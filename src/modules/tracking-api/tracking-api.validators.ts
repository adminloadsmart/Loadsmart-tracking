import { z } from 'zod';
import { POINT_SOURCES } from '../points';
import { TRACK_RESOLUTIONS } from './tracking-api.service';
import { TRIP_PLACE_KINDS } from './trip.entity';

export const vehicleParamsSchema = z.object({ params: z.object({ vehicleId: z.uuid() }) });
export const tripParamsSchema = z.object({ params: z.object({ tripId: z.uuid() }) });

export const timelineSchema = z.object({
  params: z.object({ vehicleId: z.uuid() }),
  query: z.object({
    from: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    to: z.iso.datetime({ offset: true }).transform((value) => new Date(value)),
    resolution: z.enum(TRACK_RESOLUTIONS).default('medium'),
  }),
});

export const tripTrackSchema = z.object({
  params: z.object({ tripId: z.uuid() }),
  query: z.object({
    resolution: z.enum(TRACK_RESOLUTIONS).default('medium'),
    format: z.enum(['polyline', 'points']).default('polyline'),
    source: z.enum(POINT_SOURCES).optional(),
  }),
});

export const listTripsSchema = z.object({
  query: z.object({
    state: z.enum(['pending', 'active', 'ended']).default('active'),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    // Matches load code, customer, truck, driver name/phone, and origin/destination name or city.
    q: z.string().trim().max(100).optional(),
  }),
});

const isoDateTime = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const text = (max: number) => z.string().trim().min(1).max(max);

const placeSchema = z.object({
  kind: z.enum(TRIP_PLACE_KINDS),
  /** Master id when picked from a loading point / customer address; absent for a typed address. */
  id: z.uuid().optional(),
  name: text(200),
  address: text(500),
  city: z.string().trim().max(100).nullish(),
});

/** POST /trips — the Create trip drawer's CreateTripPayload. */
export const createTripSchema = z.object({
  body: z
    .object({
      customerId: z.uuid().optional(),
      customerName: z.string().trim().max(200).optional(),
      source: placeSchema,
      destination: placeSchema,
      direction: z.enum(['in', 'out']).nullable().default(null),
      vehicleNumber: z
        .string()
        .trim()
        .transform((value) => value.replace(/[\s-]+/g, '').toUpperCase())
        .pipe(z.string().min(4).max(15)),
      driverPhone: z
        .string()
        .trim()
        .regex(/^\d{10}$/, 'driverPhone must be a 10-digit number'),
      loading: z.object({ reportingAt: isoDateTime.optional() }).optional(),
      delivery: z
        .discriminatedUnion('mode', [
          z.object({ mode: z.literal('reporting'), reportingAt: isoDateTime.optional() }),
          z.object({
            mode: z.literal('appointment'),
            appointmentId: z.string().trim().max(100).optional(),
            slotFrom: isoDateTime.optional(),
            slotTo: isoDateTime.optional(),
          }),
        ])
        .optional(),
      driver: z
        .object({
          licenceNumber: z.string().trim().max(30).optional(),
          dateOfBirth: z.iso.date().optional(),
          name: z.string().trim().max(150).optional(),
        })
        .optional(),
      transporter: z
        .object({
          id: z.uuid().optional(),
          name: z.string().trim().max(200).optional(),
          phone: z.string().trim().max(20).optional(),
        })
        .optional(),
      ewayBill: z.object({ number: text(30), validTill: isoDateTime.optional() }).optional(),
    })
    .refine(
      (body) =>
        body.delivery?.mode !== 'appointment' ||
        !body.delivery.slotFrom ||
        !body.delivery.slotTo ||
        body.delivery.slotFrom <= body.delivery.slotTo,
      { message: 'delivery.slotFrom must be before slotTo', path: ['delivery', 'slotTo'] },
    ),
});

/** POST /trips/:tripId/end — closes a created trip: delivered (ended) or called off (cancelled). */
export const endTripSchema = z.object({
  params: z.object({ tripId: z.uuid() }),
  body: z.object({ status: z.enum(['ended', 'cancelled']).default('ended') }).default({
    status: 'ended',
  }),
});

export type EndTripBody = z.infer<typeof endTripSchema>['body'];
export type CreateTripBody = z.infer<typeof createTripSchema>['body'];
export type TimelineQuery = z.infer<typeof timelineSchema>['query'];
export type TripTrackQuery = z.infer<typeof tripTrackSchema>['query'];
export type ListTripsQuery = z.infer<typeof listTripsSchema>['query'];
