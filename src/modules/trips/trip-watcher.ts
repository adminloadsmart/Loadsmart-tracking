import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { MainDataRepository, MainLoad } from '../main-data';
import { SerialQueue } from '../../shared/utils/concurrency';
import { ActiveTripIndex, IndexedRef } from './active-trip-index';
import { isAfterDelivery, isIndexed } from './trip-state';

const CURSOR_KEY = 'trk:trips:cursor';
/** Trips created from the tracking screen (tracking.trips) are paged on their own updated_at. */
const CREATED_CURSOR_KEY = 'trk:trips:created-cursor';
const PAGE_SIZE = 1000;
// Re-read loads changed slightly before the cursor: a transaction can commit after rows with a
// later updated_at were already seen. Re-applying a load is idempotent.
const OVERLAP_MS = 30_000;

/**
 * Keeps the Redis active-trip index (what ingest and the rules read on every point) in step with
 * the main backend's loads table — read directly, since the tracking service shares the main
 * database. A load is a trip; it's tracked from loading confirmation until delivery/close, and
 * indexed from assignment so the drive to the plant can be matched to it, and after delivery until
 * the truck leaves the delivery point (isIndexed).
 * Trips created from the tracking screen (tracking.trips) are indexed the same way while active.
 * Polls loads changed since the cursor (scheduler leader, every few seconds); a full rebuild runs
 * on every leadership takeover and periodically as a safety net for writes that don't touch
 * updated_at.
 */
export class TripWatcher {
  /** poll and rebuild never overlap: a rebuild works from a snapshot of the loads and deletes
   *  every index key not in it, so a poll landing in between would be undone. */
  private readonly serial = new SerialQueue();
  /** What each load was last applied as (`updatedAt|indexed`), kept for the overlap window: the
   *  overlap re-reads the same unchanged loads on every poll, ~6 times each. */
  private readonly applied = new Map<string, { as: string; atMs: number }>();

  constructor(
    private readonly mainData: MainDataRepository,
    private readonly index: ActiveTripIndex,
    private readonly redis: Redis,
    private readonly logger: Logger,
    private readonly pageSize = PAGE_SIZE,
  ) {}

  /** Applies every load, and every trip created from the tracking screen, changed since its
   *  cursor, page by page, then advances that cursor. */
  async poll(): Promise<number> {
    return this.serial.run(() => this.pollAll());
  }

  private async pollAll(): Promise<number> {
    this.forgetApplied(Date.now());
    const loads = await this.pollFeed(CURSOR_KEY, (since, after) =>
      this.mainData.loadsChangedSince(since, this.pageSize, after),
    );
    const created = await this.pollFeed(CREATED_CURSOR_KEY, (since, after) =>
      this.mainData.createdTripsChangedSince(since, this.pageSize, after),
    );
    return loads + created;
  }

  private async pollFeed(
    cursorKey: string,
    page: (since: Date, after: MainLoad | undefined) => Promise<MainLoad[]>,
  ): Promise<number> {
    const cursor = Number((await this.redis.get(cursorKey)) ?? 0);
    const since = new Date(Math.max(0, cursor - OVERLAP_MS));
    let after: MainLoad | undefined;
    let applied = 0;
    for (;;) {
      const loads = await page(since, after);
      await this.applyPage(loads);
      applied += loads.length;
      after = loads.at(-1) ?? after;
      if (loads.length < this.pageSize) break;
    }
    const newest = after?.updatedAt.getTime();
    if (newest && newest > cursor) await this.redis.set(cursorKey, String(newest));
    return applied;
  }

  /** Restores the index from the loads table and the active created trips (on takeover /
   *  periodically). */
  async rebuild(): Promise<{ set: number; removed: number }> {
    return this.serial.run(() => this.rebuildAll());
  }

  private async rebuildAll(): Promise<{ set: number; removed: number }> {
    // The index is rewritten whole: every load must be re-applied by the next polls.
    this.applied.clear();
    const [loads, created] = await Promise.all([
      this.mainData.indexedLoads(),
      this.mainData.activeCreatedTrips(),
    ]);
    const indexed = [...loads, ...created];
    // Delivered loads first: a vehicle / driver already on its next trip keeps that one.
    const ordered = [
      ...indexed.filter((load) => isAfterDelivery(load.status)),
      ...indexed.filter((load) => !isAfterDelivery(load.status)),
    ];
    const result = await this.index.rebuild(ordered.map(refs));
    this.logger.info(result, 'Active-trip index rebuilt from loads and created trips');
    return result;
  }

  /** One page: refs read in one round trip, every write in one pipeline (in load order, so two
   *  loads of the same truck in a page still resolve as one after the other would). */
  private async applyPage(loads: MainLoad[]): Promise<void> {
    const nowMs = Date.now();
    const due = loads.flatMap((load) => {
      const indexed = isIndexed(load, nowMs);
      // isIndexed depends on the clock too, so the outcome is part of what was applied.
      const as = `${load.updatedAt.getTime()}|${indexed}`;
      return this.applied.get(load.id)?.as === as ? [] : [{ load, indexed, as }];
    });
    if (due.length === 0) return;
    const previous = await this.index.getRefs(due.map(({ load }) => load.id));
    const batch = this.index.batch();
    for (const { load, indexed } of due) apply(batch, load, indexed, previous.get(load.id));
    await batch.exec();
    for (const { load, as } of due) this.applied.set(load.id, { as, atMs: nowMs });
  }

  private forgetApplied(nowMs: number): void {
    // Kept a little past the overlap, so a load re-read in the overlap is always still here.
    for (const [id, { atMs }] of this.applied) {
      if (nowMs - atMs > 2 * OVERLAP_MS) this.applied.delete(id);
    }
  }
}

function apply(
  batch: ReturnType<ActiveTripIndex['batch']>,
  load: MainLoad,
  indexed: boolean,
  previous: IndexedRef | undefined,
): void {
  const next = refs(load);
  // Reassigned mid-trip, or its vehicle's GPS device changed: release the previous ones first.
  if (
    previous &&
    (previous.vehicleId !== next.vehicleId ||
      previous.driverId !== next.driverId ||
      previous.deviceImei !== next.deviceImei)
  ) {
    batch.deactivate({ ...next, ...previous }, { endTrip: false });
  }
  if (indexed) {
    batch.activate(next, { ifFree: isAfterDelivery(load.status) });
  } else if (previous) {
    batch.deactivate({ ...next, ...previous });
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
    trackingSource: load.trackingSource,
    deviceImei: load.deviceImei,
    postingType: load.postingType,
  };
}
