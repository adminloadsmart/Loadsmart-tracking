import { describe, expect, it } from 'vitest';
import { encodePolyline, RouteGeometry } from '../../routes/route-geometry';
import { TripRoutes } from '../../routes/trip-routes';
import type { TripRouteRow } from '../../routes/routes.repository';
import { alreadyLateSeverity, evaluateDelay, promisedTime } from '../delay';
import { deviationGpsRule } from './deviation-gps.rule';
import { progressGpsRule } from './progress-gps.rule';
import { ctx, every, fix, M, run, T0, TRIP } from './rule-test-kit';

/** A straight 111 km route due north from (28.6, 77.2). */
const ROUTE_POINTS = Array.from({ length: 101 }, (_, i) => ({ lat: 28.6 + i * 0.01, lng: 77.2 }));
const row = (
  version: number,
  points = ROUTE_POINTS,
  kind: TripRouteRow['kind'] = 'planned',
): TripRouteRow => ({
  id: `r${version}`,
  trip_id: TRIP,
  version,
  kind,
  polyline: encodePolyline(points),
  distance_m: 0,
  duration_s: null,
  promised_at: null,
  created_at: new Date(T0),
});
const ROUTES = new TripRoutes([row(1)]);
/** ~1 m of longitude at this latitude, in degrees. */
const E = 1 / (111_195 * Math.cos((28.9 * Math.PI) / 180));
/** A fix `alongM` along the route and `offM` east of it. */
const at = (alongM: number, offM = 0) => ({ lat: 28.6 + alongM * M, lng: 77.2 + offM * E });

describe('RouteGeometry', () => {
  it('measures length and projects points (distance to route, distance along it)', () => {
    const g = RouteGeometry.fromPolyline(encodePolyline(ROUTE_POINTS));
    expect(g.lengthM / 1000).toBeCloseTo(111.2, 0);
    const p = g.project(at(50_000, 2000));
    expect(p.distanceM).toBeCloseTo(2000, -1);
    expect(p.alongM).toBeCloseTo(50_000, -1);
  });

  it('round-trips the Google polyline encoding', () => {
    const points = [
      { lat: 38.5, lng: -120.2 },
      { lat: 40.7, lng: -120.95 },
      { lat: 43.252, lng: -126.453 },
    ];
    expect(encodePolyline(points)).toBe('_p~iF~ps|U_ulLnnqC_mqNvxq`@'); // Google's documented example
  });
});

const DEV = { ...ctx('DEV-GPS'), route: ROUTES };
/** Driving at ~60 km/h (250 m per 15 s) from `startAlong`, `off(i)` metres east of the route. */
const drive = (
  fromS: number,
  count: number,
  startAlong: number,
  off: (i: number) => number,
  speed = 60,
) =>
  Array.from({ length: count }, (_, i) =>
    fix(fromS + i * 15, { speedKmh: speed, ...at(startAlong + i * 250, off(i)) }),
  );

