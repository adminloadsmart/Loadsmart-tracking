import { Counter } from 'prom-client';
import { metricsRegistry } from '../../shared/metrics';
import { BatchResult, StreamEntry } from '../../streams/stream-consumer';
import { ProcessedPoint, runPipeline } from '../processing/pipeline';
import { ProcessingOptions } from '../processing/steps';
import { LatestPosition, VehicleStateStore } from '../processing/vehicle-state.store';
import { NormalizedPoint, normalizedPointSchema, POINT_FIELD } from './point.contract';
import { PointRepository, PointTable } from './point.repository';

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
    const result = runPipeline(points, states, Date.now(), this.options);

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

    await this.stateStore.persist({
      states: result.states,
      latest: latestPositions(result.points),
      distance: result.distance,
      mockLocationTrips: result.mockLocationTrips,
    });

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
