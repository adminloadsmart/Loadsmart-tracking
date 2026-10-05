import { createHash } from 'crypto';

/**
 * RFC 9562 version-5 (name-based, SHA-1) UUID. Deterministic: the same namespace + name always
 * gives the same id — used wherever a retried computation must produce the same row id (market
 * vehicles, rule episodes, alerts), so replays upsert instead of duplicating.
 */
export function uuidV5(namespace: string, name: string): string {
  const hash = createHash('sha1')
    .update(Buffer.from(namespace.replace(/-/g, ''), 'hex'))
    .update(name)
    .digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50; // version 5
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // RFC 4122 variant
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
