import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { API_VERSION_PREFIX } from '../../shared/constants/api';
import { authenticated, authErrors, errorContent, TAGS } from '../../shared/openapi/core';
import { SIM_CONSENT_RESEND_PERMISSION, simConsentParamsSchema } from './sim-consent.api';

const BASE = API_VERSION_PREFIX;

export function registerSimConsentOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'get',
    path: `${BASE}/trips/{tripId}/sim-consent`,
    tags: [TAGS.TRIPS],
    operationId: 'trips.simConsent',
    ...authenticated(
      'The SIM consent of the trip’s driver mobile number (consent is per number and reused across loads). `status` is one of: `valid` (a consent already on file covers this load; `validUntil` is its date), `link_sent` (the consent SMS went out and the driver has not answered), `given` (the driver answered this load’s SMS), `unavailable` (denied, withdrawn, expired, unsupported operator or timed out), `no_number`. Also `sentAt`, `givenAt`, `withdrawnAt`, `canResend` and, when it cannot be sent again, `resendBlockedReason`. A load not tracked by SIM returns `applicable: false`.',
    ),
    request: { params: simConsentParamsSchema.shape.params },
    responses: {
      200: {
        description:
          '{ tripId, applicable, status, phone (last 4 digits), operatorStatus, sentAt, givenAt, validUntil, withdrawnAt, canResend, resendBlockedReason }',
      },
      ...authErrors,
      404: { description: 'Trip not found or outside scope', ...errorContent },
    },
  });

  registry.registerPath({
    method: 'post',
    path: `${BASE}/trips/{tripId}/sim-consent/resend`,
    tags: [TAGS.TRIPS],
    operationId: 'trips.simConsentResend',
    ...authenticated(
      `Send the consent SMS to the driver again. Only possible while no valid consent is available (409 when one is on file, when the link was sent a moment ago, or when the operator cannot be tracked by SIM). Returns the updated consent status.\n\nRequires permission: ${SIM_CONSENT_RESEND_PERMISSION}.`,
    ),
    request: { params: simConsentParamsSchema.shape.params },
    responses: {
      200: { description: 'The trip’s SIM consent, as GET returns it' },
      ...authErrors,
      404: { description: 'Trip not found or outside scope', ...errorContent },
      409: {
        description: 'A valid consent exists, sent too recently, or not resendable',
        ...errorContent,
      },
      503: { description: 'SIM tracking is not configured on this service', ...errorContent },
    },
  });
}
