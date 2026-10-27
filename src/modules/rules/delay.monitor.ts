import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { MainDataRepository } from '../main-data';
import type { RouteStore } from '../routes/route.store';
import type { InTransitTrip, RoutesRepository } from '../routes/routes.repository';
import { RULE_DEFAULTS } from './defaults';
import { alreadyLateSeverity, evaluateDelay, lateNoticeDue, promisedTime } from './delay';
import { ruleStateKey, RuleEngine } from './rule-engine';
import { alertId, episodeId, noticeId, num } from './rule-helpers';
import { AlertChange, RulesRepository } from './rules.repository';
import type { ProgressState } from './rules/progress-gps.rule';
import { DelayCause, Effects, SEVERITY_RANK, Severity } from './rule.types';

const RULE = 'DELAY-GPS' as const;
export const tripEtaKey = (tripId: string) => `trk:trip:${tripId}:eta`;
const delayStateKey = (tripId: string) => `trk:delay:${tripId}`;
const OPEN_SET = 'trk:delay:open';
/** How long a company's LS_N_0030 limit (main's org setting) is cached. */
const THRESHOLD_TTL_MS = 5 * 60_000;

interface DelayState {
  lastEvalMs: number;
  consecWarn: number;
  consecCrit: number;
  consecClear: number;
  severity: Severity | null;
  alertId: string | null;
  episodeId: string | null;
  maxDelayMin: number;
  /** LS_N_0030: consecutive evaluations over the company's limit, the delay last notified (0 =
   *  none yet) and how many notices went out (the next notice's id). */
  lateConsec: number;
  lateNotifiedMin: number;
  lateCount: number;
}

const emptyState = (): DelayState => ({
  lastEvalMs: 0,
  consecWarn: 0,
  consecCrit: 0,
  consecClear: 0,
  severity: null,
  alertId: null,
  episodeId: null,
  maxDelayMin: 0,
  lateConsec: 0,
  lateNotifiedMin: 0,
  lateCount: 0,
});

/**
 * DELAY-GPS, time-driven half (scheduler leader): every 15 min per in-transit trip, project the
 * ETA from the progress the processor tracks (progress-gps.rule) and apply the sheet's alerting:
 *  - Warning at ≥ 60 min projected delay on 2 consecutive evaluations; Critical at ≥ 240;
 *  - "already late" (past promised, not delivered) alerts at once — even when the ETA is stale;
 *  - clears below 30 min on 2 consecutive evaluations, or on delivery;
 *  - last fix older than 60 min → keep the last ETA, mark it stale, no new projected-delay alert;
 *  - re-alert only when severity changes (escalation).
 * The latest ETA is kept in Redis for the trip API and the live map.
 *
 * LS_N_0030 "delivery will be late" (a trip notice for the main backend) rides on the same
 * evaluation: once the delay exceeds the company's limit (main's org setting, default 1 day) on
 * `consecutive` evaluations, then again only each time the delay doubles since the last notice.
 */
export class DelayMonitor {
  private readonly thresholdCache = new Map<string, { at: number; value: number }>();

  constructor(
    private readonly redis: Redis,
    private readonly routes: RoutesRepository,
    private readonly routeStore: RouteStore,
    private readonly rules: RulesRepository,
    private readonly engine: RuleEngine,
    private readonly logger: Logger,
    /** Reads the company's LS_N_0030 limit; without it the default applies. */
    private readonly mainData: MainDataRepository | null = null,
  ) {}

  async tick(nowMs = Date.now()): Promise<AlertChange[]> {
    const trips = await this.routes.inTransitTripsWithRoute();
    const routes = await this.routeStore.get(
      trips.map((t) => t.id),
      nowMs,
    );
    const changes: AlertChange[] = [];

    for (const trip of trips) {
      const tripRoutes = routes.get(trip.id);
      if (!tripRoutes) continue;
      try {
        changes.push(...(await this.evaluateTrip(trip, tripRoutes.primary, nowMs)));
      } catch (err) {
        this.logger.error({ err, tripId: trip.id }, 'Delay evaluation failed');
      }
    }

    // Delivered / no longer in transit: clear their open delay alerts.
    const inTransit = new Set(trips.map((t) => t.id));
    for (const member of await this.redis.smembers(OPEN_SET)) {
      const [tripId, tenantId, vehicleId] = member.split('|');
      if (inTransit.has(tripId)) continue;
      changes.push(...(await this.clear(tripId, tenantId, vehicleId, 'not_in_transit', nowMs)));
      await this.redis.srem(OPEN_SET, member);
    }
    return changes;
  }

