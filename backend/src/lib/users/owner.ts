import type { NextFunction, Request, Response } from 'express';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { noteOwnerOnlyRefusal, noteOwnerRefusal } from '../permissions/refusalNote';
import { markRouteCheck } from '../../middleware/routeCheck';
import { canonicalUserId, sameUserId } from './sameUserId';
import { isOtherSpellingOfId } from '../ids/canonicalId';

/**
 * Roles & Permissions AL-16 (ticket 24, H5): every company has one Owner, held by the database (organizations.owner_user_id).
 *
 * This is the one Owner check. It reads the database on every call, never the sign-in cache: a hand-over (or a support fix)
 * takes effect on the very next request, on every server. A company with no Owner has none: there is NO fallback to its
 * oldest Admin, or to anyone (that rule lived only in migration M11, once).
 */

/** What every refused removal of the Owner answers (409), whoever asks, the Owner included. */
export const OWNER_CANT_BE_REMOVED = "The Owner can't be removed.";

type OwnerDb = { organization: Pick<Prisma.TransactionClient['organization'], 'findUnique'> };

/** The company's Owner, read from the database. Null when the company has none. */
export async function ownerOfCompany(organizationId: string, db: OwnerDb = prisma): Promise<string | null> {
  const org = await db.organization.findUnique({ where: { id: organizationId }, select: { owner_user_id: true } });
  return org?.owner_user_id ?? null;
}

/** Whether this person is the company's Owner, read from the database. */
export async function isCompanyOwner(organizationId: string, userId: string, db: OwnerDb = prisma): Promise<boolean> {
  // Compared as ids, not strings: an id written in capitals or without hyphens is still the Owner (CR-4).
  return sameUserId(await ownerOfCompany(organizationId, db), userId);
}

/**
 * Refuse an action that would remove the Owner of the caller's company: delete, deactivate, demote (the Admin switch or a
 * move off the Administrator role), revoke their sign-in or erase them. Answers 409 with OWNER_CANT_BE_REMOVED and notes the
 * refusal, so the audit middleware writes one `access.denied` row. Returns true when it answered.
 *
 * The Owner reference is tied to the company by the database, so a target that is the caller's company's Owner is always
 * one of the caller's own people: nothing about another company is revealed.
 */
export async function refuseOwnerRemoval(req: Request, res: Response, targetId: string): Promise<boolean> {
  if (!(await isCompanyOwner(req.user!.organization_id, targetId))) return false;
  noteOwnerRefusal(req, targetId);
  res.status(409).json({ error: OWNER_CANT_BE_REMOVED });
  return true;
}

/**
 * Roles & Permissions, ticket 26 (H4, H5): only the Owner changes Admins. Only the Owner makes someone an Admin (on create, on
 * invite, through the Admin switch, or by a move onto a role that makes its holder an Admin), and only the Owner acts on an
 * Admin's account: edit, take Admin away, deactivate, reactivate, revoke, resend invite, send password reset, mailbox address
 * and move, profile photo, switches, delete, erase and role change. Anyone else is refused with 403 and this answer.
 */
export const ONLY_THE_OWNER_CHANGES_ADMINS = 'Only the Owner can change Admins.';

/** The person an action is on, as the Owner check needs them. */
export interface AdminTarget {
  id: string;
  is_admin: boolean;
}

/**
 * Whether the Owner check refuses this action. The Owner may do all of it (the Owner's own removal is refused separately,
 * 409, by `refuseOwnerRemoval`). Anyone else may not make an Admin, and may not act on another Admin. A person acting on their
 * own account is not acting on another Admin: the rules for one's own account (no changing one's own role, no deactivating or
 * deleting oneself) are the handlers' own. A company with no Owner has no one who passes.
 */
export function ownerOnlyRefuses(args: { actorId: string; ownerId: string | null; target: AdminTarget | null; makesAdmin?: boolean }): boolean {
  if (args.ownerId !== null && sameUserId(args.actorId, args.ownerId)) return false;
  if (args.makesAdmin) return true;
  return args.target !== null && args.target.is_admin && !sameUserId(args.target.id, args.actorId);
}

/** Answer a refused change to an Admin: 403, and a note so the audit middleware writes one `access.denied` row. */
export function answerOwnerOnly(req: Request, res: Response, targetId: string | null): void {
  noteOwnerOnlyRefusal(req, targetId);
  res.status(403).json({ error: ONLY_THE_OWNER_CHANGES_ADMINS });
}

/**
 * The Owner check before an action, read from the database (never the sign-in cache). Returns true when it answered (refused).
 * A change that writes the person's access or account repeats the check inside its own transaction, under the company lock
 * (`lockCompanyForAdminChange`); an action that only sends something (a reset link, an invite) is checked here.
 */
