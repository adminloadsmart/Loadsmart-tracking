import {
  alertId,
  distanceM,
  episodeId,
  inDailyWindow,
  num,
  parseClock,
  windowEndMs,
  windowNightKey,
} from '../rule-helpers';
import { Effects, FixRule, RuleContext, RuleFix } from '../rule.types';
import { RULE_DEFAULTS } from '../defaults';

interface NightTotals {
  km: number;
  movingMs: number;
  firstMoveMs: number | null;
  lastMoveMs: number | null;
}

export interface NightSimState {
  nightKey: string | null;
  phase: 'none' | 'driving';
  episodeId: string | null;
  episodeStartMs: number | null;
  alertId: string | null;
  totals: NightTotals;
  /** The previous SIM ping (any time of day): pairs are formed from consecutive pings. */
  lastFix: { t: number; lat: number; lng: number } | null;
}

const RULE = 'NIGHT-SIM' as const;
const emptyTotals = (): NightTotals => ({
  km: 0,
  movingMs: 0,
  firstMoveMs: null,
  lastMoveMs: null,
});

/**
 * NIGHT-SIM (rule sheet, docs/simrules.md): night driving seen through SIM pings. Vehicle-level
 * (not tied to a trip) and opt-in (default OFF), like NIGHT-GPS.
 *  - Window = 23:00 to 06:00 IST (crosses midnight), judged by each ping's capture time.
 *  - A pair of consecutive pings, both inside the window, is "moving" when at least 5 km apart,
 *    "stationary" when within the 2 km halt radius, and ignored (inconclusive) in between.
 *  - Starts at the first moving pair (back-dated to the earlier ping of the pair). One alert per
 *    night per vehicle (Warning), raised on a live ping.
 *  - Ends at the first stationary pair (2 consecutive pings inside the halt radius), or when the
 *    window ends. A drive that crosses midnight is one night.
 *  - End-of-night summary on the alert: km (sum of ping-to-ping straight lines, which understates
 *    winding roads), minutes and first / last movement.
 *  - Blind spots: a movement shorter than a ping interval, and a phone that is off (no pings is
 *    not read as "no night driving").
 */
export const nightSimRule: FixRule<NightSimState> = {
  id: RULE,
  sources: ['sim'],

  initial: () => ({
    nightKey: null,
    phase: 'none',
    episodeId: null,
    episodeStartMs: null,
    alertId: null,
    totals: emptyTotals(),
    lastFix: null,
  }),

  onFix(state, fix, ctx, effects) {
    const p = ctx.params;
    const start = parseClock(String(p.windowStart));
    const end = parseClock(String(p.windowEnd));
    let s: NightSimState = { ...this.initial(), ...state };

    const inWindow = inDailyWindow(fix.t, start, end);
    const key = inWindow ? windowNightKey(fix.t, start) : null;

    // The night we were tracking is over (window ended, or a later night began).
    if (s.nightKey && key !== s.nightKey) s = finishNight(s, start, end, effects);
    const prev = s.lastFix;
    s.lastFix = { t: fix.t, lat: fix.lat, lng: fix.lng };
    if (!inWindow) return s;
    s.nightKey = key;

    // A pair needs both pings inside this night's window.
    if (!prev || windowNightKey(prev.t, start) !== key || !inDailyWindow(prev.t, start, end)) {
      return s;
    }
    const d = distanceM(prev, fix);
    const moving = d >= num(p, 'movingDistanceM');
    const stationary = d <= num(p, 'stationaryRadiusM');

    if (s.phase === 'none') {
      if (moving) s = startDriving(s, prev, fix, d, ctx, effects);
    } else if (moving || !stationary) {
      // Moving, or in between (a move too short to be sure, counted as driving): the drive goes on.
      s.totals = {
        ...s.totals,
        km: s.totals.km + d / 1000,
        movingMs: s.totals.movingMs + (fix.t - prev.t),
        lastMoveMs: fix.t,
      };
      if (!s.alertId && fix.live) s = raise(s, fix, ctx, effects);
    } else {
      // Two consecutive pings inside the halt radius: stopped; the drive ended at the first of them.
      s = closeEpisode(s, prev.t, effects);
    }
    return s;
  },
};

function startDriving(
  s: NightSimState,
  prev: { t: number; lat: number; lng: number },
  fix: RuleFix,
  d: number,
  ctx: RuleContext,
  effects: Effects,
): NightSimState {
  const startMs = prev.t;
  const id = episodeId(ctx.vehicleId, RULE, startMs, fix.source);
  effects.episode({
    op: 'open',
    id,
    ruleId: RULE,
    source: fix.source,
    tripId: fix.tripId,
    startedAt: startMs,
    anchor: { lat: prev.lat, lng: prev.lng },
    metrics: { night: s.nightKey },
  });
  const started: NightSimState = {
    ...s,
    phase: 'driving',
    episodeId: id,
    episodeStartMs: startMs,
    totals: {
      km: s.totals.km + d / 1000,
      movingMs: s.totals.movingMs + (fix.t - startMs),
      firstMoveMs: s.totals.firstMoveMs ?? startMs,
      lastMoveMs: fix.t,
    },
  };
  return !started.alertId && fix.live ? raise(started, fix, ctx, effects) : started;
}

/** One alert per night per vehicle: the dedupe key is the night itself. */
function raise(s: NightSimState, fix: RuleFix, ctx: RuleContext, effects: Effects): NightSimState {
  const dedupeKey = `${RULE}:${ctx.vehicleId}:${s.nightKey}`;
  const id = alertId(dedupeKey, 0);
  const startMs = s.totals.firstMoveMs ?? s.episodeStartMs ?? fix.t;
  effects.alert({
    op: 'raise',
    id,
    ruleId: RULE,
    severity: 'warning',
    audience: RULE_DEFAULTS[RULE]!.audience,
    title: 'Night driving',
    tripId: fix.tripId,
    episodeId: s.episodeId!,
    dedupeKey,
    occurredAt: startMs,
    payload: { night: s.nightKey, startedAt: new Date(startMs).toISOString() },
  });
  return { ...s, alertId: id };
}

function closeEpisode(s: NightSimState, endMs: number, effects: Effects): NightSimState {
  if (s.episodeId) {
    effects.episode({
      op: 'close',
      id: s.episodeId,
      endedAt: endMs,
      metrics: { night: s.nightKey, durationS: Math.round((endMs - s.episodeStartMs!) / 1000) },
    });
  }
  return { ...s, phase: 'none', episodeId: null, episodeStartMs: null };
}

/** The window is over: close any running episode at window end and send the night's summary. */
function finishNight(
  s: NightSimState,
  start: number,
  end: number,
  effects: Effects,
): NightSimState {
  const nightEnd = windowEndMs(s.nightKey!, start, end);
  let next = s;
  if (s.phase === 'driving') {
    next = closeEpisode(s, Math.min(nightEnd, s.lastFix?.t ?? nightEnd), effects);
  }
  if (next.alertId) {
    const { totals } = next;
    effects.alert({
      op: 'update',
      id: next.alertId,
      payload: {
        summary: {
          km: Math.round(totals.km * 10) / 10,
          minutes: Math.round(totals.movingMs / 60_000),
          firstMovementAt: totals.firstMoveMs ? new Date(totals.firstMoveMs).toISOString() : null,
          lastMovementAt: totals.lastMoveMs ? new Date(totals.lastMoveMs).toISOString() : null,
        },
      },
    });
    effects.alert({ op: 'close', id: next.alertId, reason: 'night_ended' });
  }
  return { ...nightSimRule.initial(), lastFix: next.lastFix };
}
