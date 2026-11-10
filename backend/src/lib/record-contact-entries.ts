/**
 * Record contact entries (Roles & Permissions, PRD 5): a job's (or a lead's) own copy of a customer detail.
 *
 * A person with the pencil adds a phone or email that belongs to ONE job or ONE lead; the customer row is never
 * written, and nothing that reads the customer (documents, public pages, send recipients, automated messages, the
 * lists) reads these. The job page and the lead page are the readers, through `liveJobEntries` and `liveLeadEntries`,
 * and so is the destination of a text a person sends from the job or the lead (#3016, communication/recordTextDestination).
 * The office review (PRD 6) reads the same rows to decide what reaches the customer, so the shape `presentEntry`
 * returns is a contract: the fields are pinned by a test.
 *
 * One reader outside the record pages, by decision (#3013 decision 1, #3015): the identity match (`matchByPhone`,
 * lib/comms-identity.ts) picks the customer for a phone number first by the one lead or job carrying that number as its
 * own. It reads the live phone entries through `livePhoneEntriesSql` below, so this module stays the only one that names
 * the table. The same module works out which customers carry a number (#3021, `carriersOfNumbers`, and the numbers one
 * customer carries, through `liveCustomerPhoneEntryValuesSql`).
 *
 * Entries are never hard-deleted: `removed_at` keeps the history whole, and "live" means not removed.
 */
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { requiredCustomerPhone } from './phone-schema';
import { normalizePhone } from './customer-duplicate';
import { CUSTOMER_CONTACT_SET_SELECT, customerContactSet, type ContactSetSource } from './customer-contact-set';
import { recordEntryCarried } from './record-contact-history';
import { DEFAULT_TIMEZONE } from './timezone';

type Db = Pick<Prisma.TransactionClient, 'recordContactEntry'>;

export const ENTRY_SELECT = {
  id: true,
  kind: true,
  intent: true,
  value: true,
  extension: true,
  label: true,
  overridden_field: true,
  overridden_row_id: true,
  customer_value_at_change: true,
  created_by_id: true,
  created_by_name: true,
  created_at: true,
  updated_by_id: true,
  updated_by_name: true,
  updated_at: true,
  source_entry_id: true,
} as const;

type EntryRow = Prisma.RecordContactEntryGetPayload<{ select: typeof ENTRY_SELECT }>;

/** One entry as the job and the lead detail and the office review read it. */
export interface RecordContactEntryView {
  id: string;
  kind: string;
  intent: string;
  value: string;
  extension: string | null;
  label: string | null;
  overridden_field: string | null;
  overridden_row_id: string | null;
  customer_value_at_change: string | null;
  created_by: { id: string | null; name: string | null };
  created_at: Date;
  updated_by: { id: string | null; name: string | null };
  updated_at: Date;
  source_entry_id: string | null;
}

export function presentEntry(row: EntryRow): RecordContactEntryView {
  return {
    id: row.id,
    kind: row.kind,
    intent: row.intent,
    value: row.value,
    extension: row.extension,
    label: row.label,
    overridden_field: row.overridden_field,
    overridden_row_id: row.overridden_row_id,
    customer_value_at_change: row.customer_value_at_change,
    created_by: { id: row.created_by_id, name: row.created_by_name },
    created_at: row.created_at,
    updated_by: { id: row.updated_by_id, name: row.updated_by_name },
    updated_at: row.updated_at,
    source_entry_id: row.source_entry_id,
  };
}

/** The record an entry belongs to: exactly one job or one lead. */
export type EntryRecord = { kind: 'job' | 'lead'; id: string };

/** The columns that tie an entry to its record (the table allows exactly one of the two). */
export const recordEntryKey = (record: EntryRecord) => (record.kind === 'job' ? { job_id: record.id } : { lead_id: record.id });

/**
 * The record's live entries, oldest first. A job's carried entries keep the lead entry's date, so two of them can share
 * it; they then follow the lead entry they came from, which is the order the lead lists them in (its own ids decide).
 */
