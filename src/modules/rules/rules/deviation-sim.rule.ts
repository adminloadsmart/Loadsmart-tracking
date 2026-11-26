import { alertId, distanceM, episodeId, num } from '../rule-helpers';
import { Effects, FixRule, RuleContext, RuleFix } from '../rule.types';
import { RULE_DEFAULTS } from '../defaults';
import { offRouteNotice } from './deviation-gps.rule';

export interface DeviationSimState {
  phase: 'on' | 'outside' | 'deviating';
  tripId: string | null;
  routeVersion: number | null;
  /** Consecutive pings outside the corridor (counting towards the start). */
  outsideCount: number;
  outsideSinceMs: number | null;
  /** Along-route position (primary route) where the truck was last on the route. */
  exitAlongM: number | null;
  lastInsideAlongM: number | null;
  startMs: number | null;
  episodeId: string | null;
  alertId: string | null;
  maxDistanceM: number;
  /** Straight-line distance between consecutive pings seen outside (understates winding roads). */
  offRouteM: number;
  /** Consecutive pings back inside 0.8 × corridor (counting towards the rejoin). */
  insideCount: number;
  insideSinceMs: number | null;
  insideAlongM: number | null;
  /** Pings in a row (while deviating) within haltRadiusM of `haltAnchor`: a halt off route. */
  haltAnchor: { lat: number; lng: number } | null;
  haltCount: number;
  escalated: boolean;
  lastFix: { t: number; lat: number; lng: number } | null;
  // Shared with DEV-GPS's LS_N_0028 off-route notice:
  farSinceMs: number | null;
  dropSamples: Array<{ t: number; m: number }>;
  notified: boolean;
}

const RULE = 'DEV-SIM' as const;

/**
 * DEV-SIM (rule sheet, docs/simrules.md): route deviation seen through SIM pings. "Same logic" as
 * DEV-GPS with a wider corridor, because tower positions are off by up to a few km.
 *  - d = shortest distance to the planned route or any approved alternate. Outside = d > 5,000 m.
 *    Pings within 5 km of origin or drop are ignored.
 *  - Starts when 2 consecutive pings are outside the corridor (one ping is never enough: tower
 *    jumps look like deviations). Start = the first of the two. A gap over 60 min restarts the
 *    count (never interpolate across a data gap to start a deviation).
 *  - Rejoin = 2 consecutive pings within 0.8 × corridor. Records max distance from the route,
 *    off-route km and duration; tagged back_track / shortcut / detour by where it rejoined.
 *  - Alert at start (Warning, only on a live ping; a buffered start raises it on the next live
 *    ping), Critical if the truck halts while off route (2 pings in a row within 2 km).
 *  - The LS_N_0028 "off route" notice is shared with DEV-GPS (15 km off for 45 min and heading
 *    away from the drop): the main backend sends it, since it does not read DEV alerts.
 *  - Only large deviations can be seen; a truck can leave and rejoin between two pings unseen.
 */
