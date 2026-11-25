import { z } from 'zod';
import { POINT_SOURCES } from '../points';
import { TRACK_RESOLUTIONS } from './tracking-api.service';
import { TRIP_PLACE_KINDS } from './trip.entity';

export const vehicleParamsSchema = z.object({ params: z.object({ vehicleId: z.uuid() }) });
/** The trips list's status filter: running, waiting to start, delivered / ended, called off. */
export const TRIP_LIST_STATES = ['pending', 'active', 'completed', 'cancelled', 'ended'] as const;
export type TripListState = (typeof TRIP_LIST_STATES)[number];

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
    // ended = completed + cancelled.
    state: z.enum(TRIP_LIST_STATES).default('active'),
    limit: z.coerce.number().int().min(1).max(500).default(100),
    // Matches load code, customer, truck, driver name/phone, and origin/destination name or city.
    q: z.string().trim().max(100).optional(),
  }),
});

const isoDateTime = z.iso.datetime({ offset: true }).transform((value) => new Date(value));
const text = (max: number) => z.string().trim().min(1).max(max);

/**
 * A route point is always a master place: a loading point, or one of the customer's delivery
 * points (Create trip saves a new place to that master first). Their geofences come from the
 * main backend's geofence syncs. `address` (a typed place with no master) is only on trips saved
 * before this rule.
 */
const placeSchema = z.object({
  kind: z.enum(
    TRIP_PLACE_KINDS.filter((kind) => kind !== 'address') as ['loading_point', 'customer_address'],
  ),
  id: z.uuid(),
  name: text(200),
  address: text(500),
  city: z.string().trim().max(100).nullish(),
  /** Where it is, when the picker knows; else the master's saved pin (or its address geocoded). */
  lat: z.number().min(-90).max(90).optional(),
  lng: z.number().min(-180).max(180).optional(),
});

const vehicleNumberSchema = z
  .string()
  .trim()
  .transform((value) => value.replace(/[\s-]+/g, '').toUpperCase())
  .pipe(z.string().min(4).max(15));
const driverPhoneSchema = z
  .string()
  .trim()
  .regex(/^\d{10}$/, 'driverPhone must be a 10-digit number');
const lrNumberSchema = z.string().trim().max(50).optional();
/** A file uploaded through the main backend's storage for driver documents (masters/driver/…). */
const uploadedKey = (prefix: 'masters/driver' | 'masters/vehicle') =>
  z
    .string()
    .trim()
    .max(500)
    .refine((key) => key.startsWith(`${prefix}/`) && !key.includes('..'), 'Upload the photo first');
const driverDocumentKey = uploadedKey('masters/driver');
/** VAHAN results that leave the truck unconfirmed: its RC photo is asked for instead. */
export const VAHAN_FAILED = ['not_found', 'manual_review', 'unavailable'] as const;
const rcRequired = (body: { vahanStatus?: string; rcKey?: string }) =>
  !(VAHAN_FAILED as readonly string[]).includes(body.vahanStatus ?? '') || !!body.rcKey;
const RC_REQUIRED = {
  message: 'Upload the RC: VAHAN could not verify this truck',
  path: ['rcKey'],
};
/** The VAHAN check Create trip ran on the truck (POST /vehicles/verify-vahan in main):
 *  `verified` only when it was found and every paper is valid; `non_compliant` when a paper has
 *  expired. Only `verified` shows the truck as Verified. */
const vahanStatusSchema = z
  .enum(['verified', 'non_compliant', 'not_found', 'manual_review', 'unavailable'])
  .optional();

/** POST /trips — the Create trip drawer's CreateTripPayload. */
export const createTripSchema = z.object({
  body: z
    .object({
      customerId: z.uuid().optional(),
      customerName: z.string().trim().max(200).optional(),
      source: placeSchema,
      destination: placeSchema,
      direction: z.enum(['in', 'out']).nullable().default(null),
      vehicleNumber: vehicleNumberSchema,
      driverPhone: driverPhoneSchema,
      lrNumber: lrNumberSchema,
      vahanStatus: vahanStatusSchema,
      /** The truck's RC photo, required when the VAHAN check failed (VAHAN_FAILED). */
      rcKey: uploadedKey('masters/vehicle').optional(),
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
          /** The Sarathi check run on the licence (POST /drivers/verify-dl in main). */
          licenceStatus: z
            .enum(['verified', 'manual_review', 'not_found', 'unavailable'])
            .optional(),
          /** Licence photos for a manual check (manual_review), uploaded via main's storage. */
          licenceFrontKey: driverDocumentKey.optional(),
          licenceBackKey: driverDocumentKey.optional(),
        })
        .refine(
          (driver) =>
            driver.licenceStatus !== 'manual_review' ||
            (!!driver.licenceFrontKey && !!driver.licenceBackKey),
          {
            message: 'Upload the front and back of the driving licence for a manual check',
            path: ['licenceFrontKey'],
          },
        )
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
    .refine(rcRequired, RC_REQUIRED)
    .refine(
      (body) =>
        body.delivery?.mode !== 'appointment' ||
        !body.delivery.slotFrom ||
        !body.delivery.slotTo ||
        body.delivery.slotFrom <= body.delivery.slotTo,
      { message: 'delivery.slotFrom must be before slotTo', path: ['delivery', 'slotTo'] },
    ),
});

/** POST /trips/:tripId/end — Stop tracking: cancels a created trip (stopped before it completed
 *  at its drop). `completed` closes it as delivered by hand. */
export const endTripSchema = z.object({
  params: z.object({ tripId: z.uuid() }),
  // Stopping by hand cancels the trip; completed is reached on its own, at the drop.
  body: z.object({ status: z.enum(['completed', 'cancelled']).default('cancelled') }).default({
    status: 'cancelled',
  }),
});

/**
 * PATCH /trips/:tripId — Edit tracking on an active created trip: the truck, the driver and the
 * destination (and the LR number). Fields left out keep their value.
 */
export const updateTripSchema = z.object({
  params: z.object({ tripId: z.uuid() }),
  body: z
    .object({
      vehicleNumber: vehicleNumberSchema.optional(),
      vahanStatus: vahanStatusSchema,
      rcKey: uploadedKey('masters/vehicle').optional(),
      driverPhone: driverPhoneSchema.optional(),
      driver: z.object({ name: z.string().trim().max(150).optional() }).optional(),
      destination: placeSchema.optional(),
      lrNumber: z.string().trim().max(50).nullable().optional(),
    })
    .refine((body) => Object.values(body).some((value) => value !== undefined), {
      message: 'Nothing to change',
    })
    .refine(rcRequired, RC_REQUIRED),
});

export type UpdateTripBody = z.infer<typeof updateTripSchema>['body'];
export type EndTripBody = z.infer<typeof endTripSchema>['body'];
export type CreateTripBody = z.infer<typeof createTripSchema>['body'];
export type TimelineQuery = z.infer<typeof timelineSchema>['query'];
export type TripTrackQuery = z.infer<typeof tripTrackSchema>['query'];
export type ListTripsQuery = z.infer<typeof listTripsSchema>['query'];
