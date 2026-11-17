import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  infraAvailable,
  testDataSource,
  truncateTrackingTables,
} from '../../__tests__/support/infra';
import { SimConsentRepository } from './sim-consent.repository';
import { SimTripRepository } from './sim-trip.repository';
import type { ConsentRecord } from './sim-consent.record';

const available = await infraAvailable();
const TENANT = '11111111-1111-4111-8111-111111111111';

describe.skipIf(!available)('SIM consent storage (real Postgres)', () => {
  let ds: DataSource;
  let consents: SimConsentRepository;
  let trips: SimTripRepository;

  beforeAll(async () => {
    ds = await testDataSource();
    consents = new SimConsentRepository(ds);
    trips = new SimTripRepository(ds);
  });
  beforeEach(async () => {
    await truncateTrackingTables(ds);
  });
  afterAll(async () => {
    // The shared test data source stays open for the other suites.
  });

  const record = (over: Partial<ConsentRecord> = {}): ConsentRecord => ({
    phone: '9876543210',
    operator: 'airtel',
    status: 'allowed',
    suggestion: null,
    firstSentAt: new Date('2026-10-01T08:00:00Z'),
    sentAt: new Date('2026-10-01T09:00:00Z'),
    givenAt: new Date('2026-10-02T08:00:00Z'),
    validUntil: new Date('2027-07-02T08:00:00Z'),
    withdrawnAt: null,
    lastCheckedAt: new Date('2026-10-02T08:00:00Z'),
    ...over,
  });
  const newTrip = (tripId: string, over: Record<string, unknown> = {}) => ({
    tenantId: TENANT,
    tripId,
    vehicleId: randomUUID(),
    driverId: null,
    phone: '9876543210',
    ...over,
  });

  it('keeps one consent per number: saved, found, updated in place', async () => {
    expect(await consents.find('9876543210')).toBeNull();
    await consents.save(record());
    expect(await consents.find('9876543210')).toEqual(record());
    await consents.save(
      record({ status: 'denied', withdrawnAt: new Date('2026-12-01T00:00:00Z') }),
    );
    const updated = await consents.find('9876543210');
    expect(updated).toMatchObject({ status: 'denied' });
    expect(updated!.withdrawnAt).toEqual(new Date('2026-12-01T00:00:00Z'));
    expect(await ds.query(`SELECT count(*)::int AS n FROM tracking.sim_consents`)).toEqual([
      { n: 1 },
    ]);
  });

  it('a load that finds a valid consent starts consented and marked reused', async () => {
    const tripId = randomUUID();
    const row = await trips.insert(newTrip(tripId, { reusedConsent: true }));
    expect(row).toMatchObject({
      state: 'consented',
      consentStatus: 'allowed',
      consentReused: true,
    });
    const fresh = await trips.insert(newTrip(randomUUID()));
    expect(fresh).toMatchObject({ state: 'awaiting_consent', consentReused: false });
  });

  it('finds a trip’s newest row even after it ended', async () => {
    const tripId = randomUUID();
    const first = (await trips.insert(newTrip(tripId)))!;
    await trips.markEnded(first, { state: 'failed', reason: 'consent_timeout', now: new Date() });
    expect(await trips.findLiveByTrip(tripId)).toBeNull();
    const second = (await trips.insert(newTrip(tripId)))!;
    const latest = await trips.findLatestByTrip(tripId);
    expect(latest?.id).toBe(second.id);
    await trips.markEnded(second, {
      state: 'unsupported',
      reason: 'consent_unsupported',
      now: new Date(),
    });
    expect(await trips.findLatestByTrip(tripId)).toMatchObject({
      state: 'unsupported',
      endReason: 'consent_unsupported',
    });
  });

  it('“never ask again” is per load AND number: a new driver on the same load is asked', async () => {
    const tripId = randomUUID();
    const row = (await trips.insert(newTrip(tripId)))!;
    await trips.markEnded(row, { state: 'unsupported', reason: 'consent_denied', now: new Date() });
    const finished = await trips.loadsWithFinishedConsent([
      { id: tripId, phone: '9876543210' },
      { id: randomUUID(), phone: '9876543210' },
    ]);
    expect([...finished]).toEqual([tripId]);
    expect(await trips.loadsWithFinishedConsent([{ id: tripId, phone: '9123456780' }])).toEqual(
      new Set(),
    );
    expect(await trips.loadsWithFinishedConsent([{ id: tripId, phone: null }])).toEqual(new Set());
  });

  it('the migration carried approved numbers over from earlier loads (given, valid 9 months)', async () => {
    // Re-run the migration's backfill statement on a row the old per-trip model would have left.
    const tripId = randomUUID();
    const row = (await trips.insert(newTrip(tripId)))!;
    await trips.updateConsent(row.id, {
      state: 'consented',
      consentStatus: 'allowed',
      operator: 'airtel',
      checkedAt: new Date('2026-09-01T00:00:00Z'),
      requestedAt: new Date('2026-09-01T00:00:00Z'),
    });
    await ds.query(`
      INSERT INTO tracking.sim_consents
        (phone, operator, status, first_sent_at, sent_at, given_at, valid_until, last_checked_at)
      SELECT DISTINCT ON (phone) phone, operator, 'allowed', consent_requested_at,
        consent_requested_at, COALESCE(consent_last_checked_at, consent_requested_at, created_at),
        COALESCE(consent_last_checked_at, consent_requested_at, created_at) + interval '9 months',
        consent_last_checked_at
      FROM tracking.sim_trips WHERE operator_consent_status = 'allowed'
      ORDER BY phone, consent_last_checked_at DESC NULLS LAST
      ON CONFLICT (phone) DO NOTHING`);
    const migrated = await consents.find('9876543210');
    expect(migrated?.givenAt).toEqual(new Date('2026-09-01T00:00:00Z'));
    expect(migrated?.validUntil).toEqual(new Date('2027-06-01T00:00:00Z'));
  });
});
