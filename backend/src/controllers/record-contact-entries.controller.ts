/**
 * A job's or a lead's own phones, emails, name and company (Roles & Permissions, PRD 5, S05.7 to S05.10 on a job, S05.13
 * on a lead): the pencil on the customer block.
 *
 * An entry belongs to ONE job or ONE lead; the customer record is never written. The route guard asks "may this person
 * edit contact details at all" (Edit job and lead contact details, or Edit jobs on a job / Edit leads on a lead - either
 * one is enough; on a lead the creator still attached counts as Edit leads, PRD 4); the handler then asks whether the
 * record opens for them, in the detail route's own split: not-found for a missing record or one in another company,
 * forbidden for one in the same company that is outside their reach. Add notes plays no part. Adding and changing share
 * the one gate.
 *
 * Correcting and removing an entry (S05.9) take the same gate whoever added the entry: the author gets nothing extra,
 * and losing the switch takes the right away from the author too. A name or company entry is the exception the gate
 * makes by kind: Edit jobs / Edit leads only, since Edit job and lead contact details covers phones and emails, not
 * names. Changing the customer's name or company for the record (S05.10) is that same gate.
 *
 * A locked record takes none of these writes: a closed lead (Won or Lost) refuses them for everyone, by a route guard
 * (lib/permissions/leadLock) that sits ahead of these handlers (S05.14).
 *
 * The handlers are one set made for a record kind: the job and the lead differ in how the record is found and opened,
 * who may touch a name, the timeline the history lands on and the word the messages use, and in nothing else.
 */
import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';
import { tenantWhere } from '../lib/tenant';
import { canAccessRow } from '../lib/permissions/enforce';
import {
  recordEntryAdded,
  recordEntryChanged,
  recordEntryCorrected,
  recordEntryRemoved,
  type ContactRecord,
} from '../lib/record-contact-history';
import {
  CUSTOMER_CONTACT_ROWS_SELECT,
  CUSTOMER_NAME_SELECT,
  ENTRY_SELECT,
  ContactEntryRefusal,
  addContactEntrySchema,
  applyCorrection,
  changeContactEntrySchema,
  changeNameSchema,
  checkNameChange,
  correctContactEntrySchema,
  findCustomerValue,
  isContactDetailKind,
  liveEntries,
  recordEntryKey,
  refuseChange,
  refuseDuplicate,
  type AddContactEntryInput,
  type ChangeContactEntryInput,
  type ChangeNameInput,
  type CorrectContactEntryInput,
  type EntryKind,
  type EntryRecord,
} from '../lib/record-contact-entries';
import { NUMBER_ON_CUSTOMER_OUT_OF_REACH, numberCarryCheckForReq, type NumberCarryCheck } from '../lib/communication/numberGuard';

export { addContactEntrySchema, changeContactEntrySchema, changeNameSchema, correctContactEntrySchema };

function actorOf(req: Request) {
  return { orgId: req.user!.organization_id, userId: req.user!.id };
}

function actorName(req: Request): string {
  const user = req.user!;
  return `${user.first_name} ${user.last_name}`.trim() || user.email;
}

const valueOf = (e: { value: string; extension: string | null; label: string | null }) => ({
  value: e.value,
  extension: e.extension,
  label: e.label,
});

/** The customer a record's entries are checked against: the columns and lists a change can name, and the names. */
const CUSTOMER_SELECT = { id: true, ...CUSTOMER_CONTACT_ROWS_SELECT, ...CUSTOMER_NAME_SELECT };

type OpenedRecord = { id: string; customer: NonNullable<Awaited<ReturnType<typeof findJob>>>['customer'] };

const findJob = (req: Request, id: string) =>
  prisma.job.findFirst({ where: { id, ...tenantWhere(req) }, select: { id: true, customer: { select: { ...CUSTOMER_SELECT } } } });

const findLead = (req: Request, id: string) =>
  prisma.lead.findFirst({ where: { id, ...tenantWhere(req) }, select: { id: true, customer: { select: { ...CUSTOMER_SELECT } } } });

