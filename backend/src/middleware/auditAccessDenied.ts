import { Request, Response, NextFunction } from 'express';
import { logAudit } from '../lib/audit';

/**
 * Records an `access.denied` audit row whenever a request terminates with HTTP 403,
 * regardless of which layer produced it: the `authorize` role guard, the `canGuard`
 * CASL ability guard, an instance-level CASL early-return in a controller, or a
 * thrown `ForbiddenError` translated by the central error handler.
 *
 * This complements the success-path instrumentation: those calls record what users
 * DID; this records what they were BLOCKED from doing — the signal for RBAC
 * misconfiguration and privilege-probing / cross-tenant access attempts.
 *
 * PASSIVE by design: it registers a single `finish` listener and then immediately
 * calls `next()`. It never changes the status, body, headers, or control flow — so
 * it is safe to mount globally ahead of every router. `logAudit` is fire-and-forget
 * and failure-isolated, so a logging hiccup can never affect the already-sent 403.
 *
 * org_id / actor / ip / user-agent are read from `req` by `logAudit`. When the 403
 * came from `authenticate` itself (e.g. a deactivated account), `req.user` is unset
 * and `logAudit` skips the row with a warning rather than writing an org-less one.
 */
export function auditAccessDenied(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    if (res.statusCode !== 403) return;

    void logAudit({
      req,
      action: 'access.denied',
      metadata: {
        method: req.method,
        // Strip the query string so single-use tokens on public routes are never logged.
        path: req.originalUrl.split('?')[0],
        role: req.user?.role ?? null,
      },
    });
  });

  next();
}
