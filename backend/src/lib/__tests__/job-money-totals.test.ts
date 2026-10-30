import { describe, it, expect } from 'vitest';
import { jobMoneyTotals, type JobMoneyInvoice } from '../job-money-totals';

/** Roles & Permissions, PRD 6, S06.13: what a job owes. Adding an invoice never lowers it. */

const invoice = (o: Partial<JobMoneyInvoice> & { total: number; paid?: number; due?: number; credit?: number }): JobMoneyInvoice => ({
  kind: o.kind ?? 'STANDARD',
  status: o.status ?? 'SENT',
  voided_at: o.voided_at ?? null,
  total_amount: o.total,
  amount_due: o.due ?? o.total,
  payments: [
    ...(o.paid ? [{ amount: o.paid, state: 'SUCCEEDED', reference_number: null }] : []),
    ...(o.credit ? [{ amount: o.credit, state: 'SUCCEEDED', reference_number: 'DEPOSIT-CREDIT' }] : []),
  ],
});

const owedOn = async (invoices: JobMoneyInvoice[], opts: { estimate?: number; own?: number } = {}) =>
  (await jobMoneyTotals({ invoices, estimateTotal: opts.estimate ?? null, attachedEstimates: [], ownTotal: async () => opts.own ?? 0 })).balance_due;

describe('jobMoneyTotals balance_due', () => {
  it('owes what one partly paid invoice has left', async () => {
    expect(await owedOn([invoice({ total: 100, paid: 40 })])).toBe(60);
  });

  it('is not lowered by a small invoice added later, sent or draft', async () => {
    const first = invoice({ total: 86.56, paid: 5, due: 81.56, status: 'PARTIAL' });
    expect(await owedOn([first])).toBe(81.56);
    expect(await owedOn([first, invoice({ total: 1, status: 'DRAFT' })])).toBe(82.56);
    expect(await owedOn([first, invoice({ total: 1 })])).toBe(82.56);
  });

  it('keeps the priced lines as the contract while only drafts exist', async () => {
    expect(await owedOn([], { own: 324.6 })).toBe(324.6);
    expect(await owedOn([invoice({ total: 1, status: 'DRAFT' })], { own: 324.6 })).toBe(324.6);
    expect(await owedOn([invoice({ total: 400, status: 'DRAFT' })], { own: 324.6 })).toBe(400);
  });

  it('is not lowered by a small invoice that is sent or paid: the work not yet invoiced is still owed', async () => {
    expect(await owedOn([], { own: 324.6 })).toBe(324.6);
    expect(await owedOn([invoice({ total: 1 })], { own: 324.6 })).toBe(324.6);
    expect(await owedOn([invoice({ total: 1, status: 'PAID', paid: 1, due: 0 })], { own: 324.6 })).toBe(323.6);
    expect(await owedOn([invoice({ total: 0 })], { own: 324.6 })).toBe(324.6);
    // Sold from an estimate, the same.
    expect(await owedOn([invoice({ total: 1, status: 'PAID', paid: 1, due: 0 })], { estimate: 800 })).toBe(799);
    expect(await owedOn([invoice({ total: 0 })], { estimate: 800 })).toBe(800);
  });

  it('owes the larger of what the invoices have due and what the job was sold for less what was paid', async () => {
    // An invoice for more than the job was sold for owes its own due.
    expect(await owedOn([invoice({ total: 500 })], { own: 324.6 })).toBe(500);
    // Billed in full and paid in full owes nothing.
    expect(await owedOn([invoice({ total: 324.6, status: 'PAID', paid: 324.6, due: 0 })], { own: 324.6 })).toBe(0);
    // Billed in two draws that together cover the work.
    expect(await owedOn([invoice({ total: 100, paid: 100, due: 0, status: 'PAID' }), invoice({ total: 224.6 })], { own: 324.6 })).toBe(224.6);
    // The balance card's contract never reads below what was invoiced or what the job was sold for.
    const totals = await jobMoneyTotals({ invoices: [invoice({ total: 1, status: 'PAID', paid: 1, due: 0 })], estimateTotal: null, attachedEstimates: [], ownTotal: async () => 324.6 });
    expect(totals).toMatchObject({ contract_total: 324.6, paid: 1, balance_due: 323.6 });
  });

  it('counts both draws of a job billed twice, and lets no overpayment offset another invoice', async () => {
    expect(await owedOn([invoice({ total: 100, paid: 30, due: 70 }), invoice({ total: 200, paid: 50, due: 150 })])).toBe(220);
    expect(await owedOn([invoice({ total: 100, paid: 130, due: 0, status: 'PAID' }), invoice({ total: 100 })])).toBe(100);
  });

  it('treats a deposit as part of the contract: drawn or not yet drawn, never on top', async () => {
    const deposit = invoice({ kind: 'DEPOSIT', status: 'PAID', total: 100, paid: 100, due: 0 });
    expect(await owedOn([deposit, invoice({ total: 437.5, due: 337.5, credit: 100, status: 'PARTIAL' })])).toBe(337.5);
    expect(await owedOn([deposit, invoice({ total: 437.5 })])).toBe(337.5);
    expect(await owedOn([invoice({ kind: 'DEPOSIT', total: 100 }), invoice({ total: 437.5 })])).toBe(437.5);
  });

  it('counts a voided invoice for nothing, and a credit comes off what is due', async () => {
    expect(await owedOn([invoice({ total: 100 }), invoice({ total: 500, status: 'VOIDED' })])).toBe(100);
    expect(await owedOn([invoice({ total: 100, paid: 0, due: 60 })])).toBe(60);
  });

  it('never owes a zero-total job or a plan visit job', async () => {
    expect(await owedOn([invoice({ total: 0 })])).toBe(0);
    expect(await owedOn([])).toBe(0);
    const plan = await jobMoneyTotals({ invoices: [invoice({ total: 90 })], estimateTotal: null, attachedEstimates: [], ownTotal: async () => 90, billedUpfront: true });
    expect(plan.balance_due).toBe(0);
  });
});
