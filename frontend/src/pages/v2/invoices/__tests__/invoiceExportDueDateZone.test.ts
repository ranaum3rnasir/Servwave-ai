/**
 * Defect B, second copy - the invoices list CSV export built its own date strings with
 * `new Date(iso).toLocaleDateString()`, so it stayed in the VIEWER's zone even while the
 * `Status` field beside it was already counted on the ORG's clock (`isOverdue(inv, tz)`).
 * Half on each clock is worse than wholly wrong: the CSV could print `OVERDUE` next to a
 * due date that had not arrived. See test 10 below.
 *
 * Viewer zone (`process.env.TZ` = Asia/Manila, UTC+8) deliberately OPPOSES the org zone
 * (America/New_York, UTC-4 in July) - a test where the two agree passes under the old
 * code too and proves nothing.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import { toInvoiceExportRow, type InvoiceListItem } from '../invoicesColumns';

const NY = 'America/New_York';
const MANILA = 'Asia/Manila';

// Staging invoice I00118 (ServWave Test), QA's repro: 02:35 UTC on 7/11 is 22:35 on 7/10
// in New York, but 10:35 on 7/11 in Manila. The org day is the 10th.
const I00118_DUE = '2026-07-11T02:35:09.368Z';

function invoice(over: Partial<InvoiceListItem>): InvoiceListItem {
  return {
    id: 'inv-1',
    invoice_number: 'I00118',
    status: 'SENT',
    kind: 'STANDARD',
    subtotal: 100,
    discount_amount: 0,
    tax_amount: 0,
    deposit_credit: 0,
    total_amount: 100,
    amount_due: 100,
    due_date: null,
    sent_at: null,
    paid_at: null,
    created_at: '2026-06-01T12:00:00.000Z',
    customer: { id: 'c-1', first_name: 'Ada', last_name: 'Lovelace', company_name: null },
    job: null,
    ...over,
  } as InvoiceListItem;
}

let originalTz: string | undefined;

beforeEach(() => {
  originalTz = process.env.TZ;
  process.env.TZ = MANILA;
  // A vacuous pin would let every assertion below pass under the OLD code.
  expect(Intl.DateTimeFormat().resolvedOptions().timeZone).toBe(MANILA);
});

afterEach(() => {
  process.env.TZ = originalTz;
  vi.useRealTimers();
});

describe('the invoices CSV export renders dates on the org clock', () => {
  it('exports the due date on the org calendar day, not the viewer\'s', () => {
    const row = toInvoiceExportRow(invoice({ due_date: I00118_DUE }), NY);

    expect(row['Due Date']).toBe('7/10/2026');
  });

  it('exports the created day on the org calendar day', () => {
    const row = toInvoiceExportRow(invoice({ created_at: I00118_DUE }), NY);

    expect(row['Created']).toBe('7/10/2026');
  });

  it('exports an empty cell, not "Invalid Date", for an invoice with no due date', () => {
    const row = toInvoiceExportRow(invoice({ due_date: null }), NY);

    expect(row['Due Date']).toBe('');
  });

  // The reason the export is in scope at all: Status is derived on the ORG clock, so a
  // viewer-zone due date can read as a day that has not arrived beside an OVERDUE stamp.
  it('never exports OVERDUE beside a due date that has not arrived', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-07-10T13:00:00.000Z')); // 09:00 on 7/10 in New York

    const row = toInvoiceExportRow(invoice({ status: 'SENT', due_date: I00118_DUE }), NY);

    expect(row['Status']).toBe('SENT');
    expect(row['Due Date']).toBe('7/10/2026');
  });
});
