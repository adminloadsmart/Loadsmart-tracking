import type { AlertRow } from '../rules/rules.repository';

/** Public shape of an alert (REST, /live and the outbox payload consumers all see this). */
export function toAlertView(alert: AlertRow) {
  const iso = (value: Date | string | null) => (value ? new Date(value).toISOString() : null);
  return {
    alertId: alert.id,
    ruleId: alert.rule_id,
    triggerCode: alert.trigger_code,
    severity: alert.severity,
    audience: alert.audience,
    status: alert.status,
    title: alert.title,
    vehicleId: alert.vehicle_id,
    tripId: alert.trip_id,
    episodeId: alert.episode_id,
    occurredAt: iso(alert.occurred_at),
    openedAt: iso(alert.opened_at),
    acknowledgedAt: iso(alert.acknowledged_at),
    acknowledgedBy: alert.acknowledged_by,
    closedAt: iso(alert.closed_at),
    closeReason: alert.close_reason,
    repeatCount: alert.repeat_count,
    details: alert.payload,
  };
}

export type AlertView = ReturnType<typeof toAlertView>;
