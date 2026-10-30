/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.24 - M8 lists every unusual item of a window.

   The Office review attention alert is raised when a job ENTERS Office review with unusual items already in its window, and
   it lists them in the panel's own words. `unusualChangesOf` folds the whole window exactly as the panel does, so what the
   alert lists and what the panel flags can never disagree: each case is checked both ways.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { buildReviewChangeSet, unusualChangeOf, unusualChangesOf, type ReviewHistoryEntry, type ReviewJobDetails } from '../lib/job-review-changeset';

const WINDOW_START = new Date('2026-10-01T09:00:00.000Z');
let clock = 0;
let ids = 0;

function entry(event_type: string, metadata: Record<string, unknown> | null): ReviewHistoryEntry {
  clock += 1;
  return { id: `entry-${++ids}`, event_type, description: event_type, metadata, created_at: new Date(WINDOW_START.getTime() + clock * 60_000), actor_name: 'Dana Rivera' };
}

const line = (over: Record<string, unknown> = {}) => ({
  name: 'Faucet', quantity: 1, unit_price: 100, line_total: 100, is_taxable: true, discount_type: null, discount_value: null, discount_amount: 0, ...over,
});

const DETAILS: ReviewJobDetails = {
  job_number: 'J-1', job_type: null, customer: { name: 'Pat', company_name: null }, service_address: null, visits: [], lines: [],
  discount_amount: 0, total: 0, invoices: [], balance: 0, file_count: 0, note_count: 0,
};

/** The panel's own list of unusual items for the same entries. */
function panelUnusual(entries: ReviewHistoryEntry[]) {
  const set = buildReviewChangeSet({ entries, windowStart: WINDOW_START, details: DETAILS, jobLatestEntryId: null, checks: [], decisions: [], mayCosts: false });
  return set.groups.find((g) => g.key === 'unusual')!.items;
}

describe('unusualChangesOf', () => {
  it('lists each unusual item once, by the panel\'s reason and title, and leaves ordinary ones out', () => {
    const entries = [
      entry('JOB_LINE_ADDED', { line_id: 'l1', old: null, new: line() }),
      entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line(), new: line({ unit_price: 80, line_total: 80 }) }),
      // A second edit to the same line is the same item.
      entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line({ unit_price: 80 }), new: line({ unit_price: 70, line_total: 70 }) }),
      entry('ATTACHMENT_UPLOADED', { attachment_id: 'a1', display_name: 'Kept.png' }),
      entry('ATTACHMENT_UPLOADED', { attachment_id: 'a2', display_name: 'Front door.png' }),
      entry('ATTACHMENT_DELETED', { attachment_id: 'a2', display_name: 'Front door.png' }),
      entry('JOB_NOTE_ADDED', { note_id: 'n1' }),
      entry('JOB_PAYMENT_RECORDED', { payment_id: 'p1', amount: 10 }),
    ];

    const found = unusualChangesOf(entries);

    expect(found.map((c) => [c.reason, c.title])).toEqual([
      ['A price was lowered', 'Line: Faucet'],
      ['A file was deleted', 'File: Front door.png'],
    ]);
    // The panel flags the same items.
    expect(panelUnusual(entries).map((i) => [i.unusual_reason, i.title]).sort()).toEqual(found.map((c) => [c.reason, c.title]).sort());
  });

  it('is empty for a window with nothing unusual in it', () => {
    expect(unusualChangesOf([
      entry('JOB_LINE_ADDED', { line_id: 'l1', old: null, new: line() }),
      entry('ATTACHMENT_UPLOADED', { attachment_id: 'a1', display_name: 'Kept.png' }),
    ])).toEqual([]);
    expect(unusualChangesOf([])).toEqual([]);
  });
});

describe('carried customer entries that share a millisecond', () => {
  // A lead's entries are carried onto the job in one transaction, so their history entries share created_at and their
  // random ids say nothing about order: the lead's own order (the lead entry's date, then its id) decides.
  const carried = (id: string, kind: 'PHONE' | 'EMAIL', source: string): ReviewHistoryEntry => ({
    id,
    event_type: 'JOB_CONTACT_ENTRY_ADDED',
    description: 'JOB_CONTACT_ENTRY_ADDED',
    metadata: {
      entry_id: `c-${source}`, kind, intent: 'ADDED', old: null, new: { value: kind === 'PHONE' ? '5551234567' : 'tenant@example.test', extension: null, label: null },
      carried_from_lead: true, source_entry_id: source, entry_created_at: '2026-09-30T08:00:00.000Z',
    },
    created_at: new Date(WINDOW_START.getTime() + 60_000),
    actor_name: 'Dana Rivera',
  });

  it('are listed by the alert in the order the panel lists them, whatever order the history arrives in', () => {
    // The phone came first on the lead (lower source id) but its history entry holds the higher id.
    const phone = carried('h-9', 'PHONE', 'src-1');
    const email = carried('h-1', 'EMAIL', 'src-2');
    for (const entries of [[phone, email], [email, phone]]) {
      const panel = panelUnusual(entries).map((i) => i.title);
      expect(panel).toEqual(['Phone', 'Email']);
      expect(unusualChangesOf(entries).map((c) => c.title)).toEqual(panel);
    }
  });
});

describe('the invoices an unusual item names', () => {
  const invoiceLine = (price: number) => ({ invoice_id: 'inv-1', invoice_number: 'INV-1', line_id: 'il1', old: line({ name: 'Service' }), new: line({ name: 'Service', unit_price: price, line_total: price }) });

  it('are carried by an invoice line, an invoice discount and a file on an invoice, and by no other item', () => {
    const entries = [
      entry('JOB_INVOICE_LINE_CHANGED', invoiceLine(70)),
      entry('JOB_INVOICE_DISCOUNT_CHANGED', { invoice_id: 'inv-2', invoice_number: 'INV-2', old: null, new: { discount_type: 'FIXED_AMOUNT', discount_value: 5, discount_amount: 5 } }),
      entry('ATTACHMENT_DELETED', { attachment_id: 'a1', display_name: 'Receipt.pdf', invoice_id: 'inv-3', invoice_number: 'INV-3' }),
      entry('ATTACHMENT_DELETED', { attachment_id: 'a2', display_name: 'Door.png' }),
      entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line(), new: line({ unit_price: 50, line_total: 50 }) }),
    ];
    expect(unusualChangesOf(entries).map((c) => [c.title, c.invoice_ids])).toEqual([
      ['Invoice INV-1 line: Service', ['inv-1']],
      ['Invoice INV-2 discount', ['inv-2']],
      ['Invoice INV-3 file: Receipt.pdf', ['inv-3']],
      ['File: Door.png', []],
      ['Line: Faucet', []],
    ]);
  });

  it('are carried by the one-item form too, which the landing of a single change uses', () => {
    const landed = entry('JOB_INVOICE_LINE_CHANGED', invoiceLine(60));
    expect(unusualChangeOf([entry('JOB_INVOICE_LINE_CHANGED', invoiceLine(80)), landed], landed)?.invoice_ids).toEqual(['inv-1']);
  });
});