describe('DEV-GPS', () => {
  it('starts after 5 km driven outside the 1 km corridor; rejoin is tagged', () => {
    const fixes = [
      ...drive(0, 40, 10_000, () => 0), // on route
      ...drive(600, 30, 20_000, () => 1500), // 7.5 km driven 1.5 km off route
      ...drive(1050, 20, 27_500, () => 200), // back on route for 5 min
    ];
    const { raised, effects } = run(deviationGpsRule, fixes, DEV);
    expect(raised).toHaveLength(1);
    expect(raised[0]).toMatchObject({ severity: 'warning', occurredAt: fix(600).t });
    const close = effects.episodes.find((e) => e.op === 'close');
    expect(close).toMatchObject({ tags: ['detour'], metrics: { endReason: 'rejoined' } });
    expect((close as { metrics: { offRouteKm: number } }).metrics.offRouteKm).toBeGreaterThan(5);
  });

  it('starts after 15 min outside even when slow', () => {
    const slow = Array.from({ length: 70 }, (_, i) =>
      fix(i * 15, { speedKmh: 8, ...at(20_000 + i * 30, 1500) }),
    );
    expect(run(deviationGpsRule, slow, DEV).raised).toHaveLength(1);
  });

  it('ignores a brief excursion (median U-turn, dhaba pull-off inside the corridor, jitter)', () => {
    const fixes = [
      ...drive(0, 20, 10_000, () => 0),
      ...drive(300, 8, 15_000, () => 1200), // 2 km outside, < 15 min
      ...drive(420, 20, 17_000, () => 0),
      ...drive(720, 40, 22_000, (i) => (i % 2 ? 900 : -900)), // inside the corridor
    ];
    expect(run(deviationGpsRule, fixes, DEV).raised).toHaveLength(0);
  });

  it('tags a rejoin further along than the off-route distance explains as a shortcut', () => {
    const fixes = [
      ...drive(0, 40, 10_000, () => 0),
      ...drive(600, 24, 21_000, () => 1500).map((f, i) => ({
        ...f,
        ...at(21_000 + i * 600, 1500),
      })), // cuts across
      ...drive(960, 20, 36_000, () => 100),
    ];
    const close = run(deviationGpsRule, fixes, DEV).effects.episodes.find((e) => e.op === 'close');
    expect(close).toMatchObject({ tags: ['shortcut'] });
  });

  it('ignores fixes within 5 km of origin or drop (yards, last mile)', () => {
    // 20 min crawling 2 km beside the route, ~3 km before the drop.
    const nearDrop = Array.from({ length: 80 }, (_, i) =>
      fix(i * 15, { speedKmh: 6, ...at(108_000 + i * 20, 2000) }),
    );
    expect(run(deviationGpsRule, nearDrop, DEV).raised).toHaveLength(0);
  });

  it('never interpolates across a data gap to start a deviation', () => {
    const fixes = [
      ...drive(0, 3, 20_000, () => 1500), // outside, then the phone goes dark for 40 min
      ...drive(2400 + 45, 3, 40_000, () => 1500), // reappears outside: the 15-min clock restarts
    ];
    expect(run(deviationGpsRule, fixes, DEV).raised).toHaveLength(0);
  });

  it('escalates to Critical when the truck halts off route', () => {
    const fixes = [
      ...drive(0, 25, 20_000, () => 1500), // 6 km outside → deviation
      ...every(400, 660, 30, () => ({ speedKmh: 0, ...at(26_000, 1500) })), // halted 11 min off route
    ];
    const { effects } = run(deviationGpsRule, fixes, DEV);
    expect(effects.alerts.find((a) => a.op === 'escalate')).toMatchObject({ severity: 'critical' });
  });

  it('an approved alternate route counts as on-route', () => {
    const detour = ROUTE_POINTS.map((p) => ({ lat: p.lat, lng: p.lng + 1500 * E }));
    const routes = new TripRoutes([row(1), row(2, detour, 'approved_alternate')]);
    const { raised } = run(
      deviationGpsRule,
      drive(0, 40, 20_000, () => 1500),
      { ...DEV, route: routes },
    );
    expect(raised).toHaveLength(0);
  });

  it('does nothing without a planned route', () => {
    expect(
      run(
        deviationGpsRule,
        drive(0, 60, 20_000, () => 5000),
        { ...DEV, route: null },
      ).raised,
    ).toHaveLength(0);
  });
});

