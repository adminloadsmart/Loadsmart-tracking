import { Counter } from 'prom-client';
import type { Logger } from 'pino';
import type { EntityManager } from 'typeorm';
import { metricsRegistry } from '../../shared/metrics';
import { BatchResult, StreamEntry } from '../../streams/stream-consumer';
import { ActiveTripIndex, ActiveTripRefs } from './active-trip-index';
import { LoadPayload, parseSnapshot, Snapshot } from './sync.contract';
import { SyncRepository, TripRow } from './sync.repository';
import { marketVehicleId, normalizePlate, trackingStateFor } from './trip-state';

const snapshotsApplied = new Counter({
  name: 'tracking_sync_snapshots_total',
  help: 'loadsmart.events snapshots consumed, by type and outcome',
  labelNames: ['type', 'outcome'] as const,
  registers: [metricsRegistry],
});

/**
 * Keeps the read models in step with the main loadsmart backend (docs/ROADMAP.md §8.1) and owns
 * the trip lifecycle derived from load status: a trip becomes `active` at loading confirmation
 * (its vehicle/driver are then indexed in Redis for the ingest paths) and `ended` at delivery.
 */
export class SyncService {
  constructor(
    private readonly repository: SyncRepository,
    private readonly activeTrips: ActiveTripIndex,
    private readonly logger: Logger,
  ) {}

  async handleBatch(_stream: string, entries: StreamEntry[]): Promise<BatchResult> {
    const dead: BatchResult['dead'] = [];
    const retry: string[] = [];

    // Sequential: the stream is ordered, and versions make any reordering on retry safe.
    for (const entry of entries) {
      let snapshot: Snapshot;
      try {
        snapshot = parseSnapshot(entry.fields);
      } catch (err) {
        dead.push({ id: entry.id, reason: err instanceof Error ? err.message : String(err) });
        snapshotsApplied.inc({ type: entry.fields.type ?? 'unknown', outcome: 'invalid' });
        continue;
      }

      try {
        const applied = await this.apply(snapshot);
        snapshotsApplied.inc({ type: snapshot.type, outcome: applied ? 'applied' : 'stale' });
      } catch (err) {
        this.logger.error(
          { err, type: snapshot.type, id: snapshot.id },
          'Failed to apply snapshot',
        );
        snapshotsApplied.inc({ type: snapshot.type, outcome: 'error' });
        retry.push(entry.id);
      }
    }
    return { dead, retry };
  }

  /** Returns false when the snapshot was older than what's stored (ignored). */
  async apply(snapshot: Snapshot): Promise<boolean> {
    if (snapshot.type === 'driver') {
      return this.repository.upsertDriver(snapshot.id, snapshot.version, snapshot.payload);
    }
    const { id, tenantId, version } = snapshot;
    switch (snapshot.type) {
      case 'vehicle':
        return this.repository.upsertVehicle(id, tenantId, version, snapshot.payload);
      case 'loading_point':
      case 'delivery_point':
        return this.repository.upsertPlace(id, tenantId, snapshot.type, version, snapshot.payload);
      case 'load':
        return this.applyLoad(snapshot);
    }
  }

  private async applyLoad(snapshot: {
    id: string;
    tenantId: string;
    version: number;
    deleted: boolean;
    payload: LoadPayload | null;
  }): Promise<boolean> {
    const { id, tenantId, version, deleted } = snapshot;
    const load = deleted ? null : snapshot.payload;

    const result = await this.repository.transaction(async (manager) => {
      const previous = await this.repository.lockTrip(manager, id);
      // A tombstone for a load we never tracked: nothing to end.
      if (!load && !previous) return null;

      const vehicleId = load
        ? await this.resolveVehicleId(manager, tenantId, load, version)
        : previous!.vehicle_id;
      const driverId = load ? load.driverId : previous!.driver_id;
      const state = trackingStateFor(load?.status ?? 'closed', deleted);
      const now = new Date();

      const startedAt =
        previous?.tracking_started_at ??
        (state !== 'pending' ? (toDate(load?.milestones.loadingConfirmedAt) ?? now) : null);
      const endedAt =
        state === 'ended'
          ? (previous?.tracking_ended_at ?? toDate(load?.milestones.deliveredAt) ?? now)
          : null;

      const applied = load
        ? await this.repository.upsertTrip(manager, {
            id,
            tenantId,
            loadCode: load.code,
            loadStatus: load.status,
            sourceType: load.sourceType,
            vehicleId,
            vehicleNumber: load.vehicleNumber ? normalizePlate(load.vehicleNumber) : null,
            driverId,
            driverPhone: load.driverNumber,
            driverName: load.driverName,
            transporterId: load.transporterId,
            originPlaceId: load.loadingPointId,
            destinationPlaceId: load.deliveryPointId,
            trackingState: state,
            trackingStartedAt: startedAt,
            trackingEndedAt: endedAt,
            milestones: load.milestones,
            deleted: false,
            version,
          })
        : await this.repository.endDeletedTrip(manager, id, version, endedAt ?? now);

      return applied
        ? {
            previous,
            next: { tripId: id, tenantId, vehicleId, driverId, startedAt },
            state,
          }
        : false;
    });

    if (result === null) return true;
    if (result === false) return false;

    // After commit: bring the Redis index in line. If this throws, the entry is retried and the
    // (equal-version) upsert re-applies, re-running this step.
    await this.updateIndex(result.previous, result.next, result.state);
    return true;
  }

  private async resolveVehicleId(
    manager: EntityManager,
    tenantId: string,
    load: LoadPayload,
    version: number,
  ): Promise<string | null> {
    if (load.sourceType === 'own_fleet') return load.vehicleId;
    if (!load.vehicleNumber?.trim()) return null;
    const plate = normalizePlate(load.vehicleNumber);
    const id = marketVehicleId(tenantId, plate);
    await this.repository.ensureMarketVehicle(manager, id, tenantId, plate, version);
    return id;
  }

  private async updateIndex(
    previous: TripRow | null,
    next: ActiveTripRefs,
    state: string,
  ): Promise<void> {
    // Reassignment mid-trip: release the previous vehicle/driver before indexing the new ones.
    if (
      previous &&
      (previous.vehicle_id !== next.vehicleId || previous.driver_id !== next.driverId)
    ) {
      await this.activeTrips.deactivate(
        {
          tripId: next.tripId,
          tenantId: next.tenantId,
          startedAt: next.startedAt,
          vehicleId: previous.vehicle_id,
          driverId: previous.driver_id,
        },
        { endTrip: false },
      );
    }
    if (state === 'active') await this.activeTrips.activate(next);
    else await this.activeTrips.deactivate(next);
  }

  /** Restores the Redis active-trip index from Postgres (scheduler leader, on takeover). */
  async rebuildActiveTripIndex(): Promise<{ set: number; removed: number }> {
    const trips = await this.repository.findActiveTrips();
    const result = await this.activeTrips.rebuild(
      trips.map((trip) => ({
        tripId: trip.id,
        tenantId: trip.tenant_id,
        startedAt: trip.tracking_started_at,
        vehicleId: trip.vehicle_id,
        driverId: trip.driver_id,
      })),
    );
    this.logger.info(result, 'Active-trip index rebuilt');
    return result;
  }
}

function toDate(value: string | null | undefined): Date | null {
  return value ? new Date(value) : null;
}
