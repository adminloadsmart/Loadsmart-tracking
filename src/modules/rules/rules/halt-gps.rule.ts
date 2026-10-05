import { impliedSpeedKmh } from '../../processing/geo';
import { alertId, distanceM, episodeId, medianAnchor, num } from '../rule-helpers';
import { Anchor, Effects, FixRule, RuleContext, RuleFix } from '../rule.types';
import { RULE_DEFAULTS } from '../defaults';

interface PreviousHalt {
  startMs: number;
  endMs: number;
  anchor: Anchor;
  episodeId: string | null;
  recorded: boolean;
  alerted: boolean;
  alertId: string | null;
}

export interface HaltState {
  halting: boolean;
  tripId: string | null;
  startMs: number;
  firstFixes: Anchor[];
  anchor: Anchor | null;
  lastHaltedMs: number;
  movingSinceMs: number | null;
  recorded: boolean;
  alerted: boolean;
  episodeId: string | null;
  alertId: string | null;
  ignition: boolean | null;
  prev: PreviousHalt | null;
  lastFix: { t: number; lat: number; lng: number } | null;
}

const RULE = 'HALT-GPS' as const;

/**
 * HALT-GPS (rule sheet): a trip-level stop while in transit.
 *  - Halted fix = speed < 5 km/h AND within 150 m of the halt anchor (both, not either).
 *  - Anchor = median of the first 3 halted fixes; distances are from the anchor, not fix to fix,
 *    so GPS jitter never splits one halt.
 *  - Start = first halted fix (back-dated). Recorded — and alerted once — at 10 min.
 *  - Ends at speed ≥ 10 km/h held 120 s, or a fix more than 300 m from the anchor.
 *  - Clubbing: a halt starting within 5 min of the previous one's end and within 500 m of its
 *    anchor continues it (duration includes the gap; still one alert).
 *  - A data gap > 10 min is "No data", not a halt — unless the fixes either side are within 200 m.
 *  - Buffered/old fixes are recorded but raise no alert.
 */
export const haltGpsRule: FixRule<HaltState> = {
  id: RULE,
  sources: ['driver_app', 'blackrock'],

  initial: () => ({
    halting: false,
    tripId: null,
    startMs: 0,
    firstFixes: [],
    anchor: null,
    lastHaltedMs: 0,
    movingSinceMs: null,
    recorded: false,
    alerted: false,
    episodeId: null,
    alertId: null,
    ignition: null,
    prev: null,
    lastFix: null,
  }),

  onFix(state, fix, ctx, effects) {
    const p = ctx.params;
    let s: HaltState = { ...state };

    // Only while the trip is in transit.
    if (!fix.inTransit || !fix.tripId) {
      if (s.halting) endHalt(s, s.lastHaltedMs, 'not_in_transit', ctx, effects);
      return { ...this.initial(), lastFix: point(fix) };
    }
    // A different trip starts clean (no clubbing across trips).
    if (s.tripId && s.tripId !== fix.tripId) {
      if (s.halting) endHalt(s, s.lastHaltedMs, 'trip_changed', ctx, effects);
      s = { ...this.initial(), lastFix: s.lastFix };
    }
    s.tripId = fix.tripId;

    // Data gap: "No data" unless both sides of the gap are at the same spot.
    if (s.halting && s.lastFix && fix.t - s.lastFix.t > num(p, 'gapS') * 1000) {
      if (distanceM(s.lastFix, fix) > num(p, 'gapSameSpotM')) {
        s = endHalt(s, s.lastHaltedMs, 'data_gap', ctx, effects);
      }
    }

    const speed = effectiveSpeed(fix, s.lastFix);
    const reference = s.anchor ?? s.firstFixes[0] ?? null;
    const isHaltedFix =
      speed !== null &&
      speed < num(p, 'haltSpeedKmh') &&
      (!s.halting || !reference || distanceM(reference, fix) <= num(p, 'haltRadiusM'));

    if (!s.halting) {
      if (isHaltedFix) s = startHalt(s, fix, ctx, effects);
    } else if (isHaltedFix) {
      if (s.firstFixes.length < 3) s.firstFixes = [...s.firstFixes, { lat: fix.lat, lng: fix.lng }];
      if (!s.anchor && s.firstFixes.length === 3) s.anchor = medianAnchor(s.firstFixes);
      s.lastHaltedMs = fix.t;
      s.movingSinceMs = null;
    } else {
      const fromAnchor = distanceM(reference ?? fix, fix);
      if (fromAnchor > num(p, 'endRadiusM')) {
        s = endHalt(s, s.lastHaltedMs, 'left_anchor', ctx, effects);
      } else if (speed !== null && speed >= num(p, 'endSpeedKmh')) {
        s.movingSinceMs = s.movingSinceMs ?? fix.t;
        if (fix.t - s.movingSinceMs >= num(p, 'endSpeedHoldS') * 1000) {
          s = endHalt(s, s.movingSinceMs, 'moving', ctx, effects);
        }
      } else {
        // Creeping inside the radius (5-10 km/h, or 150-300 m out): still the same stop.
        s.movingSinceMs = null;
      }
    }

    if (s.halting) {
      if (fix.ignition !== null) s.ignition = fix.ignition;
      if (!s.recorded && fix.t - s.startMs >= num(p, 'recordAfterS') * 1000) {
        s.recorded = true;
        s.episodeId = episodeId(ctx.vehicleId, RULE, s.startMs, fix.source);
        effects.episode({
          op: 'open',
          id: s.episodeId,
          ruleId: RULE,
          source: fix.source,
          tripId: s.tripId,
          startedAt: s.startMs,
          anchor: s.anchor ?? reference,
        });
      }
      if (s.recorded && !s.alerted && fix.live) {
        s.alerted = true;
        const dedupeKey = `${RULE}:${ctx.vehicleId}:${fix.source}:${s.episodeId}`;
        s.alertId = alertId(dedupeKey, s.startMs);
        const anchor = s.anchor ?? reference;
        effects.alert({
          op: 'raise',
          id: s.alertId,
          ruleId: RULE,
          severity: 'warning',
          audience: RULE_DEFAULTS[RULE]!.audience,
          title: 'Vehicle halted for 10+ minutes',
          tripId: s.tripId,
          episodeId: s.episodeId!,
          dedupeKey,
          occurredAt: s.startMs,
          payload: { haltStartedAt: new Date(s.startMs).toISOString(), anchor, source: fix.source },
        });
      }
    }

    s.lastFix = point(fix);
    return s;
  },
};

