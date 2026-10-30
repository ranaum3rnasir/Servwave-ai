/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.20 - M8 says whether a change is unusual at the moment it lands.

   A job in Ready to close goes back to Office review when an UNUSUAL change lands on it. The write-time decision and the
   review panel must never disagree, so both ask M8: `unusualChangeOf` folds the item the new history entry belongs to
   exactly the way the panel does and answers with the same reason and title. Each case below is one change, written in
   the shape its writer records, and is checked both ways: the write-time answer and the panel's unusual flag.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import {
  buildReviewChangeSet,
  canBeUnusual,
  itemEventTypesOf,
  REVIEW_EVENT_TYPES,
  unusualChangeOf,
  type ReviewHistoryEntry,
  type ReviewJobDetails,
} from '../lib/job-review-changeset';

const WINDOW_START = new Date('2026-10-01T09:00:00.000Z');
let clock = 0;
let ids = 0;

function entry(event_type: string, metadata: Record<string, unknown> | null): ReviewHistoryEntry {
  clock += 1;
  return {
    id: `entry-${++ids}`,
    event_type,
    description: event_type,
    metadata,
    created_at: new Date(WINDOW_START.getTime() + clock * 60_000),
    actor_name: 'Dana Rivera',
  };
}

const line = (over: Record<string, unknown> = {}) => ({
  name: 'Faucet', quantity: 1, unit_price: 100, line_total: 100, is_taxable: true,
  discount_type: null, discount_value: null, discount_amount: 0, ...over,
});
const scope = (flat_price: number) => ({ name: 'Rough-in', description: '', flat_price, is_taxable: true });
const discount = (amount: number) => ({ discount_type: 'FIXED', discount_value: amount, discount_amount: amount });
const phone = { value: '5551234567', extension: null, label: null };

const DETAILS: ReviewJobDetails = {
  job_number: 'J-1', job_type: null, customer: { name: 'Pat', company_name: null }, service_address: null, visits: [], lines: [],
  discount_amount: 0, total: 0, invoices: [], balance: 0, file_count: 0, note_count: 0,
};

/** The panel's own view of the same history: does it hold an unusual item? */
function panelUnusual(entries: ReviewHistoryEntry[]) {
  const set = buildReviewChangeSet({ entries, windowStart: WINDOW_START, details: DETAILS, jobLatestEntryId: null, checks: [], decisions: [], mayCosts: false });
  return set.groups.find((g) => g.key === 'unusual')!.items;
}

interface Case {
  name: string;
  /** What was on the job's history already, then the change that just landed (the last entry). */
  history: () => ReviewHistoryEntry[];
  /** The reason M8 gives, or null when the change is ordinary. */
  reason: string | null;
  kind?: 'file_deleted' | 'price_cut' | 'customer_change';
  title?: string;
}

