import { Response } from 'express';

export function respond(res: Response, data: unknown, statusCode = 200): void {
  res.status(statusCode).json({ data });
}
