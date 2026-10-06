import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { PointSource } from '../points';
import { vehicleActiveTripKey } from '../trips';
import { RULE_DEFAULTS } from './defaults';
import { inactiveFlagKey, lastSeenKey, RuleEngine } from './rule-engine';
import { alertId, episodeId, num } from './rule-helpers';
import { AlertChange, RulesRepository } from './rules.repository';
import { Effects, RuleId } from './rule.types';

const SOURCES: Array<{
  source: PointSource;
  ruleId: RuleId;
  severity: 'medium' | 'high';
  label: string;
}> = [
  // A phone off or in a dead zone is common → Medium, like INACT-SIM; a hard-wired device going
  // silent is a real problem → High (INACT-GPS).
  { source: 'driver_app', ruleId: 'INACT-GPS', severity: 'medium', label: 'driver phone' },
  { source: 'blackrock', ruleId: 'INACT-GPS', severity: 'high', label: 'GPS device' },
];
const MIN_THRESHOLD_MIN = 30; // the smallest possible threshold (tanker rule) bounds the scan
const SCAN_LIMIT = 2000;

/**
 * INACT-GPS (rule sheet): no packet from a source for 60 min (30 for tankers) — run on the
 * scheduler leader's tick, since silence produces no fixes to react to.
 * Opens an episode back-dated to the last packet (it shows on the trip timeline as "No data",
 * never as a halt) and an alert; the point processor closes both on the next packet (see
 * RuleEngine: inactive flag). The phone is only expected to report during a trip, so it is only
 * watched while its vehicle is on an active trip.
 */
export class InactivityMonitor {
  constructor(
    private readonly redis: Redis,
    private readonly repository: RulesRepository,
    private readonly engine: RuleEngine,
    private readonly logger: Logger,
  ) {}

  async tick(nowMs = Date.now()): Promise<AlertChange[]> {
    const changes: AlertChange[] = [];
    for (const { source, ruleId, severity, label } of SOURCES) {
      const stale = await this.redis.zrangebyscore(
        lastSeenKey(source),
        '-inf',
        nowMs - MIN_THRESHOLD_MIN * 60_000,
        'WITHSCORES',
        'LIMIT',
        0,
        SCAN_LIMIT,
      );
      for (let i = 0; i < stale.length; i += 2) {
        const member = stale[i];
        const lastSeenMs = Number(stale[i + 1]);
        const [vehicleId, tenantId] = member.split('|');
        try {
          const change = await this.check(
            source,
            ruleId,
            severity,
            label,
            vehicleId,
            tenantId,
            lastSeenMs,
            nowMs,
            member,
          );
          changes.push(...change);
        } catch (err) {
          this.logger.error({ err, vehicleId, source }, 'Inactivity check failed');
        }
      }
    }
    return changes;
  }

  private async check(
    source: PointSource,
    ruleId: RuleId,
    severity: 'medium' | 'high',
    label: string,
    vehicleId: string,
    tenantId: string,
    lastSeenMs: number,
    nowMs: number,
    member: string,
  ): Promise<AlertChange[]> {
    const flagKey = inactiveFlagKey(vehicleId, source);
    if (await this.redis.exists(flagKey)) return []; // already inactive

    let tripId: string | null = await this.redis.get(vehicleActiveTripKey(vehicleId));
    if (source === 'driver_app' && !tripId) {
      // Phone only reports during trips: off-trip silence is expected — stop watching it.
      await this.redis.zrem(lastSeenKey(source), member);
      return [];
    }
    tripId = tripId ?? null;

    const setting = (await this.engine.settings(tenantId, nowMs)).get(ruleId);
    if (!setting?.enabled) return [];
    const profiles = await this.repository.loadVehicleProfiles([vehicleId]);
    const tanker = /tank/i.test(profiles.get(vehicleId)?.bodyType ?? '');
    const thresholdMin = num(
      setting.params,
      tanker ? 'tankerInactiveAfterMin' : 'inactiveAfterMin',
    );
    if (nowMs - lastSeenMs < thresholdMin * 60_000) return [];

    const effects = new Effects();
    const id = episodeId(vehicleId, ruleId, lastSeenMs, source);
    const dedupeKey = `${ruleId}:${vehicleId}:${source}`;
    const alert = alertId(dedupeKey, lastSeenMs);
    effects.episode({
      op: 'open',
      id,
      ruleId,
      source,
      tripId,
      startedAt: lastSeenMs,
      metrics: { kind: 'no_data' },
      tags: ['no_data'],
    });
    effects.alert({
      op: 'raise',
      id: alert,
      ruleId,
      severity,
      audience: RULE_DEFAULTS[ruleId]!.audience,
      title: `No data from the ${label} for ${thresholdMin}+ minutes`,
      tripId,
      episodeId: id,
      dedupeKey,
      occurredAt: lastSeenMs,
      payload: { source, lastSeenAt: new Date(lastSeenMs).toISOString(), thresholdMin },
    });
    const changes = await this.repository.applyEffects([
      { tenantId, vehicleId, episodes: effects.episodes, alerts: effects.alerts },
    ]);
    await this.redis.hset(flagKey, {
      episodeId: id,
      alertId: alert,
      startedAt: String(lastSeenMs),
    });
    return changes;
  }
}
