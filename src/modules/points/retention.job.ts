import type { Logger } from 'pino';
import { DataSource } from 'typeorm';
import { returningRows } from '../../db/returning';
import { detectFeatures } from '../../db/db-features';

/** Same windows as the TimescaleDB retention policies (LocationPoints migration). */
const RETENTION: Array<{ table: string; days: number }> = [
  { table: 'location_points', days: 90 },
  { table: 'location_points_short', days: 7 },
];
const BATCH = 10_000;
const MAX_BATCHES_PER_RUN = 50;

/**
 * Raw-point retention on plain PostgreSQL. With TimescaleDB, retention is a chunk-drop policy and
 * this job does nothing. Without it, expired rows are deleted in bounded batches (short
 * transactions, no long locks) — run hourly by the scheduler leader.
 */
export class PointRetentionJob {
  constructor(
    private readonly dataSource: DataSource,
    private readonly logger: Logger,
  ) {}

  async run(): Promise<number> {
    if ((await detectFeatures(this.dataSource)).timescale) return 0;
    let total = 0;
    for (const { table, days } of RETENTION) {
      for (let batch = 0; batch < MAX_BATCHES_PER_RUN; batch += 1) {
        const deleted = returningRows(
          await this.dataSource.query(
            `DELETE FROM tracking.${table}
             WHERE ctid IN (
               SELECT ctid FROM tracking.${table}
               WHERE recorded_at < now() - make_interval(days => $1)
               LIMIT $2)
             RETURNING 1`,
            [days, BATCH],
          ),
        ).length;
        total += deleted;
        if (deleted < BATCH) break;
      }
    }
    if (total > 0) this.logger.info({ deleted: total }, 'Expired location points deleted');
    return total;
  }
}
