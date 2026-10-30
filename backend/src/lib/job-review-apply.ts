import type { Prisma } from '@prisma/client';
import { CHOICE, type ReviewChoice } from './job-review-changeset';
import { CUSTOMER_CONTACT_ROWS_SELECT, CUSTOMER_NAME_SELECT } from './record-contact-entries';
import { customerContactSet } from './customer-contact-set';
import { normalizeEmail, normalizePhone } from './customer-duplicate';
import { deriveCustomerKind } from './customer-kind';
import { formatPhoneDisplay } from './phone-format';

/**
 * Applying one customer decision of an office review to the customer (Roles & Permissions, PRD 6, S06.12), the way the
 * PRD's table says. The job's contact entry (PRD 5) holds the value; the customer is written only here, and only when the
 * review is finished, in the transaction of that finish.
 *
 *  - Add to the customer: the phone or email goes on the customer as an extra, never as the primary. A value the customer
 *    already has (a phone by its digits, an email without regard to case) is not added a second time.
 *  - Update the customer: a phone or email replaces the value it was changed from, wherever the customer holds it (the
 *    primary or secondary column, or the lists). If that value is no longer on the customer the new one is added instead,
 *    and the outcome says so. A name or company name replaces whatever the customer holds now.
 *  - This job only: the customer is not touched.
 *
 * The reviewer needs Office review alone for this; the customer's own edit switch plays no part, because the review is
 * the one door for these changes (PRD 6, DR-07).
 */

export const OUTCOME = {
  ADDED: 'ADDED',
  REPLACED: 'REPLACED',
  /** Update asked, but the value it replaces is gone from the customer: the new value was added instead. */
  ADDED_INSTEAD: 'ADDED_INSTEAD',
  /** The customer already holds the value, so nothing was written. */
  ALREADY_ON_CUSTOMER: 'ALREADY_ON_CUSTOMER',
  KEPT_ON_JOB: 'KEPT_ON_JOB',
} as const;
export type Outcome = (typeof OUTCOME)[keyof typeof OUTCOME];

/** The job contact entry a decision is about, as stored by PRD 5. */
export interface DecidedEntry {
  kind: string;
  value: string;
  extension: string | null;
  label: string | null;
  /** The value the customer held when the job's value was set (a changed entry). */
  customer_value_at_change: string | null;
}

export interface AppliedDecision {
  outcome: Outcome;
  /** The customer's value that was replaced, or the one an Update looked for; null for an add. */
  old: string | null;
  new: string;
  /** What was written on the customer, by column or list; empty when the customer was left alone. */
  fields: string[];
}

type Tx = Pick<Prisma.TransactionClient, 'customer' | 'customerPhone' | 'customerEmail'>;

const CUSTOMER_SELECT = { ...CUSTOMER_CONTACT_ROWS_SELECT, ...CUSTOMER_NAME_SELECT } as const;

const NAME_COLUMN = { FIRST_NAME: 'first_name', LAST_NAME: 'last_name', COMPANY_NAME: 'company_name' } as const;
type NameKind = keyof typeof NAME_COLUMN;
const isNameKind = (kind: string): kind is NameKind => kind in NAME_COLUMN;

export const CONTACT_LABEL: Record<string, string> = {
  PHONE: 'Phone', EMAIL: 'Email', FIRST_NAME: 'First name', LAST_NAME: 'Last name', COMPANY_NAME: 'Company name',
};

/** A value as a sentence shows it: a phone formatted, anything else as it is. */
export const shown = (kind: string, value: string | null): string => (value === null ? '' : kind === 'PHONE' ? formatPhoneDisplay(value) : value);

const samePhone = (a: string | null | undefined, b: string | null | undefined) => normalizePhone(a) !== null && normalizePhone(a) === normalizePhone(b);
const sameEmail = (a: string | null | undefined, b: string | null | undefined) => normalizeEmail(a) !== null && normalizeEmail(a) === normalizeEmail(b);

export async function applyDecisionToCustomer(
  tx: Tx,
  args: { orgId: string; customerId: string; choice: ReviewChoice; entry: DecidedEntry },
): Promise<AppliedDecision> {
  const { orgId, customerId, choice, entry } = args;
  if (choice === CHOICE.THIS_JOB_ONLY || choice === CHOICE.NONE) {
    return { outcome: OUTCOME.KEPT_ON_JOB, old: null, new: entry.value, fields: [] };
  }
  // Read fresh for every decision: an earlier one in the same finish may have written to the customer.
  const customer = await tx.customer.findFirst({ where: { id: customerId, organization_id: orgId }, select: CUSTOMER_SELECT });
  if (!customer) return { outcome: OUTCOME.KEPT_ON_JOB, old: null, new: entry.value, fields: [] };

  if (isNameKind(entry.kind)) return applyName(tx, customerId, customer, entry, entry.kind);
  return entry.kind === 'PHONE' ? applyPhone(tx, customerId, customer, entry, choice) : applyEmail(tx, customerId, customer, entry, choice);
}

type CustomerRow = Prisma.CustomerGetPayload<{ select: typeof CUSTOMER_SELECT }>;

// ─── Names ─────────────────────────────────────────────

