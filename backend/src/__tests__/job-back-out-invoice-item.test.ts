/* =============================================================================
   Roles & Permissions, PRD 6, slice S06.24 (fix) - the History sentence of a job sent back by an invoice item.

   "Job J moved back from Ready to close to Office review. A price was lowered: Invoice 123 line: Door." names an invoice line.
   A reader who cannot open that invoice gets the move without the item, whatever the entry was written with.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { invoiceIdsOfMovedBack, withoutInvoiceItems, JOB_MOVED_BACK_EVENT } from '../lib/job-back-out';

const moved = (metadata: Record<string, unknown>, description = 'Job J-1 moved back from Ready to close to Office review. A price was lowered: Invoice 123 line: Door.') => ({
  event_type: JOB_MOVED_BACK_EVENT, description, metadata: { door: 'unusual_change', from: 'READY_TO_CLOSE', to: 'OFFICE_REVIEW', review_id: 'r1', ...metadata },
});

describe('withoutInvoiceItems', () => {
  it('cuts the item from the sentence and the entry when the reader cannot open one of the invoices it names', () => {
    const entry = moved({ item_key: 'invoice-line:inv-1:l1', item_title: 'Invoice 123 line: Door', change_reason: 'A price was lowered', invoice_ids: ['inv-1'] });
    const [shown] = withoutInvoiceItems([entry], new Set());
    expect(shown!.description).toBe('Job J-1 moved back from Ready to close to Office review');
    expect(shown!.metadata).toEqual({ door: 'unusual_change', from: 'READY_TO_CLOSE', to: 'OFFICE_REVIEW', review_id: 'r1' });
  });

  it('keeps the entry whole for a reader who can open every invoice it names, and for an item about no invoice', () => {
    const named = moved({ item_title: 'Invoice 123 line: Door', invoice_ids: ['inv-1', 'inv-2'] });
    expect(withoutInvoiceItems([named], new Set(['inv-1', 'inv-2']))).toEqual([named]);
    const job = moved({ item_key: 'line:l1', item_title: 'Line: Door' }, 'Job J-1 moved back from Ready to close to Office review. A price was lowered: Line: Door.');
    expect(withoutInvoiceItems([job], new Set())).toEqual([job]);
  });

  it('cuts it when only some of the invoices it names can be opened', () => {
    const [shown] = withoutInvoiceItems([moved({ invoice_ids: ['inv-1', 'inv-2'] })], new Set(['inv-1']));
    expect(shown!.description).not.toContain('Invoice');
  });

  it('leaves every other entry alone', () => {
    const other = { event_type: 'JOB_NOTE_ADDED', description: 'Note added. Invoice 123', metadata: { invoice_ids: ['inv-1'] } };
    expect(withoutInvoiceItems([other], new Set())).toEqual([other]);
  });
});

describe('invoiceIdsOfMovedBack', () => {
  it('reads an entry written before the ids were kept from the item key, and treats an invoice file it cannot trace as unopenable', () => {
    expect(invoiceIdsOfMovedBack({ item_key: 'invoice-line:inv-1:l1' })).toEqual(['inv-1']);
    expect(invoiceIdsOfMovedBack({ item_key: 'invoice-discount:inv-2' })).toEqual(['inv-2']);
    expect(invoiceIdsOfMovedBack({ item_key: 'attachment:a1', item_title: 'Invoice 123 file: Receipt.pdf' })).toEqual(['unknown-invoice']);
    expect(invoiceIdsOfMovedBack({ item_key: 'attachment:a1', item_title: 'File: Door.png' })).toEqual([]);
    expect(invoiceIdsOfMovedBack(null)).toEqual([]);
  });
});
