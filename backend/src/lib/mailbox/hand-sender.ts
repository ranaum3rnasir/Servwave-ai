/**
 * Who an email written by hand goes out as (PRD 10, S10.11): the sender's own mailbox, never the company's, a
 * colleague's or a handed-over one. This file holds the two halves of that identity, shared by the dispatch
 * (lib/email.ts, the only authority on the From header) and by the compose surfaces' "Sending as" line, so the line
 * can never say something the header does not:
 *
 *   - the display name, "<sender's name> at <company name>", cleaned for a header;
 *   - the address, read from the register: the sender's own primary address, or nothing ("address needed").
 */
import type { PrismaClient } from '@prisma/client';
import { buildMailboxAddress } from './address-core';
import { mailboxDomain } from './register';

/** What a person without an address of their own is told when they try to send by hand (PRD 10, Q76), word for word. */
export const ADDRESS_NEEDED_MESSAGE =
  "You don't have an email address yet. An admin needs to set one before you can send email.";

/** What a hand-send route answers a person who has no address of their own to send from: refused, nothing sent, nothing stored. */
export const ADDRESS_NEEDED_REFUSAL = { status: 409, error: ADDRESS_NEEDED_MESSAGE, code: 'ADDRESS_NEEDED' } as const;

/** What a request is told when it names a mailbox other than the sender's own to send from. */
export const NOT_YOUR_ADDRESS_MESSAGE = 'You can only send email from your own address.';

/** The longest display name the From header carries; email.ts's cleaner cuts at the same length. */
export const MAX_SENDER_NAME_LENGTH = 64;

/** Leaves room in the display name for the company when a person has a very long name. */
const MAX_PERSON_NAME_LENGTH = 30;

/** Control characters (the CR and LF that would split a header) become spaces; runs of white space collapse. */
function tidy(value: string | null | undefined): string {
  return (value ?? '')
    // eslint-disable-next-line no-control-regex
    .replace(/[\x00-\x1F\x7F]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * A person's name as it may stand in a header. The name is typed by an admin, so besides the control characters it
 * loses everything that could open or close a quoted name, start an address or end a list: quotes, angle brackets,
 * commas, semicolons and backslashes.
 */
function cleanPersonName(first: string | null | undefined, last: string | null | undefined): string {
  return tidy(`${first ?? ''} ${last ?? ''}`.replace(/["<>,;\\]/g, ' ')).slice(0, MAX_PERSON_NAME_LENGTH).trim();
}

/**
 * The display name of a hand-written email: "<sender's name> at <company name>", at most MAX_SENDER_NAME_LENGTH long
 * (the company gives way before the person does). With only one half it is that half, and with neither it is empty,
 * which the header builder turns into the bare address.
 */
export function handDisplayName(
  person: { first_name?: string | null; last_name?: string | null },
  companyName: string | null | undefined,
): string {
  const who = cleanPersonName(person.first_name, person.last_name);
  const company = tidy(companyName);
  if (!who) return company.slice(0, MAX_SENDER_NAME_LENGTH).trim();
  if (!company) return who;
  const joined = `${who} at `;
  return `${joined}${company.slice(0, MAX_SENDER_NAME_LENGTH - joined.length)}`.trim();
}

/** What a hand send goes out as. */
export interface HandSender {
  mailboxId: string;
  /** The sender's own primary address, in full. */
  address: string;
  /** The display name that enters the From header, already clean. Empty when the person and the company have no name. */
  displayName: string;
}

/**
 * The person who pressed Send and the mailbox the send goes out from, as a caller hands them to the dispatch (the sender's
 * own mailbox: the dispatch resolves the address and the display name itself and refuses any other mailbox).
 */
export interface HandSenderRef {
  mailboxId: string;
  userId: string;
}

export type HandSenderResolution =
  | { ok: true; sender: HandSender }
  /** No mailbox, or one in "address needed": the person has no address to send from. */
  | { ok: false; reason: 'address_needed' };

/**
 * The sender's own mailbox as a hand send uses it: found by the PERSON, never by an id a caller names, so a request
 * cannot choose another mailbox. Merged mailboxes are skipped, as ownMailboxOf does. A mailbox without a primary address
 * (or an environment without a mailbox domain) is "address needed".
 */
export async function resolveHandSender(
  db: Pick<PrismaClient, 'mailbox'>,
  who: { organizationId: string; userId: string },
): Promise<HandSenderResolution> {
  const box = await db.mailbox.findFirst({
    where: { organization_id: who.organizationId, kind: 'user', user_id: who.userId, status: { not: 'merged' } },
    select: {
      id: true,
      addresses: { where: { is_primary: true }, take: 1, select: { local_part: true } },
      user: { select: { first_name: true, last_name: true } },
      organization: { select: { name: true } },
    },
  });
  const localPart = box?.addresses?.[0]?.local_part;
  const domain = mailboxDomain();
  if (!box || !localPart || !domain) return { ok: false, reason: 'address_needed' };
  return {
    ok: true,
    sender: {
      mailboxId: box.id,
      address: buildMailboxAddress(localPart, domain),
      displayName: handDisplayName(box.user ?? {}, box.organization?.name),
    },
  };
}

/**
 * The door of every send a person starts by hand from a record's page or list (an estimate, an invoice, the pickup ticket,
 * and a bulk send of either): the sender's own mailbox, or the refusal to answer when they have none. Read from the
 * signed-in person alone, so nothing a request says can choose another mailbox.
 */
export async function handSenderOrRefusal(
  db: Pick<PrismaClient, 'mailbox'>,
  req: { user?: { id: string; organization_id: string } },
): Promise<{ ok: true; sender: HandSender } | { ok: false; refusal: typeof ADDRESS_NEEDED_REFUSAL }> {
  const resolved = await resolveHandSender(db, { organizationId: req.user!.organization_id, userId: req.user!.id });
  return resolved.ok ? { ok: true, sender: resolved.sender } : { ok: false, refusal: ADDRESS_NEEDED_REFUSAL };
}
