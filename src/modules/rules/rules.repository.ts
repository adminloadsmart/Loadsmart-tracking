import { returningRows } from '../../db/returning';
import { DataSource, EntityManager } from 'typeorm';
import { AlertOp, EpisodeOp, RuleId, SEVERITY_RANK, Severity } from './rule.types';

export interface VehicleEffects {
  tenantId: string;
  vehicleId: string;
  episodes: EpisodeOp[];
  alerts: AlertOp[];
}

/** An alert that changed in a way people should hear about (outbox + /live). */
export interface AlertChange {
  type: 'alert.opened' | 'alert.escalated' | 'alert.closed';
  alert: AlertRow;
}

export interface AlertRow {
  id: string;
  tenant_id: string;
  vehicle_id: string;
  trip_id: string | null;
  episode_id: string | null;
  rule_id: string;
  trigger_code: string | null;
  severity: Severity;
  audience: string[];
  status: 'open' | 'acknowledged' | 'closed';
  title: string;
  payload: Record<string, unknown>;
  repeat_count: number;
  opened_at: Date;
  occurred_at: Date;
  acknowledged_by: string | null;
  acknowledged_at: Date | null;
  closed_at: Date | null;
  close_reason: string | null;
}

export interface RuleSettingRow {
  rule_id: RuleId;
  enabled: boolean | null;
  params: Record<string, unknown>;
}

const ts = (ms: number) => new Date(ms);

/**
 * Persistence for the rules engine. applyEffects() writes a batch's episode and alert operations
 * in ONE transaction, together with the outbox rows announcing them — so the main backend is
 * notified exactly when (and only when) an alert really changed. Every write is idempotent
 * (deterministic ids, conditional updates), so a redelivered stream batch changes nothing.
 */
export class RulesRepository {
  constructor(private readonly dataSource: DataSource) {}

  async applyEffects(batch: VehicleEffects[]): Promise<AlertChange[]> {
    if (batch.every((v) => v.episodes.length === 0 && v.alerts.length === 0)) return [];
    return this.dataSource.transaction(async (manager) => {
      const changes: AlertChange[] = [];
      for (const vehicle of batch) {
        for (const op of vehicle.episodes) await this.applyEpisode(manager, vehicle, op);
        for (const op of vehicle.alerts) {
          const change = await this.applyAlert(manager, vehicle, op);
          if (change) changes.push(change);
        }
      }
      for (const change of changes) {
        await manager.query(
          `INSERT INTO tracking.alert_outbox (event_type, payload) VALUES ($1, $2)`,
          [change.type, JSON.stringify(change.alert)],
        );
      }
      return changes;
    });
  }

  private async applyEpisode(
    manager: EntityManager,
    v: VehicleEffects,
    op: EpisodeOp,
  ): Promise<void> {
    switch (op.op) {
      case 'open':
        await manager.query(
          `INSERT INTO tracking.episodes
             (id, tenant_id, vehicle_id, trip_id, rule_id, source, status, started_at,
              anchor_lat, anchor_lng, metrics, tags)
           VALUES ($1, $2, $3, $4, $5, $6, 'open', $7, $8, $9, $10, $11)
           ON CONFLICT (id) DO NOTHING`,
          [
            op.id,
            v.tenantId,
            v.vehicleId,
            op.tripId,
            op.ruleId,
            op.source,
            ts(op.startedAt),
            op.anchor?.lat ?? null,
            op.anchor?.lng ?? null,
            JSON.stringify(op.metrics ?? {}),
            op.tags ?? [],
          ],
        );
        return;
      case 'update':
        await manager.query(
          `UPDATE tracking.episodes
             SET metrics = metrics || $2::jsonb, tags = COALESCE($3, tags), updated_at = now()
           WHERE id = $1`,
          [op.id, JSON.stringify(op.metrics ?? {}), op.tags ?? null],
        );
        return;
      case 'close':
        await manager.query(
          `UPDATE tracking.episodes
             SET status = 'closed', ended_at = $2,
                 anchor_lat = COALESCE($3, anchor_lat), anchor_lng = COALESCE($4, anchor_lng),
                 metrics = metrics || $5::jsonb, tags = COALESCE($6, tags), updated_at = now()
           WHERE id = $1`,
          [
            op.id,
            ts(op.endedAt),
            op.anchor?.lat ?? null,
            op.anchor?.lng ?? null,
            JSON.stringify(op.metrics ?? {}),
            op.tags ?? null,
          ],
        );
        return;
      case 'reopen':
        await manager.query(
          `UPDATE tracking.episodes SET status = 'open', ended_at = NULL, updated_at = now() WHERE id = $1`,
          [op.id],
        );
        return;
    }
  }

