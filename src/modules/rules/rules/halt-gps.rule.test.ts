import { describe, expect, it } from 'vitest';
import { haltGpsRule } from './halt-gps.rule';
import { ctx, every, fix, north, run } from './rule-test-kit';

const C = ctx('HALT-GPS');
const parked = (fromS: number, durationS: number, wobble = 0) =>
  every(fromS, durationS, 15, (s) => ({ speedKmh: 0, ...north(s % 30 === 0 ? wobble : -wobble) }));
const driving = (fromS: number, durationS: number, startM: number) =>
  every(fromS, durationS, 15, (s) => ({ speedKmh: 50, ...north(startM + (s - fromS) * 14) }));

describe('HALT-GPS', () => {
  it('records and alerts once when a stop reaches 10 minutes (back-dated start)', () => {
    const { opened, raised, state } = run(haltGpsRule, parked(0, 660), C);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ op: 'open', startedAt: fix(0).t });
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ severity: 'warning', occurredAt: fix(0).t });
    expect(state.halting).toBe(true);
  });

  it('does not record a stop shorter than 10 minutes', () => {
    const { opened, raised } = run(haltGpsRule, [...parked(0, 540), ...driving(555, 300, 0)], C);
    expect(opened).toHaveLength(0);
    expect(raised).toHaveLength(0);
  });

  it('GPS jitter within the radius does not split the halt (distance from anchor, not fix to fix)', () => {
    const { opened, effects } = run(haltGpsRule, parked(0, 1200, 60), C); // ±60 m wobble
    expect(opened).toHaveLength(1);
    expect(effects.episodes.filter((e) => e.op === 'close')).toHaveLength(0);
  });

  it('needs BOTH low speed and the radius: slow but 200 m away is not a halted fix', () => {
    const fixes = [
      ...parked(0, 120),
      ...every(135, 600, 15, () => ({ speedKmh: 2, ...north(200) })),
    ];
    // 200 m out (within the 300 m end radius) keeps the halt alive but never re-anchors it;
    // the halt continues from 0 s, so 10 min is still reached.
    const { opened } = run(haltGpsRule, fixes, C);
    expect(opened[0]).toMatchObject({ startedAt: fix(0).t });
  });

  it('ends after 120 s at ≥ 10 km/h, back-dated to when movement started', () => {
    const fixes = [
      ...parked(0, 900),
      ...every(915, 150, 15, (s) => ({ speedKmh: 15, ...north((s - 915) * 0.5) })), // within radius
    ];
    const { effects } = run(haltGpsRule, fixes, C);
    const close = effects.episodes.find((e) => e.op === 'close');
    expect(close).toMatchObject({ endedAt: fix(915).t, metrics: { endReason: 'moving' } });
    expect(effects.alerts.find((a) => a.op === 'close')).toBeTruthy();
  });

  it('ends at once on a fix more than 300 m from the anchor', () => {
    const { effects } = run(
      haltGpsRule,
      [...parked(0, 900), fix(915, { speedKmh: 8, ...north(350) })],
      C,
    );
    expect(effects.episodes.find((e) => e.op === 'close')).toMatchObject({
      endedAt: fix(900).t,
      metrics: { endReason: 'left_anchor' },
    });
  });

  it('clubs a new halt within 5 min and 500 m into the previous one (one alert, duration includes the gap)', () => {
    const fixes = [
      ...parked(0, 900), // halt 1: 15 min, alerted
      ...every(915, 120, 15, (s) => ({ speedKmh: 20, ...north(100 + (s - 915)) })), // short move
      ...every(1050, 600, 15, () => ({ speedKmh: 0, ...north(400) })), // stops again 400 m away
    ];
    const { effects, raised } = run(haltGpsRule, fixes, C);
    expect(raised).toHaveLength(1);
    expect(effects.episodes.map((e) => e.op)).toEqual(['open', 'close', 'reopen']);
  });

  it('does not club when the new stop is far away', () => {
    const fixes = [
      ...parked(0, 900),
      ...driving(915, 300, 400),
      ...every(1230, 660, 15, () => ({ speedKmh: 0, ...north(5000) })),
    ];
    const { raised, opened } = run(haltGpsRule, fixes, C);
    expect(opened).toHaveLength(2);
    expect(raised).toHaveLength(2);
  });

  it('a data gap is "No data", not a halt — unless both sides are within 200 m', () => {
    // 20-min gap, then the truck reappears 5 km away: the halt ends at the last halted fix.
    const moved = run(
      haltGpsRule,
      [...parked(0, 300), fix(1500, { speedKmh: 0, ...north(5000) })],
      C,
    );
    expect(moved.opened).toHaveLength(0); // 5 min halt before the gap: never recorded
    // Same spot after the gap: the gap counts as halted time.
    const same = run(haltGpsRule, [...parked(0, 300), fix(1500, { speedKmh: 0, ...north(50) })], C);
    expect(same.opened).toHaveLength(1);
    expect(same.opened[0]).toMatchObject({ startedAt: fix(0).t });
  });

  it('buffered (not live) fixes record the halt but raise no alert', () => {
    const { opened, raised } = run(
      haltGpsRule,
      parked(0, 900).map((f) => ({ ...f, live: false })),
      C,
    );
    expect(opened).toHaveLength(1);
    expect(raised).toHaveLength(0);
  });

  it('is only evaluated while the trip is in transit', () => {
    const { opened } = run(
      haltGpsRule,
      parked(0, 900).map((f) => ({ ...f, inTransit: false })),
      C,
    );
    expect(opened).toHaveLength(0);
  });

  it('tags the halt with ignition when known', () => {
    const fixes = [
      ...parked(0, 900).map((f) => ({ ...f, ignition: false })),
      fix(915, { speedKmh: 8, ...north(400) }),
    ];
    const { effects } = run(haltGpsRule, fixes, C);
    expect(effects.episodes.find((e) => e.op === 'close')).toMatchObject({
      tags: ['ignition_off'],
    });
  });
});