  private async evaluateTrip(
    trip: InTransitTrip,
    primary: { version: number; geometry: { lengthM: number }; promisedAt: number | null },
    nowMs: number,
  ): Promise<AlertChange[]> {
    const setting = (await this.engine.settings(trip.tenant_id, nowMs)).get(RULE);
    if (!setting?.enabled) return [];
    const p = setting.params;

    const state: DelayState = {
      ...emptyState(),
      ...parseState(await this.redis.hgetall(delayStateKey(trip.id))),
    };
    if (nowMs - state.lastEvalMs < num(p, 'evaluateEveryMin') * 60_000) return [];
    state.lastEvalMs = nowMs;

    const progress = await this.progress(trip, primary.version);
    const startMs = trip.tracking_started_at?.getTime() ?? nowMs;
    const promisedMs = promisedTime(
      primary.promisedAt,
      trip.promised_delivery_at?.getTime() ?? null,
      startMs,
      primary.geometry.lengthM,
      p,
    );
    const stale =
      !progress?.lastFixMs || nowMs - progress.lastFixMs > num(p, 'staleAfterMin') * 60_000;
    const alreadyLate = nowMs > promisedMs;

    const estimate = evaluateDelay({
      nowMs,
      routeLengthM: primary.geometry.lengthM,
      startMs,
      promisedMs,
      progress,
      params: p,
    });
    if (stale) {
      await this.redis.hset(tripEtaKey(trip.id), { stale: '1', evaluatedAt: String(nowMs) });
    } else {
      await this.redis.hset(tripEtaKey(trip.id), {
        etaAt: String(Math.round(estimate.etaMs)),
        promisedAt: String(Math.round(promisedMs)),
        projectedDelayMin: String(estimate.delayMin),
        remainingKm: String(estimate.remainingKm),
        speedKmh: String(estimate.speedKmh),
        basis: estimate.basis,
        stale: '0',
        evaluatedAt: String(nowMs),
      });
    }

    const effects = new Effects();
    const delayMin = alreadyLate
      ? Math.max(estimate.delayMin, Math.round((nowMs - promisedMs) / 60_000))
      : estimate.delayMin;

    if (alreadyLate) {
      const severity = alreadyLateSeverity(delayMin, p);
      this.ensureSeverity(state, trip, severity, nowMs, delayMin, true, effects);
    } else if (!stale) {
      const level =
        delayMin >= num(p, 'criticalDelayMin')
          ? 'critical'
          : delayMin >= num(p, 'warningDelayMin')
            ? 'warning'
            : delayMin < num(p, 'clearDelayMin')
              ? 'clear'
              : 'hold';
      state.consecCrit = level === 'critical' ? state.consecCrit + 1 : 0;
      state.consecWarn = level === 'critical' || level === 'warning' ? state.consecWarn + 1 : 0;
      state.consecClear = level === 'clear' ? state.consecClear + 1 : 0;
      const needed = num(p, 'consecutive');
      if (state.consecCrit >= needed)
        this.ensureSeverity(state, trip, 'critical', nowMs, delayMin, false, effects);
      else if (state.consecWarn >= needed)
        this.ensureSeverity(state, trip, 'warning', nowMs, delayMin, false, effects);
      else if (state.consecClear >= needed && state.alertId) {
        this.closeOpen(state, nowMs, 'delay_cleared', effects);
        await this.redis.srem(OPEN_SET, `${trip.id}|${trip.tenant_id}|${trip.vehicle_id}`);
      }
    }
    if (state.alertId) state.maxDelayMin = Math.max(state.maxDelayMin, delayMin);
    if (!stale || alreadyLate) {
      await this.lateNotice(state, trip, {
        delayMin,
        etaMs: stale ? null : estimate.etaMs,
        promisedMs,
        speedKmh: estimate.speedKmh,
        nowMs,
        params: p,
        effects,
      });
    }

    const changes = await this.rules.applyEffects([
      {
        tenantId: trip.tenant_id,
        vehicleId: trip.vehicle_id,
        episodes: effects.episodes,
        alerts: effects.alerts,
        notices: effects.notices,
      },
    ]);
    await this.redis.hset(delayStateKey(trip.id), serializeState(state));
    if (state.alertId)
      await this.redis.sadd(OPEN_SET, `${trip.id}|${trip.tenant_id}|${trip.vehicle_id}`);
    return changes;
  }

