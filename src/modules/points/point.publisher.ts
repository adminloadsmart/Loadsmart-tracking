import type Redis from 'ioredis';
import { partitionFor, pointStreamKey } from '../../streams/partitioner';
import { NormalizedPoint, POINT_FIELD } from './point.contract';

export interface PointPublisherOptions {
  partitions: number;
  maxLen: number;
}

/**
 * Ingest side of the point stream: XADDs each point to its vehicle's partition. One pipeline
 * round trip per call, so a phone's offline batch (≤ 200 points) costs a single request. Returns
 * once Redis has accepted every point — the phone socket only acks after this resolves.
 */
export class PointPublisher {
  constructor(
    private readonly redis: Redis,
    private readonly options: PointPublisherOptions,
  ) {}

  async publish(points: NormalizedPoint[]): Promise<void> {
    if (points.length === 0) return;
    const pipeline = this.redis.pipeline();
    for (const point of points) {
      const key = pointStreamKey(partitionFor(point.vehicleId, this.options.partitions));
      pipeline.xadd(
        key,
        'MAXLEN',
        '~',
        this.options.maxLen,
        '*',
        POINT_FIELD,
        JSON.stringify(point),
      );
    }
    const results = await pipeline.exec();
    const failed = results?.find(([err]) => err);
    if (failed) throw failed[0];
  }
}
