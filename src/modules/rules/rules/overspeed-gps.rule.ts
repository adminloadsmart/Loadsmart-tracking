import { alertId, distanceM, episodeId, num } from '../rule-helpers';
import { Anchor, Effects, FixRule, RuleContext, RuleFix } from '../rule.types';
import { RULE_DEFAULTS } from '../defaults';

/** Fixes above the start threshold before the 20 s hold confirms an episode. */
interface Candidate {
  maxSpeed: number;
  speedSum: number;
  speedCount: number;
  distanceM: number;
  start: Anchor;
  last: Anchor;
}

interface Episode {
  id: string;
  startMs: number;
  maxSpeed: number;
  speedSum: number;
  speedCount: number;
  distanceM: number;
  start: Anchor;
  last: Anchor;
  alertId: string | null;
  escalated: boolean;
}

export interface OverspeedState {
  phase: 'none' | 'candidate' | 'over';
  aboveSinceMs: number | null;
  belowSinceMs: number | null;
  /** Readings since aboveSinceMs — the episode is back-dated to them, so its metrics include them. */
  candidate?: Candidate | null;
  episode: Episode | null;
  /** The last closed episode — reopened if the next one starts within mergeGapS. */
  previous: (Episode & { endMs: number }) | null;
  prevFix: { t: number; speedKmh: number } | null;
}

const RULE = 'OVER-GPS' as const;

export function speedLimitKmh(params: RuleContext['params'], bodyType: string | null): number {
  const typeLimit = /tank/i.test(bodyType ?? '')
    ? num(params, 'tankerLimitKmh')
    : num(params, 'goodsLimitKmh');
  const customerLimit = num(params, 'customerLimitKmh');
  return customerLimit > 0 ? Math.min(typeLimit, customerLimit) : typeLimit;
}

/**
 * OVER-GPS (rule sheet): vehicle-level overspeeding.
 *  - Valid fix only (GPS positioned, ≥ 5 satellites on the device); a speed implying more than
 *    4 m/s² acceleration is rejected as noise.
 *  - Limit = lowest of vehicle-type (80 goods / 60 tanker) and customer limits.
 *  - Starts after > limit × 1.03 continuously for 20 s; ends after < limit × 0.97 for 10 s
 *    (hysteresis — no flapping at the limit). Episodes closer than 60 s merge into one.
 *  - One alert per episode at start; Critical once max speed ≥ limit + 20 km/h. The episode closes
 *    with max/avg speed, duration, distance and start/end location.
 */
export const overspeedGpsRule: FixRule<OverspeedState> = {
  id: RULE,
  sources: ['driver_app', 'roadcast'],

  initial: () => ({
    phase: 'none',
    aboveSinceMs: null,
    belowSinceMs: null,
    candidate: null,
    episode: null,
    previous: null,
    prevFix: null,
  }),

  onFix(state, fix, ctx, effects) {
    const p = ctx.params;
    if (fix.speedKmh === null || !validFix(fix)) return state;
    const speed = fix.speedKmh;

    // Acceleration filter: a jump of e.g. 0 → 90 km/h in 10 s is a bad reading, not driving.
    if (state.prevFix && fix.t > state.prevFix.t) {
      const accel =
        Math.abs(speed - state.prevFix.speedKmh) / 3.6 / ((fix.t - state.prevFix.t) / 1000);
      if (accel > num(p, 'maxAccelMs2')) return state;
    }
    let s: OverspeedState = { ...state, prevFix: { t: fix.t, speedKmh: speed } };

    // Fixes too far apart can't show the speed was held "continuously".
    if (state.prevFix && fix.t - state.prevFix.t > num(p, 'maxFixGapS') * 1000) {
      s.aboveSinceMs = null;
      s.belowSinceMs = null;
      s.candidate = null;
      if (s.phase === 'candidate') s.phase = 'none';
    }

    const limit = speedLimitKmh(p, ctx.vehicle.bodyType);
    const startAbove = limit * (1 + num(p, 'startMarginPct') / 100);
    const endBelow = limit * (1 - num(p, 'endMarginPct') / 100);

    if (s.phase !== 'over') {
      if (speed > startAbove) {
        s.candidate = addReading(s.aboveSinceMs === null ? null : (s.candidate ?? null), fix);
        s.aboveSinceMs = s.aboveSinceMs ?? fix.t;
        s.phase = 'candidate';
        if (fix.t - s.aboveSinceMs >= num(p, 'startHoldS') * 1000) {
          s = begin(s, s.aboveSinceMs, fix, limit, ctx, effects);
        }
      } else {
        s.phase = 'none';
        s.aboveSinceMs = null;
        s.candidate = null;
      }
      return s;
    }

    // Over the limit: accumulate the episode — but not the slow fixes of the end hold, since the
    // episode is back-dated to end when speed dropped below the threshold.
    const ep = { ...s.episode! };
    if (speed >= endBelow) {
      ep.distanceM += distanceM(ep.last, fix);
      ep.last = { lat: fix.lat, lng: fix.lng };
      ep.maxSpeed = Math.max(ep.maxSpeed, speed);
      ep.speedSum += speed;
      ep.speedCount += 1;
    }
    s.episode = ep;

    if (!ep.escalated && ep.alertId && ep.maxSpeed >= limit + num(p, 'criticalOverKmh')) {
      ep.escalated = true;
      effects.alert({
        op: 'escalate',
        id: ep.alertId,
        severity: 'critical',
        payload: { maxSpeedKmh: ep.maxSpeed },
      });
    }

    if (speed < endBelow) {
      s.belowSinceMs = s.belowSinceMs ?? fix.t;
      if (fix.t - s.belowSinceMs >= num(p, 'endHoldS') * 1000)
        s = end(s, s.belowSinceMs, limit, effects);
    } else {
      s.belowSinceMs = null;
    }
    return s;
  },
};

