import { Counter } from 'prom-client';
import { ConflictError, ValidationError } from '../../shared/errors';
import { metricsRegistry } from '../../shared/metrics';
import { IntugineError, type SimProvider } from './intugine.client';
import { normalizePhone, type SimConsent } from './intugine.contract';
import {
  applyObservation,
  isConsentValid,
  type ConsentRecord,
  type SimConsentView,
} from './sim-consent.record';
import type { SimConsentStore } from './sim-consent.repository';
import type { ConsentUpdate, SimTripRow, SimTripStore } from './sim-trip.repository';

export interface SimConsentOptions {
  /** Minimum gap between consent calls for one number while it is pending (each may re-send the SMS). */
  checkIntervalMs: number;
  /** After this long without approval the row gives up. */
  ttlMs: number;
  /** Failed consent calls before the row gives up. */
  maxAttempts?: number;
  /** How long a given consent stays valid (months; 6, per the operator message). */
  validityMonths?: number;
  /** Minimum gap before the consent SMS can be sent again by hand (resend). */
  resendGapMs?: number;
}

/** A load that wants SIM tracking. */
export interface SimLoad {
  tenantId: string;
  tripId: string;
  vehicleId: string;
  driverId: string | null;
  driverNumber: string | null;
}

/** `ready`: approved, nothing to wait for. `waiting`: driver has to call. `fallback`: consent ended, SIM won't run for this load. */
export type ConsentOutcome = 'ready' | 'waiting' | 'fallback' | 'no_phone';

const DEFAULT_MAX_ATTEMPTS = 5;
export const DEFAULT_CONSENT_VALIDITY_MONTHS = 6;
const DEFAULT_RESEND_GAP_MS = 10 * 60_000;

const consentChecks = new Counter({
  name: 'tracking_sim_consent_checks_total',
  help: 'Intugine consent calls (a pending number is texted again on each), by result',
  labelNames: ['result'] as const,
  registers: [metricsRegistry],
});

/** What the console shows for a load's SIM consent (see SimConsentView). */
export interface SimConsentSummary {
  /** Masked: only the last 4 digits. */
  phone: string | null;
  status: SimConsentView;
  /** The operator's last answer, for ops. */
  operatorStatus: string | null;
  /** When the consent SMS last went out. */
  sentAt: string | null;
  givenAt: string | null;
  /** The consent's validity date (shown with "Valid"). */
  validUntil: string | null;
  withdrawnAt: string | null;
  /** The SMS can be sent again: only while no valid consent is available. */
  canResend: boolean;
  /** Why not, when it can't. */
  resendBlockedReason: string | null;
}

/**
 * Consent for SIM tracking, per driver mobile number (reused across loads). The driver approves by
 * phone after Intugine's SMS; here we only ask and then look.
 *  - A number with a valid consent on file (given, not withdrawn, inside its 6 months) is never
 *    asked again: the load's row starts consented, no call, no SMS.
 *  - Otherwise the first check sends the SMS (Intugine texts a pending number on every call), so a
 *    pending one is re-checked rarely, and not at all while the number was texted recently for
 *    another load. A number that is already ALLOWED is not texted again.
 *  - Denied, unsupported operators, timeouts and repeated failures end the row (no fallback source
 *    is set for now). Sending again by hand (resend) is allowed only without a valid consent.
 */
export class SimConsentService {
  constructor(
    private readonly store: SimTripStore,
    private readonly provider: SimProvider,
    private readonly options: SimConsentOptions,
    private readonly consents: SimConsentStore,
  ) {}

  private get validityMonths() {
    return this.options.validityMonths ?? DEFAULT_CONSENT_VALIDITY_MONTHS;
  }

  /** Starts (or reports on) consent for a load. Safe to call repeatedly: one live row per trip. */
  async request(load: SimLoad, now = new Date()): Promise<ConsentOutcome> {
    const phone = normalizePhone(load.driverNumber);
    if (!phone) return 'no_phone';

    const live = await this.store.findLiveByTrip(load.tripId);
    const reused = !live && isConsentValid(await this.consents.find(phone), now);
    const existing =
      live ??
      (await this.store.insert({ ...load, phone, reusedConsent: reused })) ??
      (await this.store.findLiveByTrip(load.tripId));
    if (!existing) return 'waiting';
    if (reused && existing.consentReused) consentChecks.inc({ result: 'reused' });
    // Already asked: later checks belong to checkDue, which paces them.
    if (existing.consentRequestedAt || existing.state !== 'awaiting_consent') {
      return outcomeOf(existing);
    }
    return this.check(existing, now);
  }

