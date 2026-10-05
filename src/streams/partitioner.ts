/**
 * Point stream partitioning (docs/ROADMAP.md §7): every point for one vehicle lands on the same
 * partition, and each partition has exactly one owning processor, so a vehicle's points are
 * processed in order. The hash must never change once data is flowing — it decides where
 * in-flight entries live.
 */
export const POINT_STREAM_PREFIX = 'trk:points';

/** 32-bit FNV-1a — stable across processes, platforms and Node versions. */
function fnv1a(input: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i += 1) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

export function partitionFor(vehicleId: string, partitions: number): number {
  if (!Number.isInteger(partitions) || partitions < 1) {
    throw new Error(`partitions must be a positive integer, got ${partitions}`);
  }
  return fnv1a(vehicleId.toLowerCase()) % partitions;
}

export function pointStreamKey(partition: number): string {
  return `${POINT_STREAM_PREFIX}:${partition}`;
}

export function allPointStreamKeys(partitions: number): string[] {
  return Array.from({ length: partitions }, (_, partition) => pointStreamKey(partition));
}
