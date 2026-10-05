import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { metricsRegistry } from '../metrics';
import { HealthRegistry } from './health';
import { createOpsApp } from './ops-server';

describe('ops server', () => {
  it('GET /healthz is 200 without consulting readiness checks', async () => {
    const health = new HealthRegistry();
    health.register('redis', async () => {
      throw new Error('down');
    });

    const res = await request(createOpsApp(health, metricsRegistry)).get('/healthz');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
  });

  it('GET /readyz is 200 when all checks pass', async () => {
    const health = new HealthRegistry();
    health.register('postgres', async () => undefined);

    const res = await request(createOpsApp(health, metricsRegistry)).get('/readyz');

    expect(res.status).toBe(200);
    expect(res.body.data.status).toBe('ok');
  });

  it('GET /readyz is 503 and names the failing dependency', async () => {
    const health = new HealthRegistry();
    health.register('postgres', async () => undefined);
    health.register('redis', async () => {
      throw new Error('Connection is closed.');
    });

    const res = await request(createOpsApp(health, metricsRegistry)).get('/readyz');

    expect(res.status).toBe(503);
    expect(res.body.data.checks.redis).toMatchObject({ status: 'fail' });
  });

  it('GET /metrics exposes Prometheus text including the role gauge', async () => {
    const res = await request(createOpsApp(new HealthRegistry(), metricsRegistry)).get('/metrics');

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/plain');
    expect(res.text).toContain('tracking_role_up');
    expect(res.text).toContain('process_cpu_user_seconds_total');
  });
});