const CASES: Case[] = [
  // ─── unusual: a deleted attachment ───
  { name: 'a file deleted', reason: 'A file was deleted', kind: 'file_deleted', title: 'File: Front door.png',
    history: () => [entry('ATTACHMENT_DELETED', { attachment_id: 'a1', display_name: 'Front door.png' })] },
  { name: 'a file deleted from one of the job\'s invoices', reason: 'A file was deleted', kind: 'file_deleted', title: 'Invoice INV-7 file: Receipt.pdf',
    history: () => [entry('ATTACHMENT_DELETED', { attachment_id: 'a2', display_name: 'Receipt.pdf', invoice_id: 'i1', invoice_number: 'INV-7' })] },
  // ─── unusual: a price cut ───
  { name: 'a line price lowered', reason: 'A price was lowered', kind: 'price_cut', title: 'Line: Faucet',
    history: () => [entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line(), new: line({ unit_price: 80, line_total: 80 }) })] },
  { name: 'a line removed', reason: 'A line was removed', kind: 'price_cut', title: 'Line: Faucet',
    history: () => [entry('JOB_LINE_REMOVED', { line_id: 'l1', old: line(), new: null })] },
  { name: 'a line discount raised', reason: 'A discount was added or raised', kind: 'price_cut', title: 'Line: Faucet',
    history: () => [entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line(), new: line({ discount_amount: 10 }) })] },
  { name: 'a line added at full price and then cut', reason: 'A price was lowered', kind: 'price_cut', title: 'Line: Faucet',
    history: () => [
      entry('JOB_LINE_ADDED', { line_id: 'l1', old: null, new: line() }),
      entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line(), new: line({ unit_price: 90, line_total: 90 }) }),
    ] },
  { name: 'a scope price lowered', reason: 'A price was lowered', kind: 'price_cut', title: 'Scope: Rough-in',
    history: () => [entry('JOB_SCOPE_CHANGED', { scope_id: 's1', old: scope(500), new: scope(400) })] },
  { name: 'a scope removed', reason: 'A line was removed', kind: 'price_cut', title: 'Scope: Rough-in',
    history: () => [entry('JOB_SCOPE_REMOVED', { scope_id: 's1', old: scope(500), new: null })] },
  { name: 'a job discount raised', reason: 'A discount was added or raised', kind: 'price_cut', title: 'Job discount',
    history: () => [entry('JOB_DISCOUNT_CHANGED', { old: discount(0), new: discount(25) })] },
  { name: 'an invoice line price lowered', reason: 'A price was lowered', kind: 'price_cut', title: 'Invoice INV-1 line: Faucet',
    history: () => [entry('JOB_INVOICE_LINE_CHANGED', { invoice_id: 'i1', invoice_number: 'INV-1', line_id: 'l1', old: line(), new: line({ unit_price: 50, line_total: 50 }) })] },
  { name: 'an invoice line removed', reason: 'A line was removed', kind: 'price_cut', title: 'Invoice INV-1 line: Faucet',
    history: () => [entry('JOB_INVOICE_LINE_REMOVED', { invoice_id: 'i1', invoice_number: 'INV-1', line_id: 'l1', old: line(), new: null })] },
  { name: 'an invoice discount raised', reason: 'A discount was added or raised', kind: 'price_cut', title: 'Invoice INV-1 discount',
    history: () => [entry('JOB_INVOICE_DISCOUNT_CHANGED', { invoice_id: 'i1', invoice_number: 'INV-1', old: { discount_amount: 0 }, new: { discount_amount: 9 } })] },
  // ─── unusual: a customer detail change ───
  { name: 'a phone added for this job', reason: 'A customer detail changed', kind: 'customer_change', title: 'Phone',
    history: () => [entry('JOB_CONTACT_ENTRY_ADDED', { entry_id: 'c1', kind: 'PHONE', intent: 'ADDED', old: null, new: phone })] },
  { name: 'a name changed for this job', reason: 'A customer detail changed', kind: 'customer_change', title: 'First name',
    history: () => [entry('JOB_CONTACT_ENTRY_CHANGED', { entry_id: 'c2', kind: 'FIRST_NAME', intent: 'CHANGED', old: { value: 'Pat', extension: null, label: null }, new: { value: 'Patricia', extension: null, label: null } })] },
  { name: 'a contact entry corrected', reason: 'A customer detail changed', kind: 'customer_change', title: 'Phone',
    history: () => [
      entry('JOB_CONTACT_ENTRY_ADDED', { entry_id: 'c1', kind: 'PHONE', intent: 'ADDED', old: null, new: phone }),
      entry('JOB_CONTACT_ENTRY_CORRECTED', { entry_id: 'c1', kind: 'PHONE', intent: 'ADDED', old: phone, new: { ...phone, value: '5559876543' } }),
    ] },

  // ─── ordinary ───
  { name: 'a file uploaded', reason: null, history: () => [entry('ATTACHMENT_UPLOADED', { attachment_id: 'a3', file_type: 'image/png' })] },
  { name: 'a file renamed', reason: null, history: () => [entry('ATTACHMENT_UPDATED', { attachment_id: 'a3' })] },
  { name: 'a line added at full price', reason: null, history: () => [entry('JOB_LINE_ADDED', { line_id: 'l9', old: null, new: line() })] },
  { name: 'a line price raised', reason: null, history: () => [entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line(), new: line({ unit_price: 120, line_total: 120 }) })] },
  { name: 'a line discount lowered', reason: null, history: () => [entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line({ discount_amount: 10 }), new: line({ discount_amount: 4 }) })] },
  { name: 'a scope added', reason: null, history: () => [entry('JOB_SCOPE_ADDED', { scope_id: 's9', old: null, new: scope(300) })] },
  { name: 'a scope price raised', reason: null, history: () => [entry('JOB_SCOPE_CHANGED', { scope_id: 's1', old: scope(500), new: scope(650) })] },
  { name: 'a job discount lowered', reason: null, history: () => [entry('JOB_DISCOUNT_CHANGED', { old: discount(25), new: discount(5) })] },
  { name: 'an invoice line added', reason: null, history: () => [entry('JOB_INVOICE_LINE_ADDED', { invoice_id: 'i1', invoice_number: 'INV-1', line_id: 'l9', old: null, new: line() })] },
  { name: 'an invoice line price raised', reason: null, history: () => [entry('JOB_INVOICE_LINE_CHANGED', { invoice_id: 'i1', invoice_number: 'INV-1', line_id: 'l1', old: line(), new: line({ unit_price: 130, line_total: 130 }) })] },
  { name: 'an invoice discount lowered', reason: null, history: () => [entry('JOB_INVOICE_DISCOUNT_CHANGED', { invoice_id: 'i1', invoice_number: 'INV-1', old: { discount_amount: 9 }, new: { discount_amount: 2 } })] },
  { name: 'a note added', reason: null, history: () => [entry('JOB_NOTE_ADDED', { note_id: 'n1' })] },
  { name: 'a note deleted', reason: null, history: () => [entry('NOTE_DELETED', { note_id: 'n1' })] },
  { name: 'a payment recorded', reason: null, history: () => [entry('JOB_PAYMENT_RECORDED', { invoice_id: 'i1', payment_id: 'p1', amount: 50, method: 'CASH' })] },
  { name: 'a deposit applied', reason: null, history: () => [entry('JOB_DEPOSIT_APPLIED', { invoice_id: 'i1', deposit_invoice_id: 'i0', amount: 50 })] },
  { name: 'a refund issued', reason: null, history: () => [entry('JOB_REFUND_ISSUED', { invoice_id: 'i1', refund_id: 'r1', amount: 20 })] },
  { name: 'a payment voided', reason: null, history: () => [entry('JOB_PAYMENT_VOIDED', { invoice_id: 'i1', payment_id: 'p1', amount: 50 })] },
  { name: 'a customer detail taken off the job again (added, then removed)', reason: null,
    history: () => [
      entry('JOB_CONTACT_ENTRY_ADDED', { entry_id: 'c5', kind: 'EMAIL', intent: 'ADDED', old: null, new: { value: 'a@example.test', extension: null, label: null } }),
      entry('JOB_CONTACT_ENTRY_REMOVED', { entry_id: 'c5', kind: 'EMAIL', intent: 'ADDED', old: { value: 'a@example.test', extension: null, label: null }, new: null }),
    ] },
];

