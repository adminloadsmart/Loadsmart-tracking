/** Nominal speed for routes with no provider duration (ops-drawn polylines): only the SHAPE of
 *  time along the route matters, because the pace factor is calibrated to km per day anyway. */
const NOMINAL_KMH = 50;

/** A cumulative time profile as stored: [metres along the route, seconds from its start] pairs. */
export type TimeProfile = Array<[number, number]>;

/**
 * Expected (car, no stops) travel time along a route, segment by segment — Google's own per-step
 * durations when the route was planned with them, else uniform over the route's duration. ETA
 * logic asks "how many seconds from here to the drop" and scales that by the truck's pace.
 */
export class RouteTime {
  private constructor(
    private readonly alongM: number[],
    private readonly elapsedS: number[],
  ) {}

  /**
   * From a provider profile (scaled to this geometry's length, since the provider's step metres
   * and our polyline length differ slightly), else uniform over durationS (or the nominal speed).
   */
  static of(lengthM: number, durationS: number | null, profile?: TimeProfile | null): RouteTime {
    const points = profile ? clean(profile) : null;
    if (points && lengthM > 0) {
      const scale = lengthM / points[points.length - 1][0];
      return new RouteTime(
        points.map(([m]) => m * scale),
        points.map(([, s]) => s),
      );
    }
    const totalS = durationS && durationS > 0 ? durationS : (lengthM / 1000 / NOMINAL_KMH) * 3600;
    return new RouteTime([0, Math.max(lengthM, 1)], [0, totalS]);
  }

  get totalS(): number {
    return this.elapsedS[this.elapsedS.length - 1];
  }

  /** Expected seconds from the route's start to `alongM` along it (clamped to the route). */
  at(alongM: number): number {
    const xs = this.alongM;
    if (alongM <= xs[0]) return this.elapsedS[0];
    if (alongM >= xs[xs.length - 1]) return this.totalS;
    let lo = 0;
    let hi = xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] <= alongM) lo = mid;
      else hi = mid;
    }
    const span = xs[hi] - xs[lo];
    const f = span > 0 ? (alongM - xs[lo]) / span : 0;
    return this.elapsedS[lo] + f * (this.elapsedS[hi] - this.elapsedS[lo]);
  }

  /** Expected seconds from `alongM` to the end of the route. */
  remainingFrom(alongM: number): number {
    return Math.max(0, this.totalS - this.at(alongM));
  }
}

/** A usable profile: starts at 0, both columns non-decreasing, positive totals; else null. */
function clean(profile: TimeProfile): TimeProfile | null {
  if (!Array.isArray(profile) || profile.length < 2) return null;
  const out: TimeProfile = [[0, 0]];
  for (const pair of profile) {
    if (!Array.isArray(pair) || pair.length !== 2) return null;
    const [m, s] = pair.map(Number);
    if (!Number.isFinite(m) || !Number.isFinite(s)) return null;
    const [pm, ps] = out[out.length - 1];
    if (m < pm || s < ps) return null;
    if (m > pm) out.push([m, s]);
  }
  const [lastM, lastS] = out[out.length - 1];
  return out.length >= 2 && lastM > 0 && lastS > 0 ? out : null;
}

/** Google Routes steps → cumulative profile; null when steps are missing or unusable. */
export function profileFromSteps(
  steps: Array<{ distanceMeters?: number; staticDuration?: string }>,
): TimeProfile | null {
  if (steps.length === 0) return null;
  const profile: TimeProfile = [[0, 0]];
  let m = 0;
  let s = 0;
  for (const step of steps) {
    const d = step.distanceMeters ?? 0;
    const t = step.staticDuration ? Number.parseFloat(step.staticDuration) : NaN;
    if (!Number.isFinite(t) || d < 0 || t < 0) return null;
    m += d;
    s += t;
    profile.push([m, Math.round(s)]);
  }
  return clean(profile);
}
