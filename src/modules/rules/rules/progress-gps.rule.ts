import { num } from '../rule-helpers';
import { FixRule } from '../rule.types';

export interface ProgressSample {
  t: number;
  alongM: number;
}

export interface ProgressState {
  tripId: string | null;
  routeVersion: number | null;
  /** Furthest point reached along the primary route — progress never moves backwards. */
  furthestAlongM: number;
  /** Progress when the current route version started (for "km covered" since then). */
  baselineAlongM: number;
  baselineMs: number | null;
  samples: ProgressSample[];
  lastFixMs: number | null;
}

const SAMPLE_EVERY_MS = 5 * 60_000;

/**
 * Input half of DELAY-GPS: as fixes arrive, snap them to the trip's primary route and keep the
 * furthest progress plus a sparse history (one sample per 5 min over the speed window). The
 * time-driven half (DelayMonitor, on the scheduler) turns this into ETA and delay alerts every
 * 15 min. Snapping to the furthest point reached means a jump backwards (GPS or SIM tower)
 * can never reduce progress; fixes far from the route (deviations) don't move it at all.
 * Raises no alerts itself.
 */
export const progressGpsRule: FixRule<ProgressState> = {
  id: 'DELAY-GPS',
  sources: ['driver_app', 'blackrock'],

  initial: () => ({
    tripId: null,
    routeVersion: null,
    furthestAlongM: 0,
    baselineAlongM: 0,
    baselineMs: null,
    samples: [],
    lastFixMs: null,
  }),

  onFix(state, fix, ctx) {
    const routes = ctx.route;
    if (!fix.inTransit || !fix.tripId || !routes) return state;

    const { alongM, distanceM } = routes.primary.geometry.project(fix);
    let s: ProgressState = state;
    if (s.tripId !== fix.tripId || s.routeVersion !== routes.primary.version) {
      // New trip, or ops approved a new route: progress restarts on it from here.
      s = {
        ...this.initial(),
        tripId: fix.tripId,
        routeVersion: routes.primary.version,
        furthestAlongM: alongM,
        baselineAlongM: alongM,
        baselineMs: fix.t,
      };
    } else {
      s = { ...s };
    }
    s.lastFixMs = Math.max(s.lastFixMs ?? 0, fix.t);
    if (distanceM <= num(ctx.params, 'maxSnapDistanceM')) {
      s.furthestAlongM = Math.max(s.furthestAlongM, alongM);
    }

    // A sample is the progress AT its own time and is never updated afterwards: a sample holding
    // newer progress than its timestamp would make the speed over the window read too slow.
    // Current progress (furthestAlongM) is the other end of the window.
    const lastSample = s.samples[s.samples.length - 1];
    if (!lastSample || fix.t - lastSample.t >= SAMPLE_EVERY_MS) {
      const windowMs = num(ctx.params, 'speedWindowH') * 3_600_000;
      s.samples = [...s.samples, { t: fix.t, alongM: s.furthestAlongM }].filter(
        (sample) => fix.t - sample.t <= windowMs + SAMPLE_EVERY_MS,
      );
    }
    return s;
  },
};
