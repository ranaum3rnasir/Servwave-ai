import { describe, it, expect } from 'vitest';
import { toInvoiceForPdf } from '../invoice-select';

// Real invoicePdfSelect rows nest service_location under `job` (a job-anchored invoice) — the
// template reads it as a top-level `service_location` field. Before toInvoiceForPdf existed, a
// bare `{ ...invoice, discount_name: null }` spread silently dropped this reshape, so every
// job-anchored invoice PDF printed "Same as billing" regardless of the job's real site.
describe('toInvoiceForPdf', () => {
  const BASE_ROW = {
    invoice_number: 'I00001',
    status: 'SENT',
    created_at: new Date('2026-04-01T12:00:00Z'),
    due_date: null,
    subtotal: 100,
    discount_amount: 0,
    tax_rate: 0,
    tax_amount: 0,
    deposit_credit: 0,
    total_amount: 100,
    amount_due: 100,
    scopes: null,
    customer: {
      first_name: 'Jane',
      last_name: 'Doe',
      company_name: null,
      email: 'jane@example.com',
      phone: null,
      service_locations: [],
    },
    line_items: [],
    payments: [],
  };

  it('lifts job.service_location to a top-level service_location field', () => {
    const row = {
      ...BASE_ROW,
      job: {
        service_location: {
          address_line1: '999 Job Site Rd',
          address_line2: null,
          city: 'Newark',
          state: 'NJ',
          zip: '07102',
        },
      },
    };

    const doc = toInvoiceForPdf(row);

    expect(doc.service_location).toEqual(row.job.service_location);
  });

  it('maps a job-less invoice (no job) to a null service_location', () => {
    const row = { ...BASE_ROW, job: null };

    const doc = toInvoiceForPdf(row);

    expect(doc.service_location).toBeNull();
  });

  it('always sets discount_name to null — Invoice has no such column', () => {
    const row = { ...BASE_ROW, job: null };

    const doc = toInvoiceForPdf(row);

    expect(doc.discount_name).toBeNull();
  });

  // The deposit is already printed as its own "Deposit credit" line (invoice.deposit_credit);
  // applyDepositCredit also records it as a Payment row (reference_number = 'DEPOSIT-CREDIT',
  // see invoice.controller.ts) so it draws down the deposit invoice's balance. Carrying that
  // row into `payments` too would make activePaymentsTotal's "Payments" line double-subtract it.
  it('excludes the synthetic DEPOSIT-CREDIT payment row from payments', () => {
    const row = {
      ...BASE_ROW,
      job: null,
      payments: [
        { amount: 100, voided_at: null, reference_number: null },
        { amount: 948.13, voided_at: null, reference_number: 'DEPOSIT-CREDIT' },
      ],
    };

    const doc = toInvoiceForPdf(row);

    expect(doc.payments.map((p: any) => p.amount)).toEqual([100]);
  });
});
