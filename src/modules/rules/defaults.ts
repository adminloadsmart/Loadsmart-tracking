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
      recordAfterS: 600, // halt recorded (an episode, for the journey timeline) once it lasts 10 min
      alertAfterS: 1800, // …and alerted (alert.opened → main backend) once it lasts 30 min
      anchorFixes: 3, // anchor = median of this many first halted fixes
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
  // SIM: a coarse fix (cell tower, ±hundreds of m to km) every 10-20 min and no speed, so the
  // speed is the one implied by two fixes and every radius / gap is wider than GPS's.
  'HALT-SIM': {
    enabled: true,
    audience: ['shipper', 'trip_ops', 'fleet_owner'],
    params: {
      haltSpeedKmh: 5,
      haltRadiusM: 1000,
      recordAfterS: 600,
      alertAfterS: 1800, // reached by the first fix after 30 min: up to one poll interval late
      anchorFixes: 2, // 3 fixes would be 40+ min of the halt
      endSpeedKmh: 10,
      endSpeedHoldS: 0, // a second fix 20 min later would delay the end by a whole interval
      endRadiusM: 2500,
      clubGapS: 2400,
      clubRadiusM: 1500,
      gapS: 3000, // two missed polls (20 min each) are not yet "no data"
      gapSameSpotM: 1000,
      reminderEveryMin: 0,
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
  'DEV-GPS': {
    enabled: true,
    audience: ['shipper', 'trip_ops', 'fleet_owner'],
    params: {
      corridorM: 1000, // outside = more than 1 km from every planned/approved route
      ignoreNearEndsM: 5000, // yards, parking and the last mile around origin and drop
      startAfterS: 900, // outside for 15 min…
      startAfterOutsideM: 5000, // …or driven 5 km outside the corridor
      rejoinFactor: 0.8, // back inside 0.8 × corridor…
      rejoinHoldS: 120, // …for 2 min
      gapS: 600, // never interpolate across a gap to START a deviation
      haltSpeedKmh: 5, // halted while off route → Critical
      haltHoldS: 600,
      // LS_N_0028 notice (main backend "off route"): further than this from every route…
      notifyOffRouteM: 15_000,
      notifyAfterS: 2700, // …continuously for 45 min…
      notifyAwayWindowS: 900, // …and further from the drop than 15 min earlier
    },
  },
  'DELAY-GPS': {
    enabled: true,
    audience: ['shipper', 'trip_ops'],
    params: {
      evaluateEveryMin: 15, // delay alerts / LS_N_0030 cadence
      etaEveryMin: 1, // the trip's ETA is refreshed this often (no alerting)
      // ETA = Google's expected time for the route still ahead × the truck's pace factor:
      plannedKmPerDay: 350, // prior pace: the whole route at this rate (rests included)
      speedWindowH: 12, // observed pace = actual hours ÷ Google hours over the last 12 h…
      priorWeightH: 6, // …blended with the prior: 6 h of observation = 50/50
      minPace: 1, // pace factor bounds (1 = as fast as Google's car time, no stops)
      maxPace: 8,
      fallbackKmPerDay: 350, // promised = start + route km / 350 km per day when not given
      warningDelayMin: 60,
      criticalDelayMin: 240,
      clearDelayMin: 30,
      consecutive: 2, // evaluations needed to raise and to clear
      staleAfterMin: 60, // last fix older → keep the last ETA, marked stale
      maxSnapDistanceM: 5000, // fixes further from the route don't move progress
      // LS_N_0030 notice (main backend "delivery will be late"):
      lateNoticeDefaultMin: 1440, // the company's limit when its org admin never set one (1 day)
      lateCauseMinMin: 60, // a cause (halts / deviation) must account for this much to be named
      // Delivery ETA before the truck leaves the plant (truck_assigned … loaded), no alerts:
      loadingDwellMin: 240, // time allowed at the loading point
      approachFactor: 1.3, // drive to the plant: Google's approach time × this (short leg, no rest)
      approachKmh: 30, // …or this speed when there is no approach route to measure on
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