function addReading(c: Candidate | null, fix: RuleFix): Candidate {
  const position = { lat: fix.lat, lng: fix.lng };
  const speed = fix.speedKmh!;
  if (!c) {
    return {
      maxSpeed: speed,
      speedSum: speed,
      speedCount: 1,
      distanceM: 0,
      start: position,
      last: position,
    };
  }
  return {
    maxSpeed: Math.max(c.maxSpeed, speed),
    speedSum: c.speedSum + speed,
    speedCount: c.speedCount + 1,
    distanceM: c.distanceM + distanceM(c.last, position),
    start: c.start,
    last: position,
  };
}

function validFix(fix: RuleFix): boolean {
  if (fix.source !== 'roadcast') return true; // phone fixes were already accuracy-filtered
  if (fix.gpsPositioned === false) return false;
  return fix.satellites === null || fix.satellites >= 5;
}

function begin(
  s: OverspeedState,
  startMs: number,
  fix: RuleFix,
  limit: number,
  ctx: RuleContext,
  effects: Effects,
): OverspeedState {
  const p = ctx.params;
  const c = s.candidate ?? addReading(null, fix);
  const prev = s.previous;
  if (prev && startMs - prev.endMs < num(p, 'mergeGapS') * 1000) {
    // Merge: the previous episode continues (with these readings); its alert already went out.
    effects.episode({ op: 'reopen', id: prev.id });
    const { endMs: _endMs, ...previous } = prev;
    const episode: Episode = {
      ...previous,
      maxSpeed: Math.max(previous.maxSpeed, c.maxSpeed),
      speedSum: previous.speedSum + c.speedSum,
      speedCount: previous.speedCount + c.speedCount,
      distanceM: previous.distanceM + distanceM(previous.last, c.start) + c.distanceM,
      last: c.last,
    };
    return {
      ...s,
      phase: 'over',
      belowSinceMs: null,
      aboveSinceMs: null,
      candidate: null,
      episode,
      previous: null,
    };
  }

  const id = episodeId(ctx.vehicleId, RULE, startMs, fix.source);
  const position = { lat: fix.lat, lng: fix.lng };
  effects.episode({
    op: 'open',
    id,
    ruleId: RULE,
    source: fix.source,
    tripId: fix.tripId,
    startedAt: startMs,
    anchor: c.start,
    metrics: { limitKmh: limit },
  });

  let raisedAlertId: string | null = null;
  const critical = c.maxSpeed >= limit + num(p, 'criticalOverKmh');
  if (fix.live) {
    const dedupeKey = `${RULE}:${ctx.vehicleId}:${fix.source}:${id}`;
    raisedAlertId = alertId(dedupeKey, startMs);
    effects.alert({
      op: 'raise',
      id: raisedAlertId,
      ruleId: RULE,
      severity: critical ? 'critical' : 'warning',
      audience: RULE_DEFAULTS[RULE]!.audience,
      title: `Overspeeding: ${Math.round(fix.speedKmh!)} km/h (limit ${limit})`,
      tripId: fix.tripId,
      episodeId: id,
      dedupeKey,
      occurredAt: startMs,
      payload: { limitKmh: limit, speedKmh: fix.speedKmh, maxSpeedKmh: c.maxSpeed, position },
    });
  }

  return {
    ...s,
    phase: 'over',
    aboveSinceMs: null,
    belowSinceMs: null,
    candidate: null,
    episode: {
      id,
      startMs,
      maxSpeed: c.maxSpeed,
      speedSum: c.speedSum,
      speedCount: c.speedCount,
      distanceM: c.distanceM,
      start: c.start,
      last: c.last,
      alertId: raisedAlertId,
      escalated: critical,
    },
  };
}

function end(s: OverspeedState, endMs: number, limit: number, effects: Effects): OverspeedState {
  const ep = s.episode!;
  const metrics = {
    limitKmh: limit,
    maxSpeedKmh: ep.maxSpeed,
    avgSpeedKmh: Math.round((ep.speedSum / ep.speedCount) * 10) / 10,
    durationS: Math.round((endMs - ep.startMs) / 1000),
    distanceM: Math.round(ep.distanceM),
    start: ep.start,
    end: ep.last,
  };
  effects.episode({ op: 'close', id: ep.id, endedAt: endMs, metrics });
  if (ep.alertId) {
    effects.alert({ op: 'update', id: ep.alertId, payload: metrics });
    effects.alert({ op: 'close', id: ep.alertId, reason: 'episode_ended' });
  }
  return { ...s, phase: 'none', belowSinceMs: null, episode: null, previous: { ...ep, endMs } };
}
