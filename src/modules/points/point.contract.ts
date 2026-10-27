import { z } from 'zod';

export const POINT_SOURCES = ['driver_app', 'roadcast', 'sim'] as const;
export type PointSource = (typeof POINT_SOURCES)[number];

/**
 * The one shape every ingest path (phone socket, Roadcast/Intugine pollers) normalizes into
 * before the point stream (docs/ROADMAP.md §7). Units are fixed here so no consumer has to
 * guess: speed km/h, heading degrees 0-360, accuracy metres, timestamps ISO-8601.
 */
export const normalizedPointSchema = z.object({
  tenantId: z.uuid(),
  vehicleId: z.uuid(),
  tripId: z.uuid().nullable().optional(),
  source: z.enum(POINT_SOURCES),
  // driverId / Roadcast device IMEI / Intugine consent id — who reported this point.
  sourceRef: z.string().min(1).max(100),
  recordedAt: z.iso.datetime({ offset: true }),
  receivedAt: z.iso.datetime({ offset: true }),
  lat: z.number().min(-90).max(90),
  lng: z.number().min(-180).max(180),
  speedKmh: z.number().min(0).max(400).nullable().optional(),
  heading: z.number().min(0).max(360).nullable().optional(),
  accuracyM: z.number().min(0).nullable().optional(),
  flags: z.record(z.string(), z.unknown()).nullable().optional(),
});

export type NormalizedPoint = z.infer<typeof normalizedPointSchema>;

/** Stream field holding the JSON-encoded point. */
export const POINT_FIELD = 'p';
