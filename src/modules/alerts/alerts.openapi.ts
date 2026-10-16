import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { API_VERSION_PREFIX } from '../../shared/constants/api';
import { authenticated, authErrors, errorContent, json, TAGS } from '../../shared/openapi/core';
import { TRACKING_SETTINGS_MANAGE } from './alerts.service';
import {
  alertParamsSchema,
  closeAlertSchema,
  listAlertsSchema,
  tripEventsSchema,
  updateRuleSettingSchema,
  vehicleEventsSchema,
} from './alerts.validators';

const BASE = API_VERSION_PREFIX;

const ALERT_FIELDS =
  'alertId, ruleId, triggerCode, severity, audience, status, title, vehicleId, tripId, episodeId, occurredAt, openedAt, acknowledgedAt, acknowledgedBy, closedAt, closeReason, repeatCount, details';

export function registerAlertsOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: `${BASE}/alerts`,
    tags: [TAGS.ALERTS],
    operationId: 'alerts.list',
    ...authenticated(
      'Alerts in scope, newest first. `status` and `severity` take comma-separated lists; page with `before`.',
    ),
    request: { query: listAlertsSchema.shape.query },
    responses: {
      200: { description: `List of alerts: ${ALERT_FIELDS}` },
      400: { description: 'Validation failed', ...errorContent },
      ...authErrors,
    },
  });

  registry.registerPath({
    method: 'post',
    path: `${BASE}/alerts/{alertId}/acknowledge`,
    tags: [TAGS.ALERTS],
    operationId: 'alerts.acknowledge',
    ...authenticated('Acknowledge an alert as the caller.'),
    request: { params: alertParamsSchema.shape.params },
    responses: {
      200: { description: 'The updated alert' },
      400: { description: 'Validation failed', ...errorContent },
      ...authErrors,
      404: { description: 'Alert not found or outside scope', ...errorContent },
    },
  });

  registry.registerPath({
    method: 'post',
    path: `${BASE}/alerts/{alertId}/close`,
    tags: [TAGS.ALERTS],
    operationId: 'alerts.close',
    ...authenticated('Close an alert with a reason.'),
    request: {
      params: closeAlertSchema.shape.params,
      body: json(closeAlertSchema.shape.body),
    },
    responses: {
      200: { description: 'The updated alert' },
      400: { description: 'Validation failed', ...errorContent },
      ...authErrors,
      404: { description: 'Alert not found or outside scope', ...errorContent },
    },
  });

  registry.registerPath({
    method: 'get',
    path: `${BASE}/trips/{tripId}/events`,
    tags: [TAGS.ALERTS, TAGS.TRIPS],
    operationId: 'trips.events',
    ...authenticated('Rule events and alerts raised for a trip.'),
    request: { params: tripEventsSchema.shape.params },
    responses: {
      200: { description: 'Trip events' },
      400: { description: 'Validation failed', ...errorContent },
      ...authErrors,
      404: { description: 'Trip not found or outside scope', ...errorContent },
    },
  });

  registry.registerPath({
    method: 'get',
    path: `${BASE}/vehicles/{vehicleId}/events`,
    tags: [TAGS.ALERTS, TAGS.VEHICLES],
    operationId: 'vehicles.events',
    ...authenticated('Rule events and alerts raised for a vehicle over a time window.'),
    request: {
      params: vehicleEventsSchema.shape.params,
      query: vehicleEventsSchema.shape.query,
    },
    responses: {
      200: { description: 'Vehicle events' },
      400: { description: 'Validation failed or `to` <= `from`', ...errorContent },
      ...authErrors,
      404: { description: 'Vehicle not found or outside scope', ...errorContent },
    },
  });

  registry.registerPath({
    method: 'get',
    path: `${BASE}/rule-settings`,
    tags: [TAGS.RULE_SETTINGS],
    operationId: 'ruleSettings.list',
    ...authenticated(
      'The caller tenant’s effective settings for every rule (defaults merged with overrides). Not available to platform_admin (settings are per tenant).',
    ),
    responses: {
      200: { description: '{ rules: [{ ruleId, enabled, params, ... }] }' },
      400: { description: 'Caller has no single tenant', ...errorContent },
      ...authErrors,
    },
  });

  registry.registerPath({
    method: 'put',
    path: `${BASE}/rule-settings/{ruleId}`,
    tags: [TAGS.RULE_SETTINGS],
    operationId: 'ruleSettings.update',
    ...authenticated(
      `Override one rule for the caller’s tenant. \`enabled: null\` and \`params: {}\` fall back to defaults. Processors pick the change up within a minute.\n\nRequires permission: ${TRACKING_SETTINGS_MANAGE}.`,
    ),
    request: {
      params: updateRuleSettingSchema.shape.params,
      body: json(updateRuleSettingSchema.shape.body),
    },
    responses: {
      200: { description: 'The rule’s updated effective setting' },
      400: {
        description: 'Validation failed, rule has no settings, or invalid params',
        ...errorContent,
      },
      ...authErrors,
    },
  });
}
