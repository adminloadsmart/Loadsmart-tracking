import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { PointProcessingService } from './point-processing.service';
import { PointPublisher, PointPublisherOptions } from './point.publisher';
import { PointRepository } from './point.repository';

export function createPointsModule(
  dataSource: DataSource,
  redis: Redis,
  publisherOptions: PointPublisherOptions,
) {
  const repository = new PointRepository(dataSource);
  return {
    processing: new PointProcessingService(repository),
    publisher: new PointPublisher(redis, publisherOptions),
  };
}

export type { NormalizedPoint, PointSource } from './point.contract';
export { normalizedPointSchema, POINT_SOURCES } from './point.contract';
export type { PointProcessingService } from './point-processing.service';
export type { PointPublisher } from './point.publisher';