  private ensureSeverity(
    state: DelayState,
    trip: InTransitTrip,
    severity: Severity,
    nowMs: number,
    delayMin: number,
    alreadyLate: boolean,
    effects: Effects,
  ): void {
    const payload = { projectedDelayMin: delayMin, alreadyLate };
    if (!state.alertId) {
      state.episodeId = episodeId(trip.vehicle_id, RULE, nowMs, trip.id);
      effects.episode({
        op: 'open',
        id: state.episodeId,
        ruleId: RULE,
        source: 'driver_app',
        tripId: trip.id,
        startedAt: nowMs,
        metrics: payload,
      });
      const dedupeKey = `${RULE}:${trip.id}`;
      state.alertId = alertId(dedupeKey, nowMs);
      state.severity = severity;
      effects.alert({
        op: 'raise',
        id: state.alertId,
        ruleId: RULE,
        severity,
        audience: RULE_DEFAULTS[RULE]!.audience,
        title: alreadyLate
          ? 'Delivery is already late'
          : `Projected delivery delay of ${delayMin} min`,
        tripId: trip.id,
        episodeId: state.episodeId,
        dedupeKey,
        occurredAt: nowMs,
        payload,
      });
    } else if (SEVERITY_RANK[severity] > SEVERITY_RANK[state.severity ?? 'info']) {
      state.severity = severity;
      effects.alert({ op: 'escalate', id: state.alertId, severity, payload });
    } else {
      effects.alert({ op: 'update', id: state.alertId, payload });
    }
  }

  /** LS_N_0030: once over the company's limit, then only each time the delay doubles. */
  private async lateNotice(
    state: DelayState,
    trip: InTransitTrip,
    input: {
      delayMin: number;
      etaMs: number | null;
      promisedMs: number;
      speedKmh: number;
      nowMs: number;
      params: Record<string, number | boolean | string>;
      effects: Effects;
    },
  ): Promise<void> {
    const { delayMin, nowMs, params: p } = input;
    const threshold = await this.lateThresholdMin(
      trip.tenant_id,
      num(p, 'lateNoticeDefaultMin'),
      nowMs,
    );
    const next = lateNoticeDue(state, delayMin, threshold, num(p, 'consecutive'));
    state.lateConsec = next.lateConsec;
    if (!next.due) return;

    const causes = await this.rules.tripDelayCauses(trip.id);
    const minCauseMin = num(p, 'lateCauseMinMin');
    const cause: { delayCause: DelayCause; causeMin: number | null } =
      causes.haltMin >= minCauseMin && causes.haltMin >= causes.deviationMin
        ? { delayCause: 'halts', causeMin: causes.haltMin }
        : causes.deviationMin >= minCauseMin
          ? { delayCause: 'deviation', causeMin: causes.deviationMin }
          : { delayCause: 'slow_progress', causeMin: null };
    input.effects.notice({
      id: noticeId(trip.id, `delivery_late|${state.lateCount + 1}`),
      type: 'trip.delivery_late',
      tripId: trip.id,
      payload: {
        delayMin,
        etaAt: input.etaMs === null ? null : new Date(Math.round(input.etaMs)).toISOString(),
        promisedAt: new Date(Math.round(input.promisedMs)).toISOString(),
        ...cause,
        speedKmh: Math.round(input.speedKmh),
        sequence: state.lateCount + 1,
        occurredAt: new Date(nowMs).toISOString(),
      },
    });
    state.lateNotifiedMin = delayMin;
    state.lateCount += 1;
  }

