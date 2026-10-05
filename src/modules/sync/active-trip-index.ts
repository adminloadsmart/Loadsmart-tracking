import type Redis from 'ioredis';

// Delete only if the key still points at this trip — never clobber a newer trip's entry.
const COMPARE_DEL_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

export const vehicleActiveTripKey = (vehicleId: string) => `trk:veh:${vehicleId}:active_trip`;
export const driverActiveTripKey = (driverId: string) => `trk:drv:${driverId}:active_trip`;

export interface ActiveTripRefs {
  tripId: string;
  vehicleId: string | null;
  driverId: string | null;
}

/**
 * Redis lookup of "which trip is this vehicle / driver on right now" — read on every ingested
 * point (phone socket, pollers) to stamp tripId without touching Postgres. Derived state: the
 * trips table is the source of truth and rebuild() restores it after a Redis loss.
 */
export class ActiveTripIndex {
  constructor(private readonly redis: Redis) {}

  async getTripForVehicle(vehicleId: string): Promise<string | null> {
    return this.redis.get(vehicleActiveTripKey(vehicleId));
  }

  async getTripForDriver(driverId: string): Promise<string | null> {
    return this.redis.get(driverActiveTripKey(driverId));
  }

  async activate({ tripId, vehicleId, driverId }: ActiveTripRefs): Promise<void> {
    const pipeline = this.redis.pipeline();
    if (vehicleId) pipeline.set(vehicleActiveTripKey(vehicleId), tripId);
    if (driverId) pipeline.set(driverActiveTripKey(driverId), tripId);
    await execOrThrow(pipeline);
  }

  async deactivate({ tripId, vehicleId, driverId }: ActiveTripRefs): Promise<void> {
    const pipeline = this.redis.pipeline();
    if (vehicleId) pipeline.eval(COMPARE_DEL_SCRIPT, 1, vehicleActiveTripKey(vehicleId), tripId);
    if (driverId) pipeline.eval(COMPARE_DEL_SCRIPT, 1, driverActiveTripKey(driverId), tripId);
    await execOrThrow(pipeline);
  }

  /** Makes Redis match the given active trips exactly: sets missing keys, removes stale ones. */
  async rebuild(activeTrips: ActiveTripRefs[]): Promise<{ set: number; removed: number }> {
    const expected = new Map<string, string>();
    for (const trip of activeTrips) {
      if (trip.vehicleId) expected.set(vehicleActiveTripKey(trip.vehicleId), trip.tripId);
      if (trip.driverId) expected.set(driverActiveTripKey(trip.driverId), trip.tripId);
    }

    let removed = 0;
    for (const pattern of ['trk:veh:*:active_trip', 'trk:drv:*:active_trip']) {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = next;
        const stale = keys.filter((key) => !expected.has(key));
        if (stale.length > 0) removed += await this.redis.del(...stale);
      } while (cursor !== '0');
    }

    if (expected.size > 0) {
      const pipeline = this.redis.pipeline();
      for (const [key, tripId] of expected) pipeline.set(key, tripId);
      await execOrThrow(pipeline);
    }
    return { set: expected.size, removed };
  }
}

async function execOrThrow(pipeline: ReturnType<Redis['pipeline']>): Promise<void> {
  const results = await pipeline.exec();
  const failed = results?.find(([err]) => err);
  if (failed) throw failed[0];
}
