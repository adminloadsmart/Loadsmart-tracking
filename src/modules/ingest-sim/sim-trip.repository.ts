import { randomUUID } from 'crypto';
import { DataSource } from 'typeorm';
import type { SimConsentStatus } from './intugine.contract';

export type SimTripState =
  'awaiting_consent' | 'consented' | 'active' | 'paused' | 'ended' | 'unsupported' | 'failed';

export interface SimTripRow {
  id: string;
  tenantId: string;
  tripId: string;
  vehicleId: string;
  driverId: string | null;
  phone: string;
  operator: string | null;
  consentStatus: SimConsentStatus;
  consentSuggestion: string | null;
  consentRequestedAt: Date | null;
  consentLastCheckedAt: Date | null;
  consentExpiresAt: Date | null;
  state: SimTripState;
  intugineTripId: string | null;
  attempts: number;
  lastError: string | null;
  /** A start-trip call was made (so Intugine may hold a trip even if we never saw its id). */
  startAttempted: boolean;
}

export interface NewSimTrip {
  tenantId: string;
  tripId: string;
  vehicleId: string;
  driverId: string | null;
  phone: string;
}

/** What a consent answer (or failure) changes on a row. */
export interface ConsentUpdate {
  state: SimTripState;
  consentStatus?: SimConsentStatus;
  operator?: string | null;
  consentSuggestion?: string | null;
  /** Stamps consent_last_checked_at. */
  checkedAt: Date;
  /** Stamps consent_requested_at (first answer only; kept once set). */
  requestedAt?: Date;
  expiresAt?: Date;
  endReason?: string | null;
  /** Counts the failed call and records why; a successful call resets both. */
  error?: string | null;
}

/** What the consent flow needs from storage (a fake in tests). */
export interface SimTripStore {
  /** The trip's row unless it has finished (ended, unsupported or failed). */
  findLiveByTrip(tripId: string): Promise<SimTripRow | null>;
  /** Null if another process created the live row first. */
  insert(input: NewSimTrip): Promise<SimTripRow | null>;
  updateConsent(id: string, update: ConsentUpdate): Promise<void>;
  /** Rows waiting on consent that have not been checked for `intervalMs` (or never). */
  awaitingConsentDue(now: Date, intervalMs: number, limit: number): Promise<SimTripRow[]>;
  /** Every row that has not finished. */
  liveRows(): Promise<SimTripRow[]>;
  /** Running trips (started on Intugine) not polled for `intervalMs`, least recently polled first. */
  activeDue(now: Date, intervalMs: number, limit: number): Promise<SimTripRow[]>;
  /**
   * A poll finished. Stamps `last_polled_at`; `lastPointAt` (newest point published, if any) only
   * moves forward; `error` records a failed poll and is cleared by the next good one.
   */
  markPolled(id: string, now: Date, result: { lastPointAt?: Date; error?: string }): Promise<void>;
  /** Of these loads, the ones whose SIM row already ended as unsupported / failed (never ask again). */
  loadsWithFinishedConsent(loadIds: string[]): Promise<Set<string>>;
  /** Another trip already using this number on Intugine. */
  activeByPhone(phone: string, exceptTripId: string): Promise<SimTripRow | null>;
  /** Records the payload about to be sent, before the call, so a lost response can be traced. */
  markStarting(id: string, payload: unknown): Promise<void>;
  /** The trip is running on Intugine. */
  markStarted(row: SimTripRow, intugineTripId: string, now: Date): Promise<void>;
  /** A start attempt failed; the row stays and is retried. */
  recordError(id: string, message: string): Promise<void>;
  /** Finishes the row. */
  markEnded(
    row: SimTripRow,
    end: { state: 'ended' | 'unsupported' | 'failed'; reason: string; now: Date },
  ): Promise<void>;
}

const COLUMNS = `
  id, tenant_id AS "tenantId", load_id AS "tripId", vehicle_id AS "vehicleId",
  driver_id AS "driverId", phone, operator,
  operator_consent_status AS "consentStatus",
  operator_consent_suggestion AS "consentSuggestion",
  consent_requested_at AS "consentRequestedAt",
  consent_last_checked_at AS "consentLastCheckedAt",
  consent_expires_at AS "consentExpiresAt",
  state, intugine_trip_id AS "intugineTripId", attempts, last_error AS "lastError",
  (start_payload IS NOT NULL) AS "startAttempted"`;

const LIVE = `state IN ('awaiting_consent', 'consented', 'active', 'paused')`;

/** SQL for tracking.sim_trips (see the SimTrips migration). */
export class SimTripRepository implements SimTripStore {
  constructor(private readonly dataSource: DataSource) {}

  async findLiveByTrip(tripId: string): Promise<SimTripRow | null> {
    const rows: SimTripRow[] = await this.dataSource.query(
      `SELECT ${COLUMNS} FROM tracking.sim_trips
       WHERE load_id = $1 AND state NOT IN ('ended', 'unsupported', 'failed')`,
      [tripId],
    );
    return rows[0] ?? null;
  }

  async insert(input: NewSimTrip): Promise<SimTripRow | null> {
    const rows: SimTripRow[] = await this.dataSource.query(
      `INSERT INTO tracking.sim_trips (id, tenant_id, load_id, vehicle_id, driver_id, phone)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (load_id) WHERE state NOT IN ('ended', 'unsupported', 'failed') DO NOTHING
       RETURNING ${COLUMNS}`,
      [randomUUID(), input.tenantId, input.tripId, input.vehicleId, input.driverId, input.phone],
    );
    return rows[0] ?? null;
  }

