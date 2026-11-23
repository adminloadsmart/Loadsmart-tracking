import jwt from 'jsonwebtoken';
import type { Socket } from 'socket.io';
import { describe, expect, it } from 'vitest';
import { createDriverSocketAuth } from './driver-socket-auth';

const SECRET = 'test-secret';
const token = jwt.sign({ id: 'd1', purpose: 'driver-identity-access' }, SECRET, {
  expiresIn: '1h',
});

async function connect(opts: { tenants: string[]; onTrip: boolean }) {
  const auth = createDriverSocketAuth({
    jwtSecret: SECRET,
    isBlocked: async () => false,
    activeTenantIds: async () => opts.tenants,
    hasActiveTrip: async () => opts.onTrip,
  });
  const socket = { handshake: { auth: { token }, headers: {}, query: {} }, data: {} };
  let error: Error | undefined;
  await auth(socket as unknown as Socket, (err) => {
    error = err;
  });
  return { error, driver: (socket.data as { driver?: { tenantIds: string[] } }).driver };
}

describe('createDriverSocketAuth', () => {
  it('lets in a driver with tenant relations', async () => {
    const { error, driver } = await connect({ tenants: ['t1'], onTrip: false });
    expect(error).toBeUndefined();
    expect(driver?.tenantIds).toEqual(['t1']);
  });

  it('lets in a market / indent driver with no tenant while a load names them', async () => {
    const { error, driver } = await connect({ tenants: [], onTrip: true });
    expect(error).toBeUndefined();
    expect(driver?.tenantIds).toEqual([]);
  });

  it('refuses a driver with no tenant and no trip', async () => {
    const { error } = await connect({ tenants: [], onTrip: false });
    expect(error?.message).toBe('unauthorized');
  });
});
