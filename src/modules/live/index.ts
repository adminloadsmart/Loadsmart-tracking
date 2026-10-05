import type Redis from 'ioredis';
import type { Logger } from 'pino';
import type { Namespace } from 'socket.io';
import { createTokenBlocklist } from '../../shared/auth/token-blocklist';
import type { TrackingApiService } from '../tracking-api/tracking-api.service';
import { LiveFanout } from './live-fanout';
import { createLiveSocketAuth, registerLiveNamespace } from './live-socket.handler';

export interface LiveModuleDeps {
  /** Dedicated connection — a Redis client in subscriber mode can't run other commands. */
  subscriber: Redis;
  /** The main backend's Redis (access-token blocklist). */
  mainRedis: Redis;
  service: TrackingApiService;
  jwtSecret: string;
  logger: Logger;
  minIntervalMs?: number;
}

/** Wires the /live namespace (map viewers) and the pub/sub fan-out feeding it. */
export function createLiveModule(deps: LiveModuleDeps) {
  return {
    async attach(namespace: Namespace): Promise<LiveFanout> {
      namespace.use(
        createLiveSocketAuth({
          jwtSecret: deps.jwtSecret,
          isBlocked: createTokenBlocklist(deps.mainRedis, deps.logger),
        }),
      );
      registerLiveNamespace(namespace, deps.service);
      const fanout = new LiveFanout(namespace, deps.subscriber, deps.logger, deps.minIntervalMs);
      await fanout.start();
      return fanout;
    },
  };
}

export { createLivePublisher, LIVE_POSITIONS_CHANNEL } from './live-channel';
