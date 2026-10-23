import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { MainDataRepository, MainLoad } from '../main-data';
import { VehicleStateStore } from '../processing/vehicle-state.store';
import { noticeId } from './rule-helpers';
import type { SignalLossStep } from './rule.types';
import type { RulesRepository, VehicleEffects } from './rules.repository';

const HOUR_MS = 60 * 60_000;
const RUN_EVERY_MS = 5 * 60_000;
/** LS_N_0029 steps, in hours of silence: first notice, second, then one every DAILY_EVERY_H. */
const FIRST_STEP_H = 4;
const SECOND_STEP_H = 12;
const DAILY_FROM_H = 36;
const DAILY_EVERY_H = 24;

type LoadWithVehicle = MainLoad & { vehicleId: string };

/**
 * Which LS_N_0029 step a silence of this length has reached: once at 4 h, again at 12 h, then
 * once a day (36 h, 60 h, …). Null under 4 h. Only the step reached is sent — a monitor that
 * was down for a day doesn't catch up with every step it missed.
 */
export function signalLossStep(silenceMs: number): SignalLossStep | null {
  const hours = silenceMs / HOUR_MS;
  if (hours < FIRST_STEP_H) return null;
  if (hours < SECOND_STEP_H) return '4h';
  if (hours < DAILY_FROM_H) return '12h';
  return `day_${1 + Math.floor((hours - DAILY_FROM_H) / DAILY_EVERY_H)}`;
}

/** When a load became a running trip (At plant or loading confirmed, whichever came first). */
function runningSinceMs(load: MainLoad): number | null {
  const times = [load.milestones.atPlantAt, load.milestones.loadingConfirmedAt]
    .filter((t): t is string => !!t)
    .map((t) => Date.parse(t));
  return times.length > 0 ? Math.min(...times) : null;
}

/**
 * LS_N_0029 "tracking signal lost" (scheduler leader, every 5 min): a running trip — At plant
 * to delivery — with no position from any source for 4 h. Silence counts from the newest
 * position, or from when the trip started running if the truck hasn't reported since (a device
 * that never reports at all is the failure this exists for). Each step is a trip notice with a
 * deterministic id, so repeated ticks send it once; a position arriving resets the clock.
 */
export class SignalLossMonitor {
  private lastRunMs = 0;
  private readonly states: VehicleStateStore;

  constructor(
    redis: Redis,
    private readonly mainData: MainDataRepository,
    private readonly repository: RulesRepository,
    private readonly logger: Logger,
  ) {
    this.states = new VehicleStateStore(redis);
  }

  async tick(nowMs = Date.now()): Promise<void> {
    if (nowMs - this.lastRunMs < RUN_EVERY_MS) return;
    this.lastRunMs = nowMs;

    const loads = (await this.mainData.activeLoads()).filter(
      (l): l is LoadWithVehicle => !!l.vehicleId,
    );
    const latest = await this.states.readLatest(loads.map((l) => l.vehicleId));
    const batch: VehicleEffects[] = [];

    for (const load of loads) {
      const since = runningSinceMs(load);
      if (since === null) continue;
      const position = latest.get(load.vehicleId);
      // A position from before this trip started running (an earlier trip) doesn't count.
      const seenOnTrip = position && Date.parse(position.recordedAt) >= since ? position : null;
      const lastSeenMs = seenOnTrip ? Date.parse(seenOnTrip.recordedAt) : since;
      const step = signalLossStep(nowMs - lastSeenMs);
      if (!step) continue;
      batch.push({
        tenantId: load.tenantId,
        vehicleId: load.vehicleId,
        episodes: [],
        alerts: [],
        notices: [
          {
            id: noticeId(load.id, `signal_lost|${lastSeenMs}|${step}`),
            type: 'trip.signal_lost',
            tripId: load.id,
            payload: {
              step,
              lastSeenAt: new Date(lastSeenMs).toISOString(),
              hoursSince: Math.floor((nowMs - lastSeenMs) / HOUR_MS),
              lastLat: seenOnTrip?.lat ?? null,
              lastLng: seenOnTrip?.lng ?? null,
              occurredAt: new Date(nowMs).toISOString(),
            },
          },
        ],
      });
    }
    if (batch.length === 0) return;
    await this.repository.applyEffects(batch);
    this.logger.debug({ trips: batch.length }, 'Signal-loss notices checked');
  }
}
