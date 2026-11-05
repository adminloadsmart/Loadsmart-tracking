import type Redis from 'ioredis';
import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../../shared/metrics';
import type { NormalizedPoint, PointPublisher } from '../points';
import { isGeofenceOnly, isTrackingSource, type ActiveTripIndex, type TripRef } from '../trips';
import { IntugineError, type SimProvider } from './intugine.client';
import {
  hasPosition,
  locationRowSchema,
  locationTimeMs,
  toNormalizedPoint,
  type SimOwner,
} from './intugine.contract';
import type { SimTripStore } from './sim-trip.repository';

/** Intugine trip id → last published location time (epoch ms). Keeps a re-polled location from being ingested twice. */
export const SIM_CURSOR_KEY = 'trk:poll:cursor:sim';

// Mirrors START_GRACE_MS in ingest-roadcast/roadcast-poll.job.ts.
const START_GRACE_MS = 10 * 60_000;

/** One running Intugine trip, as the dispatcher hands it to the poller. */
export interface SimPollJobData {
  /** sim_trips row id. */
  rowId: string;
  intugineTripId: string;
  tenantId: string;
  vehicleId: string;
  /** Our trip: the main backend's load id. */
  tripId: string;
  operator: string | null;
}

export interface SimPollOptions {
  /** Newest locations asked for per poll. */
  limit: number;
}

export type RowResult = 'accepted' | 'stale' | 'no_fix' | 'invalid';
export type SimPollResult = Record<RowResult, number>;

/** Where the last published location time of each Intugine trip is kept. */
export interface SimCursorStore {
  get(intugineTripId: string): Promise<number>;
  set(intugineTripId: string, ms: number): Promise<void>;
  /** Forget a finished trip. */
  delete(intugineTripId: string): Promise<void>;
}

export class RedisSimCursors implements SimCursorStore {
  constructor(private readonly redis: Redis) {}
  async get(intugineTripId: string): Promise<number> {
    return Number(await this.redis.hget(SIM_CURSOR_KEY, intugineTripId)) || 0;
  }
  async set(intugineTripId: string, ms: number): Promise<void> {
    await this.redis.hset(SIM_CURSOR_KEY, intugineTripId, String(ms));
  }
  async delete(intugineTripId: string): Promise<void> {
    await this.redis.hdel(SIM_CURSOR_KEY, intugineTripId);
  }
}

const apiCalls = new Counter({
  name: 'tracking_intugine_api_calls_total',
  help: 'Intugine status (location) calls, by outcome',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});
const apiSeconds = new Histogram({
  name: 'tracking_intugine_api_seconds',
  help: 'Intugine status call latency',
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20],
  registers: [metricsRegistry],
});
const rowsTotal = new Counter({
  name: 'tracking_intugine_rows_total',
  help: 'Location rows returned by Intugine, by what happened to them',
  labelNames: ['result'] as const,
  registers: [metricsRegistry],
});

/**
 * One poll of one running Intugine trip: fetch its newest locations, drop the ones already
 * ingested (cursor), stamp the load from the Redis active-trip index, and publish to the point
 * stream. The location_points unique key (vehicle_id, source, recorded_at) is the second guard
 * against duplicates. The row's `last_polled_at` / `last_point_at` are updated either way.
 */
export class SimPollJob {
  constructor(
    private readonly provider: Pick<SimProvider, 'fetchLocations'>,
    private readonly store: Pick<SimTripStore, 'markPolled'>,
    private readonly cursors: SimCursorStore,
    private readonly activeTrips: ActiveTripIndex,
    private readonly publisher: PointPublisher,
    private readonly options: SimPollOptions,
  ) {}

  async run(data: SimPollJobData, nowMs = Date.now()): Promise<SimPollResult> {
    const counts: SimPollResult = { accepted: 0, stale: 0, no_fix: 0, invalid: 0 };
    const now = new Date(nowMs);

    let rows: unknown[];
    try {
      rows = await this.pull(data.intugineTripId);
    } catch (err) {
      // Still stamp the poll, so a failing trip is retried at the normal interval, not every tick.
      await this.store.markPolled(data.rowId, now, {
        error: err instanceof Error ? err.message : String(err),
      });
      throw err;
    }

    const cursor = await this.cursors.get(data.intugineTripId);
    const fresh = new Map<number, ReturnType<typeof locationRowSchema.parse>>();
    for (const raw of rows) {
      const parsed = locationRowSchema.safeParse(raw);
      if (!parsed.success) {
        counts.invalid++;
        continue;
      }
      const ms = locationTimeMs(parsed.data);
      if (ms === null || !hasPosition(parsed.data)) {
        counts.no_fix++;
        continue;
      }
      if (ms <= cursor) {
        counts.stale++;
        continue;
      }
      fresh.set(ms, parsed.data);
    }

    const times = [...fresh.keys()].sort((a, b) => a - b);
    if (times.length > 0) {
      const trip = (await this.activeTrips.getTripRefsForVehicles([data.vehicleId])).get(
        data.vehicleId,
      );
      const receivedAt = now.toISOString();
      const points: NormalizedPoint[] = times.map((ms) =>
        toNormalizedPoint(
          fresh.get(ms)!,
          ms,
          data.intugineTripId,
          ownerFor(data, trip, ms),
          receivedAt,
          data.operator,
        ),
      );
      counts.accepted = points.length;
      // Publish before moving the cursor: a failed publish is retried by the next poll.
      await this.publisher.publish(points);
      await this.cursors.set(data.intugineTripId, times[times.length - 1]);
    }

    await this.store.markPolled(data.rowId, now, {
      lastPointAt: times.length > 0 ? new Date(times[times.length - 1]) : undefined,
    });
    for (const [result, n] of Object.entries(counts)) {
      if (n > 0) rowsTotal.inc({ result }, n);
    }
    return counts;
  }

  private async pull(intugineTripId: string): Promise<unknown[]> {
    const end = apiSeconds.startTimer();
    try {
      const rows = await this.provider.fetchLocations(intugineTripId, this.options.limit);
      apiCalls.inc({ outcome: 'ok' });
      return rows;
    } catch (err) {
      apiCalls.inc({
        outcome: err instanceof IntugineError && err.rateLimited ? 'rate_limited' : 'error',
      });
      throw err;
    } finally {
      end();
    }
  }
}

/**
 * The trip a SIM location belongs to: only the load this Intugine trip was started for, and only
 * while the load is still on SIM. Anything else stays a plain vehicle point (no `tripId`).
 */
export function ownerFor(
  data: Pick<SimPollJobData, 'tenantId' | 'vehicleId' | 'tripId'>,
  trip: TripRef | undefined,
  recordedAtMs: number,
): SimOwner {
  const owner: SimOwner = { tenantId: data.tenantId, vehicleId: data.vehicleId, tripId: null };
  if (
    trip &&
    trip.tripId === data.tripId &&
    trip.tenantId === data.tenantId &&
    isTrackingSource(trip.trackingSource, 'sim') &&
    (trip.startedAtMs === null || recordedAtMs >= trip.startedAtMs - START_GRACE_MS)
  ) {
    if (isGeofenceOnly(trip.loadStatus)) owner.geofenceTripId = trip.tripId;
    else owner.tripId = trip.tripId;
  }
  return owner;
}
