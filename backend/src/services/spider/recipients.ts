/**
 * Spider's ONE recipient rule (#2619). Every channel - the in-app alert, the email and the text -
 * uses the list this returns, so the popup, the email and the text always agree.
 *
 *   1. The configured roles, users and the lead's owner.
 *   2. The company's Admins, if none are configured OR if the configured ones reach nobody for this
 *      lead after steps 3 and 4 (owner-only on an unowned lead, a chosen role with no active
 *      users, chosen people who cannot open the lead).
 *   3. Only users who can sign in (active, with a login).
 *   4. Only users who can see the lead (the same row check the bell applies), so no channel tells
 *      someone about a lead they could not open.
 *   5. Each person once.
 *
 * A lead never goes unwatched just because the chosen people miss it: the Admins are the backstop
 * (#2619). Only when nobody at all - not even an Admin - can sign in and open the lead does this
 * return an empty list; the sweep then claims nothing, so the lead can still alert once someone it
 * would reach exists.
 */
import type { PrismaClient, Prisma } from '@prisma/client';
import { filterRecipientsByAccess } from '../notifications/filterByAccess';
import type { SpiderRecipients } from './config';

export interface SpiderRecipient {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string | null;
}

type Db = PrismaClient | Prisma.TransactionClient;

const RECIPIENT_SELECT = { id: true, first_name: true, last_name: true, email: true, phone: true } as const;
const CAN_SIGN_IN = { is_active: true, has_login: true } as const;

export async function resolveSpiderRecipients(
  db: Db,
  args: { orgId: string; leadId: string; ownerId: string | null; recipients: SpiderRecipients },
): Promise<SpiderRecipient[]> {
  const { orgId, leadId, ownerId, recipients } = args;

  const anyOf: Prisma.UserWhereInput[] = [];
  if (recipients.roles.length > 0) anyOf.push({ role: { in: recipients.roles } });
  if (recipients.user_ids.length > 0) anyOf.push({ id: { in: recipients.user_ids } });
  if (recipients.lead_owner && ownerId) anyOf.push({ id: ownerId });

  if (anyOf.length > 0) {
    const users = await db.user.findMany({
      where: { organization_id: orgId, ...CAN_SIGN_IN, OR: anyOf },
      select: RECIPIENT_SELECT,
      orderBy: { id: 'asc' },
    });
    const reached = await keepThoseWhoCanSeeTheLead(users, orgId, leadId);
    if (reached.length > 0) return reached;
  }

  // Nobody configured, or the configured people reach nobody for this lead: the Admins.
  const admins = await db.user.findMany({
    where: { organization_id: orgId, ...CAN_SIGN_IN, role: 'ADMIN' },
    select: RECIPIENT_SELECT,
    orderBy: { id: 'asc' },
  });
  return keepThoseWhoCanSeeTheLead(admins, orgId, leadId);
}

async function keepThoseWhoCanSeeTheLead(
  users: SpiderRecipient[],
  orgId: string,
  leadId: string,
): Promise<SpiderRecipient[]> {
  if (users.length === 0) return users;
  const kept = new Set(await filterRecipientsByAccess('LEAD', leadId, users.map((u) => u.id), orgId));
  return users.filter((u) => kept.has(u.id));
}