export async function liveEntries(db: Db, orgId: string, record: EntryRecord): Promise<RecordContactEntryView[]> {
  const rows = await db.recordContactEntry.findMany({
    where: { organization_id: orgId, ...recordEntryKey(record), removed_at: null },
    select: ENTRY_SELECT,
    orderBy: [{ created_at: 'asc' }, { source_entry_id: 'asc' }, { id: 'asc' }],
  });
  return rows.map(presentEntry);
}

/** One live entry of a job, by id, or null when it is gone or was removed. The office review reads the entry it applies through this (PRD 6, S06.12). */
export async function findLiveJobEntry(db: Db, orgId: string, jobId: string, entryId: string): Promise<RecordContactEntryView | null> {
  const row = await db.recordContactEntry.findFirst({
    where: { id: entryId, organization_id: orgId, job_id: jobId, removed_at: null },
    select: ENTRY_SELECT,
  });
  return row ? presentEntry(row) : null;
}

/** The job's live entries, oldest first. */
export const liveJobEntries = (db: Db, orgId: string, jobId: string) => liveEntries(db, orgId, { kind: 'job', id: jobId });

/** The lead's live entries, oldest first. */
export const liveLeadEntries = (db: Db, orgId: string, leadId: string) => liveEntries(db, orgId, { kind: 'lead', id: leadId });

/**
 * The live PHONE entries of the company's leads and jobs whose value is one of `spellings`, as a subquery for a raw query:
 * one row per entry, with its id, its value (as stored), the entry it was carried from, its lead or its job (and job
 * number), that record's status (`lead_status` or `job_status`) and its customer. Phones
 * are stored as digits (`requiredCustomerPhone`), so the caller passes every spelling it accepts.
 */
export function livePhoneEntriesSql(orgId: string, spellings: string[]): Prisma.Sql {
  return Prisma.sql`
    SELECT e.id, e.value, e.source_entry_id, e.lead_id, e.job_id, oj.job_number, COALESCE(ol.customer_id, oj.customer_id) AS customer_id,
           ol.status::text AS lead_status, oj.status::text AS job_status
      FROM record_contact_entries e
      LEFT JOIN leads ol ON ol.id = e.lead_id
      LEFT JOIN jobs oj ON oj.id = e.job_id
     WHERE e.organization_id = ${orgId}::uuid AND e.kind = 'PHONE' AND e.removed_at IS NULL AND e.value = ANY(${spellings}::text[])`;
}

/**
 * #3021: the values (as stored) of the live PHONE entries of one customer's leads and jobs, as a subquery for a raw query
 * (`numbersCustomerCarries`, lib/comms-identity.ts: which conversations show on that customer's page).
 */
export function liveCustomerPhoneEntryValuesSql(orgId: string, customerId: string): Prisma.Sql {
  return Prisma.sql`
    SELECT e.value
      FROM record_contact_entries e
      LEFT JOIN leads l ON l.id = e.lead_id
      LEFT JOIN jobs j ON j.id = e.job_id
     WHERE e.organization_id = ${orgId}::uuid AND e.kind = 'PHONE' AND e.removed_at IS NULL
       AND COALESCE(l.customer_id, j.customer_id) = ${customerId}::uuid`;
}

// ─── Adding ────────────────────────────────────────────

const label = z
  .string()
  .trim()
  .max(50)
  .optional()
  .nullable()
  .transform((v) => (v ? v : null));

/** What the add endpoint accepts: a phone (stored as digits, like a customer's) or an email. */
export const addContactEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('PHONE'),
    value: requiredCustomerPhone,
    extension: z.string().trim().max(10).optional().nullable().transform((v) => (v ? v : null)),
    label,
  }),
  z.object({
    kind: z.literal('EMAIL'),
    value: z.string().trim().email('Enter a valid email address').max(254, 'Email is too long (maximum 254 characters)'),
    label,
  }),
]);

export type AddContactEntryInput = z.infer<typeof addContactEntrySchema>;

/** A value that cannot be added; `message` is plain words for the person. */
export class ContactEntryRefusal extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

const sameEmail = (a: string, b: string) => a.trim().toLowerCase() === b.trim().toLowerCase();

/**
 * Refuses (409) an added value that is already on the customer or already live on the record. A phone is compared by
 * its digits, an email without regard to case.
 */