  /** Re-checks pending rows that are due; a row past its TTL gets one last call (a late approval still counts) and then gives up. */
  async checkDue(now = new Date(), limit = 50): Promise<Record<ConsentOutcome, number>> {
    const tally: Record<ConsentOutcome, number> = {
      ready: 0,
      waiting: 0,
      fallback: 0,
      no_phone: 0,
    };
    const due = await this.store.awaitingConsentDue(now, this.options.checkIntervalMs, limit);
    for (const row of due) tally[await this.check(row, now)] += 1;
    return tally;
  }

  /**
   * Re-checks a still-pending consent because its load reached a new stage (see consentStageOf),
   * on top of the hourly re-check. Runs once per stage: the stage is recorded either way. The
   * check re-sends the SMS, so it is skipped (but still recorded) if the number was texted within
   * `resendGapMs`. Past the TTL it is the row's last call: a late approval still counts, otherwise it gives up.
   */
  async checkAtStage(row: SimTripRow, stage: number, now = new Date()): Promise<ConsentOutcome> {
    if (row.state !== 'awaiting_consent' || stage <= row.consentStage) return outcomeOf(row);
    await this.store.setConsentStage(row.id, stage);
    const record = await this.consents.find(row.phone);
    const gap = this.options.resendGapMs ?? DEFAULT_RESEND_GAP_MS;
    if (record?.sentAt && now.getTime() - record.sentAt.getTime() < gap) return 'waiting';
    consentChecks.inc({ result: 'stage_check' });
    return this.check(row, now, true);
  }

  /** The number's consent, as the operator last told us (null: never asked). */
  async recordFor(phone: string): Promise<ConsentRecord | null> {
    return this.consents.find(phone);
  }

  /** Applies an operator answer to the number's consent: given, withdrawn, or text sent. */
  async observe(phone: string, answer: SimConsent, now: Date): Promise<ConsentRecord> {
    const existing = await this.consents.find(phone);
    const updated = applyObservation(existing, answer, now, this.validityMonths);
    updated.phone = phone;
    await this.consents.save(updated);
    return updated;
  }

  private async check(row: SimTripRow, now: Date, force = false): Promise<ConsentOutcome> {
    const record = await this.consents.find(row.phone);
    // Another load of the same driver already got the consent: no call, no SMS.
    if (isConsentValid(record, now)) {
      await this.store.updateConsent(row.id, {
        state: 'consented',
        consentStatus: 'allowed',
        operator: record!.operator,
        checkedAt: now,
        requestedAt: now,
      });
      consentChecks.inc({ result: 'reused' });
      return 'ready';
    }
    // …and a number texted a moment ago for another load is not texted again yet.
    const expired = !!row.consentExpiresAt && row.consentExpiresAt.getTime() <= now.getTime();
    if (
      !force &&
      !expired &&
      record?.sentAt &&
      (record.status === 'pending' || record.status === 'not_registered') &&
      now.getTime() - record.sentAt.getTime() < this.options.checkIntervalMs
    ) {
      await this.store.updateConsent(row.id, {
        state: 'awaiting_consent',
        checkedAt: now,
        requestedAt: now,
        expiresAt: row.consentExpiresAt ? undefined : new Date(now.getTime() + this.options.ttlMs),
      });
      consentChecks.inc({ result: 'recently_sent' });
      return 'waiting';
    }
    // Past the TTL this is the last call: it still accepts a late approval, otherwise the row gives up.
    let consent: SimConsent;
    try {
      consent = await this.provider.checkConsent(row.phone);
    } catch (err) {
      return this.failed(row, now, err, expired);
    }
    consentChecks.inc({ result: consent.status });
    await this.observe(row.phone, consent, now);

    let update = this.updateFor(row, consent, now);
    if (expired && update.state === 'awaiting_consent') {
      update = { ...update, state: 'failed', endReason: 'consent_timeout' };
      consentChecks.inc({ result: 'timeout' });
    }
    await this.store.updateConsent(row.id, update);
    if (update.state === 'consented') return 'ready';
    return update.state === 'awaiting_consent' ? 'waiting' : 'fallback';
  }

  private updateFor(row: SimTripRow, consent: SimConsent, now: Date): ConsentUpdate {
    const base: ConsentUpdate = {
      state: 'awaiting_consent',
      consentStatus: consent.status,
      operator: consent.operator,
      consentSuggestion: consent.suggestion,
      checkedAt: now,
      requestedAt: now,
      // Set once, on the first answer.
      expiresAt: row.consentExpiresAt ? undefined : new Date(now.getTime() + this.options.ttlMs),
    };
    switch (consent.status) {
      case 'allowed':
        return { ...base, state: 'consented' };
      case 'denied':
      case 'unsupported':
        return { ...base, state: 'unsupported', endReason: `consent_${consent.status}` };
      default: // pending, not_registered: the driver still has to act
        return base;
    }
  }

