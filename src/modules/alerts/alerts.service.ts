import type Redis from 'ioredis';
import type { StaffIdentity, TenantScope } from '../../shared/auth/staff-token';
import { hasPermission } from '../../shared/auth/staff-token';
import { AuthorizationError, NotFoundError, ValidationError } from '../../shared/errors';
import { LIVE_ALERTS_CHANNEL, mergeParams, RULE_DEFAULTS, RuleId } from '../rules';
import type { AlertRow, RulesRepository } from '../rules/rules.repository';
import type { AddressResolver } from '../geocoding';
import { toAlertView } from './alert-view';
import { AlertFilter, AlertsRepository, EpisodeRow } from './alerts.repository';

/** Permission (main backend permission key) needed to change a tenant's rule settings. */
export const TRACKING_SETTINGS_MANAGE = 'tracking.settings.manage';

const isCoord = (v: unknown): v is { lat: number; lng: number } =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as { lat?: unknown }).lat === 'number' &&
  typeof (v as { lng?: unknown }).lng === 'number';

/** Where an alert happened: its payload carries `anchor` (halts), `position` (overspeed, route
 *  deviation) or top-level lat/lng (deviation notice), depending on the rule. */
function alertLocation(payload: Record<string, unknown>) {
  const found = [payload.anchor, payload.position, payload].find(isCoord);
  return found ? { lat: found.lat, lng: found.lng } : null;
}

function episodeView(row: EpisodeRow, address: string | null = null) {
  return {
    episodeId: row.id,
    ruleId: row.rule_id,
    // INACT episodes are gaps in the data, shown as "No data" on timelines — never as halts.
    kind: row.tags.includes('no_data') ? 'no_data' : row.rule_id,
    source: row.source,
    status: row.status,
    vehicleId: row.vehicle_id,
    tripId: row.trip_id,
    startedAt: row.started_at.toISOString(),
    endedAt: row.ended_at?.toISOString() ?? null,
    durationS: Math.round(
      ((row.ended_at ?? new Date()).getTime() - row.started_at.getTime()) / 1000,
    ),
    anchor: row.anchor_lat === null ? null : { lat: row.anchor_lat, lng: row.anchor_lng },
    address,
    metrics: row.metrics,
    tags: row.tags,
  };
}

/**
 * Alerts and derived events for people (docs/contracts/tracking-api.md § Alerts): list, acknowledge
 * and close alerts; read the episodes behind trip/vehicle timelines; view and change a tenant's
 * rule settings (sheet defaults + overrides).
 */
export class AlertsService {
  constructor(
    private readonly repository: AlertsRepository,
    private readonly rules: RulesRepository,
    private readonly redis: Redis,
    private readonly addresses?: AddressResolver,
  ) {}

  /** The alert view plus the address of where it happened (its anchor), when it has one. */
  private async withAddresses(rows: AlertRow[]) {
    const addresses = await (this.addresses?.resolve(rows.map((r) => alertLocation(r.payload))) ??
      Promise.resolve(rows.map(() => null)));
    return rows.map((row, i) => ({ ...toAlertView(row), address: addresses[i] ?? null }));
  }

  async list(scope: TenantScope, filter: AlertFilter) {
    return { alerts: await this.withAddresses(await this.repository.list(scope, filter)) };
  }

  async acknowledge(scope: TenantScope, user: StaffIdentity, id: string) {
    await this.require(scope, id);
    const updated = await this.repository.acknowledge(id, user.userId);
    if (updated) await this.publish('alert.acknowledged', updated);
    return (await this.withAddresses([updated ?? (await this.require(scope, id))]))[0];
  }

  async close(scope: TenantScope, user: StaffIdentity, id: string, reason: string) {
    await this.require(scope, id);
    const closed = await this.repository.close(id, user.userId, reason);
    if (closed) await this.publish('alert.closed', closed);
    return (await this.withAddresses([closed ?? (await this.require(scope, id))]))[0];
  }

  /** Episode views plus the address of each one's anchor (where the halt / gap happened). */
  private async episodeViews(rows: EpisodeRow[]) {
    const addresses = await (this.addresses?.resolve(
      rows.map((r) =>
        r.anchor_lat === null || r.anchor_lng === null
          ? null
          : { lat: r.anchor_lat, lng: r.anchor_lng },
      ),
    ) ?? Promise.resolve(rows.map(() => null)));
    return rows.map((row, i) => episodeView(row, addresses[i] ?? null));
  }

  async tripEvents(scope: TenantScope, tripId: string) {
    return { events: await this.episodeViews(await this.repository.episodes(scope, { tripId })) };
  }

  async vehicleEvents(scope: TenantScope, vehicleId: string, from: Date, to: Date) {
    if (to <= from) throw new ValidationError('`to` must be after `from`');
    return {
      events: await this.episodeViews(await this.repository.episodes(scope, { vehicleId, from, to })),
    };
  }

  async settings(scope: TenantScope) {
    if ('allTenants' in scope) throw new ValidationError('Rule settings are per tenant');
    const overrides = new Map(
      (await this.rules.loadSettings(scope.tenantId)).map((r) => [r.rule_id, r]),
    );
    return {
      rules: Object.entries(RULE_DEFAULTS).map(([ruleId, defaults]) => {
        const override = overrides.get(ruleId as RuleId);
        return {
          ruleId,
          enabled: override?.enabled ?? defaults!.enabled,
          params: mergeParams(ruleId as RuleId, override?.params),
          defaults: { enabled: defaults!.enabled, params: defaults!.params },
          audience: defaults!.audience,
        };
      }),
    };
  }

  async updateSetting(
    scope: TenantScope,
    user: StaffIdentity,
    ruleId: RuleId,
    enabled: boolean | null,
    params: Record<string, unknown>,
  ) {
    if ('allTenants' in scope) throw new ValidationError('Rule settings are per tenant');
    if (!hasPermission(user, TRACKING_SETTINGS_MANAGE)) {
      throw new AuthorizationError(`Requires permission ${TRACKING_SETTINGS_MANAGE}`);
    }
    const defaults = RULE_DEFAULTS[ruleId];
    if (!defaults) throw new ValidationError(`Rule ${ruleId} has no configurable settings yet`);
    const unknown = Object.keys(params).filter((key) => !(key in defaults.params));
    const wrongType = Object.entries(params).filter(
      ([key, value]) => key in defaults.params && typeof value !== typeof defaults.params[key],
    );
    if (unknown.length || wrongType.length) {
      throw new ValidationError('Invalid rule params', {
        unknown,
        wrongType: wrongType.map(([key]) => key),
      });
    }
    await this.rules.upsertSetting(scope.tenantId, ruleId, enabled, params, user.userId);
    // Processors cache settings for up to a minute; the change applies within that.
    return (await this.settings(scope)).rules.find((rule) => rule.ruleId === ruleId);
  }

  private async require(scope: TenantScope, id: string) {
    const alert = await this.repository.find(scope, id);
    if (!alert) throw new NotFoundError(`Alert ${id} not found`);
    return alert;
  }

  private async publish(type: string, alert: Parameters<typeof toAlertView>[0]) {
    await this.redis
      .publish(LIVE_ALERTS_CHANNEL, JSON.stringify([{ type, alert }]))
      .catch(() => undefined);
  }
}
