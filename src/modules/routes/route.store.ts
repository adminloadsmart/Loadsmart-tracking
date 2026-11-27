import { RoutesRepository } from './routes.repository';
import { TripRoutes } from './trip-routes';
import { LruMap } from '../../shared/utils/lru';

const TTL_MS = 60_000;

/**
 * In-memory cache of trips' routes in the processor, so snapping a fix to its route never costs
 * a database round trip. Entries refresh after a minute — an approved alternate route reaches
 * the rules within that.
 */
export class RouteStore {
  private readonly cache = new LruMap<string, { at: number; routes: TripRoutes | null }>(20_000);

  constructor(private readonly repository: RoutesRepository) {}

  async get(tripIds: string[], nowMs = Date.now()): Promise<Map<string, TripRoutes>> {
    const stale = tripIds.filter((id) => {
      const entry = this.cache.get(id);
      return !entry || nowMs - entry.at > TTL_MS;
    });
    if (stale.length > 0) {
      const rows = await this.repository.routesFor(stale);
      // Grouped once (filtering the rows per trip was O(trips × rows)).
      const byTrip = new Map<string, typeof rows>();
      for (const row of rows) {
        const list = byTrip.get(row.trip_id);
        if (list) list.push(row);
        else byTrip.set(row.trip_id, [row]);
      }
      for (const id of stale) {
        const tripRows = byTrip.get(id) ?? [];
        this.cache.set(id, {
          at: nowMs,
          routes: tripRows.length ? new TripRoutes(tripRows) : null,
        });
      }
    }
    const result = new Map<string, TripRoutes>();
    for (const id of tripIds) {
      const routes = this.cache.get(id)?.routes;
      if (routes) result.set(id, routes);
    }
    return result;
  }

  invalidate(tripId: string): void {
    this.cache.delete(tripId);
  }
}
