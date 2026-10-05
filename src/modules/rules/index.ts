import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { DataSource } from 'typeorm';
import type { BatchHook } from '../points';
import type { ActiveTripIndex } from '../sync';
import { InactivityMonitor } from './inactivity.monitor';
import { RuleEngine } from './rule-engine';
import { AlertChange, RulesRepository } from './rules.repository';
import { haltGpsRule } from './rules/halt-gps.rule';
import { nightGpsRule } from './rules/night-gps.rule';
import { overspeedGpsRule } from './rules/overspeed-gps.rule';
import type { FixRule } from './rule.types';

/** Fix-driven rules active today (docs/rules.md). Device and SIM rules join as their sources land. */
export const FIX_RULES: FixRule[] = [
  haltGpsRule as FixRule,
  overspeedGpsRule as FixRule,
  nightGpsRule as FixRule,
];

/** Redis pub/sub channel for alert changes → every realtime pod → /live `alert` events. */
export const LIVE_ALERTS_CHANNEL = 'trk:live:alerts';

export function createRulesModule(deps: {
  dataSource: DataSource;
  redis: Redis;
  activeTrips: ActiveTripIndex;
  logger: Logger;
}) {
  const repository = new RulesRepository(deps.dataSource);
  const engine = new RuleEngine(FIX_RULES, repository, deps.redis, deps.activeTrips, deps.logger);

  const publishAlerts = async (changes: AlertChange[]) => {
    if (changes.length > 0) await deps.redis.publish(LIVE_ALERTS_CHANNEL, JSON.stringify(changes));
  };

  const hook: BatchHook = {
    async run(points, nowMs) {
      const evaluation = await engine.evaluate(points, nowMs);
      const changes = await engine.apply(evaluation);
      return { writeState: evaluation.writeState, afterCommit: () => publishAlerts(changes) };
    },
  };

  const monitor = new InactivityMonitor(deps.redis, repository, engine, deps.logger);
  return {
    repository,
    engine,
    hook,
    /** Scheduler-leader tick for time-driven rules (inactivity). */
    async tick(nowMs = Date.now()) {
      await publishAlerts(await monitor.tick(nowMs));
    },
  };
}

export type { AlertChange, AlertRow } from './rules.repository';
export { OutboxRelay, TRACKING_EVENTS_STREAM } from './outbox.relay';
export { RULE_DEFAULTS, mergeParams } from './defaults';
export { RULE_IDS } from './rule.types';
export type { RuleId } from './rule.types';