function point(fix: RuleFix) {
  return { t: fix.t, lat: fix.lat, lng: fix.lng };
}

/** Reported speed, else the speed implied by the move since the last fix. */
function effectiveSpeed(fix: RuleFix, last: HaltState['lastFix']): number | null {
  if (fix.speedKmh !== null) return fix.speedKmh;
  if (!last) return null;
  return impliedSpeedKmh(distanceM(last, fix), fix.t - last.t);
}

function startHalt(s: HaltState, fix: RuleFix, ctx: RuleContext, effects: Effects): HaltState {
  const p = ctx.params;
  const prev = s.prev;
  if (
    prev &&
    fix.t - prev.endMs <= num(p, 'clubGapS') * 1000 &&
    distanceM(prev.anchor, fix) <= num(p, 'clubRadiusM')
  ) {
    // Clubbed: the previous halt continues (same episode, start and alert; the gap counts as
    // halted time), re-anchored on the new stop so it is judged against where the truck now is.
    if (prev.recorded && prev.episodeId) effects.episode({ op: 'reopen', id: prev.episodeId });
    return {
      ...s,
      halting: true,
      startMs: prev.startMs,
      firstFixes: [{ lat: fix.lat, lng: fix.lng }],
      anchor: null,
      lastHaltedMs: fix.t,
      movingSinceMs: null,
      recorded: prev.recorded,
      alerted: prev.alerted,
      episodeId: prev.episodeId,
      alertId: prev.alertId,
      prev: null,
    };
  }
  return {
    ...s,
    halting: true,
    startMs: fix.t,
    firstFixes: [{ lat: fix.lat, lng: fix.lng }],
    anchor: null,
    lastHaltedMs: fix.t,
    movingSinceMs: null,
    recorded: false,
    alerted: false,
    episodeId: null,
    alertId: null,
    ignition: fix.ignition,
  };
}

function endHalt(
  s: HaltState,
  endMs: number,
  reason: string,
  _ctx: RuleContext,
  effects: Effects,
): HaltState {
  const anchor = s.anchor ?? s.firstFixes[0] ?? null;
  if (s.recorded && s.episodeId) {
    const tags = s.ignition === null ? [] : [s.ignition ? 'ignition_on' : 'ignition_off'];
    effects.episode({
      op: 'close',
      id: s.episodeId,
      endedAt: endMs,
      anchor,
      metrics: { durationS: Math.round((endMs - s.startMs) / 1000), endReason: reason },
      tags,
    });
  }
  if (s.alertId) effects.alert({ op: 'close', id: s.alertId, reason: `halt_ended:${reason}` });
  return {
    ...s,
    halting: false,
    movingSinceMs: null,
    prev: anchor
      ? {
          startMs: s.startMs,
          endMs,
          anchor,
          episodeId: s.episodeId,
          recorded: s.recorded,
          alerted: s.alerted,
          alertId: s.alertId,
        }
      : null,
    firstFixes: [],
    anchor: null,
    recorded: false,
    alerted: false,
    episodeId: null,
    alertId: null,
  };
}
