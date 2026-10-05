import type { Logger } from 'pino';
import type { StaffIdentity, TenantScope } from '../auth/staff-token';

// Express Request augmentation for what this service's middleware attaches.
declare global {
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      validatedQuery?: unknown;
      /** Set by staff-auth.middleware on authenticated routes. */
      user?: StaffIdentity;
      tenantScope?: TenantScope;
    }
  }
}

export {};
