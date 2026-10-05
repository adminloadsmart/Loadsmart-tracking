const EARTH_RADIUS_M = 6_371_008.8;

export interface LatLng {
  lat: number;
  lng: number;
}

const toRad = (deg: number) => (deg * Math.PI) / 180;

/** Great-circle distance in metres (haversine) — accurate to ~0.5% for road-trip distances. */
export function haversineMeters(a: LatLng, b: LatLng): number {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(h)));
}

/** km/h implied by moving `meters` in `ms`; null when the interval isn't positive. */
export function impliedSpeedKmh(meters: number, ms: number): number | null {
  if (ms <= 0) return null;
  return (meters / ms) * 3600;
}
