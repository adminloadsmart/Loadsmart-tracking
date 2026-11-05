import { describe, expect, it, vi } from 'vitest';
import { IntugineError, type SimProvider } from './intugine.client';
import type { SimConsent } from './intugine.contract';
import { SimConsentService, type SimLoad } from './sim-consent.service';
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
  const service = new SimConsentService(store, provider, {
    checkIntervalMs: HOUR,
    ttlMs: 4 * HOUR,
    maxAttempts: 2,
  });
  return { store, service, checkConsent };
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
});
