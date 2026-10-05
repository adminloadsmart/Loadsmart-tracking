import { Router } from 'express';
import { validate } from '../../shared/middleware/validate.middleware';
import { AlertsController } from './alerts.controller';
import {
  alertParamsSchema,
  closeAlertSchema,
  listAlertsSchema,
  tripEventsSchema,
  updateRuleSettingSchema,
  vehicleEventsSchema,
} from './alerts.validators';

/** Mounted at /v1 behind staff auth (see app.ts). */
export function createAlertsRoutes(controller: AlertsController): Router {
  const router = Router();
  router.get('/alerts', validate(listAlertsSchema), controller.list);
  router.post('/alerts/:alertId/acknowledge', validate(alertParamsSchema), controller.acknowledge);
  router.post('/alerts/:alertId/close', validate(closeAlertSchema), controller.close);
  router.get('/trips/:tripId/events', validate(tripEventsSchema), controller.tripEvents);
  router.get(
    '/vehicles/:vehicleId/events',
    validate(vehicleEventsSchema),
    controller.vehicleEvents,
  );
  router.get('/rule-settings', controller.settings);
  router.put('/rule-settings/:ruleId', validate(updateRuleSettingSchema), controller.updateSetting);
  return router;
}
