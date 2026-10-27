import jwt, { JwtPayload } from 'jsonwebtoken';
import type { Socket } from 'socket.io';
import { extractHandshakeToken } from '../../shared/auth/handshake-token';

/** Who is on the other end of a /driver socket — set on socket.data by the handshake. */
export interface DriverIdentity {
  driverId: string;
  /** Tenants the driver may push points for: the token's tenant, or — for an identity-scoped
   *  token — their live active relations. */
  tenantIds: string[];
  jti: string | null;
  /** Epoch seconds the token expires. */
  exp: number;
}

interface DriverTokenPayload extends JwtPayload {
  id?: string;
  tenantId?: string | null;
  purpose?: string;
}

const ACCEPTED_PURPOSES = ['driver-access', 'driver-identity-access'];

/**
 * Verifies the driver-app access token the main loadsmart backend issues (its
 * driver-auth.middleware.ts): HS256 with the shared JWT_SECRET, purpose 'driver-access' or
 * 'driver-identity-access' (login always issues the latter, with no tenant — the tenants are
 * resolved live, see createDriverSocketAuth; login/OTP tokens are rejected), not revoked. Every failure is the same opaque 'unauthorized' so a caller can't probe which check
 * failed.
 */
export function verifyDriverToken(token: string, jwtSecret: string): DriverIdentity | null {
  let decoded: DriverTokenPayload;
  try {
    decoded = jwt.verify(token, jwtSecret, { algorithms: ['HS256'] }) as DriverTokenPayload;
  } catch {
    return null;
  }
  if (!decoded.purpose || !ACCEPTED_PURPOSES.includes(decoded.purpose)) return null;
  if (!decoded.id || typeof decoded.exp !== 'number') return null;
  return {
    driverId: decoded.id,
    tenantIds: decoded.tenantId ? [decoded.tenantId] : [],
    jti: decoded.jti ?? null,
    exp: decoded.exp,
  };
}

export function createDriverSocketAuth(deps: {
  jwtSecret: string;
  isBlocked: (jti: string | null) => Promise<boolean>;
  /** The driver's active tenant relations, resolved live like the main backend's createDriverAuth. */
  activeTenantIds: (driverId: string) => Promise<string[]>;
}) {
  return async (socket: Socket, next: (err?: Error) => void): Promise<void> => {
    const token = extractHandshakeToken(socket.handshake);
    const identity = token ? verifyDriverToken(token, deps.jwtSecret) : null;
    if (!identity || (await deps.isBlocked(identity.jti))) {
      next(new Error('unauthorized'));
      return;
    }
    // A tenant-pinned token carries its tenant; an identity token resolves the live relations. A
    // driver with none is rejected, same as the main backend's requireTenant.
    if (identity.tenantIds.length === 0) {
      identity.tenantIds = await deps.activeTenantIds(identity.driverId);
      if (identity.tenantIds.length === 0) {
        next(new Error('unauthorized'));
        return;
      }
    }
    socket.data.driver = identity;
    next();
  };
}
