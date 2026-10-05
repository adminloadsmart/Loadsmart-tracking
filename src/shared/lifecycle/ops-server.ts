import express, { Express } from 'express';
import { Registry } from 'prom-client';
import { HealthRegistry } from './health';

/**
 * Operational endpoints served by every process, whatever its ROLE, on its own port (OPS_PORT):
 *  - /healthz  liveness: the process and its event loop respond. Never checks dependencies — a
 *              Redis blip must not make the orchestrator kill every pod.
 *  - /readyz   readiness: every registered check (Postgres, Redis, per-role) passes; 503 otherwise.
 *  - /metrics  Prometheus exposition.
 * Kept off the public API app so it is never exposed through the API gateway.
 */
export function createOpsApp(health: HealthRegistry, metrics: Registry): Express {
  const app = express();
  app.disable('x-powered-by');

  app.get('/healthz', (_req, res) => {
    res.status(200).json({ data: { status: 'ok', uptimeSeconds: Math.round(process.uptime()) } });
  });

  app.get('/readyz', async (_req, res) => {
    const report = await health.readiness();
    res.status(report.status === 'ok' ? 200 : 503).json({ data: report });
  });

  app.get('/metrics', async (_req, res) => {
    res.setHeader('Content-Type', metrics.contentType);
    res.send(await metrics.metrics());
  });

  return app;
}
