import { Gauge } from 'prom-client';
import type { Namespace, Socket } from 'socket.io';
import { z } from 'zod';
import type { IsTokenBlocked } from '../../shared/auth/token-blocklist';
import {
  StaffIdentity,
  TenantScope,
  tenantScopeFor,
  verifyStaffToken,
} from '../../shared/auth/staff-token';
import { AppError } from '../../shared/errors';
import { metricsRegistry } from '../../shared/metrics';
import type { TrackingApiService } from '../tracking-api/tracking-api.service';
import { ALL_TENANTS_ROOM, tenantRoom, tripRoom, vehicleRoom } from './live-rooms';

const liveViewers = new Gauge({
  name: 'tracking_live_viewers',
  help: 'Connected /live (map viewer) sockets on this instance',
  registers: [metricsRegistry],
});

const subscriptionSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('fleet') }),
  z.object({ type: z.literal('vehicle'), id: z.uuid() }),
  z.object({ type: z.literal('trip'), id: z.uuid() }),
]);
type Subscription = z.infer<typeof subscriptionSchema>;

type SubscribeAck =
  | { ok: true; snapshot: unknown }
  | { ok: false; error: 'invalid_payload' | 'not_found' | 'unavailable' };

interface ViewerData {
  identity: StaffIdentity;
  scope: TenantScope;
}

/** Handshake: the same staff access token the REST API takes (main backend's portal login). */
export function createLiveSocketAuth(deps: { jwtSecret: string; isBlocked: IsTokenBlocked }) {
  return async (socket: Socket, next: (err?: Error) => void): Promise<void> => {
    const raw = socket.handshake.auth?.token;
    const token = typeof raw === 'string' ? raw.replace(/^Bearer\s+/i, '') : null;
    const identity = token ? verifyStaffToken(token, deps.jwtSecret) : null;
    const scope = identity ? tenantScopeFor(identity) : null;
    if (!identity || !scope || (await deps.isBlocked(identity.jti))) {
      next(new Error('unauthorized'));
      return;
    }
    socket.data.viewer = { identity, scope } satisfies ViewerData;
    next();
  };
}

function roomFor(subscription: Subscription, scope: TenantScope): string {
  switch (subscription.type) {
    case 'fleet':
      return 'allTenants' in scope ? ALL_TENANTS_ROOM : tenantRoom(scope.tenantId);
    case 'vehicle':
      return vehicleRoom(subscription.id);
    case 'trip':
      return tripRoom(subscription.id);
  }
}

/**
 * The /live namespace for the web map (docs/contracts/tracking-api.md). A viewer subscribes to its
 * fleet, a vehicle or a trip; each subscribe is checked against the viewer's tenant scope (via the
 * same service the REST API uses, so access rules can't drift) and acked with a snapshot, after
 * which `position` events stream in from LiveFanout.
 */
export function registerLiveNamespace(namespace: Namespace, service: TrackingApiService): void {
  namespace.on('connection', (socket) => {
    const { identity, scope } = socket.data.viewer as ViewerData;
    liveViewers.inc();

    const expiryTimer = setTimeout(
      () => {
        socket.emit('auth:expired');
        socket.disconnect(true);
      },
      Math.min(Math.max(0, identity.exp * 1000 - Date.now()), 2 ** 31 - 1),
    );

    socket.on('subscribe', async (payload: unknown, ack?: (response: SubscribeAck) => void) => {
      if (typeof ack !== 'function') return;
      const parsed = subscriptionSchema.safeParse(payload);
      if (!parsed.success) {
        ack({ ok: false, error: 'invalid_payload' });
        return;
      }
      const subscription = parsed.data;
      try {
        // The snapshot lookup doubles as the access check: out-of-scope → NotFoundError.
        const snapshot =
          subscription.type === 'fleet'
            ? await service.fleetLive(scope)
            : subscription.type === 'vehicle'
              ? await service.vehicleLocation(scope, subscription.id)
              : await service.trip(scope, subscription.id);
        await socket.join(roomFor(subscription, scope));
        ack({ ok: true, snapshot });
      } catch (err) {
        ack({
          ok: false,
          error: err instanceof AppError && err.statusCode === 404 ? 'not_found' : 'unavailable',
        });
      }
    });

    socket.on(
      'unsubscribe',
      async (payload: unknown, ack?: (response: { ok: boolean }) => void) => {
        const parsed = subscriptionSchema.safeParse(payload);
        if (parsed.success) await socket.leave(roomFor(parsed.data, scope));
        if (typeof ack === 'function') ack({ ok: parsed.success });
      },
    );

    socket.on('disconnect', () => {
      clearTimeout(expiryTimer);
      liveViewers.dec();
    });
  });
}
