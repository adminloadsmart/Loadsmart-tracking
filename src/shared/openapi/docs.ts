import { OpenApiGeneratorV31 } from '@asteasolutions/zod-to-openapi';
import { Router } from 'express';
import swaggerUi from 'swagger-ui-express';
import { registerAlertsOpenApi } from '../../modules/alerts/alerts.openapi';
import { registerRoutesOpenApi } from '../../modules/routes/routes.openapi';
import { registerTrackingApiOpenApi } from '../../modules/tracking-api/tracking-api.openapi';
import { registry, TAGS } from './core';

/**
 * Builds the OpenAPI document (once, cached) and serves it as Swagger UI. Mounted only outside
 * production — see app.ts.
 */

// Bump manually alongside meaningful API surface changes.
const API_VERSION = '0.1.0';

let cached: ReturnType<OpenApiGeneratorV31['generateDocument']> | undefined;

/**
 * Explicit calls (not side-effect imports) so a module that's forgotten here is a visible
 * missing line. Future module: add its `register<Name>OpenApi(registry)` call here + a tag below.
 */
export function getOpenApiDocument() {
  if (!cached) {
    registerTrackingApiOpenApi(registry);
    registerAlertsOpenApi(registry);
    registerRoutesOpenApi(registry);

    cached = new OpenApiGeneratorV31(registry.definitions).generateDocument({
      openapi: '3.1.0',
      info: {
        title: 'Loadsmart Tracking API',
        version: API_VERSION,
        description:
          'Vehicle and trip tracking read API, alerts and route approval. Every route needs a staff access token from the main backend; data is scoped to the caller’s tenant (platform_admin sees all tenants), and out-of-scope IDs return 404. Success bodies are `{ data: ... }` — see docs/contracts/tracking-api.md for their shapes. Live positions are pushed over socket.io (`/live` on the realtime role), not documented here.',
      },
      tags: [
        { name: TAGS.VEHICLES, description: 'Fleet map, single-vehicle position and history' },
        { name: TAGS.TRIPS, description: 'Trip summaries and trip paths' },
        { name: TAGS.ALERTS, description: 'Rule-engine alerts and the event history behind them' },
        { name: TAGS.RULE_SETTINGS, description: 'Per-tenant rule enablement and parameters' },
        { name: TAGS.ROUTES, description: 'Planned-route approval and replanning' },
      ],
    });
  }

  return cached;
}

export function createDocsRouter(): Router {
  const router = Router();
  const document = getOpenApiDocument();

  // helmet()'s default CSP (app.ts) blocks swagger-ui-bundle.js's init code, which renders as a
  // silent blank page. This router is non-production only, so relaxing CSP just here is a scoped
  // trade-off — every real API route keeps the strict default.
  router.use((_req, res, next) => {
    res.removeHeader('Content-Security-Policy');
    next();
  });

  router.get('/openapi.json', (_req, res) => {
    res.json(document);
  });

  router.use(
    '/',
    swaggerUi.serve,
    swaggerUi.setup(document, {
      customSiteTitle: 'Loadsmart Tracking API Docs',
      swaggerOptions: { persistAuthorization: true },
    }),
  );

  return router;
}
