import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import type { Crossing } from './ulip.contract';

/** The load a batch of crossings is stored for. */
export interface CrossingOwner {
  tenantId: string;
  loadId: string;
  vehicleId: string;
  vehicleNumber: string;
}

/** A stored crossing, as the API shows it. */
export interface CrossingRow {
  seqNo: string;
  vehicleNumber: string;
  crossedAt: Date;
  tollPlazaName: string;
  lat: number | null;
  lng: number | null;
  laneDirection: string | null;
  vehicleType: string | null;
}

/** What the FASTag poll needs to save crossings (a fake in tests). */
export interface CrossingStore {
  /** Saves the crossings not stored yet for this load; returns how many were new. */
  insertMany(owner: CrossingOwner, crossings: Crossing[]): Promise<number>;
}

/** SQL for tracking.fastag_crossings (see the FastagCrossings migration). */
export class FastagCrossingRepository implements CrossingStore {
  constructor(private readonly dataSource: DataSource) {}

  async insertMany(owner: CrossingOwner, crossings: Crossing[]): Promise<number> {
    if (crossings.length === 0) return 0;
    // One statement for the whole batch: the arrays are unnested into rows. A crossing already
    // stored (same load, same ULIP transaction id) is skipped, which is what makes re-polling safe.
    const rows: unknown[] = await this.dataSource.query(
      `INSERT INTO tracking.fastag_crossings
         (id, tenant_id, load_id, vehicle_id, vehicle_number, seq_no, crossed_at,
          toll_plaza_name, toll_lat, toll_lng, lane_direction, vehicle_type, raw)
       SELECT t.id, $1, $2, $3, $4, t.seq_no, t.crossed_at, t.name, t.lat, t.lng, t.direction,
              t.vehicle_type, t.raw::jsonb
       FROM unnest($5::uuid[], $6::text[], $7::timestamptz[], $8::text[], $9::float8[],
                   $10::float8[], $11::text[], $12::text[], $13::text[])
         AS t(id, seq_no, crossed_at, name, lat, lng, direction, vehicle_type, raw)
       ON CONFLICT (load_id, seq_no) DO NOTHING
       RETURNING id`,
      [
        owner.tenantId,
        owner.loadId,
        owner.vehicleId,
        owner.vehicleNumber,
        crossings.map(() => randomUUID()),
        crossings.map((c) => c.seqNo),
        crossings.map((c) => new Date(c.crossedAtMs).toISOString()),
        crossings.map((c) => c.tollPlazaName),
        crossings.map((c) => c.lat),
        crossings.map((c) => c.lng),
        crossings.map((c) => c.laneDirection),
        crossings.map((c) => c.vehicleType),
        crossings.map((c) => JSON.stringify(c.raw)),
      ],
    );
    return rows.length;
  }

  /** A load's crossings, oldest first. */
  async listByLoad(loadId: string, limit: number): Promise<CrossingRow[]> {
    const rows: Array<{
      seq_no: string;
      vehicle_number: string;
      crossed_at: Date;
      toll_plaza_name: string;
      toll_lat: number | null;
      toll_lng: number | null;
      lane_direction: string | null;
      vehicle_type: string | null;
    }> = await this.dataSource.query(
      `SELECT seq_no, vehicle_number, crossed_at, toll_plaza_name, toll_lat, toll_lng,
              lane_direction, vehicle_type
       FROM tracking.fastag_crossings WHERE load_id = $1 ORDER BY crossed_at, seq_no LIMIT $2`,
      [loadId, limit],
    );
    return rows.map((r) => ({
      seqNo: r.seq_no,
      vehicleNumber: r.vehicle_number,
      crossedAt: r.crossed_at,
      tollPlazaName: r.toll_plaza_name,
      lat: r.toll_lat,
      lng: r.toll_lng,
      laneDirection: r.lane_direction,
      vehicleType: r.vehicle_type,
    }));
  }
}
