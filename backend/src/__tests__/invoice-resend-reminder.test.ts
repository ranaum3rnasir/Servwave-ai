/**
 * SERV10X-59 — sent-invoice non-blocking "resend?" reminder.
 *
 * Derivation: needs_resend = sent_at != null && status in (SENT, PARTIAL) &&
 * exists(INVOICE_EDITED where created_at > invoice.sent_at). No new column — an INVOICE_EDITED
 * timeline event is written on a material edit to an already-sent invoice, and getById() derives
 * needs_resend from it. See md_files/plans/invoices/2026-07-30-serv10x-59-sent-invoice-resend-reminder.md.
 *
 * Harness: supertest against `app`, prisma fully mocked (setup.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, JOB_FIXTURE, INVOICE_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  invoice: {
    findUnique: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  invoiceLineItem: {
    findMany: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  timelineEvent: {
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
  };
  organization: { findUnique: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const INVOICE_ID = INVOICE_FIXTURE.id;
const LINE_ID = 'aa000000-0000-0000-0000-000000000001';
const SCOPE_ID = 'cc000000-0000-0000-0000-000000000001';

// The owner-chain + money-field shape loadGuardedInvoice (invoice-lines.controller.ts) loads.
function invoiceRow({
  status = 'SENT' as string,
  sentAt = new Date('2026-07-01T00:00:00Z') as Date | null,
  techId = TEST_USERS.technician.id as string,
}: { status?: string; sentAt?: Date | null; techId?: string } = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: INVOICE_FIXTURE.invoice_number,
    status,
    sent_at: sentAt,
    kind: 'STANDARD',
    deposit_credit: 0,
    total_amount: 1080,
    amount_due: 1080,
    tax_rate: 0.08,
    discount_amount: 0,
    tip: 0,
    job_id: JOB_FIXTURE.id,
    customer: { tax_exempt: false },
    job: {
      assignees: [{ user_id: techId }],
      customer: { tax_exempt: false },
      estimate: { lead: { lead_assignees: [] } },
    },
  };
}

function existingLines() {
  return [
    {
      id: LINE_ID,
      invoice_id: INVOICE_ID,
      sequence: 1,
      description: 'AC Unit',
      quantity: 1,
      unit_price: 1000,
      is_taxable: true,
      line_total: 1000,
      discount_type: null,
      discount_value: null,
      discount_amount: 0,
      item_type: 'SERVICE',
      price_book_item_id: null,
      unit_cost: null,
      stock_status: 'NOT_TRACKED',
      stock_location_id: null,
    },
  ];
}

function setupTransaction() {
  mockPrisma.$transaction.mockImplementation(async (fn: Function) => fn({
    invoiceLineItem: {
      findMany: mockPrisma.invoiceLineItem.findMany,
      findFirst: mockPrisma.invoiceLineItem.findFirst,
      create: mockPrisma.invoiceLineItem.create,
      update: mockPrisma.invoiceLineItem.update,
      deleteMany: mockPrisma.invoiceLineItem.deleteMany,
    },
    invoice: {
      findUnique: mockPrisma.invoice.findUnique,
      update: mockPrisma.invoice.update,
    },
    timelineEvent: { create: mockPrisma.timelineEvent.create },
    organization: { findUnique: mockPrisma.organization.findUnique },
  } as any));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  setupTransaction();
  mockAuthAs('admin');
  mockPrisma.invoice.update.mockImplementation((args: any) => Promise.resolve({ id: INVOICE_ID, ...args.data }));
});

// ─── Line-item + billing + scope mutations (invoice-lines.controller.ts) ───────────────

describe('INVOICE_EDITED — line-item mutations on an already-sent invoice', () => {
  it('addLine on a SENT invoice writes INVOICE_EDITED', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'SENT' }));
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'New part', quantity: 1, unit_price: 50 });

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entity_type: 'INVOICE',
          entity_id: INVOICE_ID,
          event_type: 'INVOICE_EDITED',
        }),
      }),
    );
  });

  it('addLine on a PARTIAL (sent) invoice writes INVOICE_EDITED', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'PARTIAL', sentAt: new Date('2026-07-01') }));
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'New part', quantity: 1, unit_price: 50 });

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'INVOICE_EDITED' }) }),
    );
  });

  it('addLine on a DRAFT invoice does NOT write INVOICE_EDITED', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'DRAFT', sentAt: null }));
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/line-items`)
      .set(authHeader('admin'))
      .send({ description: 'New part', quantity: 1, unit_price: 50 });

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });

  it('deleteLine on a SENT invoice writes INVOICE_EDITED', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'SENT' }));
    mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(existingLines()[0]);
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);

    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'INVOICE_EDITED' }) }),
    );
  });

  it('updateLine on a SENT invoice writes INVOICE_EDITED', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'SENT' }));
    mockPrisma.invoiceLineItem.findFirst.mockResolvedValue(existingLines()[0]);
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/${LINE_ID}`)
      .set(authHeader('admin'))
      .send({ quantity: 2 });

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'INVOICE_EDITED' }) }),
    );
  });

  it('reorderLines on a SENT invoice writes INVOICE_EDITED', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'SENT' }));
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/line-items/reorder`)
      .set(authHeader('admin'))
      .send({ order: [LINE_ID] });

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'INVOICE_EDITED' }) }),
    );
  });
});

describe('INVOICE_EDITED — billing (tip vs discount/tax materiality)', () => {
  it('a tip-only PATCH on a SENT invoice does NOT write INVOICE_EDITED (tip is not customer-visible yet)', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'SENT' }));
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/billing`)
      .set(authHeader('admin'))
      .send({ tip: 50 });

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });

  it('a discount_amount PATCH on a SENT invoice writes INVOICE_EDITED', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'SENT' }));
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/billing`)
      .set(authHeader('admin'))
      .send({ discount_amount: 100 });

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'INVOICE_EDITED' }) }),
    );
  });

  it('a tax_rate PATCH on a SENT invoice writes INVOICE_EDITED', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'SENT' }));
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/billing`)
      .set(authHeader('admin'))
      .send({ tax_rate: 0.05 });

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'INVOICE_EDITED' }) }),
    );
  });

  it('a no-op billing PATCH ({}) on a SENT invoice does NOT write INVOICE_EDITED', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(invoiceRow({ status: 'SENT' }));
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue(existingLines());

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/billing`)
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });
});

describe('INVOICE_EDITED — scopes of work (Yes: scopes are part of the billable document)', () => {
  function mockScopeReads(before: unknown[], after: unknown[], guardOverrides: Parameters<typeof invoiceRow>[0] = {}) {
    mockPrisma.invoice.findUnique
      .mockResolvedValueOnce(invoiceRow(guardOverrides))
      .mockResolvedValueOnce({ scopes: before })
      .mockResolvedValueOnce({ scopes: after });
  }

  it('addScope on a SENT invoice writes INVOICE_EDITED', async () => {
    mockScopeReads([], [{ id: SCOPE_ID, title: 'Permit fee', body: '', flat_price: 300, is_taxable: true, internal_cost: null }], { status: 'SENT' });
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_ID}/scopes`)
      .set(authHeader('admin'))
      .send({ title: 'Permit fee', flat_price: 300 });

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'INVOICE_EDITED' }) }),
    );
  });

  it('updateScope on a SENT invoice writes INVOICE_EDITED', async () => {
    const scope = { id: SCOPE_ID, title: 'Permit fee', body: '', flat_price: 300, is_taxable: true, internal_cost: null };
    mockScopeReads([scope], [{ ...scope, flat_price: 350 }], { status: 'SENT' });
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/0`)
      .set(authHeader('admin'))
      .send({ flat_price: 350 });

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'INVOICE_EDITED' }) }),
    );
  });

  it('deleteScope on a SENT invoice writes INVOICE_EDITED', async () => {
    const scope = { id: SCOPE_ID, title: 'Permit fee', body: '', flat_price: 300, is_taxable: true, internal_cost: null };
    mockScopeReads([scope], [], { status: 'SENT' });
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);

    const res = await request(app)
      .delete(`/api/invoices/${INVOICE_ID}/scopes/0`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'INVOICE_EDITED' }) }),
    );
  });

  it('reorderScopes on a SENT invoice writes INVOICE_EDITED', async () => {
    const scope = { id: SCOPE_ID, title: 'Permit fee', body: '', flat_price: 300, is_taxable: true, internal_cost: null };
    mockScopeReads([scope], [scope], { status: 'SENT' });
    mockPrisma.invoiceLineItem.findMany.mockResolvedValue([]);

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}/scopes/reorder`)
      .set(authHeader('admin'))
      .send({ order: [SCOPE_ID] });

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'INVOICE_EDITED' }) }),
    );
  });
});

// ─── PATCH /api/invoices/:id — due_date (invoice.controller.ts update()) ───────────────

// The owner-chain shape update()'s own findUnique loads (distinct from invoiceRow() above,
// which is invoice-lines.controller.ts's loadGuardedInvoice shape).
function updateGuardRow({
  status = 'SENT' as string,
  sentAt = new Date('2026-07-01T00:00:00Z') as Date | null,
  dueDate = new Date('2026-07-10T00:00:00Z') as Date | null,
}: { status?: string; sentAt?: Date | null; dueDate?: Date | null } = {}) {
  return {
    id: INVOICE_ID,
    status,
    sent_at: sentAt,
    due_date: dueDate,
    job: { assignees: [], estimate: { lead: { lead_assignees: [] } } },
  };
}

describe('INVOICE_EDITED — PATCH /api/invoices/:id (due_date)', () => {
  it('changing due_date on a SENT invoice writes INVOICE_EDITED', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(updateGuardRow({ status: 'SENT' }));
    mockPrisma.invoice.update.mockResolvedValue({ id: INVOICE_ID });

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}`)
      .set(authHeader('admin'))
      .send({ due_date: '2026-08-01T00:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          entity_type: 'INVOICE',
          entity_id: INVOICE_ID,
          event_type: 'INVOICE_EDITED',
          metadata: { fields: ['due_date'] },
        }),
      }),
    );
  });

  it('changing due_date on a PARTIAL invoice writes INVOICE_EDITED', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(updateGuardRow({ status: 'PARTIAL' }));
    mockPrisma.invoice.update.mockResolvedValue({ id: INVOICE_ID });

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}`)
      .set(authHeader('admin'))
      .send({ due_date: '2026-08-01T00:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ event_type: 'INVOICE_EDITED' }) }),
    );
  });

  it('changing due_date on a DRAFT invoice does NOT write INVOICE_EDITED', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(updateGuardRow({ status: 'DRAFT', sentAt: null }));
    mockPrisma.invoice.update.mockResolvedValue({ id: INVOICE_ID });

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}`)
      .set(authHeader('admin'))
      .send({ due_date: '2026-08-01T00:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });

  it('a no-op PATCH (due_date unchanged) on a SENT invoice does NOT write INVOICE_EDITED', async () => {
    const dueDate = new Date('2026-07-10T00:00:00Z');
    mockPrisma.invoice.findUnique.mockResolvedValue(updateGuardRow({ status: 'SENT', dueDate }));
    mockPrisma.invoice.update.mockResolvedValue({ id: INVOICE_ID });

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}`)
      .set(authHeader('admin'))
      .send({ due_date: dueDate.toISOString() });

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });

  it('a cost-fields-only PATCH (labor_hours) on a SENT invoice does NOT write INVOICE_EDITED', async () => {
    mockPrisma.invoice.findUnique.mockResolvedValue(updateGuardRow({ status: 'SENT' }));
    mockPrisma.invoice.update.mockResolvedValue({ id: INVOICE_ID });

    const res = await request(app)
      .patch(`/api/invoices/${INVOICE_ID}`)
      .set(authHeader('admin'))
      .send({ labor_hours: 3 });

    expect(res.status).toBe(200);
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  });
});

// ─── GET /api/invoices/:id/timeline ─────────────────────────────────────────────────────

describe('GET /api/invoices/:id/timeline', () => {
  it('returns this invoice’s timeline events, most recent first', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({ id: INVOICE_ID });
    mockPrisma.timelineEvent.findMany.mockResolvedValue([
      { id: 'e2', event_type: 'INVOICE_EDITED', description: 'Invoice edited after it was sent', metadata: { fields: ['due_date'] }, created_at: new Date('2026-07-02'), creator: null },
      { id: 'e1', event_type: 'INVOICE_SENT', description: 'Invoice sent to customer', metadata: null, created_at: new Date('2026-07-01'), creator: null },
    ]);

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}/timeline`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.events.map((e: { event_type: string }) => e.event_type)).toEqual(['INVOICE_EDITED', 'INVOICE_SENT']);
    expect(mockPrisma.timelineEvent.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { created_at: 'desc' } }),
    );
  });

  it('scopes events to entity_type INVOICE + this invoice’s id + the tenant', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue({ id: INVOICE_ID });
    mockPrisma.timelineEvent.findMany.mockResolvedValue([]);

    await request(app).get(`/api/invoices/${INVOICE_ID}/timeline`).set(authHeader('admin'));

    const where = mockPrisma.timelineEvent.findMany.mock.calls[0]![0].where;
    expect(where).toEqual(expect.objectContaining({ entity_type: 'INVOICE', entity_id: INVOICE_ID }));
  });

  it('404s on a missing/cross-org invoice', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(null);

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}/timeline`).set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  it('403s via canAccessRow for a role with a conditional read grant on a FOREIGN invoice', async () => {
    mockAuthAs('sales');
    mockPrisma.invoice.findUnique.mockResolvedValue({ id: INVOICE_ID });
    // canAccessRow's per-instance scoped findFirst — no match ⇒ not owned by this SALES user.
    mockPrisma.invoice.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}/timeline`).set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(mockPrisma.timelineEvent.findMany).not.toHaveBeenCalled();
  });
});

// ─── needs_resend — derived on GET /api/invoices/:id ────────────────────────────────────

function detailRow({
  status = 'SENT' as string,
  sentAt = new Date('2026-07-01T00:00:00Z') as Date | null,
}: { status?: string; sentAt?: Date | null } = {}) {
  return {
    id: INVOICE_ID,
    invoice_number: INVOICE_FIXTURE.invoice_number,
    status,
    sent_at: sentAt,
    job: null,
  };
}

describe('needs_resend — GET /api/invoices/:id', () => {
  it('is true when a material edit landed after the invoice was sent', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(detailRow({ status: 'SENT' }));
    mockPrisma.timelineEvent.findFirst.mockResolvedValue({ id: 'evt-1' });

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.invoice.needs_resend).toBe(true);
    expect(mockPrisma.timelineEvent.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          entity_type: 'INVOICE',
          entity_id: INVOICE_ID,
          event_type: 'INVOICE_EDITED',
          created_at: { gt: new Date('2026-07-01T00:00:00Z') },
        }),
      }),
    );
  });

  it('is false after a resend clears it (no INVOICE_EDITED past the new sent_at)', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(detailRow({ status: 'SENT', sentAt: new Date('2026-07-05T00:00:00Z') }));
    mockPrisma.timelineEvent.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.invoice.needs_resend).toBe(false);
  });

  it('is false on a never-sent (DRAFT) invoice, and skips the query entirely', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(detailRow({ status: 'DRAFT', sentAt: null }));

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.invoice.needs_resend).toBe(false);
    expect(mockPrisma.timelineEvent.findFirst).not.toHaveBeenCalled();
  });

  it('is true on a PARTIAL invoice with a stale edit', async () => {
    mockAuthAs('admin');
    mockPrisma.invoice.findUnique.mockResolvedValue(detailRow({ status: 'PARTIAL' }));
    mockPrisma.timelineEvent.findFirst.mockResolvedValue({ id: 'evt-1' });

    const res = await request(app).get(`/api/invoices/${INVOICE_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.invoice.needs_resend).toBe(true);
  });
});
