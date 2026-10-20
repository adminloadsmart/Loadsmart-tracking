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
  evaluateVehicle,
  GeofenceFix,
  GeofenceTransition,
  tripEventFor,
  VehicleGeofenceState,
} from './geofence.evaluator';
import { GeofenceEventRecord, GeofencesRepository } from './geofences.repository';

/** Per-vehicle geofence state: one hash per vehicle, one field (JSON membership) per geofence. */
export const geofenceStateKey = (vehicleId: string) => `trk:geofence:${vehicleId}`;

const GEOFENCES_TTL_MS = 60_000;
const TRIP_POINTS_TTL_MS = 5 * 60_000;
// Fixed namespace for geofence event ids — never change it, or a replay would duplicate events.
const GEOFENCE_EVENT_NAMESPACE = '0b6c3f1e-4a2d-5e8b-9f7c-1d2e3f4a5b6c';

/**
 * Geofence check on every processed batch (runs beside the rules engine as a BatchHook): the
 * geofences are drawn and edited in the main backend; tracking reads them (cached a minute per
 * tenant), tests each accepted fix, and announces every enter/exit — plus the trip step it stands
 * for (arrived at pickup / departed pickup / arrived at drop) — on `tracking.events`, where the
 * main backend moves the load's status and sends the notifications.
 *
 * Retry safety mirrors the rules: events go to Postgres (idempotent ids) before the Redis state
 * moves on, and the state commits in the same MULTI as the vehicle state. A failure here is
 * logged and leaves the state untouched — the next batch re-evaluates — instead of failing the
 * point batch, which is already stored.
 */
export function createGeofencesModule(deps: {
  dataSource: DataSource;
  redis: Redis;
  activeTrips: ActiveTripIndex;
  logger: Logger;
}) {
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

  async function evaluate(points: ProcessedPoint[], nowMs: number) {
    const byVehicle = new Map<string, { tenantId: string; fixes: GeofenceFix[] }>();
    for (const { point, rejected } of points) {
      if (rejected || point.flags?.late) continue;
      const approachTripId =
        typeof point.flags?.approachTripId === 'string' ? point.flags.approachTripId : null;
      const entry = byVehicle.get(point.vehicleId) ?? { tenantId: point.tenantId, fixes: [] };
      entry.fixes.push({
        t: Date.parse(point.recordedAt),
        lat: point.lat,
        lng: point.lng,
        tripId: point.tripId ?? approachTripId,
      });
      byVehicle.set(point.vehicleId, entry);
    }
    if (byVehicle.size === 0) return null;

    const vehicleIds = [...byVehicle.keys()];
    const stored = await loadStates(vehicleIds);
    const transitions: Array<{ vehicleId: string; tenantId: string } & GeofenceTransition> = [];
    const writes = new Map<string, Record<string, string>>();

    for (const [vehicleId, { tenantId, fixes }] of byVehicle) {
      const geofences = await geofencesFor(tenantId, nowMs);
      if (geofences.length === 0) continue;
      fixes.sort((a, b) => a.t - b.t);
      const result = evaluateVehicle(vehicleId, fixes, geofences, stored.get(vehicleId) ?? {});
      for (const transition of result.transitions) {
        transitions.push({ vehicleId, tenantId, ...transition });
      }
      if (result.changed.length > 0) {
        writes.set(
          vehicleId,
          Object.fromEntries(result.changed.map((id) => [id, JSON.stringify(result.state[id])])),
        );
      }
    }

    const tripIds = [
      ...new Set(transitions.map((t) => t.tripId).filter((id): id is string => !!id)),
    ];
    const [statuses, tripPoints] = await Promise.all([
      deps.activeTrips.getLoadStatuses(tripIds),
      tripPointsFor(tripIds, nowMs),
    ]);
    const records: GeofenceEventRecord[] = transitions.map((transition) => {
      const { vehicleId, tenantId, geofence, event, t, lat, lng, tripId } = transition;
      const points = tripId ? (tripPoints.get(tripId) ?? null) : null;
      const occurredAt = new Date(t).toISOString();
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
        occurredAt,
      };
      const outbox: GeofenceEventRecord['outbox'] = [
        { type: event === 'enter' ? 'geofence.entered' : 'geofence.exited', payload: base },
      ];
      const tripEvent = tripEventFor(
        transition,
        tripId ? (statuses.get(tripId) ?? null) : null,
        points,
      );
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
    await repository.record(records);
    return writes;
  }

  const hook: BatchHook = {
    async run(points, nowMs) {
      let writes: Map<string, Record<string, string>> | null;
      try {
        writes = await evaluate(points, nowMs);
      } catch (err) {
        deps.logger.warn({ err }, 'Geofence check failed; re-evaluated with the next batch');
        return {};
      }
      if (!writes || writes.size === 0) return {};
      return {
        writeState: (multi) => {
          for (const [vehicleId, fields] of writes) multi.hset(geofenceStateKey(vehicleId), fields);
        },
      };
    },
  };

  return { hook, repository };
}

export { evaluateVehicle, tripEventFor } from './geofence.evaluator';
export type { GeofenceFix, GeofenceTransition, VehicleGeofenceState } from './geofence.evaluator';
