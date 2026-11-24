import { haversineMeters } from '../processing/geo';

/** One GPS-device fix, oldest first (see TrackingApiRepository.vehicleGpsPoints). */
export interface StatsPoint {
  at: number;
  lat: number;
  lng: number;
  speedKmh: number | null;
  ignition: boolean | null;
  batteryPct: number | null;
  deviceStatus: string | null;
}

/** Days are India days (IST, no DST). */
const IST_OFFSET_MS = 330 * 60_000;
const DAY_MS = 86_400_000;
/** A longer silence is "no data", not driving or standing. */
const MAX_GAP_MS = 30 * 60_000;
/** A jump faster than this between two fixes is a bad fix, not distance. */
const MAX_PLAUSIBLE_KMH = 160;
/** At or above this the truck counts as running. */
const MOVING_KMH = 5;
/** A standing truck's GPS wanders; shorter hops while standing are noise. */
const MIN_HOP_M = 50;

export const STATS_DAYS = 7;

/** "2026-11-24" for the India day an instant falls in. */
export const istDay = (ms: number) => new Date(ms + IST_OFFSET_MS).toISOString().slice(0, 10);

/** Start of the India day `ms` falls in, as epoch ms. */
export const istDayStart = (ms: number) =>
  Math.floor((ms + IST_OFFSET_MS) / DAY_MS) * DAY_MS - IST_OFFSET_MS;

/** Where the stats window starts: midnight IST, `days - 1` days before today. */
export const statsWindowStart = (nowMs: number, days = STATS_DAYS) =>
  istDayStart(nowMs) - (days - 1) * DAY_MS;

export interface VehicleStats {
  today: {
    from: string;
    to: string;
    distanceKm: number;
    runningMin: number;
    stoppedMin: number;
    /** Engine on but not moving; null when the device doesn't report ignition. */
    idleMin: number | null;
    maxSpeedKmh: number | null;
    /** Average reported speed while running (else distance over running time). */
    avgSpeedKmh: number | null;
  };
  /** Oldest first, one per India day, ending today. */
  days: Array<{ date: string; distanceKm: number }>;
  /** The newest fix's device readings; null when there is no fix in the window. */
  device: {
    lastFixAt: string;
    batteryPct: number | null;
    ignition: boolean | null;
    deviceStatus: string | null;
  } | null;
}

const round1 = (n: number) => Math.round(n * 10) / 10;

/**
 * Daily distance and today's running / stopped / idle time from the vehicle's own GPS fixes.
 * Each gap between two fixes is credited to the earlier fix's state and day; silences over
 * 30 min and impossible jumps count for nothing.
 */
export function vehicleStats(points: StatsPoint[], nowMs: number, days = STATS_DAYS): VehicleStats {
  const todayStart = istDayStart(nowMs);
  const windowStart = statsWindowStart(nowMs, days);
  const kmByDay = new Map<string, number>();
  let runningMs = 0;
  let stoppedMs = 0;
  let idleMs = 0;
  let todayM = 0;
  let maxSpeed: number | null = null;
  // Time-weighted reported speed while running (the device's own speedometer).
  let reportedSpeedMs = 0;
  let reportedMs = 0;
  const hasIgnition = points.some((p) => p.ignition !== null);

  for (let i = 0; i < points.length; i++) {
    const a = points[i];
    if (a.at < windowStart) continue;
    const today = a.at >= todayStart;
    if (today && a.speedKmh !== null && a.speedKmh <= MAX_PLAUSIBLE_KMH)
      maxSpeed = Math.max(maxSpeed ?? 0, a.speedKmh);

    const b = points[i + 1];
    if (!b) continue;
    const dt = Math.min(b.at, nowMs) - a.at;
    if (dt <= 0 || dt > MAX_GAP_MS) continue;
    const m = haversineMeters(a, b);
    const implied = ((m / dt) * 3_600_000) / 1000;
    if (implied > MAX_PLAUSIBLE_KMH) continue;

    const speed = a.speedKmh ?? implied;
    const moving = speed >= MOVING_KMH;
    if (moving || m >= MIN_HOP_M) {
      const day = istDay(a.at);
      kmByDay.set(day, (kmByDay.get(day) ?? 0) + m / 1000);
      if (today) todayM += m;
    }
    if (!today) continue;
    if (moving) {
      runningMs += dt;
      if (a.speedKmh !== null) {
        reportedSpeedMs += a.speedKmh * dt;
        reportedMs += dt;
      }
    } else if (a.ignition === true) idleMs += dt;
    else stoppedMs += dt;
  }

  const last = points.at(-1);
  const runningH = runningMs / 3_600_000;
  return {
    today: {
      from: new Date(todayStart).toISOString(),
      to: new Date(nowMs).toISOString(),
      distanceKm: round1(todayM / 1000),
      runningMin: Math.round(runningMs / 60_000),
      stoppedMin: Math.round(stoppedMs / 60_000),
      idleMin: hasIgnition ? Math.round(idleMs / 60_000) : null,
      maxSpeedKmh: maxSpeed === null ? null : Math.round(maxSpeed),
      // The device's reported speed while running; distance over running time when it reports none.
      avgSpeedKmh:
        runningH < 1 / 60
          ? null
          : Math.round(reportedMs ? reportedSpeedMs / reportedMs : todayM / 1000 / runningH),
    },
    days: Array.from({ length: days }, (_, i) => {
      const date = istDay(windowStart + i * DAY_MS);
      return { date, distanceKm: round1(kmByDay.get(date) ?? 0) };
    }),
    device: last
      ? {
          lastFixAt: new Date(last.at).toISOString(),
          batteryPct: last.batteryPct,
          ignition: last.ignition,
          deviceStatus: last.deviceStatus,
        }
      : null,
  };
}
