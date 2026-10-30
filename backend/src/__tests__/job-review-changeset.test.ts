/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.8 - M8, the review change-set (pure).

   From the job's history since the round's window start, the job's current details, the round's checks and decisions
   and whether the person may see costs, it builds the job summary item and the grouped items the review panel shows.
   Everything here goes through the one exported function; the history entries are written in the shapes the earlier
   slices record them (S06.5 to S06.7, S04.24, S04.25, S05.7 to S05.9).
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import {
  buildReviewChangeSet,
  reviewVersion,
  itemsLeft,
  REVIEW_GROUP_ORDER,
  type ReviewHistoryEntry,
  type ReviewJobDetails,
  type ReviewChangeSetInput,
} from '../lib/job-review-changeset';

const WINDOW_START = new Date('2026-10-01T09:00:00.000Z');
let clock = 0;
let ids = 0;

/** One history entry, one minute after the last one made. */
function entry(event_type: string, metadata: Record<string, unknown> | null, over: Partial<ReviewHistoryEntry> = {}): ReviewHistoryEntry {
  clock += 1;
  return {
    id: `entry-${++ids}`,
    event_type,
    description: over.description ?? event_type,
    metadata,
    created_at: new Date(WINDOW_START.getTime() + clock * 60_000),
    actor_name: 'Dana Rivera',
    ...over,
  };
}

const line = (over: Record<string, unknown> = {}) => ({
  name: 'Spring', quantity: 1, unit_price: 100, line_total: 100, is_taxable: true,
  discount_type: null, discount_value: null, discount_amount: 0, ...over,
});

function details(over: Partial<ReviewJobDetails> = {}): ReviewJobDetails {
  return {
    job_number: 'J-1001',
    job_type: 'Repair',
    customer: { name: 'Pat Customer', company_name: null },
    service_address: '12 Main St, Springfield, IL 62701',
    visits: [
      { seq: 1, scheduled_at: new Date('2026-10-02T14:00:00.000Z'), outcome: 'finished', finished_by: 'Lee Tech', crew: ['Lee Tech'], cancelled_by_complete: false },
      { seq: 2, scheduled_at: new Date('2026-10-03T14:00:00.000Z'), outcome: 'cancelled', finished_by: null, crew: ['Lee Tech'], cancelled_by_complete: true },
    ],
    lines: [{ name: 'Spring', quantity: 2, unit_price: 100, line_total: 200, unit_cost: 60 }],
    discount_amount: 10,
    total: 190,
    total_cost: 120,
    invoices: [{ invoice_number: 'INV-1', status: 'SENT', total: 190, amount_due: 190 }],
    balance: 190,
    file_count: 3,
    note_count: 2,
    ...over,
  };
}

function build(over: Partial<ReviewChangeSetInput> = {}) {
  return buildReviewChangeSet({
    entries: [],
    windowStart: WINDOW_START,
    details: details(),
    jobLatestEntryId: null,
    checks: [],
    decisions: [],
    mayCosts: true,
    ...over,
  });
}

const allItems = (set: ReturnType<typeof build>) =>
  set.groups.filter((g) => g.key !== 'unusual').flatMap((g) => g.items);