  async updateConsent(id: string, update: ConsentUpdate): Promise<void> {
    await this.dataSource.query(
      `UPDATE tracking.sim_trips SET
         state = $2,
         operator_consent_status = COALESCE($3, operator_consent_status),
         operator = COALESCE($4, operator),
         operator_consent_suggestion = COALESCE($5, operator_consent_suggestion),
         consent_last_checked_at = $6,
         consent_requested_at = COALESCE(consent_requested_at, $7),
         consent_expires_at = COALESCE($8, consent_expires_at),
         end_reason = COALESCE($9, end_reason),
         ended_at = CASE WHEN $2 IN ('unsupported', 'failed') THEN $6 ELSE ended_at END,
         attempts = CASE WHEN $10::text IS NULL THEN 0 ELSE attempts + 1 END,
         last_error = $10,
         updated_at = now()
       WHERE id = $1`,
      [
        id,
        update.state,
        update.consentStatus ?? null,
        update.operator ?? null,
        update.consentSuggestion ?? null,
        update.checkedAt,
        update.requestedAt ?? null,
        update.expiresAt ?? null,
        update.endReason ?? null,
        update.error ?? null,
      ],
    );
  }

  async awaitingConsentDue(now: Date, intervalMs: number, limit: number): Promise<SimTripRow[]> {
    return this.dataSource.query(
      `SELECT ${COLUMNS} FROM tracking.sim_trips
       WHERE state = 'awaiting_consent'
         AND (consent_last_checked_at IS NULL
              OR consent_last_checked_at <= $1::timestamptz - make_interval(secs => $2))
       ORDER BY consent_last_checked_at NULLS FIRST
       LIMIT $3`,
      [now, intervalMs / 1000, limit],
    );
  }

  async liveRows(): Promise<SimTripRow[]> {
    return this.dataSource.query(`SELECT ${COLUMNS} FROM tracking.sim_trips WHERE ${LIVE}`);
  }

  async activeDue(now: Date, intervalMs: number, limit: number): Promise<SimTripRow[]> {
    return this.dataSource.query(
      `SELECT ${COLUMNS} FROM tracking.sim_trips
       WHERE state = 'active' AND intugine_trip_id IS NOT NULL
         AND (last_polled_at IS NULL
              OR last_polled_at <= $1::timestamptz - make_interval(secs => $2))
       ORDER BY last_polled_at NULLS FIRST
       LIMIT $3`,
      [now, intervalMs / 1000, limit],
    );
  }

  async markPolled(
    id: string,
    now: Date,
    result: { lastPointAt?: Date; error?: string },
  ): Promise<void> {
    await this.dataSource.query(
      `UPDATE tracking.sim_trips
       SET last_polled_at = $2,
           last_point_at = GREATEST(last_point_at, $3::timestamptz),
           last_error = $4,
           updated_at = now()
       WHERE id = $1`,
      [id, now, result.lastPointAt ?? null, result.error?.slice(0, 500) ?? null],
    );
  }

  async loadsWithFinishedConsent(loadIds: string[]): Promise<Set<string>> {
    if (loadIds.length === 0) return new Set();
    const rows: Array<{ load_id: string }> = await this.dataSource.query(
      `SELECT DISTINCT load_id FROM tracking.sim_trips
       WHERE load_id = ANY($1::uuid[]) AND state IN ('unsupported', 'failed')`,
      [loadIds],
    );
    return new Set(rows.map((r) => r.load_id));
  }

  async activeByPhone(phone: string, exceptTripId: string): Promise<SimTripRow | null> {
    const rows: SimTripRow[] = await this.dataSource.query(
      `SELECT ${COLUMNS} FROM tracking.sim_trips
       WHERE phone = $1 AND load_id <> $2 AND state = 'active' LIMIT 1`,
      [phone, exceptTripId],
    );
    return rows[0] ?? null;
  }

  async markStarting(id: string, payload: unknown): Promise<void> {
    await this.dataSource.query(
      `UPDATE tracking.sim_trips SET start_payload = $2, updated_at = now() WHERE id = $1`,
      [id, JSON.stringify(payload)],
    );
  }

  async markStarted(row: SimTripRow, intugineTripId: string, now: Date): Promise<void> {
    await this.dataSource.query(
      `UPDATE tracking.sim_trips
       SET state = 'active', intugine_trip_id = $2, started_at = $3,
           attempts = 0, last_error = NULL, updated_at = now()
       WHERE id = $1`,
      [row.id, intugineTripId, now],
    );
  }

  async recordError(id: string, message: string): Promise<void> {
    await this.dataSource.query(
      `UPDATE tracking.sim_trips
       SET attempts = attempts + 1, last_error = $2, updated_at = now() WHERE id = $1`,
      [id, message.slice(0, 500)],
    );
  }

  async markEnded(row: SimTripRow, end: Parameters<SimTripStore['markEnded']>[1]): Promise<void> {
    await this.dataSource.query(
      `UPDATE tracking.sim_trips
       SET state = $2, ended_at = $3, end_reason = $4, updated_at = now() WHERE id = $1`,
      [row.id, end.state, end.now, end.reason],
    );
  }
}
