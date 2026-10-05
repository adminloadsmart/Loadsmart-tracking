import { RequestHandler } from 'express';
import type { IsTokenBlocked } from '../auth/token-blocklist';
import { tenantScopeFor, verifyStaffToken } from '../auth/staff-token';
import { AuthenticationError, AuthorizationError } from '../errors';
import './request.types';

/**
 * Bearer-token auth for the REST read API: a staff access token from the main loadsmart backend
 * (see shared/auth/staff-token.ts). Sets req.user and req.tenantScope. Same generic message on
 * every token failure, as the main backend does, so callers can't probe which check failed.
 */
export function createStaffAuth(deps: {
  jwtSecret: string;
  isBlocked: IsTokenBlocked;
}): RequestHandler {
  return async (req, _res, next) => {
    const header = req.header('Authorization');
    const token = header?.startsWith('Bearer ') ? header.slice('Bearer '.length) : null;
    const identity = token ? verifyStaffToken(token, deps.jwtSecret) : null;
    if (!identity || (await deps.isBlocked(identity.jti))) {
      throw new AuthenticationError('Invalid or expired token');
    }
    const scope = tenantScopeFor(identity);
    if (!scope) throw new AuthorizationError('Your role has no access to tracking data');
    req.user = identity;
    req.tenantScope = scope;
    next();
  };
}
