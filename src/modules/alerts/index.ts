import type Redis from 'ioredis';
import { DataSource } from 'typeorm';
import { RulesRepository } from '../rules/rules.repository';
import { AlertsController } from './alerts.controller';
import { AlertsRepository } from './alerts.repository';
import { createAlertsRoutes } from './alerts.routes';
import { AlertsService } from './alerts.service';

export function createAlertsModule(dataSource: DataSource, redis: Redis) {
  const service = new AlertsService(
    new AlertsRepository(dataSource),
    new RulesRepository(dataSource),
    redis,
  );
  return { service, router: createAlertsRoutes(new AlertsController(service)) };
}

export { toAlertView } from './alert-view';
export { TRACKING_SETTINGS_MANAGE } from './alerts.service';
