import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { createApp } from './app';
import { ConflictError, InternalError } from './shared/errors';

function appWithRoute(handler: express.RequestHandler) {
  const router = express.Router();
  router.get('/boom', handler);
  return createApp({ publicRouters: [{ path: '/test', router }], routers: [] });
}

describe('createApp', () => {
  it('returns a JSON 404 for unknown routes and echoes a request id', async () => {
    const res = await request(createApp({ publicRouters: [], routers: [] })).get('/v1/nope');

    expect(res.status).toBe(404);
    expect(res.body.error).toMatchObject({ code: 'NOT_FOUND' });
    expect(res.headers['x-request-id']).toBeTruthy();
  });

  it('keeps a caller-supplied X-Request-Id', async () => {
    const res = await request(createApp({ publicRouters: [], routers: [] }))
      .get('/v1/nope')
      .set('X-Request-Id', 'req-123');

    expect(res.headers['x-request-id']).toBe('req-123');
  });

  it('maps operational AppErrors to their status with details', async () => {
    const res = await request(
      appWithRoute(() => {
        throw new ConflictError('Already exists', { field: 'imei' });
      }),
    ).get('/v1/test/boom');

    expect(res.status).toBe(409);
    expect(res.body.error).toEqual({
      code: 'CONFLICT',
      message: 'Already exists',
      details: { field: 'imei' },
    });
  });

  it('never leaks details of non-operational errors', async () => {
    const res = await request(
      appWithRoute(() => {
        throw new InternalError('DB failed', { sql: 'SELECT secret' });
      }),
    ).get('/v1/test/boom');

    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'DB failed' });
  });

  it('turns unknown thrown errors into a generic 500', async () => {
    const res = await request(
      appWithRoute(() => {
        throw new Error('raw failure');
      }),
    ).get('/v1/test/boom');

    expect(res.status).toBe(500);
    expect(res.body.error).toEqual({ code: 'INTERNAL_ERROR', message: 'Something went wrong' });
  });
});