describe('M8 unusualChangeOf: the same answer at write time as in the panel', () => {
  for (const c of CASES) {
    it(`${c.name}: ${c.reason ? 'is unusual' : 'is ordinary'}, in the write-time answer and in the panel alike`, () => {
      const history = c.history();
      const landed = history[history.length - 1]!;
      const change = unusualChangeOf(history, landed);
      const panel = panelUnusual(history);
      if (c.reason === null) {
        expect(change).toBeNull();
        expect(panel).toHaveLength(0);
        return;
      }
      expect(change).toMatchObject({ reason: c.reason, kind: c.kind, title: c.title });
      // The panel lists the same item, with the same reason, title and kind.
      expect(panel).toHaveLength(1);
      expect(panel[0]).toMatchObject({ key: change!.key, unusual_reason: change!.reason, unusual_kind: change!.kind, title: change!.title });
    });
  }

  it('judges only the item the landed entry belongs to: another item that is unusual already does not count', () => {
    const cut = entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line(), new: line({ unit_price: 10, line_total: 10 }) });
    const payment = entry('JOB_PAYMENT_RECORDED', { invoice_id: 'i1', payment_id: 'p1', amount: 5, method: 'CASH' });
    expect(unusualChangeOf([cut, payment], payment)).toBeNull();
    expect(unusualChangeOf([cut, payment], cut)).toMatchObject({ reason: 'A price was lowered' });
  });

  it('keeps a cut line unusual when a later edit raises it again but not back to where it began', () => {
    const cut = entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line(), new: line({ unit_price: 60, line_total: 60 }) });
    const raised = entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line({ unit_price: 60, line_total: 60 }), new: line({ unit_price: 80, line_total: 80 }) });
    expect(unusualChangeOf([cut, raised], raised)).toMatchObject({ reason: 'A price was lowered' });
    expect(panelUnusual([cut, raised])).toHaveLength(1);
  });

  it('answers null for an entry the review does not read', () => {
    const other = entry('JOB_COMPLETED_SOMETHING', {});
    expect(unusualChangeOf([other], other)).toBeNull();
  });
});