/** What differs between a job's entries and a lead's. */
interface RecordKind {
  kind: EntryRecord['kind'];
  /** The timeline the history events land on. */
  entity: ContactRecord['type'];
  /** The record, if it exists in the person's company. */
  find: (req: Request, id: string) => Promise<OpenedRecord | null>;
  /** Does the record open for this person (the per-record scope)? */
  opens: (req: Request, id: string) => Promise<boolean>;
  /** May this person touch a name or company entry: Edit jobs on a job; Edit leads, or the creator still on it, on a lead. */
  mayEditNames: (req: Request, id: string) => Promise<boolean>;
}

const JOB: RecordKind = {
  kind: 'job',
  entity: 'JOB',
  find: findJob,
  opens: (req, id) => canAccessRow(req, 'Job', prisma.job, id),
  mayEditNames: async (req) => req.ability!.can('update', 'Job'),
};

const LEAD: RecordKind = {
  kind: 'lead',
  entity: 'LEAD',
  find: findLead,
  opens: (req, id) => canAccessRow(req, 'Lead', prisma.lead, id),
  mayEditNames: async (req) => req.ability!.can('update', 'Lead'),
};

const noun = (input: { kind: string }) => (input.kind === 'PHONE' ? 'number' : 'email');

/**
 * Guard the number (lib/communication/numberGuard.ts): a phone put on a record makes its customer carry it, so one that a
 * customer the person cannot open already carries is refused, unless they hold Communication "All".
 */
async function refuseNumberOutOfReach(
  mayCarry: NumberCarryCheck, db: Parameters<NumberCarryCheck>[0], kind: string, value: string, customerId: string,
): Promise<void> {
  if (kind === 'PHONE' && !(await mayCarry(db, [value], customerId))) {
    throw new ContactEntryRefusal(NUMBER_ON_CUSTOMER_OUT_OF_REACH, 409);
  }
}