export function refuseDuplicate(
  input: AddContactEntryInput,
  customer: ContactSetSource,
  live: { kind: string; value: string }[],
  record: 'job' | 'lead',
): void {
  const set = customerContactSet(customer);
  if (input.kind === 'PHONE') {
    const digits = normalizePhone(input.value);
    if (set.phones.some((p) => normalizePhone(p.phone) === digits)) {
      throw new ContactEntryRefusal('That number is already on this customer', 409);
    }
    if (live.some((e) => e.kind === 'PHONE' && normalizePhone(e.value) === digits)) {
      throw new ContactEntryRefusal(`That number is already on this ${record}`, 409);
    }
    return;
  }
  if (set.emails.some((e) => sameEmail(e.email, input.value))) {
    throw new ContactEntryRefusal('That email is already on this customer', 409);
  }
  if (live.some((e) => e.kind === 'EMAIL' && sameEmail(e.value, input.value))) {
    throw new ContactEntryRefusal(`That email is already on this ${record}`, 409);
  }
}

// ─── Changing a customer value for this record ────────────────────────────────

/** The customer columns and lists a change can name, with the row ids a list value is told apart by. */
export const CUSTOMER_CONTACT_ROWS_SELECT = {
  ...CUSTOMER_CONTACT_SET_SELECT,
  phones: {
    select: { id: true, phone: true, label: true, extension: true, is_primary: true },
    orderBy: { created_at: 'asc' as const },
  },
  extra_emails: {
    select: { id: true, email: true, label: true },
    orderBy: { created_at: 'asc' as const },
  },
} as const;

type CustomerRows = Omit<ContactSetSource, 'phones' | 'extra_emails'> & {
  phones?: { id: string; phone: string; label: string | null; extension: string | null; is_primary: boolean }[] | null;
  extra_emails?: { id: string; email: string; label: string | null }[] | null;
};

/** Which customer column or list row holds the value a change replaces, and what it holds there. */
export interface CustomerValueRef {
  field: 'phone' | 'secondary_phone' | 'customer_phones' | 'email' | 'extra_emails';
  rowId: string | null;
  value: string;
  extension: string | null;
  label: string | null;
}

/**
 * Finds the customer value a change replaces, in the order the customer's contact set reads them (the primary
 * columns first, then the lists), so the value a person saw once is the one found. A phone is told apart by its
 * digits, an email without regard to case. Null when the customer holds no such value.
 */
export function findCustomerValue(customer: CustomerRows, kind: 'PHONE' | 'EMAIL', replaces: string): CustomerValueRef | null {
  const set = customerContactSet(customer);
  if (kind === 'PHONE') {
    const digits = normalizePhone(replaces);
    const labelOf = (phone: string) => set.phones.find((p) => normalizePhone(p.phone) === normalizePhone(phone))?.label ?? null;
    const columns = [
      { field: 'phone', value: customer.phone, extension: customer.phone_ext },
      { field: 'secondary_phone', value: customer.secondary_phone, extension: customer.secondary_phone_ext },
    ] as const;
    for (const column of columns) {
      if (column.value && normalizePhone(column.value) === digits) {
        return { field: column.field, rowId: null, value: column.value, extension: column.extension || null, label: labelOf(column.value) };
      }
    }
    const row = customer.phones?.find((p) => normalizePhone(p.phone) === digits);
    return row ? { field: 'customer_phones', rowId: row.id, value: row.phone, extension: row.extension || null, label: row.label } : null;
  }
  if (customer.email && sameEmail(customer.email, replaces)) {
    return { field: 'email', rowId: null, value: customer.email, extension: null, label: null };
  }
  const row = customer.extra_emails?.find((e) => sameEmail(e.email, replaces));
  return row ? { field: 'extra_emails', rowId: row.id, value: row.email, extension: null, label: row.label } : null;
}

/** What the change endpoint accepts: the customer value being replaced, and what it becomes on this record. */
export const changeContactEntrySchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('PHONE'),
    replaces: z.string().trim().min(1).max(50),
    value: requiredCustomerPhone,
    extension: z.string().trim().max(10).optional().nullable().transform((v) => (v ? v : null)),
    label,
  }),
  z.object({
    kind: z.literal('EMAIL'),
    replaces: z.string().trim().min(1).max(255),
    value: z.string().trim().email('Enter a valid email address').max(254, 'Email is too long (maximum 254 characters)'),
    label,
  }),
]);

