import type { Logger } from 'pino';
import { Counter } from 'prom-client';
import { metricsRegistry } from '../../shared/metrics';
import type { TenantScope } from '../../shared/auth/staff-token';
import type { MainLoad } from '../main-data';
import type { LoadStatus } from '../trips/trip-state';
import { INDEXED_STATUSES } from '../trips/trip-state';
import type { FastagTripRow, FastagTripStore } from './fastag-trip.repository';

/** The slice of MainDataRepository the lifecycle reads. */
export interface FastagMainData {
  loadsByStatus(
    scope: TenantScope | null,
    statuses: readonly LoadStatus[],
    limit: number,
  ): Promise<MainLoad[]>;
  load(scope: TenantScope | null, id: string): Promise<MainLoad | null>;
}

export interface FastagLifecycleResult {
  started: number;
  closed: number;
  skipped: number;
}

const transitions = new Counter({
  name: 'tracking_fastag_lifecycle_total',
  help: 'FASTag trip lifecycle actions, by action',
  labelNames: ['action'] as const,
  registers: [metricsRegistry],
});

/**
 * Decides which loads have their FASTag crossings collected, ticked by the scheduler leader.
 * Unlike SIM this is not a tracking source: every load in a tracked status that has a truck
 * number is followed, whatever its `tracking_source`.
 *  - a row opens when the truck is on the load (`truck_assigned` on); its window starts at the
 *    assignment time, so tolls crossed before this service noticed are still collected (ULIP keeps ~72 h);
 *  - it closes when the load leaves the tracked statuses (delivered / closed) or its truck is
 *    replaced; the window then ends at the delivery time, and one last poll follows (see
 *    FastagTripStore.due) so tolls ULIP posted late are not lost.
 */
export class FastagLifecycleService {
  constructor(
    private readonly mainData: FastagMainData,
    private readonly store: FastagTripStore,
    private readonly logger: Logger,
  ) {}

  async run(now = new Date()): Promise<FastagLifecycleResult> {
    const result: FastagLifecycleResult = { started: 0, closed: 0, skipped: 0 };
    const loads = (await this.mainData.loadsByStatus(null, INDEXED_STATUSES, 50_000)).filter(
      (load) => load.vehicleId && load.vehicleNumber,
    );
    const live = new Map(
      (await this.store.liveRows()).filter((r) => r.state === 'active').map((r) => [r.loadId, r]),
    );
    const trackedIds = new Set(loads.map((load) => load.id));

    for (const load of loads) {
      try {
        await this.tickLoad(load, live.get(load.id) ?? null, now, result);
      } catch (err) {
        result.skipped += 1;
        this.logger.warn({ err, tripId: load.id }, 'FASTag lifecycle failed for a trip');
      }
    }
    // Active rows whose load is no longer a tracked load with a truck: close them.
    for (const row of live.values()) {
      if (trackedIds.has(row.loadId)) continue;
      try {
        await this.closeGone(row, now);
        result.closed += 1;
      } catch (err) {
        result.skipped += 1;
        this.logger.warn({ err, tripId: row.loadId }, 'Closing a FASTag trip failed; will retry');
      }
    }
    return result;
  }

  private async tickLoad(
    load: MainLoad,
    row: FastagTripRow | null,
    now: Date,
    result: FastagLifecycleResult,
  ) {
    let windowStart = load.startedAt ?? now;
    if (row && row.vehicleNumber !== load.vehicleNumber) {
      // The truck on the load was replaced: the old truck's window ends now, the new one starts now.
      await this.store.markClosing(row.id, now, 'vehicle_changed');
      transitions.inc({ action: 'vehicle_changed' });
      result.closed += 1;
      row = null;
      windowStart = now;
    }
    if (row) return;
    const created = await this.store.insert({
      tenantId: load.tenantId,
      loadId: load.id,
      vehicleId: load.vehicleId!,
      vehicleNumber: load.vehicleNumber!,
      windowStart,
    });
    if (created) {
      transitions.inc({ action: 'started' });
      result.started += 1;
    }
  }

  private async closeGone(row: FastagTripRow, now: Date) {
    const load = await this.mainData.load(null, row.loadId);
    // The list above is capped: a load that is still tracked with the same truck is left alone.
    if (
      load &&
      INDEXED_STATUSES.includes(load.status) &&
      load.vehicleNumber === row.vehicleNumber
    ) {
      return;
    }
    const windowEnd = load?.endedAt && load.endedAt < now ? load.endedAt : now;
    const reason = !load ? 'load_missing' : 'load_ended';
    await this.store.markClosing(row.id, windowEnd, reason);
    transitions.inc({ action: reason });
  }
}
