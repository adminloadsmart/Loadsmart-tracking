import { haversineMeters, LatLng } from '../processing/geo';
import type { MainGeofence } from '../main-data';

/** Inside a geofence: within the circle's radius, or inside the drawn polygon. */
export function containsPoint(geofence: MainGeofence, point: LatLng): boolean {
  if (geofence.shape === 'polygon') return isInsidePolygon(point, geofence.polygon ?? []);
  return haversineMeters(point, geofence) <= (geofence.radiusM ?? 0);
}

/** Ray-casting point-in-polygon on lat/lng treated as planar — accurate for the site-sized
 *  shapes (a few km at most) a geofence is drawn at. Vertices are in drawing order. Same test the
 *  main backend used before the check moved here. */
export function isInsidePolygon(point: LatLng, polygon: LatLng[]): boolean {
  if (polygon.length < 3) return false;
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[i];
    const b = polygon[j];
    const crosses =
      a.lat > point.lat !== b.lat > point.lat &&
      point.lng < ((b.lng - a.lng) * (point.lat - a.lat)) / (b.lat - a.lat) + a.lng;
    if (crosses) inside = !inside;
  }
  return inside;
}
