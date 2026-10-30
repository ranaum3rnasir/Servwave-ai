import type { Request } from 'express';
import { SWITCH_CATALOG } from './switches/catalog';

/**
 * What a refusal needs to be logged (P18): who was refused (the audit row's actor), what they asked for, and which switch
 * would have allowed it. A guard that refuses (or a row check that finds a record out of reach) only NOTES it on the request;
 * the audit middleware (`auditAccessDenied`) reads the note when the response is sent and writes exactly one row, and only if
 * the request really ended as a refusal. So a probe that fails inside a request that then succeeds (a button list asking
 * "may this person delete?") never writes a row.
 */

/** The (action, subject) pair a guard refused. */
export interface RefusedPair { action: string; subject: string }

export type RefusalNote =
  | { kind: 'action'; needs: RefusedPair[] }
  | { kind: 'row'; resource: string; id: string; needs: RefusedPair | null; exists: () => Promise<boolean> }
  // An action that would remove the company's Owner (AL-16): refused with 409 whoever asks, so no switch would allow it.
  | { kind: 'owner'; id: string }
  // A change to an Admin (or making one) by someone who is not the Owner (ticket 26): refused with 403, and no switch allows it.
  | { kind: 'owner_only'; id: string | null };

declare module 'express-serve-static-core' {
  interface Request {
    /** The first refusal noted on this request; see `auditAccessDenied`. */
    refusalNote?: RefusalNote;
  }
}

/** The switches whose grants include any of these pairs: the ones that would have allowed the action. */
export function switchesAllowing(pairs: readonly RefusedPair[]): string[] {
  const keys = SWITCH_CATALOG
    .filter((s) => s.grants.some((g) => pairs.some((p) => p.action === g.action && p.subject === g.subject)))
    .map((s) => s.key);
  return [...new Set(keys)].sort();
}

/**
 * The scope switches that decide whether a record of this kind is within reach: an estimate or invoice follows the Jobs and
 * Leads scope (P6), a customer the leads and jobs it comes with, a purchase order its job, and a task, calendar entry, asset or
 * timesheet its own module's scope (CR-11; the same keys as moduleReach.ts's REACH_SCOPE_KEY).
 */
const OWN_SCOPE_SWITCH: Readonly<Record<string, string>> = {
  Job: 'jobs_scope',
  Lead: 'leads_scope',
  PurchaseOrder: 'jobs_scope',
  Task: 'tasks_scope',
  CalendarEntry: 'events_scope',
  Asset: 'assets_scope',
  Timesheet: 'timesheets_scope',
};

export function scopeSwitchesFor(resource: string): string[] {
  const own = OWN_SCOPE_SWITCH[resource];
  return own ? [own] : ['jobs_scope', 'leads_scope'];
}

/** A route guard refused an action. The first refusal on a request is the one kept. */
export function noteActionRefusal(req: Request, needs: readonly RefusedPair[]): void {
  req.refusalNote ??= { kind: 'action', needs: [...needs] };
}

/** A row check found a record out of the person's reach (or not allowed for this verb). Only a note; see above. */
export function noteRowRefusal(
  req: Request,
  resource: string,
  id: string,
  action: string | null,
  exists: () => Promise<boolean>,
): void {
  req.refusalNote ??= { kind: 'row', resource, id, needs: action ? { action, subject: resource } : null, exists };
}

/**
 * A request asked to remove the company's Owner (delete, deactivate, demote, revoke or erase them; AL-16). It is refused
 * with 409, not 403, and still logged as one `access.denied` row. It replaces any earlier note: a probe refused earlier in
 * the same request is not why this one ended.
 */
export function noteOwnerRefusal(req: Request, ownerId: string): void {
  req.refusalNote = { kind: 'owner', id: ownerId };
}

/**
 * A request asked to make an Admin, or to act on an Admin's account, and the caller is not the Owner (ticket 26). Refused with
 * 403 and logged as one `access.denied` row naming the person acted on (none for a new person). It replaces any earlier note.
 */
export function noteOwnerOnlyRefusal(req: Request, targetId: string | null): void {
  req.refusalNote = { kind: 'owner_only', id: targetId };
}