/** The handlers for one kind of record. */
function contactEntryHandlers(record: RecordKind) {
  const word = record.kind;
  const Word = record.kind === 'job' ? 'Job' : 'Lead';
  const target = (id: string): ContactRecord => ({ type: record.entity, id });
  const entryRecord = (id: string): EntryRecord => ({ kind: record.kind, id });

  /** The record, if it exists in the person's company and opens for them; otherwise the answer has been sent. */
  async function openOrRefuse(req: Request, res: Response) {
    const id = req.params.id as string;
    const found = await record.find(req, id);
    if (!found) {
      res.status(404).json({ error: `${Word} not found` });
      return null;
    }
    if (!(await record.opens(req, id))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return null;
    }
    return found;
  }

  /** The record's live entry the request names, after the gate that depends on its kind. */
  async function entryOrRefuse(req: Request, res: Response, recordId: string) {
    const entry = await prisma.recordContactEntry.findFirst({
      where: { id: req.params.entryId as string, organization_id: req.user!.organization_id, ...recordEntryKey(entryRecord(recordId)), removed_at: null },
      select: { ...ENTRY_SELECT },
    });
    if (!entry) {
      res.status(404).json({ error: 'Contact detail not found' });
      return null;
    }
    if (!isContactDetailKind(entry.kind) && !(await record.mayEditNames(req, recordId))) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return null;
    }
    return entry;
  }

  const refused = (err: unknown, res: Response, logLabel: string, failure: string) => {
    if (err instanceof ContactEntryRefusal) {
      res.status(err.status).json({ error: err.message });
      return;
    }
    logger.error(`${logLabel}:`, err);
    res.status(500).json({ error: failure });
  };

  /** POST .../contact-entries - add a phone or email for this record only. */
  async function addEntry(req: Request, res: Response) {
    try {
      const opened = await openOrRefuse(req, res);
      if (!opened) return;
      const input = req.body as AddContactEntryInput;
      const { orgId } = actorOf(req);
      const mayCarry = await numberCarryCheckForReq(req);

      const entries = await prisma.$transaction(async (tx) => {
        const live = await tx.recordContactEntry.findMany({
          where: { organization_id: orgId, ...recordEntryKey(entryRecord(opened.id)), removed_at: null },
          select: { kind: true, value: true },
        });
        refuseDuplicate(input, opened.customer, live, word);
        await refuseNumberOutOfReach(mayCarry, tx, input.kind, input.value, opened.customer.id);

        const name = actorName(req);
        const created = await tx.recordContactEntry.create({
          data: {
            organization_id: orgId,
            ...recordEntryKey(entryRecord(opened.id)),
            kind: input.kind,
            intent: 'ADDED',
            value: input.value,
            extension: input.kind === 'PHONE' ? input.extension : null,
            label: input.label,
            created_by_id: req.user!.id,
            created_by_name: name,
            updated_by_id: req.user!.id,
            updated_by_name: name,
          },
          select: ENTRY_SELECT,
        });
        await recordEntryAdded(tx, actorOf(req), target(opened.id), {
          id: created.id,
          kind: input.kind,
          intent: 'ADDED',
          value: created.value,
          extension: created.extension,
          label: created.label,
        });
        return liveEntries(tx, orgId, entryRecord(opened.id));
      });

      res.status(201).json({ entries });
    } catch (err) {
      refused(err, res, `Add ${word} contact entry error`, 'Failed to save this contact detail');
    }
  }

  /**
   * POST .../contact-entries/change - replace one of the customer's phones or emails for this record only. The entry
   * records which customer value it replaces and what that value was; the customer record is not written.
   */
  async function changeEntry(req: Request, res: Response) {
    try {
      const opened = await openOrRefuse(req, res);
      if (!opened) return;
      const input = req.body as ChangeContactEntryInput;
      const { orgId } = actorOf(req);

      const replaced = findCustomerValue(opened.customer, input.kind, input.replaces);
      if (!replaced) {
        res.status(404).json({ error: `That ${noun(input)} is not on this customer` });
        return;
      }

      const mayCarry = await numberCarryCheckForReq(req);
      const entries = await prisma.$transaction(async (tx) => {
        const live = await tx.recordContactEntry.findMany({
          where: { organization_id: orgId, ...recordEntryKey(entryRecord(opened.id)), removed_at: null },
          select: { kind: true, value: true, intent: true, customer_value_at_change: true },
        });
        refuseChange(input, replaced, opened.customer, live, word);
        await refuseNumberOutOfReach(mayCarry, tx, input.kind, input.value, opened.customer.id);

        const name = actorName(req);
        const created = await tx.recordContactEntry.create({
          data: {
            organization_id: orgId,
            ...recordEntryKey(entryRecord(opened.id)),
            kind: input.kind,
            intent: 'CHANGED',
            value: input.value,
            extension: input.kind === 'PHONE' ? input.extension : null,
            label: input.label,
            overridden_field: replaced.field,
            overridden_row_id: replaced.rowId,
            customer_value_at_change: replaced.value,
            created_by_id: req.user!.id,
            created_by_name: name,
            updated_by_id: req.user!.id,
            updated_by_name: name,
          },
          select: ENTRY_SELECT,
        });
        await recordEntryChanged(tx, actorOf(req), target(opened.id), {
          id: created.id,
          kind: input.kind,
          intent: 'CHANGED',
          old: { value: replaced.value, extension: replaced.extension, label: replaced.label },
          new: { value: created.value, extension: created.extension, label: created.label },
        });
        return liveEntries(tx, orgId, entryRecord(opened.id));
      });

      res.status(201).json({ entries });
    } catch (err) {
      refused(err, res, `Change ${word} contact entry error`, 'Failed to save this contact detail');
    }
  }

  /**
   * POST .../contact-entries/name - change the customer's first name, last name or company name for this record only.
   * The route guard asks Edit jobs / Edit leads alone: Edit job and lead contact details covers phones and emails, not
   * names. The customer record is not written.
   */
  async function changeName(req: Request, res: Response) {
    try {
      const opened = await openOrRefuse(req, res);
      if (!opened) return;
      const input = req.body as ChangeNameInput;
      const { orgId } = actorOf(req);

      const entries = await prisma.$transaction(async (tx) => {
        const live = await tx.recordContactEntry.findMany({
          where: { organization_id: orgId, ...recordEntryKey(entryRecord(opened.id)), removed_at: null },
          select: { kind: true },
        });
        const { field, customerValue } = checkNameChange(input, opened.customer, live, word);

        const name = actorName(req);
        const created = await tx.recordContactEntry.create({
          data: {
            organization_id: orgId,
            ...recordEntryKey(entryRecord(opened.id)),
            kind: input.kind,
            intent: 'CHANGED',
            value: input.value,
            overridden_field: field,
            customer_value_at_change: customerValue,
            created_by_id: req.user!.id,
            created_by_name: name,
            updated_by_id: req.user!.id,
            updated_by_name: name,
          },
          select: ENTRY_SELECT,
        });
        await recordEntryChanged(tx, actorOf(req), target(opened.id), {
          id: created.id,
          kind: input.kind,
          intent: 'CHANGED',
          old: { value: customerValue, extension: null, label: null },
          new: { value: created.value, extension: null, label: null },
        });
        return liveEntries(tx, orgId, entryRecord(opened.id));
      });

      res.status(201).json({ entries });
    } catch (err) {
      refused(err, res, `Change ${word} customer name error`, 'Failed to save this name');
    }
  }

  /** PATCH .../contact-entries/:entryId - correct an entry's value, extension or label, whoever added it. */
  async function correctEntry(req: Request, res: Response) {
    try {
      const opened = await openOrRefuse(req, res);
      if (!opened) return;
      const entry = await entryOrRefuse(req, res, opened.id);
      if (!entry) return;
      const input = req.body as CorrectContactEntryInput;
      const { orgId } = actorOf(req);
      const mayCarry = await numberCarryCheckForReq(req);

      const entries = await prisma.$transaction(async (tx) => {
        const others = await tx.recordContactEntry.findMany({
          where: { organization_id: orgId, ...recordEntryKey(entryRecord(opened.id)), removed_at: null, id: { not: entry.id } },
          select: { kind: true, value: true, intent: true, customer_value_at_change: true },
        });
        const next = applyCorrection(entry, input, opened.customer, others, word);
        // Only a new value is asked about: a corrected label or extension leaves the record carrying what it carried.
        if (next.value !== entry.value) await refuseNumberOutOfReach(mayCarry, tx, entry.kind, next.value, opened.customer.id);
        if (next.changed) {
          const name = actorName(req);
          await tx.recordContactEntry.update({
            where: { id: entry.id },
            data: {
              value: next.value,
              extension: next.extension,
              label: next.label,
              updated_by_id: req.user!.id,
              updated_by_name: name,
              updated_at: new Date(),
            },
          });
          await recordEntryCorrected(tx, actorOf(req), target(opened.id), {
            id: entry.id,
            kind: entry.kind as EntryKind,
            intent: entry.intent as 'ADDED' | 'CHANGED',
            old: valueOf(entry),
            new: valueOf(next),
          });
        }
        return liveEntries(tx, orgId, entryRecord(opened.id));
      });

      res.json({ entries });
    } catch (err) {
      refused(err, res, `Correct ${word} contact entry error`, 'Failed to save this contact detail');
    }
  }

  /**
   * DELETE .../contact-entries/:entryId - remove an entry, whoever added it. The row is kept (`removed_at`) so the
   * history stays whole; a removed change leaves the record on the customer record's value again.
   */
  async function removeEntry(req: Request, res: Response) {
    try {
      const opened = await openOrRefuse(req, res);
      if (!opened) return;
      const entry = await entryOrRefuse(req, res, opened.id);
      if (!entry) return;
      const { orgId } = actorOf(req);

      const entries = await prisma.$transaction(async (tx) => {
        const name = actorName(req);
        const gone = await tx.recordContactEntry.updateMany({
          where: { id: entry.id, organization_id: orgId, ...recordEntryKey(entryRecord(opened.id)), removed_at: null },
          data: { removed_at: new Date(), updated_by_id: req.user!.id, updated_by_name: name, updated_at: new Date() },
        });
        // Someone else removed it a moment ago: the entry is already gone.
        if (gone.count === 0) throw new ContactEntryRefusal('Contact detail not found', 404);
        await recordEntryRemoved(tx, actorOf(req), target(opened.id), {
          id: entry.id,
          kind: entry.kind as EntryKind,
          intent: entry.intent as 'ADDED' | 'CHANGED',
          old: valueOf(entry),
          restoredCustomerValue: entry.intent === 'CHANGED' ? entry.customer_value_at_change : null,
        });
        return liveEntries(tx, orgId, entryRecord(opened.id));
      });

      res.json({ entries });
    } catch (err) {
      refused(err, res, `Remove ${word} contact entry error`, 'Failed to remove this contact detail');
    }
  }

  return { addEntry, changeEntry, changeName, correctEntry, removeEntry };
}

/** A job's own entries: /api/jobs/:id/contact-entries. */
export const jobEntries = contactEntryHandlers(JOB);

/** A lead's own entries: /api/leads/:id/contact-entries. */
export const leadEntries = contactEntryHandlers(LEAD);
