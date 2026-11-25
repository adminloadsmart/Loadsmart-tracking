import { returningRows } from '../../db/returning';
import { DataSource } from 'typeorm';
import type { TenantScope } from '../../shared/auth/staff-token';
import type { AlertRow } from '../rules/rules.repository';

export interface AlertFilter {
  status: Array<'open' | 'acknowledged' | 'closed'>;
  severity?: string[];
  tripId?: string;
  vehicleId?: string;
  ruleId?: string;
  limit: number;
  before?: Date;
}

export interface EpisodeRow {
  id: string;
  vehicle_id: string;
  trip_id: string | null;
  rule_id: string;
  source: string;
  status: 'open' | 'closed';
  started_at: Date;
  ended_at: Date | null;
  anchor_lat: number | null;
  anchor_lng: number | null;
  metrics: Record<string, unknown>;
  tags: string[];
}

/** Reads/writes alerts and episodes for the API, always within the caller's tenant scope. */
export class AlertsRepository {
  constructor(private readonly dataSource: DataSource) {}

  list(scope: TenantScope, filter: AlertFilter): Promise<AlertRow[]> {
    const params: unknown[] = [filter.status, filter.limit];
    const where = ['status = ANY($1::text[])'];
    const add = (sql: string, value: unknown) => {
      params.push(value);
      where.push(sql.replace('?', `$${params.length}`));
    };
    if (!('allTenants' in scope)) add('tenant_id = ?', scope.tenantId);
    if (filter.severity?.length) add('severity = ANY(?::text[])', filter.severity);
    if (filter.tripId) add('trip_id = ?', filter.tripId);
    if (filter.vehicleId) add('vehicle_id = ?', filter.vehicleId);
    if (filter.ruleId) add('rule_id = ?', filter.ruleId);
    if (filter.before) add('opened_at < ?', filter.before);
    return this.dataSource.query(
      `SELECT * FROM tracking.alerts WHERE ${where.join(' AND ')}
       ORDER BY opened_at DESC LIMIT $2`,
      params,
    );
  }

  async find(scope: TenantScope, id: string): Promise<AlertRow | null> {
    const rows = await this.dataSource.query(
      `SELECT * FROM tracking.alerts WHERE id = $1 ${'allTenants' in scope ? '' : 'AND tenant_id = $2'}`,
      'allTenants' in scope ? [id] : [id, scope.tenantId],
    );
    return rows[0] ?? null;
  }

  async acknowledge(id: string, userId: string): Promise<AlertRow | null> {
    const rows = returningRows<AlertRow>(
      await this.dataSource.query(
        `UPDATE tracking.alerts
         SET status = 'acknowledged', acknowledged_by = $2, acknowledged_at = now(), updated_at = now()
       WHERE id = $1 AND status = 'open'
       RETURNING *`,
        [id, userId],
      ),
    );
    return rows[0] ?? null;
  }

  /** Close by a person; writes the outbox event in the same transaction. */
  async close(id: string, userId: string, reason: string): Promise<AlertRow | null> {
    return this.dataSource.transaction(async (manager) => {
      const rows: AlertRow[] = returningRows(
        await manager.query(
          `UPDATE tracking.alerts
           SET status = 'closed', closed_at = now(), close_reason = $3,
               acknowledged_by = COALESCE(acknowledged_by, $2),
               acknowledged_at = COALESCE(acknowledged_at, now()), updated_at = now()
         WHERE id = $1 AND status <> 'closed'
         RETURNING *`,
          [id, userId, reason],
        ),
      );
      if (rows[0]) {
        await manager.query(
          `INSERT INTO tracking.alert_outbox (event_type, payload) VALUES ('alert.closed', $1)`,
          [JSON.stringify(rows[0])],
        );
      }
      return rows[0] ?? null;
    });
  }

  episodes(
    scope: TenantScope,
    by: { tripId: string } | { vehicleId: string; from: Date; to: Date },
  ): Promise<EpisodeRow[]> {
    const tenantFilter = 'allTenants' in scope ? '' : `AND tenant_id = $${'tripId' in by ? 2 : 4}`;
    const tenantParams = 'allTenants' in scope ? [] : [scope.tenantId];
    if ('tripId' in by) {
      return this.dataSource.query(
        `SELECT id, vehicle_id, trip_id, rule_id, source, status, started_at, ended_at,
                anchor_lat, anchor_lng, metrics, tags
         FROM tracking.episodes WHERE trip_id = $1 ${tenantFilter}
         ORDER BY started_at`,
        [by.tripId, ...tenantParams],
      );
    }
    return this.dataSource.query(
      `SELECT id, vehicle_id, trip_id, rule_id, source, status, started_at, ended_at,
              anchor_lat, anchor_lng, metrics, tags
       FROM tracking.episodes
       WHERE vehicle_id = $1 AND started_at < $3 AND (ended_at IS NULL OR ended_at >= $2) ${tenantFilter}
       ORDER BY started_at`,
      [by.vehicleId, by.from, by.to, ...tenantParams],
    );
  }

  /**
   * The FASTag toll crossings of a trip, shaped as (instant) episodes so the portal's timeline and
   * map show them next to halts and alerts. They stay in their own table (they are checkpoints, not
   * location points); this is only how the events endpoint reads them.
   */
  async tollEpisodes(scope: TenantScope, tripId: string): Promise<EpisodeRow[]> {
    const tenantFilter = 'allTenants' in scope ? '' : 'AND tenant_id = $2';
    const tenantParams = 'allTenants' in scope ? [] : [scope.tenantId];
    const rows: Array<{
      id: string;
      vehicle_id: string;
      load_id: string;
      crossed_at: Date;
      toll_plaza_name: string;
      toll_lat: number | null;
      toll_lng: number | null;
      lane_direction: string | null;
    }> = await this.dataSource.query(
      `SELECT id, vehicle_id, load_id, crossed_at, toll_plaza_name, toll_lat, toll_lng, lane_direction
       FROM tracking.fastag_crossings WHERE load_id = $1 ${tenantFilter}
       ORDER BY crossed_at`,
      [tripId, ...tenantParams],
    );
    return rows.map((r) => ({
      id: r.id,
      vehicle_id: r.vehicle_id,
      trip_id: r.load_id,
      rule_id: 'TOLL-FASTAG',
      source: 'fastag',
      status: 'closed',
      started_at: r.crossed_at,
      ended_at: r.crossed_at,
      anchor_lat: r.toll_lat,
      anchor_lng: r.toll_lng,
      metrics: { plaza: r.toll_plaza_name, laneDirection: r.lane_direction },
      tags: ['toll', 'fastag'],
    }));
  }
}
