import type { LatLng } from '../processing/geo';

const EARTH_RADIUS_M = 6_371_008.8;
const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Google encoded polyline (precision 5) → points. */
export function decodePolyline(encoded: string): LatLng[] {
  const points: LatLng[] = [];
  let index = 0;
  let lat = 0;
  let lng = 0;
  while (index < encoded.length) {
    for (let axis = 0; axis < 2; axis += 1) {
      let shift = 0;
      let result = 0;
      let byte: number;
      do {
        byte = encoded.charCodeAt(index++) - 63;
        result |= (byte & 0x1f) << shift;
        shift += 5;
      } while (byte >= 0x20);
      const delta = result & 1 ? ~(result >> 1) : result >> 1;
      if (axis === 0) lat += delta;
      else lng += delta;
    }
    points.push({ lat: lat / 1e5, lng: lng / 1e5 });
  }
  return points;
}

/** Points → Google encoded polyline (precision 5). */
export function encodePolyline(points: LatLng[]): string {
  let out = '';
  let prevLat = 0;
  let prevLng = 0;
  const encode = (value: number) => {
    let v = value < 0 ? ~(value << 1) : value << 1;
    while (v >= 0x20) {
      out += String.fromCharCode((0x20 | (v & 0x1f)) + 63);
      v >>= 5;
    }
    out += String.fromCharCode(v + 63);
  };
  for (const p of points) {
    const lat = Math.round(p.lat * 1e5);
    const lng = Math.round(p.lng * 1e5);
    encode(lat - prevLat);
    encode(lng - prevLng);
    prevLat = lat;
    prevLng = lng;
  }
  return out;
}

export interface Projection {
  /** Shortest distance from the point to the route, metres. */
  distanceM: number;
  /** Distance along the route to the closest point, metres from the start. */
  alongM: number;
}

/**
 * A route as a polyline with cumulative lengths, for snapping fixes to it. Each segment is
 * projected in a local equirectangular frame — accurate to well under a metre at segment scale,
 * and cheap enough to run per fix in the processor (no database round trip).
 */
export class RouteGeometry {
  readonly points: LatLng[];
  readonly cumulativeM: number[];
  readonly lengthM: number;

  constructor(points: LatLng[]) {
    if (points.length < 2) throw new Error('A route needs at least 2 points');
    this.points = points;
    this.cumulativeM = [0];
    for (let i = 1; i < points.length; i += 1) {
      this.cumulativeM.push(this.cumulativeM[i - 1] + segmentLength(points[i - 1], points[i]));
    }
    this.lengthM = this.cumulativeM[this.cumulativeM.length - 1];
  }

  static fromPolyline(encoded: string): RouteGeometry {
    return new RouteGeometry(decodePolyline(encoded));
  }

  project(p: LatLng): Projection {
    let best: Projection = { distanceM: Infinity, alongM: 0 };
    for (let i = 1; i < this.points.length; i += 1) {
      const a = this.points[i - 1];
      const b = this.points[i];
      // Local frame centred on a: x east, y north, metres.
      const cosLat = Math.cos(toRad((a.lat + b.lat) / 2));
      const bx = toRad(b.lng - a.lng) * cosLat * EARTH_RADIUS_M;
      const by = toRad(b.lat - a.lat) * EARTH_RADIUS_M;
      const px = toRad(p.lng - a.lng) * cosLat * EARTH_RADIUS_M;
      const py = toRad(p.lat - a.lat) * EARTH_RADIUS_M;
      const len2 = bx * bx + by * by;
      const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, (px * bx + py * by) / len2));
      const dx = px - t * bx;
      const dy = py - t * by;
      const distanceM = Math.sqrt(dx * dx + dy * dy);
      if (distanceM < best.distanceM) {
        best = {
          distanceM,
          alongM: this.cumulativeM[i - 1] + t * (this.cumulativeM[i] - this.cumulativeM[i - 1]),
        };
      }
    }
    return best;
  }

  get start(): LatLng {
    return this.points[0];
  }
  get end(): LatLng {
    return this.points[this.points.length - 1];
  }
}

function segmentLength(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/**
 * Douglas-Peucker simplification with the tolerance in degrees — the same algorithm and units
 * as PostGIS ST_Simplify on SRID 4326, done in-process so tracks need no PostGIS. Iterative (no
 * recursion depth limit on multi-day tracks). Endpoints are always kept.
 */
export function simplifyPolyline(points: LatLng[], toleranceDeg: number): LatLng[] {
  if (points.length <= 2 || toleranceDeg <= 0) return points;
  const keep = new Uint8Array(points.length);
  keep[0] = 1;
  keep[points.length - 1] = 1;
  const stack: Array<[number, number]> = [[0, points.length - 1]];
  while (stack.length > 0) {
    const [first, last] = stack.pop()!;
    const a = points[first];
    const b = points[last];
    const dx = b.lng - a.lng;
    const dy = b.lat - a.lat;
    const len2 = dx * dx + dy * dy;
    let maxDistance = 0;
    let index = -1;
    for (let i = first + 1; i < last; i += 1) {
      const p = points[i];
      const t =
        len2 === 0
          ? 0
          : Math.max(0, Math.min(1, ((p.lng - a.lng) * dx + (p.lat - a.lat) * dy) / len2));
      const ex = p.lng - (a.lng + t * dx);
      const ey = p.lat - (a.lat + t * dy);
      const distance = Math.sqrt(ex * ex + ey * ey);
      if (distance > maxDistance) {
        maxDistance = distance;
        index = i;
      }
    }
    if (index !== -1 && maxDistance > toleranceDeg) {
      keep[index] = 1;
      stack.push([first, index], [index, last]);
    }
  }
  return points.filter((_, i) => keep[i] === 1);
}
