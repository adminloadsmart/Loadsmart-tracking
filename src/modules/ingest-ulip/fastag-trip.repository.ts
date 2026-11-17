import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';

export type FastagTripState = 'active' | 'closing' | 'ended';

export interface FastagTripRow {
  id: string;
  tenantId: string;
  /** The main backend's load id (our trip). */
  loadId: string;
  vehicleId: string;
  vehicleNumber: string;
  state: FastagTripState;
  windowStart: Date;
  windowEnd: Date | null;
  attempts: number;
}

export interface NewFastagTrip {
  tenantId: string;
  loadId: string;
  vehicleId: string;
  vehicleNumber: string;
  windowStart: Date;
}

export interface DueOptions {
  /** An active load is polled again after this long. */
  intervalMs: number;
  /** A finished load gets its last poll this long after it ended, so late-posted tolls are caught. */
  finalDelayMs: number;
  limit: number;
}

/** What the FASTag lifecycle and poll need from storage (a fake in tests). */
export interface FastagTripStore {
  /** Rows not yet ended (active and closing). */
  liveRows(): Promise<FastagTripRow[]>;
  /** Null if another process created the active row first. */
  insert(input: NewFastagTrip): Promise<FastagTripRow | null>;
  /** The load left the tracked statuses (or its truck changed): stop at `windowEnd`, then poll once more. */
  markClosing(id: string, windowEnd: Date, reason: string): Promise<void>;
  /** Rows whose poll is due, least recently polled first. */
  due(now: Date, options: DueOptions): Promise<FastagTripRow[]>;
  /**
   * A poll finished. Stamps `last_polled_at`; an `error` is counted and kept, a good poll clears
   * both. `finish` ends a closing row (its last poll is done, or we gave up).
   */
  markPolled(
    id: string,
    now: Date,
    result: { error?: string; finish?: 'done' | 'gave_up' },
  ): Promise<void>;
}

const COLUMNS = `
  id, tenant_id AS "tenantId", load_id AS "loadId", vehicle_id AS "vehicleId",
  vehicle_number AS "vehicleNumber", state, window_start AS "windowStart",
  window_end AS "windowEnd", attempts`;

/** SQL for tracking.fastag_trips (see the FastagCrossings migration). */
export class FastagTripRepository implements FastagTripStore {
  constructor(private readonly dataSource: DataSource) {}

  liveRows(): Promise<FastagTripRow[]> {
    return this.dataSource.query(
      `SELECT ${COLUMNS} FROM tracking.fastag_trips WHERE state IN ('active', 'closing')`,
    );
  }

  async insert(input: NewFastagTrip): Promise<FastagTripRow | null> {
    const rows: FastagTripRow[] = await this.dataSource.query(
      `INSERT INTO tracking.fastag_trips
         (id, tenant_id, load_id, vehicle_id, vehicle_number, window_start)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (load_id) WHERE state = 'active' DO NOTHING
       RETURNING ${COLUMNS}`,
      [
        randomUUID(),
        input.tenantId,
        input.loadId,
        input.vehicleId,
        input.vehicleNumber,
        input.windowStart,
      ],
    );
    return rows[0] ?? null;
  }

  async markClosing(id: string, windowEnd: Date, reason: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE tracking.fastag_trips
       SET state = 'closing', window_end = $2, end_reason = $3, updated_at = now()
       WHERE id = $1 AND state = 'active'`,
      [id, windowEnd, reason],
    );
  }

  due(now: Date, options: DueOptions): Promise<FastagTripRow[]> {
    return this.dataSource.query(
      `SELECT ${COLUMNS} FROM tracking.fastag_trips
       WHERE (state = 'active'
              AND (last_polled_at IS NULL
                   OR last_polled_at <= $1::timestamptz - make_interval(secs => $2)))
          OR (state = 'closing'
              AND window_end + make_interval(secs => $3) <= $1
              -- A poll made before the final delay doesn't count; after a failed final poll, wait the interval.
              AND (last_polled_at IS NULL
                   OR last_polled_at < window_end + make_interval(secs => $3)
                   OR last_polled_at <= $1::timestamptz - make_interval(secs => $2)))
       ORDER BY last_polled_at NULLS FIRST
       LIMIT $4`,
      [now, options.intervalMs / 1000, options.finalDelayMs / 1000, options.limit],
    );
  }

  async markPolled(
    id: string,
    now: Date,
    result: { error?: string; finish?: 'done' | 'gave_up' },
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE tracking.fastag_trips
       SET last_polled_at = $2,
           attempts = CASE WHEN $3::text IS NULL THEN 0 ELSE attempts + 1 END,
           last_error = $3,
           state = CASE WHEN $4::text IS NOT NULL AND state = 'closing' THEN 'ended' ELSE state END,
           end_reason = CASE WHEN $4::text = 'gave_up' AND state = 'closing'
                             THEN COALESCE(end_reason, '') || ' (gave up)' ELSE end_reason END,
           updated_at = now()
       WHERE id = $1`,
      [id, now, result.error?.slice(0, 500) ?? null, result.finish ?? null],
    );
  }
}
