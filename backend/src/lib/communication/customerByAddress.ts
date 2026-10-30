/**
 * Which customer an email address belongs to (PRD 10, S10.20, "Customer link by address, automatically").
 *
 * Mail on a mailbox address links to a CUSTOMER by the sender's address, and mail a person sends links on its recipient's: this
 * is the one statement of how an address finds its customers. A customer's addresses are its primary address and the extra ones
 * it carries; they are compared lower-cased, as a customer must not go unmatched because their mail client capitalised their own
 * address. (Contacts keep no email address of their own that anything writes, so they take no part.)
 *
 * It is a link to a customer and nothing more: never a conversation, a job or a lead on the sender's word (those are a person's
 * to attach, under PRD 8's attach rule), and never made for mail whose sender check failed (the router holds that for review).
 *
 * One read, whatever the number of addresses: `customers (organization_id, lower(email))` and `customer_emails (lower(email))`
 * carry the expression indexes it uses (migration 20261012820000), so the cost of a message is one indexed lookup.
 */
import type { PrismaClient } from '@prisma/client';

type Db = Pick<PrismaClient, '$queryRaw'>;

// An apostrophe is a valid character in a local part (o'brien@...), so it stays in the match; the quotes that wrap an address are
// trimmed off the ends afterwards.
const ADDRESS = /[^\s<>,;"]+@[^\s<>,;"]+/g;

/** Every bare address in a header value or a recipient list ("Name <a@b.c>, d@e.f"), lower-cased and without repeats. */
export function addressesIn(value: string | null | undefined): string[] {
  if (!value) return [];
  const found = (value.match(ADDRESS) ?? []).map((a) => a.replace(/^'+|['.]+$/g, '').toLowerCase());
  return [...new Set(found)];
}

/** What one address matched: how many customers have it, and which one when it is exactly one. */
export interface AddressCustomers {
  count: number;
  /** Set only when exactly one customer has the address. */
  customerId: string | null;
}

/** For each address among `addresses` that some customer of the company has, the customers that have it. */
export async function customersByAddress(
  db: Db, organizationId: string, addresses: readonly string[],
): Promise<Map<string, AddressCustomers>> {
  const wanted = [...new Set(addresses.map((a) => a.trim().toLowerCase()).filter(Boolean))];
  const found = new Map<string, AddressCustomers>();
  if (wanted.length === 0) return found;
  const rows = await db.$queryRaw<{ addr: string; n: number; customer_id: string }[]>`
    WITH pairs AS (
      SELECT lower(c.email) AS addr, c.id AS customer_id
      FROM customers c
      WHERE c.organization_id = ${organizationId}::uuid AND lower(c.email) = ANY(${wanted}::text[])
      UNION
      SELECT lower(ce.email) AS addr, ce.customer_id
      FROM customer_emails ce JOIN customers c ON c.id = ce.customer_id
      WHERE c.organization_id = ${organizationId}::uuid AND lower(ce.email) = ANY(${wanted}::text[])
    )
    SELECT addr, count(*)::int AS n, min(customer_id::text) AS customer_id FROM pairs GROUP BY addr`;
  for (const r of rows) found.set(r.addr, { count: r.n, customerId: r.n === 1 ? r.customer_id : null });
  return found;
}

/**
 * The one customer a set of addresses names, or null: none of them is a customer's, an address is shared by several customers, or
 * they name different customers. A link is made only when there is no doubt about whose it is.
 */
export function soleCustomerOf(matches: ReadonlyMap<string, AddressCustomers>): string | null {
  const ids = new Set<string>();
  for (const m of matches.values()) {
    if (m.customerId === null) return null;
    ids.add(m.customerId);
  }
  return ids.size === 1 ? [...ids][0]! : null;
}

/** The customer a sender's address names, when it names exactly one; the router's one read for a received message. */
export async function customerOfSender(db: Db, organizationId: string, senderAddress: string | null): Promise<string | null> {
  if (!senderAddress) return null;
  return soleCustomerOf(await customersByAddress(db, organizationId, [senderAddress]));
}

