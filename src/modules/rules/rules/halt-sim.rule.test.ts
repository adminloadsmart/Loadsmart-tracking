import { describe, expect, it } from 'vitest';
import { haltGpsRule, haltSimRule } from './halt-gps.rule';
import { ctx, fix, north, run } from './rule-test-kit';

const C = ctx('HALT-SIM');
const MIN = 60;
/** A SIM ping: no speed (SIM has none), `metres` north of the base, `minutes` in. */
const ping = (minutes: number, metres = 0, over = {}) =>
  fix(minutes * MIN, { speedKmh: null, source: 'sim', ...north(metres), ...over });

describe('HALT-SIM', () => {
  it('runs on SIM fixes only; HALT-GPS never sees them', () => {
    expect(haltSimRule.sources).toEqual(['sim']);
    expect(haltGpsRule.sources).not.toContain('sim');
    expect(haltSimRule.id).toBe('HALT-SIM');
  });

  it('a truck parked across 20-minute pings is recorded, then alerted once it passes 30 minutes', () => {
    // First ping has no earlier one to imply a speed from, so the halt starts at the second.
    const pings = [ping(0), ping(20, 200), ping(40, -300), ping(60, 150)];
    const early = run(haltSimRule, pings.slice(0, 3), C);
    expect(early.opened).toHaveLength(1); // 20 min since the start: recorded
    expect(early.raised).toHaveLength(0); // …but not 30 yet
    const { opened, raised } = run(haltSimRule, pings, C);
    expect(opened[0]).toMatchObject({ startedAt: ping(20).t, source: 'sim' });
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      ruleId: 'HALT-SIM',
      severity: 'warning',
      occurredAt: ping(20).t,
      title: 'Vehicle halted for 30+ minutes',
    });
  });

  it('cell-tower jitter of a few hundred metres does not split or end the halt', () => {
    const pings = [ping(0), ping(20, 600), ping(40, -500), ping(60, 700), ping(80, -400)];
    const { opened, raised, effects } = run(haltSimRule, pings, C);
    expect(opened).toHaveLength(1);
    expect(raised).toHaveLength(1);
    expect(effects.episodes.filter((e) => e.op === 'close')).toHaveLength(0);
  });

  it('a truck driving between pings (km apart) is never halted', () => {
    const pings = [ping(0), ping(20, 15_000), ping(40, 30_000), ping(60, 45_000), ping(80, 60_000)];
    const { opened, raised } = run(haltSimRule, pings, C);
    expect(opened).toHaveLength(0);
    expect(raised).toHaveLength(0);
  });

  it('ends at the first ping that has moved on (back-dated to the last halted ping), and closes the alert', () => {
    const pings = [ping(0), ping(20), ping(40), ping(60), ping(80, 20_000)];
    const { effects } = run(haltSimRule, pings, C);
    expect(effects.episodes.find((e) => e.op === 'close')).toMatchObject({
      endedAt: ping(60).t,
      metrics: { endReason: 'left_anchor' },
    });
    expect(effects.alerts.find((a) => a.op === 'close')).toBeTruthy();
  });

  it('a missed poll or two is not "no data", but a long silence that ends elsewhere is', () => {
    // 40 min between pings (two polls missed), same spot: still one halt.
    const same = run(haltSimRule, [ping(0), ping(20), ping(60), ping(100), ping(140)], C);
    expect(same.opened).toHaveLength(1);
    // 90 min of silence and the truck is 5 km away: the halt ended at the last ping.
    const moved = run(haltSimRule, [ping(0), ping(20), ping(40), ping(130, 5000)], C);
    expect(moved.effects.episodes.find((e) => e.op === 'close')).toMatchObject({
      metrics: { endReason: 'data_gap' },
    });
  });

  it('a buffered (not live) SIM ping records the halt but raises no alert', () => {
    const pings = [ping(0), ping(20), ping(40), ping(60)].map((f) => ({ ...f, live: false }));
    const { opened, raised } = run(haltSimRule, pings, C);
    expect(opened).toHaveLength(1);
    expect(raised).toHaveLength(0);
  });

  it('only while the trip is in transit', () => {
    const pings = [ping(0), ping(20), ping(40), ping(60)].map((f) => ({ ...f, inTransit: false }));
    expect(run(haltSimRule, pings, C).opened).toHaveLength(0);
  });
});
