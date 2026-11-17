import { env } from '../config/env';
import { redisManager } from '../db/redis';
import { createRedisConnection } from '../db/redis-connection';
import { createJobQueue } from '../jobs/queue-registry';
import { ROADCAST_QUEUE, RoadcastDispatcher } from '../modules/ingest-roadcast';
import {
  IntugineClient,
  SimConsentService,
  SIM_POLL_QUEUE,
  SimLifecycleService,
  RedisSimCursors,
  SimPollDispatcher,
  SimTripRepository,
} from '../modules/ingest-sim';
import {
  FASTAG_POLL_QUEUE,
  FastagLifecycleService,
  FastagPollDispatcher,
  FastagTripRepository,
} from '../modules/ingest-ulip';
import { PointRetentionJob } from '../modules/points/retention.job';
import { createRoutesModule } from '../modules/routes';
import { createRulesModule, OutboxRelay } from '../modules/rules';
import { createTripsModule } from '../modules/trips';
import { LeaderLock } from '../shared/lifecycle/leader-lock';
import { RoleStarter } from '../shared/lifecycle/role-runner';

export const SCHEDULER_LEADER_KEY = 'tracking:scheduler:leader';

const RULES_TICK_MS = 60_000;
// Loads (= trips) are read from the main backend's table: poll changes, plus a periodic full
// rebuild as a safety net for writes that don't touch updated_at.
const TRIP_WATCH_MS = 5_000;
const TRIP_REBUILD_MS = 10 * 60_000;
const OUTBOX_RELAY_MS = 2_000;
const ROUTE_PLANNER_MS = 30_000;
const RETENTION_MS = 60 * 60_000;
// SIM consent / trip start / trip end decisions. Minutes matter little (consent is re-checked hourly).
const SIM_LIFECYCLE_MS = 5 * 60_000;
// How often running SIM trips are checked for a poll that is due (the poll itself is every
// INTUGINE_POLL_INTERVAL_MIN).
const SIM_DISPATCH_MS = 60_000;
// FASTag: which loads are followed (open / close), and which are due a ULIP poll.
const FASTAG_LIFECYCLE_MS = 5 * 60_000;
const FASTAG_DISPATCH_MS = 60_000;

