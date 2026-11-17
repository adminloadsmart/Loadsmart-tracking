import { z } from 'zod';

/** POST /user/login → { response: { id: <bearer token> }, error: "false", code: "200", ... } */
export const loginResponseSchema = z.object({
  response: z.object({ id: z.string().min(1) }),
});

/** One toll transaction (`vehltxnList.txn[]`) as ULIP returns it. */
export const txnSchema = z.object({
  readerReadTime: z.string(),
  // ULIP's own transaction id; the sample ids are strings, but accept numbers too.
  seqNo: z.union([z.string(), z.number()]).transform(String).pipe(z.string().min(1)),
  laneDirection: z.string().nullish(),
  tollPlazaGeocode: z.string().nullish(),
  tollPlazaName: z.string().nullish(),
  vehicleType: z.string().nullish(),
  vehicleRegNo: z.string().nullish(),
});
export type UlipTxn = z.infer<typeof txnSchema>;

/**
 * POST /FASTAG/01 → { response: [ { response: { result, respCode, vehicle: { errCode,
 * vehltxnList: { txn: [...] } } }, responseStatus, message } ], error, code, message }.
 * Only the parts we read are described; the transactions stay `unknown` so one malformed row
 * can be dropped without losing the rest.
 */
const fastagResponseSchema = z.object({
  response: z.array(
    z.object({
      response: z
        .object({
          result: z.string().nullish(),
          respCode: z.string().nullish(),
          vehicle: z
            .object({
              errCode: z.string().nullish(),
              vehltxnList: z.object({ txn: z.unknown().optional() }).nullish(),
            })
            .nullish(),
        })
        .nullish(),
      responseStatus: z.string().nullish(),
      message: z.string().nullish(),
    }),
  ),
  message: z.string().nullish(),
});

export type FastagExtract =
  { ok: true; txns: unknown[] } | { ok: false; reason: string; respCode: string | null };

/**
 * The raw transactions of a FASTag answer. A SUCCESS answer with no transaction list is "no
 * crossings" (an empty list); anything else that is not SUCCESS comes back as `ok: false` with
 * ULIP's own codes, for the caller to treat as an error.
 */
export function extractTransactions(body: unknown): FastagExtract {
  const parsed = fastagResponseSchema.safeParse(body);
  if (!parsed.success || parsed.data.response.length === 0) {
    return { ok: false, reason: 'unexpected response shape', respCode: null };
  }
  const outer = parsed.data.response[0];
  const inner = outer.response;
  if (!inner || inner.result !== 'SUCCESS') {
    return {
      ok: false,
      reason: [outer.responseStatus, outer.message, inner?.result, inner?.vehicle?.errCode]
        .filter(Boolean)
        .join(' / '),
      respCode: inner?.respCode ?? null,
    };
  }
  const txn = inner.vehicle?.vehltxnList?.txn;
  // Converters from XML turn a single element into an object instead of a one-item list.
  if (Array.isArray(txn)) return { ok: true, txns: txn };
  return { ok: true, txns: txn && typeof txn === 'object' ? [txn] : [] };
}

// ULIP sends "2026-10-28 18:30:20.000" with no zone. FASTag readers are in India, so it is read as IST.
const IST_OFFSET = '+05:30';
const READER_TIME = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})(\.\d+)?$/;

/** `readerReadTime` as epoch ms, or null if it isn't a plain local timestamp. */
export function readerTimeMs(value: string): number | null {
  const match = READER_TIME.exec(value.trim());
  if (!match) return null;
  const ms = Date.parse(`${match[1]}T${match[2]}${match[3] ?? ''}${IST_OFFSET}`);
  return Number.isNaN(ms) ? null : ms;
}

/** "29.071744,77.0601904" → coordinates, or null if missing, malformed, out of range or 0,0. */
export function parseGeocode(
  value: string | null | undefined,
): { lat: number; lng: number } | null {
  if (!value) return null;
  const [rawLat, rawLng, ...rest] = value.split(',');
  if (rawLng === undefined || rest.length > 0 || !rawLat.trim() || !rawLng.trim()) return null;
  const lat = Number(rawLat);
  const lng = Number(rawLng);
  if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;
  if (Math.abs(lat) > 90 || Math.abs(lng) > 180 || (lat === 0 && lng === 0)) return null;
  return { lat, lng };
}

/** A crossing ready to store (before it is tied to a load). */
export interface Crossing {
  seqNo: string;
  crossedAtMs: number;
  tollPlazaName: string;
  lat: number | null;
  lng: number | null;
  laneDirection: string | null;
  vehicleType: string | null;
  /** The transaction exactly as received. */
  raw: unknown;
}

export function toCrossing(raw: unknown): Crossing | null {
  const parsed = txnSchema.safeParse(raw);
  if (!parsed.success) return null;
  const txn = parsed.data;
  const crossedAtMs = readerTimeMs(txn.readerReadTime);
  if (crossedAtMs === null) return null;
  const geo = parseGeocode(txn.tollPlazaGeocode);
  return {
    seqNo: txn.seqNo,
    crossedAtMs,
    tollPlazaName: txn.tollPlazaName?.trim() || 'Unknown toll plaza',
    lat: geo?.lat ?? null,
    lng: geo?.lng ?? null,
    laneDirection: txn.laneDirection?.trim() || null,
    vehicleType: txn.vehicleType?.trim() || null,
    raw,
  };
}