  private async lateThresholdMin(
    tenantId: string,
    defaultMin: number,
    nowMs: number,
  ): Promise<number> {
    const cached = this.thresholdCache.get(tenantId);
    if (cached && nowMs - cached.at < THRESHOLD_TTL_MS) return cached.value;
    let value = defaultMin;
    try {
      value = (await this.mainData?.lateDeliveryThresholdMin(tenantId)) ?? value;
    } catch (err) {
      // e.g. main's migration adding the column hasn't run yet — the default still applies.
      this.logger.warn({ err, tenantId }, 'Late-delivery limit lookup failed; using the default');
    }
    this.thresholdCache.set(tenantId, { at: nowMs, value });
    return value;
  }

  private closeOpen(state: DelayState, nowMs: number, reason: string, effects: Effects): void {
    if (state.episodeId) {
      effects.episode({
        op: 'close',
        id: state.episodeId,
        endedAt: nowMs,
        metrics: { maxDelayMin: state.maxDelayMin, endReason: reason },
      });
    }
    if (state.alertId) effects.alert({ op: 'close', id: state.alertId, reason });
    // LS_N_0030's memory outlives the alert: a later notice still needs the delay to double.
    Object.assign(state, {
      ...emptyState(),
      lastEvalMs: state.lastEvalMs,
      lateConsec: state.lateConsec,
      lateNotifiedMin: state.lateNotifiedMin,
      lateCount: state.lateCount,
    });
  }

  private async clear(
    tripId: string,
    tenantId: string,
    vehicleId: string,
    reason: string,
    nowMs: number,
  ) {
    const state: DelayState = {
      ...emptyState(),
      ...parseState(await this.redis.hgetall(delayStateKey(tripId))),
    };
    const effects = new Effects();
    this.closeOpen(state, nowMs, reason, effects);
    const changes = await this.rules.applyEffects([
      {
        tenantId,
        vehicleId,
        episodes: effects.episodes,
        alerts: effects.alerts,
        notices: effects.notices,
      },
    ]);
    await this.redis.del(delayStateKey(tripId));
    return changes;
  }

  /** The freshest progress for the trip's current route version, from any GPS source. */
  private async progress(trip: InTransitTrip, routeVersion: number): Promise<ProgressState | null> {
    const fields = await this.redis.hmget(
      ruleStateKey(trip.vehicle_id),
      `${RULE}|driver_app`,
      `${RULE}|blackrock`,
    );
    const candidates = fields
      .filter((v): v is string => !!v)
      .map((v) => JSON.parse(v) as ProgressState)
      .filter((p) => p.tripId === trip.id && p.routeVersion === routeVersion);
    return candidates.sort((a, b) => (b.lastFixMs ?? 0) - (a.lastFixMs ?? 0))[0] ?? null;
  }
}

function parseState(raw: Record<string, string>): Partial<DelayState> {
  if (!raw.lastEvalMs) return {};
  return {
    lastEvalMs: Number(raw.lastEvalMs),
    consecWarn: Number(raw.consecWarn),
    consecCrit: Number(raw.consecCrit),
    consecClear: Number(raw.consecClear),
    severity: (raw.severity || null) as Severity | null,
    alertId: raw.alertId || null,
    episodeId: raw.episodeId || null,
    maxDelayMin: Number(raw.maxDelayMin || 0),
    lateConsec: Number(raw.lateConsec || 0),
    lateNotifiedMin: Number(raw.lateNotifiedMin || 0),
    lateCount: Number(raw.lateCount || 0),
  };
}

function serializeState(s: DelayState): Record<string, string> {
  return {
    lastEvalMs: String(s.lastEvalMs),
    consecWarn: String(s.consecWarn),
    consecCrit: String(s.consecCrit),
    consecClear: String(s.consecClear),
    severity: s.severity ?? '',
    alertId: s.alertId ?? '',
    episodeId: s.episodeId ?? '',
    maxDelayMin: String(s.maxDelayMin),
    lateConsec: String(s.lateConsec),
    lateNotifiedMin: String(s.lateNotifiedMin),
    lateCount: String(s.lateCount),
  };
}
