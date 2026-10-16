import jwt, { JwtPayload } from 'jsonwebtoken';
import type { Socket } from 'socket.io';
import { extractHandshakeToken } from '../../shared/auth/handshake-token';

/** Who is on the other end of a /driver socket — set on socket.data by the handshake. */
export interface DriverIdentity {
  driverId: string;
  tenantId: string;
  jti: string | null;
  /** Epoch seconds the token expires. */
  exp: number;
}

interface DriverTokenPayload extends JwtPayload {
  id?: string;
  tenantId?: string | null;
  purpose?: string;
}

/**
 * Verifies the driver-app access token the main loadsmart backend issues (its
 * driver-auth.middleware.ts): HS256 with the shared JWT_SECRET, purpose 'driver-access' (a
 * tenant-selected session — 'driver-identity-access' and login/OTP tokens are rejected), not
 * revoked. Every failure is the same opaque 'unauthorized' so a caller can't probe which check
 * failed.
 */
export function verifyDriverToken(token: string, jwtSecret: string): DriverIdentity | null {
  let decoded: DriverTokenPayload;
  try {
    decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] }) as DriverTokenPayload;
  } catch {
    return null;
  }
  if (decoded.purpose !== 'driver-access') return null;
  if (!decoded.id || !decoded.tenantId || typeof decoded.exp !== 'number') return null;
  return {
    driverId: decoded.id,
    tenantId: decoded.tenantId,
    jti: decoded.jti ?? null,
    exp: decoded.exp,
  };
}

export function createDriverSocketAuth(deps: {
  jwtSecret: string;
  isBlocked: (jti: string | null) => Promise<boolean>;
}) {
  return async (socket: Socket, next: (err?: Error) => void): Promise<void> => {
    const token = extractHandshakeToken(socket.handshake);
    const identity = token ? verifyDriverToken(token, deps.jwtSecret) : null;
    if (!identity || (await deps.isBlocked(identity.jti))) {
      next(new Error('unauthorized'));
      return;
    }
    socket.data.driver = identity;
    next();
  };
}
