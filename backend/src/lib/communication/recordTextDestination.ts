/**
 * Where a text sent from a lead or a job goes (#3016; closes #2952's anchored path).
 *
 * A lead's or job's EFFECTIVE number is the record's changed number for the customer's primary, else the customer's
 * primary (4 October Q34): the number the record's contact card shows in the primary's place. For a send anchored on a
 * record, the server takes the destination from the record and never from the browser:
 *   - with no number named, the effective number;
 *   - a customer phone named: the record's changed number for it when the record changed it, else that phone;
 *   - a number only the record carries (one of its own phone entries): that number;
 *   - any other number: refused. The answer says nothing about who else might carry it.
 *
 * "Changed for" is decided the way the contact card draws it (CustomerContactBlock's `changedEntryFor`): a live CHANGED
 * phone entry whose customer value at the change has the same digits as the customer phone.
 *
 * The record must already be resolved under the sender's reach; this reads it by id within the company only. Automated
 * texts do not come here: they keep the customer record's own number (services/automations/smsRecord.ts, Q34).
 *
 * The same card gives the numbers whose texts the record's Communication tab lists (`recordTabNumbers`, #3022). That set is
 * wider than the numbers a text from the record may go to: it also holds a customer phone the record changed (Ran,
 * 2026-11-06), which a send never reaches because it goes to the changed number.
 */
import type { Prisma } from '@prisma/client';
import { normalizePhone } from '../customer-duplicate';
import { normalizeNAPhone } from '../comms-identity';
import { CUSTOMER_CONTACT_SET_SELECT, customerContactSet } from '../customer-contact-set';
import { liveEntries, type EntryRecord, type RecordContactEntryView } from '../record-contact-entries';

type Db = Pick<Prisma.TransactionClient, 'lead' | 'job' | 'recordContactEntry'>;

/** The record a text is sent from. */
export type TextAnchor = EntryRecord;

/** What a person is told when a text from a lead or a job names a number the record and its customer do not carry. The
 *  words say nothing about who else might carry the number (approved by Ran, 2026-11-05). */
export const NUMBER_NOT_ON_RECORD = {
  lead: 'You can only text the numbers on this lead',
  job: 'You can only text the numbers on this job',
} as const satisfies Record<TextAnchor['kind'], string>;

/** The destination, as E.164 where it normalizes (null when the record has no phone at all), or a refusal. */
export type RecordTextDestination = { ok: true; to: string | null } | { ok: false };

const asE164 = (raw: string | null | undefined): string | null => (raw ? (normalizeNAPhone(raw) ?? raw) : null);

/** The live CHANGED phone entry that stands in for this customer phone on the record, if any. */
function changedFor(entries: RecordContactEntryView[], customerPhone: string): RecordContactEntryView | undefined {
  const digits = normalizePhone(customerPhone);
  return entries.find(
    (e) => e.kind === 'PHONE' && e.intent === 'CHANGED' && e.customer_value_at_change !== null && normalizePhone(e.customer_value_at_change) === digits,
  );
}

/**
 * The record's phone card: its customer's phones, the record's own live phone entries, and how the card shows a customer
 * phone (the record's changed number in its place, else the phone itself). Two reads; null for a record not in the company.
 */
async function recordPhoneCard(db: Db, orgId: string, anchor: TextAnchor) {
  const where = { id: anchor.id, organization_id: orgId };
  const select = { customer: { select: CUSTOMER_CONTACT_SET_SELECT } } as const;
  const record = anchor.kind === 'job' ? await db.job.findFirst({ where, select }) : await db.lead.findFirst({ where, select });
  if (!record) return null;
  const phones = customerContactSet(record.customer ?? {}).phones;
  const entries = (await liveEntries(db, orgId, anchor)).filter((e) => e.kind === 'PHONE');
  const asShown = (customerPhone: string) => changedFor(entries, customerPhone)?.value ?? customerPhone;
  return { phones, entries, asShown };
}

/**
 * The numbers whose texts the record's Communication tab lists (#3022), as E.164: every phone number its contact card shows.
 * Each customer phone as the card shows it (a changed number in its place), each customer phone the record changed (the card
 * still shows it as "Customer record", Ran 2026-11-06), and every number the record carries as its own. Empty for a record not
 * in the company. Only the tab reads this; which numbers a text from the record may go to is `recordTextDestination`.
 */
export async function recordTabNumbers(db: Db, orgId: string, anchor: TextAnchor): Promise<string[]> {
  const card = await recordPhoneCard(db, orgId, anchor);
  if (!card) return [];
  const shown = [...card.phones.map((p) => card.asShown(p.phone)), ...card.entries.map((e) => e.value)];
  const replaced = card.phones.map((p) => p.phone).filter((phone) => card.asShown(phone) !== phone);
  return [...new Set([...shown, ...replaced].map((n) => normalizeNAPhone(n)).filter((n): n is string => n != null))];
}

/**
 * The destination of a text anchored on `anchor`. `named` is the number the browser named (a tapped number), or
 * null/undefined for "the record's number". Returns `{ ok: false }` for a named number the record and its customer do not
 * carry, and for a record that is not in the company.
 */
export async function recordTextDestination(
  db: Db,
  orgId: string,
  anchor: TextAnchor,
  named?: string | null,
): Promise<RecordTextDestination> {
  const card = await recordPhoneCard(db, orgId, anchor);
  if (!card) return { ok: false };
  const { phones, entries, asShown } = card;

  if (named == null) {
    const primary = phones.find((p) => p.is_primary) ?? phones[0];
    return { ok: true, to: primary ? asE164(asShown(primary.phone)) : null };
  }

  const digits = normalizePhone(named);
  if (!digits) return { ok: false };
  const customerPhone = phones.find((p) => normalizePhone(p.phone) === digits);
  if (customerPhone) return { ok: true, to: asE164(asShown(customerPhone.phone)) };
  const ownEntry = entries.find((e) => normalizePhone(e.value) === digits);
  if (ownEntry) return { ok: true, to: asE164(ownEntry.value) };
  return { ok: false };
}
