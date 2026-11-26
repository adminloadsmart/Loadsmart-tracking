import type Redis from 'ioredis';
import type { Logger } from 'pino';
import { DataSource } from 'typeorm';
import { MainDataRepository } from '../main-data';
import type { BatchHook } from '../points';
import type { RouteStore } from '../routes/route.store';
import type { RoutesRepository } from '../routes/routes.repository';
import type { ActiveTripIndex } from '../trips';
import { InactivityMonitor, type SimTripLookup } from './inactivity.monitor';
import { RuleEngine } from './rule-engine';
import { AlertChange, RulesRepository } from './rules.repository';
import { haltGpsRule } from './rules/halt-gps.rule';
import { haltSimRule } from './rules/halt-sim.rule';
import { nightGpsRule } from './rules/night-gps.rule';
import { nightSimRule } from './rules/night-sim.rule';
import { overspeedGpsRule } from './rules/overspeed-gps.rule';
import { deviationGpsRule } from './rules/deviation-gps.rule';
import { deviationSimRule } from './rules/deviation-sim.rule';
import { progressGpsRule } from './rules/progress-gps.rule';
import { DelayMonitor } from './delay.monitor';
import { PreTransitEtaMonitor } from './pre-transit-eta';
import { SignalLossMonitor } from './signal-loss.monitor';
import type { FixRule } from './rule.types';

/** Fix-driven rules active today (docs/rules.md). Device and SIM rules join as their sources land. */
export const FIX_RULES: FixRule[] = [
  haltGpsRule as FixRule,
  haltSimRule as FixRule,
  overspeedGpsRule as FixRule,
  nightGpsRule as FixRule,
  nightSimRule as FixRule,
  deviationGpsRule as FixRule,
  deviationSimRule as FixRule,
  progressGpsRule as FixRule,
];

/** Redis pub/sub channel for alert changes → every realtime pod → /live `alert` events. */
export const LIVE_ALERTS_CHANNEL = 'trk:live:alerts';

export function createRulesModule(deps: {
  dataSource: DataSource;
  redis: Redis;
  activeTrips: ActiveTripIndex;
  logger: Logger;
  /** Routes (planned/approved) — enables DEV-GPS and DELAY-GPS. */
  routes?: { repository: RoutesRepository; store: RouteStore };
  /** SIM trips — enables INACT-SIM (silence only matters while SIM is running for the trip). */
  simTrips?: SimTripLookup;
}) {
  const repository = new RulesRepository(deps.dataSource);
  const engine = new RuleEngine(
    FIX_RULES,
    repository,
    deps.redis,
    deps.activeTrips,
    deps.logger,
    deps.routes?.store ?? null,
  );

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

  const monitor = new InactivityMonitor(
    deps.redis,
    repository,
    engine,
    deps.logger,
    deps.simTrips ?? null,
  );
  const mainData = new MainDataRepository(deps.dataSource);
  const signalLoss = new SignalLossMonitor(deps.redis, mainData, repository, deps.logger);
  const delay = deps.routes
    ? new DelayMonitor(
        deps.redis,
        deps.routes.repository,
        deps.routes.store,
        repository,
        engine,
        deps.logger,
        mainData,
      )
    : null;
  // Delivery ETA from truck assignment until the truck leaves the plant (no alerts).
  const preTransitEta = deps.routes
    ? new PreTransitEtaMonitor(
        deps.redis,
        mainData,
        deps.routes.repository,
        deps.routes.store,
        engine,
        deps.logger,
      )
    : null;
  return {
    repository,
    engine,
    hook,
    /** Scheduler-leader tick for time-driven rules (inactivity, delay + ETA, signal loss). */
    async tick(nowMs = Date.now()) {
      // Each step on its own: one failing monitor must not stop the others (e.g. the ETAs).
      const step = async (name: string, work: () => Promise<unknown>) => {
        try {
          await work();
        } catch (err) {
          deps.logger.error({ err, step: name }, 'Rules tick step failed');
        }
      };
      await step('inactivity', async () => publishAlerts(await monitor.tick(nowMs)));
      if (delay) await step('delay', async () => publishAlerts(await delay.tick(nowMs)));
      if (preTransitEta) await step('pre-transit-eta', () => preTransitEta.tick(nowMs));
      await step('signal-loss', () => signalLoss.tick(nowMs));
    },
  };
}

export type { AlertChange, AlertRow } from './rules.repository';
export { OutboxRelay, TRACKING_EVENTS_STREAM } from './outbox.relay';
export { RULE_DEFAULTS, mergeParams } from './defaults';
export { RULE_IDS } from './rule.types';
export { tripEtaKey } from './delay.monitor';
export type { RuleId } from './rule.types';
