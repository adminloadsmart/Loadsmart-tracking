import { describe, expect, it } from 'vitest';
import type { SimConsent } from './intugine.contract';
import {
  addMonths,
  applyObservation,
  isConsentValid,
  type ConsentRecord,
} from './sim-consent.record';

const T0 = new Date('2026-10-28T08:00:00Z');
const DAY = 86_400_000;
const answer = (status: SimConsent['status'], operator: string | null = 'airtel'): SimConsent => ({
  status,
  operator,
  suggestion: null,
});
const withPhone = (record: ConsentRecord): ConsentRecord => ({ ...record, phone: '9876543210' });

describe('addMonths', () => {
  it('adds calendar months', () => {
    expect(addMonths(new Date('2026-10-28T08:00:00Z'), 9).toISOString()).toBe(
      '2027-07-28T08:00:00.000Z',
    );
  });
  it('a 31st lands on the last day of a shorter month, and years roll over', () => {
    expect(addMonths(new Date('2026-05-31T00:00:00Z'), 9).toISOString()).toBe(
      '2027-02-28T00:00:00.000Z',
    );
    expect(addMonths(new Date('2026-11-30T00:00:00Z'), 3).toISOString()).toBe(
      '2027-02-28T00:00:00.000Z',
    );
  });
});

describe('applyObservation', () => {
  it('pending: the SMS was sent by this call, nothing is given yet', () => {
    const record = withPhone(applyObservation(null, answer('pending'), T0, 9));
    expect(record).toMatchObject({
      status: 'pending',
      sentAt: T0,
      firstSentAt: T0,
      givenAt: null,
      validUntil: null,
      withdrawnAt: null,
    });
    expect(isConsentValid(record, T0)).toBe(false);
  });

  it('another pending check moves sentAt but keeps the first send', () => {
    const first = withPhone(applyObservation(null, answer('pending'), T0, 9));
    const later = new Date(T0.getTime() + 3_600_000);
    const second = applyObservation(first, answer('pending'), later, 9);
    expect(second).toMatchObject({ sentAt: later, firstSentAt: T0 });
  });

  it('allowed: given now, valid for the validity period', () => {
    const record = withPhone(applyObservation(null, answer('allowed'), T0, 9));
    expect(record).toMatchObject({ status: 'allowed', givenAt: T0, withdrawnAt: null });
    expect(record.validUntil?.toISOString()).toBe('2027-07-28T08:00:00.000Z');
    expect(isConsentValid(record, T0)).toBe(true);
    expect(isConsentValid(record, new Date(T0.getTime() + 300 * DAY))).toBe(false); // expired
  });

  it('allowed again while already valid keeps the original dates', () => {
    const first = withPhone(applyObservation(null, answer('allowed'), T0, 9));
    const later = new Date(T0.getTime() + 30 * DAY);
    const again = applyObservation(first, answer('allowed'), later, 9);
    expect(again.givenAt).toEqual(T0);
    expect(again.validUntil).toEqual(first.validUntil);
  });

  it('a valid consent the operator no longer allows was withdrawn', () => {
    const first = withPhone(applyObservation(null, answer('allowed'), T0, 9));
    const later = new Date(T0.getTime() + 30 * DAY);
    const revoked = applyObservation(first, answer('denied'), later, 9);
    expect(revoked).toMatchObject({ status: 'denied', withdrawnAt: later });
    expect(isConsentValid(revoked, later)).toBe(false);
  });

  it('a consent that ran out its validity is expired, not withdrawn', () => {
    const first = withPhone(applyObservation(null, answer('allowed'), T0, 9));
    const later = new Date(T0.getTime() + 300 * DAY);
    const expired = applyObservation(first, answer('pending'), later, 9);
    expect(expired.withdrawnAt).toBeNull();
    expect(expired.sentAt).toEqual(later);
  });

  it('a driver who consents again after a withdrawal is valid again, with new dates', () => {
    const first = withPhone(applyObservation(null, answer('allowed'), T0, 9));
    const revoked = applyObservation(first, answer('denied'), new Date(T0.getTime() + DAY), 9);
    const back = new Date(T0.getTime() + 2 * DAY);
    const again = applyObservation(revoked, answer('allowed'), back, 9);
    expect(again).toMatchObject({ givenAt: back, withdrawnAt: null });
    expect(isConsentValid(again, back)).toBe(true);
  });

  it('the validity period is a setting', () => {
    const record = applyObservation(null, answer('allowed'), T0, 3);
    expect(record.validUntil?.toISOString()).toBe('2027-01-28T08:00:00.000Z');
  });
});
