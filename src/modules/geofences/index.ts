import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { DataSource } from 'typeorm';
import type { MainGeofence, MainTripPoints } from '../main-data';
import { MainDataRepository } from '../main-data';
import type { BatchHook } from '../points';
import type { ProcessedPoint } from '../processing/pipeline';
import type { ActiveTripIndex } from '../trips';
import { uuidV5 } from '../../shared/utils/uuid';
import {
  advanceDwell,
  DEFAULT_DWELL_OPTIONS,
  DwellOptions,
  dwellEventFor,
  evaluateVehicle,
  GeofenceDwell,
  GeofenceFix,
  GeofenceTransition,
  hasPendingDwell,
  tripEventFor,
  VehicleGeofenceState,
} from './geofence.evaluator';
import {
  GeofenceDwellRecord,
  GeofenceEventRecord,
  GeofencesRepository,
} from './geofences.repository';

/** Per-vehicle geofence state: one hash per vehicle, one field (JSON membership) per geofence. */
export const geofenceStateKey = (vehicleId: string) => `trk:geofence:${vehicleId}`;
/** Vehicles with a visit still waiting for a dwell milestone (vehicleId → tenantId): what the
 *  time-driven check walks, so it never scans every vehicle. */
export const GEOFENCE_DWELLING_KEY = 'trk:geofence:dwelling';

const GEOFENCES_TTL_MS = 60_000;
const TRIP_POINTS_TTL_MS = 5 * 60_000;
/** A truck last seen longer ago than this is not taken to still be inside (signal-lost's job). */
const DEFAULT_STALE_MS = 45 * 60_000;
/** A visit nobody has reported on for this long is dropped from the dwelling hash. */
const FORGET_AFTER_MS = 2 * 24 * 60 * 60_000;
// Fixed namespaces for geofence event ids — never change them, or a replay would duplicate events.
const GEOFENCE_EVENT_NAMESPACE = '0b6c3f1e-4a2d-5e8b-9f7c-1d2e3f4a5b6c';
const GEOFENCE_DWELL_NAMESPACE = '7d2e4a90-3b1c-5c6d-8e7f-0a9b8c7d6e5f';

/**
 * Geofence check on every processed batch (runs beside the rules engine as a BatchHook): the
 * geofences are drawn and edited in the main backend; tracking reads them (cached a minute per
 * tenant), tests each accepted fix, and announces every enter/exit — plus the trip step it stands
 * for — on `tracking.events`, where the main backend moves the load's status and sends the
 * notifications.
 *
 * Timing: entering the drop's geofence is announced at once (trip.entered_drop_geofence). The
 * arrivals (trip.arrived_at_pickup / trip.arrived_at_drop) wait until the truck has been stopped
 * inside for the arrival wait, and trip.detention_detected until it has been inside for the
 * detention time. Those milestones are checked on every batch and again by tick() (scheduler
 * leader), because a stopped truck sends little and SIM pings are 10-20 min apart.
 *
 * Retry safety mirrors the rules: events go to Postgres (idempotent ids) before the Redis state
 * moves on, and the state commits in the same MULTI as the vehicle state. A failure here is
 * logged and leaves the state untouched — the next batch re-evaluates — instead of failing the
 * point batch, which is already stored. Dwell events are timed from the visit (not from when the
 * check ran), so a re-run, or the batch and the tick racing, produce the same event id.
 */
