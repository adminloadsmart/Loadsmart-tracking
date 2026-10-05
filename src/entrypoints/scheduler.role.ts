import { env } from '../config/env';
import { redisManager } from '../db/redis';
import { LeaderLock } from '../shared/lifecycle/leader-lock';
import { RoleStarter } from '../shared/lifecycle/role-runner';

export const SCHEDULER_LEADER_KEY = 'tracking:scheduler:leader';

// Exactly one scheduler leader across replicas runs the due-poll dispatcher, waterfall
// evaluator, retention/prune jobs and outbox relay (added in later phases via onAcquired/onLost).
// Standbys are healthy — they're ready to take over — so readiness passes either way.
export const startSchedulerRole: RoleStarter = async ({ health, logger }) => {
  const lock = new LeaderLock(redisManager.getClient(), {
    key: SCHEDULER_LEADER_KEY,
    ttlMs: env.leaderLockTtlMs,
    logger,
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
