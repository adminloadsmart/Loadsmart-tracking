import { AppError } from './AppError';

export class AuthorizationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 403, 'AUTHORIZATION_ERROR', details);
  }
}
