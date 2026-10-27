import { alertId, distanceM, episodeId, noticeId, num } from '../rule-helpers';
import { Effects, FixRule, RuleContext, RuleFix } from '../rule.types';
import { RULE_DEFAULTS } from '../defaults';

export interface DeviationState {
  phase: 'on' | 'outside' | 'deviating';
  tripId: string | null;
  routeVersion: number | null;
  outsideSinceMs: number | null;
  outsideDistanceM: number;
  /** Along-route position (primary route) where the truck left the corridor. */
  exitAlongM: number | null;
  lastInsideAlongM: number | null;
  startMs: number | null;
  episodeId: string | null;
  alertId: string | null;
  maxDistanceM: number;
  offRouteM: number;
  insideSinceMs: number | null;
  /** Along-route position where the truck came back inside (the rejoin point). */
  insideAlongM: number | null;
  slowSinceMs: number | null;
  escalated: boolean;
  lastFix: { t: number; lat: number; lng: number } | null;
  /** Since when the truck has been further than notifyOffRouteM from every route (LS_N_0028). */
  farSinceMs?: number | null;
  /** Straight-line distance to the drop, sampled about once a minute while deviating. */
  dropSamples?: Array<{ t: number; m: number }>;
  /** The LS_N_0028 notice went out for this deviation — one per deviation, re-armed on rejoin. */
  notified?: boolean;
}

const RULE = 'DEV-GPS' as const;
/** How often the straight-line distance to the drop is sampled for LS_N_0028's "heading away". */
const DROP_SAMPLE_EVERY_MS = 60_000;

/**
 * DEV-GPS (rule sheet): route deviation while in transit.
 *  - d = shortest distance to the planned route OR any approved alternate. Outside = d > 1 km.
 *    Fixes within 5 km of origin or drop are ignored (yards, parking, last mile).
 *  - Starts after 15 min outside, OR 5 km driven outside the corridor — so brief turns, median
 *    U-turns and jitter don't fire. Never interpolated across a data gap.
 *  - Rejoin = d < 0.8 × corridor held 2 min; records max distance, off-route km and duration,
 *    tagged back-track / shortcut / detour by where it rejoined along the route.
 *  - Alert at start (Warning), Critical if the truck halts while off route.
 *  - LS_N_0028 notice (main backend "off route", one per deviation): further than 15 km from
 *    every route for 45 min without a break, AND heading away from the drop — the straight-line
 *    distance to it is larger than 15 min earlier. Service roads, toll bypasses and diversions
 *    that still close in on the drop don't qualify.
 */
