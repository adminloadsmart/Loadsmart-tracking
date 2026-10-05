import type Redis from 'ioredis';
import type { Logger } from 'pino';

export interface StreamEntry {
  id: string;
  fields: Record<string, string>;
}

/**
 * What the handler decided per entry. Entries not listed are acked as done.
 *  - retry: leave pending; redelivered after `claimIdleMs`, dead-lettered after `maxDeliveries`
 *  - dead:  poison (unparseable/invalid) — straight to the dead-letter stream, never retried
 * Throwing from the handler retries the whole batch.
 */
export interface BatchResult {
  retry?: string[];
  dead?: Array<{ id: string; reason: string }>;
}

export type BatchHandler = (stream: string, entries: StreamEntry[]) => Promise<BatchResult | void>;

export interface GroupConsumerOptions {
  name: string;
  /** Non-blocking commands (XACK, XPENDING, XCLAIM, XADD to DLQ). */
  redis: Redis;
  /** Dedicated connection for XREADGROUP BLOCK — owned and closed by the caller. */
  blockingRedis: Redis;
  group: string;
  consumer: string;
  /** Streams to read; re-evaluated every loop so partition ownership can change at runtime. */
  streams: () => string[];
  handler: BatchHandler;
  logger: Logger;
  batchSize?: number;
  blockMs?: number;
  /** Pending entries idle this long (crashed consumer, failed batch) are re-claimed. */
  claimIdleMs?: number;
  maxDeliveries?: number;
  dlqMaxLen?: number;
}

type RawEntries = Array<[string, string[]]>;
type RawStreams = Array<[string, RawEntries]>;

function toEntries(raw: RawEntries): StreamEntry[] {
  return raw
    .filter(([, fields]) => Array.isArray(fields))
    .map(([id, flat]) => {
      const fields: Record<string, string> = {};
      for (let i = 0; i < flat.length; i += 2) fields[flat[i]] = flat[i + 1];
      return { id, fields };
    });
}

export function deadLetterKey(stream: string): string {
  return `${stream}:dlq`;
}

/**
 * Redis Streams consumer-group reader with at-least-once delivery:
 * XREADGROUP batches → handler → XACK; failed entries stay pending and are re-claimed after
 * `claimIdleMs` (also how a new partition owner picks up a dead owner's in-flight work); after
 * `maxDeliveries` attempts an entry moves to `<stream>:dlq` so one bad payload never jams a
 * partition. Handlers must be idempotent — a crash between handling and XACK redelivers.
 */
export class GroupConsumer {
  private running = false;
  private loop: Promise<void> | null = null;
  private readonly groupsReady = new Set<string>();
  private lastClaimAt = 0;
  private lastBatchAt = 0;

  private readonly batchSize: number;
  private readonly blockMs: number;
  private readonly claimIdleMs: number;
  private readonly maxDeliveries: number;
  private readonly dlqMaxLen: number;

  constructor(private readonly options: GroupConsumerOptions) {
    this.batchSize = options.batchSize ?? 500;
    this.blockMs = options.blockMs ?? 1000;
    this.claimIdleMs = options.claimIdleMs ?? 30_000;
    this.maxDeliveries = options.maxDeliveries ?? 5;
    this.dlqMaxLen = options.dlqMaxLen ?? 100_000;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    // The in-flight XREADGROUP returns within blockMs; the current batch finishes and is acked.
    await this.loop;
    this.loop = null;
  }

  /** For readiness: the loop is alive and has completed an iteration recently. */
  health(): { running: boolean; lastBatchAgoMs: number | null } {
    return {
      running: this.running,
      lastBatchAgoMs: this.lastBatchAt ? Date.now() - this.lastBatchAt : null,
    };
  }

  private async run(): Promise<void> {
    const { logger } = this.options;
    while (this.running) {
      try {
        const streams = this.options.streams();
        if (streams.length === 0) {
          this.lastBatchAt = Date.now();
          await sleep(Math.min(this.blockMs, 500));
          continue;
        }
        await this.ensureGroups(streams);

        if (Date.now() - this.lastClaimAt >= Math.min(this.claimIdleMs, 5000)) {
          this.lastClaimAt = Date.now();
          for (const stream of streams) await this.reclaimPending(stream);
        }

        await this.readNew(streams);
        this.lastBatchAt = Date.now();
      } catch (err) {
        logger.error({ err, consumer: this.options.name }, 'Stream consumer iteration failed');
        await sleep(1000);
      }
    }
  }