export type ChangeContactEntryInput = z.infer<typeof changeContactEntrySchema>;

/**
 * Refuses (409) a change that is no change, a value the customer already holds elsewhere, a value already live on the
 * record, or a customer value this record already replaced. A new extension on the same number is a change.
 */
export function refuseChange(
  input: ChangeContactEntryInput,
  replaced: CustomerValueRef,
  customer: CustomerRows,
  live: { kind: string; value: string; intent: string; customer_value_at_change: string | null }[],
  record: 'job' | 'lead',
): void {
  const isPhone = input.kind === 'PHONE';
  const noun = isPhone ? 'number' : 'email';
  const same = isPhone ? normalizePhone(input.value) === normalizePhone(replaced.value) : sameEmail(input.value, replaced.value);
  if (same && (!isPhone || (input.extension ?? '') === (replaced.extension ?? ''))) {
    throw new ContactEntryRefusal(`No change: that is already this customer's ${noun}`, 409);
  }
  const already = live.some(
    (e) =>
      e.intent === 'CHANGED' &&
      e.kind === input.kind &&
      e.customer_value_at_change !== null &&
      (isPhone ? normalizePhone(e.customer_value_at_change) === normalizePhone(replaced.value) : sameEmail(e.customer_value_at_change, replaced.value)),
  );
  if (already) throw new ContactEntryRefusal(`That ${noun} is already changed on this ${record}`, 409);
  // The same number with a new extension is the customer's own number; any other value is checked like an added one.
  if (same) return;
  refuseDuplicate(input, customer, live, record);
}

// ─── Changing the customer's name or company for this record ───────────────────

/** The name kinds and what each is called to the person, in the customer form's own length limits. */
const NAME_KINDS = {
  FIRST_NAME: { field: 'first_name', noun: 'first name', max: 100, empty: 'Enter a name' },
  LAST_NAME: { field: 'last_name', noun: 'last name', max: 100, empty: 'Enter a name' },
  COMPANY_NAME: { field: 'company_name', noun: 'company name', max: 200, empty: 'Enter a company name' },
} as const;

type NameKind = keyof typeof NAME_KINDS;

const nameValue = (kind: NameKind) => z.string().trim().min(1, NAME_KINDS[kind].empty).max(NAME_KINDS[kind].max);

/** The customer columns a name change reads. */
export const CUSTOMER_NAME_SELECT = { first_name: true, last_name: true, company_name: true } as const;

/** What the name endpoint accepts: which of the three names, and what it becomes on this record. */
export const changeNameSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('FIRST_NAME'), value: nameValue('FIRST_NAME') }),
  z.object({ kind: z.literal('LAST_NAME'), value: nameValue('LAST_NAME') }),
  z.object({ kind: z.literal('COMPANY_NAME'), value: nameValue('COMPANY_NAME') }),
]);

export type ChangeNameInput = z.infer<typeof changeNameSchema>;

/**
 * Refuses (409) a name that is the customer's own, or a name already changed on this record (correct that entry
 * instead). Returns the customer column and the value it holds, which the entry records. A customer with no company
 * name holds the empty string.
 */
export function checkNameChange(
  input: ChangeNameInput,
  customer: { first_name: string | null; last_name: string | null; company_name: string | null },
  live: { kind: string }[],
  record: 'job' | 'lead',
): { field: string; customerValue: string } {
  const { field, noun } = NAME_KINDS[input.kind];
  const customerValue = (customer[field] ?? '').trim();
  if (input.value === customerValue) throw new ContactEntryRefusal(`No change: that is already this customer's ${noun}`, 409);
  if (live.some((e) => e.kind === input.kind)) throw new ContactEntryRefusal(`That ${noun} is already changed on this ${record}`, 409);
  return { field, customerValue };
}

// ─── Correcting and removing an entry ──────────────────────────────────────────

