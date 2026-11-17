import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { DataSource } from 'typeorm';
import type { BatchHook } from '../points';
import type { ProcessedPoint } from '../processing/pipeline';
import { tripRefKey } from '../trips';
import {
  DEFAULT_TRIP_START_OPTIONS,
  evaluateTripStart,
  TripStartFix,
  TripStartOptions,
  TripStartState,
  TripStarted,
} from './trip-start.evaluator';

export const tripStartKey = (tripId: string) => `trk:tripstart:${tripId}`;
/** The check state outlives any trip's wait for a start; a new assignment replaces it anyway. */
const STATE_TTL_S = 14 * 24 * 60 * 60;
/** Only a load still at "Truck assigned" can start: the main backend moves it to stage 4. */
const STARTABLE_STATUS = 'truck_assigned';

/**
 * `trip.started` (batch hook, beside the rules and the geofence check): once a load has a truck
 * (truck_assigned) and live fixes arrive, the first fix is where the truck was; when it is the
 * start distance away (3 km; for SIM, 2 distinct pings that far), the trip has started, and the
 * main backend moves the load to "In transit to loading" (stage 4).
 *
 * Retry safety is the geofence module's: the event goes to Postgres first, once (the primary key
 * of trip_start_events), and the check state commits in the batch's Redis MULTI, so a failed batch
 * recomputes the same start and a redelivered one sends nothing twice.
 */
export function createTripStartModule(deps: {
  dataSource: DataSource;
  redis: Redis;
  logger: Logger;
  options?: Partial<TripStartOptions>;
}) {
  const options: TripStartOptions = { ...DEFAULT_TRIP_START_OPTIONS, ...deps.options };

  async function loadStates(tripIds: string[]) {
    const pipeline = deps.redis.pipeline();
    for (const id of tripIds) {
      pipeline.get(tripStartKey(id));
      pipeline.hmget(tripRefKey(id), 'loadStatus', 'vehicleId', 'startedAtMs', 'tenantId');
    }
    const results = (await pipeline.exec()) ?? [];
    return new Map(
      tripIds.map((id, i) => {
        const [stateErr, json] = results[i * 2] ?? [];
        const [refErr, ref] = results[i * 2 + 1] ?? [];
        if (stateErr) throw stateErr;
        if (refErr) throw refErr;
        const [loadStatus, vehicleId, startedAtMs, tenantId] = ref as Array<string | null>;
        return [
          id,
          {
            state: json ? (JSON.parse(json as string) as TripStartState) : null,
            loadStatus: loadStatus || null,
            vehicleId: vehicleId || null,
            assignment: Number(startedAtMs) || 0,
            tenantId: tenantId || null,
          },
        ] as const;
      }),
    );
  }

  /** Records the start (once) and queues the event for the main backend. */
  async function record(
    tripId: string,
    tenantId: string,
    vehicleId: string,
    assignment: number,
    s: TripStarted,
  ): Promise<boolean> {
    return deps.dataSource.transaction(async (manager) => {
      const rows: Array<{ trip_id: string }> = await manager.query(
        `INSERT INTO tracking.trip_start_events
           (trip_id, assignment_ms, tenant_id, vehicle_id, started_at, from_lat, from_lng, lat, lng,
            distance_m, source, pings)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
         ON CONFLICT (trip_id, assignment_ms) DO NOTHING
         RETURNING trip_id`,
        [
          tripId,
          assignment,
          tenantId,
          vehicleId,
          new Date(s.t),
          s.from.lat,
          s.from.lng,
          s.lat,
          s.lng,
          s.distanceM,
          s.source,
          s.pings,
        ],
      );
      if (rows.length === 0) return false;
      await manager.query(
        `INSERT INTO tracking.alert_outbox (event_type, payload) VALUES ('trip.started', $1)`,
        [
          JSON.stringify({
            tenant_id: tenantId,
            loadId: tripId,
            vehicleId,
            lat: s.lat,
            lng: s.lng,
            fromLat: s.from.lat,
            fromLng: s.from.lng,
            distanceM: Math.round(s.distanceM),
            source: s.source,
            pings: s.pings,
            occurredAt: new Date(s.t).toISOString(),
          }),
        ],
      );
      return true;
    });
  }

  async function evaluate(points: ProcessedPoint[]) {
    const byTrip = new Map<string, TripStartFix[]>();
    for (const { point, rejected } of points) {
      if (rejected || point.flags?.late) continue;
      const tripId =
        point.tripId ??
        (typeof point.flags?.geofenceTripId === 'string' ? point.flags.geofenceTripId : null);
      if (!tripId) continue;
      const fixes = byTrip.get(tripId) ?? [];
      fixes.push({
        t: Date.parse(point.recordedAt),
        lat: point.lat,
        lng: point.lng,
        source: point.source,
      });
      byTrip.set(tripId, fixes);
    }
    if (byTrip.size === 0) return new Map<string, TripStartState>();

    const tripIds = [...byTrip.keys()];
    const stored = await loadStates(tripIds);
    const writes = new Map<string, TripStartState>();
    for (const [tripId, fixes] of byTrip) {
      const ref = stored.get(tripId)!;
      // Not (or no longer) at "Truck assigned": nothing to start.
      if (ref.loadStatus !== STARTABLE_STATUS || !ref.vehicleId || !ref.tenantId) continue;
      const { state, started } = evaluateTripStart(
        ref.state,
        { assignment: ref.assignment, vehicleId: ref.vehicleId },
        fixes,
        options,
      );
      if (started) {
        await record(tripId, ref.tenantId, ref.vehicleId, ref.assignment, started);
      }
      if (state) writes.set(tripId, state);
    }
    return writes;
  }

  const hook: BatchHook = {
    async run(points) {
      let writes: Map<string, TripStartState>;
      try {
        writes = await evaluate(points);
      } catch (err) {
        deps.logger.warn({ err }, 'Trip start check failed; re-evaluated with the next batch');
        return {};
      }
      if (writes.size === 0) return {};
      return {
        writeState: (multi) => {
          for (const [tripId, state] of writes) {
            multi.set(tripStartKey(tripId), JSON.stringify(state), 'EX', STATE_TTL_S);
          }
        },
      };
    },
  };

  return { hook };
}

/** The start thresholds from the env settings. */
export function tripStartOptionsFromEnv(config: {
  tripStartDistanceM: number;
  tripStartSimMinPings: number;
}): Partial<TripStartOptions> {
  return { distanceM: config.tripStartDistanceM, simMinPings: config.tripStartSimMinPings };
}

export { evaluateTripStart } from './trip-start.evaluator';
export type { TripStartOptions, TripStartState, TripStarted } from './trip-start.evaluator';
