import { z } from 'zod';

/**
 * Contract for the `loadsmart.events` Redis stream, produced by the main loadsmart backend's
 * tracking outbox relay (see docs/contracts/loadsmart-events.md). Events are STATE SNAPSHOTS,
 * not deltas: each carries the aggregate's full current state plus a monotonically increasing
 * `version` (epoch ms of the source row's last change). Consumers keep the highest version seen,
 * so duplicates, replays and out-of-order delivery are all harmless.
 *
 * Stream fields: type, id, tenantId, version, deleted ('true'|'false'), payload (JSON, or empty
 * when deleted).
 */
export const LOADSMART_EVENTS_STREAM = 'loadsmart.events';

export const SNAPSHOT_TYPES = [
  'load',
  'vehicle',
  'driver',
  'loading_point',
  'delivery_point',
] as const;
export type SnapshotType = (typeof SNAPSHOT_TYPES)[number];

export const LOAD_STATUSES = [
  'created',
  'assigned',
  'loading_confirmed',
  'at_plant',
  'in_transit',
  'reached_delivery_point',
  'delivered',
  'closed',
] as const;
export type LoadStatus = (typeof LOAD_STATUSES)[number];

const isoOrNull = z.iso.datetime({ offset: true }).nullable();

export const loadPayloadSchema = z.object({
  code: z.string().min(1),
  status: z.enum(LOAD_STATUSES),
  sourceType: z.enum(['own_fleet', 'market']),
  vehicleId: z.uuid().nullable(),
  vehicleNumber: z.string().nullable(),
  driverId: z.uuid().nullable(),
  driverNumber: z.string().nullable(),
  driverName: z.string().nullable(),
  transporterId: z.uuid().nullable(),
  loadingPointId: z.uuid().nullable(),
  deliveryPointId: z.uuid().nullable(),
  milestones: z.object({
    loadingConfirmedAt: isoOrNull,
    atPlantAt: isoOrNull,
    inTransitAt: isoOrNull,
    reachedDeliveryPointAt: isoOrNull,
    deliveredAt: isoOrNull,
  }),
});

export const vehiclePayloadSchema = z.object({
  registrationNumber: z.string().min(1),
  status: z.string().nullable(),
  gpsProvider: z.string().nullable(),
  gpsEnabled: z.boolean(),
});

export const driverPayloadSchema = z.object({
  fullName: z.string(),
  phoneNumber: z.string(),
  status: z.string().nullable(),
});

/** Loading points and customer delivery points share one normalized place shape. */
export const placePayloadSchema = z.object({
  name: z.string(),
  address: z.string().nullable(),
  city: z.string().nullable(),
  state: z.string().nullable(),
  pinCode: z.string().nullable(),
  lat: z.number().min(-90).max(90).nullable(),
  lng: z.number().min(-180).max(180).nullable(),
});

export type LoadPayload = z.infer<typeof loadPayloadSchema>;
export type VehiclePayload = z.infer<typeof vehiclePayloadSchema>;
export type DriverPayload = z.infer<typeof driverPayloadSchema>;
export type PlacePayload = z.infer<typeof placePayloadSchema>;

const envelopeSchema = z.object({
  type: z.enum(SNAPSHOT_TYPES),
  id: z.uuid(),
  tenantId: z.uuid(),
  version: z.coerce.number().int().nonnegative(),
  deleted: z.enum(['true', 'false']).transform((value) => value === 'true'),
  payload: z.string().optional(),
});

interface EnvelopeBase {
  id: string;
  tenantId: string;
  version: number;
}

export type Snapshot =
  | (EnvelopeBase & { type: 'load'; deleted: false; payload: LoadPayload })
  | (EnvelopeBase & { type: 'vehicle'; deleted: false; payload: VehiclePayload })
  | (EnvelopeBase & { type: 'driver'; deleted: false; payload: DriverPayload })
  | (EnvelopeBase & {
      type: 'loading_point' | 'delivery_point';
      deleted: false;
      payload: PlacePayload;
    })
  | (EnvelopeBase & { type: SnapshotType; deleted: true; payload: null });

const PAYLOAD_SCHEMAS = {
  load: loadPayloadSchema,
  vehicle: vehiclePayloadSchema,
  driver: driverPayloadSchema,
  loading_point: placePayloadSchema,
  delivery_point: placePayloadSchema,
} as const;

/** Parses raw stream fields into a typed snapshot; throws with a readable reason if invalid. */
export function parseSnapshot(fields: Record<string, string>): Snapshot {
  const envelope = envelopeSchema.safeParse(fields);
  if (!envelope.success) throw new Error(`invalid envelope: ${formatIssues(envelope.error)}`);
  const { type, id, tenantId, version, deleted, payload } = envelope.data;

  if (deleted) return { type, id, tenantId, version, deleted: true, payload: null };
  if (!payload) throw new Error('payload is required unless deleted=true');

  let json: unknown;
  try {
    json = JSON.parse(payload);
  } catch {
    throw new Error('payload is not valid JSON');
  }
  const parsed = PAYLOAD_SCHEMAS[type].safeParse(json);
  if (!parsed.success) throw new Error(`invalid ${type} payload: ${formatIssues(parsed.error)}`);

  return { type, id, tenantId, version, deleted: false, payload: parsed.data } as Snapshot;
}

function formatIssues(error: z.ZodError): string {
  return error.issues
    .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
    .join('; ');
}
