import { Request, Response, NextFunction } from 'express';
import { logAudit } from '../lib/audit';
import { scopeSwitchesFor, switchesAllowing, type RefusedPair } from '../lib/permissions/refusalNote';

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
const label = (n: RefusedPair) => `${n.action}:${n.subject}`;

/**
 * One audit row per refused request (P18), written once the response is sent:
 *  - a 403 writes `access.denied`: who (the actor), what (method and path, and the action and subject the guard asked for)
 *    and when (the row's time), and `switches`, the switches that would have allowed it;
 *  - a 409 that refused removing the company's Owner (AL-16) writes `access.denied` naming the Owner; no switch allows it;
 *  - a 403 that refused a change to an Admin by someone who is not the Owner (ticket 26) names the person acted on;
 *  - a 404 for a record that exists but is outside the person's reach writes `access.hidden`, naming the scope switches that
 *    decide reach. A 404 for a record that is not there writes nothing.
 * Only a request that really ended as a refusal is logged: a guard or row check notes its refusal on the request
 * (lib/permissions/refusalNote.ts), and a probe that failed inside a request that went on to succeed leaves no row.
 */
async function writeRefusalRow(req: Request, status: number): Promise<void> {
  if (status !== 403 && status !== 404 && status !== 409) return;
  const note = req.refusalNote;
  const where = {
    method: req.method,
    // Strip the query string so single-use tokens on public routes are never logged.
    path: req.originalUrl.split('?')[0],
    role: req.user?.role ?? null,
  };
  // A 409 is a refusal only when it refused removing the company's Owner (AL-16); every other 409 is a conflict, not a
  // refusal. No switch would have allowed it.
  if (status === 409) {
    if (note?.kind !== 'owner') return;
    await logAudit({
      req,
      action: 'access.denied',
      resourceType: 'User',
      resourceId: note.id,
      metadata: { ...where, needs: [], switches: [], refused: 'owner_cant_be_removed' },
    });
    return;
  }
  if (status === 404) {
    if (note?.kind !== 'row') return;
    try {
      if (!(await note.exists())) return;
    } catch {
      return;
    }
    await logAudit({
      req,
      action: 'access.hidden',
      resourceType: note.resource,
      resourceId: note.id,
      metadata: { ...where, switches: scopeSwitchesFor(note.resource) },
    });
    return;
  }
  // Only the Owner changes Admins (ticket 26): no switch would have allowed it; the row names the person acted on.
  if (note?.kind === 'owner_only') {
    await logAudit({
      req,
      action: 'access.denied',
      ...(note.id ? { resourceType: 'User', resourceId: note.id } : {}),
      metadata: { ...where, needs: [], switches: [], refused: 'only_the_owner_changes_admins' },
    });
    return;
  }
  const needs: RefusedPair[] = !note || note.kind === 'owner' ? [] : note.kind === 'action' ? note.needs : note.needs ? [note.needs] : [];
  const switches = [...switchesAllowing(needs), ...(note?.kind === 'row' ? scopeSwitchesFor(note.resource) : [])];
  await logAudit({
    req,
    action: 'access.denied',
    ...(note?.kind === 'row' ? { resourceType: note.resource, resourceId: note.id } : {}),
    metadata: { ...where, needs: needs.map(label), switches },
  });
}

export function auditAccessDenied(req: Request, res: Response, next: NextFunction): void {
  res.on('finish', () => {
    void writeRefusalRow(req, res.statusCode);
  });

  next();
}
