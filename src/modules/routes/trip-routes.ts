import type { LatLng } from '../processing/geo';
import { haversineMeters } from '../processing/geo';
import { RouteGeometry } from './route-geometry';
import type { TripRouteRow } from './routes.repository';

export interface RouteVersion {
  version: number;
  kind: 'planned' | 'approved_alternate';
  geometry: RouteGeometry;
  promisedAt: number | null;
  createdAt: number;
}

/**
 * All routes of one trip as the rules see them: the planned route plus any ops-approved
 * alternates. Everything on any of them is "on route" (DEV); progress and remaining distance are
 * measured on the PRIMARY route — the newest version (an approved alternate supersedes the plan).
 */
export class TripRoutes {
  readonly versions: RouteVersion[];

  constructor(rows: TripRouteRow[]) {
    if (rows.length === 0) throw new Error('TripRoutes needs at least one route');
    this.versions = [...rows]
      .sort((a, b) => a.version - b.version)
      .map((row) => ({
        version: row.version,
        kind: row.kind,
        geometry: RouteGeometry.fromPolyline(row.polyline),
        promisedAt: row.promised_at ? new Date(row.promised_at).getTime() : null,
        createdAt: new Date(row.created_at).getTime(),
      }));
  }

  get primary(): RouteVersion {
    return this.versions[this.versions.length - 1];
  }

  /** Shortest distance from the point to any of the trip's routes. */
  distanceToAnyM(p: LatLng): number {
    return Math.min(...this.versions.map((v) => v.geometry.project(p).distanceM));
  }

  /** Within `radiusM` of the trip's origin or drop (yards, parking, last mile). */
  nearEndsM(p: LatLng, radiusM: number): boolean {
    const plan = this.versions[0].geometry;
    const primary = this.primary.geometry;
    return (
      haversineMeters(p, plan.start) < radiusM ||
      haversineMeters(p, plan.end) < radiusM ||
      haversineMeters(p, primary.end) < radiusM
    );
  }
}
