/**
 * The history of a record's own contact entries (Roles & Permissions, PRD 5): one TimelineEvent on the JOB or the LEAD
 * for every phone or email added, every customer value replaced, every entry corrected and every entry removed, whoever
 * holds the pencil (S05.7 to S05.10 on a job, S05.13 on a lead).
 *
 * A job's and a lead's entries are one storage and one kind of history, so the writers are shared and only the record
 * differs: the entity the event hangs on, its event types, and the word the description uses ("for this job only" /
 * "for this lead only"). Each event carries `{ entry_id, kind, intent, old, new }` in its metadata, `old` null for an
 * add and `new` null for a removal; the office review (PRD 6) reads the job's.
 *
 * Writers pass the transaction client of the write itself, so the event and the entry commit or roll back together.
 */
import { randomUUID } from 'crypto';
import type { Prisma } from '@prisma/client';
import { formatPhoneDisplay } from './phone-format';
import type { JobChangeActor } from './job-change-history';
import { returnToReviewOnUnusualChange } from './job-review-return';
import { queueReviewAttention } from '../services/notifications/reviewAttentionQueue';

/** The transaction's client: the event and, for a job in Ready to close, the move back to Office review (S06.20) are written on it. */
type Db = Pick<Prisma.TransactionClient, 'timelineEvent' | 'job' | 'jobReview'>;

/** The record an entry belongs to, and so the one whose timeline the event lands on. */
export type ContactRecord = { type: 'JOB' | 'LEAD'; id: string };

/** S05.7 to S05.9: a job-only phone or email added, a customer's replaced, an entry corrected or removed, with the pencil. */
export const JOB_CONTACT_EVENT = {
  ENTRY_ADDED: 'JOB_CONTACT_ENTRY_ADDED',
  ENTRY_CHANGED: 'JOB_CONTACT_ENTRY_CHANGED',
  ENTRY_CORRECTED: 'JOB_CONTACT_ENTRY_CORRECTED',
  ENTRY_REMOVED: 'JOB_CONTACT_ENTRY_REMOVED',
} as const;

/** S05.13: the same four events on a lead's own timeline. */
export const LEAD_CONTACT_EVENT = {
  ENTRY_ADDED: 'LEAD_CONTACT_ENTRY_ADDED',
  ENTRY_CHANGED: 'LEAD_CONTACT_ENTRY_CHANGED',
  ENTRY_CORRECTED: 'LEAD_CONTACT_ENTRY_CORRECTED',
  ENTRY_REMOVED: 'LEAD_CONTACT_ENTRY_REMOVED',
} as const;

const EVENTS = { JOB: JOB_CONTACT_EVENT, LEAD: LEAD_CONTACT_EVENT } as const;
const WORD = { JOB: 'job', LEAD: 'lead' } as const;

/** What a contact entry history event records about the value. */
export interface ContactEntryValue {
  value: string;
  extension: string | null;
  label: string | null;
}

/** The kinds of entry a change, a correction or a removal can name. */
type ContactEntryKind = 'PHONE' | 'EMAIL' | 'FIRST_NAME' | 'LAST_NAME' | 'COMPANY_NAME';

export type ContactEntryAdded = { id: string; kind: 'PHONE' | 'EMAIL'; intent: 'ADDED' } & ContactEntryValue;
export type ContactEntryChanged = { id: string; kind: ContactEntryKind; intent: 'CHANGED'; old: ContactEntryValue; new: ContactEntryValue };
export type ContactEntryCorrected = { id: string; kind: ContactEntryKind; intent: 'ADDED' | 'CHANGED'; old: ContactEntryValue; new: ContactEntryValue };
export type ContactEntryRemoved = {
  id: string;
  kind: ContactEntryKind;
  intent: 'ADDED' | 'CHANGED';
  old: ContactEntryValue;
  restoredCustomerValue: string | null;
};

