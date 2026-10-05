import type { Logger } from 'pino';

// Express Request augmentation for what this service's middleware attaches. Auth payload types
// (AuthenticatedUser / driver identity) are added here in Phase 2 alongside the auth middleware.
declare global {
  namespace Express {
    interface Request {
      id: string;
      log: Logger;
      validatedQuery?: unknown;
    }
  }
}

export {};
