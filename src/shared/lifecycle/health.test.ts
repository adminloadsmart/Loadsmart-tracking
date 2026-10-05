import { describe, expect, it } from 'vitest';
import { HealthRegistry } from './health';

describe('HealthRegistry', () => {
  it('is ok when every check passes, and surfaces check details', async () => {
    const health = new HealthRegistry();
    health.register('postgres', async () => undefined);
    health.register('scheduler', async () => ({ leader: true }));

    const report = await health.readiness();

    expect(report.status).toBe('ok');
    expect(report.checks.postgres.status).toBe('ok');
    expect(report.checks.scheduler.details).toEqual({ leader: true });
  });

  it('fails overall and names the failing check with its error', async () => {
    const health = new HealthRegistry();
    health.register('postgres', async () => undefined);
    health.register('redis', async () => {
      throw new Error('Connection is closed.');
    });

    const report = await health.readiness();

    expect(report.status).toBe('fail');
    expect(report.checks.postgres.status).toBe('ok');
    expect(report.checks.redis).toMatchObject({ status: 'fail', error: 'Connection is closed.' });
  });

  it('times out a hung check instead of hanging the probe', async () => {
    const health = new HealthRegistry(20);
    health.register('hung', () => new Promise(() => undefined));

    const report = await health.readiness();

    expect(report.checks.hung).toMatchObject({ status: 'fail', error: 'timed out after 20ms' });
  });

  it('treats a synchronous throw as a failed check', async () => {
    const health = new HealthRegistry();
    health.register('sync', (() => {
      throw new Error('boom');
    }) as never);

    expect((await health.readiness()).checks.sync.status).toBe('fail');
  });

  it('rejects duplicate registration and supports unregister', async () => {
    const health = new HealthRegistry();
    health.register('api', async () => undefined);
    expect(() => health.register('api', async () => undefined)).toThrow(/already registered/);

    health.unregister('api');
    expect((await health.readiness()).checks).toEqual({});
  });
});
