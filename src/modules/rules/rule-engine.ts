import type Redis from 'ioredis';
import type { ChainableCommander } from 'ioredis';
import type { Logger } from 'pino';
import type { PointSource } from '../points';
import type { ProcessedPoint } from '../processing/pipeline';
import type { ActiveTripIndex } from '../sync';
import { mergeParams, RULE_DEFAULTS } from './defaults';
import { AlertChange, RulesRepository, VehicleEffects } from './rules.repository';
import { Effects, FixRule, RuleContext, RuleFix, RuleId } from './rule.types';

/** Per-vehicle rule state: one hash per vehicle, one field per rule|source. */
export const ruleStateKey = (vehicleId: string) => `trk:rules:${vehicleId}`;
/** Last packet per source (ZSET, score = device time) — read by the inactivity monitor. */
export const lastSeenKey = (source: PointSource) => `trk:rules:lastseen:${source}`;
/** Set by the inactivity monitor while a vehicle/source is inactive; cleared on the next fix. */
export const inactiveFlagKey = (vehicleId: string, source: PointSource) =>
  `trk:rules:inactive:${vehicleId}:${source}`;

/** Fixes older than this when processed are "buffered": recorded, but raise no alert. */
const LIVE_WINDOW_MS = 10 * 60_000;
const SETTINGS_TTL_MS = 60_000;
const PROFILE_TTL_MS = 5 * 60_000;

export interface RuleEvaluation {
  effects: VehicleEffects[];
  /** Adds the rule-state writes to the caller's Redis transaction (with the vehicle state). */
  writeState(multi: ChainableCommander): void;
}

type ResolvedSettings = Map<RuleId, { enabled: boolean; params: RuleContext['params'] }>;

/**
 * Runs the rule-sheet state machines over each processed batch (docs/rules.md).
 *
 * Called by the point processor after a batch is stored: per vehicle, the accepted non-late
 * fixes go through every enabled rule for their source, in device-time order. State is loaded
 * from and written back to Redis in the same MULTI as the vehicle state, effects are applied to
 * Postgres in one transaction, so a redelivered batch recomputes identical, idempotent effects.
 */
export class RuleEngine {
  private readonly settingsCache = new Map<string, { at: number; value: ResolvedSettings }>();
  private readonly profileCache = new Map<string, { at: number; bodyType: string | null }>();

  constructor(
    private readonly rules: FixRule[],
    private readonly repository: RulesRepository,
    private readonly redis: Redis,
    private readonly activeTrips: ActiveTripIndex,
    private readonly logger: Logger,
  ) {}

  async evaluate(points: ProcessedPoint[], nowMs: number): Promise<RuleEvaluation> {
    const accepted = points
      .filter(({ rejected, point }) => !rejected && !point.flags?.late)
      .map(({ point }) => point);
    const byVehicle = new Map<string, typeof accepted>();
    for (const point of accepted) {
      byVehicle.set(point.vehicleId, [...(byVehicle.get(point.vehicleId) ?? []), point]);
    }
    if (byVehicle.size === 0) return { effects: [], writeState: () => undefined };

    const vehicleIds = [...byVehicle.keys()];
    const tripIds = [...new Set(accepted.map((p) => p.tripId).filter((id): id is string => !!id))];
    const [loadStatuses, profiles, stored, inactiveFlags] = await Promise.all([
      this.activeTrips.getLoadStatuses(tripIds),
      this.profiles(vehicleIds, nowMs),
      this.loadStates(vehicleIds),
      this.loadInactiveFlags(accepted.map((p) => [p.vehicleId, p.source] as const)),
    ]);

    const effects: VehicleEffects[] = [];
    const nextStates = new Map<string, Record<string, string>>();
    const lastSeen: Array<{ source: PointSource; member: string; t: number }> = [];
    const clearedFlags: string[] = [];

    for (const [vehicleId, vehiclePoints] of byVehicle) {
      const tenantId = vehiclePoints[0].tenantId;
      const settings = await this.settings(tenantId, nowMs);
      const state = { ...stored.get(vehicleId) };
      const vehicleEffects = new Effects();
      const ordered = [...vehiclePoints].sort(
        (a, b) => Date.parse(a.recordedAt) - Date.parse(b.recordedAt),
      );

      for (const point of ordered) {
        const t = Date.parse(point.recordedAt);
        const fix: RuleFix = {
          t,
          lat: point.lat,
          lng: point.lng,
          speedKmh: point.speedKmh ?? null,
          source: point.source,
          tripId: point.tripId ?? null,
          inTransit: !!point.tripId && loadStatuses.get(point.tripId) === 'in_transit',
          live: !point.flags?.supplementary && nowMs - t <= LIVE_WINDOW_MS,
          ignition: typeof point.flags?.ignition === 'boolean' ? point.flags.ignition : null,
          accuracyM: point.accuracyM ?? null,
          satellites: typeof point.flags?.satellites === 'number' ? point.flags.satellites : null,
          gpsPositioned:
            typeof point.flags?.gpsPositioned === 'boolean' ? point.flags.gpsPositioned : null,
        };

        for (const rule of this.rules) {
          const setting = settings.get(rule.id);
          if (!setting?.enabled || !rule.sources.includes(fix.source)) continue;
          const field = `${rule.id}|${fix.source}`;
          const ctx: RuleContext = {
            tenantId,
            vehicleId,
            nowMs,
            params: setting.params,
            vehicle: { bodyType: profiles.get(vehicleId) ?? null },
          };
          const previous = state[field] ? JSON.parse(state[field]) : rule.initial();
          state[field] = JSON.stringify(rule.onFix(previous, fix, ctx, vehicleEffects));
        }
      }

      // Data resumed after an inactivity alert (INACT-GPS / INACT-SIM): close it at the first fix.
      for (const source of new Set(ordered.map((p) => p.source))) {
        const flag = inactiveFlags.get(inactiveFlagKey(vehicleId, source));
        if (flag) {
          const firstFix = ordered.find((p) => p.source === source)!;
          const endedAt = Date.parse(firstFix.recordedAt);
          vehicleEffects.episode({
            op: 'close',
            id: flag.episodeId,
            endedAt,
            metrics: { durationS: Math.round((endedAt - Number(flag.startedAt)) / 1000) },
          });
          if (flag.alertId)
            vehicleEffects.alert({ op: 'close', id: flag.alertId, reason: 'data_resumed' });
          clearedFlags.push(inactiveFlagKey(vehicleId, source));
        }
        const newest = ordered.filter((p) => p.source === source).at(-1)!;
        lastSeen.push({
          source,
          member: `${vehicleId}|${tenantId}`,
          t: Date.parse(newest.recordedAt),
        });
      }

      nextStates.set(vehicleId, state);
      if (!vehicleEffects.empty) {
        effects.push({
          tenantId,
          vehicleId,
          episodes: vehicleEffects.episodes,
          alerts: vehicleEffects.alerts,
        });
      }
    }

    return {
      effects,
      writeState: (multi) => {
        for (const [vehicleId, state] of nextStates) {
          if (Object.keys(state).length > 0) multi.hset(ruleStateKey(vehicleId), state);
        }
        // GT: never move last-seen backwards (late batches).
        for (const { source, member, t } of lastSeen)
          multi.zadd(lastSeenKey(source), 'GT', t, member);
        if (clearedFlags.length > 0) multi.del(...clearedFlags);
      },
    };
  }

