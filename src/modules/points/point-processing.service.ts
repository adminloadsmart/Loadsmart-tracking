import { Counter } from 'prom-client';
import { metricsRegistry } from '../../shared/metrics';
import { BatchResult, StreamEntry } from '../../streams/stream-consumer';
import { NormalizedPoint, normalizedPointSchema, POINT_FIELD } from './point.contract';
import { PointRepository, PointTable } from './point.repository';

const pointsProcessed = new Counter({
  name: 'tracking_points_processed_total',
  help: 'Points taken off the point stream, by source and outcome',
  labelNames: ['source', 'outcome'] as const,
  registers: [metricsRegistry],
});

/**
 * Processor side of the point stream — one batch per partition read. Phase 1 pipeline:
 * decode → validate → route to its retention table → bulk insert. Phase 2 inserts the
 * cleaning / motion-state / distance steps between validate and insert (docs/ROADMAP.md §5,
 * Phase 2), and Phase 6 refines routing with the trip's active source.
 */
export class PointProcessingService {
  constructor(private readonly repository: PointRepository) {}

  async handleBatch(_stream: string, entries: StreamEntry[]): Promise<BatchResult> {
    const dead: BatchResult['dead'] = [];
    const byTable: Record<PointTable, NormalizedPoint[]> = {
      location_points: [],
      location_points_short: [],
    };

    for (const entry of entries) {
      const point = decode(entry);
      if ('reason' in point) {
        dead.push({ id: entry.id, reason: point.reason });
        pointsProcessed.inc({ source: 'unknown', outcome: 'invalid' });
        continue;
      }
      byTable[routeTable(point)].push(point);
    }

    // Any DB error throws → the whole batch is retried (inserts are idempotent).
    for (const [table, points] of Object.entries(byTable) as Array<
      [PointTable, NormalizedPoint[]]
    >) {
      if (points.length === 0) continue;
      await this.repository.insertMany(table, points);
      for (const point of points) pointsProcessed.inc({ source: point.source, outcome: 'stored' });
    }

    return { dead };
  }
}

/** Trip points live 90 days (the trip track); idle-vehicle points 7 days. */
export function routeTable(point: NormalizedPoint): PointTable {
  return point.tripId ? 'location_points' : 'location_points_short';
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