/** A lead entry carried onto the job at conversion (S05.15): what it holds now, and who wrote it on the lead and when. */
export type ContactEntryCarried = {
  id: string;
  kind: ContactEntryKind;
  intent: 'ADDED' | 'CHANGED';
  /** What the entry holds. */
  current: ContactEntryValue;
  /** For a changed entry, the customer value it replaces (empty value when the customer held none); null for an add. */
  replaced: ContactEntryValue | null;
  sourceEntryId: string;
  author: { id: string | null; name: string | null };
  authoredAt: Date;
  /** The company's time zone: the date the sentence names is the company's own day. */
  timeZone: string;
};

const CONTACT_KIND_LABEL: Record<ContactEntryKind, string> = {
  PHONE: 'Phone',
  EMAIL: 'Email',
  FIRST_NAME: 'First name',
  LAST_NAME: 'Last name',
  COMPANY_NAME: 'Company name',
};

const showContactValue = (kind: ContactEntryKind, value: string) => (kind === 'PHONE' ? formatPhoneDisplay(value) : value);

/** An entry as the sentence reads it: a phone keeps its extension ("ext. 12"), so a change of extension alone still shows. */
const showContactEntry = (kind: ContactEntryKind, entry: ContactEntryValue) =>
  `${showContactValue(kind, entry.value)}${kind === 'PHONE' && entry.extension ? ` ext. ${entry.extension}` : ''}`;

type EventDb = Pick<Prisma.TransactionClient, 'timelineEvent'>;

async function writeEvent(
  db: EventDb,
  actor: JobChangeActor,
  record: ContactRecord,
  eventType: string,
  description: string,
  metadata: Record<string, unknown>,
): Promise<string> {
  const id = randomUUID();
  await db.timelineEvent.create({
    data: {
      id,
      organization_id: actor.orgId,
      entity_type: record.type,
      entity_id: record.id,
      event_type: eventType,
      description,
      metadata: metadata as Prisma.InputJsonValue,
      created_by: actor.userId,
    },
  });
  return id;
}

/** A person's edit: the event, then (S06.20) the move back to Office review when it lands on a job in Ready to close. A lead has no review. */
async function write(
  db: Db,
  actor: JobChangeActor,
  record: ContactRecord,
  eventType: string,
  description: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  const entryId = await writeEvent(db, actor, record, eventType, description, metadata);
  if (record.type === 'JOB') {
    await returnToReviewOnUnusualChange(db, { orgId: actor.orgId, actorId: actor.userId, jobId: record.id, change: { id: entryId, event_type: eventType, description, metadata } });
    // S06.24: on a Done job every detail change of the customer on it raises the attention alert (the job stays Done).
    queueReviewAttention({
      orgId: actor.orgId, actorId: actor.userId, jobId: record.id, onlyIfDone: true,
      items: [{ reason: 'A customer detail changed', title: CONTACT_KIND_LABEL[String(metadata.kind) as keyof typeof CONTACT_KIND_LABEL] ?? 'Customer detail' }],
    });
  }
}

/** One event when a phone or email is added to the record. `old` is null for an add. */
export async function recordEntryAdded(db: Db, actor: JobChangeActor, record: ContactRecord, entry: ContactEntryAdded): Promise<void> {
  const shown = showContactEntry(entry.kind, entry);
  await write(db, actor, record, EVENTS[record.type].ENTRY_ADDED, `${CONTACT_KIND_LABEL[entry.kind]} ${shown} added for this ${WORD[record.type]} only`, {
    entry_id: entry.id,
    kind: entry.kind,
    intent: entry.intent,
    old: null,
    new: { value: entry.value, extension: entry.extension, label: entry.label },
  });
}

/**
 * One event when a customer's phone, email, name or company name is replaced for the record. `old` is the customer's
 * value (empty when the customer held none, which reads "set to").
 */
export async function recordEntryChanged(db: Db, actor: JobChangeActor, record: ContactRecord, entry: ContactEntryChanged): Promise<void> {
  const noun = CONTACT_KIND_LABEL[entry.kind];
  const only = `for this ${WORD[record.type]} only`;
  const to = showContactEntry(entry.kind, entry.new);
  const text = entry.old.value
    ? `${noun} ${showContactEntry(entry.kind, entry.old)} changed to ${to} ${only}`
    : `${noun} set to ${to} ${only}`;
  await write(db, actor, record, EVENTS[record.type].ENTRY_CHANGED, text, {
    entry_id: entry.id,
    kind: entry.kind,
    intent: entry.intent,
    old: entry.old,
    new: entry.new,
  });
}

