import { createHash, randomBytes, timingSafeEqual } from 'crypto';
import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { logger } from '../logger';
import { env } from '../../config/env';
import { INVITE_TTL_SECONDS, signScoped } from '../invite-token';
import { sendOwnerApprovalEmail, sendOwnerChangedEmail } from '../email';
import { lockCompanyForAdminChange } from './owner';
import { recordOwnerChange, type AccessActor } from './access-audit';

/**
 * Make Owner (Roles & Permissions, ticket 27; spec stories 18-23, finding H5, decision D1).
 *
 * The Owner hands the company to another active Admin of the same company who has really signed in. It is two steps:
 *
 *  1. REQUEST (the Owner, signed in): nothing changes. The CURRENT Owner is emailed a one-time approval link (D1: the Owner
 *     approves, not the new Owner), so someone who got into the Owner's session can't take the company.
 *  2. APPROVE (whoever opens the link: possession of the emailed link is the proof, as with an invite link; the spec has the
 *     link, "opened once and within its expiry", move the ownership). In one transaction, under the company lock every Admin
 *     change takes: re-check that the approver is still the Owner and the new Owner is still eligible, use the link up, move
 *     `organizations.owner_user_id`, and write ONE `owner.assigned` audit row with the before and after. After the commit the new
 *     Owner and the outgoing Owner are each emailed. The outgoing Owner stays an Admin: nothing about them changes.
 *
 * Storage: no new table. The pending approval lives the way a live invite does (lib/invite-link.ts): the link is a signed,
 * self-contained token (who, to whom, which company, until when, and an id), and the OUTGOING Owner's row remembers which id is
 * live, as `users.password_hash = 'handover:v1:<sha256 of the id>'`. That column holds one-time-link marks and nothing else (sign-in
 * lives at the identity provider). Only the hash is stored; the token and its id are never stored or logged.
 *  - a newer request overwrites the mark, so the older link is dead at once;
 *  - approving swaps the mark for '' with a compare-and-swap inside the locked transaction, so a link works once, and of two
 *    simultaneous opens exactly one moves anything;
 *  - an expired link fails its own signature check before anything is read.
 * The Owner's row is never revoked, deactivated or erased (those are refused for the Owner, AL-16), so no other writer of the
 * column touches a pending mark; a sign-in clears only invite marks (retireInvite), never this one.
 */

/** How long an approval link lives. The spec gives none, so it is the invite link's (7 days). */
export const OWNER_APPROVAL_TTL_SECONDS = INVITE_TTL_SECONDS;

const SCOPE = 'owner-handover';
const MARK_PREFIX = 'handover:v1:';

/** What every expired, used, replaced, tampered or unknown link is answered. It names no person and no company. */
export const OWNER_LINK_EXPIRED_MESSAGE = 'This approval link has expired or has already been used. Nothing was changed.';
export const OWNER_LINK_EXPIRED_CODE = 'owner_link_expired';
export const OWNER_LINK_EXPIRED_BODY = { error: OWNER_LINK_EXPIRED_MESSAGE, code: OWNER_LINK_EXPIRED_CODE } as const;

/** The person picked can't become the Owner (not an active Admin of the company who has signed in, or already the Owner). */
export const NOT_AN_OWNER_CANDIDATE = 'Only an active Admin who has signed in can become the Owner.';
/** The link was good, but by the time it was opened the new Owner was no longer eligible. Nothing changed. */
export const OWNER_CANDIDATE_GONE = 'This person can no longer become the Owner: they must be an active Admin who has signed in. Nothing was changed.';

/**
 * The completed sign-ins on the app's own record (audit_logs, written by each door), the same proof migration M11 used for the
 * first Owners, plus an accepted invite (the person set their own password from the emailed link). `has_login` alone is not
 * proof: an invite sets it before the person ever signs in (H5).
 */
export const SIGNED_IN_ACTIONS = ['login.succeeded', 'mfa.verified', 'oauth.google_finalized', 'invite.accepted'] as const;

interface HandoverPayload {
  /** The company. */
  org: string;
  /** The Owner who asked, and who alone approves. */
  owner: string;
  /** The Admin who becomes the Owner. */
  to: string;
  /** Unix seconds. */
  exp: number;
  /** Which request this link is; only the one whose hash the Owner's row holds is live. */
  jti: string;
}

