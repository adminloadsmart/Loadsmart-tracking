import { alertId, distanceM, episodeId, num } from '../rule-helpers';
import type { Anchor, FixRule, RuleContext, RuleFix, Effects } from '../rule.types';
import { RULE_DEFAULTS } from '../defaults';

export interface HaltSimState {
  tripId: string | null;
  /** First ping of the cluster: every later ping is judged by its distance from here. */
  anchor: Anchor | null;
  startMs: number;
  /** Consecutive pings inside the radius, the anchor ping included. */
  inRadius: number;
  /** Capture time of the last ping inside the radius (the recorded end of the halt). */
  lastInMs: number;
  confirmed: boolean;
  alerted: boolean;
  episodeId: string | null;
  alertId: string | null;
  lastFix: { t: number; lat: number; lng: number } | null;
}

/**
 * HALT-SIM (rule sheet, docs/simrules.md): a trip-level stop while in transit, seen through SIM
 * (cell-tower) pings that come every ~15-20 min with no speed.
 *
 *  - Evaluated only while the trip is in transit.
 *  - A ping is "halted" if it is within `haltRadiusM` (2,000 m) of the anchor = the first ping of
 *    the cluster. Tower hand-over moves a parked phone 1-3 km, so the radius sits above that.
 *  - Halt start = first ping of the cluster. Confirmed (episode recorded, alert raised) when
 *    `confirmPings` (2) consecutive pings are inside the radius: the shortest visible halt.
 *  - Ends at the first ping more than the radius from the anchor; the end is recorded as the last
 *    in-radius ping. No clubbing: the wide radius absorbs stop-start movement.
 *  - Silence longer than `gapS` (60 min) is "No data", not a halt, unless the pings either side
 *    are inside the radius (then the halt simply continues).
 *  - The alert is raised only on a live ping (the one addition to the sheet): a stale ping must not
 *    announce "stopped" for where the truck was hours ago.
 */
export const haltSimRule: FixRule<HaltSimState> = {
  id: 'HALT-SIM',
  sources: ['sim'],

  initial: () => ({
    tripId: null,
    anchor: null,
    startMs: 0,
    inRadius: 0,
    lastInMs: 0,
    confirmed: false,
    alerted: false,
    episodeId: null,
    alertId: null,
    lastFix: null,
  }),

  onFix(state, fix, ctx, effects) {
    const p = ctx.params;
    let s: HaltSimState = { ...this.initial(), ...state };

    // Only while the trip is in transit.
    if (!fix.inTransit || !fix.tripId) {
      if (s.confirmed) endHalt(s, s.lastInMs, 'not_in_transit', effects);
      return { ...this.initial(), lastFix: point(fix) };
    }
    // A different trip starts clean.
    if (s.tripId && s.tripId !== fix.tripId) {
      if (s.confirmed) endHalt(s, s.lastInMs, 'trip_changed', effects);
      s = { ...this.initial(), lastFix: s.lastFix };
    }
    s.tripId = fix.tripId;

    if (s.anchor && distanceM(s.anchor, fix) <= num(p, 'haltRadiusM')) {
      // Another ping at the same spot (also after a gap: both sides are inside the radius).
      s.inRadius += 1;
      s.lastInMs = fix.t;
    } else {
      if (s.anchor && s.confirmed) {
        const gap = s.lastFix ? fix.t - s.lastFix.t : 0;
        endHalt(s, s.lastInMs, gap > num(p, 'gapS') * 1000 ? 'data_gap' : 'left_anchor', effects);
      }
      // This ping starts a new cluster (it may be the first of a halt).
      s = {
        ...this.initial(),
        tripId: fix.tripId,
        anchor: { lat: fix.lat, lng: fix.lng },
        startMs: fix.t,
        inRadius: 1,
        lastInMs: fix.t,
        lastFix: s.lastFix,
      };
    }

    if (!s.confirmed && s.inRadius >= num(p, 'confirmPings')) {
      s.confirmed = true;
      s.episodeId = episodeId(ctx.vehicleId, 'HALT-SIM', s.startMs, fix.source);
      effects.episode({
        op: 'open',
        id: s.episodeId,
        ruleId: 'HALT-SIM',
        source: fix.source,
        tripId: s.tripId,
        startedAt: s.startMs,
        anchor: s.anchor,
      });
    }

    if (s.confirmed && !s.alerted && fix.live) raiseAlert(s, fix, ctx, effects);

    s.lastFix = point(fix);
    return s;
  },
};

function raiseAlert(s: HaltSimState, fix: RuleFix, ctx: RuleContext, effects: Effects) {
  s.alerted = true;
  const dedupeKey = `HALT-SIM:${ctx.vehicleId}:${fix.source}:${s.episodeId}`;
  s.alertId = alertId(dedupeKey, s.startMs);
  effects.alert({
    op: 'raise',
    id: s.alertId,
    ruleId: 'HALT-SIM',
    severity: 'warning',
    audience: RULE_DEFAULTS['HALT-SIM']!.audience,
    title: `Vehicle halted for ${Math.max(1, Math.floor((fix.t - s.startMs) / 60_000))}+ minutes`,
    tripId: s.tripId,
    episodeId: s.episodeId!,
    dedupeKey,
    occurredAt: s.startMs,
    payload: {
      haltStartedAt: new Date(s.startMs).toISOString(),
      anchor: s.anchor,
      source: fix.source,
    },
  });
}

function endHalt(s: HaltSimState, endMs: number, reason: string, effects: Effects) {
  if (s.episodeId) {
    effects.episode({
      op: 'close',
      id: s.episodeId,
      endedAt: endMs,
      anchor: s.anchor,
      metrics: { durationS: Math.round((endMs - s.startMs) / 1000), endReason: reason },
      tags: [],
    });
  }
  if (s.alertId) effects.alert({ op: 'close', id: s.alertId, reason: `halt_ended:${reason}` });
}

const point = (fix: RuleFix) => ({ t: fix.t, lat: fix.lat, lng: fix.lng });