  private async ensureGroups(streams: string[]): Promise<void> {
    for (const stream of streams) {
      if (this.groupsReady.has(stream)) continue;
      try {
        await this.options.redis.xgroup('CREATE', stream, this.options.group, '0', 'MKSTREAM');
      } catch (err) {
        if (!(err instanceof Error) || !err.message.includes('BUSYGROUP')) throw err;
      }
      this.groupsReady.add(stream);
    }
  }

  private async readNew(streams: string[]): Promise<void> {
    const { blockingRedis, group, consumer } = this.options;
    const reply = (await blockingRedis.xreadgroup(
      'GROUP',
      group,
      consumer,
      'COUNT',
      this.batchSize,
      'BLOCK',
      this.blockMs,
      'STREAMS',
      ...streams,
      ...streams.map(() => '>'),
    )) as RawStreams | null;
    if (!reply) return;

    // Streams are independent (different vehicles) — handle them concurrently; order within a
    // stream is preserved because each stream's batch is handled sequentially.
    await Promise.all(reply.map(([stream, raw]) => this.handleBatch(stream, toEntries(raw))));
  }

  /** Re-delivers entries stuck pending (failed batches, crashed/rebalanced consumers). */
  private async reclaimPending(stream: string): Promise<void> {
    const { redis, group, consumer } = this.options;
    const pending = (await redis.xpending(
      stream,
      group,
      'IDLE',
      this.claimIdleMs,
      '-',
      '+',
      this.batchSize,
    )) as Array<[string, string, number, number]>;
    if (pending.length === 0) return;

    const exhausted = pending.filter(([, , , deliveries]) => deliveries >= this.maxDeliveries);
    for (const [id, , , deliveries] of exhausted) {
      const [entry] = toEntries((await redis.xrange(stream, id, id)) as RawEntries);
      await this.deadLetter(stream, id, entry?.fields ?? {}, `exceeded ${deliveries} deliveries`);
    }

    const retryIds = pending
      .filter(([, , , deliveries]) => deliveries < this.maxDeliveries)
      .map(([id]) => id);
    if (retryIds.length === 0) return;

    const claimed = toEntries(
      (await redis.xclaim(stream, group, consumer, this.claimIdleMs, ...retryIds)) as RawEntries,
    );
    // Entries trimmed away by MAXLEN can't be claimed but stay in the PEL forever — drop them.
    const claimedIds = new Set(claimed.map((entry) => entry.id));
    const vanished = retryIds.filter((id) => !claimedIds.has(id));
    if (vanished.length > 0) await redis.xack(stream, group, ...vanished);

    if (claimed.length > 0) {
      this.options.logger.warn(
        { consumer: this.options.name, stream, count: claimed.length },
        'Re-processing pending stream entries',
      );
      await this.handleBatch(stream, claimed);
    }
  }

  private async handleBatch(stream: string, entries: StreamEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const { redis, group, handler, logger } = this.options;

    let result: BatchResult | void;
    try {
      result = await handler(stream, entries);
    } catch (err) {
      // Nothing acked: the whole batch is redelivered after claimIdleMs.
      logger.error(
        { err, consumer: this.options.name, stream, count: entries.length },
        'Stream batch handler failed; will retry',
      );
      return;
    }

    const retry = new Set(result?.retry ?? []);
    const dead = new Map((result?.dead ?? []).map(({ id, reason }) => [id, reason]));
    const byId = new Map(entries.map((entry) => [entry.id, entry]));

    for (const [id, reason] of dead) {
      await this.deadLetter(stream, id, byId.get(id)?.fields ?? {}, reason);
    }
    const ackIds = entries.map((entry) => entry.id).filter((id) => !retry.has(id) && !dead.has(id));
    if (ackIds.length > 0) await redis.xack(stream, group, ...ackIds);
  }

  private async deadLetter(
    stream: string,
    id: string,
    fields: Record<string, string>,
    reason: string,
  ): Promise<void> {
    const { redis, group } = this.options;
    await redis.xadd(
      deadLetterKey(stream),
      'MAXLEN',
      '~',
      this.dlqMaxLen,
      '*',
      ...Object.entries(fields).flat(),
      '_origin_stream',
      stream,
      '_origin_id',
      id,
      '_reason',
      reason,
      '_dead_at',
      new Date().toISOString(),
    );
    await redis.xack(stream, group, id);
    this.options.logger.error(
      { consumer: this.options.name, stream, id, reason },
      'Stream entry moved to dead-letter stream',
    );
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
