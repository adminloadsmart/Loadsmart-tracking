import type { ChainableCommander } from 'ioredis';
import type { Logger } from 'pino';
import { Counter } from 'prom-client';
import { metricsRegistry } from '../../shared/metrics';
import { BatchResult, StreamEntry } from '../../streams/stream-consumer';
import { ProcessedPoint, runPipeline } from '../processing/pipeline';
import { ProcessingOptions } from '../processing/steps';
import { LatestPosition, VehicleStateStore } from '../processing/vehicle-state.store';
import { NormalizedPoint, normalizedPointSchema, POINT_FIELD } from './point.contract';
import { PointRepository, PointTable } from './point.repository';

/** Extension point run on every processed batch — implemented by the rules module. */
export interface BatchHook {
  run(
    points: ProcessedPoint[],
    nowMs: number,
  ): Promise<{
    writeState?: (multi: ChainableCommander) => void;
    afterCommit?: () => Promise<void>;
  }>;
}

/**
 * Several hooks as one (rules engine, geofence check), run in order: each one's state writes join
 * the same Redis transaction, and every after-commit step runs — one failing doesn't skip the rest.
 */
export function composeHooks(...hooks: BatchHook[]): BatchHook {
  return {
    async run(points, nowMs) {
      const results: Array<Awaited<ReturnType<BatchHook['run']>>> = [];
      for (const hook of hooks) results.push(await hook.run(points, nowMs));
      return {
        writeState: (multi) => {
          for (const result of results) result.writeState?.(multi);
        },
        afterCommit: async () => {
          const failures = (
            await Promise.allSettled(results.map((result) => result.afterCommit?.()))
          ).filter((r): r is PromiseRejectedResult => r.status === 'rejected');
          if (failures.length > 0) throw failures[0].reason;
        },
      };
    },
  };
}

const pointsProcessed = new Counter({
  name: 'tracking_points_processed_total',
  help: 'Points taken off the point stream, by source and outcome',
  labelNames: ['source', 'outcome'] as const,
  registers: [metricsRegistry],
});

/**
 * Processor side of the point stream — one batch per partition read:
 * decode/validate → pipeline (clean, movement, motion, distance; see modules/processing) →
 * bulk insert into the retention table → persist vehicle state, latest position and trip
 * distance in one Redis transaction.
 *
 * Retry safety: the insert is idempotent (unique key), and state is persisted only after it, so a
 * failed batch is redelivered and recomputed from the old state; once state is persisted, a
 * redelivery finds every point "late" and adds nothing.
 */
export class PointProcessingService {
  constructor(
    private readonly repository: PointRepository,
    private readonly stateStore: VehicleStateStore,
    private readonly options: ProcessingOptions,
    /** Notified with each batch's newest positions once they're persisted (live map fan-out). */
    private readonly onLatestPositions?: (positions: LatestPosition[]) => Promise<void>,
    private readonly logger?: Logger,
    /** Rule-sheet engine (modules/rules): runs after the insert, commits with the state. */
    private readonly batchHook?: BatchHook,
  ) {}

  async handleBatch(_stream: string, entries: StreamEntry[]): Promise<BatchResult> {
    const dead: BatchResult['dead'] = [];
    const points: NormalizedPoint[] = [];

    for (const entry of entries) {
      const point = decode(entry);
      if ('reason' in point) {
        dead.push({ id: entry.id, reason: point.reason });
        pointsProcessed.inc({ source: 'unknown', outcome: 'invalid' });
        continue;
      }
      points.push(point);
    }
    if (points.length === 0) return { dead };

    const states = await this.stateStore.load(points);
    const now = Date.now();
    const result = runPipeline(points, states, now, this.options);

    // Any DB error throws → the whole batch is retried (inserts are idempotent).
    const byTable: Record<PointTable, NormalizedPoint[]> = {
      location_points: [],
      location_points_short: [],
    };
    for (const processed of result.points) byTable[routeTable(processed)].push(processed.point);
    for (const [table, tablePoints] of Object.entries(byTable) as Array<
      [PointTable, NormalizedPoint[]]
    >) {
      if (tablePoints.length > 0) await this.repository.insertMany(table, tablePoints);
    }

    const latest = latestPositions(result.points);
    // Rules: effects go to Postgres (idempotent) BEFORE the Redis state moves on, and rule state
    // commits in the same MULTI as vehicle state — a crash anywhere recomputes the same effects.
    const hook = this.batchHook ? await this.batchHook.run(result.points, now) : null;
    await this.stateStore.persist({
      states: result.states,
      latest,
      distance: result.distance,
      mockLocationTrips: result.mockLocationTrips,
      extra: hook?.writeState,
    });
    if (hook?.afterCommit) {
      await hook
        .afterCommit()
        .catch((err) => this.logger?.warn({ err }, 'Rule after-commit failed'));
    }
    // Best effort: a missed live update is replaced by the next one (≤ 15 s later); it must never
    // fail — and so redeliver — a batch that is already stored.
    if (this.onLatestPositions && latest.size > 0) {
      await this.onLatestPositions([...latest.values()]).catch((err) =>
        this.logger?.warn({ err }, 'Failed to publish live positions'),
      );
    }

    for (const { point, rejected } of result.points) {
      pointsProcessed.inc({
        source: point.source,
        outcome: rejected ?? (point.flags?.late ? 'late' : 'stored'),
      });
    }
    return { dead };
  }
}

/**
 * Trip points live 90 days (the trip track); idle-vehicle points and rejected fixes 7 days
 * (rejected ones are kept only for auditing — they never appear on a track).
 */
export function routeTable({ point, rejected }: ProcessedPoint): PointTable {
  return point.tripId && !rejected ? 'location_points' : 'location_points_short';
}

/** Newest accepted, non-late point per vehicle in this batch. */
function latestPositions(points: ProcessedPoint[]): Map<string, LatestPosition> {
  const latest = new Map<string, LatestPosition>();
  for (const { point, rejected } of points) {
    if (rejected || point.flags?.late) continue;
    const current = latest.get(point.vehicleId);
    if (current && Date.parse(current.recordedAt) >= Date.parse(point.recordedAt)) continue;
    latest.set(point.vehicleId, {
      tenantId: point.tenantId,
      vehicleId: point.vehicleId,
      lat: point.lat,
      lng: point.lng,
      recordedAt: point.recordedAt,
      source: point.source,
      speedKmh: point.speedKmh ?? null,
      heading: point.heading ?? null,
      motion: String(point.flags?.motion ?? ''),
      tripId: point.tripId ?? null,
    });
  }
  return latest;
}

function decode(entry: StreamEntry): NormalizedPoint | { reason: string } {
  const raw = entry.fields[POINT_FIELD];
  if (!raw) return { reason: `missing "${POINT_FIELD}" field` };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { reason: 'payload is not valid JSON' };
  }
  const parsed = normalizedPointSchema.safeParse(json);
  if (!parsed.success) {
    return {
      reason: `invalid point: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`,
    };
  }
  return parsed.data;
}
