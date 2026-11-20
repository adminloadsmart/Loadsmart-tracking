import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { MainDataRepository, MainLoad } from '../main-data';
import { haversineMeters, type LatLng } from '../processing/geo';
import { vehicleLatestKey } from '../processing/vehicle-state.store';
import { RouteGeometry } from '../routes/route-geometry';
import type { RouteStore } from '../routes/route.store';
import type { ApproachRouteRow, RoutesRepository } from '../routes/routes.repository';
import type { LoadStatus } from '../trips';
import { promisedTime } from './delay';
import { tripEtaKey } from './delay.monitor';
import type { RuleEngine } from './rule-engine';
import { num } from './rule-helpers';

const RULE = 'DELAY-GPS' as const;
/** Road km per straight-line km when the truck is off its drawn approach leg (or there is none). */
const ROAD_FACTOR = 1.3;

/** The stages before the truck leaves the plant; from in_transit_unloading the DelayMonitor owns the ETA. */
export const PRE_TRANSIT_STATUSES: readonly LoadStatus[] = [
  'truck_assigned',
  'in_transit_loading',
  'reached_loading',
  'loaded',
];
/** Still on the way to the plant: the approach leg counts and a position is needed. */
const HEADING_TO_PLANT: readonly LoadStatus[] = ['truck_assigned', 'in_transit_loading'];

export interface PreTransitInput {
  nowMs: number;
  stage: LoadStatus;
  /** Plant → drop route length (the trip's primary route). */
  routeLengthM: number;
  atPlantAtMs: number | null;
  /** The truck's latest position (any source); only used while heading to the plant. */
  position: LatLng | null;
  /** The drawn approach leg (first tracked point → loading point), if any. */
  approach: RouteGeometry | null;
  loadingPoint: LatLng | null;
  params: Record<string, number | boolean | string>;
}

export interface PreTransitEstimate {
  approachKm: number;
  dwellMin: number;
  /** Approach km still to drive + the plant → drop route. */
  remainingKm: number;
  speedKmh: number;
  etaMs: number;
}

/**
 * Delivery ETA before the truck leaves the plant, pure:
 *   ETA = now + approach km left ÷ rate + plant dwell left + route km ÷ rate
 *  - approach km left: the position snapped onto the approach leg (within maxSnapDistanceM), else
 *    straight line to the loading point × 1.3; only for truck_assigned / in_transit_loading;
 *  - dwell left: loadingDwellMin before the plant, minus time since atPlantAt at the plant, 0 once loaded;
 *  - rate: preTransitKmPerDay (planning rate, rests included).
 * Null when the approach can't be measured (no position, or nowhere to measure it to).
 */
export function estimatePreTransit(input: PreTransitInput): PreTransitEstimate | null {
  const { nowMs, stage, params: p } = input;
  const speedKmh = num(p, 'preTransitKmPerDay') / 24;
  if (!(speedKmh > 0)) return null;

  let approachM = 0;
  if (HEADING_TO_PLANT.includes(stage)) {
    if (!input.position) return null;
    const snapped = input.approach?.project(input.position);
    if (input.approach && snapped && snapped.distanceM <= num(p, 'maxSnapDistanceM')) {
      approachM = Math.max(0, input.approach.lengthM - snapped.alongM);
    } else {
      const target = input.loadingPoint ?? input.approach?.end ?? null;
      if (!target) return null;
      approachM = haversineMeters(input.position, target) * ROAD_FACTOR;
    }
  }

  const fullDwellMin = num(p, 'loadingDwellMin');
  const dwellMin =
    stage === 'loaded'
      ? 0
      : stage === 'reached_loading' && input.atPlantAtMs !== null
        ? Math.max(0, fullDwellMin - (nowMs - input.atPlantAtMs) / 60_000)
        : fullDwellMin;

  const approachKm = approachM / 1000;
  const remainingKm = approachKm + input.routeLengthM / 1000;
  const etaMs = nowMs + (remainingKm / speedKmh) * 3_600_000 + dwellMin * 60_000;
  const round1 = (value: number) => Math.round(value * 10) / 10;
  return {
    approachKm: round1(approachKm),
    dwellMin: Math.round(dwellMin),
    remainingKm: round1(remainingKm),
    speedKmh: round1(speedKmh),
    etaMs,
  };
}

/**
 * Keeps trk:trip:{id}:eta filled from truck assignment until the truck leaves the plant (scheduler
 * leader, every etaEveryMin), so the trip list has a delivery ETA at every stage. ETA only: no
 * DELAY alerts and no LS_N_0030 notices before in_transit_unloading. The hash carries no
 * vehicleId / routeLengthM, so the API's live refresh (tracking-api/live-eta) leaves it as written.
 */
export class PreTransitEtaMonitor {
  constructor(
    private readonly redis: Redis,
    private readonly mainData: MainDataRepository,
    private readonly routes: RoutesRepository,
    private readonly routeStore: RouteStore,
    private readonly engine: RuleEngine,
    private readonly logger: Logger,
  ) {}

