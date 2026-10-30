import type { Logger } from 'pino';
import type { JobQueue } from '../../jobs/queue-registry';
import type { SimPollJobData } from './sim-poll.job';
import type { SimTripStore } from './sim-trip.repository';

export const SIM_POLL_QUEUE = 'poll-sim';
export const SIM_POLL_JOB = 'pull';

export interface SimPollDispatcherOptions {
  /** A running trip is polled again after this long (INTUGINE_POLL_INTERVAL_MIN). */
  pollIntervalMs: number;
  /** Most trips enqueued per tick. */
  batchSize?: number;
  /** Gap between the calls of one tick, so Intugine isn't hit all at once (its limits are unknown). */
  spacingMs?: number;
}

const DEFAULT_BATCH = 500;
const DEFAULT_SPACING_MS = 1_000;
const MAX_DELAY_MS = 55_000;

/**
 * Scheduler side of the SIM pull, ticked every minute by the leader. Each running Intugine trip
 * that has not been polled for `pollIntervalMs` gets one job. Job ids are fixed per trip: BullMQ
 * skips an add while a job with that id is still waiting or running, so a slow Intugine never
 * builds a backlog of stale polls. The row's `last_polled_at` (set by the job) is what paces it.
 */
export class SimPollDispatcher {
  constructor(
    private readonly store: Pick<SimTripStore, 'activeDue'>,
    private readonly queue: JobQueue,
    private readonly options: SimPollDispatcherOptions,
    private readonly logger: Logger,
  ) {}

  /** Enqueues the polls due now; returns how many. */
  async dispatch(now = new Date()): Promise<number> {
    const {
      pollIntervalMs,
      batchSize = DEFAULT_BATCH,
      spacingMs = DEFAULT_SPACING_MS,
    } = this.options;
    const due = await this.store.activeDue(now, pollIntervalMs, batchSize);
    for (const [i, row] of due.entries()) {
      const data: SimPollJobData = {
        rowId: row.id,
        intugineTripId: row.intugineTripId!,
        tenantId: row.tenantId,
        vehicleId: row.vehicleId,
        tripId: row.tripId,
        operator: row.operator,
      };
      await this.queue.enqueue(SIM_POLL_JOB, data, {
        jobId: `sim-${row.intugineTripId}`,
        delay: Math.min(i * spacingMs, MAX_DELAY_MS),
        // The next tick is the retry; a kept failed job would block its id.
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      });
    }
    if (due.length > 0) this.logger.debug({ trips: due.length }, 'SIM polls enqueued');
    return due.length;
  }
}
