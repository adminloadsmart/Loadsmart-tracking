import { describe, expect, it } from 'vitest';
import { nightGpsRule } from './night-gps.rule';
import { overspeedGpsRule, speedLimitKmh } from './overspeed-gps.rule';
import { ctx, every, fix, north, run } from './rule-test-kit';

const OVER = ctx('OVER-GPS');
/** Cruising at `speed` from `fromS` for `durationS`, a fix every 10 s, moving north. */
const cruise = (fromS: number, durationS: number, speed: number, offsetM = 0) =>
  every(fromS, durationS, 10, (s) => ({
    speedKmh: speed,
    ...north(offsetM + (s - fromS) * (speed / 3.6)),
  }));

describe('OVER-GPS', () => {
  it('limit is the lowest of vehicle type and customer limits', () => {
    expect(speedLimitKmh(OVER.params, 'Open body')).toBe(80);
    expect(speedLimitKmh(OVER.params, 'Tanker')).toBe(60);
    expect(speedLimitKmh(ctx('OVER-GPS', { customerLimitKmh: 70 }).params, null)).toBe(70);
  });

  it('starts after > limit+3% held 20 s (back-dated), one alert, closes with metrics', () => {
    const fixes = [...cruise(0, 60, 70), ...cruise(70, 60, 90, 1200), ...cruise(140, 40, 60, 2800)];
    const { effects, raised, opened } = run(overspeedGpsRule, fixes, OVER);
    expect(opened).toHaveLength(1);
    expect(opened[0]).toMatchObject({ startedAt: fix(70).t });
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ severity: 'warning' });
    const close = effects.episodes.find((e) => e.op === 'close');
    expect(close).toMatchObject({
      endedAt: fix(140).t,
      metrics: { maxSpeedKmh: 90, avgSpeedKmh: 90, limitKmh: 80 },
    });
  });

  it('ignores a short burst and hovering inside the hysteresis band', () => {
    const burst = run(overspeedGpsRule, [...cruise(0, 30, 70), ...cruise(40, 10, 90, 500)], OVER);
    expect(burst.opened).toHaveLength(0);
    const hover = run(overspeedGpsRule, cruise(0, 600, 81), OVER); // 81 < 82.4 start threshold
    expect(hover.opened).toHaveLength(0);
  });

  it('does not end while speed stays between the end and start thresholds', () => {
    const fixes = [...cruise(0, 30, 90), ...cruise(40, 300, 79, 800)]; // 79 > 77.6 end threshold
    const { effects } = run(overspeedGpsRule, fixes, OVER);
    expect(effects.episodes.filter((e) => e.op === 'close')).toHaveLength(0);
  });

  it('merges episodes closer than 60 s apart', () => {
    const fixes = [
      ...cruise(0, 40, 90),
      ...cruise(50, 30, 70, 1000), // below for 30 s → episode closes
      ...cruise(90, 40, 90, 1700), // above again 30 s later → merged
    ];
    const { effects, raised } = run(overspeedGpsRule, fixes, OVER);
    expect(raised).toHaveLength(1);
    expect(effects.episodes.map((e) => e.op)).toEqual(['open', 'close', 'reopen']);
  });

  it('counts the fixes before the 20 s hold in the episode (start, max, distance) and its severity', () => {
    const fixes = [
      fix(0, { speedKmh: 100, ...north(0) }),
      fix(10, { speedKmh: 90, ...north(250) }),
      fix(20, { speedKmh: 88, ...north(500) }), // confirms the episode (held 20 s)
      ...cruise(30, 30, 60, 750),
    ];
    const { effects, raised } = run(overspeedGpsRule, fixes, OVER);
    expect(raised[0]).toMatchObject({ severity: 'critical' }); // 100 ≥ 80 + 20
    const close = effects.episodes.find((e) => e.op === 'close') as {
      metrics: { maxSpeedKmh: number; distanceM: number; start: { lat: number } };
    };
    expect(close.metrics.maxSpeedKmh).toBe(100);
    expect(close.metrics.start.lat).toBeCloseTo(north(0).lat, 6);
    expect(close.metrics.distanceM).toBeGreaterThanOrEqual(500);
  });

  it('escalates to Critical at limit + 20 km/h', () => {
    const { effects } = run(
      overspeedGpsRule,
      [...cruise(0, 40, 90), ...cruise(50, 20, 101, 1000)],
      OVER,
    );
    expect(effects.alerts.find((a) => a.op === 'escalate')).toMatchObject({ severity: 'critical' });
  });

  it('rejects implausible acceleration and invalid device fixes', () => {
    const spike = [
      ...cruise(0, 30, 50),
      fix(40, { speedKmh: 140, ...north(600) }),
      ...cruise(50, 30, 50, 700),
    ];
    expect(run(overspeedGpsRule, spike, OVER).opened).toHaveLength(0);
    const noFix = cruise(0, 60, 95).map((f) => ({
      ...f,
      source: 'roadcast' as const,
      gpsPositioned: false,
    }));
    expect(run(overspeedGpsRule, noFix, OVER).opened).toHaveLength(0);
    const fewSats = cruise(0, 60, 95).map((f) => ({
      ...f,
      source: 'roadcast' as const,
      satellites: 4,
    }));
    expect(run(overspeedGpsRule, fewSats, OVER).opened).toHaveLength(0);
  });
});

