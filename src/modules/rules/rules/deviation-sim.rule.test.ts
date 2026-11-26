import { describe, expect, it } from 'vitest';
import { encodePolyline } from '../../routes/route-geometry';
import { TripRoutes } from '../../routes/trip-routes';
import type { TripRouteRow } from '../../routes/routes.repository';
import { deviationGpsRule } from './deviation-gps.rule';
import { deviationSimRule } from './deviation-sim.rule';
import { ctx, fix, M, run, T0, TRIP } from './rule-test-kit';

/** The same straight 111 km route due north from (28.6, 77.2) as route-rules.test.ts. */
const ROUTE_POINTS = Array.from({ length: 101 }, (_, i) => ({ lat: 28.6 + i * 0.01, lng: 77.2 }));
const row: TripRouteRow = {
  id: 'r1',
  trip_id: TRIP,
  version: 1,
  kind: 'planned',
  polyline: encodePolyline(ROUTE_POINTS),
  distance_m: 0,
  duration_s: null,
  promised_at: null,
  created_at: new Date(T0),
};
const ROUTES = new TripRoutes([row]);
const E = 1 / (111_195 * Math.cos((28.9 * Math.PI) / 180));
const at = (alongM: number, offM = 0) => ({ lat: 28.6 + alongM * M, lng: 77.2 + offM * E });

const C = { ...ctx('DEV-SIM'), route: ROUTES };
const MIN = 60;
/** A SIM ping `minutes` in, `alongM` along the route and `offM` east of it. */
const ping = (minutes: number, alongM: number, offM = 0, over = {}) =>
  fix(minutes * MIN, { speedKmh: null, source: 'sim', ...at(alongM, offM), ...over });

