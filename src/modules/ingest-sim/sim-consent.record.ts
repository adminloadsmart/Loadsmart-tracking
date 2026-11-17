import type { SimConsent, SimConsentStatus } from './intugine.contract';

/** SIM consent of one driver mobile number — shared by every load that driver is on. */
export interface ConsentRecord {
  /** Normalized 10-digit number. */
  phone: string;
  operator: string | null;
  /** The operator's last answer. */
  status: SimConsentStatus;
  suggestion: string | null;
  firstSentAt: Date | null;
  /** The last time the consent SMS went out (Intugine texts a pending number on each check). */
  sentAt: Date | null;
  /** When the operator first reported the number as allowed. */
  givenAt: Date | null;
  /** givenAt + the validity period. */
  validUntil: Date | null;
  /** When a consent that had been valid stopped being allowed. */
  withdrawnAt: Date | null;
  lastCheckedAt: Date | null;
}

/** Valid: given, not withdrawn, not past its validity date. */
export function isConsentValid(record: ConsentRecord | null | undefined, now: Date): boolean {
  return (
    !!record &&
    record.status === 'allowed' &&
    !!record.givenAt &&
    !record.withdrawnAt &&
    !!record.validUntil &&
    record.validUntil.getTime() > now.getTime()
  );
}

/** `date` plus whole calendar months (a 31st lands on the month's last day). */
export function addMonths(date: Date, months: number): Date {
  const result = new Date(date.getTime());
  const day = result.getUTCDate();
  result.setUTCDate(1);
  result.setUTCMonth(result.getUTCMonth() + months);
  const lastDay = new Date(
    Date.UTC(result.getUTCFullYear(), result.getUTCMonth() + 1, 0),
  ).getUTCDate();
  result.setUTCDate(Math.min(day, lastDay));
  return result;
}

/**
 * What an answer from the operator (via Intugine) does to the number's consent. Pure.
 *  - allowed: a consent that is not already valid is given now (valid for `validityMonths`); one
 *    that is already valid keeps its original dates; a withdrawal is cleared.
 *  - anything else after a valid consent: it was withdrawn (revoked) at the operator.
 *  - pending / not registered: the SMS was (re)sent by this very call, so `sentAt` moves.
 *  A consent that merely ran past its validity date is expired, not withdrawn.
 */
export function applyObservation(
  existing: ConsentRecord | null,
  answer: SimConsent,
  now: Date,
  validityMonths: number,
): ConsentRecord {
  const record: ConsentRecord = existing
    ? { ...existing }
    : {
        phone: '',
        operator: null,
        status: 'pending',
        suggestion: null,
        firstSentAt: null,
        sentAt: null,
        givenAt: null,
        validUntil: null,
        withdrawnAt: null,
        lastCheckedAt: null,
      };
  const wasValid = isConsentValid(existing, now);
  record.operator = answer.operator ?? record.operator;
  record.suggestion = answer.suggestion ?? record.suggestion;
  record.status = answer.status;
  record.lastCheckedAt = now;

  if (answer.status === 'allowed') {
    if (!wasValid) {
      record.givenAt = now;
      record.validUntil = addMonths(now, validityMonths);
    }
    record.withdrawnAt = null;
    return record;
  }
  if (wasValid) record.withdrawnAt = now;
  if (answer.status === 'pending' || answer.status === 'not_registered') {
    record.sentAt = now;
    record.firstSentAt ??= now;
  }
  return record;
}

/** The status the console shows for a load's SIM consent. */
export type SimConsentView =
  | 'valid' // a consent already on file covered this load (shown with its validity date)
  | 'link_sent' // the SMS went out and the driver has not answered
  | 'given' // the driver answered this load's SMS
  | 'unavailable' // denied, withdrawn, expired, unsupported operator or timed out
  | 'no_number'; // the load has no usable driver number
