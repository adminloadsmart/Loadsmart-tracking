import { describe, expect, it } from 'vitest';
import { profileFromSteps, RouteTime } from './route-time';

describe('RouteTime', () => {
  it('uniform over the provider duration when there is no profile', () => {
    const t = RouteTime.of(100_000, 7200);
    expect(t.totalS).toBe(7200);
    expect(t.at(50_000)).toBeCloseTo(3600, 6);
    expect(t.remainingFrom(75_000)).toBeCloseTo(1800, 6);
  });

  it('uniform at a nominal 50 km/h when there is no duration either', () => {
    expect(RouteTime.of(100_000, null).totalS).toBeCloseTo(7200, 6);
  });

  it('follows the profile: a slow city stretch then a fast highway', () => {
    // 10 km of city in 1 h, then 90 km of highway in 1 h.
    const t = RouteTime.of(100_000, 7200, [
      [0, 0],
      [10_000, 3600],
      [100_000, 7200],
    ]);
    expect(t.at(5_000)).toBeCloseTo(1800, 6);
    expect(t.remainingFrom(10_000)).toBeCloseTo(3600, 6); // 90 km left, but only 1 h
    expect(t.remainingFrom(0)).toBeCloseTo(7200, 6);
  });

  it('scales the profile to the geometry length (provider metres differ slightly)', () => {
    const t = RouteTime.of(101_000, null, [
      [0, 0],
      [100_000, 7200],
    ]);
    expect(t.at(101_000)).toBe(7200);
    expect(t.at(50_500)).toBeCloseTo(3600, 6);
  });

  it('clamps outside the route', () => {
    const t = RouteTime.of(100_000, 7200);
    expect(t.at(-5)).toBe(0);
    expect(t.at(200_000)).toBe(7200);
    expect(t.remainingFrom(200_000)).toBe(0);
  });

  it('falls back to uniform on an unusable profile', () => {
    const decreasing = RouteTime.of(100_000, 7200, [
      [0, 0],
      [60_000, 4000],
      [50_000, 5000],
    ]);
    expect(decreasing.at(50_000)).toBeCloseTo(3600, 6);
    expect(RouteTime.of(100_000, 7200, [[0, 0]]).at(50_000)).toBeCloseTo(3600, 6);
  });
});

describe('profileFromSteps', () => {
  it('accumulates step distance and static duration', () => {
    expect(
      profileFromSteps([
        { distanceMeters: 1000, staticDuration: '120s' },
        { distanceMeters: 4000, staticDuration: '180.4s' },
      ]),
    ).toEqual([
      [0, 0],
      [1000, 120],
      [5000, 300],
    ]);
  });

  it('null when steps are missing or malformed', () => {
    expect(profileFromSteps([])).toBeNull();
    expect(profileFromSteps([{ distanceMeters: 1000 }])).toBeNull();
  });
});
