import type { Logger } from 'pino';
import { describe, expect, it, vi } from 'vitest';
import type { SimProvider } from './intugine.client';
import type { SimConsent } from './intugine.contract';
import { MemoryConsentStore } from './sim-consent.repository';
import { SimConsentService } from './sim-consent.service';
import {
  type CreatedTripEnds,
  SimLifecycleService,
  type SimMainData,
} from './sim-lifecycle.service';
import { MemoryStore } from './sim-trip.memory-store';

const MIN = 60_000;
const T0 = Date.parse('2026-10-28T08:00:00Z');
const at = (min: number) => new Date(T0 + min * MIN);

const place = (id: string, lat: number, lng: number) => ({
  id,
  kind: 'loading_point' as const,
  name: `Place ${id}`,
  city: null,
  address: null,
  lat,
  lng,
});

function makeLoad(over: Record<string, unknown> = {}) {
  return {
    id: 'load-1',
    tenantId: 'ten',
    code: 'LD-1',
    status: 'loaded',
    trackingSource: 'sim',
    vehicleId: 'veh-1',
    vehicleNumber: 'MH42BF0711',
    driverId: 'drv-1',
    driverNumber: '9876543210',
    startedAt: new Date(T0),
    ...over,
  };
}

/** A trip created from the tracking screen, as main-data hands it over (in the load shape). */
function makeCreatedTrip(over: Record<string, unknown> = {}) {
  return makeLoad({
    id: 'trip-1',
    code: 'TRP-0001',
    status: 'in_transit_unloading',
    driverId: null,
    createdTrip: true,
    ...over,
  });
}

function setup(
  opts: {
    load?: Record<string, unknown> | null;
    consent?: SimConsent;
    /** A created trip next to (or instead of) the load. */
    created?: Record<string, unknown>;
    /** The created trip's master points, when not the load's p1 → d1. */
    createdPoints?: Record<string, unknown>;
    createdEnds?: CreatedTripEnds | null;
  } = {},
) {
  let load: ReturnType<typeof makeLoad> | null =
    opts.load === null ? null : makeLoad(opts.load ?? {});
  let created: ReturnType<typeof makeLoad> | null = opts.created
    ? makeCreatedTrip(opts.created)
    : null;
  const store = new MemoryStore();
  const provider = {
    checkConsent: vi.fn(
      async () => opts.consent ?? { status: 'allowed', operator: 'airtel', suggestion: null },
    ),
    startTrip: vi.fn(async () => ({
      intugineTripId: 'INT-1',
      consent: { status: 'allowed', operator: 'airtel', suggestion: null } as SimConsent,
    })),
    endTrip: vi.fn(async () => true),
    updateTripPhone: vi.fn(async (_id: string, _tel: string) => {}),
    findTripByInvoice: vi.fn(async () => null as string | null),
  };
  const mainData: SimMainData = {
    loadsByStatus: async (_scope, statuses) =>
      load && statuses.includes(load.status as never) ? [load as never] : [],
    trip: async (_scope, id) => ((created && created.id === id ? created : load) as never) ?? null,
    activeCreatedTrips: async () =>
      created && created.status === 'in_transit_unloading' ? [created as never] : [],
    createdTripEnds: async () => opts.createdEnds ?? null,
    tripPoints: async () => {
      const points = {
        vehicleNumber: 'MH42BF0711',
        pickupLoadingPointId: 'p1',
        dropCustomerDeliveryPointId: 'd1',
        dropLoadingPointId: null,
      };
      return new Map([
        ['load-1', points],
        ['trip-1', { ...points, ...opts.createdPoints }],
      ]);
    },
    places: async () =>
      new Map([
        ['p1', place('p1', 18.78, 74.27)],
        ['d1', place('d1', 16.81, 81.53)],
      ]),
  };
  const cursorDelete = vi.fn(async (_id: string) => {});
  const consents = new MemoryConsentStore();
  const consent = new SimConsentService(
    store,
    provider as unknown as SimProvider,
    { checkIntervalMs: 60 * MIN, ttlMs: 240 * MIN },
    consents,
  );
  const service = new SimLifecycleService(
    mainData,
    store,
    provider as unknown as SimProvider,
    consent,
    { delete: cursorDelete },
    { warn: vi.fn(), info: vi.fn() } as unknown as Logger,
  );
  return {
    service,
    store,
    provider,
    cursorDelete,
    consents,
    setLoad: (l: typeof load) => (load = l),
    setCreated: (c: typeof created) => (created = c),
  };
}

