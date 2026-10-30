import type { Logger } from 'pino';
import { Counter } from 'prom-client';
import { metricsRegistry } from '../../shared/metrics';
import type { TenantScope } from '../../shared/auth/staff-token';
import type { MainLoad, MainPlace, MainTripPoints } from '../main-data';
import type { LoadStatus } from '../trips/trip-state';
import { ACTIVE_STATUSES, INDEXED_STATUSES } from '../trips/trip-state';
import type { SimProvider, StartTripInput } from './intugine.client';
import type { SimConsentService } from './sim-consent.service';
import type { SimCursorStore } from './sim-poll.job';
import type { SimTripRow, SimTripStore } from './sim-trip.repository';

/** The slice of MainDataRepository the lifecycle reads. */
export interface SimMainData {
  loadsByStatus(
    scope: TenantScope | null,
    statuses: readonly LoadStatus[],
    limit: number,
  ): Promise<MainLoad[]>;
  load(scope: TenantScope | null, id: string): Promise<MainLoad | null>;
  tripPoints(loadIds: string[]): Promise<Map<string, MainTripPoints>>;
  places(loadingPointIds: string[], deliveryPointIds: string[]): Promise<Map<string, MainPlace>>;
}

export interface SimLifecycleOptions {
  /** Start attempts before the row gives up (the trip is then not tracked by SIM). */
  maxStartAttempts?: number;
}

export interface LifecycleResult {
  consentRequested: number;
  started: number;
  ended: number;
  skipped: number;
}

const DEFAULT_MAX_START_ATTEMPTS = 5;

const transitions = new Counter({
  name: 'tracking_sim_lifecycle_total',
  help: 'SIM trip lifecycle actions, by action',
  labelNames: ['action'] as const,
  registers: [metricsRegistry],
});

/**
 * Runs the SIM life of each trip, ticked by the scheduler leader. SIM is its own source, not a
 * fallback: only loads whose `loads.tracking_source` is `sim` (chosen by the main backend when the
 * truck has neither GPS nor a driver app) are looked at, and this service never writes that column.
 *  - consent is asked once the load is `sim` (it costs nothing and a driver can take hours to approve);
 *  - the billed Intugine trip starts once consent is allowed and loading is confirmed;
 *  - it ends when the load leaves the tracked statuses or its source is no longer `sim` (Intugine
 *    bills by trip length, so stopping to poll is not enough).
 * If consent is denied, unsupported or times out, the row just ends: nothing falls back for now.
 */
export class SimLifecycleService {
  constructor(
    private readonly mainData: SimMainData,
    private readonly store: SimTripStore,
    private readonly provider: SimProvider,
    private readonly consent: SimConsentService,
    private readonly cursors: Pick<SimCursorStore, 'delete'>,
    private readonly logger: Logger,
    private readonly options: SimLifecycleOptions = {},
  ) {}

  async run(now = new Date()): Promise<LifecycleResult> {
    const result: LifecycleResult = { consentRequested: 0, started: 0, ended: 0, skipped: 0 };
    await this.consent.checkDue(now);

    const loads = (await this.mainData.loadsByStatus(null, INDEXED_STATUSES, 50_000)).filter(
      (load) => load.vehicleId && load.trackingSource === 'sim',
    );
    const live = new Map((await this.store.liveRows()).map((row) => [row.tripId, row]));
    const finished = await this.store.loadsWithFinishedConsent(loads.map((load) => load.id));
    const simIds = new Set(loads.map((load) => load.id));

    for (const load of loads) {
      try {
        await this.tickLoad(load, live.get(load.id) ?? null, finished.has(load.id), now, result);
      } catch (err) {
        result.skipped += 1;
        this.logger.warn({ err, tripId: load.id }, 'SIM lifecycle failed for a trip');
      }
    }
    // Rows whose load is no longer a tracked SIM load: end them (and their Intugine trip).
    for (const row of live.values()) {
      if (simIds.has(row.tripId)) continue;
      try {
        if (await this.endIfNoLongerSim(row, now)) result.ended += 1;
      } catch (err) {
        result.skipped += 1;
        this.logger.warn({ err, tripId: row.tripId }, 'Ending a SIM trip failed; will retry');
      }
    }
    return result;
  }

  private async tickLoad(
    load: MainLoad,
    row: SimTripRow | null,
    consentFinished: boolean,
    now: Date,
    result: LifecycleResult,
  ) {
    // Consent first. A number that already ended as denied / unsupported / failed is never asked
    // again (each ask texts a pending driver).
    if (!row && !consentFinished) {
      const outcome = await this.consent.request(
        {
          tenantId: load.tenantId,
          tripId: load.id,
          vehicleId: load.vehicleId!,
          driverId: load.driverId,
          driverNumber: load.driverNumber,
        },
        now,
      );
      if (outcome !== 'no_phone') result.consentRequested += 1;
      row = await this.store.findLiveByTrip(load.id);
    }
    // Before loading is confirmed there is nothing to track yet (and nothing to bill).
    if (!ACTIVE_STATUSES.includes(load.status) || !load.startedAt) return;
    if (row?.state === 'consented') await this.startTrip(row, load, now, result);
  }

