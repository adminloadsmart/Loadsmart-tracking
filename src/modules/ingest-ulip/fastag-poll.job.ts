import { Counter, Histogram } from 'prom-client';
import { metricsRegistry } from '../../shared/metrics';
import type { CrossingStore } from './fastag-crossing.repository';
import type { FastagTripStore } from './fastag-trip.repository';
import { UlipError, type FastagProvider } from './ulip.client';
import { toCrossing, type Crossing } from './ulip.contract';

/** One load being followed, as the dispatcher hands it to the poller. */
export interface FastagPollJobData {
  /** fastag_trips row id. */
  rowId: string;
  tenantId: string;
  loadId: string;
  vehicleId: string;
  vehicleNumber: string;
  /** Crossings are kept from here (ISO)… */
  windowStart: string;
  /** …to here (ISO), once the load has ended; null while it is running. */
  windowEnd: string | null;
  /** Failed polls in a row so far (from the row). */
  attempts: number;
}

export interface FastagPollOptions {
  /** Failed polls after which a finished load stops being retried. */
  maxFinalAttempts?: number;
}

export interface FastagPollResult {
  /** Transactions ULIP returned. */
  received: number;
  /** Stored now (not seen before). */
  stored: number;
  /** Already stored on an earlier poll. */
  known: number;
  /** Outside the load's window (another trip of the same truck). */
  outsideWindow: number;
  /** Malformed rows that were dropped. */
  invalid: number;
}

const DEFAULT_MAX_FINAL_ATTEMPTS = 10;

const apiCalls = new Counter({
  name: 'tracking_ulip_api_calls_total',
  help: 'ULIP FASTag calls, by outcome',
  labelNames: ['outcome'] as const,
  registers: [metricsRegistry],
});
const apiSeconds = new Histogram({
  name: 'tracking_ulip_api_seconds',
  help: 'ULIP FASTag call latency',
  buckets: [0.1, 0.25, 0.5, 1, 2.5, 5, 10, 20],
  registers: [metricsRegistry],
});
const crossingsTotal = new Counter({
  name: 'tracking_fastag_crossings_total',
  help: 'Transactions returned by ULIP, by what happened to them',
  labelNames: ['result'] as const,
  registers: [metricsRegistry],
});

/**
 * One poll of one load: ask ULIP for the truck's transactions, keep the ones inside the load's
 * window, and store the ones not stored yet. ULIP returns the truck's whole recent history every
 * time, so the (load_id, seq_no) unique key is what prevents duplicates. A load that has ended
 * (`windowEnd` set) is finished by this poll; if it keeps failing it is given up on, since ULIP
 * only keeps about 72 h.
 */
export class FastagPollJob {
  constructor(
    private readonly provider: FastagProvider,
    private readonly trips: Pick<FastagTripStore, 'markPolled'>,
    private readonly crossings: CrossingStore,
    private readonly options: FastagPollOptions = {},
  ) {}

  async run(data: FastagPollJobData, nowMs = Date.now()): Promise<FastagPollResult> {
    const now = new Date(nowMs);
    const closing = data.windowEnd !== null;

    let raw: unknown[];
    try {
      raw = await this.pull(data.vehicleNumber);
    } catch (err) {
      // Still stamp the poll, so a failing load is retried at the normal interval, not every tick.
      await this.trips.markPolled(data.rowId, now, {
        error: err instanceof Error ? err.message : String(err),
        finish:
          closing &&
          data.attempts + 1 >= (this.options.maxFinalAttempts ?? DEFAULT_MAX_FINAL_ATTEMPTS)
            ? 'gave_up'
            : undefined,
      });
      throw err;
    }

    const result: FastagPollResult = {
      received: raw.length,
      stored: 0,
      known: 0,
      outsideWindow: 0,
      invalid: 0,
    };
    const start = Date.parse(data.windowStart);
    const end = data.windowEnd ? Date.parse(data.windowEnd) : Infinity;
    const inWindow: Crossing[] = [];
    for (const item of raw) {
      const crossing = toCrossing(item);
      if (!crossing) {
        result.invalid++;
      } else if (crossing.crossedAtMs < start || crossing.crossedAtMs > end) {
        result.outsideWindow++;
      } else {
        inWindow.push(crossing);
      }
    }
    // Same transaction twice in one answer: keep one.
    const unique = [...new Map(inWindow.map((c) => [c.seqNo, c])).values()].sort(
      (a, b) => a.crossedAtMs - b.crossedAtMs,
    );

    result.stored = await this.crossings.insertMany(
      {
        tenantId: data.tenantId,
        loadId: data.loadId,
        vehicleId: data.vehicleId,
        vehicleNumber: data.vehicleNumber,
      },
      unique,
    );
    result.known = unique.length - result.stored;

    await this.trips.markPolled(data.rowId, now, { finish: closing ? 'done' : undefined });
    for (const key of ['stored', 'known', 'outsideWindow', 'invalid'] as const) {
      if (result[key] > 0) crossingsTotal.inc({ result: key }, result[key]);
    }
    return result;
  }

  private async pull(vehicleNumber: string): Promise<unknown[]> {
    const end = apiSeconds.startTimer();
    try {
      const rows = await this.provider.fetchCrossings(vehicleNumber);
      apiCalls.inc({ outcome: 'ok' });
      return rows;
    } catch (err) {
      apiCalls.inc({
        outcome: err instanceof UlipError && err.rateLimited ? 'rate_limited' : 'error',
      });
      throw err;
    } finally {
      end();
    }
  }
}