/**
 * The customer a sent email's recipients name (PRD 10, S10.20: "sent mail links on its recipient's address"), or null when no
 * recipient is a customer's, an address is shared by several customers, or the recipients are different customers. One read.
 */
export async function customerOfRecipients(db: Db, organizationId: string, to: string | null | undefined): Promise<string | null> {
  return soleCustomerOf(await customersByAddress(db, organizationId, addressesIn(to)));
}

/**
 * Every customer of the company that has this address (the matches the picker offers when several do). Bounded: an address
 * shared by more customers than this is shared by too many for any list to be useful, and the picker searches within them.
 */
const MATCH_CAP = 1000;
export async function customerIdsWithAddress(db: Db, organizationId: string, address: string): Promise<string[]> {
  const wanted = address.trim().toLowerCase();
  if (!wanted) return [];
  const rows = await db.$queryRaw<{ id: string }[]>`
    SELECT c.id::text AS id FROM customers c
    WHERE c.organization_id = ${organizationId}::uuid AND lower(c.email) = ${wanted}
    UNION
    SELECT ce.customer_id::text FROM customer_emails ce JOIN customers c ON c.id = ce.customer_id
    WHERE c.organization_id = ${organizationId}::uuid AND lower(ce.email) = ${wanted}
    LIMIT ${MATCH_CAP}`;
  return rows.map((r) => r.id);
}

/** The columns of a stored email that say it is a received message whose customer link rests on an unchecked sender. */
export interface SenderLinkFacts {
  direction?: string | null;
  customer_id?: string | null;
  reply_token?: string | null;
  inbound_auth?: string | null;
}

/**
 * "Unverified sender" (PRD 10, S10.20): a received message on a mailbox address that is linked to a customer although the sender's
 * domain could not prove who sent it (no published policy, or no check available). The link is made anyway, so a forged sender
 * shows for what it is. A reply on a reply address is not this: the address itself vouches for who may answer.
 */
export function isUnverifiedSenderLink(row: SenderLinkFacts): boolean {
  return row.direction === 'in' && row.customer_id != null && row.reply_token == null
    && (row.inbound_auth === 'NO_POLICY' || row.inbound_auth === 'UNAVAILABLE');
}

/** The columns of a stored email that decide whether it is waiting for a customer to be picked. */
export interface ReceivedRowFacts extends SenderLinkFacts {
  id: string;
  from?: unknown;
  job_id?: string | null;
  lead_id?: string | null;
  vendor_id?: string | null;
  review_reason?: string | null;
}

/** The bare, lower-cased address a received message came from (`from` holds `{ name, email }`), or null. */
export function senderAddressOfRow(row: Pick<ReceivedRowFacts, 'from'>): string | null {
  const from = row.from;
  const email = from && typeof from === 'object' ? (from as { email?: unknown }).email : null;
  return typeof email === 'string' ? (addressesIn(email)[0] ?? null) : null;
}

/**
 * A message that arrived on a mailbox address and is tied to nothing: no customer, job, lead or vendor, and not held for review.
 * The only kind a person picks a customer for, and the only kind that can "match several customers".
 */
export function awaitsCustomer(row: ReceivedRowFacts): boolean {
  return row.direction === 'in' && row.customer_id == null && row.reply_token == null && row.review_reason == null
    && row.job_id == null && row.lead_id == null && row.vendor_id == null;
}

/**
 * Which of these messages are waiting for a customer AND come from an address that several customers have: the ones the screens
 * label "Matches several customers". One read for the whole page, however many messages, and none when no message is waiting.
 */
export async function awaitingSeveralCustomers(
  db: Db, organizationId: string, rows: readonly ReceivedRowFacts[],
): Promise<Set<string>> {
  const waiting = rows.filter(awaitsCustomer).map((row) => ({ id: row.id, address: senderAddressOfRow(row) }));
  const addresses = waiting.flatMap((w) => (w.address ? [w.address] : []));
  if (addresses.length === 0) return new Set();
  const matches = await customersByAddress(db, organizationId, addresses);
  return new Set(waiting.filter((w) => w.address && (matches.get(w.address)?.count ?? 0) > 1).map((w) => w.id));
}
