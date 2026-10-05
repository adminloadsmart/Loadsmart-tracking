import type Redis from 'ioredis';
import { DataSource } from 'typeorm';

/** Stream the main backend consumes for tracking → backend events (docs/ROADMAP.md §8.2). */
export const TRACKING_EVENTS_STREAM = 'tracking.events';
const BATCH = 500;
const STREAM_MAX_LEN = 100_000;

/**
 * Relays tracking.outbox (written in the same transaction as the alert change) to the
 * `tracking.events` stream on the main backend's Redis — the main backend's notifications module
 * turns alert events into push/SMS for the alert's audience. Claim (SKIP LOCKED) → XADD →
 * delete, in one transaction: a failed XADD leaves the rows for the next run; a crash after the
 * XADD republishes, and the consumer dedupes on the outbox id.
 */
export class OutboxRelay {
  constructor(
    private readonly dataSource: DataSource,
    private readonly mainRedis: Redis,
  ) {}

  async relay(): Promise<number> {
    return this.dataSource.transaction(async (manager) => {
      const rows: Array<{ id: string; event_type: string; payload: Record<string, unknown> }> =
        await manager.query(
          `SELECT id, event_type, payload FROM tracking.outbox ORDER BY id LIMIT $1 FOR UPDATE SKIP LOCKED`,
          [BATCH],
        );
      if (rows.length === 0) return 0;
      const pipeline = this.mainRedis.pipeline();
      for (const row of rows) {
        pipeline.xadd(
          TRACKING_EVENTS_STREAM,
          'MAXLEN',
          '~',
          STREAM_MAX_LEN,
          '*',
          'eventId',
          row.id,
          'type',
          row.event_type,
          'tenantId',
          String(row.payload.tenant_id ?? ''),
          'payload',
          JSON.stringify(row.payload),
        );
      }
      const results = await pipeline.exec();
      const failed = results?.find(([err]) => err);
      if (failed) throw failed[0];
      await manager.query(`DELETE FROM tracking.outbox WHERE id = ANY($1::bigint[])`, [
        rows.map((r) => r.id),
      ]);
      return rows.length;
    });
  }
}
