import { mergeParams } from '../defaults';
import { Effects, FixRule, RuleContext, RuleFix, RuleId } from '../rule.types';

// Test-only helpers (imported by *.test.ts; tree-shaken from builds that don't use them).
export const VEHICLE = '22222222-2222-4222-8222-222222222222';
export const TRIP = '33333333-3333-4333-8333-333333333333';
export const T0 = Date.parse('2026-10-05T10:00:00.000Z');

/** ~1 m of latitude in degrees. */
export const M = 1 / 111_195;

export function fix(seconds: number, overrides: Partial<RuleFix> = {}): RuleFix {
  return {
    t: T0 + seconds * 1000,
    lat: 28.6,
    lng: 77.2,
    speedKmh: 0,
    source: 'driver_app',
    tripId: TRIP,
    inTransit: true,
    live: true,
    ignition: null,
    accuracyM: 5,
    satellites: null,
    gpsPositioned: null,
    ...overrides,
  };
}

/** A fix `metres` north of the base point. */
export const north = (metres: number) => ({ lat: 28.6 + metres * M });

export function ctx(
  ruleId: RuleId,
  overrides: Record<string, unknown> = {},
  bodyType: string | null = null,
): RuleContext {
  return {
    tenantId: '11111111-1111-4111-8111-111111111111',
    vehicleId: VEHICLE,
    nowMs: T0 + 86_400_000,
    params: mergeParams(ruleId, overrides),
    vehicle: { bodyType },
    route: null,
  };
}

/** Runs a rule over fixes, collecting every effect. */
export function run<S>(rule: FixRule<S>, fixes: RuleFix[], context: RuleContext, initial?: S) {
  const effects = new Effects();
  let state = initial ?? rule.initial();
  for (const f of fixes) state = rule.onFix(state, f, context, effects);
  return {
    state,
    effects,
    opened: effects.episodes.filter((e) => e.op === 'open'),
    raised: effects.alerts.filter((a) => a.op === 'raise'),
  };
}

/** One fix every `everyS` seconds for `durationS`, built by `make(secondsFromStart)`. */
export function every(
  startS: number,
  durationS: number,
  everyS: number,
  make: (s: number) => Partial<RuleFix>,
): RuleFix[] {
  const out: RuleFix[] = [];
  for (let s = startS; s <= startS + durationS; s += everyS) out.push(fix(s, make(s)));
  return out;
}
