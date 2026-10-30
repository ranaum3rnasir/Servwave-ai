/**
 * invoice-due-cron.test.ts
 *
 * TDD for Task 3.9: daily cron that emits invoice overdue / due-soon notifications.
 *
 * Verbs covered:
 *   - billing.invoice_overdue   — due_date < now
 *   - billing.invoice_due_soon  — now <= due_date <= now + 3 days
 *
 * Strategy:
 *   - vi.mock captures the billing alert the sweep asks for (S06.28: it goes through M6's two-lane chain, so who it reaches is
 *     permission-billing-alerts-db.test.ts; here the sweep is held to WHAT it asks for and HOW MANY reads it costs).
 *   - prisma.invoice.findMany is mocked directly (no supertest — cron is a pure function).
 *   - Fixed now = 2026-06-18T12:00:00Z for deterministic date assertions.
 *   - dedupKey format: `${verb}:${invoice.id}:YYYY-MM-DD` (daily, per-invoice).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { runInvoiceDueChecks } from '../services/notifications/invoiceDueCron';

// ─── Mock the billing alert sender ───────────────────────────────────────────

vi.mock('../services/notifications/invoiceBillingAlerts', async (original) => ({
  ...(await original<typeof import('../services/notifications/invoiceBillingAlerts')>()),
  alertInvoice: vi.fn().mockResolvedValue([]),
}));

// Import AFTER mock is registered so we get the spy reference.
import { alertInvoice as emit } from '../services/notifications/invoiceBillingAlerts';
const mockEmit = emit as ReturnType<typeof vi.fn>;

// ─── Prisma typed surface ─────────────────────────────────────────────────────

const mockPrisma = prisma as unknown as {
  invoice: {
    findMany: ReturnType<typeof vi.fn>;
  };
  notification: {
    findMany: ReturnType<typeof vi.fn>;
  };
};

// ─── Constants ────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-06-18T12:00:00Z');
const TODAY_DATE = '2026-06-18';

const ORG_A = '00000000-0000-0000-0000-000000000001';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

/** An open invoice as the sweep reads it: with the people it needs for the alert (INVOICE_PEOPLE_SELECT). */
function makeInvoice(overrides: {
  id?: string;
  invoice_number?: string;
  due_date?: Date | null;
  organization_id?: string;
  job?: any;
  estimate?: any;
} = {}) {
  return {
    id: 'inv-1',
    invoice_number: 'I00001',
    due_date: new Date('2026-06-17T00:00:00Z'), // yesterday (overdue) by default
    organization_id: ORG_A,
    job_id: 'job-1',
    job: { salesperson_id: '00000000-0000-0000-0000-000000000099', dispatcher_id: null, visits: [] },
    estimate: null,
    ...overrides,
  };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  mockEmit.mockResolvedValue([]);
  // Nothing was sent today yet.
  mockPrisma.notification.findMany.mockResolvedValue([]);
});

// ═══════════════════════════════════════════════════════════════════════════════
// Test cases
// ═══════════════════════════════════════════════════════════════════════════════

