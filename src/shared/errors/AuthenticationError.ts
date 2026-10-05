import { AppError } from './AppError';

export class AuthenticationError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 401, 'AUTHENTICATION_ERROR', details);
  }
}
