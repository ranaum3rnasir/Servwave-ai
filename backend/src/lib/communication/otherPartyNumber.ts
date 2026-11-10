// The other party's number a text row stores (messages.other_party_e164, #3014): the number of whoever the text went to
// or came from, normalized E.164. One rule for every writer (the send handler, the automation recorder, the incoming-text
// ingest and the fill-in of older texts): a number that is one of this organization's own lines is never the other
// party, so it is stored as none. Matched inside the organization only: another organization's line is a customer here.
import type { Prisma, PrismaClient } from '@prisma/client';
import { normalizeNAPhone } from '../comms-identity';

type Db = PrismaClient | Prisma.TransactionClient;

/** The rule: the number as normalized E.164, or null when it is not a phone number or is one of `ownNumbers`. */
export function otherPartyNumber(number: unknown, ownNumbers: ReadonlySet<string>): string | null {
  const e164 = number == null ? null : normalizeNAPhone(String(number));
  if (!e164) return null;
  return ownNumbers.has(e164) ? null : e164;
}

/** Every one of the organization's own numbers, normalized E.164: read once by a writer that handles many texts. */
export async function ownNumbersOf(db: Db, orgId: string): Promise<Set<string>> {
  const rows = await db.phoneNumber.findMany({ where: { organization_id: orgId }, select: { e164: true } });
  return new Set(rows.map((n) => normalizeNAPhone(n.e164) ?? n.e164));
}

/** The rule for a writer storing one text: reads only whether this one number is one of the organization's own. */
export async function otherPartyE164(db: Db, orgId: string, number: unknown): Promise<string | null> {
  // Normalized first (no number is ours yet), so only a real number is looked up among ours.
  const e164 = otherPartyNumber(number, new Set());
  if (!e164) return null;
  const ours = await db.phoneNumber.findUnique({
    where: { organization_id_e164: { organization_id: orgId, e164 } },
    select: { e164: true },
  });
  return otherPartyNumber(e164, new Set(ours ? [e164] : []));
}
