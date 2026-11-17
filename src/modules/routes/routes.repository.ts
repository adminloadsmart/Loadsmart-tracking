import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { MainDataRepository } from '../main-data';
import { IN_TRANSIT_STATUS } from '../trips';

export interface TripNeedingRoute {
  id: string;
  tenant_id: string;
  promised_delivery_at: Date | null;
  route_attempts: number;
  origin_id: string | null;
  origin_lat: number | null;
  origin_lng: number | null;
  destination_id: string | null;
  destination_lat: number | null;
  destination_lng: number | null;
  destination_address: string | null;
}

export interface TripRouteRow {
  id: string;
  trip_id: string;
  version: number;
  kind: 'planned' | 'approved_alternate';
  polyline: string;
  distance_m: number;
  duration_s: number | null;
  promised_at: Date | null;
  created_at: Date;
}

export interface InTransitTrip {
  id: string;
  tenant_id: string;
  vehicle_id: string;
  tracking_started_at: Date | null;
  promised_delivery_at: Date | null;
}

export interface TripNeedingApproach {
  id: string;
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
}

export interface ApproachRouteRow {
  trip_id: string;
  polyline: string | null;
  distance_m: number | null;
  duration_s: number | null;
}

const MAX_BACKOFF_MIN = 360;
/** The drive to the plant — after loading, a first point no longer starts an approach. */
const APPROACH_STATUSES: readonly string[] = [
  'truck_assigned',
  'in_transit_loading',
  'reached_loading',
];
const APPROACH_TABLE = 'tracking.trip_approach_routes';

export class RoutesRepository {
  private readonly mainData: MainDataRepository;

  constructor(private readonly dataSource: DataSource) {
    this.mainData = new MainDataRepository(dataSource);
  }

  /**
   * Active trips (the main backend's loads) with no route yet, whose last planning attempt is
   * older than their back-off — with their origin / destination from main's places.
   */
  async tripsNeedingRoute(limit: number): Promise<TripNeedingRoute[]> {
    const active = await this.mainData.activeLoads();
    if (active.length === 0) return [];
    const ids = active.map((l) => l.id);
    const [routed, statuses] = await Promise.all([
      this.dataSource.query(
        `SELECT DISTINCT trip_id FROM tracking.trip_routes WHERE trip_id = ANY($1::uuid[])`,
        [ids],
      ),
      this.dataSource.query(
        `SELECT trip_id, attempts, checked_at FROM tracking.trip_route_status WHERE trip_id = ANY($1::uuid[])`,
        [ids],
      ),
    ]);
    const hasRoute = new Set(routed.map((r: { trip_id: string }) => r.trip_id));
    const status = new Map<string, { attempts: number; checked_at: Date }>(
      statuses.map((r: { trip_id: string; attempts: number; checked_at: Date }) => [r.trip_id, r]),
    );
    const now = Date.now();
    const due = active
      .filter((load) => {
        if (hasRoute.has(load.id)) return false;
        const st = status.get(load.id);
        if (!st) return true;
        const backoffMin = Math.min(MAX_BACKOFF_MIN, 5 * 2 ** st.attempts);
        return now - new Date(st.checked_at).getTime() > backoffMin * 60_000;
      })
      .sort((a, b) => (a.startedAt?.getTime() ?? Infinity) - (b.startedAt?.getTime() ?? Infinity))
      .slice(0, limit);

    const places = await this.mainData.places(
      due.map((l) => l.loadingPointId).filter((x): x is string => !!x),
      due.map((l) => l.deliveryPointId).filter((x): x is string => !!x),
    );
    return due.map((load) => {
      const origin = load.loadingPointId ? places.get(load.loadingPointId) : undefined;
      const destination = load.deliveryPointId ? places.get(load.deliveryPointId) : undefined;
      return {
        id: load.id,
        tenant_id: load.tenantId,
        promised_delivery_at: load.promisedDeliveryAt,
        route_attempts: status.get(load.id)?.attempts ?? 0,
        origin_id: origin?.id ?? null,
        origin_lat: origin?.lat ?? null,
        origin_lng: origin?.lng ?? null,
        destination_id: destination?.id ?? null,
        destination_lat: destination?.lat ?? null,
        destination_lng: destination?.lng ?? null,
        destination_address: destination
          ? [destination.name, destination.address].filter(Boolean).join(', ')
          : null,
      };
    });
  }