export const deviationGpsRule: FixRule<DeviationState> = {
  id: RULE,
  sources: ['driver_app', 'roadcast'],

  initial: () => ({
    phase: 'on',
    tripId: null,
    routeVersion: null,
    outsideSinceMs: null,
    outsideDistanceM: 0,
    exitAlongM: null,
    lastInsideAlongM: null,
    startMs: null,
    episodeId: null,
    alertId: null,
    maxDistanceM: 0,
    offRouteM: 0,
    insideSinceMs: null,
    insideAlongM: null,
    slowSinceMs: null,
    escalated: false,
    lastFix: null,
    farSinceMs: null,
    dropSamples: [],
    notified: false,
  }),

  onFix(state, fix, ctx, effects) {
    const p = ctx.params;
    const routes = ctx.route;
    const last = (s: DeviationState) => ({
      ...s,
      lastFix: { t: fix.t, lat: fix.lat, lng: fix.lng },
    });

    if (!fix.inTransit || !fix.tripId || !routes) {
      if (state.phase === 'deviating') close(state, fix.t, 'not_in_transit', null, effects);
      return last({ ...this.initial(), tripId: fix.tripId });
    }
    let s: DeviationState =
      state.tripId === fix.tripId ? { ...state } : { ...this.initial(), tripId: fix.tripId };

    // An approved alternate route (new version) is on-route by definition: re-judge from here.
    if (
      s.routeVersion !== null &&
      s.routeVersion !== routes.primary.version &&
      s.phase === 'outside'
    ) {
      s.phase = 'on';
      s.outsideSinceMs = null;
    }
    s.routeVersion = routes.primary.version;

    if (routes.nearEndsM(fix, num(p, 'ignoreNearEndsM'))) return last(s);

    const d = routes.distanceToAnyM(fix);
    const along = routes.primary.geometry.project(fix).alongM;
    const corridor = num(p, 'corridorM');
    const outside = d > corridor;
    const gap = s.lastFix ? fix.t - s.lastFix.t > num(p, 'gapS') * 1000 : false;
    const step = s.lastFix && !gap ? distanceM(s.lastFix, fix) : 0;

    if (s.phase === 'on') {
      if (outside) {
        s = {
          ...s,
          phase: 'outside',
          outsideSinceMs: fix.t,
          outsideDistanceM: 0,
          exitAlongM: s.lastInsideAlongM ?? along,
          maxDistanceM: d,
        };
      } else {
        s.lastInsideAlongM = along;
      }
    } else if (s.phase === 'outside') {
      if (!outside) {
        s = {
          ...s,
          phase: 'on',
          outsideSinceMs: null,
          outsideDistanceM: 0,
          lastInsideAlongM: along,
        };
      } else {
        if (gap) {
          // Don't count time/distance we didn't see: restart the clock at this fix.
          s.outsideSinceMs = fix.t;
          s.outsideDistanceM = 0;
        }
        s.outsideDistanceM += step;
        s.maxDistanceM = Math.max(s.maxDistanceM, d);
        if (
          fix.t - s.outsideSinceMs! >= num(p, 'startAfterS') * 1000 ||
          s.outsideDistanceM >= num(p, 'startAfterOutsideM')
        ) {
          s = start(s, fix, ctx, effects);
        }
      }
    } else {
      // Deviating.
      s.maxDistanceM = Math.max(s.maxDistanceM, d);
      if (outside) s.offRouteM += step;

      if (d < corridor * num(p, 'rejoinFactor')) {
        if (s.insideSinceMs === null) {
          s.insideSinceMs = fix.t;
          s.insideAlongM = along;
        }
        if (fix.t - s.insideSinceMs >= num(p, 'rejoinHoldS') * 1000) {
          close(s, s.insideSinceMs, 'rejoined', s.insideAlongM, effects);
          return last({
            ...this.initial(),
            tripId: s.tripId,
            routeVersion: s.routeVersion,
            lastInsideAlongM: along,
          });
        }
      } else {
        s.insideSinceMs = null;
        s.insideAlongM = null;
      }

      s = offRouteNotice(s, fix, d, gap, routes.primary.geometry.end, ctx, effects);

      // Halted while off route → Critical.
      if (fix.speedKmh !== null && fix.speedKmh < num(p, 'haltSpeedKmh')) {
        s.slowSinceMs = s.slowSinceMs ?? fix.t;
        if (!s.escalated && s.alertId && fix.t - s.slowSinceMs >= num(p, 'haltHoldS') * 1000) {
          s.escalated = true;
          effects.alert({
            op: 'escalate',
            id: s.alertId,
            severity: 'critical',
            payload: { haltedOffRoute: true },
          });
        }
      } else {
        s.slowSinceMs = null;
      }
    }
    return last(s);
  },
};

