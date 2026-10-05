import type Redis from 'ioredis';
import type { LatestPosition } from '../processing/vehicle-state.store';

/**
 * Redis pub/sub channel carrying every batch's newest positions from the processors to all
 * realtime pods. Each pod subscribes and fans out to its own /live sockets, so viewers can be
 * connected to any pod — no sticky sessions and no socket.io adapter needed. One message per
 * processed batch (an array), not per point.
 */
export const LIVE_POSITIONS_CHANNEL = 'trk:live:positions';

export interface LivePublisher {
  publish(positions: LatestPosition[]): Promise<void>;
}

export function createLivePublisher(redis: Redis): LivePublisher {
  return {
    async publish(positions) {
      if (positions.length === 0) return;
      await redis.publish(LIVE_POSITIONS_CHANNEL, JSON.stringify(positions));
    },
  };
}
