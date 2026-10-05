import { RequestHandler } from 'express';
import { ZodType } from 'zod';
import { ValidationError } from '../errors';

export const validate = (schema: ZodType): RequestHandler => {
  return (req, _res, next) => {
    const result = schema.safeParse({ body: req.body, query: req.query, params: req.params });

    if (!result.success) {
      throw new ValidationError('Validation failed', result.error.flatten());
    }

    const parsed = result.data as { body?: unknown; query?: unknown; params?: unknown };
    if (parsed.body !== undefined) req.body = parsed.body;
    // req.query has no setter in Express 5 (it's a getter that re-parses req.url on every
    // access), so the coerced/defaulted query can't be written back onto it — controllers must
    // read req.validatedQuery instead of req.query whenever their route validates a query schema.
    if (parsed.query !== undefined) req.validatedQuery = parsed.query;
    if (parsed.params !== undefined) Object.assign(req.params, parsed.params);

    next();
  };
};