  async tick(nowMs = Date.now()): Promise<void> {
    const loads = (await this.mainData.loadsByStatus(null, PRE_TRANSIT_STATUSES, 50_000)).filter(
      (l) => l.vehicleId,
    );
    if (loads.length === 0) return;
    const tripRoutes = await this.routeStore.get(
      loads.map((l) => l.id),
      nowMs,
    );
    const routed = loads.filter((l) => tripRoutes.has(l.id));
    if (routed.length === 0) return;

    const [lastEval, latest, approaches, places] = await Promise.all([
      this.lastEvaluated(routed.map((l) => l.id)),
      this.latestPositions(routed.map((l) => l.vehicleId!)),
      this.routes.approachRoutes(routed.map((l) => l.id)),
      this.mainData.places(
        routed.map((l) => l.loadingPointId).filter((id): id is string => !!id),
        [],
      ),
    ]);

    for (const load of routed) {
      try {
        const setting = (await this.engine.settings(load.tenantId, nowMs)).get(RULE);
        if (!setting?.enabled) continue;
        const p = setting.params;
        if (nowMs - (lastEval.get(load.id) ?? 0) < num(p, 'etaEveryMin') * 60_000) continue;

        const place = load.loadingPointId ? places.get(load.loadingPointId) : undefined;
        await this.evaluate(load, {
          nowMs,
          primary: tripRoutes.get(load.id)!.primary,
          position: latest.get(load.vehicleId!) ?? null,
          approach: approaches.get(load.id),
          loadingPoint:
            place && place.lat !== null && place.lng !== null
              ? { lat: place.lat, lng: place.lng }
              : null,
          params: p,
        });
      } catch (err) {
        this.logger.error({ err, tripId: load.id }, 'Pre-transit ETA failed');
      }
    }
  }

  private async evaluate(
    load: MainLoad,
    input: {
      nowMs: number;
      primary: { geometry: { lengthM: number }; promisedAt: number | null };
      position: (LatLng & { recordedAtMs: number }) | null;
      approach: ApproachRouteRow | undefined;
      loadingPoint: LatLng | null;
      params: Record<string, number | boolean | string>;
    },
  ): Promise<void> {
    const { nowMs, primary, position, params: p } = input;
    const key = tripEtaKey(load.id);
    const headingToPlant = HEADING_TO_PLANT.includes(load.status);
    // Heading to the plant the ETA rests on where the truck is: an old fix keeps the last ETA, stale.
    if (
      headingToPlant &&
      position &&
      nowMs - position.recordedAtMs > num(p, 'staleAfterMin') * 60_000
    ) {
      await this.redis.hset(key, { stale: '1', stage: load.status, evaluatedAt: String(nowMs) });
      return;
    }

    const atPlantAt = load.milestones.atPlantAt ? Date.parse(load.milestones.atPlantAt) : null;
    const estimate = estimatePreTransit({
      nowMs,
      stage: load.status,
      routeLengthM: primary.geometry.lengthM,
      atPlantAtMs: Number.isFinite(atPlantAt) ? atPlantAt : null,
      position,
      approach: approachGeometry(input.approach),
      loadingPoint: input.loadingPoint,
      params: p,
    });
    if (!estimate) return; // e.g. no position yet: nothing to measure the approach from

    const promisedMs = promisedTime(
      primary.promisedAt,
      load.promisedDeliveryAt?.getTime() ?? null,
      load.startedAt?.getTime() ?? nowMs,
      primary.geometry.lengthM,
      p,
    );
    await this.redis.hset(key, {
      etaAt: String(Math.round(estimate.etaMs)),
      promisedAt: String(Math.round(promisedMs)),
      projectedDelayMin: String(Math.round((estimate.etaMs - promisedMs) / 60_000)),
      remainingKm: String(estimate.remainingKm),
      speedKmh: String(estimate.speedKmh),
      basis: 'pre_transit',
      stage: load.status,
      stale: '0',
      evaluatedAt: String(nowMs),
    });
  }

  private async lastEvaluated(tripIds: string[]): Promise<Map<string, number>> {
    const pipeline = this.redis.pipeline();
    for (const id of tripIds) pipeline.hget(tripEtaKey(id), 'evaluatedAt');
    const results = (await pipeline.exec()) ?? [];
    const out = new Map<string, number>();
    tripIds.forEach((id, i) => {
      const value = results[i]?.[1];
      if (typeof value === 'string') out.set(id, Number(value));
    });
    return out;
  }

  private async latestPositions(
    vehicleIds: string[],
  ): Promise<Map<string, LatLng & { recordedAtMs: number }>> {
    const pipeline = this.redis.pipeline();
    for (const id of vehicleIds) pipeline.hmget(vehicleLatestKey(id), 'lat', 'lng', 'recordedAt');
    const results = (await pipeline.exec()) ?? [];
    const out = new Map<string, LatLng & { recordedAtMs: number }>();
    vehicleIds.forEach((id, i) => {
      const [lat, lng, recordedAt] = (results[i]?.[1] as Array<string | null>) ?? [];
      const recordedAtMs = recordedAt ? Date.parse(recordedAt) : NaN;
      if (lat && lng && Number.isFinite(recordedAtMs)) {
        out.set(id, { lat: Number(lat), lng: Number(lng), recordedAtMs });
      }
    });
    return out;
  }
}

function approachGeometry(row: ApproachRouteRow | undefined): RouteGeometry | null {
  if (!row?.polyline) return null;
  try {
    return RouteGeometry.fromPolyline(row.polyline);
  } catch {
    return null; // fewer than 2 points: nothing to snap to
  }
}
