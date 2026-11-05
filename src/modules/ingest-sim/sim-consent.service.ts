import { Counter } from 'prom-client';
import { metricsRegistry } from '../../shared/metrics';
import { IntugineError, type SimProvider } from './intugine.client';
import { normalizePhone, type SimConsent } from './intugine.contract';
import type { ConsentUpdate, SimTripRow, SimTripStore } from './sim-trip.repository';

export interface SimConsentOptions {
  /** Minimum gap between consent calls for one number while it is pending (each may re-send the SMS). */
  checkIntervalMs: number;
  /** After this long without approval the row gives up. */
  ttlMs: number;
  /** Failed consent calls before the row gives up. */
  maxAttempts?: number;
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

const consentChecks = new Counter({
  name: 'tracking_sim_consent_checks_total',
  help: 'Intugine consent calls (a pending number is texted again on each), by result',
  labelNames: ['result'] as const,
  registers: [metricsRegistry],
});

/**
 * Consent for SIM tracking, per trip. The driver approves by phone after Intugine's SMS; here we
 * only ask and then look. A number that is already ALLOWED is not texted again, so it is checked
 * first; a pending one is re-checked rarely because every call re-sends the SMS. Denied, unsupported
 * operators, timeouts and repeated failures all end the row (no fallback source is set for now).
 */
export class SimConsentService {
  constructor(
    private readonly store: SimTripStore,
    private readonly provider: SimProvider,
    private readonly options: SimConsentOptions,
  ) {}

  /** Starts (or reports on) consent for a load. Safe to call repeatedly: one live row per trip. */
  async request(load: SimLoad, now = new Date()): Promise<ConsentOutcome> {
    const phone = normalizePhone(load.driverNumber);
    if (!phone) return 'no_phone';

    const existing =
      (await this.store.findLiveByTrip(load.tripId)) ??
      (await this.store.insert({ ...load, phone })) ??
      (await this.store.findLiveByTrip(load.tripId));
    if (!existing) return 'waiting';
    // Already asked: later checks belong to checkDue, which paces them.
    if (existing.consentRequestedAt || existing.state !== 'awaiting_consent') {
      return outcomeOf(existing);
    }
    return this.check(existing, now);
  }

  /** Re-checks pending rows that are due; expires the ones past their TTL without calling. */
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

  private async check(row: SimTripRow, now: Date): Promise<ConsentOutcome> {
    // Past the TTL: give up before calling, so no further SMS goes out.
    if (row.consentExpiresAt && row.consentExpiresAt.getTime() <= now.getTime()) {
      await this.store.updateConsent(row.id, {
        state: 'failed',
        checkedAt: now,
        endReason: 'consent_timeout',
      });
      consentChecks.inc({ result: 'timeout' });
      return 'fallback';
    }

    let consent: SimConsent;
    try {
      consent = await this.provider.checkConsent(row.phone);
    } catch (err) {
      return this.failed(row, now, err);
    }
    consentChecks.inc({ result: consent.status });

    const update = this.updateFor(row, consent, now);
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

  private async failed(row: SimTripRow, now: Date, err: unknown): Promise<ConsentOutcome> {
    const message = err instanceof Error ? err.message : String(err);
    const giveUp = row.attempts + 1 >= (this.options.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const rateLimited = err instanceof IntugineError && err.rateLimited;
    consentChecks.inc({ result: rateLimited ? 'rate_limited' : 'error' });
    await this.store.updateConsent(row.id, {
      state: giveUp ? 'failed' : 'awaiting_consent',
      checkedAt: now,
      endReason: giveUp ? 'consent_error' : undefined,
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
