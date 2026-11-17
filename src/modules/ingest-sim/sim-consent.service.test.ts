import { describe, expect, it, vi } from 'vitest';
import { IntugineError, type SimProvider } from './intugine.client';
import type { SimConsent } from './intugine.contract';
import { SimConsentService, type SimLoad } from './sim-consent.service';
import { MemoryConsentStore } from './sim-consent.repository';
import { MemoryStore } from './sim-trip.memory-store';

const load: SimLoad = {
  tenantId: 't',
  tripId: 'trip-1',
  vehicleId: 'veh-1',
  driverId: 'drv-1',
  driverNumber: '+91 98765 43210',
};
const HOUR = 3_600_000;
const T0 = new Date('2026-10-28T08:00:00Z');
const at = (ms: number) => new Date(T0.getTime() + ms);
const consent = (status: SimConsent['status']): SimConsent => ({
  status,
  operator: 'airtel',
  suggestion: null,
});

function setup(answers: Array<SimConsent | Error>) {
  const store = new MemoryStore();
  const checkConsent = vi.fn(async () => {
    const next = answers.shift()!;
    if (next instanceof Error) throw next;
    return next;
  });
  const provider = { checkConsent } as unknown as SimProvider;
  const consents = new MemoryConsentStore();
  const service = new SimConsentService(
    store,
    provider,
    { checkIntervalMs: HOUR, ttlMs: 4 * HOUR, maxAttempts: 2 },
    consents,
  );
  return { store, service, checkConsent, consents };
}