/** LS_N_0028: far off route for long enough and moving away from the drop → one notice. */
function offRouteNotice(
  state: DeviationState,
  fix: RuleFix,
  d: number,
  gap: boolean,
  drop: { lat: number; lng: number },
  ctx: RuleContext,
  effects: Effects,
): DeviationState {
  const p = ctx.params;
  const s = { ...state };
  const toDropM = distanceM(fix, drop);
  const windowMs = num(p, 'notifyAwayWindowS') * 1000;
  // A data gap breaks "continuously" — the clock restarts at the first fix after it.
  const farSince = d > num(p, 'notifyOffRouteM') ? (gap ? fix.t : (s.farSinceMs ?? fix.t)) : null;
  const samples = (s.dropSamples ?? []).filter((x) => fix.t - x.t <= 2 * windowMs);
  const lastSample = samples[samples.length - 1];
  if (!lastSample || fix.t - lastSample.t >= DROP_SAMPLE_EVERY_MS) {
    samples.push({ t: fix.t, m: Math.round(toDropM) });
  }
  s.farSinceMs = farSince;
  s.dropSamples = samples;

  if (s.notified || !fix.live || !fix.tripId || farSince === null) return s;
  if (fix.t - farSince < num(p, 'notifyAfterS') * 1000) return s;
  // The newest sample at least one window old: was the truck closer to the drop back then?
  const earlier = [...samples].reverse().find((x) => fix.t - x.t >= windowMs);
  if (!earlier || toDropM <= earlier.m) return s;

  effects.notice({
    id: noticeId(fix.tripId, `route_deviation|${s.episodeId ?? s.startMs}`),
    type: 'trip.route_deviation',
    tripId: fix.tripId,
    payload: {
      distanceOffKm: Math.round(d / 100) / 10,
      deviationStartedAt: new Date(s.startMs ?? farSince).toISOString(),
      lat: fix.lat,
      lng: fix.lng,
      occurredAt: new Date(fix.t).toISOString(),
    },
  });
  return { ...s, notified: true };
}

function start(
  s: DeviationState,
  fix: RuleFix,
  ctx: RuleContext,
  effects: Effects,
): DeviationState {
  const startMs = s.outsideSinceMs!;
  const id = episodeId(ctx.vehicleId, RULE, startMs, fix.source);
  effects.episode({
    op: 'open',
    id,
    ruleId: RULE,
    source: fix.source,
    tripId: fix.tripId,
    startedAt: startMs,
    anchor: { lat: fix.lat, lng: fix.lng },
  });
  let raised: string | null = null;
  if (fix.live) {
    const dedupeKey = `${RULE}:${ctx.vehicleId}:${fix.source}:${id}`;
    raised = alertId(dedupeKey, startMs);
    effects.alert({
      op: 'raise',
      id: raised,
      ruleId: RULE,
      severity: 'warning',
      audience: RULE_DEFAULTS[RULE]!.audience,
      title: 'Vehicle deviated from the planned route',
      tripId: fix.tripId,
      episodeId: id,
      dedupeKey,
      occurredAt: startMs,
      payload: {
        distanceFromRouteM: Math.round(s.maxDistanceM),
        position: { lat: fix.lat, lng: fix.lng },
      },
    });
  }
  return {
    ...s,
    phase: 'deviating',
    startMs,
    episodeId: id,
    alertId: raised,
    offRouteM: s.outsideDistanceM,
    insideSinceMs: null,
    slowSinceMs: null,
    escalated: false,
  };
}

function close(
  s: DeviationState,
  endMs: number,
  reason: string,
  rejoinAlongM: number | null,
  effects: Effects,
): void {
  if (!s.episodeId) return;
  const tag =
    rejoinAlongM === null || s.exitAlongM === null
      ? reason
      : rejoinAlongM < s.exitAlongM - 1000
        ? 'back_track'
        : // Shortcut = gained clearly more route than it drove off route (a parallel road is a detour).
          rejoinAlongM - s.exitAlongM > s.offRouteM * 1.1 + 500
          ? 'shortcut'
          : 'detour';
  const metrics = {
    maxDistanceM: Math.round(s.maxDistanceM),
    offRouteKm: Math.round(s.offRouteM / 100) / 10,
    durationS: Math.round((endMs - s.startMs!) / 1000),
    endReason: reason,
  };
  effects.episode({ op: 'close', id: s.episodeId, endedAt: endMs, metrics, tags: [tag] });
  if (s.alertId) {
    effects.alert({ op: 'update', id: s.alertId, payload: { ...metrics, rejoinTag: tag } });
    effects.alert({ op: 'close', id: s.alertId, reason });
  }
}