describe('M8 the review change-set', () => {
  describe('the job summary', () => {
    it('is present on a round with no changes, and is the one item to check', () => {
      const set = build();
      expect(set.summary.key).toBe('summary');
      expect(set.summary.title).toBe('Job details');
      expect(set.summary.checked).toBe(false);
      expect(set.summary.job_type).toBe('Repair');
      expect(set.summary.customer.name).toBe('Pat Customer');
      expect(set.summary.service_address).toBe('12 Main St, Springfield, IL 62701');
      expect(set.summary.file_count).toBe(3);
      expect(set.summary.note_count).toBe(2);
      expect(set.totals).toEqual({ items: 1, checked: 0, unusual: 0 });
      expect(set.groups.every((g) => g.items.length === 0)).toBe(true);
    });

    it('lists the groups in the PRD order, empty ones included', () => {
      expect(build().groups.map((g) => g.key)).toEqual(['unusual', 'customer', 'lines', 'attachments', 'notes', 'payments']);
      expect(REVIEW_GROUP_ORDER).toEqual(['unusual', 'customer', 'lines', 'attachments', 'notes', 'payments']);
    });

    it('carries the visits with who finished each and which the complete cancelled, the lines and total with prices, and the invoices and balance', () => {
      const { summary } = build();
      expect(summary.visits.map((v) => [v.seq, v.outcome, v.finished_by, v.cancelled_by_complete])).toEqual([
        [1, 'finished', 'Lee Tech', false],
        [2, 'cancelled', null, true],
      ]);
      expect(summary.lines).toEqual([{ name: 'Spring', quantity: 2, unit_price: 100, line_total: 200, unit_cost: 60 }]);
      expect(summary.total).toBe(190);
      expect(summary.invoices).toEqual([{ invoice_number: 'INV-1', status: 'SENT', total: 190, amount_due: 190 }]);
      expect(summary.balance).toBe(190);
    });
  });

  describe('items are per thing, not per event', () => {
    it('makes one item of two edits to one line, with the first old value and the latest new value', () => {
      const first = entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line({ quantity: 1, line_total: 100 }), new: line({ quantity: 2, line_total: 200 }) });
      const second = entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line({ quantity: 2, line_total: 200 }), new: line({ quantity: 3, line_total: 300 }) }, { actor_name: 'Sam Office' });
      const set = build({ entries: [first, second] });
      const items = allItems(set);
      expect(items).toHaveLength(1);
      const item = items[0]!;
      expect(item.key).toBe('line:l1');
      expect(item.group).toBe('lines');
      expect(item.by).toBe('Sam Office');
      expect(item.latest_entry_id).toBe(second.id);
      expect(item.changes).toContainEqual({ label: 'Quantity', old: '1', new: '3' });
      expect(item.changes).toContainEqual({ label: 'Line total', old: '$100.00', new: '$300.00' });
      expect(item.summary).toContain('Quantity 1 to 3');
      expect(set.totals.items).toBe(2); // the summary and the line
    });

    it('keeps two different lines as two items', () => {
      const a = entry('JOB_LINE_ADDED', { line_id: 'l1', old: null, new: line() });
      const b = entry('JOB_LINE_ADDED', { line_id: 'l2', old: null, new: line({ name: 'Hinge' }) });
      expect(allItems(build({ entries: [a, b] })).map((i) => i.key)).toEqual(['line:l1', 'line:l2']);
    });

    it('leaves out history from before the round started', () => {
      const old = entry('JOB_LINE_ADDED', { line_id: 'l1', old: null, new: line() }, { created_at: new Date(WINDOW_START.getTime() - 60_000) });
      const fresh = entry('JOB_LINE_ADDED', { line_id: 'l2', old: null, new: line() });
      expect(allItems(build({ entries: [old, fresh] })).map((i) => i.key)).toEqual(['line:l2']);
    });

    it('puts every kind of change in its own group', () => {
      const set = build({
        entries: [
          entry('JOB_LINE_ADDED', { line_id: 'l1', old: null, new: line() }),
          entry('JOB_SCOPE_ADDED', { scope_id: 's1', old: null, new: { name: 'Install', description: '', flat_price: 50, is_taxable: true } }),
          entry('JOB_DISCOUNT_CHANGED', { old: { discount_type: null, discount_value: null, discount_amount: 0 }, new: { discount_type: 'FIXED', discount_value: 5, discount_amount: 5 } }),
          entry('JOB_INVOICE_LINE_ADDED', { invoice_id: 'i1', invoice_number: 'INV-1', line_id: 'il1', old: null, new: line() }),
          entry('ATTACHMENT_UPLOADED', { attachment_id: 'a1', file_type: 'image/png' }, { description: 'File uploaded: Photo.png' }),
          entry('JOB_NOTE_ADDED', { note_id: 'n1', note_content: 'Gate code is 1234' }),
          entry('JOB_PAYMENT_RECORDED', { invoice_id: 'i1', invoice_number: 'INV-1', amount: 50, method: 'CASH', payment_id: 'p1' }),
          entry('JOB_CONTACT_ENTRY_ADDED', { entry_id: 'c1', kind: 'PHONE', intent: 'ADDED', old: null, new: { value: '5551234567', extension: null, label: null } }),
        ],
      });
      const byGroup = Object.fromEntries(set.groups.filter((g) => g.key !== 'unusual').map((g) => [g.key, g.items.map((i) => i.key)]));
      expect(byGroup).toEqual({
        customer: ['contact:c1'],
        lines: ['line:l1', 'scope:s1', 'discount:job', 'invoice-line:i1:il1'],
        attachments: ['attachment:a1'],
        notes: ['note:n1'],
        payments: ['payment:p1'],
      });
    });
  });

  describe('unusual items', () => {
    const unusualKeys = (set: ReturnType<typeof build>) => set.groups.find((g) => g.key === 'unusual')!.items.map((i) => i.key);

    it('flags a deleted attachment, naming who deleted it and who uploaded it', () => {
      const set = build({
        entries: [
          entry('ATTACHMENT_DELETED', { attachment_id: 'a1', file_name: 'x.png', display_name: 'Front door.png', uploaded_by_name: 'Lee Tech', deleted_by_name: 'Sam Office' }, { actor_name: 'Sam Office' }),
        ],
      });
      expect(unusualKeys(set)).toEqual(['attachment:a1']);
      const item = allItems(set)[0]!;
      expect(item.unusual).toBe(true);
      expect(item.title).toBe('File: Front door.png');
      expect(item.summary).toBe('Deleted by Sam Office, uploaded by Lee Tech');
      expect(set.totals.unusual).toBe(1);
      expect(item.unusual_kind).toBe('file_deleted');
    });

    it('names the invoice on a file taken off one of the job\'s invoices, and on an upload read from its description alone (S06.9)', () => {
      const set = build({
        entries: [
          entry('ATTACHMENT_DELETED', { attachment_id: 'a1', display_name: 'Receipt.pdf', invoice_id: 'inv-1', invoice_number: 'INV-7', deleted_by_name: 'Sam Office' }),
          entry('ATTACHMENT_UPLOADED', { attachment_id: 'a2', invoice_id: 'inv-1', invoice_number: 'INV-7' }, { description: 'Invoice INV-7: File uploaded: Scan.pdf' }),
        ],
      });
      const titles = allItems(set).map((i) => i.title).sort();
      expect(titles).toEqual(['Invoice INV-7 file: Receipt.pdf', 'Invoice INV-7 file: Scan.pdf']);
    });

    it('names the kind of each unusual item, for the banner chips', () => {
      const set = build({
        entries: [
          entry('JOB_LINE_REMOVED', { line_id: 'l1', old: line(), new: null }),
          entry('JOB_INVOICE_DISCOUNT_CHANGED', { invoice_id: 'i1', invoice_number: 'INV-1', old: { discount_amount: 0 }, new: { discount_amount: 9 } }),
          entry('JOB_CONTACT_ENTRY_ADDED', { entry_id: 'c1', kind: 'PHONE', intent: 'ADDED', old: null, new: { value: '5551234567', extension: null, label: null } }),
          entry('JOB_LINE_ADDED', { line_id: 'l9', old: null, new: line() }),
        ],
      });
      const kinds = Object.fromEntries(allItems(set).map((i) => [i.key, i.unusual_kind]));
      expect(kinds).toEqual({
        'line:l1': 'price_cut', 'invoice-discount:i1': 'price_cut', 'contact:c1': 'customer_change', 'line:l9': null,
      });
    });

    it('flags a lowered unit price, a removed line and a raised discount on an invoice, and not a price raise', () => {
      const lowered = entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line({ unit_price: 100 }), new: line({ unit_price: 80, line_total: 80 }) });
      const removed = entry('JOB_LINE_REMOVED', { line_id: 'l2', old: line({ name: 'Hinge' }), new: null });
      const invoiceDiscount = entry('JOB_INVOICE_DISCOUNT_CHANGED', { invoice_id: 'i1', invoice_number: 'INV-1', old: { discount_amount: 5 }, new: { discount_amount: 25 } });
      const raised = entry('JOB_LINE_CHANGED', { line_id: 'l3', old: line({ unit_price: 100 }), new: line({ unit_price: 150, line_total: 150 }) });
      const set = build({ entries: [lowered, removed, invoiceDiscount, raised] });
      expect(unusualKeys(set)).toEqual(['line:l1', 'line:l2', 'invoice-discount:i1']);
      expect(allItems(set).find((i) => i.key === 'line:l3')!.unusual).toBe(false);
    });

    it('flags a discount added or raised on the job, and a scope removed or cut, and not a discount lowered', () => {
      const added = entry('JOB_DISCOUNT_CHANGED', { old: { discount_type: null, discount_value: null, discount_amount: 0 }, new: { discount_type: 'FIXED', discount_value: 20, discount_amount: 20 } });
      const cutScope = entry('JOB_SCOPE_CHANGED', { scope_id: 's1', old: { name: 'Install', description: '', flat_price: 200, is_taxable: true }, new: { name: 'Install', description: '', flat_price: 150, is_taxable: true } });
      const goneScope = entry('JOB_SCOPE_REMOVED', { scope_id: 's2', old: { name: 'Haul away', description: '', flat_price: 40, is_taxable: true }, new: null });
      expect(unusualKeys(build({ entries: [added, cutScope, goneScope] }))).toEqual(['discount:job', 'scope:s1', 'scope:s2']);
      const lowered = entry('JOB_DISCOUNT_CHANGED', { old: { discount_type: 'FIXED', discount_value: 20, discount_amount: 20 }, new: { discount_type: 'FIXED', discount_value: 5, discount_amount: 5 } });
      expect(unusualKeys(build({ entries: [lowered] }))).toEqual([]);
    });

    it('judges a line by its net change: a price cut and then restored is not a cut', () => {
      const down = entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line({ unit_price: 100 }), new: line({ unit_price: 80 }) });
      const up = entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line({ unit_price: 80 }), new: line({ unit_price: 100 }) });
      const set = build({ entries: [down, up] });
      expect(unusualKeys(set)).toEqual([]);
      expect(allItems(set)).toHaveLength(1);
    });

    // A first review's window opens at the job's creation, so nearly every line was added INSIDE it: its baseline is the
    // value it had when it was added (PRD 6, M8).
    describe('a line added inside the window', () => {
      const added = (id: string, over: Record<string, unknown> = {}) => entry('JOB_LINE_ADDED', { line_id: id, old: null, new: line(over) });
      const changed = (id: string, from: Record<string, unknown>, to: Record<string, unknown>) =>
        entry('JOB_LINE_CHANGED', { line_id: id, old: line(from), new: line(to) });

      it('flags a line added and then removed as a removed line, and titles it with its name', () => {
        const set = build({ entries: [added('l1', { name: 'Hinge' }), entry('JOB_LINE_REMOVED', { line_id: 'l1', old: line({ name: 'Hinge' }), new: null })] });
        expect(unusualKeys(set)).toEqual(['line:l1']);
        const item = allItems(set)[0]!;
        expect(item.title).toBe('Line: Hinge');
        expect(item.summary).toBe('Line added, then removed');
        expect(item.unusual_reason).toBe('A line was removed');
        expect(item.unusual_kind).toBe('price_cut');
        expect(set.totals.unusual).toBe(1);
      });

      it('takes the name from the add when the removal carries none', () => {
        const set = build({ entries: [added('l1', { name: 'Hinge' }), entry('JOB_LINE_REMOVED', { line_id: 'l1', old: null, new: null })] });
        expect(allItems(set)[0]!.title).toBe('Line: Hinge');
      });

      it('flags a price lowered after the add, and shows what it was added at against what it is now', () => {
        const set = build({
          entries: [added('l1', { quantity: 2, unit_price: 100, line_total: 200 }), changed('l1', { quantity: 2, unit_price: 100, line_total: 200 }, { quantity: 2, unit_price: 80, line_total: 160 })],
        });
        expect(unusualKeys(set)).toEqual(['line:l1']);
        const item = allItems(set)[0]!;
        expect(item.unusual_reason).toBe('A price was lowered');
        expect(item.summary).toContain('$100.00 to $80.00');
        expect(item.summary).not.toContain('Line added');
        expect(item.changes).toContainEqual({ label: 'Unit price', old: '$100.00', new: '$80.00' });
      });

      it('judges the net change from the added value: a price cut and then restored is not a cut, and a raise is not unusual', () => {
        const restored = build({ entries: [added('l1'), changed('l1', { unit_price: 100 }, { unit_price: 80 }), changed('l1', { unit_price: 80 }, { unit_price: 100 })] });
        expect(unusualKeys(restored)).toEqual([]);
        expect(allItems(restored)[0]!.summary).toBe('Line added 1 x $100.00');
        const raised = build({ entries: [added('l1'), changed('l1', { unit_price: 100 }, { unit_price: 150 })] });
        expect(unusualKeys(raised)).toEqual([]);
        expect(allItems(raised)[0]!.summary).toBe('Line added 1 x $150.00');
        const cheaperThanAdded = build({ entries: [added('l1'), changed('l1', { unit_price: 100 }, { unit_price: 150 }), changed('l1', { unit_price: 150 }, { unit_price: 120 })] });
        expect(unusualKeys(cheaperThanAdded)).toEqual([]);
      });

      it('flags a line discount raised after the add', () => {
        const set = build({ entries: [added('l1'), changed('l1', { discount_amount: 0 }, { discount_amount: 10 })] });
        expect(unusualKeys(set)).toEqual(['line:l1']);
        expect(allItems(set)[0]!.unusual_reason).toBe('A discount was added or raised');
      });

      it('applies the same rule to a scope and to an invoice line', () => {
        const scope = (price: number) => ({ name: 'Install', description: '', flat_price: price, is_taxable: true });
        const cut = build({
          entries: [
            entry('JOB_SCOPE_ADDED', { scope_id: 's1', old: null, new: scope(200) }),
            entry('JOB_SCOPE_CHANGED', { scope_id: 's1', old: scope(200), new: scope(150) }),
            entry('JOB_SCOPE_ADDED', { scope_id: 's2', old: null, new: { ...scope(40), name: 'Haul away' } }),
            entry('JOB_SCOPE_REMOVED', { scope_id: 's2', old: { ...scope(40), name: 'Haul away' }, new: null }),
          ],
        });
        expect(unusualKeys(cut)).toEqual(['scope:s1', 'scope:s2']);
        expect(allItems(cut).find((i) => i.key === 'scope:s1')!.summary).toContain('$200.00 to $150.00');
        expect(allItems(cut).find((i) => i.key === 'scope:s2')!.title).toBe('Scope: Haul away');

        const invoiceLine = (price: number) => line({ name: 'Labor', unit_price: price, line_total: price });
        const invoice = build({
          entries: [
            entry('JOB_INVOICE_LINE_ADDED', { invoice_id: 'i1', invoice_number: 'INV-1', line_id: 'x1', old: null, new: invoiceLine(300) }),
            entry('JOB_INVOICE_LINE_REMOVED', { invoice_id: 'i1', invoice_number: 'INV-1', line_id: 'x1', old: null, new: null }),
          ],
        });
        expect(unusualKeys(invoice)).toEqual(['invoice-line:i1:x1']);
        expect(allItems(invoice)[0]!.title).toBe('Invoice INV-1 line: Labor');
      });
    });

    it('flags a live customer detail change, and not an entry removed before the review', () => {
      const live = entry('JOB_CONTACT_ENTRY_ADDED', { entry_id: 'c1', kind: 'PHONE', intent: 'ADDED', old: null, new: { value: '5551234567', extension: null, label: null } });
      const added = entry('JOB_CONTACT_ENTRY_ADDED', { entry_id: 'c2', kind: 'EMAIL', intent: 'ADDED', old: null, new: { value: 'tenant@example.test', extension: null, label: null } }, { actor_name: 'Dana Rivera' });
      const removed = entry('JOB_CONTACT_ENTRY_REMOVED', { entry_id: 'c2', kind: 'EMAIL', intent: 'ADDED', old: { value: 'tenant@example.test', extension: null, label: null }, new: null, restored_customer_value: null }, { actor_name: 'Sam Office' });
      const set = build({ entries: [live, added, removed] });
      expect(unusualKeys(set)).toEqual(['contact:c1']);
      const gone = allItems(set).find((i) => i.key === 'contact:c2')!;
      expect(gone.unusual).toBe(false);
      expect(gone.contact).toMatchObject({ removed: true, kind: 'EMAIL' });
      expect(gone.summary).toBe('Email tenant@example.test: added by Dana Rivera, removed by Sam Office');
      const phone = allItems(set).find((i) => i.key === 'contact:c1')!;
      expect(phone.summary).toBe('Phone (555) 123-4567 added for this job only');
    });

    it('lists an unusual item in the first group and in its own, and counts it once', () => {
      const removed = entry('JOB_LINE_REMOVED', { line_id: 'l2', old: line(), new: null });
      const set = build({ entries: [removed] });
      expect(set.groups.find((g) => g.key === 'lines')!.items.map((i) => i.key)).toEqual(['line:l2']);
      expect(set.groups.find((g) => g.key === 'unusual')!.items.map((i) => i.key)).toEqual(['line:l2']);
      expect(set.totals).toEqual({ items: 2, checked: 0, unusual: 1 });
    });
  });

  describe('notes, files and payments', () => {
    it('shows a deleted note with its text, who wrote it and who deleted it, and it is not unusual', () => {
      const del = entry('NOTE_DELETED', { note_id: 'n9', note_content: 'Call before arriving', written_by_name: 'Lee Tech', deleted_by_name: 'Sam Office' }, { actor_name: 'Sam Office' });
      const item = allItems(build({ entries: [del] }))[0]!;
      expect(item.group).toBe('notes');
      expect(item.summary).toBe('Deleted by Sam Office, written by Lee Tech: Call before arriving');
      expect(item.unusual).toBe(false);
    });

    it('makes one item of a payment and its void, with the amounts', () => {
      const paid = entry('JOB_PAYMENT_RECORDED', { invoice_id: 'i1', invoice_number: 'INV-1', amount: 75, method: 'CHECK', payment_id: 'p1' });
      const voided = entry('JOB_PAYMENT_VOIDED', { invoice_id: 'i1', invoice_number: 'INV-1', amount: 75, method: 'CHECK', payment_id: 'p1' });
      const refund = entry('JOB_REFUND_ISSUED', { invoice_id: 'i1', invoice_number: 'INV-1', amount: 20, method: 'CARD', refund_id: 'r1' });
      const set = build({ entries: [paid, voided, refund] });
      const items = set.groups.find((g) => g.key === 'payments')!.items;
      expect(items.map((i) => i.key)).toEqual(['payment:p1', 'refund:r1']);
      expect(items[0]!.summary).toBe('Payment recorded $75.00 via Check, then Payment voided $75.00 via Check');
      expect(items[1]!.summary).toBe('Refund issued $20.00 via Card');
    });

    it('names an uploaded file from the history line', () => {
      const up = entry('ATTACHMENT_UPLOADED', { attachment_id: 'a1', file_type: 'image/png' }, { description: 'File uploaded: Garage.png' });
      expect(allItems(build({ entries: [up] }))[0]!.title).toBe('File: Garage.png');
    });
  });

  describe('costs', () => {
    it('keeps prices and drops costs from the summary for a person without See costs', () => {
      const withoutCosts = build({ mayCosts: false }).summary;
      expect(withoutCosts.lines).toEqual([{ name: 'Spring', quantity: 2, unit_price: 100, line_total: 200 }]);
      expect('total_cost' in withoutCosts).toBe(false);
      expect(withoutCosts.total).toBe(190);
      const withCosts = build({ mayCosts: true }).summary;
      expect(withCosts.lines[0]!.unit_cost).toBe(60);
      expect(withCosts.total_cost).toBe(120);
    });

    it('never lets a cost in an entry reach an item, with or without the right to see costs', () => {
      const leaky = entry('JOB_LINE_CHANGED', {
        line_id: 'l1',
        old: { ...line(), unit_cost: 40, markup_percent: 50, internal_cost: 33 },
        new: { ...line({ unit_price: 120, line_total: 120 }), unit_cost: 45, markup_percent: 60, internal_cost: 35 },
      });
      for (const mayCosts of [true, false]) {
        const json = JSON.stringify(build({ entries: [leaky], mayCosts }).groups);
        expect(json).not.toMatch(/unit_cost|markup|internal_cost|"45"|\$45|\$40/);
        expect(json).toContain('$120.00');
      }
    });
  });

  describe('checks, decisions and counts', () => {
    it('counts an item as checked only while its check is against its latest entry', () => {
      const first = entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line(), new: line({ quantity: 2, line_total: 200 }) });
      const checks = [{ item_key: 'line:l1', entry_id: first.id, checked_by: 'Sam Office', checked_at: '2026-10-02T10:00:00.000Z' }];
      const set = build({ entries: [first], checks });
      expect(allItems(set)[0]!.checked).toBe(true);
      expect(allItems(set)[0]!.checked_by).toBe('Sam Office');
      expect(set.totals).toEqual({ items: 2, checked: 1, unusual: 0 });

      const second = entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line({ quantity: 2 }), new: line({ quantity: 3, line_total: 300 }) });
      const after = build({ entries: [first, second], checks });
      expect(allItems(after)[0]!.checked).toBe(false);
      expect(allItems(after)[0]!.checked_by).toBeNull();
      expect(after.totals.checked).toBe(0);
    });

    it('ties the job summary check to the latest entry on the job, so any later entry un-checks it', () => {
      const checks = [{ item_key: 'summary', entry_id: 'latest-1', checked_by: 'Sam Office', checked_at: '2026-10-02T10:00:00.000Z' }];
      const still = build({ checks, jobLatestEntryId: 'latest-1' });
      expect(still.summary.checked).toBe(true);
      expect(still.totals).toEqual({ items: 1, checked: 1, unusual: 0 });
      expect(build({ checks, jobLatestEntryId: 'latest-2' }).summary.checked).toBe(false);
      expect(build({ checks, jobLatestEntryId: null }).summary.checked).toBe(false);
    });

    it('passes a decision through on its customer item', () => {
      const added = entry('JOB_CONTACT_ENTRY_ADDED', { entry_id: 'c1', kind: 'PHONE', intent: 'ADDED', old: null, new: { value: '5551234567', extension: null, label: null } });
      const set = build({ entries: [added], decisions: [{ entry_id: 'c1', choice: 'THIS_JOB_ONLY', event_id: added.id }] });
      expect(allItems(set)[0]!.contact!.decision).toBe('THIS_JOB_ONLY');
      expect(allItems(build({ entries: [added] }))[0]!.contact!.decision).toBeNull();
    });
  });

  describe('customer decisions (S06.11)', () => {
    const value = (v: string) => ({ value: v, extension: null, label: null });
    const added = (kind: 'PHONE' | 'EMAIL', id = 'c1') => entry('JOB_CONTACT_ENTRY_ADDED', { entry_id: id, kind, intent: 'ADDED', old: null, new: value(kind === 'PHONE' ? '5551234567' : 'tenant@example.test') });
    const changed = (kind: string, from: string, to: string, id = 'c1') => entry('JOB_CONTACT_ENTRY_CHANGED', { entry_id: id, kind, intent: 'CHANGED', old: value(from), new: value(to) });
    const contactOf = (set: ReturnType<typeof build>, key = 'contact:c1') => allItems(set).find((i) => i.key === key)!;

    it('offers Add and This job only for an added phone or email, defaulting to Add', () => {
      for (const kind of ['PHONE', 'EMAIL'] as const) {
        const item = contactOf(build({ entries: [added(kind)] }));
        expect(item.contact).toMatchObject({ entry_id: 'c1', options: ['ADD', 'THIS_JOB_ONLY'], default_choice: 'ADD', choice: 'ADD', decision: null });
      }
    });

    it('offers Add, Update the customer and This job only for a changed phone or email, defaulting to Add', () => {
      for (const kind of ['PHONE', 'EMAIL']) {
        const item = contactOf(build({ entries: [changed(kind, 'old', 'new')] }));
        expect(item.contact).toMatchObject({ options: ['ADD', 'UPDATE', 'THIS_JOB_ONLY'], default_choice: 'ADD', choice: 'ADD' });
      }
    });

    it('offers This job only and Update the customer for a changed name or company name, defaulting to This job only, with the customer current value', () => {
      const now = { first_name: 'Patricia', last_name: 'Customer', company_name: 'Acme Plumbing' };
      const cases = [['FIRST_NAME', 'Patricia'], ['LAST_NAME', 'Customer'], ['COMPANY_NAME', 'Acme Plumbing']] as const;
      for (const [kind, current] of cases) {
        const item = contactOf(build({ entries: [changed(kind, 'Was', 'Now')], customerNow: now }));
        expect(item.contact).toMatchObject({ options: ['THIS_JOB_ONLY', 'UPDATE'], default_choice: 'THIS_JOB_ONLY', choice: 'THIS_JOB_ONLY', customer_current: current });
      }
      // A phone has no single current value to show beside it.
      expect(contactOf(build({ entries: [changed('PHONE', 'a', 'b')], customerNow: now })).contact!.customer_current).toBeNull();
    });

    it('offers no choice for an entry removed before the review', () => {
      const add = added('EMAIL', 'c2');
      const gone = entry('JOB_CONTACT_ENTRY_REMOVED', { entry_id: 'c2', kind: 'EMAIL', intent: 'ADDED', old: value('tenant@example.test'), new: null, restored_customer_value: null }, { actor_name: 'Sam Office' });
      const item = contactOf(build({ entries: [add, gone] }), 'contact:c2');
      expect(item.contact).toMatchObject({ removed: true, options: [], default_choice: null, choice: null });
    });

    it('counts a customer item as checked only while its decision was made against its latest entry', () => {
      const first = added('PHONE');
      const decision = { entry_id: 'c1', choice: 'ADD', event_id: first.id, decided_by: 'Sam Office', decided_at: '2026-10-02T10:00:00.000Z' };
      const ticked = build({ entries: [first], decisions: [decision] });
      expect(contactOf(ticked)).toMatchObject({ checked: true, checked_by: 'Sam Office', checked_at: '2026-10-02T10:00:00.000Z' });
      expect(ticked.totals).toEqual({ items: 2, checked: 1, unusual: 1 });

      // A correction to the entry un-checks it with no write; the earlier pick stays shown, unticked.
      const fix = entry('JOB_CONTACT_ENTRY_CORRECTED', { entry_id: 'c1', kind: 'PHONE', intent: 'ADDED', old: value('5551234567'), new: value('5551234568') });
      const corrected = build({ entries: [first, fix], decisions: [{ ...decision, choice: 'THIS_JOB_ONLY' }] });
      expect(contactOf(corrected)).toMatchObject({ checked: false, checked_by: null, contact: { decision: 'THIS_JOB_ONLY', choice: 'THIS_JOB_ONLY' } });
      expect(corrected.totals.checked).toBe(0);
    });

    it('ticks a removed entry with a decision that applies nothing', () => {
      const add = added('EMAIL', 'c2');
      const gone = entry('JOB_CONTACT_ENTRY_REMOVED', { entry_id: 'c2', kind: 'EMAIL', intent: 'ADDED', old: value('tenant@example.test'), new: null, restored_customer_value: null });
      const set = build({ entries: [add, gone], decisions: [{ entry_id: 'c2', choice: 'NONE', event_id: gone.id }] });
      expect(contactOf(set, 'contact:c2').checked).toBe(true);
    });

    it('ignores a stored pick that the entry no longer offers', () => {
      // Update on an added phone is never offered; a stale row holding it falls back to the default.
      const first = added('PHONE');
      const item = contactOf(build({ entries: [first], decisions: [{ entry_id: 'c1', choice: 'UPDATE', event_id: first.id }] }));
      expect(item.contact!.choice).toBe('ADD');
    });
  });

  describe('rounds', () => {
    it('shows only the changes after the first round on a second round, with the summary again', () => {
      const firstRound = entry('JOB_LINE_ADDED', { line_id: 'l1', old: null, new: line() });
      const finishedAt = new Date(WINDOW_START.getTime() + (clock + 1) * 60_000);
      clock += 2;
      const secondRound = entry('JOB_LINE_ADDED', { line_id: 'l2', old: null, new: line() });
      const set = build({ entries: [firstRound, secondRound], windowStart: finishedAt });
      expect(allItems(set).map((i) => i.key)).toEqual(['line:l2']);
      expect(set.summary.key).toBe('summary');
      expect(set.totals.items).toBe(2);
    });
  });
});

