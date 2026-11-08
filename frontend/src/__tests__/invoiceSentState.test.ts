import { describe, it, expect } from 'vitest';
import { selectInvoiceSentState } from '@/lib/jobs/invoiceSentState';

const sent = { id: 'i1', invoice_number: 'I00001', status: 'SENT', sent_at: '2026-03-10T12:00:00Z', paid_at: null };
const draft = { id: 'i2', invoice_number: 'I00002', status: 'DRAFT', sent_at: null, paid_at: null };

describe('selectInvoiceSentState', () => {
  it('State 1 when the job has a sent invoice', () => {
    const s = selectInvoiceSentState({ final_invoice: sent, first_sent_at: sent.sent_at } as never, 0);
    expect(s.state).toBe(1);
    expect(s.invoice?.id).toBe('i1');
  });

  it('State 1 on an earlier sent draw even when the newest invoice is a draft', () => {
    // Multi-draw (Task 5): first_sent_at is the truth, final_invoice is just the newest.
    const s = selectInvoiceSentState({ final_invoice: draft, first_sent_at: '2026-03-10T12:00:00Z' } as never, 0);
    expect(s.state).toBe(1);
  });

  it('State 2 when the only invoice is a draft — never offers to create a second', () => {
    const s = selectInvoiceSentState({ final_invoice: draft, first_sent_at: null } as never, 3);
    expect(s.state).toBe(2);
    expect(s.invoice?.invoice_number).toBe('I00002');
  });

  it('State 3 when there are billable lines and no invoice', () => {
    expect(selectInvoiceSentState({ final_invoice: null, first_sent_at: null } as never, 3).state).toBe(3);
  });

  it('State 4 when there is nothing billable at all', () => {
    expect(selectInvoiceSentState({ final_invoice: null, first_sent_at: null } as never, 0).state).toBe(4);
  });

  it('State 4 when financials have not loaded yet — never a dead end', () => {
    expect(selectInvoiceSentState(undefined, 0).state).toBe(4);
  });
});
