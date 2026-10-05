import { AppError } from './AppError';

export class InternalError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 500, 'INTERNAL_ERROR', details, false);
  }
}
