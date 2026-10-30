import type { TenantScope } from '../../shared/auth/staff-token';
import { NotFoundError, ValidationError } from '../../shared/errors';
import type { AddressResolver } from '../geocoding';
import type { PointSource } from '../points';
import type { LatestPosition, VehicleStateStore } from '../processing/vehicle-state.store';
import {
  PlannedRouteRow,
  TrackingApiRepository,
  TrackPoint,
  TrackPolyline,
  TripRow,
  VehicleRow,
} from './tracking-api.repository';

/** A position older than this is shown as stale on the map (phone sends every 15 s). */
export const STALE_AFTER_MS = 10 * 60_000;

export const TRACK_RESOLUTIONS = ['low', 'medium', 'full'] as const;
export type TrackResolution = (typeof TRACK_RESOLUTIONS)[number];
// Douglas-Peucker tolerance in degrees: ~55 m (overview), ~11 m (detail), none.
const TOLERANCE_DEG: Record<TrackResolution, number> = { low: 0.0005, medium: 0.0001, full: 0 };

const MAX_PLAYBACK_POINTS = 20_000;
const MAX_FLEET_VEHICLES = 5_000;
const RAW_TIMELINE_MAX_MS = 24 * 3_600_000;
const TIMELINE_MAX_MS = 7 * 24 * 3_600_000;

export interface PositionView {
  lat: number;
  lng: number;
  recordedAt: string;
  source: PointSource;
  speedKmh: number | null;
  heading: number | null;
  motion: string | null;
  ageSeconds: number;
  stale: boolean;
}

export function toPositionView(position: LatestPosition, nowMs = Date.now()): PositionView {
  const ageMs = Math.max(0, nowMs - Date.parse(position.recordedAt));
  return {
    lat: position.lat,
    lng: position.lng,
    recordedAt: position.recordedAt,
    source: position.source,
    speedKmh: position.speedKmh,
    heading: position.heading,
    motion: position.motion || null,
    ageSeconds: Math.round(ageMs / 1000),
    stale: ageMs > STALE_AFTER_MS,
  };
}

function vehicleView(vehicle: VehicleRow) {
  return {
    vehicleId: vehicle.id,
    registrationNumber: vehicle.registration_number,
    kind: vehicle.kind,
    gpsProvider: vehicle.gps_provider,
    gpsEnabled: vehicle.gps_enabled,
  };
}

function polylineView(line: TrackPolyline) {
  return {
    encoding: 'google-polyline-5',
    polyline: line.polyline,
    pointCount: line.point_count,
    firstAt: line.first_at?.toISOString() ?? null,
    lastAt: line.last_at?.toISOString() ?? null,
  };
}

function pointView(point: TrackPoint) {
  return {
    t: point.recorded_at.toISOString(),
    lat: point.lat,
    lng: point.lng,
    speedKmh: point.speed_kmh,
    heading: point.heading,
    source: point.source,
    motion: point.motion,
  };
}

type EtaView = {
  etaAt: string;
  promisedAt: string | null;
  projectedDelayMin: number;
  remainingKm: number;
  speedKmh: number;
  basis: string;
  stale: boolean;
  evaluatedAt: string;
};

/** The DELAY rule's latest ETA (Redis hash, all strings) as the API shape; null if none yet. */
function etaView(eta: Record<string, string>): EtaView | null {
  if (!eta.etaAt) return null;
  return {
    etaAt: new Date(Number(eta.etaAt)).toISOString(),
    promisedAt: eta.promisedAt ? new Date(Number(eta.promisedAt)).toISOString() : null,
    projectedDelayMin: Number(eta.projectedDelayMin),
    remainingKm: Number(eta.remainingKm),
    speedKmh: Number(eta.speedKmh),
    basis: eta.basis,
    stale: eta.stale === '1',
    evaluatedAt: new Date(Number(eta.evaluatedAt)).toISOString(),
  };
}

const round1 = (value: number) => Math.round(value * 10) / 10;

function routeView(route: PlannedRouteRow | undefined) {
  return route
    ? {
        kind: route.kind,
        version: route.version,
        distanceKm: round1(route.distance_m / 1000),
        durationMin: route.duration_s === null ? null : Math.round(route.duration_s / 60),
      }
    : null;
}

/** Free-text match over what the tracking list's search box covers. */
function matchesQuery(trip: TripRow, query: string): boolean {
  const needle = query.trim().toLowerCase();
  if (!needle) return true;
  return [
    trip.load_code,
    trip.customer_name,
    trip.vehicle_number,
    trip.driver_name,
    trip.driver_phone,
    trip.origin?.name,
    trip.origin?.city,
    trip.destination?.name,
    trip.destination?.city,
  ].some((field) => field?.toLowerCase().includes(needle));
}

