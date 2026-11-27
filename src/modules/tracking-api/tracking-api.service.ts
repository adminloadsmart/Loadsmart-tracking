import type { TenantScope } from '../../shared/auth/staff-token';
import { ConflictError, NotFoundError, ValidationError } from '../../shared/errors';
import type { AddressResolver } from '../geocoding';
import type { PointSource } from '../points';
import { decodePolyline } from '../routes';
import type { Geocoder } from '../routes';
import type { LatestPosition, VehicleStateStore } from '../processing/vehicle-state.store';
import { statsWindowStart, vehicleStats } from './vehicle-stats';
import type {
  CreateTripBody,
  EndTripBody,
  TripListState,
  UpdateTripBody,
} from './tracking-api.validators';
import {
  CreatedTripPatch,
  DriverChangeRow,
  isActiveTruckConflict,
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
// A trip crosses a few dozen tolls at most; the cap only guards against a runaway.
const MAX_FASTAG_CROSSINGS = 1_000;
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
  /** planned | blended | observed (on the road to the drop) | pre_transit (before leaving the plant). */
  basis: string;
  /** How much longer than Google's car time the truck is taking / expected to take. */
  paceFactor: number | null;
  /** Load status the pre-transit ETA was computed for; null once on the road to the drop. */
  stage: string | null;
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
    paceFactor: eta.paceFactor ? Number(eta.paceFactor) : null,
    stage: eta.stage || null,
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
    trip.load_title,
    trip.customer_name,
    trip.vehicle_number,
    trip.driver_name,
    trip.driver_phone,
    trip.origin?.name,
    trip.origin?.city,
    trip.destination?.name,
    trip.destination?.city,
    trip.lr_number,
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
    /** Forward geocoding (Google), for a master place saved without a pin. */
    private readonly geocoder?: Geocoder | null,
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
    // My Fleet shows where the vehicle's own GPS device is — never a phone/SIM fix from its load.
    const [latest, activeTrips] = await Promise.all([
      this.positions.readLatestGps(ids),
      this.repository.activeTripsByVehicle(ids),
    ]);
    const now = Date.now();
    // Addresses come from the Redis-cached resolver (one Google call per ~110 m cell). On a cold
    // cache only the first GEOCODE_MAX_LOOKUPS_PER_REQUEST misses are looked up now; the others are
    // null this time and warmed in the background for the next refresh.
    const positions = await this.withAddresses(
      vehicles.map((vehicle) => {
        const position = latest.get(vehicle.id);
        return position ? toPositionView(position, now) : null;
      }),
    );
    return {
      vehicles: vehicles.map((vehicle, i) => ({
        ...vehicleView(vehicle),
        activeTripId: activeTrips.get(vehicle.id) ?? null,
        position: positions[i],
      })),
      truncated: vehicles.length === MAX_FLEET_VEHICLES,
    };
  }

  async vehicleLocation(scope: TenantScope, vehicleId: string) {
    const vehicle = await this.requireVehicle(scope, vehicleId);
    const [latest, activeTrips] = await Promise.all([
      this.positions.readLatestGps([vehicleId]),
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

  /** Today's running / stopped / idle time and the last 7 days' km, from the GPS device. */
  async vehicleStats(scope: TenantScope, vehicleId: string) {
    await this.requireVehicle(scope, vehicleId);
    const now = Date.now();
    const points = await this.repository.vehicleGpsPoints(
      vehicleId,
      new Date(statsWindowStart(now)),
    );
    return { vehicleId, timezone: 'Asia/Kolkata', ...vehicleStats(points, now) };
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

  async listTrips(scope: TenantScope, state: TripListState, limit: number, query?: string) {
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
    const [metrics, latest, rawEta, routes, driverChanges] = await Promise.all([
      this.positions.readTripMetrics(tripId),
      trip.vehicle_id ? this.positions.readLatest([trip.vehicle_id]) : Promise.resolve(new Map()),
      this.readEta(tripId),
      this.repository.currentRoutes([tripId]),
      // Only created trips are edited here; a load's driver changes in the main backend.
      trip.created ? this.repository.driverChanges(tripId) : Promise.resolve([]),
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
      route: routeView(route),
      // Route km already driven = route length − what the ETA says is left (null until both exist).
      coveredKm: routeKm !== null && eta ? round1(Math.max(0, routeKm - eta.remainingKm)) : null,
      eta,
      driverChanges: driverChanges.map(driverChangeView),
    };
  }

  /** The route in force for the trip (planned, or the ops-approved alternate), for the map. */
  async tripRoute(scope: TenantScope, tripId: string) {
    const trip = await this.requireTrip(scope, tripId);
    const [routes, approach] = await Promise.all([
      this.repository.currentRoutes([tripId]),
      this.repository.approachRoute(tripId),
    ]);
    const route = routes.get(tripId);
    // Where the truck started: the approach leg's first point, with its address when known.
    const start = approach ? (decodePolyline(approach.polyline)[0] ?? null) : null;
    const [startAddress] = await (this.addresses?.resolve([start]) ?? Promise.resolve([null]));
    return {
      tripId,
      routeStatus: trip.route_status,
      route: routeView(route),
      // First tracked point → loading point; display-only, null until planned / when not needed.
      approach: approach
        ? {
            distanceKm: round1(Number(approach.distance_m) / 1000),
            durationMin:
              approach.duration_s === null ? null : Math.round(Number(approach.duration_s) / 60),
            encoding: 'google-polyline-5',
            polyline: approach.polyline,
            startAddress: startAddress ?? null,
          }
        : null,
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

  /** Toll plazas the trip's truck crossed since it was assigned, oldest first. */
  async tripFastag(scope: TenantScope, tripId: string) {
    await this.requireTrip(scope, tripId);
    const rows = await this.repository.tripFastagCrossings(tripId, MAX_FASTAG_CROSSINGS + 1);
    return {
      tripId,
      count: Math.min(rows.length, MAX_FASTAG_CROSSINGS),
      truncated: rows.length > MAX_FASTAG_CROSSINGS,
      crossings: rows.slice(0, MAX_FASTAG_CROSSINGS).map((row) => ({
        seqNo: row.seqNo,
        vehicleNumber: row.vehicleNumber,
        crossedAt: row.crossedAt.toISOString(),
        tollPlaza: { name: row.tollPlazaName, lat: row.lat, lng: row.lng },
        laneDirection: row.laneDirection,
        vehicleType: row.vehicleType,
      })),
    };
  }

  /**
   * Saves a trip from the Create trip drawer (tracking.trips) and returns it in the same shape as
   * GET /trips/:tripId. A trip belongs to one tenant, so a platform admin (all-tenant scope) can't
   * create one here.
   */
  async createTrip(scope: TenantScope, actorId: string, body: CreateTripBody) {
    if ('allTenants' in scope) {
      throw new ValidationError('Create the trip from an organization account');
    }
    await this.assertTruckFree(scope.tenantId, body.vehicleNumber, body.driverPhone);
    const delivery = body.delivery;
    // Decided once, as a load decides on truck assignment: which vehicle id its points carry, the
    // driver's account, and gps > driver_app > sim > fastag. A `sim` trip gets the driver's SIM
    // consent request from the SIM lifecycle on its next tick.
    const [tracking, origin, destination] = await Promise.all([
      this.repository.truckTracking(scope.tenantId, body.vehicleNumber, body.driverPhone),
      this.locate(body.source),
      this.locate(body.destination),
    ]);
    const save = () =>
      this.repository.createTrip({
        ...tracking,
        tenantId: scope.tenantId,
        direction: body.direction,
        customerId: body.customerId ?? null,
        customerName: body.customerName ?? null,
        originKind: body.source.kind,
        originRefId: body.source.id,
        originName: body.source.name,
        originAddress: body.source.address,
        originCity: body.source.city ?? null,
        originLat: origin?.lat ?? null,
        originLng: origin?.lng ?? null,
        destinationKind: body.destination.kind,
        destinationRefId: body.destination.id,
        destinationName: body.destination.name,
        destinationAddress: body.destination.address,
        destinationCity: body.destination.city ?? null,
        destinationLat: destination?.lat ?? null,
        destinationLng: destination?.lng ?? null,
        arrivedPickupAt: null,
        departedPickupAt: null,
        arrivedDropAt: null,
        vehicleNumber: body.vehicleNumber,
        vahanStatus: body.vahanStatus ?? null,
        driverPhone: body.driverPhone,
        driverName: body.driver?.name || null,
        driverLicenceNumber: body.driver?.licenceNumber?.toUpperCase() || null,
        driverDateOfBirth: body.driver?.dateOfBirth ?? null,
        dlStatus: body.driver?.licenceStatus ?? null,
        dlFrontKey: body.driver?.licenceFrontKey ?? null,
        dlBackKey: body.driver?.licenceBackKey ?? null,
        rcKey: body.rcKey ?? null,
        transporterId: body.transporter?.id ?? null,
        transporterName: body.transporter?.name || null,
        transporterPhone: body.transporter?.phone || null,
        loadingReportingAt: body.loading?.reportingAt ?? null,
        deliveryMode: delivery?.mode ?? null,
        deliveryReportingAt: delivery?.mode === 'reporting' ? (delivery.reportingAt ?? null) : null,
        appointmentRef: delivery?.mode === 'appointment' ? delivery.appointmentId || null : null,
        appointmentFrom: delivery?.mode === 'appointment' ? (delivery.slotFrom ?? null) : null,
        appointmentTo: delivery?.mode === 'appointment' ? (delivery.slotTo ?? null) : null,
        ewayBillNumber: body.ewayBill?.number ?? null,
        ewayBillValidTill: body.ewayBill?.validTill ?? null,
        lrNumber: body.lrNumber || null,
        createdBy: actorId,
      });
    const trip = await this.mapTruckConflict(save, scope.tenantId, body);
    return { ...tripView(trip), position: null, eta: null };
  }

  /**
   * Edit tracking on an active created trip: the truck, the driver (and their licence), the
   * destination, the LR number, the e-way bill. A new truck or driver number is tracked as a new one would be (vehicle id, driver
   * account and source decided again); the SIM lifecycle ends the old driver's SIM trip on its
   * next tick and asks the new one for consent when the trip is on SIM.
   */
  async updateTrip(
    scope: TenantScope,
    tripId: string,
    body: UpdateTripBody,
    actorId: string | null = null,
  ) {
    if ('allTenants' in scope) {
      throw new ValidationError('Edit the trip from an organization account');
    }
    const current = await this.repository.findActiveCreatedTrip(scope, tripId);
    if (!current) {
      const existing = await this.requireTrip(scope, tripId);
      throw new ValidationError(
        existing.created
          ? `Trip ${existing.load_code} has ended — it can no longer be edited`
          : 'A load trip is edited from the load',
      );
    }
    const vehicleNumber = body.vehicleNumber ?? current.vehicleNumber;
    const driverPhone = body.driverPhone ?? current.driverPhone;
    const truckChanged =
      vehicleNumber !== current.vehicleNumber || driverPhone !== current.driverPhone;
    const patch: CreatedTripPatch = {};
    if (truckChanged) {
      await this.assertTruckFree(scope.tenantId, vehicleNumber, driverPhone, tripId);
      Object.assign(
        patch,
        { vehicleNumber, driverPhone },
        await this.repository.truckTracking(scope.tenantId, vehicleNumber, driverPhone),
      );
    }
    if (vehicleNumber !== current.vehicleNumber) {
      // A new truck: its own VAHAN result and RC photo (none carried over from the old one).
      patch.vahanStatus = body.vahanStatus ?? null;
      patch.rcKey = body.rcKey ?? null;
    } else {
      if (body.vahanStatus) patch.vahanStatus = body.vahanStatus;
      if (body.rcKey) patch.rcKey = body.rcKey;
    }
    const driver = body.driver;
    if (driver?.name !== undefined) patch.driverName = driver.name || null;
    if (driver?.licenceNumber !== undefined) {
      // A licence re-checked on Sarathi: its own result and photos, none kept from the old one.
      patch.driverLicenceNumber = driver.licenceNumber.toUpperCase() || null;
      patch.driverDateOfBirth = driver.dateOfBirth ?? null;
      patch.dlStatus = driver.licenceStatus ?? null;
      patch.dlFrontKey = driver.licenceFrontKey ?? null;
      patch.dlBackKey = driver.licenceBackKey ?? null;
    }
    if (body.ewayBill?.number !== undefined) patch.ewayBillNumber = body.ewayBill.number;
    if (body.ewayBill?.validTill !== undefined) patch.ewayBillValidTill = body.ewayBill.validTill;
    if (body.lrNumber !== undefined) patch.lrNumber = body.lrNumber || null;
    if (body.destination) {
      const at = await this.locate(body.destination);
      Object.assign(patch, {
        destinationKind: body.destination.kind,
        destinationRefId: body.destination.id,
        destinationName: body.destination.name,
        destinationAddress: body.destination.address,
        destinationCity: body.destination.city ?? null,
        destinationLat: at?.lat ?? null,
        destinationLng: at?.lng ?? null,
      });
    }
    // A new driver number is kept as history: the trip page marks where it changed.
    const driverChange =
      driverPhone !== current.driverPhone
        ? {
            tenantId: current.tenantId,
            fromPhone: current.driverPhone,
            toPhone: driverPhone,
            fromName: current.driverName,
            toName: patch.driverName !== undefined ? patch.driverName : current.driverName,
            changedBy: actorId,
          }
        : undefined;
    const trip = await this.mapTruckConflict(
      () => this.repository.updateCreatedTrip(scope, tripId, patch, driverChange),
      scope.tenantId,
      { vehicleNumber, driverPhone },
    );
    if (!trip)
      throw new ValidationError(`Trip ${current.code} has ended — it can no longer be edited`);
    return { ...tripView(trip), position: null, eta: null };
  }

  /** One trip at a time per truck and per driver, in an account: refuses a second running one. */
  private async assertTruckFree(
    tenantId: string,
    vehicleNumber: string,
    driverPhone: string,
    exceptId?: string,
  ) {
    const running = await this.repository.activeTripOnTruck(
      tenantId,
      vehicleNumber,
      driverPhone,
      exceptId,
    );
    if (running) throw truckBusy(vehicleNumber, running);
  }

  /** Two saves racing past assertTruckFree meet the unique index; the loser gets the same 409. */
  private async mapTruckConflict<T>(
    save: () => Promise<T>,
    tenantId: string,
    truck: { vehicleNumber: string; driverPhone: string },
  ): Promise<T> {
    try {
      return await save();
    } catch (error) {
      if (!isActiveTruckConflict(error)) throw error;
      const running = await this.repository.activeTripOnTruck(
        tenantId,
        truck.vehicleNumber,
        truck.driverPhone,
      );
      throw truckBusy(truck.vehicleNumber, running);
    }
  }

  /** Where a master place is: as the picker sent it, else the master's saved pin, else its
   *  address geocoded. Null when none of them knows (that end then has no arrival check). */
  private async locate(
    place: CreateTripBody['source'],
  ): Promise<{ lat: number; lng: number } | null> {
    if (place.lat !== undefined && place.lng !== undefined)
      return { lat: place.lat, lng: place.lng };
    const master = await this.repository.placeCoordinates(place.kind, place.id);
    if (master || !this.geocoder) return master;
    try {
      return await this.geocoder.geocode(place.address);
    } catch {
      // Deliberately not fatal: the trip is saved without a pin for that end.
      return null;
    }
  }

  /** Ends or cancels a trip created from the tracking screen. Load trips end with their load. */
  async endTrip(scope: TenantScope, tripId: string, body: EndTripBody) {
    const trip = await this.repository.endCreatedTrip(scope, tripId, body.status);
    if (trip) return { ...tripView(trip), position: null, eta: null };
    const existing = await this.requireTrip(scope, tripId);
    throw new ValidationError(
      existing.created
        ? `Trip ${existing.load_code} has already ${existing.created.status === 'cancelled' ? 'been cancelled' : 'been completed'}`
        : 'A load trip ends with its load — close it from the load instead',
    );
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

/** A driver number change, with where the truck was then (its last point; null before any). */
function driverChangeView(change: DriverChangeRow) {
  return {
    changedAt: new Date(change.changed_at).toISOString(),
    fromPhone: change.from_phone,
    toPhone: change.to_phone,
    fromName: change.from_name,
    toName: change.to_name,
    position:
      change.lat !== null && change.lng !== null && change.recorded_at
        ? {
            lat: Number(change.lat),
            lng: Number(change.lng),
            recordedAt: new Date(change.recorded_at).toISOString(),
          }
        : null,
  };
}

function tripView(trip: TripRow) {
  return {
    tripId: trip.id,
    loadCode: trip.load_code,
    loadTitle: trip.load_title,
    loadStatus: trip.load_status,
    postingType: trip.posting_type,
    route: trip.route,
    trackingState: trip.tracking_state,
    // The first ping; null while the trip waits for it.
    trackingStartedAt: trip.tracking_started_at?.toISOString() ?? null,
    trackingSource: trip.tracking_source,
    /** completed | cancelled once it has ended; null while it runs. */
    outcome: trip.outcome,
    lrNumber: trip.lr_number,
    vehicleVerified: trip.vehicle_verified,
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
    promisedDeliveryAt: trip.promised_delivery_at?.toISOString() ?? null,
    ewayBillNumber: trip.eway_bill_number,
    ewayBillExpiresAt: trip.eway_bill_expires_at?.toISOString() ?? null,
    // Trips created from the tracking screen carry no load; these say so and add what they hold.
    trackingOnly: Boolean(trip.created),
    ...(trip.created && {
      direction: trip.created.direction,
      customerId: trip.created.customerId,
      transporterName: trip.created.transporterName,
      transporterPhone: trip.created.transporterPhone,
      driverLicenceNumber: trip.created.driverLicenceNumber,
      driverDateOfBirth: trip.created.driverDateOfBirth,
      dlStatus: trip.created.dlStatus,
      loadingReportingAt: trip.created.loadingReportingAt?.toISOString() ?? null,
      // The stage (trip.entity TRIP_STATUSES) and when each geofence step happened.
      tripStatus: trip.created.status,
      arrivedPickupAt: trip.created.arrivedPickupAt?.toISOString() ?? null,
      departedPickupAt: trip.created.departedPickupAt?.toISOString() ?? null,
      arrivedDropAt: trip.created.arrivedDropAt?.toISOString() ?? null,
      appointment: trip.created.appointment && {
        id: trip.created.appointment.ref,
        from: trip.created.appointment.from?.toISOString() ?? null,
        to: trip.created.appointment.to?.toISOString() ?? null,
      },
      createdAt: trip.created.createdAt.toISOString(),
    }),
  };
}

/** The 409 for a truck, or a driver, already on a running trip in this account. */
function truckBusy(
  vehicleNumber: string,
  running: { id: string; code: string; kind: 'trip' | 'load'; busy: 'truck' | 'driver' } | null,
) {
  const where = running ? ` (${running.kind === 'load' ? 'load' : 'trip'} ${running.code})` : '';
  const message =
    running?.busy === 'driver'
      ? `This driver is already on an active trip${where}. End it before starting another.`
      : `Truck ${vehicleNumber} is already on an active trip${where}. End it before starting another.`;
  return new ConflictError(
    message,
    running
      ? { tripId: running.id, code: running.code, kind: running.kind, busy: running.busy }
      : undefined,
  );
}
