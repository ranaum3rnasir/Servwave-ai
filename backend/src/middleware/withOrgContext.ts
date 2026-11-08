import { Request, Response, NextFunction } from 'express';
import { runWithOrg } from '../lib/tenant-context';

/**
 * Re-establish the AsyncLocalStorage tenant context for the downstream handler.
 *
 * `authenticate` runs the request inside runWithOrg(org, next) so the DB RLS
 * backstop can scope every query to the caller's org. Body-parsing middleware
 * that consumes the request stream — notably multer's `upload.single()` — drives
 * the continuation off stream events, OUTSIDE that AsyncLocalStorage scope. Any
 * controller mounted AFTER such middleware would then run with no org context,
 * so (with DB_TENANT_GUARD=on) RLS matches zero rows and reads 404 as
 * "Entity not found".
 *
 * Place this immediately AFTER multer on every multipart route to restore the
 * uploader's org scope for the controller. `req.user` is set by `authenticate`
 * and survives multer, so it is the source of truth for the org id here.
 */
export function withOrgContext(req: Request, _res: Response, next: NextFunction) {
  const orgId = req.user?.organization_id;
  if (orgId) {
    runWithOrg(orgId, () => next());
    return;
  }
  next();
}
