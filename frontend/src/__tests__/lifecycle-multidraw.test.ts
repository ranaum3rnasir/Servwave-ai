import { describe, it, expect } from 'vitest';
import { computeLifecycle } from '@/lib/jobs/lifecycle';

const job = {
  created_at: '2026-03-01T09:00:00Z',
  scheduled_start: '2026-03-02T09:00:00Z',
  on_site_at: '2026-03-02T10:00:00Z',
  completed_at: '2026-03-02T16:00:00Z',
  status: 'COMPLETED',
  cancelled_at: null,
};
const stage = (s: ReturnType<typeof computeLifecycle>, k: string) => s.find((x) => x.key === k)!;

describe('multi-draw lifecycle semantics', () => {
  it('keeps Invoice Sent reached when a LATER draft supersedes a sent draw', () => {
    const stages = computeLifecycle(job, {
      final_invoice: { invoice_number: 'I00002', status: 'DRAFT', sent_at: null, paid_at: null, amount_due: 4000 },
      first_sent_at: '2026-03-10T12:00:00Z',
      total_invoiced: 7000,
      total_paid: 0,
    } as never);
    expect(stage(stages, 'invoice_sent').reached).toBe(true);
    expect(stage(stages, 'invoice_sent').at).toBe('2026-03-10T12:00:00Z');
  });

  it('marks Payment Received only when the whole job is paid off', () => {
    const partly = computeLifecycle(job, {
      final_invoice: null, first_sent_at: '2026-03-10T12:00:00Z', total_invoiced: 7000, total_paid: 3000,
    } as never);
    expect(stage(partly, 'payment_received').reached).toBe(false);

    const fully = computeLifecycle(job, {
      final_invoice: null, first_sent_at: '2026-03-10T12:00:00Z', total_invoiced: 7000, total_paid: 7000,
    } as never);
    expect(stage(fully, 'payment_received').reached).toBe(true);
  });

  it('does not mark Payment Received on a job that was never invoiced', () => {
    // 0 >= 0 is true — the trap. An uninvoiced job must not read as paid.
    const stages = computeLifecycle(job, {
      final_invoice: null, first_sent_at: null, total_invoiced: 0, total_paid: 0,
    } as never);
    expect(stage(stages, 'payment_received').reached).toBe(false);
    expect(stage(stages, 'invoice_sent').reached).toBe(false);
  });

  it('treats an overpayment as paid, not as unpaid', () => {
    const stages = computeLifecycle(job, {
      final_invoice: null, first_sent_at: '2026-03-10T12:00:00Z', total_invoiced: 7000, total_paid: 7600,
    } as never);
    expect(stage(stages, 'payment_received').reached).toBe(true);
  });

  it('falls back to final_invoice.status when the totals are stripped (price-blind requester)', () => {
    // stripFinancialsForRequester removes total_invoiced/total_paid AND final_invoice.amount_due,
    // keeping status. The bar must still read correctly, not report everything unpaid.
    const stages = computeLifecycle(job, {
      final_invoice: { invoice_number: 'I00001', status: 'PAID', sent_at: '2026-03-10T12:00:00Z', paid_at: '2026-03-12T12:00:00Z' },
      first_sent_at: '2026-03-10T12:00:00Z',
    } as never);
    expect(stage(stages, 'invoice_sent').reached).toBe(true);
    expect(stage(stages, 'payment_received').reached).toBe(true);
  });

  it('still works for the single-invoice case it replaces', () => {
    const stages = computeLifecycle(job, {
      final_invoice: { invoice_number: 'I00001', status: 'SENT', sent_at: '2026-03-10T12:00:00Z', paid_at: null, amount_due: 900 },
      first_sent_at: '2026-03-10T12:00:00Z', total_invoiced: 900, total_paid: 0,
    } as never);
    expect(stage(stages, 'invoice_sent').reached).toBe(true);
    expect(stage(stages, 'payment_received').reached).toBe(false);
  });
});
