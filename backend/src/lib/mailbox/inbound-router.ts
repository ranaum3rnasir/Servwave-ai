/**
 * The inbound mail router (PRD 10, M11b), database half: the real lookups behind the pure decision in inbound-router-core.ts.
 *
 * ONE ENTRY POINT per step of a received message, in the order the webhook needs them:
 *   1. `planInboundMail`  - from the event's recipients ALONE: which company, which mailbox or which token's conversation, or
 *      dropped. Runs before the body is fetched, so a message nobody here is expecting costs no fetch and stores no content.
 *   2. `persistInboundEmail` (lib/inbound-email.ts) - with the fetched body, places the message and returns one placement per
 *      stored copy: company, mailbox, conversation, and a state (delivered, needs review).
 *
 * Reads are indexed and bounded: the tokens in ONE read by primary key, the mailbox addresses in ONE read by the register's
 * unique local part, however many recipients the message has, and nothing at all when no recipient is on either domain.
 * Mailbox mail goes where the REGISTER says and nowhere else: the inbox directory's forwarding rules are never consulted.
 *
 * THE ONE PLACE A LEAVER'S ADDRESS HOOKS IN: `issuedMailboxes` below answers "which mailbox does this issued address
 * deliver to". When a deactivated person's mailbox is merged into the main one (S10.21), the address follows it here and
 * nowhere else; one handed to a person (S10.21) keeps delivering into itself, which that person holds.
 */
import type { PrismaClient } from '@prisma/client';
import { env } from '../../config/env';
import { isLiveReplyToken, type ReplyTokenRow } from '../reply-token';
import { mailboxDomain } from './register';
import { planInbound, type InboundPlan, type RegisteredMailbox, type RouterDomains, type RouterLookups } from './inbound-router-core';

type RouterDb = Pick<PrismaClient, 'replyToken' | 'mailboxAddress'>;

/** A live reply token with the mailbox its conversation sits in (null when the conversation is gone). */
export type RoutedToken = ReplyTokenRow & { thread: { mailbox_id: string | null } | null };

export type InboundRoute = InboundPlan<RoutedToken>;

/** This environment's two domains, read from configuration at the time of the call. */
export function routerDomains(): RouterDomains {
  return { replyDomain: env.EMAIL_REPLY_DOMAIN, mailboxDomain: mailboxDomain() };
}

async function issuedMailboxes(db: Pick<PrismaClient, 'mailboxAddress'>, localParts: string[]): Promise<RegisteredMailbox[]> {
  // One read of the register by its unique local part: the address row itself names the company and the mailbox. An address of
  // a mailbox that was merged into the main one (a leaver's, S10.21) delivers to the mailbox it was merged into; the address
  // row stays on the leaver's mailbox so whose address it was is never lost.
  const rows = await db.mailboxAddress.findMany({
    where: { local_part: { in: localParts }, kind: 'issued', organization_id: { not: null }, mailbox_id: { not: null } },
    select: { local_part: true, organization_id: true, mailbox_id: true, mailbox: { select: { merged_into_mailbox_id: true } } },
  });
  return rows.flatMap((row) => (row.organization_id && row.mailbox_id
    ? [{ localPart: row.local_part, organizationId: row.organization_id, mailboxId: row.mailbox?.merged_into_mailbox_id ?? row.mailbox_id }]
    : []));
}

function lookupsOn(db: RouterDb): RouterLookups<RoutedToken> {
  const tokenRows = (tokens: string[]) => db.replyToken.findMany({
    where: { token: { in: tokens } },
    include: { thread: { select: { mailbox_id: true } } },
  });
  return {
    liveTokens: async (tokens) => (await tokenRows(tokens)).filter(isLiveReplyToken),
    // Only reached when no live token and no mailbox address took the message, so it is one more read on a rare path.
    knownTokens: tokenRows,
    issuedAddresses: (localParts) => issuedMailboxes(db, localParts),
  };
}

/** Where a message addressed to these recipients goes; decided without its body. */
export function planInboundMail(db: RouterDb, recipients: string[]): Promise<InboundRoute> {
  return planInbound(recipients, routerDomains(), lookupsOn(db));
}

/**
 * Every recipient the delivery event names (the To, Cc and Bcc headers and the envelope), or null when the event carries no
 * recipient list at all. An event without one cannot be judged from the event, and is never dropped for that: the caller
 * fetches the message and judges it on its own recipients, so a change in the provider's payload shape cannot silently
 * lose a customer's mail.
 */
export function eventRecipients(data: unknown): string[] | null {
  const d = (data ?? {}) as Record<string, unknown>;
  if (!Array.isArray(d.to)) return null;
  return ['to', 'cc', 'bcc', 'received_for'].flatMap((key) =>
    Array.isArray(d[key]) ? (d[key] as unknown[]).filter((x): x is string => typeof x === 'string') : [],
  );
}