describe('runInvoiceDueChecks', () => {
  // ─── Case 1: overdue invoice ───────────────────────────────────────────────

  it('emits billing.invoice_overdue for an invoice due yesterday', async () => {
    const invoice = makeInvoice({
      due_date: new Date('2026-06-17T00:00:00Z'), // yesterday
    });
    mockPrisma.invoice.findMany.mockResolvedValue([invoice]);

    await runInvoiceDueChecks(FIXED_NOW);

    expect(mockEmit).toHaveBeenCalledOnce();
    const args = mockEmit.mock.calls[0][0];
    expect(args.verb).toBe('billing.invoice_overdue');
    expect(args.organizationId).toBe(ORG_A);
    expect(args.object.type).toBe('INVOICE');
    expect(args.object.id).toBe(invoice.id);
    expect(args.object.label).toBe(invoice.invoice_number);
    expect(args.actorId).toBeNull();
    expect(args.dedupKey).toBe(`billing.invoice_overdue:${invoice.id}:${TODAY_DATE}`);
    expect(args.data.due_date).toBe(invoice.due_date!.toISOString());
    expect(args.data.object_label).toBe(invoice.invoice_number);
  });

  // ─── Case 2: due-soon invoice (within 3 days) ─────────────────────────────

  it('emits billing.invoice_due_soon for an invoice due in 2 days', async () => {
    const invoice = makeInvoice({
      id: 'inv-2',
      invoice_number: 'I00002',
      due_date: new Date('2026-06-20T00:00:00Z'), // +2 days from FIXED_NOW
    });
    mockPrisma.invoice.findMany.mockResolvedValue([invoice]);

    await runInvoiceDueChecks(FIXED_NOW);

    expect(mockEmit).toHaveBeenCalledOnce();
    const args = mockEmit.mock.calls[0][0];
    expect(args.verb).toBe('billing.invoice_due_soon');
    expect(args.object.id).toBe(invoice.id);
    expect(args.actorId).toBeNull();
    expect(args.dedupKey).toBe(`billing.invoice_due_soon:${invoice.id}:${TODAY_DATE}`);
  });

  // ─── Case 3: invoice due far in the future (no emit) ──────────────────────

  it('does NOT emit for an invoice due in 10 days', async () => {
    const invoice = makeInvoice({
      id: 'inv-3',
      invoice_number: 'I00003',
      due_date: new Date('2026-06-28T00:00:00Z'), // +10 days
    });
    mockPrisma.invoice.findMany.mockResolvedValue([invoice]);

    await runInvoiceDueChecks(FIXED_NOW);

    expect(mockEmit).not.toHaveBeenCalled();
  });

  // ─── Case 4: the invoice's people ride in with the invoice ────────────────

  it('hands the invoice and its people to the alert, so the alert reads nothing about the invoice and names no seller', async () => {
    const invoice = makeInvoice({ due_date: new Date('2026-06-17T00:00:00Z') });
    mockPrisma.invoice.findMany.mockResolvedValue([invoice]);

    await runInvoiceDueChecks(FIXED_NOW);

    const args = mockEmit.mock.calls[0][0];
    expect(args.known).toBe(invoice);
    expect(args).not.toHaveProperty('entity');
    // The sweep reads the people with the invoices, in the one read.
    const select = mockPrisma.invoice.findMany.mock.calls[0][0].select;
    expect(select).toMatchObject({ job_id: true, job: expect.anything(), estimate: expect.anything() });
  });

  // ─── Case 5: actorId is always null (system cron, no user) ───────────────

  it('always sets actorId to null (system-initiated cron)', async () => {
    const invoice = makeInvoice({
      due_date: new Date('2026-06-17T00:00:00Z'),
    });
    mockPrisma.invoice.findMany.mockResolvedValue([invoice]);

    await runInvoiceDueChecks(FIXED_NOW);

    const args = mockEmit.mock.calls[0][0];
    expect(args.actorId).toBeNull();
  });

  // ─── Case 6: dedupKey includes the correct date portion ──────────────────

  it('dedupKey date portion is the YYYY-MM-DD of `now`, not the due_date', async () => {
    const invoice = makeInvoice({
      id: 'inv-6',
      // due_date is Feb 10 — well in the past, but today (FIXED_NOW) is 2026-06-18
      due_date: new Date('2026-02-10T00:00:00Z'),
    });
    mockPrisma.invoice.findMany.mockResolvedValue([invoice]);

    await runInvoiceDueChecks(FIXED_NOW);

    const args = mockEmit.mock.calls[0][0];
    // The date in the key must be today's date (from `now`), not the due_date
    expect(args.dedupKey).toContain(TODAY_DATE);
    expect(args.dedupKey).not.toContain('2026-02-10');
  });

  // ─── Case 7: a company-sized sweep does not repeat its company-wide reads ─

  it('asks once what was sent today for all the invoices, and reads each company\'s switch holders once for the whole run', async () => {
    const invoices = Array.from({ length: 30 }, (_, i) => makeInvoice({ id: `inv-many-${i}`, invoice_number: `I${i}` }));
    mockPrisma.invoice.findMany.mockResolvedValue(invoices);

    await runInvoiceDueChecks(FIXED_NOW);

    expect(mockEmit).toHaveBeenCalledTimes(30);
    // One read of "sent already" for thirty invoices, not one per invoice; each alert is told it was asked.
    expect(mockPrisma.notification.findMany).toHaveBeenCalledTimes(1);
    expect(mockEmit.mock.calls.every((c: any[]) => c[0].dedupChecked === true)).toBe(true);
    // The same remembering reader of "who holds this switch" is shared by every alert of the run.
    const readers = new Set(mockEmit.mock.calls.map((c: any[]) => c[0].holdersOf));
    expect(readers.size).toBe(1);
    expect(typeof [...readers][0]).toBe('function');
  });

  it('skips an invoice that was alerted earlier today (the plain alert or the one that carries the why line)', async () => {
    const plain = makeInvoice({ id: 'inv-plain' });
    const why = makeInvoice({ id: 'inv-why' });
    const fresh = makeInvoice({ id: 'inv-fresh' });
    mockPrisma.invoice.findMany.mockResolvedValue([plain, why, fresh]);
    mockPrisma.notification.findMany.mockResolvedValue([
      { dedup_key: `billing.invoice_overdue:inv-plain:${TODAY_DATE}` },
      { dedup_key: `billing.invoice_overdue:inv-why:${TODAY_DATE}:why` },
    ]);

    await runInvoiceDueChecks(FIXED_NOW);

    expect(mockEmit.mock.calls.map((c: any[]) => c[0].object.id)).toEqual(['inv-fresh']);
  });

  it('if it cannot tell what was sent today, each alert checks for itself rather than the sweep staying silent', async () => {
    mockPrisma.invoice.findMany.mockResolvedValue([makeInvoice()]);
    mockPrisma.notification.findMany.mockRejectedValue(new Error('read failed'));

    await runInvoiceDueChecks(FIXED_NOW);

    expect(mockEmit).toHaveBeenCalledOnce();
    expect(mockEmit.mock.calls[0][0].dedupChecked).toBe(false);
  });

  // ─── Case 8: no invoices → emit never called ──────────────────────────────

  it('does nothing when there are no SENT/PARTIAL invoices with a due_date', async () => {
    mockPrisma.invoice.findMany.mockResolvedValue([]);

    await runInvoiceDueChecks(FIXED_NOW);

    expect(mockEmit).not.toHaveBeenCalled();
  });

  // ─── Case 9: error on one invoice does not prevent others ────────────────

  it('continues processing remaining invoices if emit throws on one', async () => {
    const overdue = makeInvoice({ id: 'inv-fail', due_date: new Date('2026-06-17T00:00:00Z') });
    const dueSoon = makeInvoice({ id: 'inv-ok', due_date: new Date('2026-06-20T00:00:00Z') });
    mockPrisma.invoice.findMany.mockResolvedValue([overdue, dueSoon]);

    // First call throws; second succeeds
    let callCount = 0;
    mockEmit.mockImplementation(() => {
      callCount++;
      if (callCount === 1) return Promise.reject(new Error('emit failure'));
      return Promise.resolve(undefined);
    });

    // Should not throw despite the first emit failure
    await expect(runInvoiceDueChecks(FIXED_NOW)).resolves.toBeUndefined();

    // Second invoice still attempted
    expect(mockEmit).toHaveBeenCalledTimes(2);
  });
});
