import request from 'supertest';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApp } from '../../app';
import { env } from '../../config/env';

const app = () => createApp({ publicRouters: [], routers: [] });

describe('API docs', () => {
  afterEach(() => vi.restoreAllMocks());

  it('serves an OpenAPI spec covering every REST route, all behind bearer auth', async () => {
    const res = await request(app()).get('/docs/openapi.json');

    expect(res.status).toBe(200);
    expect(res.body.openapi).toBe('3.1.0');
    expect(Object.keys(res.body.paths).sort()).toEqual([
      '/v1/alerts',
      '/v1/alerts/{alertId}/acknowledge',
      '/v1/alerts/{alertId}/close',
      '/v1/rule-settings',
      '/v1/rule-settings/{ruleId}',
      '/v1/trips',
      '/v1/trips/{tripId}',
      '/v1/trips/{tripId}/events',
      '/v1/trips/{tripId}/route/approve',
      '/v1/trips/{tripId}/track',
      '/v1/vehicles/live',
      '/v1/vehicles/{vehicleId}/events',
      '/v1/vehicles/{vehicleId}/location',
      '/v1/vehicles/{vehicleId}/timeline',
    ]);
    const operations = Object.values(res.body.paths).flatMap((item) =>
      Object.values(item as Record<string, { security?: unknown }>),
    );
    expect(operations).toHaveLength(14);
    for (const operation of operations) {
      expect(operation.security).toEqual([{ bearerAuth: [] }]);
    }
  });

  it('serves the Swagger UI', async () => {
    const res = await request(app()).get('/docs/').redirects(1);

    expect(res.status).toBe(200);
    expect(res.text).toContain('swagger-ui');
  });

  it('does not mount /docs in production', async () => {
    vi.spyOn(env, 'nodeEnv', 'get').mockReturnValue('production');
    const res = await request(app()).get('/docs/openapi.json');

    expect(res.status).toBe(404);
  });
});