export function createGeofencesModule(deps: {
  dataSource: DataSource;
  redis: Redis;
  activeTrips: ActiveTripIndex;
  logger: Logger;
  dwell?: Partial<DwellOptions>;
  staleMs?: number;
}) {
  const options: DwellOptions = { ...DEFAULT_DWELL_OPTIONS, ...deps.dwell };
  const staleMs = deps.staleMs ?? DEFAULT_STALE_MS;
  const mainData = new MainDataRepository(deps.dataSource);
  const repository = new GeofencesRepository(deps.dataSource);
  const geofenceCache = new Map<string, { at: number; value: MainGeofence[] }>();
  const tripPointsCache = new Map<string, { at: number; value: MainTripPoints | null }>();

  const geofencesFor = async (tenantId: string, nowMs: number) => {
    const cached = geofenceCache.get(tenantId);
    if (cached && nowMs - cached.at < GEOFENCES_TTL_MS) return cached.value;
    const value = await mainData.geofences(tenantId);
    geofenceCache.set(tenantId, { at: nowMs, value });
    return value;
  };

  const tripPointsFor = async (tripIds: string[], nowMs: number) => {
    const missing = tripIds.filter((id) => {
      const cached = tripPointsCache.get(id);
      return !cached || nowMs - cached.at > TRIP_POINTS_TTL_MS;
    });
    if (missing.length > 0) {
      const loaded = await mainData.tripPoints(missing);
      for (const id of missing)
        tripPointsCache.set(id, { at: nowMs, value: loaded.get(id) ?? null });
    }
    return new Map(tripIds.map((id) => [id, tripPointsCache.get(id)?.value ?? null]));
  };

  const loadStates = async (vehicleIds: string[]) => {
    const pipeline = deps.redis.pipeline();
    for (const id of vehicleIds) pipeline.hgetall(geofenceStateKey(id));
    const results = (await pipeline.exec()) ?? [];
    return new Map(
      vehicleIds.map((id, i) => {
        const [err, value] = results[i] ?? [];
        if (err) throw err;
        const state: VehicleGeofenceState = {};
        for (const [geofenceId, json] of Object.entries((value as Record<string, string>) ?? {})) {
          state[geofenceId] = JSON.parse(json);
        }
        return [id, state];
      }),
    );
  };

  type WithVehicle<T> = { vehicleId: string; tenantId: string } & T;

  /** The records (and outbox events) for a set of transitions and dwell milestones. */
  async function recordsFor(
    transitions: Array<WithVehicle<GeofenceTransition>>,
    dwells: Array<WithVehicle<GeofenceDwell>>,
    nowMs: number,
  ) {
    const tripIds = [
      ...new Set(
        [...transitions, ...dwells].map((t) => t.tripId).filter((id): id is string => !!id),
      ),
    ];
    const [statuses, tripPoints] = await Promise.all([
      deps.activeTrips.getLoadStatuses(tripIds),
      tripPointsFor(tripIds, nowMs),
    ]);
    const statusOf = (tripId: string | null) => (tripId ? (statuses.get(tripId) ?? null) : null);
    const pointsOf = (tripId: string | null) => (tripId ? (tripPoints.get(tripId) ?? null) : null);

    const records: GeofenceEventRecord[] = transitions.map((transition) => {
      const { vehicleId, tenantId, geofence, event, t, lat, lng, tripId } = transition;
      const points = pointsOf(tripId);
      const base = {
        tenant_id: tenantId,
        geofenceId: geofence.id,
        geofenceName: geofence.name,
        geofenceType: geofence.type,
        vehicleId,
        vehicleNumber: points?.vehicleNumber ?? null,
        loadId: tripId,
        lat,
        lng,
        occurredAt: new Date(t).toISOString(),
      };
      const outbox: GeofenceEventRecord['outbox'] = [
        { type: event === 'enter' ? 'geofence.entered' : 'geofence.exited', payload: base },
      ];
      const tripEvent = tripEventFor(transition, statusOf(tripId), points);
      if (tripEvent) outbox.push({ type: tripEvent, payload: base });
      return {
        id: uuidV5(GEOFENCE_EVENT_NAMESPACE, `${vehicleId}|${geofence.id}|${event}|${t}`),
        tenantId,
        geofenceId: geofence.id,
        vehicleId,
        loadId: tripId,
        event,
        lat,
        lng,
        occurredAt: new Date(t),
        outbox,
      };
    });

    const dwellRecords: GeofenceDwellRecord[] = dwells.map((dwell) => {
      const { vehicleId, tenantId, geofence, kind, t, since, lat, lng, tripId } = dwell;
      const points = pointsOf(tripId);
      const step = dwellEventFor(dwell, statusOf(tripId), points);
      const outbox: GeofenceDwellRecord['outbox'] = [];
      if (step) {
        // An arrival is stamped with when the truck stopped there (the detention clock and the
        // appointment slot count from it); `confirmedAt` is when the wait was over. A detention
        // is stamped with when the limit was passed, and says since when the truck was inside.
        outbox.push({
          type: step.type,
          payload: {
            tenant_id: tenantId,
            geofenceId: geofence.id,
            geofenceName: geofence.name,
            geofenceType: geofence.type,
            vehicleId,
            vehicleNumber: points?.vehicleNumber ?? null,
            loadId: tripId,
            point: step.point,
            lat,
            lng,
            occurredAt: new Date(kind === 'arrival' ? since : t).toISOString(),
            confirmedAt: new Date(t).toISOString(),
            ...(kind === 'detention' ? { enteredAt: new Date(since).toISOString() } : {}),
          },
        });
      }
      return {
        id: uuidV5(GEOFENCE_DWELL_NAMESPACE, `${vehicleId}|${geofence.id}|${kind}|${t}`),
        tenantId,
        geofenceId: geofence.id,
        vehicleId,
        loadId: tripId,
        kind,
        since: new Date(since),
        occurredAt: new Date(t),
        lat,
        lng,
        outbox,
      };
    });
    return { records, dwellRecords };
  }

  async function evaluate(points: ProcessedPoint[], nowMs: number) {
    const byVehicle = new Map<string, { tenantId: string; fixes: GeofenceFix[] }>();
    for (const { point, rejected } of points) {
      if (rejected || point.flags?.late) continue;
      const geofenceTripId =
        typeof point.flags?.geofenceTripId === 'string' ? point.flags.geofenceTripId : null;
      const entry = byVehicle.get(point.vehicleId) ?? { tenantId: point.tenantId, fixes: [] };
      entry.fixes.push({
        t: Date.parse(point.recordedAt),
        lat: point.lat,
        lng: point.lng,
        tripId: point.tripId ?? geofenceTripId,
        speedKmh: point.speedKmh ?? null,
        ignition: typeof point.flags?.ignition === 'boolean' ? point.flags.ignition : null,
      });
      byVehicle.set(point.vehicleId, entry);
    }
    if (byVehicle.size === 0) return null;

    const vehicleIds = [...byVehicle.keys()];
    const stored = await loadStates(vehicleIds);
    const transitions: Array<WithVehicle<GeofenceTransition>> = [];
    const dwells: Array<WithVehicle<GeofenceDwell>> = [];
    const writes = new Map<
      string,
      { fields: Record<string, string>; tenantId: string; dwelling: boolean }
    >();

    for (const [vehicleId, { tenantId, fixes }] of byVehicle) {
      const geofences = await geofencesFor(tenantId, nowMs);
      if (geofences.length === 0) continue;
      fixes.sort((a, b) => a.t - b.t);
      const result = evaluateVehicle(
        vehicleId,
        fixes,
        geofences,
        stored.get(vehicleId) ?? {},
        options,
      );
      for (const transition of result.transitions) {
        transitions.push({ vehicleId, tenantId, ...transition });
      }
      for (const dwell of result.dwells) dwells.push({ vehicleId, tenantId, ...dwell });
      if (result.changed.length > 0) {
        writes.set(vehicleId, {
          fields: Object.fromEntries(
            result.changed.map((id) => [id, JSON.stringify(result.state[id])]),
          ),
          tenantId,
          dwelling: Object.values(result.state).some(hasPendingDwell),
        });
      }
    }

    const { records, dwellRecords } = await recordsFor(transitions, dwells, nowMs);
    await repository.record(records);
    await repository.recordDwell(dwellRecords);
    return writes;
  }

  const hook: BatchHook = {
    async run(points, nowMs) {
      let writes: Awaited<ReturnType<typeof evaluate>>;
      try {
        writes = await evaluate(points, nowMs);
      } catch (err) {
        deps.logger.warn({ err }, 'Geofence check failed; re-evaluated with the next batch');
        return {};
      }
      if (!writes || writes.size === 0) return {};
      return {
        writeState: (multi) => {
          for (const [vehicleId, { fields, tenantId, dwelling }] of writes) {
            multi.hset(geofenceStateKey(vehicleId), fields);
            if (dwelling) multi.hset(GEOFENCE_DWELLING_KEY, vehicleId, tenantId);
            else multi.hdel(GEOFENCE_DWELLING_KEY, vehicleId);
          }
        },
      };
    },
  };

  /**
   * Scheduler-leader tick: checks the dwell milestones against the clock for every vehicle with a
   * visit in progress, so a truck that has stopped sending movement still arrives after the wait
   * and still trips detention. Returns the number of milestones raised.
   */
  async function tick(nowMs = Date.now()): Promise<number> {
    const dwelling = await deps.redis.hgetall(GEOFENCE_DWELLING_KEY);
    const vehicleIds = Object.keys(dwelling);
    if (vehicleIds.length === 0) return 0;
    const stored = await loadStates(vehicleIds);
    const dwells: Array<WithVehicle<GeofenceDwell>> = [];
    const writes = new Map<string, Record<string, string>>();
    const forget: string[] = [];

    for (const vehicleId of vehicleIds) {
      const tenantId = dwelling[vehicleId];
      const state = stored.get(vehicleId) ?? {};
      const geofences = await geofencesFor(tenantId, nowMs);
      const result = advanceDwell(geofences, state, nowMs, staleMs, options);
      for (const dwell of result.dwells) dwells.push({ vehicleId, tenantId, ...dwell });
      if (result.changed.length > 0) {
        writes.set(
          vehicleId,
          Object.fromEntries(result.changed.map((id) => [id, JSON.stringify(result.state[id])])),
        );
      }
      const waiting = Object.values(result.state).some(
        (m) => hasPendingDwell(m) && nowMs - m.lastT <= FORGET_AFTER_MS,
      );
      if (!waiting) forget.push(vehicleId);
    }

    // Events first (idempotent ids), then the state: a failure in between re-raises the same ids.
    const { dwellRecords } = await recordsFor([], dwells, nowMs);
    await repository.recordDwell(dwellRecords);
    if (writes.size > 0 || forget.length > 0) {
      const multi = deps.redis.multi();
      for (const [vehicleId, fields] of writes) multi.hset(geofenceStateKey(vehicleId), fields);
      if (forget.length > 0) multi.hdel(GEOFENCE_DWELLING_KEY, ...forget);
      await multi.exec();
    }
    return dwells.length;
  }

  return { hook, repository, tick };
}

/** The dwell thresholds from the env settings. */
export function dwellOptionsFromEnv(config: {
  geofenceArrivalWaitMin: number;
  geofenceDetentionHours: number;
  geofenceDefaultRadiusM: number;
  geofenceStopSpeedKmh: number;
}): Partial<DwellOptions> {
  return {
    arrivalWaitMs: config.geofenceArrivalWaitMin * 60_000,
    detentionMs: config.geofenceDetentionHours * 60 * 60_000,
    defaultRadiusM: config.geofenceDefaultRadiusM,
    stopSpeedKmh: config.geofenceStopSpeedKmh,
  };
}

export { advanceDwell, dwellEventFor, evaluateVehicle, tripEventFor } from './geofence.evaluator';
export type {
  DwellOptions,
  GeofenceDwell,
  GeofenceFix,
  GeofenceTransition,
  VehicleGeofenceState,
} from './geofence.evaluator';