  /** Applies effects to Postgres (one transaction); returns alert changes for /live. */
  apply(evaluation: RuleEvaluation): Promise<AlertChange[]> {
    return this.repository.applyEffects(evaluation.effects);
  }

  private async loadStates(vehicleIds: string[]): Promise<Map<string, Record<string, string>>> {
    const pipeline = this.redis.pipeline();
    for (const id of vehicleIds) pipeline.hgetall(ruleStateKey(id));
    const results = (await pipeline.exec()) ?? [];
    return new Map(
      vehicleIds.map((id, i) => {
        const [err, value] = results[i] ?? [];
        if (err) throw err;
        return [id, (value as Record<string, string>) ?? {}];
      }),
    );
  }

  private async loadInactiveFlags(
    pairs: ReadonlyArray<readonly [string, PointSource]>,
  ): Promise<Map<string, Record<string, string>>> {
    const keys = [
      ...new Set(pairs.map(([vehicleId, source]) => inactiveFlagKey(vehicleId, source))),
    ];
    if (keys.length === 0) return new Map();
    const pipeline = this.redis.pipeline();
    for (const key of keys) pipeline.hgetall(key);
    const results = (await pipeline.exec()) ?? [];
    const flags = new Map<string, Record<string, string>>();
    keys.forEach((key, i) => {
      const value = results[i]?.[1] as Record<string, string> | undefined;
      if (value?.episodeId) flags.set(key, value);
    });
    return flags;
  }

  /** Sheet defaults merged with the tenant's overrides; cached briefly per tenant. */
  async settings(tenantId: string, nowMs: number): Promise<ResolvedSettings> {
    const cached = this.settingsCache.get(tenantId);
    if (cached && nowMs - cached.at < SETTINGS_TTL_MS) return cached.value;
    const overrides = new Map(
      (await this.repository.loadSettings(tenantId)).map((row) => [row.rule_id, row]),
    );
    const value: ResolvedSettings = new Map();
    for (const [ruleId, defaults] of Object.entries(RULE_DEFAULTS) as Array<
      [RuleId, NonNullable<(typeof RULE_DEFAULTS)[RuleId]>]
    >) {
      const override = overrides.get(ruleId);
      value.set(ruleId, {
        enabled: override?.enabled ?? defaults.enabled,
        params: mergeParams(ruleId, override?.params),
      });
    }
    this.settingsCache.set(tenantId, { at: nowMs, value });
    return value;
  }

  invalidateSettings(tenantId: string): void {
    this.settingsCache.delete(tenantId);
  }

  private async profiles(vehicleIds: string[], nowMs: number): Promise<Map<string, string | null>> {
    const missing = vehicleIds.filter((id) => {
      const cached = this.profileCache.get(id);
      return !cached || nowMs - cached.at > PROFILE_TTL_MS;
    });
    if (missing.length > 0) {
      try {
        const loaded = await this.repository.loadVehicleProfiles(missing);
        for (const id of missing) {
          this.profileCache.set(id, { at: nowMs, bodyType: loaded.get(id)?.bodyType ?? null });
        }
      } catch (err) {
        this.logger.warn({ err }, 'Vehicle profile lookup failed; using defaults');
      }
    }
    return new Map(vehicleIds.map((id) => [id, this.profileCache.get(id)?.bodyType ?? null]));
  }
}