// 22:50 IST = 17:20 UTC. T0 in the kit is 10:00 UTC, so offset the fixes from there.
const IST_2250 = (Date.parse('2026-10-05T17:20:00Z') - Date.parse('2026-10-05T10:00:00Z')) / 1000;
const NIGHT = ctx('NIGHT-GPS');

describe('NIGHT-GPS', () => {
  it('is opt-in (disabled by default)', async () => {
    const { RULE_DEFAULTS } = await import('../defaults');
    expect(RULE_DEFAULTS['NIGHT-GPS']!.enabled).toBe(false);
  });

  it('flags a truck already moving when the window opens, once per night, with a summary', () => {
    // Driving from 22:50 to 00:30 IST, then parked until 06:10.
    const drive = cruise(IST_2250, 100 * 60, 50);
    const parked = every(IST_2250 + 101 * 60, 7 * 3600, 300, () => ({
      speedKmh: 0,
      ...north(83_000),
    }));
    const { raised, effects } = run(nightGpsRule, [...drive, ...parked], NIGHT);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ occurredAt: fix(IST_2250 + 600).t }); // first in-window fix (23:00)
    const summary = effects.alerts.find((a) => a.op === 'update');
    expect(summary).toMatchObject({ payload: { summary: { minutes: 90 } } });
    expect((summary as { payload: { summary: { km: number } } }).payload.summary.km).toBeCloseTo(
      75,
      0,
    );
    expect(effects.alerts.at(-1)).toMatchObject({ op: 'close', reason: 'night_ended' });
  });

  it('a second drive the same night is another episode but no second alert; midnight is one night', () => {
    const fixes = [
      ...cruise(IST_2250 + 15 * 60, 20 * 60, 50), // 23:05–23:25
      ...every(IST_2250 + 36 * 60, 15 * 60, 60, () => ({ speedKmh: 0, ...north(17_000) })), // stop 15 min
      ...cruise(IST_2250 + 80 * 60, 20 * 60, 50, 17_000), // 00:10–00:30 (after midnight)
    ];
    const { raised, opened } = run(nightGpsRule, fixes, NIGHT);
    expect(opened).toHaveLength(2);
    expect(raised).toHaveLength(1);
  });

  it('GPS drift while parked never counts (needs speed AND distance)', () => {
    const drift = every(IST_2250 + 600, 3600, 15, (s) => ({ speedKmh: 0, ...north((s % 30) * 3) }));
    expect(run(nightGpsRule, drift, NIGHT).opened).toHaveLength(0);
  });

  it('a truck creeping at 5-10 km/h after a stop is not stationary', () => {
    const fixes = [
      ...cruise(IST_2250 + 15 * 60, 10 * 60, 50), // 23:05–23:15 driving
      fix(IST_2250 + 26 * 60, { speedKmh: 0, ...north(8400) }), // brief stop
      ...every(IST_2250 + 27 * 60, 15 * 60, 60, (s) => ({
        speedKmh: 7,
        ...north(8400 + (s - (IST_2250 + 27 * 60)) * 2),
      })), // crawling 15 min
    ];
    const closes = (extra: ReturnType<typeof fix>[]) =>
      run(nightGpsRule, [...fixes, ...extra], NIGHT).effects.episodes.filter(
        (e) => e.op === 'close',
      );
    const stopAt = IST_2250 + 43 * 60;

    // Stopping after the crawl starts a fresh 10-minute stationary timer…
    expect(closes([fix(stopAt, { speedKmh: 0, ...north(10_300) })])).toHaveLength(0);
    // …and the episode ends when that stop began, not at the brief stop before the crawl.
    const stopped = every(stopAt, 10 * 60, 60, () => ({ speedKmh: 0, ...north(10_300) }));
    expect(closes(stopped)).toEqual([expect.objectContaining({ endedAt: fix(stopAt).t })]);
  });

  it('starts on 2 km moved even before 5 minutes', () => {
    const fast = cruise(IST_2250 + 600, 200, 60); // 60 km/h → 2 km in 120 s
    expect(run(nightGpsRule, fast, NIGHT).opened).toHaveLength(1);
  });

  it('does nothing outside the window', () => {
    expect(run(nightGpsRule, cruise(0, 3600, 60), NIGHT).opened).toHaveLength(0); // 15:30 IST
  });
});
