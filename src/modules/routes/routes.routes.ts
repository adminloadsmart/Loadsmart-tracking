import { Router } from 'express';
import { z } from 'zod';
import { validate } from '../../shared/middleware/validate.middleware';
import { RoutesController } from './routes.controller';

const approveSchema = z.object({
  params: z.object({ tripId: z.uuid() }),
  body: z.object({
    reason: z.string().trim().min(1).max(500),
    polyline: z.string().min(4).optional(),
    replan: z.boolean().optional(),
    promisedDeliveryAt: z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v))
      .optional(),
  }),
});

/** Mounted at /v1 behind staff auth (see app.ts). */
export function createRoutesRoutes(controller: RoutesController): Router {
  const router = Router();
  router.post('/trips/:tripId/route/approve', validate(approveSchema), controller.approve);
  return router;
}
