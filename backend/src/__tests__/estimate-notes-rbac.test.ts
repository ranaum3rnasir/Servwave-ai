import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader, ESTIMATE_FIXTURE } from './helpers';

// ─── Per-row RBAC on estimate notes (F-004 tail — in-tenant cross-user leak) ──────────────
//
// `GET /api/estimates/:id/notes` is route-gated `canDo('read','Estimate')` and
// `POST /api/estimates/:id/notes` is route-gated `canDo('update','Estimate')`. SALES holds
// UNCONDITIONAL `read` AND `update` Estimate grants, so it clears BOTH route guards. Before this
// fix both handlers loaded the estimate with `tenantWhere` ONLY — no per-row ownership check — so
// a SALES rep could read (and write) notes on ANY estimate in the org, including leads they don't
// own, even though the JSON `getById`/`getPdf` for the SAME estimate are own-scoped
// (`canAccessEstimate`).
//
// Fix: getNotes/addNote now apply the SAME `canAccessEstimate` gate getById/getPdf use (selecting
// `lead.lead_assignees` so ownership can be evaluated). Non-owner SALES → 403; owner SALES + ADMIN
// succeed; behavior for owner/admin/dispatcher is unchanged.

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  note: { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
};

// Minimal estimate row shaped like the getNotes/addNote select (id + lead.lead_assignees).
const NOTES_FIXTURE_OWNED_BY_SALES = {
  id: ESTIMATE_FIXTURE.id,
  lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
};

// Same estimate but the parent lead is owned by SOMEONE ELSE — the requesting SALES rep does NOT
// own it.
const NOTES_FIXTURE_OWNED_BY_OTHER = {
  id: ESTIMATE_FIXTURE.id,
  lead: { lead_assignees: [{ user_id: '00000000-0000-0000-0000-0000000000ff' }] },
};

const NOTE_ROW = {
  id: 'n0000000-0000-0000-0000-000000000001',
  content: 'A note',
  created_at: new Date('2026-02-01'),
  creator: { id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales' },
};

describe('GET /api/estimates/:id/notes — per-row RBAC (in-tenant cross-user read leak)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // canAccessRow is not used by getNotes, but scopeWhereForReq runs inside canAccessEstimate for
    // conditional readers; harmless for SALES/ADMIN (SALES scope is {}; ADMIN short-circuits).
    mockPrisma.estimate.findFirst?.mockResolvedValue(null);
    mockPrisma.note.findMany.mockResolvedValue([NOTE_ROW]);
  });

  it('SALES requesting notes on an estimate they do NOT own → 403 (notes never queried)', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue(NOTES_FIXTURE_OWNED_BY_OTHER);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}/notes`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(mockPrisma.note.findMany).not.toHaveBeenCalled();
  });

  it('the OWNING SALES rep gets 200 + notes for their own estimate', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue(NOTES_FIXTURE_OWNED_BY_SALES);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}/notes`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(mockPrisma.note.findMany).toHaveBeenCalledTimes(1);
  });

  it('ADMIN gets 200 for notes on an estimate they do not own (unconditional access preserved)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(NOTES_FIXTURE_OWNED_BY_OTHER);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}/notes`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(mockPrisma.note.findMany).toHaveBeenCalledTimes(1);
  });

  it('still 404s an unknown estimate id (own-check runs only after the row loads)', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}/notes`)
      .set(authHeader('sales'));

    expect(res.status).toBe(404);
    expect(mockPrisma.note.findMany).not.toHaveBeenCalled();
  });
});

describe('POST /api/estimates/:id/notes — per-row RBAC (in-tenant cross-user write leak)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma.estimate.findFirst?.mockResolvedValue(null);
    mockPrisma.note.create.mockResolvedValue(NOTE_ROW);
  });

  it('SALES writing a note on an estimate they do NOT own → 403 (note never created)', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue(NOTES_FIXTURE_OWNED_BY_OTHER);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/notes`)
      .set(authHeader('sales'))
      .send({ content: 'sneaky cross-user note' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(mockPrisma.note.create).not.toHaveBeenCalled();
  });

  it('the OWNING SALES rep gets 201 + creates the note on their own estimate', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue(NOTES_FIXTURE_OWNED_BY_SALES);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/notes`)
      .set(authHeader('sales'))
      .send({ content: 'legit note' });

    expect(res.status).toBe(201);
    expect(res.body.note.id).toBe(NOTE_ROW.id);
    expect(mockPrisma.note.create).toHaveBeenCalledTimes(1);
  });

  it('ADMIN gets 201 writing a note on an estimate they do not own (unconditional access preserved)', async () => {
    mockAuthAs('admin');
    mockPrisma.estimate.findUnique.mockResolvedValue(NOTES_FIXTURE_OWNED_BY_OTHER);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/notes`)
      .set(authHeader('admin'))
      .send({ content: 'admin note' });

    expect(res.status).toBe(201);
    expect(mockPrisma.note.create).toHaveBeenCalledTimes(1);
  });

  it('still 404s an unknown estimate id (own-check runs only after the row loads)', async () => {
    mockAuthAs('sales');
    mockPrisma.estimate.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/notes`)
      .set(authHeader('sales'))
      .send({ content: 'note' });

    expect(res.status).toBe(404);
    expect(mockPrisma.note.create).not.toHaveBeenCalled();
  });
});