describe('M8 canBeUnusual and itemEventTypesOf: what the write-time hook may skip', () => {
  it('says yes for every kind of entry that some case above shows unusual', () => {
    for (const c of CASES.filter((x) => x.reason)) {
      const types = c.history().map((h) => h.event_type);
      expect(types.some(canBeUnusual), c.name).toBe(true);
    }
  });

  it('says no only where no case lets that entry, landing last, make an item unusual', () => {
    // Every review event type is exercised by at least one case, so the skip list is checked against all of them.
    const exercised = new Set(CASES.flatMap((c) => c.history().map((h) => h.event_type)));
    for (const type of REVIEW_EVENT_TYPES) expect(exercised.has(type), `no case for ${type}`).toBe(true);
    for (const c of CASES) {
      const history = c.history();
      const landed = history[history.length - 1]!;
      if (!canBeUnusual(landed.event_type)) expect(unusualChangeOf(history, landed), c.name).toBeNull();
    }
  });

  it('names, for an entry, every type of entry that folds into the same item', () => {
    expect(itemEventTypesOf('JOB_LINE_CHANGED')).toEqual(['JOB_LINE_ADDED', 'JOB_LINE_CHANGED', 'JOB_LINE_REMOVED']);
    expect(itemEventTypesOf('JOB_DISCOUNT_CHANGED')).toEqual(['JOB_DISCOUNT_CHANGED']);
    expect(itemEventTypesOf('ATTACHMENT_DELETED')).toEqual(['ATTACHMENT_UPLOADED', 'ATTACHMENT_UPDATED', 'ATTACHMENT_DELETED']);
    expect(itemEventTypesOf('JOB_CONTACT_ENTRY_CORRECTED')).toHaveLength(4);
    expect(itemEventTypesOf('SOMETHING_ELSE')).toEqual([]);
  });
});

describe('M8 "Since the review": ordinary changes after the round was finished', () => {
  const FINISHED_AT = new Date(WINDOW_START.getTime() + 24 * 60 * 60_000);
  const after = (type: string, metadata: Record<string, unknown>): ReviewHistoryEntry => ({
    id: `entry-${++ids}`, event_type: type, description: type, metadata,
    created_at: new Date(FINISHED_AT.getTime() + 60_000 * (1 + ids)), actor_name: 'Sam Office',
  });
  const before = (type: string, metadata: Record<string, unknown>): ReviewHistoryEntry => ({
    id: `entry-${++ids}`, event_type: type, description: type, metadata,
    created_at: new Date(WINDOW_START.getTime() + 60_000 * (1 + ids)), actor_name: 'Dana Rivera',
  });
  const build = (entries: ReviewHistoryEntry[], finishedAt: Date | null) =>
    buildReviewChangeSet({ entries, windowStart: WINDOW_START, finishedAt, details: DETAILS, jobLatestEntryId: null, checks: [], decisions: [], mayCosts: false });

  it('lists the items whose latest change came after the finish, and not the ones the review already saw', () => {
    const seen = before('JOB_NOTE_ADDED', { note_id: 'n1' });
    const paid = after('JOB_PAYMENT_RECORDED', { invoice_id: 'i1', payment_id: 'p1', amount: 50, method: 'CASH' });
    const noted = after('JOB_NOTE_ADDED', { note_id: 'n2' });
    const set = build([seen, paid, noted], FINISHED_AT);
    expect(set.since_review?.map((i) => i.key)).toEqual(['payment:p1', 'note:n2']);
    // The ordinary groups still hold every item once; the count of items is unchanged by the extra list.
    expect(set.totals.items).toBe(1 + 3);
  });

  it('is an empty list when nothing changed after the finish, and null when the round was not finished', () => {
    const seen = before('JOB_NOTE_ADDED', { note_id: 'n1' });
    expect(build([seen], FINISHED_AT).since_review).toEqual([]);
    expect(build([seen], null).since_review).toBeNull();
  });

  it('lists an item changed both before and after the finish once, with its latest change after', () => {
    const first = before('JOB_LINE_ADDED', { line_id: 'l1', old: null, new: line() });
    const raised = after('JOB_LINE_CHANGED', { line_id: 'l1', old: line(), new: line({ unit_price: 120, line_total: 120 }) });
    expect(build([first, raised], FINISHED_AT).since_review?.map((i) => [i.key, i.latest_entry_id])).toEqual([['line:l1', raised.id]]);
  });
});
