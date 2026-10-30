/**
 * priceMergeFields.ts - the merge fields (variables) that render an entity's price or carry the customer's private link,
 * and who they are hidden from (M4, ticket 35; Ran's ruling 2026-10-28).
 *
 * "See prices" hides price, cost and money FIELDS of platform records, and the variables that render one. An automation
 * email or text sent to a TEAMMATE who lacks See prices is built from the same merge context as the one the customer
 * gets, so `{{estimate.total}}` would put the estimate's total in their inbox and `{{estimate.link}}` would hand them the
 * customer's private page (which opens with no sign-in and shows every price). For that teammate those fields resolve to
 * '' - the way every merge field with nothing to say resolves, so the author's "If empty, fill with" applies as it does
 * anywhere else. The customer's own send is never touched, and neither is the text a person TYPED: only these variables.
 *
 * Message text is never scanned (the same ruling): an amount typed into the body of an automation stays as written.
 */

import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import { abilityForUser } from '../../lib/permissions/enforce';

/** Merge fields that render a price of an entity, or the customer's private link to it (a token that opens every price). */
export const PRICE_MERGE_FIELDS: readonly string[] = ['estimate.total', 'estimate.link', 'invoice.total', 'invoice.link'];

/**
 * Advertised merge fields whose name sounds like money or a link but which are neither, each with the reason. The guard
 * test reads every advertised field: one that sounds like money and is on neither list fails until a person decides it.
 */
export const NOT_PRICE_MERGE_FIELDS: Readonly<Record<string, string>> = {
  'invoice.due_date': 'a date',
  'task.due_date': 'a date',
  'task.link': 'a link into the staff app, which opens only for someone signed in',
};

/** The context a teammate without See prices is rendered with: every price field present but empty. */
export function withoutPriceFields(ctx: Record<string, string>): Record<string, string> {
  const out = { ...ctx };
  for (const field of PRICE_MERGE_FIELDS) if (Object.prototype.hasOwnProperty.call(out, field)) out[field] = '';
  return out;
}

export interface BlindStaff {
  /** Ids of teammates of the company who lack See prices. */
  ids: ReadonlySet<string>;
  /** Their login emails, lower case. */
  emails: ReadonlySet<string>;
}

/**
 * Which of these people - named by user id or by email address - are teammates of the company WITHOUT See prices. A person
 * who is not a teammate (the customer, an outside address typed into a step) is not in the answer: their send is left as
 * written. A teammate whose switches cannot be read is treated as lacking the switch (fail closed).
 */
export async function staffWithoutSeePrices(
  organizationId: string,
  who: { ids?: readonly string[]; emails?: readonly string[] },
): Promise<BlindStaff> {
  const ids = [...new Set(who.ids ?? [])];
  const emails = [...new Set((who.emails ?? []).map((e) => e.toLowerCase()))];
  const blindIds = new Set<string>();
  const blindEmails = new Set<string>();
  if (ids.length === 0 && emails.length === 0) return { ids: blindIds, emails: blindEmails };

  let users;
  try {
    users = await prisma.user.findMany({
      where: {
        organization_id: organizationId,
        OR: [
          ...(ids.length ? [{ id: { in: ids } }] : []),
          ...emails.map((email) => ({ email: { equals: email, mode: 'insensitive' as const } })),
        ],
      },
      select: {
        id: true, email: true, role: true, is_admin: true, organization_id: true, department_id: true, location_id: true,
        custom_role_id: true, custom_role: { select: { key: true } },
      },
    });
  } catch (err) {
    // Fail closed: when the company's people cannot be read, nobody asked about is known to see prices.
    logger.warn('[automations] could not read the recipients\' accounts; their send leaves prices out', { err });
    return { ids: new Set(ids), emails: new Set(emails) };
  }
  for (const user of users) {
    let sees = false;
    try {
      sees = (await abilityForUser(user)).can('read', 'Prices' as never);
    } catch (err) {
      logger.warn('[automations] could not read a teammate\'s switches; their send leaves prices out', { userId: user.id, err });
    }
    if (sees) continue;
    blindIds.add(user.id);
    if (user.email) blindEmails.add(user.email.toLowerCase());
  }
  return { ids: blindIds, emails: blindEmails };
}
