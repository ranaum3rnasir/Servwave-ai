import { Request, Response, NextFunction } from 'express';
import type { Action, Subject } from '../lib/permissions/catalog';
import { noteActionRefusal } from '../lib/permissions/refusalNote';
import { isSuperUser } from '../lib/permissions/effectiveRole';
import { markRouteCheck } from './routeCheck';

/**
 * The route permission gates (`canDo`, `canDoAny`): a switch refusal that says nothing about any record. A rule that
 * must run after a route's gates and before the rest (lib/permissions/outOfReachIsMissing.ts) finds them by this mark.
 */
const gates = new WeakMap<object, ReadonlyArray<readonly [string, string]>>();
export const isPermissionGate = (handle: unknown): boolean => typeof handle === 'function' && gates.has(handle);
/**
 * The (action, subject) pairs a gate lets through, any one of which passes it. The route test reads them to tell a real check
 * from a gate on a grant every signed-in person holds (lib/permissions/fixedGrants.ts), which nobody can fail (re-audit N14).
 */
export const gatePairsOf = (handle: unknown): ReadonlyArray<readonly [string, string]> | undefined =>
  (typeof handle === 'function' ? gates.get(handle) : undefined);
const gate = <T extends object>(pairs: ReadonlyArray<readonly [string, string]>, fn: T): T => {
  gates.set(fn, pairs);
  return markRouteCheck('permission', fn);
};

export function canDo(action: Action, subject: Subject) {
  return gate([[action, subject]], (req: Request, res: Response, next: NextFunction) => {
    if (!req.ability) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (!req.ability.can(action, subject)) {
      noteActionRefusal(req, [{ action, subject }]);
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  });
}

/**
 * User and role management is Admin-only (AL-18, ticket 28): every role route, every route that reads or changes a person's
 * switches, and every route that adds, invites, changes, deactivates, deletes or erases a person passes only for an Admin,
 * the `is_admin` flag on the person (isSuperUser), never for a switch. No switch can grant it, so a custom role holding every
 * switch, or a copy of the Admin role's switches, still cannot manage people or roles. Assigning a role rides on the same
 * routes, so it is Admin-only too. What only the Owner may do to an Admin is decided inside the handlers (AL-16).
 */
export const ADMIN_ONLY_MESSAGE = 'Only an Admin can manage users and roles.';

export function requireAdmin(req: Request, res: Response, next: NextFunction): void {
  refuseUnlessAdmin(req, res, next, ADMIN_ONLY_MESSAGE);
}
markRouteCheck('permission', requireAdmin);

function refuseUnlessAdmin(req: Request, res: Response, next: NextFunction, message: string): void {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  if (!isSuperUser(req.user)) {
    // No switch would have allowed it, so the refusal row names none (auditAccessDenied).
    res.status(403).json({ error: message });
    return;
  }
  next();
}

/**
 * A part of the company's setup that is the Admin flag's alone: the Company settings (the switch retired, ticket 36b, M17),
 * who reads the main mailbox, the phone service and phone numbers (ticket 36). Same rule as `requireAdmin`: the flag, never a
 * switch. `what` completes "Only an Admin can ...".
 */
export function requireAdminTo(what: string) {
  const message = `Only an Admin can ${what}.`;
  return markRouteCheck('permission', (req: Request, res: Response, next: NextFunction): void => refuseUnlessAdmin(req, res, next, message));
}

/**
 * Passes when the requester holds ANY of the given (action, subject) pairs — same 401/403
 * bodies as `canDo`. Introduced for the #2041 org-wide customer picker: the SAME picker
 * component backs the lead, job, estimate and standalone-invoice create forms, so the guard
 * has to be "may create at least one of these", not any single subject.
 */
export function canDoAny(pairs: [Action, Subject][]) {
  return gate(pairs, (req: Request, res: Response, next: NextFunction) => {
    if (!req.ability) {
      res.status(401).json({ error: 'Not authenticated' });
      return;
    }
    if (!pairs.some(([action, subject]) => req.ability!.can(action, subject))) {
      noteActionRefusal(req, pairs.map(([action, subject]) => ({ action, subject })));
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  });
}
