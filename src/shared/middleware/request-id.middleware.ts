import { randomUUID } from 'crypto';
import { RequestHandler } from 'express';
import { logger } from '../logger';
import './request.types';

export const requestId: RequestHandler = (req, res, next) => {
  req.id = req.header('X-Request-Id') ?? randomUUID();
  res.setHeader('X-Request-Id', req.id);
  // Every log line written while handling this request carries its requestId.
  req.log = logger.child({ requestId: req.id });
  next();
};
