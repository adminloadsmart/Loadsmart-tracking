import type { PointSource } from '../points';
import type { TripRoutes } from '../routes/trip-routes';

export const RULE_IDS = [
  'HALT-GPS',
  'OVER-GPS',
  'NIGHT-GPS',
  'INACT-GPS',
  'DELAY-GPS',
  'DEV-GPS',
  'IDLE-GPS',
  'TAMP-GPS',
  'PARK-GPS',
  'UNPLG-GPS',
  'RELAY-GPS',
  'HALT-SIM',
  'DELAY-SIM',
  'DEV-SIM',
  'NIGHT-SIM',
  'INACT-SIM',
  'CONSENT-SIM',
] as const;
export type RuleId = (typeof RULE_IDS)[number];

export type Severity = 'info' | 'warning' | 'medium' | 'high' | 'critical';
export const SEVERITY_RANK: Record<Severity, number> = {
  info: 0,
  warning: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

export type Audience = 'shipper' | 'trip_ops' | 'fleet_owner' | 'loadsmart_ops';

/** One accepted position as the rules see it (device time throughout). */
export interface RuleFix {
  t: number; // epoch ms, device time
  lat: number;
  lng: number;
  speedKmh: number | null;
  source: PointSource;
  tripId: string | null;
  /** The trip is in transit (rules scoped to "while the trip is in transit"). */
  inTransit: boolean;
  /** False for buffered/supplementary or >10 min old fixes: recorded, but raise no alert. */
  live: boolean;
  /** Ignition (ACC) when the source knows it — BR05 only. */
  ignition: boolean | null;
  accuracyM: number | null;
  satellites: number | null;
  gpsPositioned: boolean | null;
}

export interface Anchor {
  lat: number;
  lng: number;
}

export type EpisodeOp =
  | {
      op: 'open';
      id: string;
      ruleId: RuleId;
      source: PointSource;
      tripId: string | null;
      startedAt: number;
      anchor?: Anchor | null;
      metrics?: Record<string, unknown>;
      tags?: string[];
    }
  | { op: 'update'; id: string; metrics?: Record<string, unknown>; tags?: string[] }
  | {
      op: 'close';
      id: string;
      endedAt: number;
      anchor?: Anchor | null;
      metrics?: Record<string, unknown>;
      tags?: string[];
    }
  /** Clubbing / merging: a closed episode continues. */
  | { op: 'reopen'; id: string };

export type AlertOp =
  | {
      op: 'raise';
      id: string;
      ruleId: RuleId;
      triggerCode?: string;
      severity: Severity;
      audience: Audience[];
      title: string;
      tripId: string | null;
      episodeId?: string;
      dedupeKey: string;
      occurredAt: number;
      reminderEveryMin?: number;
      payload?: Record<string, unknown>;
    }
  | { op: 'escalate'; id: string; severity: Severity; payload?: Record<string, unknown> }
  | { op: 'update'; id: string; payload: Record<string, unknown> }
  | { op: 'close'; id: string; reason: string };

/** Side effects a rule asks for; applied by the engine (DB, outbox, live). */
export class Effects {
  readonly episodes: EpisodeOp[] = [];
  readonly alerts: AlertOp[] = [];

  episode(op: EpisodeOp): void {
    this.episodes.push(op);
  }
  alert(op: AlertOp): void {
    this.alerts.push(op);
  }
  get empty(): boolean {
    return this.episodes.length === 0 && this.alerts.length === 0;
  }
}

export interface RuleContext {
  tenantId: string;
  vehicleId: string;
  nowMs: number;
  /** Merged sheet defaults + tenant overrides for this rule. */
  params: Record<string, number | boolean | string>;
  vehicle: { bodyType: string | null };
  /** The fix's trip routes (planned + approved), for DEV/DELAY; null when not planned yet. */
  route: TripRoutes | null;
}

/**
 * A rule from the sheet: a pure state machine over a vehicle's fixes. The engine persists the
 * state between batches (per vehicle, in Redis) and applies the effects; a rule never does I/O,
 * so it is unit-testable with plain fixture sequences and deterministic under redelivery.
 */
export interface FixRule<S = unknown> {
  id: RuleId;
  sources: readonly PointSource[];
  initial(): S;
  onFix(state: S, fix: RuleFix, ctx: RuleContext, effects: Effects): S;
}