  private async applyAlert(
    manager: EntityManager,
    v: VehicleEffects,
    op: AlertOp,
  ): Promise<AlertChange | null> {
    switch (op.op) {
      case 'raise': {
        // Replay of an alert we already have (open or closed): nothing to do.
        const existing = await manager.query(`SELECT 1 FROM tracking.alerts WHERE id = $1`, [
          op.id,
        ]);
        if (existing.length > 0) return null;
        // A different alert with the same dedupe key is still open: merge into it as a repeat.
        const rows: Array<AlertRow & { inserted: boolean }> = returningRows(
          await manager.query(
            `INSERT INTO tracking.alerts
             (id, tenant_id, vehicle_id, trip_id, episode_id, rule_id, trigger_code, severity,
              audience, title, payload, dedupe_key, opened_at, occurred_at, reminder_every_min)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, now(), $13, $14)
           ON CONFLICT (dedupe_key) WHERE status <> 'closed' DO UPDATE
             SET repeat_count = tracking.alerts.repeat_count + 1,
                 payload = tracking.alerts.payload || jsonb_build_object('lastRepeatAt', $13::timestamptz),
                 updated_at = now()
           RETURNING *, (xmax = 0) AS inserted`,
            [
              op.id,
              v.tenantId,
              v.vehicleId,
              op.tripId,
              op.episodeId ?? null,
              op.ruleId,
              op.triggerCode ?? null,
              op.severity,
              op.audience,
              op.title,
              JSON.stringify(op.payload ?? {}),
              op.dedupeKey,
              ts(op.occurredAt),
              op.reminderEveryMin ?? 0,
            ],
          ),
        );
        const { inserted, ...alert } = rows[0];
        return inserted ? { type: 'alert.opened', alert } : null;
      }
      case 'escalate': {
        const rows: AlertRow[] = returningRows(
          await manager.query(
            `UPDATE tracking.alerts
             SET severity = $2, payload = payload || $3::jsonb, updated_at = now()
           WHERE id = $1 AND status <> 'closed'
             AND (CASE severity WHEN 'info' THEN 0 WHEN 'warning' THEN 1 WHEN 'medium' THEN 2
                                WHEN 'high' THEN 3 ELSE 4 END) < $4
           RETURNING *`,
            [op.id, op.severity, JSON.stringify(op.payload ?? {}), SEVERITY_RANK[op.severity]],
          ),
        );
        return rows[0] ? { type: 'alert.escalated', alert: rows[0] } : null;
      }
      case 'update':
        await manager.query(
          `UPDATE tracking.alerts SET payload = payload || $2::jsonb, updated_at = now() WHERE id = $1`,
          [op.id, JSON.stringify(op.payload)],
        );
        return null;
      case 'close': {
        const rows: AlertRow[] = returningRows(
          await manager.query(
            `UPDATE tracking.alerts
             SET status = 'closed', closed_at = now(), close_reason = $2, updated_at = now()
           WHERE id = $1 AND status <> 'closed'
           RETURNING *`,
            [op.id, op.reason],
          ),
        );
        return rows[0] ? { type: 'alert.closed', alert: rows[0] } : null;
      }
    }
  }

  loadSettings(tenantId: string): Promise<RuleSettingRow[]> {
    return this.dataSource.query(
      `SELECT rule_id, enabled, params FROM tracking.rule_settings WHERE tenant_id = $1`,
      [tenantId],
    );
  }

  async upsertSetting(
    tenantId: string,
    ruleId: RuleId,
    enabled: boolean | null,
    params: Record<string, unknown>,
    userId: string,
  ): Promise<void> {
    await this.dataSource.query(
      `INSERT INTO tracking.rule_settings (tenant_id, rule_id, enabled, params, updated_by)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (tenant_id, rule_id) DO UPDATE
         SET enabled = EXCLUDED.enabled, params = EXCLUDED.params,
             updated_by = EXCLUDED.updated_by, updated_at = now()`,
      [tenantId, ruleId, enabled, JSON.stringify(params), userId],
    );
  }

  async loadVehicleProfiles(
    vehicleIds: string[],
  ): Promise<Map<string, { bodyType: string | null }>> {
    if (vehicleIds.length === 0) return new Map();
    const rows: Array<{ id: string; body_type: string | null }> = await this.dataSource.query(
      `SELECT id, body_type FROM tracking.vehicles WHERE id = ANY($1::uuid[])`,
      [vehicleIds],
    );
    return new Map(rows.map((row) => [row.id, { bodyType: row.body_type }]));
  }
}
