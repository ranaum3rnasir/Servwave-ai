/**
 * The inbound mail router's decision (PRD 10, M11b), taken from a message's RECIPIENTS alone, before its body is fetched.
 * Pure apart from the two lookups it is handed; lib/mailbox/inbound-router.ts supplies the real ones.
 *
 * Recipient order, first match wins:
 *   1. A recipient on the reply domain whose token still resolves: today's path (the conversation the customer answers).
 *   2. A recipient on THIS environment's mailbox domain that the register holds as an issued address: that mailbox, as a
 *      new conversation. One message to several of a company's addresses goes to each of their mailboxes once; a message
 *      is never stored under two companies, so the company of the first such recipient takes it and the rest are left out.
 *   3. A recipient on the reply domain whose token the table holds but no longer resolves (revoked or expired), with nothing
 *      else to take the message: held for review under the company's main mailbox (S10.18). The token names the company.
 *   4. Anything else (a reserved address such as no-reply, an address never issued, another environment's mailbox domain,
 *      a token the table has never held): dropped, never bounced. Nothing names a company to file it under.
 * Forwarding rules are not consulted: only the register decides the mailbox.
 */
import { isReservedLocalPart, parseMailboxAddress } from './address-core';
import { parseReplyAddressOn } from '../reply-token';

/** The two domains a message can be addressed on, both from this environment's configuration. */
export interface RouterDomains {
  replyDomain: string;
  mailboxDomain: string;
}

/**
 * How many distinct reply tokens, and how many distinct mailbox addresses, of one message are looked up. A message copying more company
 * addresses than this is not mail anyone wrote to a handful of colleagues; the rest are left out so each lookup stays
 * one bounded read.
 */
export const MAX_MAILBOX_CANDIDATES = 50;

export interface MailboxCandidate {
  localPart: string;
  /** The address as it will be recorded on the stored message: lowercase, bare. */
  address: string;
}

/** What a mailbox address resolves to in the register. */
export interface RegisteredMailbox {
  localPart: string;
  organizationId: string;
  mailboxId: string;
}

export interface MailboxDelivery {
  mailboxId: string;
  /** The address this mailbox was reached on. */
  address: string;
}

export type InboundPlan<T> =
  | { state: 'dropped' }
  | { state: 'token'; token: T }
  /** A reply address that no longer resolves: the row names the company, the message waits in its main mailbox's review list. */
  | { state: 'unresolved_token'; token: T }
  | { state: 'mailboxes'; organizationId: string; deliveries: MailboxDelivery[] };

/** The two reads the router makes, each ONE query however many recipients there are. */
export interface RouterLookups<T extends { token: string }> {
  /** The tokens among these that still resolve (not revoked, not expired). */
  liveTokens(tokens: string[]): Promise<T[]>;
  /** The tokens among these that the table holds, whether or not they still resolve: asked only when none of them did. */
  knownTokens(tokens: string[]): Promise<T[]>;
  /** The register's issued addresses among these local parts that belong to a mailbox of a company. */
  issuedAddresses(localParts: string[]): Promise<RegisteredMailbox[]>;
}

/** The bare, lowercase address inside `Name <addr>` or `addr`, or null when there is none. */
function bareAddress(raw: string): string | null {
  const angled = raw.match(/<([^>]*)>/);
  const address = (angled ? angled[1]! : raw).trim().toLowerCase();
  return address.includes('@') ? address : null;
}

/** The reply tokens and the mailbox addresses among the recipients, in the order they came, each once. */
export function recipientCandidates(
  recipients: string[],
  domains: RouterDomains,
): { tokens: string[]; mailboxes: MailboxCandidate[] } {
  const tokens: string[] = [];
  const mailboxes: MailboxCandidate[] = [];
  const seen = new Set<string>();
  for (const raw of recipients) {
    const token = parseReplyAddressOn(raw, domains.replyDomain);
    if (token) {
      if (!tokens.includes(token) && tokens.length < MAX_MAILBOX_CANDIDATES) tokens.push(token);
      continue;
    }
    const address = bareAddress(raw);
    const localPart = address ? parseMailboxAddress(address, domains.mailboxDomain) : null;
    // A reserved local part is never in the register as anyone's mailbox: it is dropped here without a read.
    if (!address || !localPart || isReservedLocalPart(localPart) || seen.has(localPart)) continue;
    if (mailboxes.length >= MAX_MAILBOX_CANDIDATES) continue;
    seen.add(localPart);
    mailboxes.push({ localPart, address });
  }
  return { tokens, mailboxes };
}

/** Where a message addressed to `recipients` goes. Reads nothing when no recipient could be ours. */
export async function planInbound<T extends { token: string }>(
  recipients: string[],
  domains: RouterDomains,
  lookups: RouterLookups<T>,
): Promise<InboundPlan<T>> {
  const candidates = recipientCandidates(recipients, domains);

  if (candidates.tokens.length > 0) {
    const live = await lookups.liveTokens(candidates.tokens);
    const byToken = new Map(live.map((row) => [row.token, row]));
    for (const token of candidates.tokens) {
      const row = byToken.get(token);
      if (row) return { state: 'token', token: row };
    }
  }

  if (candidates.mailboxes.length > 0) {
    const held = new Map(
      (await lookups.issuedAddresses(candidates.mailboxes.map((c) => c.localPart))).map((b) => [b.localPart, b]),
    );
    const reached = candidates.mailboxes.flatMap((c) => {
      const found = held.get(c.localPart);
      return found ? [{ organizationId: found.organizationId, mailboxId: found.mailboxId, address: c.address }] : [];
    });
    // Never under two companies: the company of the first recipient the register knows takes the message.
    const organizationId = reached[0]?.organizationId;
    if (organizationId) {
      const once = new Map<string, MailboxDelivery>();
      for (const r of reached) {
        if (r.organizationId === organizationId && !once.has(r.mailboxId)) once.set(r.mailboxId, { mailboxId: r.mailboxId, address: r.address });
      }
      // A fixed order, so a redelivery stores every copy under the same id.
      const deliveries = [...once.values()].sort((a, b) => (a.mailboxId < b.mailboxId ? -1 : a.mailboxId > b.mailboxId ? 1 : 0));
      return { state: 'mailboxes', organizationId, deliveries };
    }
  }

  // A reply address that once existed and no longer resolves: the customer replied in good faith, so a person decides.
  if (candidates.tokens.length > 0) {
    const known = new Map((await lookups.knownTokens(candidates.tokens)).map((row) => [row.token, row]));
    for (const token of candidates.tokens) {
      const row = known.get(token);
      if (row) return { state: 'unresolved_token', token: row };
    }
  }

  return { state: 'dropped' };
}
