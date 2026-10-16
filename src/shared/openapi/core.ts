import { OpenAPIRegistry } from '@asteasolutions/zod-to-openapi';
import { z, ZodType } from 'zod';

/**
 * Shared OpenAPI infra, mirroring the main loadsmart backend's shared/openapi/core.ts: the
 * registry every module's `*.openapi.ts` registers against, the bearer-auth security scheme,
 * and the error envelope used by the whole API. See `docs.ts` for where this becomes the final
 * spec + Swagger UI.
 */

export const registry = new OpenAPIRegistry();

/** One tag per documented resource. */
export const TAGS = {
  VEHICLES: 'vehicles',
  TRIPS: 'trips',
  ALERTS: 'alerts',
  RULE_SETTINGS: 'rule-settings',
  ROUTES: 'routes',
} as const;

/**
 * The API has exactly one auth scheme: the main backend's staff access token, verified in
 * `shared/middleware/staff-auth.middleware.ts` and required by every `routers` mount.
 */
const bearerAuth = registry.registerComponent('securitySchemes', 'bearerAuth', {
  type: 'http',
  scheme: 'bearer',
  bearerFormat: 'JWT',
  description:
    'Staff access token issued by the main loadsmart backend (POST /v1/auth/login). Send as `Authorization: Bearer <token>`.',
});

export const authenticated = (description: string) => ({
  security: [{ [bearerAuth.name]: [] }],
  description,
});

/**
 * Like the main backend, only request shapes are documented (they come straight from the
 * `validate()` schemas, so they can't drift); success bodies get a description only — see
 * docs/contracts/tracking-api.md for their shapes.
 *
 *   error -> { error: { code, message, details? } }  (shared/middleware/error-handler.middleware.ts)
 */
export const ErrorResponseSchema = z
  .object({
    error: z.object({
      code: z.string(),
      message: z.string(),
      details: z.unknown().optional(),
    }),
  })
  .meta({ id: 'ErrorResponse' });

export const json = <T extends ZodType>(schema: T) => ({
  content: { 'application/json': { schema } },
});

export const errorContent = json(ErrorResponseSchema);

/** The 401/403 every staff-auth route can return. */
export const authErrors = {
  401: { description: 'Missing, invalid, expired or revoked token', ...errorContent },
  403: { description: 'Platform role without tracking access', ...errorContent },
};
