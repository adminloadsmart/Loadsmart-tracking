import { describe, expect, it, vi } from 'vitest';
import { InactivityMonitor } from './inactivity.monitor';
import { RULE_DEFAULTS } from './defaults';
import { inactiveFlagKey, lastSeenKey } from './rule-engine';

const TENANT = '11111111-1111-4111-8111-111111111111';
const TRIP = '33333333-3333-4333-8333-333333333333';
const NOW = Date.parse('2026-11-26T12:00:00.000Z');
const MIN = 60_000;

const vehicle = (n: number) => `22222222-2222-4222-8222-${String(n).padStart(12, '0')}`;

/** A Roadcast last-seen set with real ZRANGEBYSCORE / flag / unwatch semantics. */
function setup(members: Array<{ vehicleId: string; lastSeenMinAgo: number; flagged?: boolean }>) {
  const zset = new Map(
    members.map((m) => [`${m.vehicleId}|${TENANT}`, NOW - m.lastSeenMinAgo * MIN]),
  );
  const flags = new Set(
    members.filter((m) => m.flagged).map((m) => inactiveFlagKey(m.vehicleId, 'roadcast')),
  );
  const applied: Array<{ vehicleId: string; alerts: any[] }> = [];
  const redis = {
    zrangebyscore: vi.fn(async (key: string, _min: string, max: number, ...rest: unknown[]) => {
      if (key !== lastSeenKey('roadcast')) return [];
      const limit = Number(rest[rest.indexOf('LIMIT') + 2]);
      return [...zset]
        .filter(([, score]) => score <= max)
        .sort((a, b) => a[1] - b[1])
        .slice(0, limit)
        .flatMap(([member, score]) => [member, String(score)]);
    }),
    exists: vi.fn(async (key: string) => (flags.has(key) ? 1 : 0)),
    get: vi.fn(async () => TRIP),
    hget: vi.fn(async () => 'in_transit_unloading'),
    zrem: vi.fn(async (_key: string, member: string) => Number(zset.delete(member))),
    hset: vi.fn(async (key: string) => {
      flags.add(key);
      return 1;
    }),
    eval: vi.fn(async (_script: string, _n: number, _key: string, member: string, max: number) => {
      const score = zset.get(member);
      return score !== undefined && score <= Number(max) ? Number(zset.delete(member)) : 0;
    }),
  };
  const repository = {
    loadVehicleProfiles: vi.fn(async () => new Map()),
    applyEffects: vi.fn(async (batches: any[]) => {
      applied.push(...batches);
      return [];
    }),
  };
  const engine = {
    settings: vi.fn(async () => {
      const d = RULE_DEFAULTS['INACT-GPS']!;
      return new Map([['INACT-GPS', { enabled: d.enabled, params: d.params }]]);
    }),
  };
  const monitor = new InactivityMonitor(
    redis as any,
    repository as any,
    engine as any,
    { error: vi.fn() } as any,
  );
  return { monitor, applied, zset, redis };
}

describe('InactivityMonitor scan', () => {
  it('an alerted vehicle leaves the scan set, so the next tick does not re-check it', async () => {
    const { monitor, applied, zset } = setup([{ vehicleId: vehicle(1), lastSeenMinAgo: 70 }]);
    await monitor.tick(NOW);
    expect(applied.map((a) => a.vehicleId)).toEqual([vehicle(1)]);
    expect(zset.size).toBe(0);
  });

  it('more already-alerted vehicles than SCAN_LIMIT no longer starve a newly silent one', async () => {
    const flagged = Array.from({ length: 2000 }, (_, i) => ({
      vehicleId: vehicle(i + 1),
      lastSeenMinAgo: 600 - i * 0.1, // all older than the new one
      flagged: true,
    }));
    const fresh = { vehicleId: vehicle(9999), lastSeenMinAgo: 70 };
    const { monitor, applied } = setup([...flagged, fresh]);

    await monitor.tick(NOW); // first tick drains the flagged backlog out of the set
    await monitor.tick(NOW);
    expect(applied.map((a) => a.vehicleId)).toEqual([fresh.vehicleId]);
  });

  it('silence first seen more than a day late is not alerted (no burst after a backlog)', async () => {
    const { monitor, applied, zset } = setup([{ vehicleId: vehicle(1), lastSeenMinAgo: 25 * 60 }]);
    await monitor.tick(NOW);
    expect(applied).toHaveLength(0);
    expect(zset.size).toBe(0);
  });

  it('a packet that arrived after the scan read the member keeps it watched', async () => {
    const { monitor, zset, redis } = setup([
      { vehicleId: vehicle(1), lastSeenMinAgo: 120, flagged: true },
    ]);
    const member = `${vehicle(1)}|${TENANT}`;
    redis.exists.mockImplementationOnce(async () => {
      zset.set(member, NOW); // the processor's ZADD GT lands between the scan and the unwatch
      return 1;
    });
    await monitor.tick(NOW);
    expect(zset.get(member)).toBe(NOW);
  });
});
