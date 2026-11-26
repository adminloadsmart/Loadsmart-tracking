import { describe, expect, it } from 'vitest';
import { haltGpsRule } from './halt-gps.rule';
import { haltSimRule } from './halt-sim.rule';
import { ctx, fix, north, run } from './rule-test-kit';

const C = ctx('HALT-SIM');
const MIN = 60;
/** A SIM ping: no speed (SIM has none), `metres` north of the base, `minutes` in. */
const ping = (minutes: number, metres = 0, over = {}) =>
  fix(minutes * MIN, { speedKmh: null, source: 'sim', ...north(metres), ...over });

describe('HALT-SIM (rule sheet: 2 km radius, 2 consecutive pings)', () => {
  it('runs on SIM fixes only; HALT-GPS never sees them', () => {
    expect(haltSimRule.sources).toEqual(['sim']);
    expect(haltGpsRule.sources).not.toContain('sim');
    expect(haltSimRule.id).toBe('HALT-SIM');
  });

  it('one ping is not a halt; the second in-radius ping confirms it (episode + alert, start = first ping)', () => {
    const one = run(haltSimRule, [ping(0)], C);
    expect(one.opened).toHaveLength(0);
    expect(one.raised).toHaveLength(0);
    const { opened, raised } = run(haltSimRule, [ping(0), ping(20, 200)], C);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ startedAt: ping(0).t, source: 'sim' });
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      ruleId: 'HALT-SIM',
      severity: 'warning',
      audience: ['shipper', 'trip_ops'],
      occurredAt: ping(0).t,
      title: 'Vehicle halted for 20+ minutes',
    });
  });

  it('the anchor is the first ping; the halt is raised once however long it lasts', () => {
    const { opened, raised } = run(
      haltSimRule,
      [ping(0), ping(20, 600), ping(40, -500), ping(60, 700), ping(80, -400)],
      C,
    );
    expect(opened).toHaveLength(1);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ payload: { anchor: { lat: ping(0).lat } } });
  });

  it('tower wander up to 2 km stays one halt; a ping beyond 2 km ends it', () => {
    const wander = run(haltSimRule, [ping(0), ping(20, 1900), ping(40, -1900), ping(60, 1500)], C);
    expect(wander.opened).toHaveLength(1);
    expect(wander.effects.episodes.filter((e) => e.op === 'close')).toHaveLength(0);
    const left = run(haltSimRule, [ping(0), ping(20, 100), ping(40, 2100)], C);
    expect(left.effects.episodes.find((e) => e.op === 'close')).toMatchObject({
      endedAt: ping(20).t, // the last in-radius ping
      metrics: { endReason: 'left_anchor' },
    });
    expect(left.effects.alerts.find((a) => a.op === 'close')).toBeTruthy();
  });

  it('a truck driving between pings (km apart) is never halted', () => {
    const pings = [ping(0), ping(20, 15_000), ping(40, 30_000), ping(60, 45_000), ping(80, 60_000)];
    const { opened, raised } = run(haltSimRule, pings, C);
    expect(opened).toHaveLength(0);
    expect(raised).toHaveLength(0);
  });

  it('a ping outside the radius restarts the cluster: it is the new anchor', () => {
    const { opened, raised } = run(haltSimRule, [ping(0), ping(20, 5000), ping(40, 5100)], C);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ startedAt: ping(20).t });
    expect(raised).toHaveLength(1);
  });

  it('no clubbing: a new halt after a move is a new episode and a new alert', () => {
    const { opened, raised } = run(
      haltSimRule,
      [ping(0), ping(20), ping(40, 5000), ping(60, 5100)],
      C,
    );
    expect(opened).toHaveLength(2);
    expect(raised).toHaveLength(2);
  });

  it('silence over 60 min is "No data" unless the pings either side are in the radius', () => {
    // 90 min of silence, same spot: the halt simply continues (one halt).
    const same = run(haltSimRule, [ping(0), ping(20), ping(110)], C);
    expect(same.opened).toHaveLength(1);
    expect(same.effects.episodes.filter((e) => e.op === 'close')).toHaveLength(0);
    // 90 min of silence and the truck is 5 km away: the halt ended at the last ping seen there.
    const moved = run(haltSimRule, [ping(0), ping(20), ping(110, 5000)], C);
    expect(moved.effects.episodes.find((e) => e.op === 'close')).toMatchObject({
      endedAt: ping(20).t,
      metrics: { endReason: 'data_gap' },
    });
    // A gap of 40 min (under 60) that ends elsewhere is an ordinary exit.
    const short = run(haltSimRule, [ping(0), ping(20), ping(60, 5000)], C);
    expect(short.effects.episodes.find((e) => e.op === 'close')).toMatchObject({
      metrics: { endReason: 'left_anchor' },
    });
  });

  it('a buffered (not live) ping records the halt but raises no alert; the next live ping does', () => {
    const buffered = [ping(0), ping(20)].map((f) => ({ ...f, live: false }));
    const first = run(haltSimRule, buffered, C);
    expect(first.opened).toHaveLength(1);
    expect(first.raised).toHaveLength(0);
    const { raised } = run(haltSimRule, [...buffered, ping(40)], C);
    expect(raised).toHaveLength(1);
  });

  it('only while the trip is in transit', () => {
    const pings = [ping(0), ping(20), ping(40), ping(60)].map((f) => ({ ...f, inTransit: false }));
    expect(run(haltSimRule, pings, C).opened).toHaveLength(0);
  });

  it('leaving transit ends a confirmed halt', () => {
    const { effects } = run(haltSimRule, [ping(0), ping(20), ping(40, 0, { inTransit: false })], C);
    expect(effects.episodes.find((e) => e.op === 'close')).toMatchObject({
      metrics: { endReason: 'not_in_transit' },
    });
  });
});