describe('the review version (S06.12)', () => {
  const lineEntry = () => entry('JOB_LINE_ADDED', { line_id: 'l1', old: null, new: line() });
  const versionOf = (over: Partial<ReviewChangeSetInput> = {}) => reviewVersion(build(over));

  it('is the same for the same review, read twice', () => {
    const e = lineEntry();
    expect(versionOf({ entries: [e], jobLatestEntryId: e.id })).toBe(versionOf({ entries: [e], jobLatestEntryId: e.id }));
  });

  it('changes when anything lands on the job, even an entry the review does not list', () => {
    expect(versionOf({ jobLatestEntryId: 'a' })).not.toBe(versionOf({ jobLatestEntryId: 'b' }));
  });

  it('changes when an item is added, changed or checked', () => {
    const e = lineEntry();
    const base = versionOf({ entries: [e], jobLatestEntryId: e.id });
    expect(versionOf({ jobLatestEntryId: e.id })).not.toBe(base);
    const edit = entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line(), new: line({ unit_price: 90, line_total: 90 }) });
    expect(versionOf({ entries: [e, edit], jobLatestEntryId: edit.id })).not.toBe(base);
    expect(versionOf({ entries: [e], jobLatestEntryId: e.id, checks: [{ item_key: 'line:l1', entry_id: e.id }] })).not.toBe(base);
  });

  it('changes when a customer decision is made or its choice changed, because the decision is what finishing applies', () => {
    const added = entry('JOB_CONTACT_ENTRY_ADDED', { entry_id: 'c1', kind: 'PHONE', intent: 'ADDED', old: null, new: { value: '5551234567', extension: null, label: null } });
    const input = { entries: [added], jobLatestEntryId: added.id };
    const add = versionOf({ ...input, decisions: [{ entry_id: 'c1', choice: 'ADD', event_id: added.id }] });
    const only = versionOf({ ...input, decisions: [{ entry_id: 'c1', choice: 'THIS_JOB_ONLY', event_id: added.id }] });
    expect(new Set([versionOf(input), add, only]).size).toBe(3);
  });

  it('changes when the customer name shown beside a changed name moves', () => {
    const changed = entry('JOB_CONTACT_ENTRY_CHANGED', { entry_id: 'c1', kind: 'FIRST_NAME', intent: 'CHANGED', old: { value: 'Pat', extension: null, label: null }, new: { value: 'Patricia', extension: null, label: null } });
    const at = (first: string) => versionOf({ entries: [changed], jobLatestEntryId: changed.id, customerNow: { first_name: first, last_name: 'Customer', company_name: null } });
    expect(at('Pat')).not.toBe(at('Patty'));
  });

  it('does not depend on whether the person may see costs, so a person who can and one who cannot agree on what changed', () => {
    expect(versionOf({ mayCosts: true })).toBe(versionOf({ mayCosts: false }));
  });

  it('changes when the job summary does: the total, the balance, the files or the notes', () => {
    const base = versionOf();
    expect(versionOf({ details: details({ total: 200 }) })).not.toBe(base);
    expect(versionOf({ details: details({ balance: 0 }) })).not.toBe(base);
    expect(versionOf({ details: details({ file_count: 4 }) })).not.toBe(base);
    expect(versionOf({ details: details({ note_count: 3 }) })).not.toBe(base);
  });
});

