import type Redis from 'ioredis';
import type { Logger } from 'pino';

// Same key the main backend writes on logout/revocation (its shared/utils/token-blocklist.ts).
const BLOCKLIST_PREFIX = 'access-token-blocklist:';

export type IsTokenBlocked = (jti: string | null | undefined) => Promise<boolean>;

/**
 * Revocation check against the MAIN backend's Redis, shared by driver and staff tokens. Fails
 * open exactly like the main backend: a Redis blip must not lock every user out; exposure is
 * bounded by the short access-token lifetime.
 */
export function createTokenBlocklist(mainRedis: Redis, logger: Logger): IsTokenBlocked {
  return async (jti) => {
    if (!jti) return false;
    try {
      return (await mainRedis.get(`${BLOCKLIST_PREFIX}${jti}`)) !== null;
    } catch (err) {
      logger.warn({ err }, 'Token blocklist check failed; allowing (fail-open)');
      return false;
    }
  };
}
