import type { Socket } from 'socket.io';

/**
 * The access token from a socket.io handshake. Prefers the `auth` payload; falls back to the
 * `token` query param, then `Authorization: Bearer`, for clients that can't set `auth`. Only
 * where the token is read from — verifying it is still the caller's job.
 */
export function extractHandshakeToken(handshake: Socket['handshake']): string | null {
  for (const raw of [
    handshake.auth?.token,
    handshake.query?.token,
    handshake.headers?.authorization,
  ]) {
    if (typeof raw !== 'string') continue;
    const token = raw.replace(/^Bearer\s+/i, '').trim();
    if (token) return token;
  }
  return null;
}
