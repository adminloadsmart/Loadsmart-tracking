import { z } from 'zod';
import type { NormalizedPoint } from '../points/point.contract';

/**
 * Roadcast's pull-positions API: latest-only — one row per device that has data (a
 * device with none is simply missing), filtered by `deviceImeis`. All
 * timestamps are UTC. `gpsFixTimestamp` is when the position was taken; `deviceTimestamp` moves
 * on every heartbeat even while the fix stays old (a parked truck), so only the fix time dates
 * the position.
 */
export const roadcastResponseSchema = z.object({
  data: z.object({
    PositionsPull: z.object({
      extras: z
        .object({
          deviceCount: z.number().nullish(),
          maxDeviceCap: z.number().nullish(),
          rowCount: z.number().nullish(),
        })
        .nullish(),
      // Rows are validated one by one, so a single malformed row can't sink the whole batch.
      rows: z.array(z.unknown()),
    }),
  }),
});

export const roadcastRowSchema = z.object({
  deviceImei: z.string().min(1),
  deviceId: z.string().nullish(),
  deviceName: z.string().nullish(),
  latitude: z.number(),
  longitude: z.number(),
  speed: z.number().nullish(),
  course: z.number().nullish(),
  ignition: z.boolean().nullish(),
  motion: z.boolean().nullish(),
  gpsBattery: z.number().nullish(),
  deviceStatus: z.string().nullish(),
  gpsFixTimestamp: z.string().nullish(),
  deviceTimestamp: z.string().nullish(),
});

export type RoadcastRow = z.infer<typeof roadcastRowSchema>;

export type SpeedUnit = 'kmh' | 'knots';

export interface DeviceOwner {
  tenantId: string;
  vehicleId: string;
  tripId: string | null;
  /** Set instead of `tripId` on the drive to the plant (see trips/trip-state INDEXED_STATUSES). */
  approachTripId?: string;
}

const KNOTS_TO_KMH = 1.852;
const MAX_SPEED_KMH = 400;

/** Position time of a row in epoch ms, or null when it has no usable timestamp. */
export function fixTimeMs(row: RoadcastRow): number | null {
  const raw = row.gpsFixTimestamp || row.deviceTimestamp;
  if (!raw) return null;
  const ms = Date.parse(raw);
  return Number.isNaN(ms) ? null : ms;
}

/** A row with a real position: in range and not the 0,0 a device reports before its first fix. */
export function hasPosition(row: RoadcastRow): boolean {
  const { latitude: lat, longitude: lng } = row;
  if (lat === 0 && lng === 0) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

export function toNormalizedPoint(
  row: RoadcastRow,
  recordedAtMs: number,
  owner: DeviceOwner,
  receivedAt: string,
  speedUnit: SpeedUnit,
): NormalizedPoint {
  const flags: Record<string, unknown> = {};
  if (row.ignition != null) flags.ignition = row.ignition;
  if (row.motion != null) flags.motion = row.motion;
  if (row.gpsBattery != null) flags.batteryPct = row.gpsBattery;
  if (row.deviceStatus) flags.deviceStatus = row.deviceStatus;
  if (owner.approachTripId) flags.approachTripId = owner.approachTripId;

  const speedKmh =
    row.speed == null ? null : speedUnit === 'knots' ? row.speed * KNOTS_TO_KMH : row.speed;

  return {
    tenantId: owner.tenantId,
    vehicleId: owner.vehicleId,
    tripId: owner.tripId,
    source: 'roadcast',
    sourceRef: row.deviceImei,
    recordedAt: new Date(recordedAtMs).toISOString(),
    receivedAt,
    lat: row.latitude,
    lng: row.longitude,
    speedKmh: speedKmh != null && speedKmh >= 0 && speedKmh <= MAX_SPEED_KMH ? speedKmh : null,
    heading: row.course != null && row.course >= 0 && row.course <= 360 ? row.course : null,
    accuracyM: null,
    flags: Object.keys(flags).length > 0 ? flags : null,
  };
}
