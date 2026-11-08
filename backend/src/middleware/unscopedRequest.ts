import { Request, Response, NextFunction } from 'express';
import { runUnscoped } from '../lib/tenant-context';

/**
 * Marks a request as a legitimate cross-tenant path for the RLS backstop.
 *
 * Use ONLY on unauthenticated routes that have no `req.user` org yet resolve the
 * tenant from the entity/token themselves — the Stripe webhook and the public
 * token pages (GET /:id/public). Without this, once DB_TENANT_GUARD=on those
 * routes would run with no org context and RLS would (correctly) hide every row.
 */
export function unscopedRequest(_req: Request, _res: Response, next: NextFunction): void {
  runUnscoped(() => next());
}
