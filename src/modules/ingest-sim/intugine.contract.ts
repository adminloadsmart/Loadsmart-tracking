import { z } from 'zod';
import type { NormalizedPoint } from '../points/point.contract';

export type SimConsentStatus = 'pending' | 'allowed' | 'not_registered' | 'denied' | 'unsupported';

/**
 * GET /consents?tel= — one entry per number. `consent` is the operator's status as a free-text
 * string ("ALLOWED", "PENDING", "NOT REGISTERED IN MISSEDCALLALERT"…); `consent_suggestion` is
 * what the driver has to do ("Send 's' to 5114040") or "Other Operator: Trip will not be tracked.".
 */
export const consentEntrySchema = z.object({
  code: z.number().nullish(),
  result: z.object({
    number: z.string().nullish(),
    operator: z.string().nullish(),
    consent: z.string().nullish(),
    current_consent: z.string().nullish(),
    consent_suggestion: z.string().nullish(),
    message: z.string().nullish(),
  }),
});
export const consentResponseSchema = z.array(consentEntrySchema);

export interface SimConsent {
  status: SimConsentStatus;
  operator: string | null;
  suggestion: string | null;
}

const SUPPORTED_OPERATORS = ['airtel', 'jio', 'vodafone', 'idea', 'bsnl'];

/** Normalizes Intugine's consent text; anything unrecognised stays pending (never "allowed"). */
export function toSimConsent(entry: z.infer<typeof consentEntrySchema>['result']): SimConsent {
  const raw = (entry.consent ?? entry.current_consent ?? '').trim().toUpperCase();
  const operator = entry.operator?.trim().toLowerCase() || null;
  const suggestion = entry.consent_suggestion?.trim() || null;

  let status: SimConsentStatus = 'pending';
  if (/^(ALLOWED|APPROVED)$/.test(raw)) status = 'allowed';
  else if (raw.startsWith('NOT REGISTERED')) status = 'not_registered';
  else if (/^(DENIED|REJECTED|REVOKED|BLOCKED)$/.test(raw)) status = 'denied';

  // Operators Intugine can't track never become allowed.
  const unsupported =
    /other operator/i.test(suggestion ?? '') ||
    (operator !== null && !SUPPORTED_OPERATORS.some((name) => operator.includes(name)));
  if (status !== 'allowed' && unsupported) status = 'unsupported';

  return { status, operator, suggestion };
}

/** POST /trips/start — `tripId` is what the status API is keyed on. */
export const startTripResponseSchema = z.object({
  tripId: z.string().min(1),
  msg: z.string().nullish(),
  consentResults: z.array(z.unknown()).nullish(),
});

/** POST /trips/end/:id answers 200 with a message in every case, including "No trip exists". */
export const endTripResponseSchema = z.object({
  msg: z.string(),
  tripId: z.string().nullish(),
});

/** POST /login */
export const loginResponseSchema = z.object({ token: z.string().min(1) });

/**
 * GET /status?tripId= — newest first. `loc` is [lat, lng]; `createdAt` is when the location was
 * taken. No speed, heading or accuracy: SIM positions are cell-tower fixes. Rows are validated one
 * by one so a malformed one can't sink the batch.
 */
export const locationRowSchema = z.object({
  _id: z.string().nullish(),
  tripId: z.string().nullish(),
  tel: z.string().nullish(),
  loc: z.tuple([z.number(), z.number()]),
  createdAt: z.string(),
  mode: z.string().nullish(),
  through: z.string().nullish(),
  tracking_type: z.string().nullish(),
  distance_remained: z.number().nullish(),
});
export type LocationRow = z.infer<typeof locationRowSchema>;

export interface SimOwner {
  tenantId: string;
  vehicleId: string;
  tripId: string | null;
  /** Set instead of `tripId` on the drive to the plant (see trips/trip-state APPROACH_STATUSES). */
  geofenceTripId?: string;
}

export function locationTimeMs(row: LocationRow): number | null {
  const ms = Date.parse(row.createdAt);
  return Number.isNaN(ms) ? null : ms;
}

/** In range and not the 0,0 an unlocated number reports. */
export function hasPosition(row: LocationRow): boolean {
  const [lat, lng] = row.loc;
  if (lat === 0 && lng === 0) return false;
  return lat >= -90 && lat <= 90 && lng >= -180 && lng <= 180;
}

export function toNormalizedPoint(
  row: LocationRow,
  recordedAtMs: number,
  intugineTripId: string,
  owner: SimOwner,
  receivedAt: string,
  operator: string | null,
): NormalizedPoint {
  const flags: Record<string, unknown> = { lowAccuracy: true };
  if (row.through) flags.through = row.through;
  if (row.tracking_type) flags.trackingType = row.tracking_type;
  if (operator) flags.operator = operator;
  if (owner.geofenceTripId) flags.geofenceTripId = owner.geofenceTripId;

  return {
    tenantId: owner.tenantId,
    vehicleId: owner.vehicleId,
    tripId: owner.tripId,
    source: 'sim',
    sourceRef: intugineTripId,
    recordedAt: new Date(recordedAtMs).toISOString(),
    receivedAt,
    lat: row.loc[0],
    lng: row.loc[1],
    speedKmh: null,
    heading: null,
    accuracyM: null,
    flags,
  };
}

/** The 10-digit national number Intugine expects, or null if the input isn't an Indian mobile. */
export function normalizePhone(input: string | null | undefined): string | null {
  const digits = (input ?? '').replace(/\D/g, '');
  const national = digits.length > 10 ? digits.replace(/^(91|0)/, '') : digits;
  return /^[6-9]\d{9}$/.test(national) ? national : null;
}
