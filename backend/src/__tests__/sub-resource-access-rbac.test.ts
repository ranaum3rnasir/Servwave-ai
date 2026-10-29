import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { TEST_USERS, mockAuthAs, authHeader, LEAD_FIXTURE, JOB_FIXTURE } from './helpers';

// ─── Per-row RBAC on entity sub-resources (in-tenant cross-user leaks, F-004/F-006 class) ──────
//
// Three sub-resource handlers loaded their parent entity with `tenantWhere` ONLY — no per-row
// ownership check — even though the role that clears the subject-level route guard is own-scoped:
//
//   GET  /api/leads/:id/notes        route: read Lead    — SALES `read Lead` is OWN_LEAD;
//                                                          TECHNICIAN `read Lead` is OWN_WALKTHROUGH
//   POST /api/leads/:id/notes        route: update Lead  — SALES `update Lead` is OWN_LEAD
//   GET  /api/jobs/:id/communications route: read Comm   — SALES `read Communication` is UNCONDITIONAL
//                                                          but SALES is own-scoped on Jobs
//
// Fix: each handler now applies the SAME `canAccessRow` per-row gate the lifecycle/own-scoped
// reads use (Lead → `canAccessRow(req,'Lead',…)`; Job → `canAccessRow(req,'Job',…)`). canAccessRow
// resolves visibility through a scoped `findFirst`: for a conditional read the parent's `findFirst`
// must return the row (owner) or null (non-owner) to drive own-vs-other. ADMIN's scope is {} →
// fast-path, no findFirst.

