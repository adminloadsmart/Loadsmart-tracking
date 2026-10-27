import { uuidV5 } from '../../shared/utils/uuid';
import { haversineMeters } from '../processing/geo';
import type { Anchor, RuleId } from './rule.types';

// Fixed namespaces — never change them, or replays would mint new episode/alert ids.
const EPISODE_NAMESPACE = '0a8f3c55-6c1d-5e0b-9a1f-6f4b2d9e7c31';
const ALERT_NAMESPACE = '5d2e7b19-3a4c-5f86-8b0d-1c9e6a7f2b44';
const NOTICE_NAMESPACE = '9c4a1e7d-2b6f-5a83-8e1c-4d7f0b3a6e92';

/** Deterministic episode id: the same vehicle/rule/start always maps to the same row. */
export function episodeId(
  vehicleId: string,
  ruleId: RuleId,
  startedAtMs: number,
  key = '',
): string {
  return uuidV5(EPISODE_NAMESPACE, `${vehicleId}|${ruleId}|${key}|${startedAtMs}`);
}

export function alertId(dedupeKey: string, occurredAtMs: number): string {
  return uuidV5(ALERT_NAMESPACE, `${dedupeKey}|${occurredAtMs}`);
}

/** Deterministic trip-notice id: the same trip + occurrence key always maps to the same row. */
export function noticeId(tripId: string, key: string): string {
  return uuidV5(NOTICE_NAMESPACE, `${tripId}|${key}`);
}

const median = (values: number[]) => {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Anchor = median of the first fixes of a stop (robust to one bad fix, unlike the mean). */
export function medianAnchor(points: Anchor[]): Anchor {
  return { lat: median(points.map((p) => p.lat)), lng: median(points.map((p) => p.lng)) };
}

export const distanceM = (a: Anchor, b: Anchor) => haversineMeters(a, b);

const IST_OFFSET_MIN = 330;

/** Minutes since midnight in IST (device time). */
export function istMinuteOfDay(epochMs: number): number {
  return (((Math.floor(epochMs / 60_000) + IST_OFFSET_MIN) % 1440) + 1440) % 1440;
}

/** "HH:MM" → minutes since midnight. */
export function parseClock(value: string): number {
  const [h, m] = value.split(':').map(Number);
  return h * 60 + (m || 0);
}

/** In a daily window that may cross midnight: t ≥ start OR t < end (when start > end). */
export function inDailyWindow(epochMs: number, start: number, end: number): boolean {
  const minute = istMinuteOfDay(epochMs);
  return start <= end ? minute >= start && minute < end : minute >= start || minute < end;
}

/**
 * Which night a time belongs to: the IST calendar date on which that window STARTED, as
 * 'YYYY-MM-DD'. An episode crossing midnight therefore counts as one night.
 */
export function windowNightKey(epochMs: number, start: number): string {
  const istMs = epochMs + IST_OFFSET_MIN * 60_000;
  const day = new Date(istMs);
  if (istMinuteOfDay(epochMs) < start) day.setUTCDate(day.getUTCDate() - 1);
  return day.toISOString().slice(0, 10);
}

/** End of the window that `nightKey` started, as epoch ms. */
export function windowEndMs(nightKey: string, start: number, end: number): number {
  const startOfNightIst = Date.parse(`${nightKey}T00:00:00Z`) - IST_OFFSET_MIN * 60_000;
  const endOffsetMin = start <= end ? end : end + 1440;
  return startOfNightIst + endOffsetMin * 60_000;
}

export const num = (params: Record<string, unknown>, key: string): number => Number(params[key]);
