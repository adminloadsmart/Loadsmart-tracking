import type Redis from 'ioredis';

// Delete only if the key still points at this trip — never clobber a newer trip's entry.
const COMPARE_DEL_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

export const vehicleActiveTripKey = (vehicleId: string) => `trk:veh:${vehicleId}:active_trip`;
export const driverActiveTripKey = (driverId: string) => `trk:drv:${driverId}:active_trip`;
/** Hash {tenantId, vehicleId, driverId} for an active trip — what ingest needs to stamp a point. */
export const tripRefKey = (tripId: string) => `trk:trip:${tripId}:ref`;

export interface ActiveTripRefs {
  tripId: string;
  tenantId: string;
  vehicleId: string | null;
  driverId: string | null;
  startedAt: Date | null;
  /** Load status (e.g. in_transit) — rules evaluate some events only while in transit. */
  loadStatus?: string | null;
}

export interface TripRef {
  tripId: string;
  tenantId: string;
  vehicleId: string | null;
  /** Epoch ms tracking started — points recorded before it don't belong to this trip. */
  startedAtMs: number | null;
  loadStatus: string | null;
}

function refHash(trip: ActiveTripRefs): Record<string, string> {
  return {
    tenantId: trip.tenantId,
    vehicleId: trip.vehicleId ?? '',
    driverId: trip.driverId ?? '',
    startedAtMs: trip.startedAt ? String(trip.startedAt.getTime()) : '',
    loadStatus: trip.loadStatus ?? '',
  };
}

/**
 * Redis lookup of "which trip is this vehicle / driver on right now, and whose is it" — read on
 * every ingested point (phone socket, pollers) to stamp tripId/vehicleId/tenantId without touching
 * Postgres. Derived state: the trips table is the source of truth and rebuild() restores it after
 * a Redis loss.
 */
export class ActiveTripIndex {
  constructor(private readonly redis: Redis) {}

  async getTripForVehicle(vehicleId: string): Promise<string | null> {
    return this.redis.get(vehicleActiveTripKey(vehicleId));
  }

  async getTripForDriver(driverId: string): Promise<string | null> {
    return this.redis.get(driverActiveTripKey(driverId));
  }

  /** The vehicle/driver a trip is currently indexed under (to release them on reassignment). */
  async getRef(
    tripId: string,
  ): Promise<{ vehicleId: string | null; driverId: string | null } | null> {
    const ref = await this.redis.hgetall(tripRefKey(tripId));
    if (!ref.tenantId) return null;
    return { vehicleId: ref.vehicleId || null, driverId: ref.driverId || null };
  }

  /** The driver's active trip with its tenant and vehicle, or null if they're not on one. */
  async getTripRefForDriver(driverId: string): Promise<TripRef | null> {
    const tripId = await this.getTripForDriver(driverId);
    if (!tripId) return null;
    const ref = await this.redis.hgetall(tripRefKey(tripId));
    if (!ref.tenantId) return null;
    return {
      tripId,
      tenantId: ref.tenantId,
      vehicleId: ref.vehicleId || null,
      startedAtMs: ref.startedAtMs ? Number(ref.startedAtMs) : null,
      loadStatus: ref.loadStatus || null,
    };
  }

  async activate(trip: ActiveTripRefs): Promise<void> {
    const { tripId, vehicleId, driverId } = trip;
    const pipeline = this.redis.pipeline();
    pipeline.del(tripRefKey(tripId));
    pipeline.hset(tripRefKey(tripId), refHash(trip));
    if (vehicleId) pipeline.set(vehicleActiveTripKey(vehicleId), tripId);
    if (driverId) pipeline.set(driverActiveTripKey(driverId), tripId);
    await execOrThrow(pipeline);
  }

  /** Releases the given vehicle/driver from the trip; `endTrip` also drops the trip's ref hash. */
  async deactivate(
    { tripId, vehicleId, driverId }: ActiveTripRefs,
    { endTrip = true }: { endTrip?: boolean } = {},
  ): Promise<void> {
    const pipeline = this.redis.pipeline();
    if (endTrip) pipeline.del(tripRefKey(tripId));
    if (vehicleId) pipeline.eval(COMPARE_DEL_SCRIPT, 1, vehicleActiveTripKey(vehicleId), tripId);
    if (driverId) pipeline.eval(COMPARE_DEL_SCRIPT, 1, driverActiveTripKey(driverId), tripId);
    await execOrThrow(pipeline);
  }

  /** Load status of many trips in one round trip (missing = trip no longer active). */
  async getLoadStatuses(tripIds: string[]): Promise<Map<string, string>> {
    if (tripIds.length === 0) return new Map();
    const pipeline = this.redis.pipeline();
    for (const id of tripIds) pipeline.hget(tripRefKey(id), 'loadStatus');
    const results = (await pipeline.exec()) ?? [];
    const statuses = new Map<string, string>();
    tripIds.forEach((id, i) => {
      const [err, value] = results[i] ?? [];
      if (err) throw err;
      if (typeof value === 'string' && value) statuses.set(id, value);
    });
    return statuses;
  }

  /** Makes Redis match the given active trips exactly: sets missing keys, removes stale ones. */
  async rebuild(activeTrips: ActiveTripRefs[]): Promise<{ set: number; removed: number }> {
    const expected = new Map<string, string>();
    const expectedRefs = new Map<string, ActiveTripRefs>();
    for (const trip of activeTrips) {
      if (trip.vehicleId) expected.set(vehicleActiveTripKey(trip.vehicleId), trip.tripId);
      if (trip.driverId) expected.set(driverActiveTripKey(trip.driverId), trip.tripId);
      expectedRefs.set(tripRefKey(trip.tripId), trip);
    }

    let removed = 0;
    for (const pattern of ['trk:veh:*:active_trip', 'trk:drv:*:active_trip', 'trk:trip:*:ref']) {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = next;
        const stale = keys.filter((key) => !expected.has(key) && !expectedRefs.has(key));
        if (stale.length > 0) removed += await this.redis.del(...stale);
      } while (cursor !== '0');
    }

    if (expected.size > 0 || expectedRefs.size > 0) {
      const pipeline = this.redis.pipeline();
      for (const [key, tripId] of expected) pipeline.set(key, tripId);
      for (const [key, trip] of expectedRefs) {
        pipeline.hset(key, refHash(trip));
      }
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
