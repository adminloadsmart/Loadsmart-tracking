import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { API_VERSION_PREFIX } from '../../shared/constants/api';
import { authenticated, authErrors, errorContent, json, TAGS } from '../../shared/openapi/core';
import { TRACKING_ROUTES_APPROVE } from './route-approval.service';
import { approveSchema } from './routes.validators';

const BASE = API_VERSION_PREFIX;

export function registerRoutesOpenApi(registry: OpenAPIRegistry): void {
  registry.registerPath({
    method: 'post',
    path: `${BASE}/trips/{tripId}/route/approve`,
    tags: [TAGS.ROUTES, TAGS.TRIPS],
    operationId: 'routes.approve',
    ...authenticated(
      `Approve a new planned route for a trip that already has one. Provide at least one of: \`polyline\` (a route you drew), \`replan: true\` (replan from the vehicle’s current position via Google), or \`promisedDeliveryAt\`.\n\nRequires permission: ${TRACKING_ROUTES_APPROVE}.`,
    ),
    request: {
      params: approveSchema.shape.params,
      body: json(approveSchema.shape.body),
    },
    responses: {
      201: { description: 'The newly approved route' },
      400: {
        description:
          'Validation failed, trip has no planned route, nothing to change, or replanning unavailable',
        ...errorContent,
      },
      ...authErrors,
      404: { description: 'Trip not found or outside scope', ...errorContent },
    },
  });
}
