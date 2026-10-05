import { env } from '../config/env';
import { redisManager } from '../db/redis';
import { createRedisConnection } from '../db/redis-connection';
import { PointRetentionJob } from '../modules/points/retention.job';
import { createRoutesModule } from '../modules/routes';
import { createRulesModule, OutboxRelay } from '../modules/rules';
import { createSyncModule } from '../modules/sync';
import { LeaderLock } from '../shared/lifecycle/leader-lock';
import { RoleStarter } from '../shared/lifecycle/role-runner';

export const SCHEDULER_LEADER_KEY = 'tracking:scheduler:leader';

const RULES_TICK_MS = 60_000;
const OUTBOX_RELAY_MS = 2_000;
const ROUTE_PLANNER_MS = 30_000;
const RETENTION_MS = 60 * 60_000;

// Exactly one scheduler leader across replicas runs the leader-only work: the active-trip index
// rebuild on takeover, the time-driven rules tick (inactivity, delay), route planning, and the
// outbox relay to the main backend. Standbys are healthy — they're ready to take over — so readiness passes either way.
export const startSchedulerRole: RoleStarter = async ({ dataSource, health, logger }) => {
  const redis = redisManager.getClient();
  const sync = createSyncModule(dataSource, redis, logger);
  const routes = createRoutesModule({
    dataSource,
    redis,
    logger,
    googleMapsApiKey: env.googleMapsApiKey,
  });
  const rules = createRulesModule({
    dataSource,
    redis,
    activeTrips: sync.activeTrips,
    logger,
    routes,
  });
  const mainRedis = createRedisConnection(env.mainRedisUrl, 'main-backend-events');
  const outbox = new OutboxRelay(dataSource, mainRedis);
  const retention = new PointRetentionJob(dataSource, logger);

  const lock = new LeaderLock(redis, {
    key: SCHEDULER_LEADER_KEY,
    ttlMs: env.leaderLockTtlMs,
    logger,
    // The Redis index is derived from Postgres; reconciling on every takeover repairs it after a
    // Redis flush/failover or any missed update while no leader was running.
    onAcquired: () => {
      sync.service
        .rebuildActiveTripIndex()
        .catch((err) => logger.error({ err }, 'Active-trip index rebuild failed'));
    },
  });
  await lock.start();

  const loops = [
    leaderLoop('rules-tick', RULES_TICK_MS, () => rules.tick()),
    leaderLoop('route-planner', ROUTE_PLANNER_MS, () => routes.planner.planPending()),
    leaderLoop('point-retention', RETENTION_MS, () => retention.run()),
    leaderLoop('outbox-relay', OUTBOX_RELAY_MS, async () => {
      // Drain: keep relaying full batches until the outbox is empty.
      while ((await outbox.relay()) >= 500);
    }),
  ];

  /** Runs `work` every `everyMs` while this instance is leader; never overlaps itself. */
  function leaderLoop(name: string, everyMs: number, work: () => Promise<unknown>) {
    let running = false;
    return setInterval(() => {
      if (!lock.isLeader() || running) return;
      running = true;
      work()
        .catch((err) => logger.error({ err, loop: name }, 'Scheduler loop failed'))
        .finally(() => {
          running = false;
        });
    }, everyMs);
  }

  health.register('scheduler', async () => ({ leader: lock.isLeader() }));

  return {
    async stop() {
      health.unregister('scheduler');
      loops.forEach(clearInterval);
      await lock.stop();
      await mainRedis.quit();
    },
  };
};
