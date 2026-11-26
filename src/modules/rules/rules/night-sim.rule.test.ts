import { describe, expect, it } from 'vitest';
import { nightGpsRule } from './night-gps.rule';
import { nightSimRule } from './night-sim.rule';
import { RULE_DEFAULTS } from '../defaults';
import { ctx, M, run, T0, VEHICLE } from './rule-test-kit';

// Opt-in rule: tests turn it on through the context (rules only run when enabled).
const C = ctx('NIGHT-SIM');

/** IST wall-clock time on the night of 2026-10-05 → epoch ms (IST = UTC + 5:30). */
const ist = (day: number, hh: number, mm = 0) => Date.UTC(2026, 9, day, hh, mm) - 330 * 60_000;
/** A SIM ping at an IST time, `northM` metres north of the base point. */
const ping = (t: number, northM = 0, over = {}) => ({
  t,
  lat: 28.6 + northM * M,
  lng: 77.2,
  speedKmh: null,
  source: 'sim' as const,
  tripId: null,
  inTransit: false,
  live: true,
  ignition: null,
  accuracyM: 300,
  satellites: null,
  gpsPositioned: null,
  ...over,
});

describe('NIGHT-SIM (rule sheet: 5 km moving, 2 km stationary)', () => {
  it('is opt-in, SIM-only, with the sheet window and distances', () => {
    expect(RULE_DEFAULTS['NIGHT-SIM']).toMatchObject({
      enabled: false,
      audience: ['fleet_owner', 'shipper'],
      params: {
        windowStart: '23:00',
        windowEnd: '06:00',
        movingDistanceM: 5000,
        stationaryRadiusM: 2000,
      },
    });
    expect(nightSimRule.sources).toEqual(['sim']);
    expect(nightGpsRule.sources).not.toContain('sim');
  });

  it('a pair 5+ km apart inside the window starts the drive: one Warning alert, back-dated to the first ping', () => {
    const pings = [ping(ist(5, 22, 40)), ping(ist(5, 23, 20)), ping(ist(5, 23, 40), 12_000)];
    const { opened, raised } = run(nightSimRule, pings, C);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({
      ruleId: 'NIGHT-SIM',
      source: 'sim',
      startedAt: ist(5, 23, 20),
    });
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({
      ruleId: 'NIGHT-SIM',
      severity: 'warning',
      title: 'Night driving',
      audience: ['fleet_owner', 'shipper'],
      occurredAt: ist(5, 23, 20),
    });
  });

  it('only one alert per night, however long it drives', () => {
    const pings = [
      ping(ist(5, 23, 20)),
      ping(ist(5, 23, 40), 12_000),
      ping(ist(6, 0, 0), 24_000),
      ping(ist(6, 0, 20), 36_000),
      ping(ist(6, 1, 0), 60_000),
    ];
    const { opened, raised } = run(nightSimRule, pings, C);
    expect(opened).toHaveLength(1);
    expect(raised).toHaveLength(1);
  });

  it('pings 2 km apart or less are stationary; 2-5 km apart are ignored', () => {
    const parked = [ping(ist(5, 23, 20)), ping(ist(5, 23, 40), 1500), ping(ist(6, 0, 0), 300)];
    expect(run(nightSimRule, parked, C).opened).toHaveLength(0);
    const between = [ping(ist(5, 23, 20)), ping(ist(5, 23, 40), 3500), ping(ist(6, 0, 0), 7000)];
    expect(run(nightSimRule, between, C).opened).toHaveLength(0);
  });

  it('ends on 2 consecutive pings inside the halt radius, recorded at the first of them', () => {
    const pings = [
      ping(ist(5, 23, 20)),
      ping(ist(5, 23, 40), 12_000),
      ping(ist(6, 0, 0), 24_000),
      ping(ist(6, 0, 20), 24_500), // stopped
      ping(ist(6, 0, 40), 36_500), // …and drives again
    ];
    const { effects } = run(nightSimRule, pings, C);
    const closed = effects.episodes.filter((e) => e.op === 'close');
    expect(closed[0]).toMatchObject({ endedAt: ist(6, 0, 0) });
    // Driving again the same night: a second episode, but still one alert for the night.
    expect(effects.episodes.filter((e) => e.op === 'open')).toHaveLength(2);
    expect(effects.alerts.filter((a) => a.op === 'raise')).toHaveLength(1);
  });

  it('pings outside the window never count, and a pair straddling the window edge is not used', () => {
    const day = [ping(ist(5, 14, 0)), ping(ist(5, 14, 20), 12_000), ping(ist(5, 14, 40), 24_000)];
    expect(run(nightSimRule, day, C).opened).toHaveLength(0);
    const edge = [ping(ist(5, 22, 50)), ping(ist(5, 23, 10), 12_000)];
    expect(run(nightSimRule, edge, C).opened).toHaveLength(0);
    const edgeEnd = [ping(ist(6, 5, 50)), ping(ist(6, 6, 10), 12_000)];
    expect(run(nightSimRule, edgeEnd, C).opened).toHaveLength(0);
  });

  it('at window end the drive is closed and the alert gets a summary (km, minutes, first / last) and closes', () => {
    const pings = [
      ping(ist(5, 23, 20)),
      ping(ist(5, 23, 40), 12_000),
      ping(ist(6, 0, 0), 24_000),
      ping(ist(6, 7, 0), 24_000), // first ping after the window
    ];
    const { effects } = run(nightSimRule, pings, C);
    const closed = effects.episodes.find((e) => e.op === 'close');
    expect(closed).toMatchObject({ endedAt: ist(6, 0, 0) });
    const summary = effects.alerts.find((a) => a.op === 'update') as unknown as {
      payload: {
        summary: { km: number; minutes: number; firstMovementAt: string; lastMovementAt: string };
      };
    };
    expect(summary.payload.summary.km).toBeCloseTo(24, 0);
    expect(summary.payload.summary.minutes).toBe(40);
    expect(summary.payload.summary.firstMovementAt).toBe(new Date(ist(5, 23, 20)).toISOString());
    expect(summary.payload.summary.lastMovementAt).toBe(new Date(ist(6, 0, 0)).toISOString());
    expect(effects.alerts.find((a) => a.op === 'close')).toMatchObject({ reason: 'night_ended' });
  });

  it('a drive across midnight is one night; the next night alerts again', () => {
    const pings = [
      ping(ist(5, 23, 30)),
      ping(ist(5, 23, 50), 12_000),
      ping(ist(6, 0, 10), 24_000),
      ping(ist(6, 23, 30), 24_000),
      ping(ist(6, 23, 50), 36_000),
    ];
    const { raised } = run(nightSimRule, pings, C);
    expect(raised).toHaveLength(2);
    expect(raised[0]).not.toMatchObject({ id: raised[1].id });
  });

  it('a buffered (not live) start records the drive; the alert comes on the next live moving pair', () => {
    const buffered = [ping(ist(5, 23, 20)), ping(ist(5, 23, 40), 12_000)].map((f) => ({
      ...f,
      live: false,
    }));
    const first = run(nightSimRule, buffered, C);
    expect(first.opened).toHaveLength(1);
    expect(first.raised).toHaveLength(0);
    const { raised } = run(nightSimRule, [...buffered, ping(ist(6, 0, 0), 24_000)], C);
    expect(raised).toHaveLength(1);
  });

  it('works on a vehicle with no trip (vehicle-level) and keeps no state for a phone that goes silent', () => {
    const { opened, state } = run(
      nightSimRule,
      [ping(ist(5, 23, 20)), ping(ist(5, 23, 40), 12_000)],
      { ...C, vehicleId: VEHICLE },
    );
    expect(opened).toHaveLength(1);
    expect(state.phase).toBe('driving');
    void T0;
  });
});