describe('SimLifecycleService', () => {
  it('asks for consent once the load is on SIM, before tracking starts', async () => {
    const { service, store, provider } = setup({
      load: { status: 'truck_assigned', startedAt: null },
    });
    const result = await service.run(at(0));
    expect(result.consentRequested).toBe(1);
    expect(provider.checkConsent).toHaveBeenCalledTimes(1);
    expect(store.rows[0].state).toBe('consented');
    expect(provider.startTrip).not.toHaveBeenCalled();
    await service.run(at(10));
    expect(provider.checkConsent).toHaveBeenCalledTimes(1); // never asked twice
  });

  it.each(['gps', 'driver_app', 'fastag', null])(
    'ignores a load whose source is %s: no consent, no trip',
    async (trackingSource) => {
      const { service, store, provider } = setup({ load: { trackingSource } });
      const result = await service.run(at(0));
      expect(result).toMatchObject({ consentRequested: 0, started: 0, ended: 0 });
      expect(store.rows).toHaveLength(0);
      expect(provider.checkConsent).not.toHaveBeenCalled();
      expect(provider.startTrip).not.toHaveBeenCalled();
    },
  );

  it('starts the trip as soon as consent is allowed and the load is tracked', async () => {
    const { service, store, provider } = setup();
    const result = await service.run(at(0));
    expect(result.started).toBe(1);
    expect(provider.startTrip).toHaveBeenCalledWith(
      expect.objectContaining({
        tel: '9876543210',
        src: [18.78, 74.27],
        dest: [16.81, 81.53],
        truckNumber: 'MH42BF0711',
        invoice: 'LD-1',
        loadId: 'load-1',
      }),
    );
    expect(store.rows[0]).toMatchObject({ state: 'active', intugineTripId: 'INT-1' });
  });

  it('keeps waiting while consent is pending and starts once it is allowed', async () => {
    const { service, store, provider } = setup({
      consent: { status: 'pending', operator: 'airtel', suggestion: null },
    });
    await service.run(at(0));
    await service.run(at(35));
    expect(provider.startTrip).not.toHaveBeenCalled();
    expect(store.rows[0].state).toBe('awaiting_consent');

    provider.checkConsent.mockResolvedValue({
      status: 'allowed',
      operator: 'airtel',
      suggestion: null,
    });
    const result = await service.run(at(61)); // the hourly re-check finds it approved and starts
    expect(result.started).toBe(1);
    expect(store.rows[0].state).toBe('active');
  });

  describe('extra consent checks at the loading and transit statuses', () => {
    const pending: SimConsent = { status: 'pending', operator: 'airtel', suggestion: null };
    const allowed: SimConsent = { status: 'allowed', operator: 'airtel', suggestion: null };

    it('re-checks a pending consent once at in_transit_loading, reached_loading and in_transit_unloading', async () => {
      const { service, provider, setLoad } = setup({
        load: { status: 'truck_assigned', startedAt: new Date(T0) },
        consent: pending,
      });
      await service.run(at(0)); // assignment: the first SMS
      expect(provider.checkConsent).toHaveBeenCalledTimes(1);

      const at_ = (status: string) => setLoad(makeLoad({ status }));
      at_('in_transit_loading');
      await service.run(at(20));
      await service.run(at(25)); // same stage again: no second check
      expect(provider.checkConsent).toHaveBeenCalledTimes(2);

      at_('reached_loading');
      await service.run(at(40));
      expect(provider.checkConsent).toHaveBeenCalledTimes(3);

      at_('loaded'); // still the same stage as reached_loading
      await service.run(at(45));
      expect(provider.checkConsent).toHaveBeenCalledTimes(3);

      at_('in_transit_unloading');
      await service.run(at(60));
      expect(provider.checkConsent).toHaveBeenCalledTimes(4);
    });

    it('a skipped status still gets one check', async () => {
      const { service, provider, setLoad } = setup({
        load: { status: 'truck_assigned', startedAt: new Date(T0) },
        consent: pending,
      });
      await service.run(at(0));
      setLoad(makeLoad({ status: 'in_transit_unloading' }));
      await service.run(at(30));
      expect(provider.checkConsent).toHaveBeenCalledTimes(2);
    });

    it('does not text again within the resend gap, but records the stage', async () => {
      const { service, store, provider, setLoad } = setup({
        load: { status: 'truck_assigned', startedAt: new Date(T0) },
        consent: pending,
      });
      await service.run(at(0));
      setLoad(makeLoad({ status: 'in_transit_loading' }));
      await service.run(at(5)); // texted 5 min ago, gap is 10
      expect(provider.checkConsent).toHaveBeenCalledTimes(1);
      expect(store.rows[0].consentStage).toBe(1);
    });

    it('starts the trip when the stage check finds the consent approved', async () => {
      const { service, store, provider, setLoad } = setup({
        load: { status: 'truck_assigned', startedAt: new Date(T0) },
        consent: pending,
      });
      await service.run(at(0));
      provider.checkConsent.mockResolvedValue(allowed);
      setLoad(makeLoad({ status: 'reached_loading' }));
      const result = await service.run(at(30)); // before the hourly re-check is due
      expect(result.started).toBe(1);
      expect(store.rows[0].state).toBe('active');
    });

    it('does not extend the expiry: past the TTL one last call, then the row gives up', async () => {
      const { service, store, provider, setLoad } = setup({
        load: { status: 'truck_assigned', startedAt: new Date(T0) },
        consent: pending,
      });
      await service.run(at(0));
      const calls = provider.checkConsent.mock.calls.length;
      setLoad(makeLoad({ status: 'in_transit_unloading' }));
      await service.run(at(241)); // TTL in these tests is 240 min
      expect(store.rows[0]).toMatchObject({ state: 'failed', endReason: 'consent_timeout' });
      expect(provider.checkConsent.mock.calls.length).toBe(calls + 1); // the last check only
    });

    it('does nothing for a consent already given', async () => {
      const { service, provider } = setup({
        load: { status: 'in_transit_loading', startedAt: new Date(T0) },
        consent: allowed,
      });
      await service.run(at(0));
      await service.run(at(30));
      expect(provider.checkConsent).toHaveBeenCalledTimes(1);
    });
  });

  it('just ends the row when consent is denied, and never asks again', async () => {
    const { service, store, provider } = setup({
      consent: { status: 'denied', operator: 'airtel', suggestion: null },
    });
    await service.run(at(0));
    await service.run(at(35));
    expect(store.rows[0].state).toBe('unsupported');
    expect(provider.checkConsent).toHaveBeenCalledTimes(1);
    expect(provider.startTrip).not.toHaveBeenCalled();
  });

  it('does nothing when the driver has no usable number', async () => {
    const { service, store, provider } = setup({ load: { driverNumber: null } });
    const result = await service.run(at(35));
    expect(result.consentRequested).toBe(0);
    expect(store.rows).toHaveLength(0);
    expect(provider.checkConsent).not.toHaveBeenCalled();
  });

  it('will not start while the same number is on another trip', async () => {
    const { service, store, provider } = setup();
    await store.insert({
      tenantId: 'ten',
      tripId: 'other-load',
      vehicleId: 'v2',
      driverId: null,
      phone: '9876543210',
    });
    store.rows[0].state = 'active';
    await service.run(at(0));
    expect(provider.startTrip).not.toHaveBeenCalled();
    expect(store.rows.find((r) => r.tripId === 'load-1')).toMatchObject({
      state: 'consented',
      lastError: 'phone in use by trip other-load',
    });
  });

  it('gives up after repeated start failures', async () => {
    const { service, store, provider } = setup();
    provider.startTrip.mockRejectedValue(new Error('boom'));
    for (let i = 0; i < 7; i++) await service.run(at(i));
    expect(store.rows[0].state).toBe('failed');
  });

  it('adopts a trip whose start response was lost instead of starting a second', async () => {
    const { service, store, provider } = setup();
    provider.startTrip.mockRejectedValueOnce(new Error('timeout'));
    await service.run(at(0)); // start fails, but the call may have reached Intugine
    provider.findTripByInvoice.mockResolvedValue('INT-LOST');
    await service.run(at(5));
    expect(provider.startTrip).toHaveBeenCalledTimes(1);
    expect(store.rows[0]).toMatchObject({ state: 'active', intugineTripId: 'INT-LOST' });
  });

  it('ends the Intugine trip when the load finishes', async () => {
    const { service, store, provider, setLoad } = setup();
    await service.run(at(0));
    setLoad(makeLoad({ status: 'delivered' }));
    const result = await service.run(at(90));
    expect(result.ended).toBe(1);
    expect(provider.endTrip).toHaveBeenCalledWith('INT-1');
    expect(store.rows[0].state).toBe('ended');
  });

  it('forgets the poll cursor when the trip ends, even if that fails', async () => {
    const { service, store, cursorDelete, setLoad } = setup();
    await service.run(at(0));
    setLoad(makeLoad({ status: 'delivered' }));
    cursorDelete.mockRejectedValueOnce(new Error('redis down'));
    await service.run(at(90));
    expect(cursorDelete).toHaveBeenCalledWith('INT-1');
    expect(store.rows[0].state).toBe('ended'); // not undone by the failed cleanup
  });

  it('leaves the cursor alone while the trip runs, and for rows that never started', async () => {
    const { service, cursorDelete, setLoad } = setup({
      consent: { status: 'pending', operator: 'airtel', suggestion: null },
    });
    await service.run(at(0));
    setLoad(makeLoad({ status: 'delivered' }));
    await service.run(at(40));
    expect(cursorDelete).not.toHaveBeenCalled();
  });

  it('ends the Intugine trip when the load is no longer on SIM', async () => {
    const { service, store, provider, setLoad } = setup();
    await service.run(at(0));
    setLoad(makeLoad({ trackingSource: 'gps' }));
    const result = await service.run(at(10));
    expect(result.ended).toBe(1);
    expect(provider.endTrip).toHaveBeenCalledWith('INT-1');
    expect(store.rows[0].state).toBe('ended');
  });

  it('ends the old driver’s trip and asks the new driver when the truck was cancelled and replaced', async () => {
    const { service, store, provider, setLoad } = setup();
    await service.run(at(0));
    await service.run(at(1));
    expect(store.rows[0].state).toBe('active');
    // Cancelled and re-assigned between two ticks: same load, same source, new truck and driver.
    setLoad(makeLoad({ vehicleId: 'veh-2', driverId: 'drv-2', driverNumber: '9123456780' }));
    const result = await service.run(at(10));
    expect(result.ended).toBe(1);
    expect(provider.endTrip).toHaveBeenCalledWith('INT-1');
    expect(store.rows[0].state).toBe('ended');
    expect(store.rows[1]).toMatchObject({ phone: '9123456780', vehicleId: 'veh-2' });
    expect(provider.checkConsent).toHaveBeenLastCalledWith('9123456780');
  });

  describe('driver number changed mid-trip (same truck)', () => {
    const NEW = '9123456780';
    async function running(opts: Parameters<typeof setup>[0] = {}) {
      const kit = setup(opts);
      await kit.service.run(at(0));
      await kit.service.run(at(1));
      expect(kit.store.rows[0]).toMatchObject({ state: 'active', intugineTripId: 'INT-1' });
      return kit;
    }

    it('keeps the Intugine trip and moves it to the new number once it consents', async () => {
      const { service, store, provider, cursorDelete, setLoad } = await running();
      setLoad(makeLoad({ driverId: 'drv-2', driverNumber: NEW }));
      await service.run(at(10));

      expect(provider.endTrip).not.toHaveBeenCalled();
      expect(provider.startTrip).toHaveBeenCalledTimes(1); // only the original start
      expect(provider.checkConsent).toHaveBeenLastCalledWith(NEW);
      expect(provider.updateTripPhone).toHaveBeenCalledWith('INT-1', NEW);
      expect(store.rows[0]).toMatchObject({ state: 'ended', endReason: 'driver_changed' });
      expect(store.rows[1]).toMatchObject({
        phone: NEW,
        driverId: 'drv-2',
        state: 'active',
        intugineTripId: 'INT-1',
        carriedIntugineTripId: null,
      });
      expect(cursorDelete).not.toHaveBeenCalled(); // polling continues from the same cursor
    });

    it('waits for a pending consent, without polling, then updates the number', async () => {
      const { service, store, provider, setLoad } = await running();
      provider.checkConsent.mockResolvedValue({
        status: 'pending',
        operator: 'airtel',
        suggestion: null,
      });
      setLoad(makeLoad({ driverId: 'drv-2', driverNumber: NEW }));
      await service.run(at(10));
      expect(store.rows[1]).toMatchObject({
        state: 'awaiting_consent',
        intugineTripId: null,
        carriedIntugineTripId: 'INT-1',
      });
      expect(await store.activeDue(at(10), 0, 10)).toHaveLength(0);
      expect(provider.updateTripPhone).not.toHaveBeenCalled();
      expect(provider.endTrip).not.toHaveBeenCalled();

      provider.checkConsent.mockResolvedValue({
        status: 'allowed',
        operator: 'airtel',
        suggestion: null,
      });
      await service.run(at(80)); // past the hourly re-check
      expect(provider.updateTripPhone).toHaveBeenCalledWith('INT-1', NEW);
      expect(store.rows[1]).toMatchObject({ state: 'active', intugineTripId: 'INT-1' });
    });

    it('a new number with a valid consent on file is moved at once, without an SMS', async () => {
      const { service, provider, consents, setLoad } = await running();
      await consents.save({
        phone: NEW,
        operator: 'jio',
        status: 'allowed',
        suggestion: null,
        firstSentAt: at(-60),
        sentAt: at(-60),
        givenAt: at(-50),
        validUntil: new Date(T0 + 90 * 24 * 60 * MIN),
        withdrawnAt: null,
        lastCheckedAt: at(-50),
      });
      provider.checkConsent.mockClear();
      setLoad(makeLoad({ driverNumber: NEW }));
      await service.run(at(10));
      expect(provider.checkConsent).not.toHaveBeenCalled();
      expect(provider.updateTripPhone).toHaveBeenCalledWith('INT-1', NEW);
    });

    it('ends the Intugine trip when the new number is denied', async () => {
      const { service, store, provider, cursorDelete, setLoad } = await running();
      provider.checkConsent.mockResolvedValue({
        status: 'denied',
        operator: 'airtel',
        suggestion: null,
      });
      setLoad(makeLoad({ driverNumber: NEW }));
      await service.run(at(10));
      expect(store.rows[1]).toMatchObject({ state: 'unsupported', carriedIntugineTripId: null });
      expect(provider.endTrip).toHaveBeenCalledTimes(1);
      expect(provider.endTrip).toHaveBeenCalledWith('INT-1');
      expect(cursorDelete).toHaveBeenCalledWith('INT-1');
      await service.run(at(20));
      expect(provider.endTrip).toHaveBeenCalledTimes(1);
    });

    it('ends the carried trip when the load finishes before the new number consents', async () => {
      const { service, store, provider, setLoad } = await running();
      provider.checkConsent.mockResolvedValue({
        status: 'pending',
        operator: 'airtel',
        suggestion: null,
      });
      setLoad(makeLoad({ driverNumber: NEW }));
      await service.run(at(10));
      setLoad(makeLoad({ driverNumber: NEW, status: 'delivered' }));
      await service.run(at(20));
      expect(provider.endTrip).toHaveBeenCalledTimes(1);
      expect(provider.endTrip).toHaveBeenCalledWith('INT-1');
      expect(store.rows[1]).toMatchObject({ state: 'ended', carriedIntugineTripId: null });
    });

    it('a second change while waiting hands the same trip over again', async () => {
      const { service, store, provider, setLoad } = await running();
      provider.checkConsent.mockResolvedValue({
        status: 'pending',
        operator: 'airtel',
        suggestion: null,
      });
      setLoad(makeLoad({ driverNumber: NEW }));
      await service.run(at(10));
      provider.checkConsent.mockResolvedValue({
        status: 'allowed',
        operator: 'airtel',
        suggestion: null,
      });
      setLoad(makeLoad({ driverNumber: '9000000001' }));
      await service.run(at(20));
      expect(provider.endTrip).not.toHaveBeenCalled();
      expect(provider.updateTripPhone).toHaveBeenCalledWith('INT-1', '9000000001');
      expect(store.rows[2]).toMatchObject({ state: 'active', intugineTripId: 'INT-1' });
    });

    it('gives up after repeated update failures and ends the Intugine trip', async () => {
      const { service, store, provider, setLoad } = await running();
      provider.updateTripPhone.mockRejectedValue(new Error('Intugine 500'));
      setLoad(makeLoad({ driverNumber: NEW }));
      for (let i = 0; i < 7; i++) await service.run(at(10 + i));
      expect(store.rows[1]).toMatchObject({ state: 'failed', carriedIntugineTripId: null });
      expect(provider.endTrip).toHaveBeenCalledWith('INT-1');
      expect(provider.startTrip).toHaveBeenCalledTimes(1);
    });
  });

  it('a denied number does not block the next driver on the same load', async () => {
    const { service, store, provider, setLoad } = setup({
      consent: { status: 'denied', operator: 'airtel', suggestion: null },
    });
    await service.run(at(0));
    expect(store.rows[0].state).toBe('unsupported');
    setLoad(makeLoad({ vehicleId: 'veh-2', driverId: 'drv-2', driverNumber: '9123456780' }));
    await service.run(at(5));
    expect(provider.checkConsent).toHaveBeenCalledTimes(2);
    expect(store.rows).toHaveLength(2);
  });

  it('closes a row that never started when its load finishes, without calling Intugine', async () => {
    const { service, store, provider, setLoad } = setup({
      consent: { status: 'pending', operator: 'airtel', suggestion: null },
    });
    await service.run(at(0));
    setLoad(makeLoad({ status: 'delivered' }));
    await service.run(at(40));
    expect(store.rows[0].state).toBe('ended');
    expect(provider.endTrip).not.toHaveBeenCalled();
  });

  describe('stops at POD accepted, not at delivery', () => {
    const delivered = (over: Record<string, unknown> = {}) =>
      makeLoad({ status: 'delivered_ok', podStatus: 'pending', deliveredAt: at(60), ...over });

    it('a delivered load keeps its running SIM trip while the POD is not accepted', async () => {
      const { service, store, provider, setLoad } = setup();
      await service.run(at(0));
      setLoad(delivered());
      const result = await service.run(at(90));
      expect(result.ended).toBe(0);
      expect(provider.endTrip).not.toHaveBeenCalled();
      expect(store.rows[0].state).toBe('active');
    });

    it('ends the Intugine trip once the POD is accepted', async () => {
      const { service, store, provider, setLoad } = setup();
      await service.run(at(0));
      setLoad(delivered());
      await service.run(at(90));
      setLoad(delivered({ podStatus: 'accepted' }));
      const result = await service.run(at(120));
      expect(result.ended).toBe(1);
      expect(provider.endTrip).toHaveBeenCalledWith('INT-1');
      expect(store.rows[0]).toMatchObject({ state: 'ended', endReason: 'pod_accepted' });
    });

    it('a POD accepted before the load leaves a tracked stage ends it too', async () => {
      const { service, store, setLoad } = setup();
      await service.run(at(0));
      setLoad(makeLoad({ status: 'loaded', podStatus: 'accepted' }));
      await service.run(at(30));
      expect(store.rows[0]).toMatchObject({ state: 'ended', endReason: 'pod_accepted' });
    });

    it('never waits for a POD forever: ends after the limit past the delivery', async () => {
      const { service, store, provider, setLoad } = setup();
      await service.run(at(0));
      setLoad(delivered({ deliveredAt: at(60) }));
      await service.run(at(60 + 71 * 60));
      expect(store.rows[0].state).toBe('active');
      await service.run(at(60 + 73 * 60));
      expect(provider.endTrip).toHaveBeenCalledWith('INT-1');
      expect(store.rows[0]).toMatchObject({ state: 'ended', endReason: 'delivery_timeout' });
    });

    it('a delivered load that never had a SIM trip does not start one', async () => {
      const { service, store, provider } = setup({
        load: { status: 'delivered_ok', podStatus: 'pending', deliveredAt: at(0) },
      });
      await service.run(at(10));
      expect(store.rows).toHaveLength(0);
      expect(provider.checkConsent).not.toHaveBeenCalled();
    });

    it('a load that is no longer on SIM is still ended after delivery', async () => {
      const { service, store, setLoad } = setup();
      await service.run(at(0));
      setLoad(delivered({ trackingSource: 'gps' }));
      await service.run(at(90));
      expect(store.rows[0].state).toBe('ended');
    });
  });

  describe('consent across loads and withdrawal', () => {
    it('a driver already approved on another load is not asked again', async () => {
      const { service, store, provider, consents } = setup({
        load: { status: 'truck_assigned', startedAt: null },
      });
      await consents.save({
        phone: '9876543210',
        operator: 'airtel',
        status: 'allowed',
        suggestion: null,
        firstSentAt: at(-60 * 24),
        sentAt: at(-60 * 24),
        givenAt: at(-60 * 24),
        validUntil: new Date(T0 + 200 * 86_400_000),
        withdrawnAt: null,
        lastCheckedAt: at(-60 * 24),
      });
      await service.run(at(0));
      expect(provider.checkConsent).not.toHaveBeenCalled();
      expect(store.rows[0]).toMatchObject({ state: 'consented', consentReused: true });
    });

    it('Intugine refusing a number we had as valid records the withdrawal and ends the row', async () => {
      const { service, store, provider, consents } = setup();
      provider.startTrip.mockResolvedValueOnce({
        intugineTripId: 'INT-X',
        consent: { status: 'denied', operator: 'airtel', suggestion: null },
      } as never);
      await service.run(at(0));
      expect(store.rows[0].state).toBe('unsupported');
      expect(provider.endTrip).toHaveBeenCalledWith('INT-X');
      expect(consents.records.get('9876543210')).toMatchObject({
        status: 'denied',
        withdrawnAt: at(0),
      });
    });
  });
  describe('trips created from the tracking screen', () => {
    it('asks a created SIM trip’s driver for consent and starts it under a tenant-unique invoice', async () => {
      const { service, store, provider } = setup({ load: null, created: {} });
      const result = await service.run(at(0));
      expect(result).toMatchObject({ consentRequested: 1, started: 1 });
      expect(provider.checkConsent).toHaveBeenCalledTimes(1);
      expect(provider.startTrip).toHaveBeenCalledWith(
        expect.objectContaining({
          tel: '9876543210',
          src: [18.78, 74.27],
          dest: [16.81, 81.53],
          invoice: 'TRP-0001-trip-1',
          loadId: 'trip-1',
        }),
      );
      expect(store.rows[0]).toMatchObject({ tripId: 'trip-1', state: 'active' });
    });

    it.each(['gps', 'driver_app', 'fastag'])(
      'leaves a created trip tracked by %s alone: no SMS, no Intugine trip',
      async (trackingSource) => {
        const { service, store, provider } = setup({ load: null, created: { trackingSource } });
        await service.run(at(0));
        expect(provider.checkConsent).not.toHaveBeenCalled();
        expect(store.rows).toHaveLength(0);
      },
    );

    it('starts from an inbound trip’s customer address', async () => {
      const { service, provider } = setup({
        load: null,
        created: {},
        createdPoints: {
          pickupLoadingPointId: null,
          pickupCustomerDeliveryPointId: 'd1',
          dropCustomerDeliveryPointId: null,
          dropLoadingPointId: 'p1',
        },
      });
      await service.run(at(0));
      expect(provider.startTrip).toHaveBeenCalledWith(
        expect.objectContaining({ src: [16.81, 81.53], dest: [18.78, 74.27] }),
      );
    });

    it('takes a typed address’s coordinates from the planned route', async () => {
      const { service, provider } = setup({
        load: null,
        created: {},
        createdPoints: { dropCustomerDeliveryPointId: null },
        createdEnds: {
          start: [18.7, 74.2],
          end: [12.97, 77.59],
          startName: 'Plant',
          endName: 'Bengaluru DC',
          endAddress: 'Whitefield, Bengaluru',
        },
      });
      await service.run(at(0));
      expect(provider.startTrip).toHaveBeenCalledWith(
        expect.objectContaining({
          src: [18.78, 74.27], // the picked master keeps its own coordinates
          dest: [12.97, 77.59],
          destName: 'Bengaluru DC',
          destAddress: 'Whitefield, Bengaluru',
        }),
      );
    });

    it('waits without starting while a typed address has no route yet', async () => {
      const { service, store, provider } = setup({
        load: null,
        created: {},
        createdPoints: { dropCustomerDeliveryPointId: null },
      });
      const result = await service.run(at(0));
      expect(result.skipped).toBe(1);
      expect(provider.startTrip).not.toHaveBeenCalled();
      expect(store.rows[0]).toMatchObject({ state: 'consented' });
    });

    it('ends the Intugine trip when the created trip is ended', async () => {
      const { service, store, provider, setCreated, cursorDelete } = setup({
        load: null,
        created: {},
      });
      await service.run(at(0));
      setCreated(makeCreatedTrip({ status: 'closed' }));
      const result = await service.run(at(30));
      expect(result.ended).toBe(1);
      expect(provider.endTrip).toHaveBeenCalledWith('INT-1');
      expect(store.rows[0]).toMatchObject({ state: 'ended', endReason: 'load_ended' });
      expect(cursorDelete).toHaveBeenCalledWith('INT-1');
    });
  });
});
