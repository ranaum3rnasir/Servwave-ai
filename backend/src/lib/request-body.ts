/**
 * The JSON body of a request as a plain object: an array, a bare value or no body at all read as an empty object, so a
 * schema sees the same input a hand-written `req.body ?? {}` read did.
 */
import type { Request } from 'express';

export function plainBody(req: Request): Record<string, unknown> {
  const body: unknown = req.body;
  return body !== null && typeof body === 'object' && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
}