/** The kinds of entry a record can hold. A name or company entry is written by the slice that adds those pencils. */
export type EntryKind = 'PHONE' | 'EMAIL' | 'FIRST_NAME' | 'LAST_NAME' | 'COMPANY_NAME';

/** Phones and emails are the "contact details" the Edit job and lead contact details switch covers; names are not. */
export const isContactDetailKind = (kind: string): boolean => kind === 'PHONE' || kind === 'EMAIL';

/**
 * What the correct endpoint accepts: any of the entry's value, extension or label. What the value must look like
 * depends on the entry's kind, which only the stored entry knows, so `correctedValue` checks it.
 */
export const correctContactEntrySchema = z
  .object({
    value: z.string().trim().min(1, 'Enter a value').max(255).optional(),
    extension: z.string().trim().max(10).nullable().optional(),
    label: z.string().trim().max(50).nullable().optional(),
  })
  .refine((b) => b.value !== undefined || b.extension !== undefined || b.label !== undefined, 'Change the value or the label');

export type CorrectContactEntryInput = z.infer<typeof correctContactEntrySchema>;

/** The corrected value as it is stored (a phone as digits), or a plain 400 for one the kind does not accept. */
function correctedValue(kind: EntryKind, raw: string): string {
  const parsed =
    kind === 'PHONE'
      ? requiredCustomerPhone.safeParse(raw)
      : kind === 'EMAIL'
        ? z.string().trim().email('Enter a valid email address').safeParse(raw)
        : nameValue(kind).safeParse(raw);
  if (!parsed.success) throw new ContactEntryRefusal(parsed.error.errors[0]?.message ?? 'Enter a valid value', 400);
  return parsed.data;
}

/** An entry as the correct and remove endpoints read it. */
export type StoredEntry = Pick<EntryRow, 'id' | 'kind' | 'intent' | 'value' | 'extension' | 'label' | 'overridden_field' | 'overridden_row_id' | 'customer_value_at_change'>;

export interface Correction {
  value: string;
  extension: string | null;
  label: string | null;
  /** False when the correction leaves the entry exactly as it was. */
  changed: boolean;
  /** True when the value or extension moved, which is when the duplicate checks apply. */
  valueMoved: boolean;
}

const sameValue = (kind: string, a: string, b: string) =>
  kind === 'PHONE' ? normalizePhone(a) === normalizePhone(b) : kind === 'EMAIL' ? sameEmail(a, b) : a === b;

/**
 * What the entry becomes under a correction, checked the way the add and the change check a value: a valid value of
 * its kind, not one the customer or the record already holds, and for a changed entry not the customer's own value.
 * `others` are the record's other live entries, so an entry never counts as a duplicate of itself.
 */
export function applyCorrection(
  entry: StoredEntry,
  input: CorrectContactEntryInput,
  customer: CustomerRows,
  others: { kind: string; value: string; intent: string; customer_value_at_change: string | null }[],
  record: 'job' | 'lead',
): Correction {
  const kind = entry.kind as EntryKind;
  const value = input.value !== undefined ? correctedValue(kind, input.value) : entry.value;
  const extension = kind === 'PHONE' ? (input.extension !== undefined ? input.extension || null : entry.extension) : null;
  const label = input.label !== undefined ? input.label || null : entry.label;
  const valueMoved = !sameValue(kind, value, entry.value) || (extension ?? '') !== (entry.extension ?? '');
  const changed = valueMoved || value !== entry.value || label !== entry.label;
  if (valueMoved && !isContactDetailKind(kind) && entry.intent === 'CHANGED' && entry.customer_value_at_change === value) {
    throw new ContactEntryRefusal(`No change: that is already this customer's ${NAME_KINDS[kind as NameKind].noun}`, 409);
  }
  if (valueMoved && isContactDetailKind(kind)) {
    if (entry.intent === 'CHANGED' && entry.customer_value_at_change !== null) {
      const replaced = findCustomerValue(customer, kind as 'PHONE' | 'EMAIL', entry.customer_value_at_change) ?? {
        field: entry.overridden_field as CustomerValueRef['field'],
        rowId: entry.overridden_row_id,
        value: entry.customer_value_at_change,
        extension: null,
        label: null,
      };
      refuseChange(
        (kind === 'PHONE' ? { kind, replaces: replaced.value, value, extension, label } : { kind: 'EMAIL', replaces: replaced.value, value, label }) as ChangeContactEntryInput,
        replaced,
        customer,
        others,
        record,
      );
    } else {
      refuseDuplicate(
        (kind === 'PHONE' ? { kind, value, extension, label } : { kind: 'EMAIL', value, label }) as AddContactEntryInput,
        customer,
        others,
        record,
      );
    }
  }
  return { value, extension, label, changed, valueMoved };
}