  private async startTrip(row: SimTripRow, load: MainLoad, now: Date, result: LifecycleResult) {
    // Intugine may replace an older trip on the same number: never start while one is running.
    const busy = await this.store.activeByPhone(row.phone, row.tripId);
    if (busy) {
      await this.store.recordError(row.id, `phone in use by trip ${busy.tripId}`);
      result.skipped += 1;
      return;
    }
    if (row.attempts >= (this.options.maxStartAttempts ?? DEFAULT_MAX_START_ATTEMPTS)) {
      await this.store.markEnded(row, {
        state: 'failed',
        reason: 'start_failed',
        now,
      });
      transitions.inc({ action: 'start_gave_up' });
      return;
    }

    // A previous start call may have reached Intugine without us seeing the answer.
    if (row.startAttempted) {
      const existing = await this.provider.findTripByInvoice(load.code);
      if (existing) {
        await this.store.markStarted(row, existing, now);
        transitions.inc({ action: 'start_adopted' });
        result.started += 1;
        return;
      }
    }

    const input = await this.startInput(row, load);
    if (!input) {
      await this.store.recordError(row.id, 'source or destination coordinates missing');
      result.skipped += 1;
      return;
    }
    await this.store.markStarting(row.id, input);
    try {
      const started = await this.provider.startTrip(input);
      if (started.consent && started.consent.status !== 'allowed') {
        // Intugine does not consider the number approved: don't leave a billed trip open.
        await this.provider.endTrip(started.intugineTripId).catch(() => undefined);
        await this.store.markEnded(row, {
          state: 'unsupported',
          reason: `consent_${started.consent.status}`,
          now,
        });
        return;
      }
      await this.store.markStarted(row, started.intugineTripId, now);
      transitions.inc({ action: 'started' });
      result.started += 1;
    } catch (err) {
      await this.store.recordError(row.id, err instanceof Error ? err.message : String(err));
      transitions.inc({ action: 'start_error' });
      result.skipped += 1;
    }
  }

  private async startInput(row: SimTripRow, load: MainLoad): Promise<StartTripInput | null> {
    const points = (await this.mainData.tripPoints([load.id])).get(load.id);
    if (!points) return null;
    const dropId = points.dropCustomerDeliveryPointId ?? points.dropLoadingPointId;
    const pickupId = points.pickupLoadingPointId;
    if (!pickupId || !dropId) return null;
    const places = await this.mainData.places(
      [pickupId, points.dropLoadingPointId].filter((id): id is string => !!id),
      points.dropCustomerDeliveryPointId ? [points.dropCustomerDeliveryPointId] : [],
    );
    const src = places.get(pickupId);
    const dest = places.get(dropId);
    if (
      !src ||
      !dest ||
      src.lat == null ||
      src.lng == null ||
      dest.lat == null ||
      dest.lng == null
    ) {
      return null;
    }
    return {
      tel: row.phone,
      src: [src.lat, src.lng],
      srcName: src.name,
      dest: [dest.lat, dest.lng],
      destName: dest.name,
      destAddress: dest.address ?? undefined,
      truckNumber: load.vehicleNumber ?? points.vehicleNumber ?? '',
      invoice: load.code,
      loadId: load.id,
    };
  }

  /** The load left the tracked statuses, or is no longer on SIM: close the row and the Intugine trip. */
  private async endIfNoLongerSim(row: SimTripRow, now: Date): Promise<boolean> {
    const load = await this.mainData.load(null, row.tripId);
    const tracked = load !== null && INDEXED_STATUSES.includes(load.status);
    // The list is capped; a load that is still a tracked SIM load is left alone.
    if (tracked && load.trackingSource === 'sim') return false;
    await this.endTrip(row, load, now, tracked ? 'source_changed' : 'load_ended');
    return true;
  }

  private async endTrip(row: SimTripRow, load: MainLoad | null, now: Date, reason: string) {
    let intugineTripId = row.intugineTripId;
    // A start whose answer was lost may still be running (and billed) on Intugine.
    if (!intugineTripId && row.startAttempted && load) {
      intugineTripId = await this.provider.findTripByInvoice(load.code);
    }
    if (intugineTripId) {
      // False = "No trip exists" / "already ended": either way it is not running.
      await this.provider.endTrip(intugineTripId);
    }
    await this.store.markEnded(row, { state: 'ended', reason, now });
    transitions.inc({ action: reason });
    if (intugineTripId) {
      // Best effort: the row is already closed, so a Redis hiccup must not fail (and so never retry) this.
      await this.cursors
        .delete(intugineTripId)
        .catch((err) => this.logger.warn({ err, tripId: row.tripId }, 'SIM cursor cleanup failed'));
    }
  }
}
