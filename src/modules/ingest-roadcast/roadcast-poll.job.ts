import type Redis from 'ioredis';
import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../../shared/metrics';
import type { NormalizedPoint, PointPublisher } from '../points';
import { isGeofenceOnly, isTrackingSource, type ActiveTripIndex, type TripRef } from '../trips';
import type { PositionSource } from './roadcast.client';
import { RoadcastError } from './roadcast.client';
import {
  DeviceOwner,
  fixTimeMs,
  hasPosition,
  RoadcastRow,
  roadcastRowSchema,
  SpeedUnit,
  toNormalizedPoint,
} from './roadcast.contract';

/** IMEI → last published fix time (epoch ms). Latest-only API: the same fix comes back on every
 *  poll until the device reports a new one, so this is what keeps it from being re-ingested. */
export const ROADCAST_CURSOR_KEY = 'trk:poll:cursor:roadcast';

// Mirrors START_GRACE_MS in ingest-phone/trip-resolver.ts.
const START_GRACE_MS = 10 * 60_000;

export interface RoadcastDevice {
  imei: string;
  vehicleId: string;
  tenantId: string;
}

export interface RoadcastPollJobData {
  devices: RoadcastDevice[];
}

export interface RoadcastPollOptions {
  /** Without an active trip, at most one point per vehicle per this interval. */
  idleIntervalMs: number;
  speedUnit: SpeedUnit;
}

export type RoadcastPollResult = Record<RowResult, number>;

export type RowResult =
  'accepted' | 'stale' | 'idle_throttled' | 'unknown_device' | 'no_fix' | 'invalid';

const apiCalls = new Counter({
  name: 'tracking_roadcast_api_calls_total',
  help: 'Roadcast pull-positions calls (each one is billed), by org and outcome',
  labelNames: ['tenant', 'outcome'] as const,
  registers: [metricsRegistry],
});
const apiSeconds = new Histogram({
  name: 'tracking_roadcast_api_seconds',
  help: 'Roadcast pull-positions call latency',
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10],
  registers: [metricsRegistry],
});
const rowsTotal = new Counter({
  name: 'tracking_roadcast_rows_total',
  help: 'Rows returned by Roadcast, by what happened to them',
  labelNames: ['result'] as const,
  registers: [metricsRegistry],
});

/**
 * One poll of one org's devices: pull their latest positions, drop fixes already ingested
 * (cursor) and idle vehicles' points inside the idle interval, stamp the trip from the Redis
 * active-trip index, and publish to the point stream. The location_points unique key
 * (vehicle_id, source, recorded_at) is the second guard against duplicates.
 */
export class RoadcastPollJob {
  constructor(
    private readonly source: PositionSource,
    private readonly redis: Redis,
    private readonly activeTrips: ActiveTripIndex,
    private readonly publisher: PointPublisher,
    private readonly options: RoadcastPollOptions,
  ) {}

  async run({ devices }: RoadcastPollJobData, nowMs = Date.now()): Promise<RoadcastPollResult> {
    const counts: RoadcastPollResult = {
      accepted: 0,
      stale: 0,
      idle_throttled: 0,
      unknown_device: 0,
      no_fix: 0,
      invalid: 0,
    };
    if (devices.length === 0) return counts;

    // The dispatcher builds every job from one org's devices.
    const rows = await this.pull(
      devices[0].tenantId,
      devices.map((device) => device.imei),
    );

    // Newest fix per requested device.
    const byImei = new Map(devices.map((device) => [device.imei, device]));
    const latest = new Map<string, { row: RoadcastRow; device: RoadcastDevice; fixMs: number }>();
    for (const raw of rows) {
      const parsed = roadcastRowSchema.safeParse(raw);
      if (!parsed.success) {
        counts.invalid++;
        continue;
      }
      const row = parsed.data;
      const device = byImei.get(row.deviceImei.trim());
      if (!device) {
        counts.unknown_device++;
        continue;
      }
      const fixMs = fixTimeMs(row);
      if (fixMs === null || !hasPosition(row)) {
        counts.no_fix++;
        continue;
      }
      const seen = latest.get(device.imei);
      if (!seen || fixMs > seen.fixMs) latest.set(device.imei, { row, device, fixMs });
    }

    const candidates = [...latest.values()];
    if (candidates.length > 0) {
      const cursors = await this.redis.hmget(
        ROADCAST_CURSOR_KEY,
        ...candidates.map((c) => c.device.imei),
      );
      const trips = await this.activeTrips.getTripRefsForVehicles([
        ...new Set(candidates.map((c) => c.device.vehicleId)),
      ]);

      const receivedAt = new Date(nowMs).toISOString();
      const points: NormalizedPoint[] = [];
      const advanced: Record<string, string> = {};
      candidates.forEach(({ row, device, fixMs }, i) => {
        const cursor = Number(cursors[i]) || 0;
        if (fixMs <= cursor) {
          counts.stale++;
          return;
        }
        const owner = ownerFor(device, trips.get(device.vehicleId), fixMs);
        const onTrip = owner.tripId !== null || owner.geofenceTripId !== undefined;
        if (!onTrip && fixMs - cursor < this.options.idleIntervalMs) {
          counts.idle_throttled++;
          return;
        }
        points.push(toNormalizedPoint(row, fixMs, owner, receivedAt, this.options.speedUnit));
        advanced[device.imei] = String(fixMs);
        counts.accepted++;
      });

      // Publish before moving the cursors: a failed publish is retried by the next poll.
      await this.publisher.publish(points);
      if (points.length > 0) await this.redis.hset(ROADCAST_CURSOR_KEY, advanced);
    }

    for (const [result, n] of Object.entries(counts)) {
      if (n > 0) rowsTotal.inc({ result }, n);
    }
    return counts;
  }

  private async pull(tenant: string, imeis: string[]): Promise<unknown[]> {
    const end = apiSeconds.startTimer();
    try {
      const rows = await this.source.pullPositions(imeis);
      apiCalls.inc({ tenant, outcome: 'ok' });
      return rows;
    } catch (err) {
      apiCalls.inc({
        tenant,
        outcome: err instanceof RoadcastError && err.rateLimited ? 'rate_limited' : 'error',
      });
      throw err;
    } finally {
      end();
    }
  }
}

/** The trip a device's fix belongs to — same rules as the phone's TripResolver. */
export function ownerFor(device: RoadcastDevice, trip: TripRef | undefined, fixMs: number) {
  const owner: DeviceOwner = {
    tenantId: device.tenantId,
    vehicleId: device.vehicleId,
    tripId: null,
  };
  if (
    trip &&
    trip.tenantId === device.tenantId &&
    isTrackingSource(trip.trackingSource, 'roadcast') &&
    (trip.startedAtMs === null || fixMs >= trip.startedAtMs - START_GRACE_MS)
  ) {
    if (isGeofenceOnly(trip.loadStatus)) owner.geofenceTripId = trip.tripId;
    else owner.tripId = trip.tripId;
  }
  return owner;
}
