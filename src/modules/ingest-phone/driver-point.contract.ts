import { z } from 'zod';
import type { NormalizedPoint } from '../points/point.contract';

/**
 * What the driver app sends on the /driver socket (docs/contracts/driver-socket.md). Mirrors the
 * Android/iOS location APIs directly so the app does no unit conversion: speed in m/s, accuracy
 * and altitude in metres, bearing in degrees.
 */
export const phonePointSchema = z.object({
  // Client-generated id (UUIDv7 recommended) — carried in flags for debugging/tracing.
  pointId: z.string().min(1).max(64).optional(),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  accuracy: z.number().min(0).max(100_000).nullable().optional(),
  speed: z.number().min(0).max(120).nullable().optional(),
  bearing: z.number().min(0).max(360).nullable().optional(),
  altitude: z.number().min(-1000).max(10_000).nullable().optional(),
  recordedAt: z.iso.datetime({ offset: true }),
  isMock: z.boolean().optional(),
  batteryPct: z.number().min(0).max(100).optional(),
  provider: z.enum(['gps', 'network', 'fused', 'other']).optional(),
  appState: z.enum(['foreground', 'background']).optional(),
});

export const MAX_BATCH_POINTS = 200;
export const phoneBatchSchema = z.array(phonePointSchema).min(1).max(MAX_BATCH_POINTS);

export type PhonePoint = z.infer<typeof phonePointSchema>;

export interface PointOwner {
  tenantId: string;
  vehicleId: string;
  tripId: string | null;
  driverId: string;
  /** Set instead of `tripId` outside the tracked window — the drive to the plant, and leaving the
   *  delivery point after the E-POD (see trips/trip-state GEOFENCE_ONLY_STATUSES). */
  geofenceTripId?: string;
}

const MPS_TO_KMH = 3.6;

export function toNormalizedPoint(
  point: PhonePoint,
  owner: PointOwner,
  receivedAt: string,
): NormalizedPoint {
  const flags: Record<string, unknown> = {};
  if (point.pointId) flags.pointId = point.pointId;
  if (point.isMock !== undefined) flags.isMock = point.isMock;
  if (point.batteryPct !== undefined) flags.batteryPct = point.batteryPct;
  if (point.provider) flags.provider = point.provider;
  if (point.appState) flags.appState = point.appState;
  if (point.altitude != null) flags.altitudeM = point.altitude;
  if (owner.geofenceTripId) flags.geofenceTripId = owner.geofenceTripId;

  return {
    tenantId: owner.tenantId,
    vehicleId: owner.vehicleId,
    tripId: owner.tripId,
    source: 'driver_app',
    sourceRef: owner.driverId,
    recordedAt: new Date(point.recordedAt).toISOString(),
    receivedAt,
    lat: point.lat,
    lng: point.lng,
    speedKmh: point.speed != null ? Math.round(point.speed * MPS_TO_KMH * 10) / 10 : null,
    heading: point.bearing ?? null,
    accuracyM: point.accuracy ?? null,
    flags: Object.keys(flags).length > 0 ? flags : null,
  };
}
