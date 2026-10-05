import { ErrorRequestHandler, RequestHandler } from 'express';
import { AppError, NotFoundError } from '../errors';
import { logger } from '../logger';
import './request.types';

/** Mounted after every router: turns an unmatched route into the standard JSON error shape. */
export const notFoundHandler: RequestHandler = (req, _res, next) => {
  next(new NotFoundError(`Route ${req.method} ${req.path} not found`));
};

export const errorHandler: ErrorRequestHandler = (err, req, res, _next) => {
  const log = req.log ?? logger;

  if (err instanceof AppError) {
    if (!err.isOperational) {
      log.error({ err }, err.message);
    }

    res.status(err.statusCode).json({
      error: {
        code: err.code,
        message: err.message,
        // Non-operational errors (InternalError) carry raw caught errors — possibly SQL and bound
        // parameters — in `details`, which must never reach the client.
        ...(err.isOperational ? { details: err.details } : {}),
      },
    });
    return;
  }

  log.error({ err }, 'Unhandled error');
  res.status(500).json({
    error: { code: 'INTERNAL_ERROR', message: 'Something went wrong' },
  });
};
