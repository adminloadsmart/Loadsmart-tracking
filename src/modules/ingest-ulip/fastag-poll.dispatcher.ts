import type { Logger } from 'pino';
import type { JobQueue } from '../../jobs/queue-registry';
import type { FastagPollJobData } from './fastag-poll.job';
import type { FastagTripStore } from './fastag-trip.repository';

export const FASTAG_POLL_QUEUE = 'poll-ulip';
export const FASTAG_POLL_JOB = 'pull';

export interface FastagPollDispatcherOptions {
  /** A running load is polled again after this long (ULIP_POLL_INTERVAL_MIN). */
  pollIntervalMs: number;
  /** A finished load gets its last poll this long after it ended (ULIP_FINAL_POLL_DELAY_MIN). */
  finalDelayMs: number;
  /** Most loads enqueued per tick. */
  batchSize?: number;
  /** Gap between the calls of one tick, so ULIP isn't hit all at once (its limits are unknown). */
  spacingMs?: number;
}

const DEFAULT_BATCH = 500;
const DEFAULT_SPACING_MS = 1_000;
const MAX_DELAY_MS = 55_000;

/**
 * Scheduler side of the FASTag pull, ticked every minute by the leader. Every load whose poll is
 * due (see FastagTripStore.due) gets one `poll-ulip` job. Job ids are fixed per row: BullMQ skips
 * an add while that job is still waiting or running, so a slow ULIP never builds a backlog. The
 * row's `last_polled_at` (set by the job) is what paces it.
 */
export class FastagPollDispatcher {
  constructor(
    private readonly store: Pick<FastagTripStore, 'due'>,
    private readonly queue: JobQueue,
    private readonly options: FastagPollDispatcherOptions,
    private readonly logger: Logger,
  ) {}

  /** Enqueues the polls due now; returns how many. */
  async dispatch(now = new Date()): Promise<number> {
    const {
      pollIntervalMs,
      finalDelayMs,
      batchSize = DEFAULT_BATCH,
      spacingMs = DEFAULT_SPACING_MS,
    } = this.options;
    const due = await this.store.due(now, {
      intervalMs: pollIntervalMs,
      finalDelayMs,
      limit: batchSize,
    });
    for (const [i, row] of due.entries()) {
      const data: FastagPollJobData = {
        rowId: row.id,
        tenantId: row.tenantId,
        loadId: row.loadId,
        vehicleId: row.vehicleId,
        vehicleNumber: row.vehicleNumber,
        windowStart: row.windowStart.toISOString(),
        windowEnd: row.state === 'closing' && row.windowEnd ? row.windowEnd.toISOString() : null,
        attempts: row.attempts,
      };
      await this.queue.enqueue(FASTAG_POLL_JOB, data, {
        jobId: `ulip-${row.id}`,
        delay: Math.min(i * spacingMs, MAX_DELAY_MS),
        // The next tick is the retry; a kept failed job would block its id.
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      });
    }
    if (due.length > 0) this.logger.debug({ trips: due.length }, 'FASTag polls enqueued');
    return due.length;
  }
}
