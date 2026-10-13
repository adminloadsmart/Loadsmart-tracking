import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { MainDataRepository, MainLoad } from '../main-data';
import { ActiveTripIndex } from './active-trip-index';
import { trackingStateFor } from './trip-state';

const CURSOR_KEY = 'trk:trips:cursor';
const PAGE_SIZE = 1000;
// Re-read loads changed slightly before the cursor: a transaction can commit after rows with a
// later updated_at were already seen. Re-applying a load is idempotent.
const OVERLAP_MS = 30_000;

/**
 * Keeps the Redis active-trip index (what ingest and the rules read on every point) in step with
 * the main backend's loads table — read directly, since the tracking service shares the main
 * database. A load is a trip; it's tracked from loading confirmation until delivery/close.
 * Polls loads changed since the cursor (scheduler leader, every few seconds); a full rebuild runs
 * on every leadership takeover and periodically as a safety net for writes that don't touch
 * updated_at.
 */
export class TripWatcher {
  constructor(
    private readonly mainData: MainDataRepository,
    private readonly index: ActiveTripIndex,
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly pageSize = PAGE_SIZE,
  ) {}

  /** Applies every load changed since the cursor, page by page, then advances the cursor. */
  async poll(): Promise<number> {
    const cursor = Number((await this.redis.get(CURSOR_KEY)) ?? 0);
    const since = new Date(Math.max(0, cursor - OVERLAP_MS));
    let after: MainLoad | undefined;
    let applied = 0;
    for (;;) {
      const loads = await this.mainData.loadsChangedSince(since, this.pageSize, after);
      for (const load of loads) await this.apply(load);
      applied += loads.length;
      after = loads.at(-1) ?? after;
      if (loads.length < this.pageSize) break;
    }
    const newest = after?.updatedAt.getTime();
    if (newest && newest > cursor) await this.redis.set(CURSOR_KEY, String(newest));
    return applied;
  }

  /** Restores the index from the loads table (on takeover / periodically). */
  async rebuild(): Promise<{ set: number; removed: number }> {
    const active = await this.mainData.activeLoads();
    const result = await this.index.rebuild(active.map(refs));
    this.logger.info(result, 'Active-trip index rebuilt from loads');
    return result;
  }

  private async apply(load: MainLoad): Promise<void> {
    const next = refs(load);
    const previous = await this.index.getRef(load.id);
    // Reassigned mid-trip: release the previous vehicle/driver first.
    if (
      previous &&
      (previous.vehicleId !== next.vehicleId || previous.driverId !== next.driverId)
    ) {
      await this.index.deactivate({ ...next, ...previous }, { endTrip: false });
    }
    if (trackingStateFor(load.status, false) === 'active') {
      await this.index.activate(next);
    } else if (previous) {
      await this.index.deactivate({ ...next, ...previous });
    }
  }
}

function refs(load: MainLoad) {
  return {
    tripId: load.id,
    tenantId: load.tenantId,
    vehicleId: load.vehicleId,
    driverId: load.driverId,
    startedAt: load.startedAt,
    loadStatus: load.status,
  };
}
