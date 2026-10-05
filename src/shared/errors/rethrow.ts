import { AppError } from './AppError';
import { InternalError } from './InternalError';

/**
 * Used inside a service method's catch block: known AppErrors (NotFoundError, ConflictError,
 * ValidationError, ...) propagate unchanged so their status code still reaches the client via
 * errorHandler; anything unexpected (DB failures, bugs) is wrapped into a 500 so it's never
 * silently lost, with the original error kept as `details` for logging.
 */
export function rethrow(error: unknown, message: string): never {
  if (error instanceof AppError) throw error;
  throw new InternalError(message, error);
}
