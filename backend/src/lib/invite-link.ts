import { createHash, randomBytes } from 'crypto';
import { prisma } from './prisma';
import { env } from '../config/env';
import { sendUserInviteEmail } from './email';
import { signInviteToken, type InvitePayload } from './invite-token';

/**
 * Invite links are single-use, and a person has at most one live invite (security finding H2).
 *
 * The link itself stays a signed, self-contained token (lib/invite-token.ts), but it now carries an id (`jti`), and the person's
 * row remembers which id is the live one: `users.password_hash` holds `invite:v1:<sha256 of that id>` while an invite is live.
 * That column is otherwise unused (sign-in lives at the identity provider; every writer sets it to ''), so no new storage is
 * needed, and every place that already ends someone's sign-in (revoke, deactivate, erase) already blanks it, which is exactly
 * "every invite link for that person is expired".
 *
 *  - issue (invite or resend): store the new id's hash, replacing the previous one, so the earlier link is expired at once;
 *  - use: a compare-and-swap that moves the mark to THIS link's own "used" sentinel (`invite:used:<hash>`) only if it still
 *    equals this link's live mark, so of any number of simultaneous uses exactly one wins;
 *  - a use whose account could not be made is undone by a compare-and-swap from that exact sentinel back to that link's live
 *    mark. Because the sentinel is per link, a late failure can never revive an older link, and because revoke, deactivate and
 *    erase blank the column, it can never undo them either;
 *  - a link is live only while the mark equals its id. A link without an id (every link minted before this change) is expired.
 *
 * Only the hash of the id is stored; the id and the token are never logged.
 */

const MARK_PREFIX = 'invite:v1:';

export const INVITE_EXPIRED_MESSAGE = 'This invitation link has expired. Ask your admin to send you a new invite.';
export const INVITE_EXPIRED_CODE = 'invite_expired';

/** The body every expired, used, cancelled or unknown link gets. It names no person and no company. */
export const INVITE_EXPIRED_BODY = { error: INVITE_EXPIRED_MESSAGE, code: INVITE_EXPIRED_CODE } as const;

const USED_PREFIX = 'invite:used:';
const hashOf = (jti: string) => createHash('sha256').update(jti).digest('hex');

export function inviteMarkFor(jti: string): string {
  return MARK_PREFIX + hashOf(jti);
}

/** What the column holds while this link is being used: not live, and not any other link's. */
export function inviteUsedMarkFor(jti: string): string {
  return USED_PREFIX + hashOf(jti);
}

/** Mint a new invite link token for this person and make it their one live invite. The earlier one is expired. */
export async function issueInviteToken(user: { id: string; email: string }): Promise<string> {
  const jti = randomBytes(24).toString('base64url');
  await prisma.user.update({ where: { id: user.id }, data: { password_hash: inviteMarkFor(jti) } });
  return signInviteToken(user.id, user.email, undefined, jti);
}

/** Is this link the person's live invite? `storedMark` is the person's `password_hash`. */
export function isLiveInvite(payload: Pick<InvitePayload, 'jti'>, storedMark: string | null | undefined): boolean {
  return Boolean(payload.jti) && Boolean(storedMark) && storedMark === inviteMarkFor(payload.jti!);
}

/** Use the link up. True for exactly one caller; false if it was already used, replaced or cancelled. */
export async function consumeInvite(userId: string, payload: Pick<InvitePayload, 'jti'>): Promise<boolean> {
  if (!payload.jti) return false;
  const { count } = await prisma.user.updateMany({
    where: { id: userId, password_hash: inviteMarkFor(payload.jti), has_login: true },
    data: { password_hash: inviteUsedMarkFor(payload.jti) },
  });
  return count === 1;
}

/** The account was made: the sentinel has done its job and the column goes back to empty. */
export async function finishInvite(userId: string, payload: Pick<InvitePayload, 'jti'>): Promise<void> {
  if (!payload.jti) return;
  await prisma.user.updateMany({
    where: { id: userId, password_hash: inviteUsedMarkFor(payload.jti) },
    data: { password_hash: '' },
  });
}

/**
 * The account could not be made (a provider failure): put THIS link back, only if the column still holds exactly this link's
 * sentinel. A newer link, a revoke, a deactivation or an erase has changed the column since, and then nothing is touched.
 */
export async function restoreInvite(userId: string, payload: Pick<InvitePayload, 'jti'>): Promise<void> {
  if (!payload.jti) return;
  await prisma.user.updateMany({
    where: { id: userId, password_hash: inviteUsedMarkFor(payload.jti), has_login: true, is_active: true },
    data: { password_hash: inviteMarkFor(payload.jti) },
  });
}

/**
 * The person has signed in and is set up: whatever invite is still out is finished. Every successful sign-in calls this (password,
 * two-step code, refresh, Google; ticket 22), so a link that answered "already set up" cannot outlive the person's first sign-in.
 * Returns whether a live invite was finished: the first sign-in after an invitation.
 */
export async function retireInvite(userId: string): Promise<boolean> {
  // Invite marks only: the column also holds Revoke's marks (user.controller revokeLogin), which a sign-in must never clear.
  const result = await prisma.user.updateMany({ where: { id: userId, password_hash: { startsWith: 'invite:' } }, data: { password_hash: '' } });
  return (result?.count ?? 0) > 0;
}

/**
 * Make the person's one live invite, build the address in it, and mail it. The one door every invitation goes through: an
 * admin's invite, a resend, and onboarding a new company's first admin. Returns the address too, for the copy-link fallback.
 */
export async function sendInviteLink(user: {
  id: string; email: string; first_name: string; organization_id: string;
}): Promise<{ inviteUrl: string; emailSent: boolean }> {
  const token = await issueInviteToken(user);
  const inviteUrl = `${env.FRONTEND_URL}/accept-invite?token=${encodeURIComponent(token)}`;
  const emailSent = await sendUserInviteEmail({
    to: user.email,
    firstName: user.first_name,
    inviteUrl,
    organizationId: user.organization_id,
  });
  return { inviteUrl, emailSent };
}