describe('SimConsentService', () => {
  it('does nothing without a usable driver number', async () => {
    const { service, store, checkConsent } = setup([]);
    expect(await service.request({ ...load, driverNumber: '12345' }, T0)).toBe('no_phone');
    expect(checkConsent).not.toHaveBeenCalled();
    expect(store.rows).toHaveLength(0);
  });

  it('is ready at once when the number is already allowed', async () => {
    const { service, store, checkConsent } = setup([consent('allowed')]);
    expect(await service.request(load, T0)).toBe('ready');
    expect(checkConsent).toHaveBeenCalledWith('9876543210');
    expect(store.rows[0]).toMatchObject({ state: 'consented', operator: 'airtel' });
  });

  it('asks only once per trip, however often it is called', async () => {
    const { service, checkConsent } = setup([consent('pending')]);
    expect(await service.request(load, T0)).toBe('waiting');
    expect(await service.request(load, at(60_000))).toBe('waiting');
    expect(checkConsent).toHaveBeenCalledTimes(1);
  });

  it('re-checks a pending number only when the interval has passed', async () => {
    const { service, store, checkConsent } = setup([consent('pending'), consent('allowed')]);
    await service.request(load, T0);
    expect(await service.checkDue(at(30 * 60_000))).toMatchObject({ ready: 0, waiting: 0 });
    expect(await service.checkDue(at(HOUR))).toMatchObject({ ready: 1 });
    expect(store.rows[0].state).toBe('consented');
    expect(checkConsent).toHaveBeenCalledTimes(2);
  });

  it('falls back when consent is denied or the operator is unsupported', async () => {
    for (const status of ['denied', 'unsupported'] as const) {
      const { service, store } = setup([consent(status)]);
      expect(await service.request(load, T0)).toBe('fallback');
      expect(store.rows[0]).toMatchObject({ state: 'unsupported' });
    }
  });

  it('gives up after the TTL without another call', async () => {
    const { service, store, checkConsent } = setup([consent('pending')]);
    await service.request(load, T0);
    expect(await service.checkDue(at(4 * HOUR))).toMatchObject({ fallback: 1 });
    expect(store.rows[0].state).toBe('failed');
    expect(checkConsent).toHaveBeenCalledTimes(1);
  });

  it('keeps trying after an error, then gives up', async () => {
    const { service, store } = setup([
      new IntugineError('boom', 500),
      new IntugineError('boom', 500),
    ]);
    expect(await service.request(load, T0)).toBe('waiting');
    expect(store.rows[0]).toMatchObject({ state: 'awaiting_consent', attempts: 1 });
    expect(await service.checkDue(at(HOUR))).toMatchObject({ fallback: 1 });
    expect(store.rows[0].state).toBe('failed');
  });

  describe('consent per driver number, reused across loads', () => {
    const other: SimLoad = { ...load, tripId: 'trip-2', vehicleId: 'veh-2' };

    it('records the SMS time while pending, and the given time with ~9 months of validity', async () => {
      const { service, consents } = setup([consent('pending'), consent('allowed')]);
      await service.request(load, T0);
      expect(consents.records.get('9876543210')).toMatchObject({
        status: 'pending',
        sentAt: T0,
        givenAt: null,
      });
      await service.checkDue(at(2 * HOUR));
      const record = consents.records.get('9876543210')!;
      expect(record.givenAt).toEqual(at(2 * HOUR));
      expect(record.validUntil!.getTime()).toBeGreaterThan(
        at(2 * HOUR).getTime() + 250 * 86_400_000,
      );
    });

    it('a second load of the same driver needs no call and no SMS: ready at once, marked reused', async () => {
      const { service, store, checkConsent } = setup([consent('allowed')]);
      expect(await service.request(load, T0)).toBe('ready');
      expect(await service.request(other, at(HOUR))).toBe('ready');
      expect(checkConsent).toHaveBeenCalledTimes(1);
      expect(store.rows[1]).toMatchObject({
        tripId: 'trip-2',
        state: 'consented',
        consentReused: true,
      });
      expect(store.rows[0].consentReused).toBe(false);
    });

    it('a number texted a moment ago for another load is not texted again', async () => {
      const { service, store, checkConsent } = setup([consent('pending')]);
      await service.request(load, T0);
      expect(await service.request(other, at(5 * 60_000))).toBe('waiting');
      expect(checkConsent).toHaveBeenCalledTimes(1);
      expect(store.rows[1].state).toBe('awaiting_consent');
    });

    it('a pending load picks up a consent another load got meanwhile, without a call', async () => {
      const { service, store, checkConsent } = setup([consent('pending'), consent('allowed')]);
      await service.request(load, T0); // load 1: texted
      await service.request(other, at(5 * 60_000)); // load 2: waits (not texted again)
      await service.checkDue(at(2 * HOUR)); // load 1's check: allowed
      expect(checkConsent).toHaveBeenCalledTimes(2);
      expect(store.rows.map((r) => r.state)).toEqual(['consented', 'consented']);
      expect(checkConsent).toHaveBeenCalledTimes(2); // load 2 reused it: no third call
    });

    it('a consent past its validity asks again', async () => {
      const { service, checkConsent } = setup([consent('allowed'), consent('pending')]);
      await service.request(load, T0);
      const later = at(300 * 86_400_000);
      expect(await service.request(other, later)).toBe('waiting');
      expect(checkConsent).toHaveBeenCalledTimes(2);
    });

    it('observe() marks a valid consent the operator no longer allows as withdrawn', async () => {
      const { service, consents } = setup([consent('allowed'), consent('pending')]);
      await service.request(load, T0);
      await service.observe('9876543210', consent('denied'), at(30 * 86_400_000));
      expect(consents.records.get('9876543210')).toMatchObject({
        status: 'denied',
        withdrawnAt: at(30 * 86_400_000),
      });
      expect(await service.request(other, at(31 * 86_400_000))).toBe('waiting'); // asked afresh
    });
  });

  describe('resend', () => {
    it('is refused while a valid consent is on file', async () => {
      const { service } = setup([consent('allowed')]);
      await service.request(load, T0);
      await expect(service.resend(load, at(HOUR))).rejects.toThrow(/valid consent/);
    });

    it('is refused within the gap after the last send, then sends and records it', async () => {
      const { service, checkConsent, consents } = setup([consent('pending'), consent('pending')]);
      await service.request(load, T0);
      await expect(service.resend(load, at(60_000))).rejects.toThrow(/a moment ago/);
      expect(await service.resend(load, at(11 * 60_000))).toBe('waiting');
      expect(checkConsent).toHaveBeenCalledTimes(2);
      expect(consents.records.get('9876543210')!.sentAt).toEqual(at(11 * 60_000));
    });

    it('a trip whose consent timed out gets a fresh row and a new SMS', async () => {
      const { service, store, checkConsent } = setup([consent('pending'), consent('pending')]);
      await service.request(load, T0);
      await service.checkDue(at(5 * HOUR)); // past the 4 h TTL
      expect(store.rows[0].state).toBe('failed');
      expect(await service.resend(load, at(5 * HOUR + 1000))).toBe('waiting');
      expect(store.rows).toHaveLength(2);
      expect(checkConsent).toHaveBeenCalledTimes(2);
    });

    it('is refused for an operator Intugine cannot track', async () => {
      const { service } = setup([consent('unsupported')]);
      await service.request(load, T0);
      await expect(service.resend(load, at(HOUR))).rejects.toThrow(/cannot be tracked/);
    });

    it('needs a usable number', async () => {
      const { service } = setup([]);
      await expect(service.resend({ ...load, driverNumber: '123' }, T0)).rejects.toThrow(/mobile/);
    });
  });

  describe('summarize: what the console shows', () => {
    it('Link sent and waiting, with the send time and a resend allowed', async () => {
      const { service, store } = setup([consent('pending')]);
      await service.request(load, T0);
      const view = await service.summarize(load.driverNumber, store.rows[0], at(60_000));
      expect(view).toMatchObject({
        status: 'link_sent',
        phone: 'XXXXXX3210',
        sentAt: T0.toISOString(),
        canResend: true,
      });
    });

    it('Given when the driver answered this load’s SMS; Valid (with the date) on a later load', async () => {
      const { service, store } = setup([consent('pending'), consent('allowed')]);
      await service.request(load, T0);
      await service.checkDue(at(2 * HOUR));
      const given = await service.summarize(load.driverNumber, store.rows[0], at(3 * HOUR));
      expect(given).toMatchObject({ status: 'given', canResend: false });
      await service.request({ ...load, tripId: 'trip-2', vehicleId: 'veh-2' }, at(4 * HOUR));
      const valid = await service.summarize(load.driverNumber, store.rows[1], at(4 * HOUR));
      expect(valid.status).toBe('valid');
      expect(valid.validUntil).toBe(given.validUntil);
      expect(valid.validUntil).not.toBeNull();
    });

    it('unavailable once denied or withdrawn, resendable unless the operator is unsupported', async () => {
      const denied = setup([consent('denied')]);
      await denied.service.request(load, T0);
      expect(
        await denied.service.summarize(load.driverNumber, denied.store.rows[0], at(HOUR)),
      ).toMatchObject({ status: 'unavailable', canResend: true });

      const unsupported = setup([consent('unsupported')]);
      await unsupported.service.request(load, T0);
      expect(
        await unsupported.service.summarize(load.driverNumber, unsupported.store.rows[0], at(HOUR)),
      ).toMatchObject({ status: 'unavailable', canResend: false });
    });

    it('no number', async () => {
      const { service } = setup([]);
      expect(await service.summarize('12345', null, T0)).toMatchObject({
        status: 'no_number',
        phone: null,
        canResend: false,
      });
    });
  });
});
