import { describe, expect, it, vi } from 'vitest';
import type { StaffIdentity } from '../../shared/auth/staff-token';
import type { SimConsent } from './intugine.contract';
import type { SimProvider } from './intugine.client';
import { SimConsentApiService } from './sim-consent.api';
import { MemoryConsentStore } from './sim-consent.repository';
import { SimConsentService } from './sim-consent.service';
import { MemoryStore } from './sim-trip.memory-store';

const T0 = new Date('2026-10-28T08:00:00Z');
const HOUR = 3_600_000;
const scope = { tenantId: 'ten' };
const user = (permissions: string[]): StaffIdentity =>
  ({ userId: 'u1', tenantId: 'ten', role: 'ops', permissions }) as unknown as StaffIdentity;
const ops = user(['trip.track']);
const consent = (status: SimConsent['status']): SimConsent => ({
  status,
  operator: 'airtel',
  suggestion: null,
});

function setup(answers: SimConsent[], load: Record<string, unknown> | null = {}, canSend = true) {
  const trips = new MemoryStore();
  const consents = new MemoryConsentStore();
  const checkConsent = vi.fn(async () => answers.shift()!);
  const service = new SimConsentService(
    trips,
    { checkConsent } as unknown as SimProvider,
    { checkIntervalMs: HOUR, ttlMs: 12 * HOUR },
    consents,
  );
  const fullLoad =
    load === null
      ? null
      : {
          id: 'trip-1',
          tenantId: 'ten',
          status: 'truck_assigned',
          trackingSource: 'sim',
          vehicleId: 'veh-1',
          driverId: 'drv-1',
          driverNumber: '9876543210',
          ...load,
        };
  const api = new SimConsentApiService(
    { trip: async () => fullLoad as never },
    trips,
    service,
    canSend,
  );
  return { api, service, trips, checkConsent, consents };
}

describe('SimConsentApiService', () => {
  it('a trip outside the tenant (or missing) is not found', async () => {
    await expect(setup([], null).api.get(scope, 'trip-1')).rejects.toThrow(/not found/);
  });

  it('a load not tracked by SIM has no consent to show', async () => {
    const { api } = setup([], { trackingSource: 'gps' });
    expect(await api.get(scope, 'trip-1')).toEqual({
      tripId: 'trip-1',
      applicable: false,
      trackingSource: 'gps',
    });
  });

  it('shows Link sent and waiting, then Given', async () => {
    const { api, service } = setup([consent('pending'), consent('allowed')]);
    await service.request(
      {
        tenantId: 'ten',
        tripId: 'trip-1',
        vehicleId: 'veh-1',
        driverId: null,
        driverNumber: '9876543210',
      },
      T0,
    );
    expect(await api.get(scope, 'trip-1')).toMatchObject({
      applicable: true,
      status: 'link_sent',
      phone: 'XXXXXX3210',
    });
    await service.checkDue(new Date(T0.getTime() + 2 * HOUR));
    expect(await api.get(scope, 'trip-1')).toMatchObject({ status: 'given', canResend: false });
  });

  it('resending needs the trip.track permission', async () => {
    const { api } = setup([consent('pending')]);
    await expect(api.resend(scope, user([]), 'trip-1')).rejects.toThrow(/permission/);
  });

  it('resend sends the SMS again, only without a valid consent', async () => {
    const { api, checkConsent, consents } = setup([consent('pending'), consent('pending')]);
    // The first send is the lifecycle's; make it old enough that the resend gap has passed.
    await consents.save({
      phone: '9876543210',
      operator: 'airtel',
      status: 'pending',
      suggestion: null,
      firstSentAt: new Date(Date.now() - 3 * HOUR),
      sentAt: new Date(Date.now() - 3 * HOUR),
      givenAt: null,
      validUntil: null,
      withdrawnAt: null,
      lastCheckedAt: null,
    });
    const result = await api.resend(scope, ops, 'trip-1');
    expect(checkConsent).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({ applicable: true, status: 'link_sent' });
  });

  it('resend with a valid consent on file answers with it (no SMS)', async () => {
    const { api, consents } = setup([]);
    await consents.save({
      phone: '9876543210',
      operator: 'airtel',
      status: 'allowed',
      suggestion: null,
      firstSentAt: null,
      sentAt: null,
      givenAt: new Date(),
      validUntil: new Date(Date.now() + 30 * 86_400_000),
      withdrawnAt: null,
      lastCheckedAt: null,
    });
    expect(await api.resend(scope, ops, 'trip-1')).toMatchObject({ status: 'given' });
  });

  it('resend only while the load is being tracked, and only for SIM loads', async () => {
    await expect(
      setup([], { status: 'delivered_ok' }).api.resend(scope, ops, 'trip-1'),
    ).rejects.toThrow(/being tracked/);
    await expect(
      setup([], { trackingSource: 'gps' }).api.resend(scope, ops, 'trip-1'),
    ).rejects.toThrow(/not tracked by SIM/);
  });

  it('resend says so when SIM is not configured on this process', async () => {
    await expect(setup([], {}, false).api.resend(scope, ops, 'trip-1')).rejects.toThrow(
      /not configured/,
    );
  });
});
