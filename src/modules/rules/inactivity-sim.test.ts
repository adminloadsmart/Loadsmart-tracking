import { describe, expect, it, vi } from 'vitest';
import type { SimTripRow } from '../ingest-sim';
import { InactivityMonitor } from './inactivity.monitor';
import { RULE_DEFAULTS } from './defaults';
import { lastSeenKey } from './rule-engine';

const VEHICLE = '22222222-2222-4222-8222-222222222222';
const TENANT = '11111111-1111-4111-8111-111111111111';
const TRIP = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const MIN = 60_000;

function setup(opts: { row: Partial<SimTripRow> | null; lastSeenMinAgo: number; status?: string }) {
  const removed: string[] = [];
  const applied: Array<{ episodes: any[]; alerts: any[] }> = [];
  const redis = {
    zrangebyscore: vi.fn(async (key: string) =>
      key === lastSeenKey('sim')
        ? [`${VEHICLE}|${TENANT}`, String(NOW - opts.lastSeenMinAgo * MIN)]
        : [],
    ),
    exists: vi.fn(async () => 0),
    get: vi.fn(async () => TRIP),
    hget: vi.fn(async () => opts.status ?? 'in_transit_unloading'),
    zrem: vi.fn(async (_k: string, member: string) => void removed.push(member)),
    hset: vi.fn(async () => 1),
  };
  const repository = {
    loadVehicleProfiles: vi.fn(async () => new Map([[VEHICLE, { bodyType: 'Tanker' }]])),
    applyEffects: vi.fn(async (batches: any[]) => {
      applied.push(...batches);
      return [];
    }),
  };
  const engine = {
    settings: vi.fn(async () => {
      const d = RULE_DEFAULTS['INACT-SIM']!;
      return new Map([['INACT-SIM', { enabled: d.enabled, params: d.params }]]);
    }),
  };
  const simTrips = {
    findLiveByTrip: vi.fn(async () =>
      opts.row ? ({ state: 'active', lastError: null, ...opts.row } as SimTripRow) : null,
    ),
  };
  const monitor = new InactivityMonitor(
    redis as any,
    repository as any,
    engine as any,
    { error: vi.fn() } as any,
    simTrips,
  );
  return { monitor, removed, applied };
}

describe('INACT-SIM', () => {
  it('defaults: 60 min, trip ops and shipper', () => {
    expect(RULE_DEFAULTS['INACT-SIM']).toMatchObject({
      enabled: true,
      audience: ['trip_ops', 'shipper'],
      params: { inactiveAfterMin: 60 },
    });
  });

  it('no SIM ping for 60+ min on an active SIM trip → Medium alert, back-dated, reason phone_unreachable', async () => {
    const { monitor, applied } = setup({ row: {}, lastSeenMinAgo: 70 });
    await monitor.tick(NOW);
    const [{ episodes, alerts }] = applied;
    expect(episodes[0]).toMatchObject({
      op: 'open',
      ruleId: 'INACT-SIM',
      source: 'sim',
      startedAt: NOW - 70 * MIN,
      tripId: TRIP,
    });
    expect(episodes[0].tags).toEqual(['no_data', 'phone_unreachable']);
    expect(alerts[0]).toMatchObject({
      op: 'raise',
      ruleId: 'INACT-SIM',
      severity: 'medium',
      audience: ['trip_ops', 'shipper'],
      title: 'No data from the SIM location for 60+ minutes',
      payload: { thresholdMin: 60, reason: 'phone_unreachable' },
    });
  });

  it('tags vendor_error when the last poll failed; a tanker is still 60 min (no tanker rule for SIM)', async () => {
    const { monitor, applied } = setup({ row: { lastError: 'HTTP 500' }, lastSeenMinAgo: 61 });
    await monitor.tick(NOW);
    expect(applied[0].alerts[0].payload.reason).toBe('vendor_error');
  });

  it('under 60 min: nothing', async () => {
    const { monitor, applied } = setup({ row: {}, lastSeenMinAgo: 45 });
    await monitor.tick(NOW);
    expect(applied).toHaveLength(0);
  });

  it('SIM not active (waiting for consent / paused): no alert, keep watching', async () => {
    for (const state of ['awaiting_consent', 'consented', 'paused'] as const) {
      const { monitor, applied, removed } = setup({ row: { state }, lastSeenMinAgo: 120 });
      await monitor.tick(NOW);
      expect(applied).toHaveLength(0);
      expect(removed).toHaveLength(0);
    }
  });

  it('no live SIM row (ended, handed back to GPS) or load past transit: no alert, stop watching', async () => {
    const ended = setup({ row: null, lastSeenMinAgo: 120 });
    await ended.monitor.tick(NOW);
    expect(ended.applied).toHaveLength(0);
    expect(ended.removed).toEqual([`${VEHICLE}|${TENANT}`]);
    const delivered = setup({ row: {}, lastSeenMinAgo: 120, status: 'delivered_ok' });
    await delivered.monitor.tick(NOW);
    expect(delivered.applied).toHaveLength(0);
    expect(delivered.removed).toHaveLength(1);
  });

  it('without a SIM trip lookup, INACT-SIM is not evaluated', async () => {
    const { monitor, applied } = setup({ row: {}, lastSeenMinAgo: 120 });
    const bare = new InactivityMonitor(
      (monitor as any).redis,
      (monitor as any).repository,
      (monitor as any).engine,
      { error: vi.fn() } as any,
    );
    await bare.tick(NOW);
    expect(applied).toHaveLength(0);
  });
});
