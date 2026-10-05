import type { Audience, RuleId } from './rule.types';

/**
 * Defaults straight from the "Tracking Derivatives - Rule sheet" (docs/rules.md). Every number a
 * rule uses lives here, so a tenant override (tracking.rule_settings.params) can change it
 * without code changes. Distances in metres, durations in seconds unless the name says otherwise.
 */
export interface RuleDefaults {
  enabled: boolean;
  audience: Audience[];
  params: Record<string, number | boolean | string>;
}

export const RULE_DEFAULTS: Partial<Record<RuleId, RuleDefaults>> = {
  'HALT-GPS': {
    enabled: true,
    audience: ['shipper', 'trip_ops', 'fleet_owner'],
    params: {
      haltSpeedKmh: 5, // a fix is halted below this speed…
      haltRadiusM: 150, // …AND within this distance of the anchor
      recordAfterS: 600, // halt recorded (and alerted) once it lasts 10 min
      endSpeedKmh: 10, // ends when speed ≥ this…
      endSpeedHoldS: 120, // …for 120 s
      endRadiusM: 300, // …or a fix is further than this from the anchor
      clubGapS: 300, // a new halt within 5 min…
      clubRadiusM: 500, // …and 500 m of the previous one is merged into it
      gapS: 600, // fixes further apart than this are a data gap…
      gapSameSpotM: 200, // …which continues the halt only if both sides are within 200 m
      reminderEveryMin: 0, // 0 = alert once
    },
  },
  'OVER-GPS': {
    enabled: true,
    audience: ['fleet_owner', 'shipper'],
    params: {
      goodsLimitKmh: 80,
      tankerLimitKmh: 60,
      customerLimitKmh: 0, // 0 = none
      startMarginPct: 3,
      startHoldS: 20,
      endMarginPct: 3,
      endHoldS: 10,
      mergeGapS: 60,
      criticalOverKmh: 20,
      maxAccelMs2: 4, // reject speeds implying more acceleration than this
      maxFixGapS: 60, // fixes further apart can't prove "continuously" above the limit
    },
  },
  'NIGHT-GPS': {
    // Opt-in per customer / vehicle type: night running is normal for long-haul trucks.
    enabled: false,
    audience: ['fleet_owner'],
    params: {
      windowStart: '23:00',
      windowEnd: '06:00',
      movingSpeedKmh: 10,
      startHoldS: 300, // speed ≥ 10 km/h for 5 min…
      startDistanceM: 2000, // …or 2 km moved
      stationarySpeedKmh: 5,
      endStationaryS: 600,
    },
  },
  'INACT-GPS': {
    enabled: true,
    audience: ['fleet_owner', 'loadsmart_ops', 'shipper'],
    params: {
      inactiveAfterMin: 60,
      tankerInactiveAfterMin: 30, // oil-company rule
    },
  },
};

export const DEFAULT_AUDIENCE: Audience[] = ['trip_ops'];

/** Default params for a rule merged with a tenant's overrides (unknown keys are ignored). */
export function mergeParams(
  ruleId: RuleId,
  overrides: Record<string, unknown> | undefined,
): Record<string, number | boolean | string> {
  const defaults = RULE_DEFAULTS[ruleId]?.params ?? {};
  const merged: Record<string, number | boolean | string> = { ...defaults };
  for (const [key, value] of Object.entries(overrides ?? {})) {
    if (key in defaults && typeof value === typeof defaults[key]) {
      merged[key] = value as number | boolean | string;
    }
  }
  return merged;
}
