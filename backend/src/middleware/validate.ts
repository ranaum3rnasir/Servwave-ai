import { Request, Response, NextFunction } from 'express';
import { ZodSchema, ZodError } from 'zod';

/** The standard 400 body for a failed validation - single owner of this shape. */
export function validationFailure(details: { field: string; message: string }[]) {
  return { error: 'Validation failed', details };
}

export function zodValidationFailure(err: ZodError) {
  return validationFailure(err.errors.map((e) => ({ field: e.path.join('.'), message: e.message })));
}

export function validate(schema: ZodSchema) {
  return (req: Request, res: Response, next: NextFunction) => {
    try {
      req.body = schema.parse(req.body);
      next();
    } catch (err) {
      if (err instanceof ZodError) {
        res.status(400).json(zodValidationFailure(err));
        return;
      }
      next(err);
    }
  };
}