describe('DELAY-GPS progress + projection', () => {
  const P = { ...ctx('DELAY-GPS'), route: ROUTES };

  it('progress never moves backwards, and ignores fixes far off route', () => {
    const fixes = [
      fix(0, { speedKmh: 50, ...at(10_000) }),
      fix(300, { speedKmh: 50, ...at(14_000) }),
      fix(600, { speedKmh: 50, ...at(12_000) }), // SIM-style jump backwards
      fix(900, { speedKmh: 50, ...at(60_000, 8000) }), // 8 km off route: no progress
    ];
    const { state } = run(progressGpsRule, fixes, P);
    expect(state.furthestAlongM).toBeCloseTo(14_000, -1);
    expect(state.lastFixMs).toBe(fix(900).t);
  });

  it('projects with the planned speed before 50 km, then the observed speed over 3 h', () => {
    const params = P.params;
    const start = T0;
    const promised = promisedTime(null, null, start, 111_195, params); // 111 km at 350 km/day ≈ 7.6 h
    expect((promised - start) / 3_600_000).toBeCloseTo(7.6, 1);

    // 20 km covered: planned speed (14.6 km/h) → on time.
    const early = evaluateDelay({
      nowMs: start + 3_600_000,
      routeLengthM: 111_195,
      startMs: start,
      promisedMs: promised,
      progress: {
        tripId: TRIP,
        routeVersion: 1,
        furthestAlongM: 20_000,
        baselineAlongM: 0,
        baselineMs: start,
        samples: [{ t: start, alongM: 0 }],
        lastFixMs: start + 3_600_000,
      },
      params,
    });
    expect(early.basis).toBe('planned');

    // 60 km in the last 3 h at 20 km/h (slow), 51 km to go → late.
    const slow = evaluateDelay({
      nowMs: start + 3 * 3_600_000,
      routeLengthM: 111_195,
      startMs: start,
      promisedMs: start + 4 * 3_600_000,
      progress: {
        tripId: TRIP,
        routeVersion: 1,
        furthestAlongM: 60_000,
        baselineAlongM: 0,
        baselineMs: start,
        samples: [
          { t: start, alongM: 0 },
          { t: start + 3_600_000, alongM: 20_000 },
        ],
        lastFixMs: start + 3 * 3_600_000,
      },
      params,
    });
    expect(slow.basis).toBe('observed');
    expect(slow.speedKmh).toBeCloseTo(20, 0);
    expect(slow.remainingKm).toBeCloseTo(51.2, 0);
    expect(slow.delayMin).toBeGreaterThan(90);
  });

  it('measures the observed speed without bias from how progress is sampled', () => {
    // 3 h at a steady 36 km/h (10 m/s), a fix every 60 s — the estimate must be 36, not slower.
    const fixes = every(0, 3 * 3600, 60, (s) => ({ speedKmh: 36, ...at(s * 10) }));
    const { state } = run(progressGpsRule, fixes, P);
    const nowMs = fixes.at(-1)!.t;
    const estimate = evaluateDelay({
      nowMs,
      routeLengthM: 111_195,
      startMs: T0,
      promisedMs: T0 + 6 * 3_600_000,
      progress: state,
      params: P.params,
    });
    expect(estimate.basis).toBe('observed');
    expect(estimate.speedKmh).toBeCloseTo(36, 0);
  });

  it('"already late" is Warning until 240 min late, then Critical', () => {
    expect(alreadyLateSeverity(5, P.params)).toBe('warning');
    expect(alreadyLateSeverity(239, P.params)).toBe('warning');
    expect(alreadyLateSeverity(240, P.params)).toBe('critical');
  });

  it('a long halt drags the speed estimate (no separate halt term) and never divides by zero', () => {
    const halted = evaluateDelay({
      nowMs: T0 + 6 * 3_600_000,
      routeLengthM: 111_195,
      startMs: T0,
      promisedMs: T0 + 8 * 3_600_000,
      progress: {
        tripId: TRIP,
        routeVersion: 1,
        furthestAlongM: 60_000,
        baselineAlongM: 0,
        baselineMs: T0,
        samples: [{ t: T0 + 3 * 3_600_000, alongM: 60_000 }],
        lastFixMs: T0 + 6 * 3_600_000,
      },
      params: P.params,
    });
    expect(halted.speedKmh).toBe(1);
    expect(Number.isFinite(halted.etaMs)).toBe(true);
    expect(halted.delayMin).toBeGreaterThan(240);
  });
});

describe('DEV-GPS → LS_N_0028 off-route notice', () => {
  /** On route for 10 min, then 20 km east of it for `minutes`, drifting `alongStepM` per fix. */
  const offRoute = (minutes: number, alongStepM: number) => [
    ...drive(0, 40, 30_000, () => 0),
    ...Array.from({ length: minutes * 4 }, (_, i) =>
      fix(600 + i * 15, { speedKmh: 25, ...at(40_000 + i * alongStepM, 20_000) }),
    ),
  ];
  const notices = (fixes: ReturnType<typeof fix>[]) =>
    run(deviationGpsRule, fixes, DEV).effects.notices;

  it('far off route for 45 min and heading away from the drop → one notice', () => {
    const sent = notices(offRoute(60, -100)); // driving back south, away from the drop
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ type: 'trip.route_deviation', tripId: TRIP });
    expect(sent[0].payload.distanceOffKm as number).toBeGreaterThan(15);
  });

  it('far off route but still closing in on the drop (a long diversion) → no notice', () => {
    expect(notices(offRoute(60, 100))).toHaveLength(0);
  });

  it('far off route for less than 45 min → no notice', () => {
    expect(notices(offRoute(40, -100))).toHaveLength(0);
  });
});
