import { Router } from 'express';
import { validate } from '../../shared/middleware/validate.middleware';
import { RoutesController } from './routes.controller';
import { approveSchema } from './routes.validators';

/** Mounted at /v1 behind staff auth (see app.ts). */
export function createRoutesRoutes(controller: RoutesController): Router {
  const router = Router();
  router.post('/trips/:tripId/route/approve', validate(approveSchema), controller.approve);
  return router;
}
