import { AppError } from './AppError';

export class RateLimitError extends AppError {
  constructor(message: string, details?: unknown) {
    super(message, 429, 'RATE_LIMIT_EXCEEDED', details);
  }
}