export const deviationSimRule: FixRule<DeviationSimState> = {
  id: RULE,
  sources: ['sim'],

  initial: () => ({
    phase: 'on',
    tripId: null,
    routeVersion: null,
    outsideCount: 0,
    outsideSinceMs: null,
    exitAlongM: null,
    lastInsideAlongM: null,
    startMs: null,
    episodeId: null,
    alertId: null,
    maxDistanceM: 0,
    offRouteM: 0,
    insideCount: 0,
    insideSinceMs: null,
    insideAlongM: null,
    haltAnchor: null,
    haltCount: 0,
    escalated: false,
    lastFix: null,
    farSinceMs: null,
    dropSamples: [],
    notified: false,
  }),

  onFix(state, fix, ctx, effects) {
    const p = ctx.params;
    const routes = ctx.route;
    const last = (s: DeviationSimState) => ({
      ...s,
      lastFix: { t: fix.t, lat: fix.lat, lng: fix.lng },
    });

    if (!fix.inTransit || !fix.tripId || !routes) {
      if (state.phase === 'deviating') close(state, fix.t, 'not_in_transit', null, effects);
      return last({ ...this.initial(), tripId: fix.tripId });
    }
    let s: DeviationSimState = {
      ...this.initial(),
      ...(state.tripId === fix.tripId ? state : { tripId: fix.tripId }),
    };

    // An approved alternate route (new version) is on-route by definition: re-judge from here.
    if (
      s.routeVersion !== null &&
      s.routeVersion !== routes.primary.version &&
      s.phase === 'outside'
    ) {
      s.phase = 'on';
      s.outsideCount = 0;
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
          outsideCount: 1,
          outsideSinceMs: fix.t,
          exitAlongM: s.lastInsideAlongM ?? along,
          maxDistanceM: d,
          // The leg that took it off the route counts as off-route distance: with pings this far
          // apart, the first leg is much of the detour (the tag compares it with the along gain).
          offRouteM: step,
        };
        if (s.outsideCount >= num(p, 'startPings')) s = start(s, fix, ctx, effects);
      } else {
        s.lastInsideAlongM = along;
      }
    } else if (s.phase === 'outside') {
      if (!outside) {
        // One ping outside is never a deviation.
        s = { ...s, phase: 'on', outsideCount: 0, outsideSinceMs: null, lastInsideAlongM: along };
      } else {
        if (gap) {
          // Don't count pings either side of a gap as consecutive: restart at this ping.
          s.outsideCount = 0;
          s.outsideSinceMs = fix.t;
        }
        s.outsideCount += 1;
        s.offRouteM += step;
        s.maxDistanceM = Math.max(s.maxDistanceM, d);
        if (s.outsideCount >= num(p, 'startPings')) s = start(s, fix, ctx, effects);
      }
    } else {
      // Deviating.
      s.maxDistanceM = Math.max(s.maxDistanceM, d);
      if (outside) s.offRouteM += step;
      if (!s.alertId && fix.live) s = raise(s, fix, ctx, effects); // a buffered start, now live

      if (d < corridor * num(p, 'rejoinFactor')) {
        if (s.insideCount === 0) {
          s.insideSinceMs = fix.t;
          s.insideAlongM = along;
        }
        s.insideCount += 1;
        if (s.insideCount >= num(p, 'rejoinPings')) {
          close(s, s.insideSinceMs!, 'rejoined', s.insideAlongM, effects);
          return last({
            ...this.initial(),
            tripId: s.tripId,
            routeVersion: s.routeVersion,
            lastInsideAlongM: along,
          });
        }
      } else {
        s.insideCount = 0;
        s.insideSinceMs = null;
        s.insideAlongM = null;
      }

      s = offRouteNotice(s, fix, d, gap, routes.primary.geometry.end, ctx, effects);

      // Halted while off route (pings in a row at the same spot) → Critical.
      if (s.haltAnchor && distanceM(s.haltAnchor, fix) <= num(p, 'haltRadiusM')) {
        s.haltCount += 1;
      } else {
        s.haltAnchor = { lat: fix.lat, lng: fix.lng };
        s.haltCount = 1;
      }
      if (!s.escalated && s.alertId && s.haltCount >= num(p, 'haltPings')) {
        s.escalated = true;
        effects.alert({
          op: 'escalate',
          id: s.alertId,
          severity: 'critical',
          payload: { haltedOffRoute: true },
        });
      }
    }
    return last(s);
  },
};

function start(
  s: DeviationSimState,
  fix: RuleFix,
  ctx: RuleContext,
  effects: Effects,
): DeviationSimState {
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
  const started: DeviationSimState = {
    ...s,
    phase: 'deviating',
    startMs,
    episodeId: id,
    alertId: null,
    insideCount: 0,
    insideSinceMs: null,
    insideAlongM: null,
    haltAnchor: { lat: fix.lat, lng: fix.lng },
    haltCount: 1,
    escalated: false,
  };
  return fix.live ? raise(started, fix, ctx, effects) : started;
}

function raise(
  s: DeviationSimState,
  fix: RuleFix,
  ctx: RuleContext,
  effects: Effects,
): DeviationSimState {
  const dedupeKey = `${RULE}:${ctx.vehicleId}:${fix.source}:${s.episodeId}`;
  const id = alertId(dedupeKey, s.startMs!);
  effects.alert({
    op: 'raise',
    id,
    ruleId: RULE,
    severity: 'warning',
    audience: RULE_DEFAULTS[RULE]!.audience,
    title: 'Vehicle deviated from the planned route',
    tripId: fix.tripId,
    episodeId: s.episodeId!,
    dedupeKey,
    occurredAt: s.startMs!,
    payload: {
      distanceFromRouteM: Math.round(s.maxDistanceM),
      position: { lat: fix.lat, lng: fix.lng },
    },
  });
  return { ...s, alertId: id };
}

function close(
  s: DeviationSimState,
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
