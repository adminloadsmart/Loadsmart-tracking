import { env } from '../config/env';
import { redisManager } from '../db/redis';
import { createSyncModule } from '../modules/sync';
import { LeaderLock } from '../shared/lifecycle/leader-lock';
import { RoleStarter } from '../shared/lifecycle/role-runner';

export const SCHEDULER_LEADER_KEY = 'tracking:scheduler:leader';

// Exactly one scheduler leader across replicas runs the leader-only work: today the active-trip
// index rebuild on takeover; later the due-poll dispatcher, waterfall evaluator and outbox relay.
// Standbys are healthy — they're ready to take over — so readiness passes either way.
export const startSchedulerRole: RoleStarter = async ({ dataSource, health, logger }) => {
  const sync = createSyncModule(dataSource, redisManager.getClient(), logger);

  const lock = new LeaderLock(redisManager.getClient(), {
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

  health.register('scheduler', async () => ({ leader: lock.isLeader() }));

  return {
    async stop() {
      health.unregister('scheduler');
      await lock.stop();
    },
  };
};