async function applyName(tx: Tx, customerId: string, customer: CustomerRow, entry: DecidedEntry, kind: NameKind): Promise<AppliedDecision> {
  const column = NAME_COLUMN[kind];
  const current = (customer[column] as string | null) ?? '';
  const next = entry.value;
  if (current.trim() === next.trim()) return { outcome: OUTCOME.ALREADY_ON_CUSTOMER, old: current, new: next, fields: [] };
  const effective = { first_name: customer.first_name, company_name: customer.company_name, [column]: next };
  await tx.customer.update({
    where: { id: customerId },
    data: {
      [column]: next,
      // The kind (person or company) is derived from the names, exactly as the customer's own edit derives it.
      ...(kind === 'FIRST_NAME' || kind === 'COMPANY_NAME' ? { kind: deriveCustomerKind(effective) } : {}),
    },
  });
  return { outcome: OUTCOME.REPLACED, old: current || null, new: next, fields: [column] };
}

// ─── Phones ────────────────────────────────────────────

async function addPhone(tx: Tx, customerId: string, customer: CustomerRow, entry: DecidedEntry, replaced: string | null): Promise<AppliedDecision> {
  if (customerContactSet(customer).phones.some((p) => samePhone(p.phone, entry.value))) {
    return { outcome: OUTCOME.ALREADY_ON_CUSTOMER, old: replaced, new: entry.value, fields: [] };
  }
  await tx.customerPhone.create({
    data: { customer_id: customerId, phone: entry.value, extension: entry.extension, label: entry.label, is_primary: false },
  });
  return { outcome: replaced ? OUTCOME.ADDED_INSTEAD : OUTCOME.ADDED, old: replaced, new: entry.value, fields: ['phones'] };
}

async function applyPhone(tx: Tx, customerId: string, customer: CustomerRow, entry: DecidedEntry, choice: ReviewChoice): Promise<AppliedDecision> {
  if (choice === CHOICE.ADD) return addPhone(tx, customerId, customer, entry, null);

  const was = entry.customer_value_at_change;
  const columns: Prisma.CustomerUpdateInput = {};
  const fields: string[] = [];
  if (was && samePhone(customer.phone, was)) { columns.phone = entry.value; columns.phone_ext = entry.extension; fields.push('phone'); }
  if (was && samePhone(customer.secondary_phone, was)) { columns.secondary_phone = entry.value; columns.secondary_phone_ext = entry.extension; fields.push('secondary_phone'); }
  const rows = was ? customer.phones.filter((p) => samePhone(p.phone, was)) : [];
  if (fields.length === 0 && rows.length === 0) return addPhone(tx, customerId, customer, entry, was);

  // The new number is already on the customer elsewhere: keep what is there rather than make it appear twice.
  const elsewhere = customerContactSet(customer).phones.some((p) => samePhone(p.phone, entry.value));
  if (elsewhere && !samePhone(was, entry.value)) return { outcome: OUTCOME.ALREADY_ON_CUSTOMER, old: was, new: entry.value, fields: [] };

  if (fields.length > 0) await tx.customer.update({ where: { id: customerId }, data: columns });
  for (const row of rows) await tx.customerPhone.update({ where: { id: row.id }, data: { phone: entry.value, extension: entry.extension } });
  if (rows.length > 0) fields.push('phones');
  return { outcome: OUTCOME.REPLACED, old: was, new: entry.value, fields };
}

// ─── Emails ────────────────────────────────────────────

async function addEmail(tx: Tx, customerId: string, customer: CustomerRow, entry: DecidedEntry, replaced: string | null): Promise<AppliedDecision> {
  if (customerContactSet(customer).emails.some((e) => sameEmail(e.email, entry.value))) {
    return { outcome: OUTCOME.ALREADY_ON_CUSTOMER, old: replaced, new: entry.value, fields: [] };
  }
  await tx.customerEmail.create({ data: { customer_id: customerId, email: entry.value, label: entry.label } });
  return { outcome: replaced ? OUTCOME.ADDED_INSTEAD : OUTCOME.ADDED, old: replaced, new: entry.value, fields: ['extra_emails'] };
}

async function applyEmail(tx: Tx, customerId: string, customer: CustomerRow, entry: DecidedEntry, choice: ReviewChoice): Promise<AppliedDecision> {
  if (choice === CHOICE.ADD) return addEmail(tx, customerId, customer, entry, null);

  const was = entry.customer_value_at_change;
  const primary = Boolean(was && sameEmail(customer.email, was));
  const rows = was ? customer.extra_emails.filter((e) => sameEmail(e.email, was)) : [];
  if (!primary && rows.length === 0) return addEmail(tx, customerId, customer, entry, was);

  const elsewhere = customerContactSet(customer).emails.some((e) => sameEmail(e.email, entry.value));
  if (elsewhere && !sameEmail(was, entry.value)) return { outcome: OUTCOME.ALREADY_ON_CUSTOMER, old: was, new: entry.value, fields: [] };

  const fields: string[] = [];
  if (primary) { await tx.customer.update({ where: { id: customerId }, data: { email: entry.value } }); fields.push('email'); }
  for (const row of rows) await tx.customerEmail.update({ where: { id: row.id }, data: { email: entry.value } });
  if (rows.length > 0) fields.push('extra_emails');
  return { outcome: OUTCOME.REPLACED, old: was, new: entry.value, fields };
}
