import { z } from 'zod';
import { RULE_IDS } from '../rules';

// .meta() only feeds the generated OpenAPI spec (the transform hides the allowed values there).
const csv = <T extends string>(values: readonly [T, ...T[]]) =>
  z
    .string()
    .meta({ description: `Comma-separated list of: ${values.join(', ')}` })
    .transform((value) =>
      value
        .split(',')
        .map((v) => v.trim())
        .filter(Boolean),
    )
    .pipe(z.array(z.enum(values)));

export const listAlertsSchema = z.object({
  query: z.object({
    status: csv(['open', 'acknowledged', 'closed'] as const)
      .default(['open', 'acknowledged'])
      .meta({ default: 'open,acknowledged' }),
    severity: csv(['info', 'warning', 'medium', 'high', 'critical'] as const).optional(),
    tripId: z.uuid().optional(),
    vehicleId: z.uuid().optional(),
    ruleId: z.enum(RULE_IDS).optional(),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    before: z.iso
      .datetime({ offset: true })
      .transform((v) => new Date(v))
      .optional(),
  }),
});

export const alertParamsSchema = z.object({ params: z.object({ alertId: z.uuid() }) });

export const closeAlertSchema = z.object({
  params: z.object({ alertId: z.uuid() }),
  body: z.object({ reason: z.string().trim().min(1).max(500) }),
});

export const tripEventsSchema = z.object({ params: z.object({ tripId: z.uuid() }) });

export const vehicleEventsSchema = z.object({
  params: z.object({ vehicleId: z.uuid() }),
  query: z.object({
    from: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
    to: z.iso.datetime({ offset: true }).transform((v) => new Date(v)),
  }),
});

export const updateRuleSettingSchema = z.object({
  params: z.object({ ruleId: z.enum(RULE_IDS) }),
  body: z.object({
    enabled: z.boolean().nullable().default(null),
    params: z.record(z.string(), z.union([z.number(), z.boolean(), z.string()])).default({}),
  }),
});

export type ListAlertsQuery = z.infer<typeof listAlertsSchema>['query'];
export type VehicleEventsQuery = z.infer<typeof vehicleEventsSchema>['query'];
export type UpdateRuleSettingBody = z.infer<typeof updateRuleSettingSchema>['body'];