describe('DEV-SIM (rule sheet: 5 km corridor, 2 consecutive pings)', () => {
  it('runs on SIM fixes only; DEV-GPS never sees them', () => {
    expect(deviationSimRule.sources).toEqual(['sim']);
    expect(deviationGpsRule.sources).not.toContain('sim');
    expect(deviationSimRule.id).toBe('DEV-SIM');
  });

  it('two consecutive pings outside 5 km start a deviation (Warning, start = the first ping)', () => {
    const pings = [
      ping(0, 20_000),
      ping(20, 30_000),
      ping(40, 40_000, 6000),
      ping(60, 50_000, 6500),
    ];
    const { opened, raised } = run(deviationSimRule, pings, C);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ ruleId: 'DEV-SIM', source: 'sim', startedAt: ping(40, 0).t });
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      ruleId: 'DEV-SIM',
      severity: 'warning',
      occurredAt: ping(40, 0).t,
      audience: ['shipper', 'trip_ops', 'fleet_owner'],
    });
  });

  it('one ping outside is never a deviation (tower jump)', () => {
    const pings = [ping(0, 20_000), ping(20, 30_000, 9000), ping(40, 40_000), ping(60, 50_000)];
    expect(run(deviationSimRule, pings, C).raised).toHaveLength(0);
  });

  it('4 km off is inside the 5 km corridor: nothing', () => {
    const pings = [ping(0, 20_000, 4000), ping(20, 30_000, 4500), ping(40, 40_000, 4000)];
    expect(run(deviationSimRule, pings, C).opened).toHaveLength(0);
  });

  it('ignores pings within 5 km of origin or drop', () => {
    // (With the default 5 km corridor nothing near an end can be outside it, so narrow the corridor.)
    const narrow = { ...ctx('DEV-SIM', { corridorM: 1000 }), route: ROUTES };
    const nearDrop = [ping(0, 108_000, 2000), ping(20, 109_000, 2000), ping(40, 110_000, 2000)];
    expect(run(deviationSimRule, nearDrop, narrow).opened).toHaveLength(0);
    const midRoute = [ping(0, 50_000, 2000), ping(20, 51_000, 2000)];
    expect(run(deviationSimRule, midRoute, narrow).opened).toHaveLength(1);
  });

  it('never counts pings either side of a >60 min gap as consecutive', () => {
    const pings = [ping(0, 20_000, 7000), ping(90, 40_000, 7000)];
    expect(run(deviationSimRule, pings, C).opened).toHaveLength(0);
    // …but the next ping after the gap makes two in a row again.
    expect(run(deviationSimRule, [...pings, ping(110, 50_000, 7000)], C).opened).toHaveLength(1);
  });

  it('rejoins on 2 consecutive pings within 0.8 × corridor; one is not enough; tagged', () => {
    const out = [ping(0, 20_000), ping(20, 22_000, 7000), ping(40, 24_000, 7000)];
    const oneBack = run(deviationSimRule, [...out, ping(60, 26_000, 100)], C);
    expect(oneBack.effects.episodes.find((e) => e.op === 'close')).toBeUndefined();
    const flicker = run(
      deviationSimRule,
      [...out, ping(60, 26_000, 100), ping(80, 28_000, 7000), ping(100, 30_000, 100)],
      C,
    );
    expect(flicker.effects.episodes.find((e) => e.op === 'close')).toBeUndefined();
    const back = run(deviationSimRule, [...out, ping(60, 26_000, 100), ping(80, 28_000, 100)], C);
    const close = back.effects.episodes.find((e) => e.op === 'close');
    expect(close).toMatchObject({
      endedAt: ping(60, 0).t, // the first of the two pings back
      tags: ['detour'],
      metrics: { endReason: 'rejoined' },
    });
    expect(back.effects.alerts.find((a) => a.op === 'close')).toBeTruthy();
    // 4.1 km off is outside 0.8 × corridor (4 km): not back yet.
    const near = run(deviationSimRule, [...out, ping(60, 26_000, 4100), ping(80, 28_000, 4100)], C);
    expect(near.effects.episodes.find((e) => e.op === 'close')).toBeUndefined();
  });

  it('escalates to Critical when the truck halts off route (2 pings in a row within 2 km)', () => {
    const pings = [
      ping(0, 20_000),
      ping(20, 30_000, 7000),
      ping(40, 40_000, 7000),
      ping(60, 50_000, 7000),
      ping(80, 50_500, 7000),
    ];
    const { effects } = run(deviationSimRule, pings, C);
    expect(effects.alerts.filter((a) => a.op === 'escalate')).toHaveLength(1);
    expect(effects.alerts.find((a) => a.op === 'escalate')).toMatchObject({ severity: 'critical' });
    // Moving the whole way (pings 10 km apart): no escalation.
    const moving = run(
      deviationSimRule,
      [
        ping(0, 20_000),
        ping(20, 30_000, 7000),
        ping(40, 40_000, 7000),
        ping(60, 52_000, 7000),
        ping(80, 64_000, 7000),
      ],
      C,
    );
    expect(moving.effects.alerts.find((a) => a.op === 'escalate')).toBeUndefined();
  });

  it('a buffered start records the deviation but raises no alert; the next live ping does', () => {
    const buffered = [ping(0, 20_000), ping(20, 30_000, 7000), ping(40, 40_000, 7000)].map((f) => ({
      ...f,
      live: false,
    }));
    const first = run(deviationSimRule, buffered, C);
    expect(first.opened).toHaveLength(1);
    expect(first.raised).toHaveLength(0);
    const { raised } = run(deviationSimRule, [...buffered, ping(60, 50_000, 7000)], C);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ occurredAt: ping(20, 0).t });
  });

  it('only while the trip is in transit', () => {
    const pings = [ping(0, 20_000, 7000), ping(20, 30_000, 7000), ping(40, 40_000, 7000)].map(
      (f) => ({ ...f, inTransit: false }),
    );
    expect(run(deviationSimRule, pings, C).opened).toHaveLength(0);
  });

  it('LS_N_0028: 15+ km off for 45+ min and heading away from the drop → one notice', () => {
    // The deviation starts on the 2nd far ping; the 45 min of "far" run from the ping after it.
    const far = (minutes: number, alongM: number) => ping(minutes, alongM, 20_000);
    const away = [
      ping(0, 30_000),
      far(20, 40_000),
      far(40, 38_000),
      far(60, 36_000),
      far(80, 34_000),
      far(100, 32_000),
      far(120, 30_000),
    ];
    const sent = run(deviationSimRule, away, C).effects.notices;
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'trip.route_deviation', tripId: TRIP });
    // Heading towards the drop instead: no notice.
    const towards = [
      ping(0, 30_000),
      far(20, 40_000),
      far(40, 42_000),
      far(60, 44_000),
      far(80, 46_000),
      far(100, 48_000),
      far(120, 50_000),
    ];
    expect(run(deviationSimRule, towards, C).effects.notices).toHaveLength(0);
  });
});
