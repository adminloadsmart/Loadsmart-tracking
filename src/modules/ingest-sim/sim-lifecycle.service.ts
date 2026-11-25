import type { Logger } from 'pino';
import { Counter } from 'prom-client';
import { metricsRegistry } from '../../shared/metrics';
import type { TenantScope } from '../../shared/auth/staff-token';
import type { MainLoad, MainPlace, MainTripPoints } from '../main-data';
import type { LoadStatus } from '../trips/trip-state';
import { ACTIVE_STATUSES, INDEXED_STATUSES, consentStageOf } from '../trips/trip-state';
import type { SimProvider, StartTripInput } from './intugine.client';
import { normalizePhone } from './intugine.contract';
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
  /** A load, else a trip created from the tracking screen (in the load shape). */
  trip(scope: TenantScope | null, id: string): Promise<MainLoad | null>;
  /** Active trips created from the tracking screen, in the load shape. */
  activeCreatedTrips(limit: number): Promise<MainLoad[]>;
  tripPoints(loadIds: string[]): Promise<Map<string, MainTripPoints>>;
  places(loadingPointIds: string[], deliveryPointIds: string[]): Promise<Map<string, MainPlace>>;
  /** A created trip's places as typed, with the ends of its planned road route — for a place
   *  typed as an address (no master, so no coordinates of its own). */
  createdTripEnds(tripId: string): Promise<CreatedTripEnds | null>;
}

export interface CreatedTripEnds {
  start: [number, number] | null;
  end: [number, number] | null;
  startName: string;
  endName: string;
  endAddress: string;
}

/**
 * The invoice a trip's Intugine trip is started (and found again) with. A load's code is unique;
 * a created trip's TRP-#### is only unique within its tenant, so its id is added.
 */
export function simInvoiceOf(load: Pick<MainLoad, 'code' | 'id' | 'createdTrip'>): string {
  return load.createdTrip ? `${load.code}-${load.id.slice(0, 8)}` : load.code;
}

export interface SimLifecycleOptions {
  /** Start attempts before the row gives up (the trip is then not tracked by SIM). */
  maxStartAttempts?: number;
  /** A delivered load stays on SIM until its POD is accepted, but no longer than this after the
   *  delivery (Intugine bills by trip length; 0 = no limit). */
  maxAfterDeliveryMs?: number;
}

