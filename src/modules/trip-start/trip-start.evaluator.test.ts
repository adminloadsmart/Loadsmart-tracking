import { describe, expect, it } from 'vitest';
import { evaluateTripStart, TripStartFix, TripStartState } from './trip-start.evaluator';

const T0 = Date.parse('2026-10-19T10:00:00.000Z');
const MIN = 60_000;
const ctx = { assignment: T0 - 3_600_000, vehicleId: 'veh-1' };
/** ~1 m of latitude in degrees. */
const M = 1 / 111_195;

/** A fix `metres` north of the start, `minutes` after T0. */
const fix = (minutes: number, metres: number, source = 'driver_app'): TripStartFix => ({
  t: T0 + minutes * MIN,
  lat: 28.6 + metres * M,
  lng: 77.2,
  source,
});

describe('evaluateTripStart', () => {
  it('the first fix is where the truck was; nothing starts', () => {
    const result = evaluateTripStart(null, ctx, [fix(0, 0)]);
    expect(result.started).toBeNull();
    expect(result.state?.anchor).toMatchObject({ lat: 28.6, t: T0 });
  });

  it('a phone / GPS fix 3 km away starts the trip, stamped with that fix', () => {
    const result = evaluateTripStart(null, ctx, [fix(0, 0), fix(5, 1500), fix(10, 3100)]);
    expect(result.started).toMatchObject({ t: T0 + 10 * MIN, pings: 1, source: 'driver_app' });
    expect(result.started!.distanceM).toBeGreaterThan(3000);
    expect(result.started!.from).toMatchObject({ t: T0 });
  });

  it('works in any direction, not just north', () => {
    const east = { t: T0 + MIN, lat: 28.6, lng: 77.2 + 0.04, source: 'roadcast' }; // ~3.9 km
    expect(evaluateTripStart(null, ctx, [fix(0, 0), east]).started).not.toBeNull();
  });

  it('stays quiet under the distance', () => {
    expect(
      evaluateTripStart(null, ctx, [fix(0, 0), fix(5, 1000), fix(10, 2900)]).started,
    ).toBeNull();
  });

  it('raises the start once: later fixes, and a redelivery, add nothing', () => {
    const first = evaluateTripStart(null, ctx, [fix(0, 0), fix(5, 3500)]);
    expect(first.started).not.toBeNull();
    const later = evaluateTripStart(first.state, ctx, [fix(10, 6000), fix(15, 9000)]);
    expect(later.started).toBeNull();
    const again = evaluateTripStart(first.state, ctx, [fix(0, 0), fix(5, 3500)]);
    expect(again.started).toBeNull();
  });

  describe('SIM (coarse fixes, 10-20 min apart)', () => {
    it('one far ping is not enough; a second distinct one confirms, stamped with the first', () => {
      const one = evaluateTripStart(null, ctx, [fix(0, 0, 'sim'), fix(20, 3500, 'sim')]);
      expect(one.started).toBeNull();
      const two = evaluateTripStart(one.state, ctx, [fix(40, 6000, 'sim')]);
      expect(two.started).toMatchObject({ t: T0 + 20 * MIN, pings: 2, source: 'sim' });
    });

    it('a ping that falls back inside the distance resets the count (a stray cell-tower fix)', () => {
      const result = evaluateTripStart(null, ctx, [
        fix(0, 0, 'sim'),
        fix(20, 3500, 'sim'),
        fix(40, 800, 'sim'),
        fix(60, 3600, 'sim'),
      ]);
      expect(result.started).toBeNull();
      expect(result.state?.far).toHaveLength(1);
    });

    it('the number of pings is a setting', () => {
      const fixes = [fix(0, 0, 'sim'), fix(20, 3500, 'sim')];
      const options = { distanceM: 3000, simMinPings: 1 };
      expect(evaluateTripStart(null, ctx, fixes, options).started).not.toBeNull();
    });
  });

  it('a new assignment (re-assigned truck) starts the check over', () => {
    const done = evaluateTripStart(null, ctx, [fix(0, 0), fix(5, 3500)]);
    expect(done.started).not.toBeNull();
    const reassigned = { assignment: ctx.assignment + 86_400_000, vehicleId: 'veh-1' };
    const next = evaluateTripStart(done.state, reassigned, [fix(100, 3500)]);
    expect(next.started).toBeNull(); // this fix is the new anchor
    const moved = evaluateTripStart(next.state, reassigned, [fix(110, 7000)]);
    expect(moved.started).not.toBeNull();
  });

  it('a different truck on the same load starts the check over too', () => {
    const done = evaluateTripStart(null, ctx, [fix(0, 0), fix(5, 3500)]);
    const other = evaluateTripStart(done.state, { ...ctx, vehicleId: 'veh-2' }, [fix(10, 9000)]);
    expect(other.started).toBeNull();
    expect(other.state?.vehicleId).toBe('veh-2');
  });

  it('ignores fixes not newer than the state (late, duplicates)', () => {
    const state: TripStartState = {
      assignment: ctx.assignment,
      vehicleId: 'veh-1',
      anchor: { lat: 28.6, lng: 77.2, t: T0 },
      far: [],
      lastT: T0 + 10 * MIN,
      fired: false,
    };
    expect(evaluateTripStart(state, ctx, [fix(5, 5000), fix(10, 5000)]).started).toBeNull();
  });
});