/** One event when an entry's value, extension or label is corrected, by whoever holds the pencil. */
export async function recordEntryCorrected(db: Db, actor: JobChangeActor, record: ContactRecord, entry: ContactEntryCorrected): Promise<void> {
  const noun = CONTACT_KIND_LABEL[entry.kind];
  const only = `for this ${WORD[record.type]} only`;
  const was = showContactEntry(entry.kind, entry.old);
  const now = showContactEntry(entry.kind, entry.new);
  const text = was === now ? `${noun} ${now} corrected ${only}` : `${noun} ${was} corrected to ${now} ${only}`;
  await write(db, actor, record, EVENTS[record.type].ENTRY_CORRECTED, text, {
    entry_id: entry.id,
    kind: entry.kind,
    intent: entry.intent,
    old: entry.old,
    new: entry.new,
  });
}

/**
 * One event when an entry is removed. For a changed entry the record goes back to the customer record's value, which
 * `restoredCustomerValue` names; `new` is null because the entry no longer stands.
 */
export async function recordEntryRemoved(db: Db, actor: JobChangeActor, record: ContactRecord, entry: ContactEntryRemoved): Promise<void> {
  const noun = CONTACT_KIND_LABEL[entry.kind];
  const word = WORD[record.type];
  const text = entry.restoredCustomerValue
    ? `${noun} ${showContactEntry(entry.kind, entry.old)} removed from this ${word}; back to the customer's ${showContactValue(entry.kind, entry.restoredCustomerValue)}`
    : `${noun} ${showContactEntry(entry.kind, entry.old)} removed from this ${word}`;
  await write(db, actor, record, EVENTS[record.type].ENTRY_REMOVED, text, {
    entry_id: entry.id,
    kind: entry.kind,
    intent: entry.intent,
    old: entry.old,
    new: null,
    restored_customer_value: entry.restoredCustomerValue,
  });
}

const authoredDate = (date: Date, timeZone: string): string => {
  const fmt = (zone: string) => new Intl.DateTimeFormat('en-US', { month: 'short', day: 'numeric', year: 'numeric', timeZone: zone }).format(date);
  try {
    return fmt(timeZone);
  } catch {
    return fmt('UTC');
  }
};

/**
 * One event on the JOB when an entry is carried over from the lead at conversion. It is the job's own add or change
 * event (the same two types the pencil writes, so everything that reads the job's entries history reads it too), and it
 * is not the converter's edit: it names the LEAD entry's author as the actor and its author and date in the sentence and
 * the metadata. `carried_from_lead` and `source_entry_id` tell it from an entry made on the job.
 */
export async function recordEntryCarried(db: EventDb, record: ContactRecord & { type: 'JOB' }, orgId: string, entry: ContactEntryCarried): Promise<void> {
  const noun = CONTACT_KIND_LABEL[entry.kind];
  const who = [entry.author.name, authoredDate(entry.authoredAt, entry.timeZone)].filter(Boolean).join(', ');
  const carried = `carried from the lead (${who})`;
  const now = showContactEntry(entry.kind, entry.current);
  const text = entry.replaced
    ? entry.replaced.value
      ? `${noun} ${showContactEntry(entry.kind, entry.replaced)} changed to ${now}, ${carried}`
      : `${noun} set to ${now}, ${carried}`
    : `${noun} ${now} ${carried}`;
  await writeEvent(
    db,
    { orgId, userId: entry.author.id },
    record,
    entry.replaced ? EVENTS.JOB.ENTRY_CHANGED : EVENTS.JOB.ENTRY_ADDED,
    text,
    {
      entry_id: entry.id,
      kind: entry.kind,
      intent: entry.intent,
      old: entry.replaced,
      new: entry.current,
      carried_from_lead: true,
      source_entry_id: entry.sourceEntryId,
      entry_author: entry.author,
      entry_created_at: entry.authoredAt.toISOString(),
    },
  );
}