/**
 * Read API for the web map and dashboards (docs/contracts/tracking-api.md). Live positions come
 * from Redis (written by the processor on every batch) — never from the hypertables on the hot
 * path; tracks and timelines come from Timescale/PostGIS.
 */
export class TrackingApiService {
  constructor(
    private readonly repository: TrackingApiRepository,
    private readonly positions: VehicleStateStore,
    /** Reads the latest ETA the DELAY rule computed (trk:trip:{id}:eta). */
    private readonly readEta: (tripId: string) => Promise<Record<string, string>>,
    private readonly addresses?: AddressResolver,
  ) {}

  /** Adds `address` (reverse-geocoded) to each position view; null where there's no position. */
  private async withAddresses<T extends PositionView | null>(
    positions: T[],
  ): Promise<Array<(T & { address: string | null }) | null>> {
    const addresses = await (this.addresses?.resolve(positions) ??
      Promise.resolve(positions.map(() => null)));
    return positions.map((p, i) => (p ? { ...p, address: addresses[i] ?? null } : null));
  }

  async fleetLive(scope: TenantScope) {
    const vehicles = await this.repository.listVehicles(scope, MAX_FLEET_VEHICLES);
    const ids = vehicles.map((vehicle) => vehicle.id);
    const [latest, activeTrips] = await Promise.all([
      this.positions.readLatest(ids),
      this.repository.activeTripsByVehicle(ids),
    ]);
    const now = Date.now();
    return {
      vehicles: vehicles.map((vehicle) => {
        const position = latest.get(vehicle.id);
        return {
          ...vehicleView(vehicle),
          activeTripId: activeTrips.get(vehicle.id) ?? null,
          position: position ? toPositionView(position, now) : null,
        };
      }),
      truncated: vehicles.length === MAX_FLEET_VEHICLES,
    };
  }

  async vehicleLocation(scope: TenantScope, vehicleId: string) {
    const vehicle = await this.requireVehicle(scope, vehicleId);
    const [latest, activeTrips] = await Promise.all([
      this.positions.readLatest([vehicleId]),
      this.repository.activeTripsByVehicle([vehicleId]),
    ]);
    const position = latest.get(vehicleId);
    const [withAddress] = await this.withAddresses([position ? toPositionView(position) : null]);
    return {
      ...vehicleView(vehicle),
      activeTripId: activeTrips.get(vehicleId) ?? null,
      position: withAddress,
    };
  }

  async vehicleTimeline(
    scope: TenantScope,
    vehicleId: string,
    from: Date,
    to: Date,
    resolution: TrackResolution,
  ) {
    await this.requireVehicle(scope, vehicleId);
    const spanMs = to.getTime() - from.getTime();
    if (spanMs <= 0) throw new ValidationError('`to` must be after `from`');
    if (spanMs > TIMELINE_MAX_MS) throw new ValidationError('Timeline window is limited to 7 days');

    // Raw points only exist for a week for idle vehicles; long or old windows use 1-min rollups.
    const useRollups =
      spanMs > RAW_TIMELINE_MAX_MS || Date.now() - from.getTime() > 6 * 24 * 3_600_000;
    const line = await this.repository.vehicleTimelinePolyline(
      vehicleId,
      from,
      to,
      TOLERANCE_DEG[resolution],
      useRollups,
    );
    return {
      vehicleId,
      from: from.toISOString(),
      to: to.toISOString(),
      resolution,
      granularity: useRollups ? '1min' : 'raw',
      ...polylineView(line),
    };
  }

  async listTrips(
    scope: TenantScope,
    state: 'pending' | 'active' | 'ended',
    limit: number,
    query?: string,
  ) {
    const all = await this.repository.listTrips(scope, state, limit);
    const trips = query ? all.filter((trip) => matchesQuery(trip, query)) : all;
    const [latest, etas] = await Promise.all([
      this.positions.readLatest(
        trips.map((trip) => trip.vehicle_id).filter((id): id is string => Boolean(id)),
      ),
      // ETAs only exist for trips the DELAY rule is evaluating (in transit).
      Promise.all(trips.map((trip) => this.readEta(trip.id))),
    ]);
    const now = Date.now();
    const views = trips.map((trip) => {
      const position = trip.vehicle_id ? latest.get(trip.vehicle_id) : undefined;
      // Only a position reported for THIS trip is the trip's position.
      return position && position.tripId === trip.id ? toPositionView(position, now) : null;
    });
    const positions = await this.withAddresses(views);
    return {
      trips: trips.map((trip, index) => ({
        ...tripView(trip),
        position: positions[index],
        eta: etaView(etas[index]),
      })),
    };
  }

