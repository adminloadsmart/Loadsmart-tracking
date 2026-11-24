import { describe, expect, it } from 'vitest';
import {
  istDay,
  istDayStart,
  statsWindowStart,
  vehicleStats,
  type StatsPoint,
} from './vehicle-stats';

const MIN = 60_000;
// 24 Nov 2026, 15:00 IST.
const NOW = Date.parse('2026-11-24T09:30:00Z');
const TODAY = istDayStart(NOW);

/** ~0.009° of latitude is ~1 km. */
const fix = (at: number, km: number, over: Partial<StatsPoint> = {}): StatsPoint => ({
  at,
  lat: 22 + km * 0.008993,
  lng: 75,
  speedKmh: null,
  ignition: null,
  batteryPct: null,
  deviceStatus: null,
  ...over,
});

describe('IST days', () => {
  it('starts the day at midnight India time', () => {
    expect(new Date(TODAY).toISOString()).toBe('2026-11-23T18:30:00.000Z');
    expect(istDay(TODAY)).toBe('2026-11-24');
    expect(istDay(TODAY - 1)).toBe('2026-11-23');
    expect(istDay(statsWindowStart(NOW))).toBe('2026-11-18');
  });
});

describe('vehicleStats', () => {
  it('splits today into running, idle and stopped, and adds up the km', () => {
    const t = TODAY + 8 * 60 * MIN;
    const points = [
      // 60 km in an hour, running.
      fix(t, 0, { speedKmh: 60, ignition: true }),
      fix(t + 30 * MIN, 30, { speedKmh: 60, ignition: true }),
      // Engine on, standing: idle.
      fix(t + 60 * MIN, 60, { speedKmh: 0, ignition: true }),
      // Engine off: stopped.
      fix(t + 80 * MIN, 60, { speedKmh: 0, ignition: false, batteryPct: 98 }),
      fix(t + 100 * MIN, 60, { speedKmh: 0, ignition: false, batteryPct: 97 }),
    ];
    const s = vehicleStats(points, NOW);
    expect(s.today.distanceKm).toBeCloseTo(60, 0);
    expect(s.today.runningMin).toBe(60);
    expect(s.today.idleMin).toBe(20);
    expect(s.today.stoppedMin).toBe(20);
    expect(s.today.maxSpeedKmh).toBe(60);
    expect(s.today.avgSpeedKmh).toBe(60);
    expect(s.days.at(-1)).toEqual({ date: '2026-11-24', distanceKm: expect.closeTo(60, 0) });
    expect(s.device).toMatchObject({ batteryPct: 97, ignition: false });
  });

  it('puts earlier days in their own bar and ignores long silences and bad jumps', () => {
    const y = TODAY - 10 * 60 * MIN; // yesterday 14:00 IST
    const points = [
      fix(y, 0, { speedKmh: 50 }),
      fix(y + 20 * MIN, 15, { speedKmh: 50 }),
      // 2 h of silence: not counted.
      fix(y + 140 * MIN, 100, { speedKmh: 50 }),
      // 500 km in 10 min: a bad fix, not distance.
      fix(y + 150 * MIN, 600, { speedKmh: 50 }),
    ];
    const s = vehicleStats(points, NOW);
    expect(s.days).toHaveLength(7);
    expect(s.days.at(-2)).toEqual({ date: '2026-11-23', distanceKm: expect.closeTo(15, 0) });
    expect(s.today.distanceKm).toBe(0);
    expect(s.today.idleMin).toBeNull(); // the device never reported ignition
  });

  it('does not count GPS wander while standing as distance', () => {
    const t = TODAY + 60 * MIN;
    const points = [0, 1, 2, 3].map((i) => fix(t + i * MIN, i % 2 ? 0.01 : 0, { speedKmh: 0 }));
    expect(vehicleStats(points, NOW).today.distanceKm).toBe(0);
  });
});
