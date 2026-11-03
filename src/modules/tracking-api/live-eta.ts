import type Redis from 'ioredis';
import type { ProgressState } from '../rules/rules/progress-gps.rule';

const progressFields = ['DELAY-GPS|driver_app', 'DELAY-GPS|roadcast'];
const round1 = (value: number) => Math.round(value * 10) / 10;

/**
 * The trip's ETA hash (trk:trip:{id}:eta, written by the DelayMonitor every few minutes), kept
 * live between those evaluations: the processor updates the trip's progress along the route on
 * every fix, so remaining km — and with it km covered, the ETA at the evaluated speed and the
 * projected delay — follow the truck point by point. Without a fresh evaluation, or progress, the
 * hash is returned as written.
 */
export async function readLiveEta(redis: Redis, tripId: string): Promise<Record<string, string>> {
  const eta = await redis.hgetall(`trk:trip:${tripId}:eta`);
  if (!eta.etaAt || eta.stale === '1' || !eta.vehicleId || !eta.routeLengthM) return eta;

  const raw = await redis.hmget(`trk:rules:${eta.vehicleId}`, ...progressFields);
  const progress = raw
    .filter((v): v is string => !!v)
    .map((v) => JSON.parse(v) as ProgressState)
    .filter((p) => p.tripId === tripId && p.lastFixMs)
    .sort((a, b) => (b.lastFixMs ?? 0) - (a.lastFixMs ?? 0))[0];
  const speedKmh = Number(eta.speedKmh);
  if (!progress || !(speedKmh > 0)) return eta;

  const remainingKm = Math.max(0, Number(eta.routeLengthM) - progress.furthestAlongM) / 1000;
  const etaMs = Date.now() + (remainingKm / speedKmh) * 3_600_000;
  const promisedMs = Number(eta.promisedAt);
  return {
    ...eta,
    remainingKm: String(round1(remainingKm)),
    etaAt: String(Math.round(etaMs)),
    ...(promisedMs ? { projectedDelayMin: String(Math.round((etaMs - promisedMs) / 60_000)) } : {}),
  };
}