export async function refuseUnlessOwnerFor(
  req: Request,
  res: Response,
  target: AdminTarget | null,
  opts: { makesAdmin?: boolean } = {},
): Promise<boolean> {
  if (!opts.makesAdmin && !target?.is_admin) return false;
  const ownerId = await ownerOfCompany(req.user!.organization_id);
  if (!ownerOnlyRefuses({ actorId: req.user!.id, ownerId, target, makesAdmin: opts.makesAdmin })) return false;
  answerOwnerOnly(req, res, target?.id ?? null);
  return true;
}

/**
 * The same check for a route that names a person by id and does not read them itself: the person is read here, inside the
 * caller's company. A person not found is left to the handler (its own 404), so nothing about another company is revealed.
 * A uuid in any spelling but the canonical one is refused here, 404 "User not found", never let through: the handler's own
 * lookup would still find the person by an upper-case, dash-less, braced or `urn:uuid:` spelling (security review SR-2). A
 * value that is no uuid at all names nobody, and is left to the handler as before.
 */
export async function refuseUnlessOwnerForPerson(req: Request, res: Response, personId: string): Promise<boolean> {
  if (isOtherSpellingOfId(personId)) {
    res.status(404).json({ error: 'User not found' });
    return true;
  }
  const id = canonicalUserId(personId);
  if (!UUID.test(id)) return false;
  const target = await prisma.user.findFirst({
    where: { id, organization_id: req.user!.organization_id },
    select: { id: true, is_admin: true },
  });
  return refuseUnlessOwnerFor(req, res, target);
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Route guard for an action that is the Owner's alone whoever the target is (Make Owner, ticket 27). Anyone else, an Admin or
 * not, is refused 403 "Only the Owner can change Admins." with one `access.denied` row, read from the database (never the
 * sign-in cache). The row names the person in `:id` only when they are one of the caller's own people, so nothing about another
 * company is written or revealed. The handler repeats the check under the company lock.
 */
export async function requireOwner(req: Request, res: Response, next: NextFunction): Promise<void> {
  if (!req.user) {
    res.status(401).json({ error: 'Not authenticated' });
    return;
  }
  try {
    if (await isCompanyOwner(req.user.organization_id, req.user.id)) {
      next();
      return;
    }
    const canonical = typeof req.params.id === 'string' ? canonicalUserId(req.params.id) : null;
    const id = canonical && UUID.test(canonical) ? canonical : null;
    const target = id
      ? await prisma.user.findFirst({ where: { id, organization_id: req.user.organization_id }, select: { id: true } })
      : null;
    answerOwnerOnly(req, res, target?.id ?? null);
  } catch (err) {
    // Express 4 does not catch a rejected guard: answer here, never pass a failed check through.
    next(err);
  }
}
markRouteCheck('permission', requireOwner);

/** Thrown inside a change's transaction when the Owner check, made under the company lock, refuses: the change rolls back. */
export class OwnerOnlyRefusal extends Error {
  constructor(readonly targetId: string | null) {
    super(ONLY_THE_OWNER_CHANGES_ADMINS);
    this.name = 'OwnerOnlyRefusal';
  }
}

/** Thrown inside a change's transaction when, under the company lock, the change would leave the company with no active Admin. */
export class LastAdminRefusal extends Error {
  constructor() {
    super('last active admin');
    this.name = 'LastAdminRefusal';
  }
}

/**
 * Lock the company for a change to who is an Admin or to an Admin's account, and read its Owner under that lock. Every such
 * change takes this lock first, inside its own transaction, so the Owner check and the count of active Admins it makes hold
 * until it commits: two Admins demoting each other at once run one after the other, and a hand-over of ownership (which
 * updates this row) can't slip between the check and the write.
 *
 * FOR NO KEY UPDATE: it conflicts with itself and with any update of the row, but not with the key-share lock every insert of
 * a row that references the company takes, so the company's ordinary work is not held up while a person is changed.
 */
export async function lockCompanyForAdminChange(tx: Prisma.TransactionClient, organizationId: string): Promise<string | null> {
  const rows = await tx.$queryRaw<Array<{ owner_user_id: string | null }>>`
    SELECT owner_user_id FROM organizations WHERE id = ${organizationId}::uuid FOR NO KEY UPDATE`;
  return rows[0]?.owner_user_id ?? null;
}

/** The company's active Admins, counted inside the change (under the lock above). */
export async function activeAdminCount(tx: Prisma.TransactionClient, organizationId: string): Promise<number> {
  return tx.user.count({ where: { organization_id: organizationId, is_admin: true, is_active: true } });
}