  /**
   * Sends the consent SMS again, by hand — only while no valid consent is available, and not
   * within `resendGapMs` of the last send. A trip whose consent ended (timeout, repeated failures,
   * denied or withdrawn) gets a fresh row; an operator Intugine cannot track is not retried.
   */
  async resend(load: SimLoad, now = new Date()): Promise<ConsentOutcome> {
    const phone = normalizePhone(load.driverNumber);
    if (!phone) throw new ValidationError('The load has no usable driver mobile number');
    const record = await this.consents.find(phone);
    if (isConsentValid(record, now)) {
      throw new ConflictError('A valid consent is already on file for this number', {
        validUntil: record!.validUntil!.toISOString(),
      });
    }
    const gap = this.options.resendGapMs ?? DEFAULT_RESEND_GAP_MS;
    if (record?.sentAt && now.getTime() - record.sentAt.getTime() < gap) {
      throw new ConflictError('The consent link was sent a moment ago; wait before sending again', {
        retryAt: new Date(record.sentAt.getTime() + gap).toISOString(),
      });
    }
    let row = await this.store.findLiveByTrip(load.tripId);
    if (!row) {
      const latest = await this.store.findLatestByTrip(load.tripId);
      if (latest?.endReason === 'consent_unsupported') {
        throw new ConflictError(
          "The driver's operator cannot be tracked by SIM; sending again will not help",
        );
      }
      row =
        (await this.store.insert({ ...load, phone, reusedConsent: false })) ??
        (await this.store.findLiveByTrip(load.tripId));
    }
    if (!row) return 'waiting';
    return this.check(row, now, true);
  }

  /** The consent status of a load, for the console. `trip` is the load's newest SIM row, if any. */
  async summarize(
    driverNumber: string | null,
    trip: SimTripRow | null,
    now = new Date(),
  ): Promise<SimConsentSummary> {
    const phone = normalizePhone(driverNumber);
    const empty = {
      phone: null,
      operatorStatus: null,
      sentAt: null,
      givenAt: null,
      validUntil: null,
      withdrawnAt: null,
      canResend: false,
    };
    if (!phone) {
      return {
        ...empty,
        status: 'no_number',
        resendBlockedReason: 'The load has no usable driver mobile number',
      };
    }
    const record = await this.consents.find(phone);
    const iso = (date: Date | null | undefined) => date?.toISOString() ?? null;
    const base = {
      phone: `XXXXXX${phone.slice(-4)}`,
      operatorStatus: record?.status ?? trip?.consentStatus ?? null,
      sentAt: iso(record?.sentAt),
      givenAt: iso(record?.givenAt),
      validUntil: iso(record?.validUntil),
      withdrawnAt: iso(record?.withdrawnAt),
    };
    if (isConsentValid(record, now)) {
      return {
        ...base,
        // A consent already on file when the load asked is "Valid"; one the driver gave in answer
        // to this load's SMS is "Given".
        status: trip && !trip.consentReused ? 'given' : 'valid',
        canResend: false,
        resendBlockedReason: 'A valid consent is already on file',
      };
    }
    const waiting = trip?.state === 'awaiting_consent' || (!trip && record?.status === 'pending');
    if (waiting) {
      return { ...base, status: 'link_sent', canResend: true, resendBlockedReason: null };
    }
    const unsupported =
      trip?.endReason === 'consent_unsupported' || record?.status === 'unsupported';
    return {
      ...base,
      status: 'unavailable',
      canResend: !unsupported,
      resendBlockedReason: unsupported ? "The driver's operator cannot be tracked by SIM" : null,
    };
  }

  private async failed(
    row: SimTripRow,
    now: Date,
    err: unknown,
    expired = false,
  ): Promise<ConsentOutcome> {
    const message = err instanceof Error ? err.message : String(err);
    const giveUp =
      expired || row.attempts + 1 >= (this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const rateLimited = err instanceof IntugineError && err.rateLimited;
    consentChecks.inc({ result: rateLimited ? 'rate_limited' : 'error' });
    await this.store.updateConsent(row.id, {
      state: giveUp ? 'failed' : 'awaiting_consent',
      checkedAt: now,
      endReason: giveUp ? (expired ? 'consent_timeout' : 'consent_error') : undefined,
      error: message.slice(0, 500),
    });
    return giveUp ? 'fallback' : 'waiting';
  }
}

function outcomeOf(row: SimTripRow): ConsentOutcome {
  if (row.state === 'awaiting_consent') return 'waiting';
  return row.state === 'unsupported' || row.state === 'failed' || row.state === 'ended'
    ? 'fallback'
    : 'ready';
}
