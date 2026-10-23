import type Redis from 'ioredis';

// Delete only if the key still points at this trip — never clobber a newer trip's entry.
const COMPARE_DEL_SCRIPT = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0`;

// Remove a device from its org's on-trip registry only if it still belongs to this vehicle (a
// reassigned truck or a moved IMEI must not drop another vehicle's entry), and drop the org from
// the registry's org set once it has no device left.
const REMOVE_DEVICE_SCRIPT = `
if redis.call('hget', KEYS[1], ARGV[1]) == ARGV[2] then
  redis.call('hdel', KEYS[1], ARGV[1])
end
if redis.call('hlen', KEYS[1]) == 0 then
  redis.call('srem', KEYS[2], ARGV[3])
end
return 0`;

export const vehicleActiveTripKey = (vehicleId: string) => `trk:veh:${vehicleId}:active_trip`;
export const driverActiveTripKey = (driverId: string) => `trk:drv:${driverId}:active_trip`;
/** Hash {tenantId, vehicleId, driverId} for an active trip — what ingest needs to stamp a point. */
export const tripRefKey = (tripId: string) => `trk:trip:${tripId}:ref`;
/** Per org, the GPS devices of its trucks on a trip: hash IMEI → vehicleId. The device pollers
 *  read this every tick instead of working out from all devices which ones are on a trip. */
export const onTripDevicesKey = (tenantId: string) => `trk:ontrip-devices:${tenantId}`;
/** Orgs with at least one entry in their on-trip device registry. */
export const ON_TRIP_TENANTS_KEY = 'trk:ontrip-devices:tenants';

export interface OnTripDevice {
  imei: string;
  vehicleId: string;
  tenantId: string;
}

export interface ActiveTripRefs {
  tripId: string;
  tenantId: string;
  vehicleId: string | null;
  driverId: string | null;
  startedAt: Date | null;
  /** Load status (e.g. in_transit) — rules evaluate some events only while in transit. */
  loadStatus?: string | null;
  /** The vehicle's GPS device IMEI, if it has one (on-trip device registry). */
  deviceImei?: string | null;
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
    deviceImei: trip.deviceImei ?? '',
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

  /** The vehicle/driver/device a trip is currently indexed under (to release on reassignment). */
  async getRef(tripId: string): Promise<{
    tenantId: string;
    vehicleId: string | null;
    driverId: string | null;
    deviceImei: string | null;
  } | null> {
    const ref = await this.redis.hgetall(tripRefKey(tripId));
    if (!ref.tenantId) return null;
    return {
      tenantId: ref.tenantId,
      vehicleId: ref.vehicleId || null,
      driverId: ref.driverId || null,
      deviceImei: ref.deviceImei || null,
    };
  }

  /** The on-trip device registry, per org — two round trips, whatever the fleet size. */
  async onTripDevicesByTenant(): Promise<Map<string, OnTripDevice[]>> {
    const byTenant = new Map<string, OnTripDevice[]>();
    const tenants = await this.redis.smembers(ON_TRIP_TENANTS_KEY);
    if (tenants.length === 0) return byTenant;
    const pipeline = this.redis.pipeline();
    for (const tenantId of tenants) pipeline.hgetall(onTripDevicesKey(tenantId));
    const results = (await pipeline.exec()) ?? [];
    tenants.forEach((tenantId, i) => {
      const [err, hash] = results[i] ?? [];
      if (err) throw err;
      const devices = Object.entries((hash ?? {}) as Record<string, string>).map(
        ([imei, vehicleId]) => ({ imei, vehicleId, tenantId }),
      );
      if (devices.length > 0) byTenant.set(tenantId, devices);
    });
    return byTenant;
  }

  /** The driver's active trip with its tenant and vehicle, or null if they're not on one. */
  async getTripRefForDriver(driverId: string): Promise<TripRef | null> {
    const tripId = await this.getTripForDriver(driverId);
    if (!tripId) return null;
    return toTripRef(tripId, await this.redis.hgetall(tripRefKey(tripId)));
  }

  /** Active trip per vehicle, for a poller's whole batch in two round trips. */
  async getTripRefsForVehicles(vehicleIds: string[]): Promise<Map<string, TripRef>> {
    const refs = new Map<string, TripRef>();
    if (vehicleIds.length === 0) return refs;
    const tripIds = await this.redis.mget(vehicleIds.map(vehicleActiveTripKey));
    const onTrip = vehicleIds.flatMap((vehicleId, i) => {
      const tripId = tripIds[i];
      return tripId ? [{ vehicleId, tripId }] : [];
    });
    if (onTrip.length === 0) return refs;

    const pipeline = this.redis.pipeline();
    for (const { tripId } of onTrip) pipeline.hgetall(tripRefKey(tripId));
    const results = (await pipeline.exec()) ?? [];
    onTrip.forEach(({ vehicleId, tripId }, i) => {
      const [err, hash] = results[i] ?? [];
      if (err) throw err;
      const ref = toTripRef(tripId, (hash ?? {}) as Record<string, string>);
      if (ref) refs.set(vehicleId, ref);
    });
    return refs;
  }

  async activate(trip: ActiveTripRefs): Promise<void> {
    const { tripId, vehicleId, driverId } = trip;
    const pipeline = this.redis.pipeline();
    pipeline.del(tripRefKey(tripId));
    pipeline.hset(tripRefKey(tripId), refHash(trip));
    if (vehicleId) pipeline.set(vehicleActiveTripKey(vehicleId), tripId);
    if (driverId) pipeline.set(driverActiveTripKey(driverId), tripId);
    if (vehicleId && trip.deviceImei) {
      pipeline.hset(onTripDevicesKey(trip.tenantId), trip.deviceImei, vehicleId);
      pipeline.sadd(ON_TRIP_TENANTS_KEY, trip.tenantId);
    }
    await execOrThrow(pipeline);
  }

  /** Releases the given vehicle/driver from the trip; `endTrip` also drops the trip's ref hash. */
  async deactivate(
    { tripId, tenantId, vehicleId, driverId, deviceImei }: ActiveTripRefs,
    { endTrip = true }: { endTrip?: boolean } = {},
  ): Promise<void> {
    const pipeline = this.redis.pipeline();
    if (endTrip) pipeline.del(tripRefKey(tripId));
    if (vehicleId) pipeline.eval(COMPARE_DEL_SCRIPT, 1, vehicleActiveTripKey(vehicleId), tripId);
    if (driverId) pipeline.eval(COMPARE_DEL_SCRIPT, 1, driverActiveTripKey(driverId), tripId);
    if (vehicleId && deviceImei) {
      pipeline.eval(
        REMOVE_DEVICE_SCRIPT,
        2,
        onTripDevicesKey(tenantId),
        ON_TRIP_TENANTS_KEY,
        deviceImei,
        vehicleId,
        tenantId,
      );
    }
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
    const expectedDevices = new Map<string, Record<string, string>>();
    for (const trip of activeTrips) {
      if (trip.vehicleId) expected.set(vehicleActiveTripKey(trip.vehicleId), trip.tripId);
      if (trip.driverId) expected.set(driverActiveTripKey(trip.driverId), trip.tripId);
      expectedRefs.set(tripRefKey(trip.tripId), trip);
      if (trip.vehicleId && trip.deviceImei) {
        const key = onTripDevicesKey(trip.tenantId);
        expectedDevices.set(key, {
          ...expectedDevices.get(key),
          [trip.deviceImei]: trip.vehicleId,
        });
      }
    }
    const isExpected = (key: string) =>
      expected.has(key) ||
      expectedRefs.has(key) ||
      expectedDevices.has(key) ||
      key === ON_TRIP_TENANTS_KEY;

    let removed = 0;
    for (const pattern of [
      'trk:veh:*:active_trip',
      'trk:drv:*:active_trip',
      'trk:trip:*:ref',
      'trk:ontrip-devices:*',
    ]) {
      let cursor = '0';
      do {
        const [next, keys] = await this.redis.scan(cursor, 'MATCH', pattern, 'COUNT', 500);
        cursor = next;
        const stale = keys.filter((key) => !isExpected(key));
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

    // The device registry is replaced whole, in one transaction: a poller tick never sees an org
    // half-written. Hashes are rewritten (not merged) so a device that left a trip is dropped.
    const registry = this.redis.multi();
    registry.del(ON_TRIP_TENANTS_KEY);
    for (const [key, devices] of expectedDevices) {
      registry.del(key);
      registry.hset(key, devices);
    }
    const tenants = activeTrips
      .filter((trip) => trip.vehicleId && trip.deviceImei)
      .map((trip) => trip.tenantId);
    if (tenants.length > 0) registry.sadd(ON_TRIP_TENANTS_KEY, ...new Set(tenants));
    await execOrThrow(registry);
    return { set: expected.size, removed };
  }
}

function toTripRef(tripId: string, ref: Record<string, string>): TripRef | null {
  if (!ref.tenantId) return null;
  return {
    tripId,
    tenantId: ref.tenantId,
    vehicleId: ref.vehicleId || null,
    startedAtMs: ref.startedAtMs ? Number(ref.startedAtMs) : null,
    loadStatus: ref.loadStatus || null,
  };
}

async function execOrThrow(pipeline: ReturnType<Redis['pipeline']>): Promise<void> {
  const results = await pipeline.exec();
  const failed = results?.find(([err]) => err);
  if (failed) throw failed[0];
}