// ─── Carrying a lead's entries onto the job at conversion ──────────────────────

/**
 * Copies the lead's LIVE entries onto the job it was converted into (PRD 5, S05.15), in the transaction that creates the
 * job, so no conversion lands without them. Every conversion path calls this one function.
 *
 * Each job entry keeps the lead entry's kind, intent, value, extension, label, overridden customer field or row, author
 * and dates, and points back at it (`source_entry_id`). The job's history gets one event per entry that names the lead
 * entry's author and date (`recordEntryCarried`). This is not a person's edit: it is not checked against the converter's
 * switches and nothing about the converter is written. A removed lead entry is not carried, and the lead keeps all of its
 * own entries untouched.
 *
 * Safe to run twice for the same job: a lead entry already carried onto it (live or since removed from the job) is
 * skipped, so a retry never doubles an entry nor brings back one the office took off the job.
 * Returns the job entries it created.
 */
export async function carryLeadEntriesToJob(
  db: Pick<Prisma.TransactionClient, 'recordContactEntry' | 'timelineEvent' | 'organization'>,
  args: { orgId: string; leadId: string; jobId: string },
): Promise<RecordContactEntryView[]> {
  const { orgId, leadId, jobId } = args;
  const fromLead = await db.recordContactEntry.findMany({
    where: { organization_id: orgId, lead_id: leadId, removed_at: null },
    select: ENTRY_SELECT,
    orderBy: [{ created_at: 'asc' }, { id: 'asc' }],
  });
  if (fromLead.length === 0) return [];

  const already = await db.recordContactEntry.findMany({
    where: { organization_id: orgId, job_id: jobId, source_entry_id: { in: fromLead.map((e) => e.id) } },
    select: { source_entry_id: true },
  });
  const carriedIds = new Set(already.map((e) => e.source_entry_id));
  const toCarry = fromLead.filter((e) => !carriedIds.has(e.id));
  if (toCarry.length === 0) return [];

  const org = await db.organization.findUnique({ where: { id: orgId }, select: { timezone: true } });
  const timeZone = org?.timezone || DEFAULT_TIMEZONE;

  const carried: RecordContactEntryView[] = [];
  for (const entry of toCarry) {
    const created = await db.recordContactEntry.create({
      data: {
        organization_id: orgId,
        job_id: jobId,
        kind: entry.kind,
        intent: entry.intent,
        value: entry.value,
        extension: entry.extension,
        label: entry.label,
        overridden_field: entry.overridden_field,
        overridden_row_id: entry.overridden_row_id,
        customer_value_at_change: entry.customer_value_at_change,
        created_by_id: entry.created_by_id,
        created_by_name: entry.created_by_name,
        created_at: entry.created_at,
        updated_by_id: entry.updated_by_id,
        updated_by_name: entry.updated_by_name,
        updated_at: entry.updated_at,
        source_entry_id: entry.id,
      },
      select: ENTRY_SELECT,
    });
    carried.push(presentEntry(created));
    await recordEntryCarried(db, { type: 'JOB', id: jobId }, orgId, {
      id: created.id,
      kind: entry.kind as EntryKind,
      intent: entry.intent as 'ADDED' | 'CHANGED',
      current: { value: entry.value, extension: entry.extension, label: entry.label },
      replaced: entry.intent === 'CHANGED' ? { value: entry.customer_value_at_change ?? '', extension: null, label: null } : null,
      sourceEntryId: entry.id,
      author: { id: entry.created_by_id, name: entry.created_by_name },
      authoredAt: entry.created_at,
      timeZone,
    });
  }
  return carried;
}
