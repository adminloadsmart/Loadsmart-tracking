import { DataSource } from 'typeorm';

/** One enter/exit to record, with the outbox events announcing it to the main backend. */
export interface GeofenceEventRecord {
  /** Deterministic (vehicle|geofence|event|time), so a redelivered batch inserts nothing new. */
  id: string;
  tenantId: string;
  geofenceId: string;
  vehicleId: string;
  loadId: string | null;
  event: 'enter' | 'exit';
  lat: number;
  lng: number;
  occurredAt: Date;
  outbox: Array<{ type: string; payload: Record<string, unknown> }>;
}

/**
 * Writes geofence transitions: the enter/exit log (tracking.geofence_events, the table main's
 * CreateGeofences migration made for it) and the outbox rows the relay forwards on
 * `tracking.events` — in one transaction. Outbox rows are written only for log rows actually
 * inserted, so the main backend hears about each transition exactly once.
 */
export class GeofencesRepository {
  constructor(private readonly dataSource: DataSource) {}

  async record(events: GeofenceEventRecord[]): Promise<number> {
    if (events.length === 0) return 0;
    return this.dataSource.transaction(async (manager) => {
      let inserted = 0;
      for (const e of events) {
        const rows: Array<{ id: string }> = await manager.query(
          `INSERT INTO tracking.geofence_events
             (id, tenant_id, geofence_id, vehicle_id, load_id, event, latitude, longitude, occurred_at)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
           ON CONFLICT (id) DO NOTHING
           RETURNING id`,
          [
            e.id,
            e.tenantId,
            e.geofenceId,
            e.vehicleId,
            e.loadId,
            e.event,
            e.lat.toFixed(6),
            e.lng.toFixed(6),
            e.occurredAt,
          ],
        );
        if (rows.length === 0) continue;
        inserted += 1;
        for (const { type, payload } of e.outbox) {
          await manager.query(
            `INSERT INTO tracking.alert_outbox (event_type, payload) VALUES ($1, $2)`,
            [type, JSON.stringify(payload)],
          );
        }
      }
      return inserted;
    });
  }
}