  /** Counters for the tracking screen's header cards, over the tenant's active trips. */
  async summary(scope: TenantScope) {
    const { trips } = await this.listTrips(scope, 'active', 500);
    return {
      // "At a gate" (inside a loading/unloading geofence) needs geofence events (Phase 7).
      onTheRoad: trips.length,
      runningLate: trips.filter((trip) => (trip.eta?.projectedDelayMin ?? 0) > 0).length,
      notTracked: trips.filter((trip) => trip.position === null).length,
    };
  }

  async trip(scope: TenantScope, tripId: string) {
    const trip = await this.requireTrip(scope, tripId);
    const [metrics, latest, rawEta, routes] = await Promise.all([
      this.positions.readTripMetrics(tripId),
      trip.vehicle_id ? this.positions.readLatest([trip.vehicle_id]) : Promise.resolve(new Map()),
      this.readEta(tripId),
      this.repository.currentRoutes([tripId]),
    ]);
    const route = routes.get(tripId);
    const eta = etaView(rawEta);
    const routeKm = route ? round1(route.distance_m / 1000) : null;
    const position = trip.vehicle_id ? latest.get(trip.vehicle_id) : undefined;
    // Until the waterfall (Phase 6) picks an authoritative source, report the largest source's
    // distance as the trip distance and expose the per-source breakdown.
    const distances = Object.values(metrics.distanceMBySource);
    const [tripPosition] = await this.withAddresses([
      position && position.tripId === trip.id ? toPositionView(position) : null,
    ]);
    return {
      ...tripView(trip),
      distanceKm: distances.length ? Math.round(Math.max(...distances) / 10) / 100 : 0,
      distanceKmBySource: Object.fromEntries(
        Object.entries(metrics.distanceMBySource).map(([source, m]) => [
          source,
          Math.round(m / 10) / 100,
        ]),
      ),
      fraudFlags: metrics.fraudFlags,
      position: tripPosition,
      routeStatus: trip.route_status,
      promisedDeliveryAt: trip.promised_delivery_at?.toISOString() ?? null,
      route: routeView(route),
      // Route km already driven = route length − what the ETA says is left (null until both exist).
      coveredKm: routeKm !== null && eta ? round1(Math.max(0, routeKm - eta.remainingKm)) : null,
      eta,
    };
  }

  /** The route in force for the trip (planned, or the ops-approved alternate), for the map. */
  async tripRoute(scope: TenantScope, tripId: string) {
    const trip = await this.requireTrip(scope, tripId);
    const route = (await this.repository.currentRoutes([tripId])).get(tripId);
    return {
      tripId,
      routeStatus: trip.route_status,
      route: routeView(route),
      ...(route
        ? { encoding: 'google-polyline-5', polyline: route.polyline }
        : { encoding: null, polyline: null }),
    };
  }

  async tripTrack(
    scope: TenantScope,
    tripId: string,
    resolution: TrackResolution,
    format: 'polyline' | 'points',
    source: PointSource | null,
  ) {
    await this.requireTrip(scope, tripId);
    if (format === 'points') {
      if (resolution !== 'full') {
        throw new ValidationError('format=points is only available with resolution=full');
      }
      const points = await this.repository.tripPoints(tripId, source, MAX_PLAYBACK_POINTS + 1);
      return {
        tripId,
        resolution,
        format,
        truncated: points.length > MAX_PLAYBACK_POINTS,
        points: points.slice(0, MAX_PLAYBACK_POINTS).map(pointView),
      };
    }
    const line = await this.repository.tripPolyline(tripId, source, TOLERANCE_DEG[resolution]);
    return { tripId, resolution, format, ...polylineView(line) };
  }

  private async requireVehicle(scope: TenantScope, vehicleId: string): Promise<VehicleRow> {
    const vehicle = await this.repository.findVehicle(scope, vehicleId);
    if (!vehicle) throw new NotFoundError(`Vehicle ${vehicleId} not found`);
    return vehicle;
  }

  private async requireTrip(scope: TenantScope, tripId: string): Promise<TripRow> {
    const trip = await this.repository.findTrip(scope, tripId);
    if (!trip) throw new NotFoundError(`Trip ${tripId} not found`);
    return trip;
  }
}

function tripView(trip: TripRow) {
  return {
    tripId: trip.id,
    loadCode: trip.load_code,
    loadStatus: trip.load_status,
    sourceType: trip.source_type,
    trackingState: trip.tracking_state,
    trackingStartedAt: trip.tracking_started_at?.toISOString() ?? null,
    trackingEndedAt: trip.tracking_ended_at?.toISOString() ?? null,
    vehicleId: trip.vehicle_id,
    vehicleNumber: trip.vehicle_number,
    driverId: trip.driver_id,
    driverName: trip.driver_name,
    driverPhone: trip.driver_phone,
    customerName: trip.customer_name,
    plannedTonnes: trip.planned_tonnes,
    origin: trip.origin,
    destination: trip.destination,
    milestones: trip.milestones,
  };
}
