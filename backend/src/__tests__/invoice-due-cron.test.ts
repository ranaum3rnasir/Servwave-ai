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
 *   - vi.mock captures emit calls (same pattern as invoice-notifications.test.ts).
 *   - prisma.invoice.findMany is mocked directly (no supertest — cron is a pure function).
 *   - Fixed now = 2026-06-18T12:00:00Z for deterministic date assertions.
 *   - dedupKey format: `${verb}:${invoice.id}:YYYY-MM-DD` (daily, per-invoice).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { runInvoiceDueChecks } from '../services/notifications/invoiceDueCron';

// ─── Mock the notification emit function ─────────────────────────────────────

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER mock is registered so we get the spy reference.
import { emit } from '../services/notifications/notificationService';
const mockEmit = emit as ReturnType<typeof vi.fn>;

// ─── Prisma typed surface ─────────────────────────────────────────────────────

const mockPrisma = prisma as unknown as {
  invoice: {
    findMany: ReturnType<typeof vi.fn>;
  };
};

// ─── Constants ────────────────────────────────────────────────────────────────

const FIXED_NOW = new Date('2026-06-18T12:00:00Z');
const TODAY_DATE = '2026-06-18';

const ORG_A = '00000000-0000-0000-0000-000000000001';
const COMMISSION_OWNER_ID = '00000000-0000-0000-0000-000000000099';

// ─── Fixtures ─────────────────────────────────────────────────────────────────

function makeInvoice(overrides: {
  id?: string;
  invoice_number?: string;
  due_date?: Date | null;
  organization_id?: string;
  commission_owner_id?: string | null;
} = {}) {
  return {
    id: 'inv-1',
    invoice_number: 'I00001',
    due_date: new Date('2026-06-17T00:00:00Z'), // yesterday (overdue) by default
    organization_id: ORG_A,
    job: {
      estimate: {
        lead: {
          commission_owner_id: COMMISSION_OWNER_ID,
        },
      },
    },
    ...overrides,
  };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
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
    expect(args.entity.customer_owner_id).toBe(COMMISSION_OWNER_ID);
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

  // ─── Case 4: entity.customer_owner_id sourced from nested lead ───────────

  it('sets entity.customer_owner_id from the nested lead commission_owner_id', async () => {
    const ownerId = '00000000-0000-0000-0000-000000000077';
    const invoice = makeInvoice({
      due_date: new Date('2026-06-17T00:00:00Z'), // overdue
      commission_owner_id: ownerId, // used via job.estimate.lead.commission_owner_id
    });
    // Override the nested lead's commission_owner_id
    invoice.job.estimate.lead.commission_owner_id = ownerId;
    mockPrisma.invoice.findMany.mockResolvedValue([invoice]);

    await runInvoiceDueChecks(FIXED_NOW);

    const args = mockEmit.mock.calls[0][0];
    expect(args.entity.customer_owner_id).toBe(ownerId);
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

  // ─── Case 7: null commission_owner_id falls back to null gracefully ───────

  it('sets entity.customer_owner_id to null when the lead chain is absent', async () => {
    const invoice = {
      id: 'inv-7',
      invoice_number: 'I00007',
      due_date: new Date('2026-06-17T00:00:00Z'),
      organization_id: ORG_A,
      job: null, // no job → no lead chain
    };
    mockPrisma.invoice.findMany.mockResolvedValue([invoice]);

    await runInvoiceDueChecks(FIXED_NOW);

    const args = mockEmit.mock.calls[0][0];
    expect(args.entity.customer_owner_id).toBeNull();
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