const mockPrisma = prisma as unknown as {
  lead: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  job: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  note: { findMany: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  callSession: { findMany: ReturnType<typeof vi.fn> };
  message: { findMany: ReturnType<typeof vi.fn> };
  email: { findMany: ReturnType<typeof vi.fn> };
  whatsAppMessage: { findMany: ReturnType<typeof vi.fn> };
  manualCommunicationLog: { findMany: ReturnType<typeof vi.fn> };
};

const LEAD_ID = LEAD_FIXTURE.id;
const JOB_ID = JOB_FIXTURE.id;

const NOTE_ROW = {
  id: 'n0000000-0000-0000-0000-000000000001',
  content: 'A note',
  created_at: new Date('2026-02-01'),
  creator: { id: TEST_USERS.sales.id, first_name: 'Test', last_name: 'Sales' },
};

beforeEach(() => {
  vi.resetAllMocks();
  clearPermissionCache();
  // attachAbility loads role grants for non-ADMIN; mockAuthAs sets these from DEFAULT_GRANTS.
});

// ═══════════════════════════════════════════════════════════════════════
// Leak 1 — GET /api/leads/:id/notes  (in-tenant cross-user READ leak)
// ═══════════════════════════════════════════════════════════════════════
describe('GET /api/leads/:id/notes — per-row RBAC', () => {
  beforeEach(() => {
    mockPrisma.note.findMany.mockResolvedValue([NOTE_ROW]);
  });

  it('SALES requesting notes on a lead they do NOT own → 403 (notes never queried)', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    // canAccessRow probes the OWN_LEAD scope via lead.findFirst → not visible.
    mockPrisma.lead.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/leads/${LEAD_ID}/notes`).set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(mockPrisma.note.findMany).not.toHaveBeenCalled();
  });

  it('the OWNING SALES rep gets 200 + notes for their own lead', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    // Owner → the scoped findFirst matches.
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });

    const res = await request(app).get(`/api/leads/${LEAD_ID}/notes`).set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    expect(mockPrisma.note.findMany).toHaveBeenCalledTimes(1);
  });

  it('TECHNICIAN who is NOT the walkthrough performer → 403 (OWN_WALKTHROUGH scope, notes never queried)', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    // TECHNICIAN read Lead is OWN_WALKTHROUGH (non-empty scope) → findFirst probe → not a performer.
    mockPrisma.lead.findFirst.mockResolvedValue(null);

    const res = await request(app).get(`/api/leads/${LEAD_ID}/notes`).set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(mockPrisma.note.findMany).not.toHaveBeenCalled();
  });

  it('ADMIN gets 200 for notes on a lead they do not own (unconditional access preserved)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });

    const res = await request(app).get(`/api/leads/${LEAD_ID}/notes`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.notes).toHaveLength(1);
    // ADMIN scope is {} → no extra row probe.
    expect(mockPrisma.lead.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.note.findMany).toHaveBeenCalledTimes(1);
  });

  it('still 404s an unknown lead id (own-check runs only after the row loads)', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue(null);

    const res = await request(app).get(`/api/leads/${LEAD_ID}/notes`).set(authHeader('sales'));

    expect(res.status).toBe(404);
    expect(mockPrisma.note.findMany).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Leak 2 — POST /api/leads/:id/notes  (in-tenant cross-user WRITE leak)
// ═══════════════════════════════════════════════════════════════════════
describe('POST /api/leads/:id/notes — per-row RBAC', () => {
  beforeEach(() => {
    mockPrisma.note.create.mockResolvedValue(NOTE_ROW);
  });

  it('SALES writing a note on a lead they do NOT own → 403 (note never created)', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.lead.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/leads/${LEAD_ID}/notes`)
      .set(authHeader('sales'))
      .send({ content: 'sneaky cross-user note' });

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(mockPrisma.note.create).not.toHaveBeenCalled();
  });

  it('the OWNING SALES rep gets 201 + creates the note on their own lead', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });

    const res = await request(app)
      .post(`/api/leads/${LEAD_ID}/notes`)
      .set(authHeader('sales'))
      .send({ content: 'legit note' });

    expect(res.status).toBe(201);
    expect(res.body.note.id).toBe(NOTE_ROW.id);
    expect(mockPrisma.note.create).toHaveBeenCalledTimes(1);
  });

  it('ADMIN gets 201 writing a note on a lead they do not own (unconditional access preserved)', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });

    const res = await request(app)
      .post(`/api/leads/${LEAD_ID}/notes`)
      .set(authHeader('admin'))
      .send({ content: 'admin note' });

    expect(res.status).toBe(201);
    expect(mockPrisma.note.create).toHaveBeenCalledTimes(1);
  });

  it('still 404s an unknown lead id (own-check runs only after the row loads)', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/leads/${LEAD_ID}/notes`)
      .set(authHeader('sales'))
      .send({ content: 'note' });

    expect(res.status).toBe(404);
    expect(mockPrisma.note.create).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// Leak 3 — GET /api/jobs/:id/communications  (in-tenant cross-user READ leak)
// ═══════════════════════════════════════════════════════════════════════
describe('GET /api/jobs/:id/communications — per-row RBAC', () => {
  beforeEach(() => {
    // Aggregator channel queries — if reached, return empty (we assert they're NOT called on 403).
    // The manual communication log is the FIFTH source the job aggregation reads (slice 5); this
    // file's `vi.resetAllMocks()` clears setup.ts's `[]` default, so it is re-stubbed here with
    // its four siblings and is asserted alongside them below.
    mockPrisma.callSession.findMany.mockResolvedValue([]);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.email.findMany.mockResolvedValue([]);
    mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);
    mockPrisma.manualCommunicationLog.findMany.mockResolvedValue([]);
  });

  it('SALES requesting comms on a job they do NOT own → 403 (aggregator never queried)', async () => {
    mockAuthAs('sales');
    // Job exists in-tenant (existence load) …
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
    // … but canAccessRow probes the OWN_JOB_VIA_ESTIMATE scope via job.findFirst → not visible.
    mockPrisma.job.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/jobs/${JOB_ID}/communications`)
      .set(authHeader('sales'));

    expect(res.status).toBe(403);
    expect(res.body).toEqual({ error: 'Insufficient permissions' });
    expect(mockPrisma.callSession.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.message.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.email.findMany).not.toHaveBeenCalled();
    expect(mockPrisma.whatsAppMessage.findMany).not.toHaveBeenCalled();
    // The hand-logged history is behind the same row gate as the four real channels.
    expect(mockPrisma.manualCommunicationLog.findMany).not.toHaveBeenCalled();
  });

  it('the OWNING SALES rep gets 200 + the comms timeline for their own job', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
    // Owner → canAccessRow's scoped findFirst matches.
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });

    const res = await request(app)
      .get(`/api/jobs/${JOB_ID}/communications`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    // The aggregator ran (all four channel queries fired).
    expect(mockPrisma.callSession.findMany).toHaveBeenCalled();
  });

  it('ADMIN gets 200 for comms on a job they do not own (unconditional access preserved)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });

    const res = await request(app)
      .get(`/api/jobs/${JOB_ID}/communications`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toHaveProperty('items');
    // ADMIN scope is {} → no extra row probe.
    expect(mockPrisma.job.findFirst).not.toHaveBeenCalled();
  });

  it('still 404s an unknown job id (own-check runs only after the row loads)', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/jobs/${JOB_ID}/communications`)
      .set(authHeader('sales'));

    expect(res.status).toBe(404);
    expect(mockPrisma.job.findFirst).not.toHaveBeenCalled();
    expect(mockPrisma.callSession.findMany).not.toHaveBeenCalled();
  });
});
