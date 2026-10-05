import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { Counter } from 'prom-client';
import type { Namespace } from 'socket.io';
import { metricsRegistry } from '../../shared/metrics';
import type { LatestPosition } from '../processing/vehicle-state.store';
import { LIVE_ALERTS_CHANNEL } from '../rules';
import type { AlertChange } from '../rules';
import { toAlertView } from '../alerts';
import { toPositionView } from '../tracking-api';
import { LIVE_POSITIONS_CHANNEL } from './live-channel';
import { ALL_TENANTS_ROOM, tenantRoom, tripRoom, vehicleRoom } from './live-rooms';

const updatesEmitted = new Counter({
  name: 'tracking_live_updates_emitted_total',
  help: 'Position updates pushed to /live rooms by this instance',
  registers: [metricsRegistry],
});

/**
 * Subscribes to the processors' live-positions channel and pushes `position` events to the /live
 * rooms each update belongs to (its tenant's fleet room, the vehicle room, the trip room).
 *
 * Throttled per vehicle with a trailing edge: at most one push per `minIntervalMs`, and the
 * newest position always gets delivered (never dropped, only delayed). Keeps map clients calm
 * even if a vehicle reports from two sources at once.
 */
export class LiveFanout {
  private readonly lastEmitAt = new Map<string, number>();
  private readonly pending = new Map<string, LatestPosition>();
  private readonly timers = new Map<string, NodeJS.Timeout>();

  constructor(
    private readonly namespace: Namespace,
    private readonly subscriber: Redis,
    private readonly logger: Logger,
    private readonly minIntervalMs = 5000,
  ) {}

  async start(): Promise<void> {
    this.subscriber.on('message', (channel, message) => {
      try {
        if (channel === LIVE_POSITIONS_CHANNEL) {
          for (const position of JSON.parse(message) as LatestPosition[]) this.offer(position);
        } else if (channel === LIVE_ALERTS_CHANNEL) {
          for (const change of JSON.parse(message) as AlertChange[]) this.emitAlert(change);
        }
      } catch (err) {
        this.logger.warn({ err, channel }, 'Dropping malformed live message');
      }
    });
    await this.subscriber.subscribe(LIVE_POSITIONS_CHANNEL, LIVE_ALERTS_CHANNEL);
  }

  /** Alerts are never throttled: every open / escalate / close reaches the viewer. */
  private emitAlert({ type, alert }: AlertChange): void {
    const rooms = [ALL_TENANTS_ROOM, tenantRoom(alert.tenant_id), vehicleRoom(alert.vehicle_id)];
    if (alert.trip_id) rooms.push(tripRoom(alert.trip_id));
    this.namespace.to(rooms).emit('alert', { type, alert: toAlertView(alert) });
  }

  async stop(): Promise<void> {
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
    await this.subscriber
      .unsubscribe(LIVE_POSITIONS_CHANNEL, LIVE_ALERTS_CHANNEL)
      .catch(() => undefined);
  }

  private offer(position: LatestPosition): void {
    const { vehicleId } = position;
    const current = this.pending.get(vehicleId);
    if (current && Date.parse(current.recordedAt) > Date.parse(position.recordedAt)) return;

    const sinceLast = Date.now() - (this.lastEmitAt.get(vehicleId) ?? 0);
    if (sinceLast >= this.minIntervalMs && !this.timers.has(vehicleId)) {
      this.emit(position);
      return;
    }
    this.pending.set(vehicleId, position);
    if (!this.timers.has(vehicleId)) {
      this.timers.set(
        vehicleId,
        setTimeout(
          () => {
            this.timers.delete(vehicleId);
            const next = this.pending.get(vehicleId);
            this.pending.delete(vehicleId);
            if (next) this.emit(next);
          },
          Math.max(0, this.minIntervalMs - sinceLast),
        ),
      );
    }
  }

  private emit(position: LatestPosition): void {
    this.lastEmitAt.set(position.vehicleId, Date.now());
    const rooms = [
      ALL_TENANTS_ROOM,
      tenantRoom(position.tenantId),
      vehicleRoom(position.vehicleId),
    ];
    if (position.tripId) rooms.push(tripRoom(position.tripId));
    // A socket in several of these rooms still receives the event once.
    this.namespace.to(rooms).emit('position', {
      vehicleId: position.vehicleId,
      tripId: position.tripId,
      position: toPositionView(position),
    });
    updatesEmitted.inc();
  }
}