  /**
   * Trips still heading to the plant with no approach leg yet, with the first point the
   * truck was tracked at (origin) and the loading point (destination). Trips with no tracked
   * point yet are left for a later run.
   */
  async tripsNeedingApproach(limit: number): Promise<TripNeedingApproach[]> {
    const active = await this.mainData.activeLoads();
    if (active.length === 0) return [];
    const ids = active.map((l) => l.id);

    const done = await this.dataSource
      .createQueryBuilder()
      .select('a.trip_id', 'trip_id')
      .from(APPROACH_TABLE, 'a')
      .where('a.trip_id IN (:...ids)', { ids })
      .getRawMany<{ trip_id: string }>();
    const hasApproach = new Set(done.map((r) => r.trip_id));
    // Only while the truck is still on its way to the plant: its first point as soon as the truck
    // is assigned, independent of whether the loading → delivery route is planned yet.
    const pending = active
      .filter(
        (l) => APPROACH_STATUSES.includes(l.status) && !hasApproach.has(l.id) && l.loadingPointId,
      )
      .slice(0, limit);
    if (pending.length === 0) return [];

    const places = await this.mainData.places(
      pending.map((l) => l.loadingPointId).filter((x): x is string => !!x),
      [],
    );
    const result: TripNeedingApproach[] = [];
    for (const load of pending) {
      const loading = load.loadingPointId ? places.get(load.loadingPointId) : undefined;
      if (!loading || loading.lat === null || loading.lng === null) continue;
      const first = await this.dataSource
        .createQueryBuilder()
        .select(['p.lat AS lat', 'p.lng AS lng'])
        .from('tracking.location_points', 'p')
        .where('p.trip_id = :tripId', { tripId: load.id })
        .orderBy('p.recorded_at', 'ASC')
        .limit(1)
        .getRawOne<{ lat: number; lng: number }>();
      if (!first) continue;
      result.push({
        id: load.id,
        origin: { lat: Number(first.lat), lng: Number(first.lng) },
        destination: { lat: loading.lat, lng: loading.lng },
      });
    }
    return result;
  }

  async saveApproachRoute(input: {
    tripId: string;
    origin: { lat: number; lng: number };
    route: { polyline: string; distanceM: number; durationS: number | null } | null;
    provider: string | null;
  }): Promise<void> {
    await this.dataSource
      .createQueryBuilder()
      .insert()
      .into(APPROACH_TABLE, [
        'trip_id',
        'origin_lat',
        'origin_lng',
        'polyline',
        'distance_m',
        'duration_s',
        'provider',
      ])
      .values({
        trip_id: input.tripId,
        origin_lat: input.origin.lat,
        origin_lng: input.origin.lng,
        polyline: input.route?.polyline ?? null,
        distance_m: input.route?.distanceM ?? null,
        duration_s: input.route?.durationS ?? null,
        provider: input.route ? input.provider : null,
      })
      .orIgnore()
      .execute();
  }

  async setRouteStatus(tripId: string, status: string, attempted: boolean): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO tracking.trip_route_status (trip_id, status, attempts, checked_at)
       VALUES ($1, $2, CASE WHEN $3 THEN 1 ELSE 0 END, now())
       ON CONFLICT (trip_id) DO UPDATE
         SET status = EXCLUDED.status, checked_at = now(),
             attempts = tracking.trip_route_status.attempts + CASE WHEN $3 THEN 1 ELSE 0 END`,
      [tripId, status, attempted],
    );
  }

  /** Delivery-point coordinates are tracking's own cache (main stores only the address). */
  async saveGeocode(placeId: string, lat: number, lng: number, source: string): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO tracking.place_geocodes (place_id, lat, lng, source) VALUES ($1, $2, $3, $4)
       ON CONFLICT (place_id) DO NOTHING`,
      [placeId, lat, lng, source],
    );
  }

  /** Appends a route version. */
  async insertRoute(input: {
    tripId: string;
    kind: 'planned' | 'approved_alternate';
    polyline: string;
    distanceM: number;
    durationS: number | null;
    provider: string;
    promisedAt: Date | null;
    createdBy: string | null;
  }): Promise<TripRouteRow> {
    const rows: TripRouteRow[] = await this.dataSource.query(
      `INSERT INTO tracking.trip_routes
         (id, trip_id, version, kind, polyline, distance_m, duration_s, provider, promised_at, created_by)
       VALUES ($1, $2,
               COALESCE((SELECT max(version) FROM tracking.trip_routes WHERE trip_id = $2), 0) + 1,
               $3, $4, $5, $6, $7, $8, $9)
       RETURNING id, trip_id, version, kind, polyline, distance_m, duration_s, promised_at, created_at`,
      [
        randomUUID(),
        input.tripId,
        input.kind,
        input.polyline,
        input.distanceM,
        input.durationS,
        input.provider,
        input.promisedAt,
        input.createdBy,
      ],
    );
    return rows[0];
  }

  routesFor(tripIds: string[]): Promise<TripRouteRow[]> {
    if (tripIds.length === 0) return Promise.resolve([]);
    return this.dataSource.query(
      `SELECT id, trip_id, version, kind, polyline, distance_m, duration_s, promised_at, created_at
       FROM tracking.trip_routes WHERE trip_id = ANY($1::uuid[]) ORDER BY trip_id, version`,
      [tripIds],
    );
  }

  /** Trips the DELAY rule evaluates: load in transit, with a vehicle and a planned route. */
  async inTransitTripsWithRoute(): Promise<InTransitTrip[]> {
    const loads = (await this.mainData.loadsByStatus(null, [IN_TRANSIT_STATUS], 50_000)).filter(
      (l) => l.vehicleId,
    );
    if (loads.length === 0) return [];
    const routed: Array<{ trip_id: string }> = await this.dataSource.query(
      `SELECT DISTINCT trip_id FROM tracking.trip_routes WHERE trip_id = ANY($1::uuid[])`,
      [loads.map((l) => l.id)],
    );
    const hasRoute = new Set(routed.map((r) => r.trip_id));
    return loads
      .filter((l) => hasRoute.has(l.id))
      .map((l) => ({
        id: l.id,
        tenant_id: l.tenantId,
        vehicle_id: l.vehicleId!,
        tracking_started_at: l.startedAt,
        promised_delivery_at: l.promisedDeliveryAt,
      }));
  }
}
