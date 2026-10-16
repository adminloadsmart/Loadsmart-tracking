import { z } from 'zod';

export const approveSchema = z.object({
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
