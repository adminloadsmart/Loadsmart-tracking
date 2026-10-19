import type { Logger } from 'pino';
import { Counter, Gauge, Histogram } from 'prom-client';
import type { Namespace } from 'socket.io';
import { metricsRegistry } from '../../shared/metrics';
import type { NormalizedPoint, PointPublisher } from '../points';
import { DriverIdentity } from './driver-socket-auth';
import {
  PhonePoint,
  phoneBatchSchema,
  phonePointSchema,
  toNormalizedPoint,
} from './driver-point.contract';
import { TripResolver } from './trip-resolver';

const driverSockets = new Gauge({
  name: 'tracking_driver_sockets',
  help: 'Connected driver-app sockets on this instance',
  registers: [metricsRegistry],
});
const ackSeconds = new Histogram({
  name: 'tracking_socket_ack_seconds',
  help: 'Time from receiving a driver loc/loc:batch to acking it',
  labelNames: ['event'] as const,
  buckets: [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5],
  registers: [metricsRegistry],
});
const pointsReceived = new Counter({
  name: 'tracking_points_received_total',
  help: 'Points received at ingest, by source and result',
  labelNames: ['source', 'result'] as const,
  registers: [metricsRegistry],
});

/**
 * Largest single socket message accepted. Phones report coordinates as full-precision doubles, so a
 * full 200-point `loc:batch` is ~67 KB; anything over the limit makes socket.io drop the connection
 * with no ack, and the app would resend the same batch forever. 256 KB leaves ~4× headroom.
 */
export const DRIVER_SOCKET_MAX_MESSAGE_BYTES = 256 * 1024;

export type AckError = 'invalid_payload' | 'rate_limited' | 'unavailable';
export type Ack = { ok: true; accepted: number; noTrip: number } | { ok: false; error: AckError };

export interface DriverSocketOptions {
  /** Minimum gap between two `loc` events on one socket. */
  minLocIntervalMs: number;
  /** Minimum gap between two `loc:batch` events on one socket. */
  minBatchIntervalMs: number;
}

interface Deps {
  publisher: PointPublisher;
  resolver: TripResolver;
  logger: Logger;
  options: DriverSocketOptions;
}

/**
 * The /driver namespace: phone GPS ingest (docs/contracts/driver-socket.md). Every event is acked
 * only after its points are durably on the point stream — the app deletes a point from its local
 * queue only on { ok: true }, which makes delivery at-least-once across flaky mobile networks.
 */
export function registerDriverNamespace(namespace: Namespace, deps: Deps): void {
  namespace.on('connection', (socket) => {
    const driver = socket.data.driver as DriverIdentity;
    const log = deps.logger.child({ driverId: driver.driverId, socketId: socket.id });
    driverSockets.inc();
    log.info({ tenantId: driver.tenantId }, 'Driver socket connected');
    // Raw payloads are debug-only (LOG_LEVEL=debug); unknown event names show up here too.
    socket.onAny((event: string, payload: unknown) =>
      log.debug({ event, payload }, 'Driver socket event'),
    );

    // The access token is short-lived but the socket isn't: drop the connection when the token
    // expires; the client reconnects with a fresh token via its `auth` callback.
    const expiresInMs = driver.exp * 1000 - Date.now();
    const expiryTimer = setTimeout(
      () => {
        socket.emit('auth:expired');
        socket.disconnect(true);
      },
      // setTimeout overflows above ~24.8 days; access tokens live minutes, so clamp defensively.
      Math.min(Math.max(0, expiresInMs), 2 ** 31 - 1),
    );

    let lastLocAt = 0;
    let lastBatchAt = 0;

    socket.on('loc', async (payload: unknown, ack?: (response: Ack) => void) => {
      if (typeof ack !== 'function') return;
      const startedAt = process.hrtime.bigint();
      const now = Date.now();
      if (now - lastLocAt < deps.options.minLocIntervalMs) {
        pointsReceived.inc({ source: 'driver_app', result: 'rate_limited' });
        respond(ack, { ok: false, error: 'rate_limited' }, 'loc', startedAt, log);
        return;
      }
      lastLocAt = now;
      const parsed = phonePointSchema.safeParse(payload);
      if (!parsed.success) {
        pointsReceived.inc({ source: 'driver_app', result: 'invalid' });
        log.debug({ event: 'loc', issues: parsed.error.issues }, 'Invalid driver payload');
        respond(ack, { ok: false, error: 'invalid_payload' }, 'loc', startedAt, log);
        return;
      }
      respond(ack, await ingest(deps, driver, [parsed.data], log), 'loc', startedAt, log);
    });

    socket.on('loc:batch', async (payload: unknown, ack?: (response: Ack) => void) => {
      if (typeof ack !== 'function') return;
      const startedAt = process.hrtime.bigint();
      const now = Date.now();
      if (now - lastBatchAt < deps.options.minBatchIntervalMs) {
        pointsReceived.inc({ source: 'driver_app', result: 'rate_limited' });
        respond(ack, { ok: false, error: 'rate_limited' }, 'loc:batch', startedAt, log);
        return;
      }
      lastBatchAt = now;
      const parsed = phoneBatchSchema.safeParse(payload);
      if (!parsed.success) {
        pointsReceived.inc({ source: 'driver_app', result: 'invalid' });
        log.debug({ event: 'loc:batch', issues: parsed.error.issues }, 'Invalid driver payload');
        respond(ack, { ok: false, error: 'invalid_payload' }, 'loc:batch', startedAt, log);
        return;
      }
      respond(ack, await ingest(deps, driver, parsed.data, log), 'loc:batch', startedAt, log);
    });

    socket.on('disconnect', (reason) => {
      clearTimeout(expiryTimer);
      driverSockets.dec();
      log.info({ reason }, 'Driver socket disconnected');
    });
  });
}

async function ingest(
  deps: Deps,
  driver: DriverIdentity,
  points: PhonePoint[],
  log: Logger,
): Promise<Ack> {
  try {
    const recordedAts = points.map((point) => new Date(point.recordedAt).toISOString());
    const trips = await deps.resolver.resolve(driver.driverId, driver.tenantId, recordedAts);
    const receivedAt = new Date().toISOString();

    const normalized: NormalizedPoint[] = [];
    points.forEach((point, i) => {
      const trip = trips[i];
      if (!trip) return;
      normalized.push(
        toNormalizedPoint(
          point,
          {
            tenantId: trip.tenantId,
            vehicleId: trip.vehicleId,
            tripId: trip.tripId,
            driverId: driver.driverId,
            approachTripId: trip.approachTripId,
          },
          receivedAt,
        ),
      );
    });

    await deps.publisher.publish(normalized);
    const noTrip = points.length - normalized.length;
    if (normalized.length > 0) {
      pointsReceived.inc({ source: 'driver_app', result: 'accepted' }, normalized.length);
    }
    if (noTrip > 0) pointsReceived.inc({ source: 'driver_app', result: 'no_trip' }, noTrip);
    return { ok: true, accepted: normalized.length, noTrip };
  } catch (err) {
    log.error({ err, count: points.length }, 'Failed to ingest driver points');
    return { ok: false, error: 'unavailable' };
  }
}

function respond(
  ack: (response: Ack) => void,
  response: Ack,
  event: string,
  startedAt: bigint,
  log: Logger,
): void {
  log.debug({ event, response }, 'Driver socket ack');
  ack(response);
  ackSeconds.observe({ event }, Number(process.hrtime.bigint() - startedAt) / 1e9);
}