const hashOf = (jti: string) => createHash('sha256').update(jti).digest('hex');
export const handoverMarkFor = (jti: string) => MARK_PREFIX + hashOf(jti);

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function signHandover(payload: HandoverPayload): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${signScoped(SCOPE, body)}`;
}

/** Signature, shape and expiry. Null for anything that is not a live-looking approval link. */
function verifyHandover(token: unknown): HandoverPayload | null {
  if (typeof token !== 'string' || token.length > 2048) return null;
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const [body, given] = parts as [string, string];
  const a = Buffer.from(given);
  const b = Buffer.from(signScoped(SCOPE, body));
  if (a.length !== b.length || !timingSafeEqual(a, b)) return null;
  let p: Partial<HandoverPayload>;
  try {
    p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Partial<HandoverPayload>;
  } catch {
    return null;
  }
  if (!p || typeof p.org !== 'string' || typeof p.owner !== 'string' || typeof p.to !== 'string' || typeof p.jti !== 'string') return null;
  if (!UUID.test(p.org) || !UUID.test(p.owner) || !UUID.test(p.to) || typeof p.exp !== 'number') return null;
  if (p.exp < Math.floor(Date.now() / 1000)) return null;
  return p as HandoverPayload;
}

type Db = Prisma.TransactionClient | typeof prisma;

/** Of these people of the company, the ones the app has on record as having really signed in. */
export async function signedInAmong(db: Db, organizationId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const rows = await db.auditLog.findMany({
    where: { org_id: organizationId, actor_id: { in: ids }, action: { in: [...SIGNED_IN_ACTIONS] } },
    select: { actor_id: true },
    distinct: ['actor_id'],
  });
  return new Set(rows.map((r) => r.actor_id!).filter(Boolean));
}

/** The people of the company who could become its Owner now: active Admins with a login, not erased, who have signed in. */
export async function ownerCandidates(db: Db, organizationId: string, ids: string[]): Promise<Set<string>> {
  if (ids.length === 0) return new Set();
  const admins = await db.user.findMany({
    where: { organization_id: organizationId, id: { in: ids }, is_admin: true, is_active: true, has_login: true, erased_at: null },
    select: { id: true },
  });
  return signedInAmong(db, organizationId, admins.map((a) => a.id));
}

const nameOf = (p: { first_name: string; last_name: string }) => `${p.first_name} ${p.last_name}`.trim();

export type RequestOutcome =
  | { kind: 'not_owner' }
  | { kind: 'not_found' }
  | { kind: 'not_a_candidate' }
  | { kind: 'sent'; emailSent: boolean; newOwnerName: string };

/**
 * Step 1: the Owner asks to hand the company to `targetId`. Nothing about who owns the company changes. Under the company lock:
 * the caller must be its Owner, the target one of its people (else not_found: a person of another company, or no one, answers
 * the same), and a candidate. Then the Owner's one live approval is replaced by this one and the link is mailed to the Owner.
 */
export async function requestOwnerHandover(args: { organizationId: string; actorId: string; targetId: string }): Promise<RequestOutcome> {
  const targetId = args.targetId.toLowerCase();
  if (!UUID.test(targetId)) return { kind: 'not_found' };
  const jti = randomBytes(24).toString('base64url');
  const exp = Math.floor(Date.now() / 1000) + OWNER_APPROVAL_TTL_SECONDS;

  const decided = await prisma.$transaction(async (tx) => {
    const ownerId = await lockCompanyForAdminChange(tx, args.organizationId);
    if (ownerId === null || ownerId !== args.actorId) return { kind: 'not_owner' as const };
    const target = await tx.user.findFirst({
      where: { id: targetId, organization_id: args.organizationId },
      select: { id: true, first_name: true, last_name: true },
    });
    if (!target) return { kind: 'not_found' as const };
    if (target.id === ownerId || !(await ownerCandidates(tx, args.organizationId, [target.id])).has(target.id)) {
      return { kind: 'not_a_candidate' as const };
    }
    const owner = await tx.user.findFirst({
      where: { id: ownerId, organization_id: args.organizationId },
      select: { email: true, first_name: true },
    });
    if (!owner) return { kind: 'not_owner' as const };
    // The one live approval: this request's. Any earlier link is dead from here on.
    await tx.user.update({ where: { id: ownerId }, data: { password_hash: handoverMarkFor(jti) } });
    return { kind: 'ok' as const, owner, target };
  });
  if (decided.kind !== 'ok') return decided;

  const token = signHandover({ org: args.organizationId, owner: args.actorId, to: decided.target.id, exp, jti });
  const approveUrl = `${env.FRONTEND_URL.replace(/\/+$/, '')}/approve-owner?token=${encodeURIComponent(token)}`;
  const newOwnerName = nameOf(decided.target);
  const emailSent = await sendOwnerApprovalEmail({
    to: decided.owner.email,
    ownerFirstName: decided.owner.first_name,
    newOwnerName,
    approveUrl,
    organizationId: args.organizationId,
  });
  if (!emailSent) {
    // No one has the link: take this request back, only if it is still the live one.
    await prisma.user.updateMany({ where: { id: args.actorId, password_hash: handoverMarkFor(jti) }, data: { password_hash: '' } });
  }
  return { kind: 'sent', emailSent, newOwnerName };
}

/** What the approval page shows before the Owner approves: who becomes the Owner of which company. Null for a dead link. */
export async function previewOwnerHandover(token: unknown): Promise<{ company_name: string; new_owner_name: string } | null> {
  const p = verifyHandover(token);
  if (!p) return null;
  const [org, owner, target] = await Promise.all([
    prisma.organization.findUnique({ where: { id: p.org }, select: { name: true, owner_user_id: true } }),
    prisma.user.findFirst({ where: { id: p.owner, organization_id: p.org }, select: { password_hash: true } }),
    prisma.user.findFirst({ where: { id: p.to, organization_id: p.org }, select: { first_name: true, last_name: true } }),
  ]);
  if (!org || org.owner_user_id !== p.owner || !owner || owner.password_hash !== handoverMarkFor(p.jti) || !target) return null;
  return { company_name: org.name, new_owner_name: nameOf(target) };
}

export type ApproveOutcome =
  | { kind: 'expired' }
  | { kind: 'not_a_candidate' }
  | { kind: 'moved'; company_name: string; new_owner_name: string };

/**
 * Step 2: the link is opened. One transaction under the company lock: the approver must still be the Owner and their row must
 * still hold this link's mark (used, replaced and cancelled links fail here), the new Owner must still be a candidate, then the
 * mark is used up, the Owner moves, and the one audit row is written. A failure anywhere rolls all of it back. The two emails go
 * after the commit.
 */
export async function approveOwnerHandover(token: unknown, actorMeta: Pick<AccessActor, 'ip' | 'userAgent'>): Promise<ApproveOutcome> {
  const p = verifyHandover(token);
  if (!p) return { kind: 'expired' };
  const mark = handoverMarkFor(p.jti);

  const decided = await prisma.$transaction(async (tx) => {
    const ownerId = await lockCompanyForAdminChange(tx, p.org);
    if (ownerId === null || ownerId !== p.owner) return { kind: 'expired' as const };
    const people = await tx.user.findMany({
      where: { organization_id: p.org, id: { in: [p.owner, p.to] } },
      select: { id: true, email: true, first_name: true, last_name: true, password_hash: true, is_active: true },
    });
    const owner = people.find((u) => u.id === p.owner);
    const target = people.find((u) => u.id === p.to);
    if (!owner || !owner.is_active || owner.password_hash !== mark || !target) return { kind: 'expired' as const };
    if (target.id === ownerId || !(await ownerCandidates(tx, p.org, [target.id])).has(target.id)) {
      return { kind: 'not_a_candidate' as const };
    }
    // Use the link up. Under the lock nothing else can have changed the mark since it was read, but the swap is still made on
    // the exact mark, so a link is never used twice whatever the isolation.
    const used = await tx.user.updateMany({ where: { id: owner.id, organization_id: p.org, password_hash: mark }, data: { password_hash: '' } });
    if (used.count !== 1) return { kind: 'expired' as const };
    const org = await tx.organization.update({ where: { id: p.org }, data: { owner_user_id: target.id }, select: { name: true } });
    await recordOwnerChange(tx, {
      organizationId: p.org,
      actor: { id: owner.id, email: owner.email, ip: actorMeta.ip, userAgent: actorMeta.userAgent },
      before: owner.id,
      after: target.id,
      by: 'make owner',
    });
    return { kind: 'moved' as const, org, owner, target };
  });
  if (decided.kind !== 'moved') return decided;

  const at = new Date();
  const newOwnerName = nameOf(decided.target);
  const previousOwnerName = nameOf(decided.owner);
  const results = await Promise.all([
    sendOwnerChangedEmail({
      to: decided.target.email, firstName: decided.target.first_name, for: 'new', newOwnerName, previousOwnerName, at, organizationId: p.org,
    }),
    sendOwnerChangedEmail({
      to: decided.owner.email, firstName: decided.owner.first_name, for: 'previous', newOwnerName, previousOwnerName, at, organizationId: p.org,
    }),
  ]);
  if (results.some((sent) => !sent)) logger.warn(`Owner change email not sent (org ${p.org})`, { new: results[0], previous: results[1] });
  return { kind: 'moved', company_name: decided.org.name, new_owner_name: newOwnerName };
}
