import { EARTH_RADIUS_M, haversineMeters, LatLng } from '../processing/geo';
import type { MainGeofence } from '../main-data';

/** Inside a geofence: within the circle's radius, or inside the drawn polygon. */
export function containsPoint(geofence: MainGeofence, point: LatLng, defaultRadiusM = 0): boolean {
  if (geofence.shape === 'polygon') return isInsidePolygon(point, geofence.polygon ?? []);
  // A circle saved without a radius (null or 0) uses the default: a 0 m circle is never entered.
  return haversineMeters(point, geofence) <= (geofence.radiusM || defaultRadiusM);
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

interface Box {
  minLat: number;
  maxLat: number;
  minLng: number;
  maxLng: number;
}

// Per geofence object: the cached tenant list is reused across batches, so each box is built once.
const boxes = new WeakMap<MainGeofence, { defaultRadiusM: number; box: Box }>();
/** Slack on every box (degrees, ~10 m), so float rounding never cuts off a fix on the border. */
const SLACK_DEG = 0.0001;

function boxOf(geofence: MainGeofence, defaultRadiusM: number): Box {
  const cached = boxes.get(geofence);
  if (cached && cached.defaultRadiusM === defaultRadiusM) return cached.box;
  let box: Box;
  if (geofence.shape === 'polygon') {
    const polygon = geofence.polygon ?? [];
    box = {
      minLat: Math.min(...polygon.map((p) => p.lat)) - SLACK_DEG,
      maxLat: Math.max(...polygon.map((p) => p.lat)) + SLACK_DEG,
      minLng: Math.min(...polygon.map((p) => p.lng)) - SLACK_DEG,
      maxLng: Math.max(...polygon.map((p) => p.lng)) + SLACK_DEG,
    };
  } else {
    // A point within r metres is at most r / R radians away in latitude; in longitude the
    // allowance is widest at the box's edge nearest a pole, so use the cosine there.
    const radiusM = geofence.radiusM || defaultRadiusM;
    const dLat = (radiusM / EARTH_RADIUS_M) * (180 / Math.PI);
    const edgeLat = Math.min(89.9, Math.abs(geofence.lat) + dLat);
    const dLng = dLat / Math.cos((edgeLat * Math.PI) / 180);
    box = {
      minLat: geofence.lat - dLat - SLACK_DEG,
      maxLat: geofence.lat + dLat + SLACK_DEG,
      minLng: geofence.lng - dLng - SLACK_DEG,
      maxLng: geofence.lng + dLng + SLACK_DEG,
    };
  }
  boxes.set(geofence, { defaultRadiusM, box });
  return box;
}

/** False only when the point is certainly outside (outside the geofence's bounding box): the
 *  cheap test before containsPoint. True means "maybe" — containsPoint decides. */
export function mayContain(geofence: MainGeofence, point: LatLng, defaultRadiusM = 0): boolean {
  const box = boxOf(geofence, defaultRadiusM);
  return (
    point.lat >= box.minLat &&
    point.lat <= box.maxLat &&
    point.lng >= box.minLng &&
    point.lng <= box.maxLng
  );
}
