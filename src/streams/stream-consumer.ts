import type Redis from 'ioredis';
import type { Logger } from 'pino';
import {
  streamDeadLettered,
  streamLag,
  streamLength,
  streamPending,
  streamTrimmed,
} from '../shared/metrics';

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
  /** Most streams handled at once (each stream is still handled one batch at a time). */
  concurrency?: number;
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
  /** The one task (a read batch or a re-claim) running per stream: a stream's entries are handled
   *  in order, while other streams go on without waiting for it. */
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly taskStartedAt = new Map<string, number>();
  /** Resolves the loop's wait when a stream task finishes, so its stream is read again at once. */
  private wake: (() => void) | null = null;
  /** Streams whose gauges this consumer set, so a stream it stops reading drops its series. */
  private readonly sampled = new Set<string>();

  private readonly batchSize: number;
  private readonly blockMs: number;
  private readonly claimIdleMs: number;
  private readonly maxDeliveries: number;
  private readonly dlqMaxLen: number;
  private readonly concurrency: number;

  constructor(private readonly options: GroupConsumerOptions) {
    this.batchSize = options.batchSize ?? 500;
    this.blockMs = options.blockMs ?? 1000;
    this.claimIdleMs = options.claimIdleMs ?? 30_000;
    this.maxDeliveries = options.maxDeliveries ?? 5;
    this.dlqMaxLen = options.dlqMaxLen ?? 100_000;
    this.concurrency = Math.max(1, options.concurrency ?? 16);
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.loop = this.run();
  }

  async stop(): Promise<void> {
    this.running = false;
    // The in-flight XREADGROUP returns within blockMs; batches in flight finish and are acked.
    this.wake?.();
    await this.loop;
    await Promise.all(this.inFlight.values());
    this.loop = null;
  }

  /** For readiness: the loop is alive and has completed an iteration recently. */
  health(): { running: boolean; lastBatchAgoMs: number | null; oldestTaskAgoMs: number | null } {
    const now = Date.now();
    const oldest = Math.min(...this.taskStartedAt.values());
    return {
      running: this.running,
      lastBatchAgoMs: this.lastBatchAt ? now - this.lastBatchAt : null,
      // A stuck batch no longer stalls the loop (other streams go on), so it shows here instead.
      oldestTaskAgoMs: Number.isFinite(oldest) ? now - oldest : null,
    };
  }

  private async run(): Promise<void> {
    const { logger } = this.options;
    while (this.running) {
      try {
        const streams = this.options.streams();
        this.lastBatchAt = Date.now();
        if (streams.length === 0) {
          await this.idle(Math.min(this.blockMs, 500));
          continue;
        }
        await this.ensureGroups(streams);

        if (Date.now() - this.lastClaimAt >= Math.min(this.claimIdleMs, 5000)) {
          this.lastClaimAt = Date.now();
          await this.sampleStreams(streams);
          // Re-claims run as the stream's task, so they never overlap a batch of the same stream.
          for (const stream of this.free(streams)) {
            this.dispatch(stream, () => this.reclaimPending(stream));
          }
        }

        const free = this.free(streams);
        if (free.length === 0) {
          await this.idle(this.blockMs); // every stream busy, or the concurrency limit reached
          continue;
        }
        await this.readNew(free);
      } catch (err) {
        logger.error({ err, consumer: this.options.name }, 'Stream consumer iteration failed');
        await sleep(1000);
      }
    }
  }

  /** Streams with no task running, up to the concurrency limit. */
  private free(streams: string[]): string[] {
    const slots = this.concurrency - this.inFlight.size;
    if (slots <= 0) return [];
    return streams.filter((stream) => !this.inFlight.has(stream)).slice(0, slots);
  }

  /** Runs one task for a stream in the background; the loop moves on to the other streams. */
  private dispatch(stream: string, task: () => Promise<void>): void {
    const run = task()
      .catch((err: unknown) => {
        this.options.logger.error(
          { err, consumer: this.options.name, stream },
          'Stream task failed; its entries stay pending and are re-claimed',
        );
      })
      .finally(() => {
        this.inFlight.delete(stream);
        this.taskStartedAt.delete(stream);
        this.lastBatchAt = Date.now();
        this.wake?.();
      });
    this.inFlight.set(stream, run);
    this.taskStartedAt.set(stream, Date.now());
  }

  /** Waits up to `ms`, or until a stream task finishes or the consumer stops. */
  private async idle(ms: number): Promise<void> {
    await new Promise<void>((resolve) => {
      const timer = setTimeout(done, ms);
      function done() {
        clearTimeout(timer);
        resolve();
      }
      this.wake = done;
    });
    this.wake = null;
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
    // While other streams are busy, block only briefly: when one of them finishes it must be read
    // again soon, and this read can't be woken early.
    const blockMs = this.inFlight.size > 0 ? Math.min(this.blockMs, 100) : this.blockMs;
    const reply = (await blockingRedis.xreadgroup(
      'GROUP',
      group,
      consumer,
      'COUNT',
      this.batchSize,
      'BLOCK',
      blockMs,
      'STREAMS',
      ...streams,
      ...streams.map(() => '>'),
    )) as RawStreams | null;
    if (!reply) return;

    // Streams are independent (different vehicles): each batch runs as its stream's task, so a
    // slow partition holds up only itself. Order within a stream holds: a stream with a task
    // running is not read again until it finishes.
    for (const [stream, raw] of reply) {
      const entries = toEntries(raw);
      this.dispatch(stream, () => this.handleBatch(stream, entries));
    }
  }

  /** Backlog gauges: undelivered (lag), unacked (pending) and stored (length) per stream. */
  private async sampleStreams(streams: string[]): Promise<void> {
    const { redis, group } = this.options;
    try {
      const pipeline = redis.pipeline();
      for (const stream of streams) pipeline.xinfo('GROUPS', stream).xlen(stream);
      const replies = (await pipeline.exec()) ?? [];
      streams.forEach((stream, i) => {
        const [groupsErr, groups] = replies[i * 2] ?? [];
        const [lengthErr, length] = replies[i * 2 + 1] ?? [];
        if (!lengthErr) streamLength.set({ stream }, Number(length));
        const info = groupsErr ? undefined : groupInfo(groups, group);
        if (!info) return;
        streamPending.set({ stream, group }, info.pending);
        // Redis reports no lag when it can't tell (entries deleted mid-stream): leave the last value.
        if (info.lag !== null) streamLag.set({ stream, group }, info.lag);
      });
      for (const stream of this.sampled) {
        if (streams.includes(stream)) continue;
        streamLag.remove({ stream, group });
        streamPending.remove({ stream, group });
        streamLength.remove({ stream });
      }
      this.sampled.clear();
      for (const stream of streams) this.sampled.add(stream);
    } catch (err) {
      this.options.logger.warn(
        { err, consumer: this.options.name },
        'Stream metrics sample failed',
      );
    }
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
    if (vanished.length > 0) {
      await redis.xack(stream, group, ...vanished);
      // These were never processed: the consumers fell further behind than MAXLEN allows.
      streamTrimmed.inc({ stream, group }, vanished.length);
      this.options.logger.error(
        { consumer: this.options.name, stream, count: vanished.length },
        'Pending stream entries were trimmed by MAXLEN before processing; they are lost',
      );
    }

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
    streamDeadLettered.inc({ stream, group });
    this.options.logger.error(
      { consumer: this.options.name, stream, id, reason },
      'Stream entry moved to dead-letter stream',
    );
  }
}

/** One group's `pending` and `lag` from an XINFO GROUPS reply (flat field/value arrays). */
export function groupInfo(
  reply: unknown,
  group: string,
): { pending: number; lag: number | null } | undefined {
  if (!Array.isArray(reply)) return undefined;
  for (const flat of reply) {
    if (!Array.isArray(flat)) continue;
    const fields = new Map<string, unknown>();
    for (let i = 0; i + 1 < flat.length; i += 2) fields.set(String(flat[i]), flat[i + 1]);
    if (fields.get('name') !== group) continue;
    const lag = fields.get('lag');
    return {
      pending: Number(fields.get('pending') ?? 0),
      lag: lag === null || lag === undefined ? null : Number(lag),
    };
  }
  return undefined;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
