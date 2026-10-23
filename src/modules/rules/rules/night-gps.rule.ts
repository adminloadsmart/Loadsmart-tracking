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
import { Effects, FixRule, RuleContext } from '../rule.types';
import { RULE_DEFAULTS } from '../defaults';

interface NightTotals {
  km: number;
  movingMs: number;
  firstMoveMs: number | null;
  lastMoveMs: number | null;
}

export interface NightState {
  nightKey: string | null;
  phase: 'none' | 'candidate' | 'driving';
  movingSinceMs: number | null;
  candidateDistanceM: number;
  stationarySinceMs: number | null;
  episodeId: string | null;
  episodeStartMs: number | null;
  alertId: string | null;
  totals: NightTotals;
  lastFix: { t: number; lat: number; lng: number; speedKmh: number } | null;
}

const RULE = 'NIGHT-GPS' as const;
const emptyTotals = (): NightTotals => ({
  km: 0,
  movingMs: 0,
  firstMoveMs: null,
  lastMoveMs: null,
});

/**
 * NIGHT-GPS (rule sheet): driving inside the night window (default 23:00–06:00 IST, crossing
 * midnight, always by DEVICE time). Opt-in per customer/vehicle type — default OFF.
 *  - Starts when in window AND speed ≥ 10 km/h for 5 min, OR the truck has moved 2 km (speed
 *    AND distance, so GPS drift while parked never counts). A truck already moving when the
 *    window opens is flagged from its first in-window fix.
 *  - Ends after 10 min stationary, or when the window ends. Crossing midnight is one night.
 *  - One alert per night per vehicle at start, plus an end-of-night summary (km and minutes
 *    driven, first and last movement) attached to that alert when the night is over.
 */
export const nightGpsRule: FixRule<NightState> = {
  id: RULE,
  sources: ['driver_app', 'roadcast'],

  initial: () => ({
    nightKey: null,
    phase: 'none',
    movingSinceMs: null,
    candidateDistanceM: 0,
    stationarySinceMs: null,
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
    const speed = fix.speedKmh ?? 0;
    let s: NightState = { ...state };

    const inWindow = inDailyWindow(fix.t, start, end);
    const key = inWindow ? windowNightKey(fix.t, start) : null;

    // The night we were tracking is over (window ended, or a later night began).
    if (s.nightKey && key !== s.nightKey) s = finishNight(s, start, end, ctx, effects);
    if (!inWindow) return { ...s, lastFix: last(fix, speed) };
    s.nightKey = key;

    const moving = speed >= num(p, 'movingSpeedKmh');
    const step =
      s.lastFix && inDailyWindow(s.lastFix.t, start, end) ? distanceM(s.lastFix, fix) : 0;
    const stepMs = s.lastFix ? fix.t - s.lastFix.t : 0;

    if (s.phase === 'driving') {
      if (moving) {
        s.totals = {
          ...s.totals,
          km: s.totals.km + step / 1000,
          movingMs: s.totals.movingMs + stepMs,
          lastMoveMs: fix.t,
        };
        s.stationarySinceMs = null;
      } else if (speed < num(p, 'stationarySpeedKmh')) {
        s.stationarySinceMs = s.stationarySinceMs ?? fix.t;
        if (fix.t - s.stationarySinceMs >= num(p, 'endStationaryS') * 1000) {
          s = closeEpisode(s, s.stationarySinceMs, effects);
        }
      } else {
        // Creeping (between stationary and moving speed): not stationary, so a later stop starts
        // a fresh 10-minute timer instead of counting from a stop before the crawl.
        s.stationarySinceMs = null;
      }
    } else if (moving) {
      if (s.phase === 'none') {
        s.phase = 'candidate';
        s.movingSinceMs = fix.t;
        s.candidateDistanceM = 0;
      } else {
        s.candidateDistanceM += step;
      }
      const heldMs = fix.t - s.movingSinceMs!;
      if (
        heldMs >= num(p, 'startHoldS') * 1000 ||
        s.candidateDistanceM >= num(p, 'startDistanceM')
      ) {
        s = startDriving(s, fix.t, heldMs, fix, ctx, effects);
      }
    } else {
      s.phase = 'none';
      s.movingSinceMs = null;
      s.candidateDistanceM = 0;
    }

    s.lastFix = last(fix, speed);
    return s;
  },
};

const last = (fix: { t: number; lat: number; lng: number }, speedKmh: number) => ({
  t: fix.t,
  lat: fix.lat,
  lng: fix.lng,
  speedKmh,
});

function startDriving(
  s: NightState,
  nowMs: number,
  heldMs: number,
  fix: Parameters<(typeof nightGpsRule)['onFix']>[1],
  ctx: RuleContext,
  effects: Effects,
): NightState {
  const startMs = s.movingSinceMs!;
  const id = episodeId(ctx.vehicleId, RULE, startMs, fix.source);
  effects.episode({
    op: 'open',
    id,
    ruleId: RULE,
    source: fix.source,
    tripId: fix.tripId,
    startedAt: startMs,
    anchor: { lat: fix.lat, lng: fix.lng },
    metrics: { night: s.nightKey },
  });
  const totals: NightTotals = {
    km: s.totals.km + s.candidateDistanceM / 1000,
    movingMs: s.totals.movingMs + heldMs,
    firstMoveMs: s.totals.firstMoveMs ?? startMs,
    lastMoveMs: nowMs,
  };

  let nightAlertId = s.alertId;
  if (!nightAlertId && fix.live) {
    // One alert per night per vehicle: the dedupe key is the night itself.
    const dedupeKey = `${RULE}:${ctx.vehicleId}:${s.nightKey}`;
    nightAlertId = alertId(dedupeKey, 0);
    effects.alert({
      op: 'raise',
      id: nightAlertId,
      ruleId: RULE,
      severity: 'warning',
      audience: RULE_DEFAULTS[RULE]!.audience,
      title: 'Night driving',
      tripId: fix.tripId,
      episodeId: id,
      dedupeKey,
      occurredAt: startMs,
      payload: { night: s.nightKey, startedAt: new Date(startMs).toISOString() },
    });
  }
  return {
    ...s,
    phase: 'driving',
    movingSinceMs: null,
    candidateDistanceM: 0,
    stationarySinceMs: null,
    episodeId: id,
    episodeStartMs: startMs,
    alertId: nightAlertId,
    totals,
  };
}

function closeEpisode(s: NightState, endMs: number, effects: Effects): NightState {
  if (s.episodeId) {
    effects.episode({
      op: 'close',
      id: s.episodeId,
      endedAt: endMs,
      metrics: { night: s.nightKey, durationS: Math.round((endMs - s.episodeStartMs!) / 1000) },
    });
  }
  return { ...s, phase: 'none', episodeId: null, episodeStartMs: null, stationarySinceMs: null };
}

/** The window is over: close any running episode at window end and send the night's summary. */
function finishNight(
  s: NightState,
  start: number,
  end: number,
  _ctx: RuleContext,
  effects: Effects,
): NightState {
  const nightEnd = windowEndMs(s.nightKey!, start, end);
  let next = s;
  if (s.phase === 'driving')
    next = closeEpisode(s, Math.min(nightEnd, s.lastFix?.t ?? nightEnd), effects);
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
  return { ...nightGpsRule.initial(), lastFix: next.lastFix };
}