/** Delivered, with the POD still to be accepted: SIM keeps tracking until it is. */
const AWAITING_POD_STATUSES: readonly LoadStatus[] = ['delivered_ok', 'delivered_with_issues'];
const DEFAULT_MAX_AFTER_DELIVERY_MS = 72 * 60 * 60_000;

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
 *  - the billed Intugine trip starts once consent is allowed and the load is in a tracked status (from truck assignment);
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

    // A load whose POD is accepted is done (tracking stops there), whatever stage it is in.
    // Trips created from the tracking screen on SIM are asked and started the same way.
    const [indexedLoads, createdTrips] = await Promise.all([
      this.mainData.loadsByStatus(null, INDEXED_STATUSES, 50_000),
      this.mainData.activeCreatedTrips(50_000),
    ]);
    const loads = [...indexedLoads, ...createdTrips].filter(
      (load) => load.vehicleId && load.trackingSource === 'sim' && load.podStatus !== 'accepted',
    );
    // Delivered loads keep their running SIM trip until the POD is accepted (never started anew).
    const awaitingPod = (await this.mainData.loadsByStatus(null, AWAITING_POD_STATUSES, 50_000))
      .filter((load) => this.keepsAfterDelivery(load, now))
      .map((load) => load.id);
    const live = new Map((await this.store.liveRows()).map((row) => [row.tripId, row]));
    const finished = await this.store.loadsWithFinishedConsent(
      loads.map((load) => ({ id: load.id, phone: normalizePhone(load.driverNumber) })),
    );
    const simIds = new Set([...loads.map((load) => load.id), ...awaitingPod]);

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
    // The truck was cancelled and another assigned (or the driver changed) between two ticks: the
    // row still holds the old driver's number and vehicle. End it (and its billed Intugine trip)
    // so the new driver is asked for consent and the old phone is no longer polled.
    if (
      row &&
      (row.vehicleId !== load.vehicleId || row.phone !== normalizePhone(load.driverNumber))
    ) {
      await this.endTrip(row, load, now, 'truck_changed');
      result.ended += 1;
      row = null;
    }
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
    // A still-pending consent is checked again when the load reaches in_transit_loading,
    // reached_loading and in_transit_unloading (once each; the hourly re-check carries on too).
    if (row?.state === 'awaiting_consent') {
      await this.consent.checkAtStage(row, consentStageOf(load.status), now);
      row = await this.store.findLiveByTrip(load.id);
    }
    // Tracked statuses start at truck assignment, so the trip starts as soon as consent is allowed.
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
      const existing = await this.provider.findTripByInvoice(simInvoiceOf(load));
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
        // A consent we had as valid that the operator no longer allows was withdrawn.
        await this.consent.observe(row.phone, started.consent, now);
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
    // An inbound created trip can start at a customer address.
    const pickupId = points.pickupLoadingPointId ?? points.pickupCustomerDeliveryPointId ?? null;
    const places = await this.mainData.places(
      [points.pickupLoadingPointId, points.dropLoadingPointId].filter((id): id is string => !!id),
      [points.pickupCustomerDeliveryPointId, points.dropCustomerDeliveryPointId].filter(
        (id): id is string => !!id,
      ),
    );
    type End = { coords: [number, number]; place: MainPlace | null };
    const at = (id: string | null): End | null => {
      const place = id ? places.get(id) : undefined;
      return place && place.lat != null && place.lng != null
        ? { coords: [place.lat, place.lng] as [number, number], place }
        : null;
    };
    let src = at(pickupId);
    let dest = at(dropId ?? null);
    // A created trip's place typed as an address has no master: take its end of the planned route.
    const typed = load.createdTrip && (!src || !dest)
      ? await this.mainData.createdTripEnds(load.id)
      : null;
    if (typed) {
      src ??= typed.start ? { coords: typed.start, place: null } : null;
      dest ??= typed.end ? { coords: typed.end, place: null } : null;
    }
    if (!src || !dest) return null;
    return {
      tel: row.phone,
      src: src.coords,
      srcName: src.place?.name ?? typed?.startName ?? 'Source',
      dest: dest.coords,
      destName: dest.place?.name ?? typed?.endName ?? 'Destination',
      destAddress: dest.place?.address ?? typed?.endAddress ?? undefined,
      truckNumber: load.vehicleNumber ?? points.vehicleNumber ?? '',
      invoice: simInvoiceOf(load),
      loadId: load.id,
    };
  }

  /** The load left the tracked statuses, or is no longer on SIM: close the row and the Intugine trip. */
  private async endIfNoLongerSim(row: SimTripRow, now: Date): Promise<boolean> {
    const load = await this.mainData.trip(null, row.tripId);
    const tracked = load !== null && INDEXED_STATUSES.includes(load.status);
    if (load?.podStatus === 'accepted') {
      await this.endTrip(row, load, now, 'pod_accepted');
      return true;
    }
    // The lists are capped; a load that is still a tracked SIM load (or a delivered one waiting
    // for its POD) is left alone.
    if (load?.trackingSource === 'sim' && (tracked || this.keepsAfterDelivery(load, now))) {
      return false;
    }
    const waitedTooLong =
      load !== null && load.trackingSource === 'sim' && AWAITING_POD_STATUSES.includes(load.status);
    await this.endTrip(
      row,
      load,
      now,
      tracked ? 'source_changed' : waitedTooLong ? 'delivery_timeout' : 'load_ended',
    );
    return true;
  }

  /** Delivered, on SIM, POD not accepted yet, and not past the time limit after the delivery. */
  private keepsAfterDelivery(load: MainLoad, now: Date): boolean {
    if (
      load.trackingSource !== 'sim' ||
      !load.vehicleId ||
      !AWAITING_POD_STATUSES.includes(load.status) ||
      load.podStatus === 'accepted'
    ) {
      return false;
    }
    const limit = this.options.maxAfterDeliveryMs ?? DEFAULT_MAX_AFTER_DELIVERY_MS;
    return limit === 0 || !load.deliveredAt || now.getTime() - load.deliveredAt.getTime() < limit;
  }

  private async endTrip(row: SimTripRow, load: MainLoad | null, now: Date, reason: string) {
    let intugineTripId = row.intugineTripId;
    // A start whose answer was lost may still be running (and billed) on Intugine.
    if (!intugineTripId && row.startAttempted && load) {
      intugineTripId = await this.provider.findTripByInvoice(simInvoiceOf(load));
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