// Exactly one scheduler leader across replicas runs the leader-only work: the active-trip index
// rebuild on takeover, the time-driven rules tick (inactivity, delay), route planning, and the
// outbox relay to the main backend. Standbys are healthy — they're ready to take over — so readiness passes either way.
export const startSchedulerRole: RoleStarter = async ({ dataSource, health, logger }) => {
  const redis = redisManager.getClient();
  const trips = createTripsModule(dataSource, redis, logger);
  const routes = createRoutesModule({
    dataSource,
    redis,
    logger,
    googleMapsApiKey: env.googleMapsApiKey,
  });
  const rules = createRulesModule({
    dataSource,
    redis,
    activeTrips: trips.activeTrips,
    logger,
    routes,
  });
  const mainRedis = createRedisConnection(env.mainRedisUrl, 'main-backend-events');
  const outbox = new OutboxRelay(dataSource, mainRedis);
  const retention = new PointRetentionJob(dataSource, logger);
  // Roadcast polls run on the poller role; the leader only enqueues them.
  const roadcast =
    env.roadcastApiKey && env.roadcastApiUrl
      ? new RoadcastDispatcher(
          trips.mainData,
          trips.activeTrips,
          createJobQueue(ROADCAST_QUEUE),
          {
            intervalMs: env.roadcastPollIntervalMs,
            idleIntervalMs: env.roadcastIdleIntervalMs,
          },
          logger,
        )
      : null;

  // SIM tracking (Intugine). Without credentials it stays off.
  let sim: SimLifecycleService | null = null;
  let simPolls: SimPollDispatcher | null = null;
  if (env.intugineApiUrl && env.intugineUsername && env.intuginePassword) {
    const provider = new IntugineClient({
      url: env.intugineApiUrl,
      username: env.intugineUsername,
      password: env.intuginePassword,
      timeoutMs: env.intugineTimeoutMs,
      slowTimeoutMs: env.intugineSlowTimeoutMs,
    });
    const store = new SimTripRepository(dataSource);
    sim = new SimLifecycleService(
      trips.mainData,
      store,
      provider,
      new SimConsentService(store, provider, {
        checkIntervalMs: env.intugineConsentCheckMin * 60_000,
        ttlMs: env.intugineConsentTtlMin * 60_000,
      }),
      new RedisSimCursors(redis),
      logger,
    );
    simPolls = new SimPollDispatcher(
      store,
      createJobQueue(SIM_POLL_QUEUE),
      { pollIntervalMs: env.intuginePollIntervalMin * 60_000 },
      logger,
    );
  }

  // FASTag crossings (ULIP). Without credentials it stays off.
  let fastag: FastagLifecycleService | null = null;
  let fastagPolls: FastagPollDispatcher | null = null;
  if (env.ulipApiUrl && env.ulipUsername && env.ulipPassword) {
    const store = new FastagTripRepository(dataSource);
    fastag = new FastagLifecycleService(trips.mainData, store, logger);
    fastagPolls = new FastagPollDispatcher(
      store,
      createJobQueue(FASTAG_POLL_QUEUE),
      {
        pollIntervalMs: env.ulipPollIntervalMin * 60_000,
        finalDelayMs: env.ulipFinalPollDelayMin * 60_000,
      },
      logger,
    );
  }

  const lock = new LeaderLock(redis, {
    key: SCHEDULER_LEADER_KEY,
    ttlMs: env.leaderLockTtlMs,
    logger,
    // The Redis index is derived from Postgres; reconciling on every takeover repairs it after a
    // Redis flush/failover or any missed update while no leader was running.
    onAcquired: () => {
      trips.watcher
        .rebuild()
        .catch((err) => logger.error({ err }, 'Active-trip index rebuild failed'));
    },
  });
  await lock.start();

  const loops = [
    leaderLoop('trip-watcher', TRIP_WATCH_MS, () => trips.watcher.poll()),
    leaderLoop('trip-index-rebuild', TRIP_REBUILD_MS, () => trips.watcher.rebuild()),
    leaderLoop('rules-tick', RULES_TICK_MS, () => rules.tick()),
    leaderLoop('route-planner', ROUTE_PLANNER_MS, () => routes.planner.planPending()),
    leaderLoop('point-retention', RETENTION_MS, () => retention.run()),
    leaderLoop('outbox-relay', OUTBOX_RELAY_MS, async () => {
      // Drain: keep relaying full batches until the outbox is empty.
      while ((await outbox.relay()) >= 500);
    }),
  ];
  if (roadcast) {
    loops.push(
      leaderLoop('roadcast-dispatch', env.roadcastPollIntervalMs, () => roadcast.dispatch()),
    );
  }

  if (sim) {
    const lifecycle = sim;
    loops.push(
      leaderLoop('sim-lifecycle', SIM_LIFECYCLE_MS, async () => {
        const result = await lifecycle.run();
        logger.info(result, 'SIM lifecycle tick');
      }),
    );
  }

  if (simPolls) {
    const dispatcher = simPolls;
    loops.push(leaderLoop('sim-dispatch', SIM_DISPATCH_MS, () => dispatcher.dispatch()));
  }

  if (fastag) {
    const lifecycle = fastag;
    loops.push(
      leaderLoop('fastag-lifecycle', FASTAG_LIFECYCLE_MS, async () => {
        const result = await lifecycle.run();
        logger.info(result, 'FASTag lifecycle tick');
      }),
    );
  }

  if (fastagPolls) {
    const dispatcher = fastagPolls;
    loops.push(leaderLoop('fastag-dispatch', FASTAG_DISPATCH_MS, () => dispatcher.dispatch()));
  }

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