describe('what is left to check (S06.12)', () => {
  it('names the job summary first, then each unchecked item once (the unusual group lists some twice), and nothing when all is checked', () => {
    const cut = entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line(), new: line({ unit_price: 90, line_total: 90 }) });
    const note = entry('JOB_NOTE_ADDED', { note_id: 'n1', note_content: 'Hi' });
    const input = { entries: [cut, note], jobLatestEntryId: note.id };
    expect(itemsLeft(build(input))).toEqual(['Job details', 'Line: Spring', 'Note']);
    const checks = [{ item_key: 'summary', entry_id: note.id }, { item_key: 'line:l1', entry_id: cut.id }, { item_key: 'note:n1', entry_id: note.id }];
    expect(itemsLeft(build({ ...input, checks }))).toEqual([]);
    expect(itemsLeft(build({ ...input, checks: checks.slice(0, 2) }))).toEqual(['Note']);
  });
});


describe('a second review round (S06.16)', () => {
  // Round one covered everything up to its finish; round two's window opens there, so the entries are the same history
  // read from a later start.
  const added = entry('JOB_LINE_ADDED', { line_id: 'l1', old: null, new: line({ name: 'Hinge', unit_price: 100, line_total: 100 }) });
  const untouched = entry('JOB_LINE_ADDED', { line_id: 'l2', old: null, new: line({ name: 'Bracket', unit_price: 20, line_total: 20 }) });
  const firstFinish = new Date(Math.max(+added.created_at, +untouched.created_at) + 30_000);
  const lowered = entry('JOB_LINE_CHANGED', { line_id: 'l1', old: line({ name: 'Hinge', unit_price: 100, line_total: 100 }), new: line({ name: 'Hinge', unit_price: 80, line_total: 80 }) }, { created_at: new Date(firstFinish.getTime() + 60_000) });
  const history = [added, untouched, lowered];

  it('shows the job summary again, and only the changes after the previous round\'s finish', () => {
    const roundOne = build({ entries: history.slice(0, 2), jobLatestEntryId: untouched.id });
    expect(allItems(roundOne).map((i) => i.key).sort()).toEqual(['line:l1', 'line:l2']);

    const roundTwo = build({ entries: history, windowStart: firstFinish, jobLatestEntryId: lowered.id });
    expect(roundTwo.summary.checked).toBe(false);
    expect(allItems(roundTwo).map((i) => i.key)).toEqual(['line:l1']);
    expect(roundTwo.totals).toEqual({ items: 2, checked: 0, unusual: 1 });
  });

  it('judges a line added in round one and lowered in round two against the price it had at round one\'s finish', () => {
    const roundTwo = build({ entries: history, windowStart: firstFinish, jobLatestEntryId: lowered.id });
    const item = allItems(roundTwo)[0]!;
    expect(item.unusual).toBe(true);
    expect(item.unusual_reason).toBe('A price was lowered');
    expect(item.summary).toContain('$100.00 to $80.00');
    expect(item.summary).not.toContain('Line added');
  });

  it('starts unchecked: the checks made in round one belong to round one and are not handed to round two', () => {
    // The reader hands M8 only the open round's checks; with none, nothing is checked even on an item round one had checked.
    const roundTwo = build({ entries: history, windowStart: firstFinish, jobLatestEntryId: lowered.id, checks: [] });
    expect(allItems(roundTwo).every((i) => !i.checked)).toBe(true);
    expect(roundTwo.totals.checked).toBe(0);
  });
});
