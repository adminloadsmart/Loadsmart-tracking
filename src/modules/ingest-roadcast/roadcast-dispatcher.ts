import type { Logger } from 'pino';
import type { JobQueue } from '../../jobs/queue-registry';
import type { MainDataRepository } from '../main-data';
import type { ActiveTripIndex } from '../trips';
import type { RoadcastDevice, RoadcastPollJobData } from './roadcast-poll.job';

export const ROADCAST_QUEUE = 'poll-roadcast';
export const ROADCAST_JOB = 'pull';
/** Roadcast returns at most this many devices per call (`maxDeviceCap`). */
export const MAX_IMEIS_PER_CALL = 1000;

export interface RoadcastDispatcherOptions {
  /** How often dispatch() is ticked: the on-trip poll interval (10 s). */
  intervalMs: number;
  /** Every org's idle trucks are swept this often (5 min). */
  idleIntervalMs: number;
}

/**
 * Scheduler side of the Roadcast pull, ticked every intervalMs (10 s) by the leader. One call per
 * org per tick, carrying that org's IMEIs:
 *  - its trucks on a trip, read from the Redis on-trip device registry that the TripWatcher keeps
 *    as trips start and end — two Redis round trips, no SQL, nothing proportional to idle trucks;
 *  - on the org's sweep tick (one of the idle interval's 30 ticks, fixed per org), all of its
 *    IMEIs too, so idle trucks get a point every 5 min. Only that tick's orgs are read from main,
 *    so both the SQL and the calls are spread over the 5 min instead of bursting.
 * An org with nothing to fetch makes no call. On-trip polling never waits on Postgres: if the
 * sweep read fails, only that tick's sweep is skipped.
 *
 * Calls are spread across the tick. Each org's job ids are fixed: BullMQ skips an add while a job
 * with that id is still waiting or running, so a slow org never builds a backlog of stale polls.
 */
export class RoadcastDispatcher {
  private tick = 0;

  constructor(
    private readonly mainData: MainDataRepository,
    private readonly activeTrips: ActiveTripIndex,
    private readonly queue: JobQueue,
    private readonly options: RoadcastDispatcherOptions,
    private readonly logger: Logger,
  ) {}

  /** Enqueues this tick's calls; returns the number of jobs. */
  async dispatch(): Promise<number> {
    const slots = Math.max(1, Math.round(this.options.idleIntervalMs / this.options.intervalMs));
    const slot = this.tick++ % slots;

    const byOrg = new Map<string, Map<string, RoadcastDevice>>();
    const add = (device: RoadcastDevice) => {
      const devices = byOrg.get(device.tenantId) ?? new Map<string, RoadcastDevice>();
      devices.set(device.imei, device);
      byOrg.set(device.tenantId, devices);
    };
    for (const devices of (await this.activeTrips.onTripDevicesByTenant()).values()) {
      devices.forEach(add);
    }
    try {
      (await this.mainData.gpsDeviceBindings({ slot, slots })).forEach(add);
    } catch (err) {
      this.logger.warn({ err, slot }, 'Roadcast idle sweep skipped: device bindings unreadable');
    }

    const jobs: Array<{ jobId: string; devices: RoadcastDevice[] }> = [];
    for (const [tenantId, devices] of byOrg) {
      chunk([...devices.values()], MAX_IMEIS_PER_CALL).forEach((batch, n) =>
        jobs.push({ jobId: `roadcast-${tenantId}-${n}`, devices: batch }),
      );
    }

    const spacingMs = jobs.length > 0 ? Math.floor(this.options.intervalMs / jobs.length) : 0;
    for (const [i, { jobId, devices }] of jobs.entries()) {
      const data: RoadcastPollJobData = { devices };
      await this.queue.enqueue(ROADCAST_JOB, data, {
        jobId,
        delay: i * spacingMs,
        // The next tick is the retry; a kept failed job would block its id.
        attempts: 1,
        removeOnComplete: true,
        removeOnFail: true,
      });
    }
    return jobs.length;
  }
}

export function chunk<T>(items: T[], size: number): T[][] {
  const batches: T[][] = [];
  for (let i = 0; i < items.length; i += size) batches.push(items.slice(i, i + size));
  return batches;
}
