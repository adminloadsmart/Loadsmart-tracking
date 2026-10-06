import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { MainDataRepository } from '../main-data';
import { returningRows } from '../../db/returning';
import type { StaffIdentity, TenantScope } from '../../shared/auth/staff-token';
import { hasPermission } from '../../shared/auth/staff-token';
import { AuthorizationError, NotFoundError, ValidationError } from '../../shared/errors';
import { vehicleLatestKey } from '../processing/vehicle-state.store';
import type { RouteProvider } from './google.client';
import { RouteGeometry } from './route-geometry';
import type { RouteStore } from './route.store';
import { RoutesRepository } from './routes.repository';

export const TRACKING_ROUTES_APPROVE = 'tracking.routes.approve';
const LIVE_ALERTS_CHANNEL = 'trk:live:alerts';

/**
 * Ops approve an alternate route and/or a new promised time for a trip (rule sheet: DEV-GPS
 * "ops can approve an alternate route to close the alert"; DELAY-GPS "when ops approve a new
 * route or a new promised time, recompute from that moment").
 * The alternate is either supplied (encoded polyline) or planned now from the truck's latest
 * position to the drop. Open deviation alerts close; the delay rule re-evaluates at once.
 */
export class RouteApprovalService {
  private readonly mainData: MainDataRepository;

  constructor(
    private readonly dataSource: DataSource,
    private readonly repository: RoutesRepository,
    private readonly provider: RouteProvider | null,
    private readonly routeStore: RouteStore,
    private readonly redis: Redis,
  ) {
    this.mainData = new MainDataRepository(dataSource);
  }

  async approve(
    scope: TenantScope,
    user: StaffIdentity,
    tripId: string,
    input: { reason: string; polyline?: string; replan?: boolean; promisedDeliveryAt?: Date },
  ) {
    if (!hasPermission(user, TRACKING_ROUTES_APPROVE)) {
      throw new AuthorizationError(`Requires permission ${TRACKING_ROUTES_APPROVE}`);
    }
    const load = await this.mainData.load(scope, tripId);
    if (!load) throw new NotFoundError(`Trip ${tripId} not found`);
    const trip = { id: load.id, vehicle_id: load.vehicleId };
    const existing = await this.repository.routesFor([tripId]);
    if (existing.length === 0) throw new ValidationError('Trip has no planned route yet');
    const current = existing[existing.length - 1];

    // Three ways to approve: a supplied alternate, a re-plan from the truck's current position,
    // or only a new promised time on the current geometry.
    let polyline = current.polyline;
    let distanceM = current.distance_m;
    let durationS: number | null = current.duration_s;
    let provider = 'ops';
    if (input.polyline) {
      polyline = input.polyline;
      distanceM = RouteGeometry.fromPolyline(input.polyline).lengthM;
      durationS = null;
    } else if (input.replan) {
      if (!this.provider)
        throw new ValidationError('Route planning is not configured (GOOGLE_MAPS_API_KEY)');
      const latest = trip.vehicle_id
        ? await this.redis.hgetall(vehicleLatestKey(trip.vehicle_id))
        : {};
      if (!latest.lat) throw new ValidationError('No recent position for this vehicle');
      const destination = RouteGeometry.fromPolyline(current.polyline).end;
      const planned = await this.provider.computeRoute(
        { lat: Number(latest.lat), lng: Number(latest.lng) },
        destination,
      );
      if (!planned) throw new ValidationError('No route found from the current position');
      ({ polyline, distanceM, durationS } = planned);
      provider = this.provider.name;
    } else if (!input.promisedDeliveryAt) {
      throw new ValidationError('Provide a polyline, replan: true, or a promisedDeliveryAt');
    }

    const route = await this.repository.insertRoute({
      tripId,
      kind: 'approved_alternate',
      polyline,
      distanceM,
      durationS,
      provider,
      promisedAt: input.promisedDeliveryAt ?? current.promised_at,
      createdBy: user.userId,
    });

    // Close open deviation alerts for the trip — the new route is on-route by definition.
    const closed = await this.dataSource.transaction(async (manager) => {
      const rows = returningRows<Record<string, unknown>>(
        await manager.query(
          `UPDATE tracking.alerts
             SET status = 'closed', closed_at = now(), close_reason = 'alternate_approved',
                 acknowledged_by = COALESCE(acknowledged_by, $2), updated_at = now()
           WHERE trip_id = $1 AND rule_id IN ('DEV-GPS', 'DEV-SIM') AND status <> 'closed'
           RETURNING *`,
          [tripId, user.userId],
        ),
      );
      for (const row of rows) {
        await manager.query(
          `INSERT INTO tracking.alert_outbox (event_type, payload) VALUES ('alert.closed', $1)`,
          [JSON.stringify(row)],
        );
      }
      return rows;
    });
    if (closed.length > 0) {
      await this.redis.publish(
        LIVE_ALERTS_CHANNEL,
        JSON.stringify(closed.map((alert) => ({ type: 'alert.closed', alert }))),
      );
    }

    // Recompute delay from this moment: reset its streaks and evaluate on the next tick.
    await this.redis.hset(`trk:delay:${tripId}`, {
      lastEvalMs: '0',
      consecWarn: '0',
      consecCrit: '0',
      consecClear: '0',
    });
    this.routeStore.invalidate(tripId);

    return {
      tripId,
      version: route.version,
      kind: route.kind,
      distanceKm: Math.round(route.distance_m / 100) / 10,
      promisedAt: route.promised_at ? new Date(route.promised_at).toISOString() : null,
      reason: input.reason,
      closedDeviationAlerts: closed.length,
    };
  }
}
