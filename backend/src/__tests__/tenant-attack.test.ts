/**
 * Cross-tenant attack tests.
 *
 * These tests act as Org B admin attempting to access / mutate / leak
 * Org A resources by their UUIDs (BOLA / IDOR scenarios) and verify
 * the multi-tenant boundary holds.
 *
 * Convention used by the existing controllers (post §3.1):
 *   - Every authenticated read of a single resource does
 *       prisma.X.findUnique({ where: { id, ...tenantWhere(req) } })
 *     so a cross-org id returns null → 404. We assert both the response
 *     code AND that the Prisma where clause carried organization_id of
 *     the *requesting* org (i.e. Org B). If we observed organization_id
 *     == Org A (the resource owner), the controller is using the wrong
 *     org and we have a leak.
 *
 *   - The Prisma mock in setup.ts returns undefined by default, so we
 *     explicitly mockResolvedValue(null) to simulate the (correct)
 *     state where the cross-org row is invisible.
 *
 * If any of these tests fail, that is a real vulnerability — do not
 * "fix" by relaxing the assertion. Triage with the team.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import {
  mockAuthAs, authHeader,
  ALPHA_ORG_ID, ORG_B_ID,
  CUSTOMER_FIXTURE, LEAD_FIXTURE, ESTIMATE_FIXTURE, JOB_FIXTURE, INVOICE_FIXTURE,
  TEST_USERS,
} from './helpers';

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
});

// ─── Helpers ─────────────────────────────────────────────

/** Assert: every where-clause Prisma saw on this mock was scoped to orgId. */
function everyWhereScopedTo(mockFn: Mock, orgId: string) {
  const calls = mockFn.mock.calls;
  expect(calls.length).toBeGreaterThan(0);
  for (const [args] of calls) {
    const where = (args as { where?: Record<string, unknown> })?.where;
    expect(where).toBeDefined();
    expect((where as Record<string, unknown>).organization_id).toBe(orgId);
  }
}

/** Assert: payload contains no fields from the OTHER org. */
function noLeakInBody(body: unknown, leakIndicator: string) {
  expect(JSON.stringify(body)).not.toContain(leakIndicator);
}

const ORG_A_LEAK = 'ORG_A_SECRET_VALUE_DO_NOT_LEAK';

// ═══════════════════════════════════════════════════════════════════════
// 1. DIRECT UUID GUESSING — GET single resource cross-org
// ═══════════════════════════════════════════════════════════════════════
describe('Attack 1 — Cross-org direct UUID GET', () => {
  it('GET /api/customers/:id with Org A id as Org B admin → 404 (no leak)', async () => {
    mockAuthAs('orgB_admin');
    (prisma.customer.findUnique as Mock).mockResolvedValue(null);
    (prisma.note.findMany as Mock).mockResolvedValue([]);
    (prisma.$queryRaw as Mock).mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    everyWhereScopedTo(prisma.customer.findUnique as Mock, ORG_B_ID);
    noLeakInBody(res.body, ORG_A_LEAK);
  });

  it('GET /api/leads/:id with Org A id as Org B admin → 404', async () => {
    mockAuthAs('orgB_admin');
    (prisma.lead.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    everyWhereScopedTo(prisma.lead.findUnique as Mock, ORG_B_ID);
  });

  it('GET /api/estimates/:id with Org A id as Org B admin → 404', async () => {
    mockAuthAs('orgB_admin');
    (prisma.estimate.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    everyWhereScopedTo(prisma.estimate.findUnique as Mock, ORG_B_ID);
  });

  it('GET /api/jobs/:id with Org A id as Org B admin → 404', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}`)
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    everyWhereScopedTo(prisma.job.findUnique as Mock, ORG_B_ID);
  });

  it('GET /api/invoices/:id with Org A id as Org B admin → 404', async () => {
    mockAuthAs('orgB_admin');
    (prisma.invoice.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}`)
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    everyWhereScopedTo(prisma.invoice.findUnique as Mock, ORG_B_ID);
  });

  it('GET /api/users/:id with Org A user id as Org B admin → 404', async () => {
    mockAuthAs('orgB_admin');
    // The authenticate middleware looks up the *requesting* user via findUnique
    // (wired by mockAuthAs). The controller looks up the *target* user via
    // findFirst with `{ id, organization_id: ORG_B_ID }`, so a cross-org id
    // (the target belongs to Org A) must resolve to null → 404.
    (prisma.user.findFirst as Mock).mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/users/${TEST_USERS.admin.id}`) // Org A admin
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    // Confirm the controller call (the one with organization_id) used Org B
    const calls = (prisma.user.findFirst as Mock).mock.calls;
    const targetCalls = calls.filter(([a]: any[]) => a?.where?.organization_id);
    expect(targetCalls.length).toBeGreaterThan(0);
    for (const [a] of targetCalls) {
      expect((a as any).where.organization_id).toBe(ORG_B_ID);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 2. CROSS-ORG MUTATION (PATCH / DELETE)
// ═══════════════════════════════════════════════════════════════════════
describe('Attack 2 — Cross-org mutation', () => {
  it('PATCH /api/customers/:id (Org A id, Org B admin) → 404, no update issued', async () => {
    mockAuthAs('orgB_admin');
    (prisma.customer.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('orgB_admin'))
      .send({ first_name: 'PWNED' });

    expect(res.status).toBe(404);
    everyWhereScopedTo(prisma.customer.findUnique as Mock, ORG_B_ID);
    // Critical: no update was issued for the Org A row
    expect(prisma.customer.update).not.toHaveBeenCalled();
  });

  it('PATCH /api/leads/:id (Org A id, Org B admin) → 404, no update issued', async () => {
    mockAuthAs('orgB_admin');
    (prisma.lead.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('orgB_admin'))
      .send({ status: 'CANCELLED', notes: 'pwn' });

    expect(res.status).toBe(404);
    everyWhereScopedTo(prisma.lead.findUnique as Mock, ORG_B_ID);
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });

  it('PATCH /api/estimates/:id (Org A id, Org B admin) → 404, no update issued', async () => {
    mockAuthAs('orgB_admin');
    (prisma.estimate.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/estimates/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('orgB_admin'))
      .send({ scope_notes: 'pwn' });

    expect(res.status).toBe(404);
    everyWhereScopedTo(prisma.estimate.findUnique as Mock, ORG_B_ID);
    expect(prisma.estimate.update).not.toHaveBeenCalled();
  });

  it('DELETE /api/customers/:id (Org A id, Org B admin) → 404, no delete issued', async () => {
    mockAuthAs('orgB_admin');
    (prisma.customer.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    everyWhereScopedTo(prisma.customer.findUnique as Mock, ORG_B_ID);
    expect(prisma.customer.delete).not.toHaveBeenCalled();
  });

  it('PATCH /api/users/:id with role=ADMIN (Org A user, Org B admin) → 404, no privilege escalation', async () => {
    mockAuthAs('orgB_admin');
    // See user GET test for impl rationale. The controller resolves the target
    // user via findFirst (org-scoped); a cross-org id is invisible → null.
    (prisma.user.findFirst as Mock).mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/users/${TEST_USERS.sales.id}`) // Org A sales user
      .set(authHeader('orgB_admin'))
      .send({ role: 'ADMIN' });

    expect(res.status).toBe(404);
    expect(prisma.user.update).not.toHaveBeenCalled();

    const calls = (prisma.user.findFirst as Mock).mock.calls;
    const targetCalls = calls.filter(([a]: any[]) => a?.where?.organization_id);
    expect(targetCalls.length).toBeGreaterThan(0);
    for (const [a] of targetCalls) {
      expect((a as any).where.organization_id).toBe(ORG_B_ID);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 3. CROSS-ORG ACTION ENDPOINTS (the dangerous ones)
// ═══════════════════════════════════════════════════════════════════════
describe('Attack 3 — Cross-org action endpoints', () => {
  it('POST /api/estimates/:id/cancel (Org A est, Org B admin) → 404/403, no update', async () => {
    mockAuthAs('orgB_admin');
    (prisma.estimate.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/estimates/${ESTIMATE_FIXTURE.id}/cancel`)
      .set(authHeader('orgB_admin'))
      .send({ cancelled_reason: 'pwn' });

    expect([403, 404]).toContain(res.status);
    everyWhereScopedTo(prisma.estimate.findUnique as Mock, ORG_B_ID);
    expect(prisma.estimate.update).not.toHaveBeenCalled();
  });

  it('POST /api/jobs/:id/start (Org A job, Org B admin) → 404/403, no update', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/start`)
      .set(authHeader('orgB_admin'))
      .send({});

    expect([403, 404]).toContain(res.status);
    everyWhereScopedTo(prisma.job.findUnique as Mock, ORG_B_ID);
    expect(prisma.job.update).not.toHaveBeenCalled();
  });

  it('POST /api/invoices/:id/void (Org A inv, Org B admin) → 404/403, no update', async () => {
    mockAuthAs('orgB_admin');
    (prisma.invoice.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/void`)
      .set(authHeader('orgB_admin'))
      .send({ voided_reason: 'pwn' });

    expect([403, 404]).toContain(res.status);
    everyWhereScopedTo(prisma.invoice.findUnique as Mock, ORG_B_ID);
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it('POST /api/invoices/:id/refund (Org A inv, Org B admin) → 404, no refund issued', async () => {
    mockAuthAs('orgB_admin');
    (prisma.invoice.findUnique as Mock).mockResolvedValue(null);

    // Valid Zod payload (refundInvoiceSchema) so we exercise the controller,
    // not the validator.
    const res = await request(app)
      .post(`/api/invoices/${INVOICE_FIXTURE.id}/refund`)
      .set(authHeader('orgB_admin'))
      .send({ reason_category: 'CUSTOMER_REQUEST', reason: 'pwn' });

    expect(res.status).toBe(404);
    everyWhereScopedTo(prisma.invoice.findUnique as Mock, ORG_B_ID);
    expect(prisma.payment.create).not.toHaveBeenCalled();
    expect(prisma.payment.update).not.toHaveBeenCalled();
    expect(prisma.invoice.update).not.toHaveBeenCalled();
  });

  it('POST /api/jobs/:id/cancel (Org A job, Org B admin) → 404/403', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/cancel`)
      .set(authHeader('orgB_admin'))
      .send({ cancelled_reason: 'pwn' });

    expect([403, 404]).toContain(res.status);
    everyWhereScopedTo(prisma.job.findUnique as Mock, ORG_B_ID);
    expect(prisma.job.update).not.toHaveBeenCalled();
  });

  it('POST /api/leads/:id/cancel (Org A lead, Org B admin) → 404, no update', async () => {
    mockAuthAs('orgB_admin');
    (prisma.lead.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/cancel`)
      .set(authHeader('orgB_admin'))
      .send({ cancelled_reason: 'pwn' });

    expect([403, 404]).toContain(res.status);
    everyWhereScopedTo(prisma.lead.findUnique as Mock, ORG_B_ID);
    expect(prisma.lead.update).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 4. SEARCH / DASHBOARD / LIST LEAKAGE
// ═══════════════════════════════════════════════════════════════════════
describe('Attack 4 — Search / dashboard / list leakage', () => {
  it('GET /api/customers as Org B → list findMany scoped to Org B only', async () => {
    mockAuthAs('orgB_admin');
    (prisma.customer.findMany as Mock).mockResolvedValue([]);
    (prisma.customer.count as Mock).mockResolvedValue(0);

    const res = await request(app).get('/api/customers').set(authHeader('orgB_admin'));
    expect(res.status).toBe(200);
    everyWhereScopedTo(prisma.customer.findMany as Mock, ORG_B_ID);
    everyWhereScopedTo(prisma.customer.count as Mock, ORG_B_ID);
    // Result should be empty for Org B; no Org A customer ids should appear
    noLeakInBody(res.body, CUSTOMER_FIXTURE.id);
  });

  it('GET /api/customers/stats as Org B → all 4 count() calls scoped to Org B', async () => {
    mockAuthAs('orgB_admin');
    (prisma.customer.count as Mock).mockResolvedValue(0);
    (prisma.lead.count as Mock).mockResolvedValue(0);
    (prisma.job.count as Mock).mockResolvedValue(0);

    const res = await request(app).get('/api/customers/stats').set(authHeader('orgB_admin'));
    expect(res.status).toBe(200);
    // All 4 stat counts now go through customer.count (activeLeads/activeJobs
    // count customers via leads/jobs relation filters), so the lead/job tables
    // are no longer queried directly here.
    everyWhereScopedTo(prisma.customer.count as Mock, ORG_B_ID);
    expect((prisma.customer.count as Mock).mock.calls).toHaveLength(4);
  });

  it('GET /api/search?q=<org-a-only-string> as Org B → all entity findMany scoped to Org B', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.findMany as Mock).mockResolvedValue([]);
    (prisma.customer.findMany as Mock).mockResolvedValue([]);
    (prisma.lead.findMany as Mock).mockResolvedValue([]);
    (prisma.estimate.findMany as Mock).mockResolvedValue([]);
    (prisma.invoice.findMany as Mock).mockResolvedValue([]);

    const res = await request(app)
      .get('/api/search?q=' + encodeURIComponent('Doe HVAC'))
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    everyWhereScopedTo(prisma.job.findMany as Mock, ORG_B_ID);
    everyWhereScopedTo(prisma.customer.findMany as Mock, ORG_B_ID);
    everyWhereScopedTo(prisma.lead.findMany as Mock, ORG_B_ID);
    everyWhereScopedTo(prisma.estimate.findMany as Mock, ORG_B_ID);
    everyWhereScopedTo(prisma.invoice.findMany as Mock, ORG_B_ID);
    // No Org A entity ids in payload
    noLeakInBody(res.body, CUSTOMER_FIXTURE.id);
    noLeakInBody(res.body, ESTIMATE_FIXTURE.id);
    noLeakInBody(res.body, INVOICE_FIXTURE.id);
  });

  it('GET /api/dashboard as Org B → every aggregate/count/findMany is scoped to Org B', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.groupBy as Mock).mockResolvedValue([]);
    (prisma.job.count as Mock).mockResolvedValue(0);
    // invoice.aggregate backs invoiced-MTD (_sum), avg-ticket (_avg) and
    // deposits-awaiting (_sum + _count) — return all three shapes.
    (prisma.invoice.aggregate as Mock).mockResolvedValue({ _sum: {}, _avg: {}, _count: { _all: 0 } });
    (prisma.estimate.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.job.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.payment.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.appSetting.findUnique as Mock).mockResolvedValue(null);
    (prisma.invoice.findMany as Mock).mockResolvedValue([]);
    (prisma.lead.findMany as Mock).mockResolvedValue([]);
    (prisma.lead.groupBy as Mock).mockResolvedValue([]);
    (prisma.lead.count as Mock).mockResolvedValue(0);
    (prisma.estimate.findMany as Mock).mockResolvedValue([]);
    (prisma.job.findMany as Mock).mockResolvedValue([]);
    (prisma.servicePlan.findMany as Mock).mockResolvedValue([]);
    (prisma.user.findMany as Mock).mockResolvedValue([]);
    (prisma.timelineEvent.findMany as Mock).mockResolvedValue([]);
    (prisma.$queryRaw as Mock).mockResolvedValue([]);

    const res = await request(app).get('/api/dashboard').set(authHeader('orgB_admin'));
    expect(res.status).toBe(200);

    everyWhereScopedTo(prisma.job.groupBy as Mock, ORG_B_ID);
    everyWhereScopedTo(prisma.job.count as Mock, ORG_B_ID);
    everyWhereScopedTo(prisma.invoice.aggregate as Mock, ORG_B_ID);
    everyWhereScopedTo(prisma.lead.findMany as Mock, ORG_B_ID);
    everyWhereScopedTo(prisma.timelineEvent.findMany as Mock, ORG_B_ID);

    // payment.aggregate scopes via invoice relation; assert that relation
    // filter contains org_id (Prisma payments don't carry organization_id
    // themselves — they're scoped via { invoice: { organization_id } }).
    const payCalls = (prisma.payment.aggregate as Mock).mock.calls;
    expect(payCalls.length).toBeGreaterThan(0);
    for (const [args] of payCalls) {
      const inv = (args as any)?.where?.invoice;
      expect(inv?.organization_id).toBe(ORG_B_ID);
    }

    // appSetting lookup uses composite key (organization_id_key)
    const settingCalls = (prisma.appSetting.findUnique as Mock).mock.calls;
    expect(settingCalls.length).toBeGreaterThan(0);
    for (const [args] of settingCalls) {
      expect((args as any).where.organization_id_key.organization_id).toBe(ORG_B_ID);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 5. POLYMORPHIC IDOR (attachments / notes)
// ═══════════════════════════════════════════════════════════════════════
describe('Attack 5 — Polymorphic IDOR (attachments + notes)', () => {
  it('GET /api/attachments/INVOICE/:org-a-invoice-id as Org B → 404/403, no rows returned', async () => {
    mockAuthAs('orgB_admin');
    (prisma.invoice.findUnique as Mock).mockResolvedValue(null);
    (prisma.attachment.findMany as Mock).mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/attachments/INVOICE/${INVOICE_FIXTURE.id}`)
      .set(authHeader('orgB_admin'));

    expect([403, 404]).toContain(res.status);
    // The parent existence check (checkEntityExists) must include org_id
    everyWhereScopedTo(prisma.invoice.findUnique as Mock, ORG_B_ID);
  });

  // ESTIMATE stopped being a valid attachment entity on 2026-08-27 (attachments belong to a
  // lead or a job). This used to assert cross-org isolation on an estimate's attachments; the
  // guarantee is now strictly stronger — the entity type is refused outright, for every caller
  // in every org, before any tenancy check runs. Asserting the 400 keeps a live test on the
  // door: if ESTIMATE is ever added back to VALID_ENTITY_TYPES without a tenancy check being
  // restored alongside it, this fails.
  it('GET /api/attachments/ESTIMATE/:id → 400, ESTIMATE is not an attachment entity', async () => {
    mockAuthAs('orgB_admin');

    const res = await request(app)
      .get(`/api/attachments/ESTIMATE/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Invalid entity type');
    // Refused before the parent is ever looked up — no DB round-trip at all.
    expect(prisma.estimate.findUnique as Mock).not.toHaveBeenCalled();
  });

  it('POST /api/attachments/ESTIMATE/:id → 400, writes are refused too', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/attachments/ESTIMATE/${ESTIMATE_FIXTURE.id}`)
      .set(authHeader('admin'))
      .attach('file', Buffer.from('x'), 'x.pdf');

    expect(res.status).toBe(400);
    expect(prisma.attachment.create as Mock).not.toHaveBeenCalled();
  });

  it('POST /api/attachments/JOB/:org-a-job-id as Org B → 404/403, no attachment record created', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/attachments/JOB/${JOB_FIXTURE.id}`)
      .set(authHeader('orgB_admin'))
      .field('display_name', 'pwn.png')
      .field('description', 'pwn')
      .attach('file', Buffer.from([0xff, 0xd8, 0xff, 0xe0]), { filename: 'pwn.png', contentType: 'image/png' });

    expect([403, 404]).toContain(res.status);
    everyWhereScopedTo(prisma.job.findUnique as Mock, ORG_B_ID);
    expect(prisma.attachment.create).not.toHaveBeenCalled();
  });

  it('POST /api/customers/:org-a-id/notes as Org B → 404, no note created', async () => {
    mockAuthAs('orgB_admin');
    (prisma.customer.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/customers/${CUSTOMER_FIXTURE.id}/notes`)
      .set(authHeader('orgB_admin'))
      .send({ content: 'pwn' });

    expect(res.status).toBe(404);
    everyWhereScopedTo(prisma.customer.findUnique as Mock, ORG_B_ID);
    expect(prisma.note.create).not.toHaveBeenCalled();
  });

  it('POST /api/leads/:org-a-id/notes as Org B → 404, no note created', async () => {
    mockAuthAs('orgB_admin');
    (prisma.lead.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/notes`)
      .set(authHeader('orgB_admin'))
      .send({ content: 'pwn' });

    expect([403, 404]).toContain(res.status);
    everyWhereScopedTo(prisma.lead.findUnique as Mock, ORG_B_ID);
    expect(prisma.note.create).not.toHaveBeenCalled();
  });

  it('GET /api/jobs/:org-a-id/notes as Org B → 404/403', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}/notes`)
      .set(authHeader('orgB_admin'));

    expect([403, 404]).toContain(res.status);
    everyWhereScopedTo(prisma.job.findUnique as Mock, ORG_B_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 6. ORG-SCOPED SETTINGS & ORGANIZATION ROW
// ═══════════════════════════════════════════════════════════════════════
describe('Attack 6 — Settings + Organization row isolation', () => {
  it('GET /api/settings/<random-key> as Org B → lookup uses Org B composite key', async () => {
    mockAuthAs('orgB_admin');
    (prisma.appSetting.findUnique as Mock).mockResolvedValue(null);

    await request(app)
      .get('/api/settings/revenue_target_monthly')
      .set(authHeader('orgB_admin'));

    const calls = (prisma.appSetting.findUnique as Mock).mock.calls;
    expect(calls.length).toBeGreaterThan(0);
    for (const [args] of calls) {
      expect((args as any).where.organization_id_key.organization_id).toBe(ORG_B_ID);
    }
  });

  it('PATCH /api/settings/<key> as Org B → upsert keyed under Org B (not Org A)', async () => {
    mockAuthAs('orgB_admin');
    (prisma.appSetting.upsert as Mock).mockResolvedValue({
      organization_id: ORG_B_ID, key: 'company_name', value: 'Lakeside', updated_at: new Date(),
    });

    const res = await request(app)
      .patch('/api/settings/company_name')
      .set(authHeader('orgB_admin'))
      .send({ value: 'Lakeside' });

    expect(res.status).toBe(200);
    const calls = (prisma.appSetting.upsert as Mock).mock.calls;
    expect(calls.length).toBe(1);
    const [args] = calls[0];
    expect((args as any).where.organization_id_key.organization_id).toBe(ORG_B_ID);
    expect((args as any).create.organization_id).toBe(ORG_B_ID);
    // Never touches Org A's setting row
    expect((args as any).where.organization_id_key.organization_id).not.toBe(ALPHA_ORG_ID);
  });

  it('GET /api/organization as Org B → loads Org B row only (never Org A)', async () => {
    mockAuthAs('orgB_admin');
    (prisma.organization.findUnique as Mock).mockResolvedValue({
      id: ORG_B_ID, name: 'Lakeside', logo_url: null, brand_color: '#242424',
    });

    const res = await request(app).get('/api/organization').set(authHeader('orgB_admin'));
    expect(res.status).toBe(200);
    expect(res.body.id).toBe(ORG_B_ID);

    const calls = (prisma.organization.findUnique as Mock).mock.calls;
    for (const [args] of calls) {
      expect((args as any).where.id).toBe(ORG_B_ID);
      expect((args as any).where.id).not.toBe(ALPHA_ORG_ID);
    }
  });

  it('PATCH /api/organization as Org B → update keyed by Org B id, never touches Org A', async () => {
    mockAuthAs('orgB_admin');
    (prisma.organization.findUnique as Mock).mockResolvedValue({
      id: ORG_B_ID,
      lead_first_issued_at: null, estimate_first_issued_at: null,
      job_first_issued_at: null, invoice_first_issued_at: null,
      customer_first_issued_at: null,
      lead_prefix: 'L', estimate_prefix: 'E', job_prefix: 'J', invoice_prefix: 'I',
      customer_prefix: 'C',
      number_padding: 5,
    });
    (prisma.organization.update as Mock).mockResolvedValue({ id: ORG_B_ID, estimate_prefix: 'E' });
    (prisma.$transaction as Mock).mockImplementation((fn: any) => fn(prisma));
    (prisma.$executeRaw as Mock).mockResolvedValue(0);

    // Per spec: both orgs setting prefix "E" is allowed because composite uniques
    // are per-org. Setting prefix "E" on Org B must NOT touch Org A.
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('orgB_admin'))
      .send({ estimate_prefix: 'E' });

    expect(res.status).toBe(200);
    const calls = (prisma.organization.update as Mock).mock.calls;
    expect(calls.length).toBe(1);
    expect((calls[0][0] as any).where.id).toBe(ORG_B_ID);
    expect((calls[0][0] as any).where.id).not.toBe(ALPHA_ORG_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 7. PUBLIC ROUTES — token-based access boundary
// ═══════════════════════════════════════════════════════════════════════
describe('Attack 7 — Public route token boundary', () => {
  it('GET /api/estimates/:org-a-id/public with bogus token → 404 (token gate)', async () => {
    // Public routes don't use req.user; access is gated solely by id+token.
    (prisma.estimate.findFirst as Mock).mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/estimates/${ESTIMATE_FIXTURE.id}/public?token=wrong-token`);

    expect(res.status).toBe(404);
    // Token was passed to the query — token mismatch yields null → 404
    const calls = (prisma.estimate.findFirst as Mock).mock.calls;
    expect(calls.length).toBe(1);
    expect((calls[0][0] as any).where.public_token).toBe('wrong-token');
  });

  it('GET /api/invoices/:org-a-id/public with bogus token → 404', async () => {
    (prisma.invoice.findFirst as Mock).mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/invoices/${INVOICE_FIXTURE.id}/public?token=wrong-token`);

    expect(res.status).toBe(404);
    const calls = (prisma.invoice.findFirst as Mock).mock.calls;
    expect(calls.length).toBe(1);
    expect((calls[0][0] as any).where.public_token).toBe('wrong-token');
  });

  it('GET /api/estimates/:id/public WITHOUT token → 400 (no findFirst issued)', async () => {
    const res = await request(app).get(`/api/estimates/${ESTIMATE_FIXTURE.id}/public`);
    expect(res.status).toBe(400);
    expect(prisma.estimate.findFirst).not.toHaveBeenCalled();
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 8. NUMBER COLLISION BOUNDARY (per-org sequences)
// ═══════════════════════════════════════════════════════════════════════
describe('Attack 8 — Number collision boundary', () => {
  it('Org A and Org B can both create estimate E00001 (different rows)', async () => {
    // First, Org A creates an estimate.
    mockAuthAs('admin');
    (prisma.lead.findUnique as Mock).mockResolvedValue({
      ...LEAD_FIXTURE, organization_id: ALPHA_ORG_ID, status: 'CONTACTED', service_address_line1: '1', service_city: 'A', service_state: 'TX', service_zip: '78701',
    });
    (prisma.stateTaxRate.findFirst as Mock).mockResolvedValue({ tax_rate: 0.0625 });
    (prisma.estimate.create as Mock).mockResolvedValue({
      ...ESTIMATE_FIXTURE, estimate_number: 'E00001', organization_id: ALPHA_ORG_ID,
    });
    (prisma.$transaction as Mock).mockImplementation(async (cb: any) => cb(prisma));

    const resA = await request(app)
      .post('/api/estimates')
      .set(authHeader('admin'))
      .send({ lead_id: LEAD_FIXTURE.id, line_items: [{ description: 'x', quantity: 1, unit_price: 1, is_taxable: true, item_type: 'SERVICE' }] });

    expect(resA.status).toBe(201);
    expect(resA.body.estimate?.estimate_number).toBe('E00001');

    // Now Org B creates an estimate too. Same number (E00001), different org.
    vi.clearAllMocks();
    clearTokenCache();
    mockAuthAs('orgB_admin');
    (prisma.lead.findUnique as Mock).mockResolvedValue({
      ...LEAD_FIXTURE, id: 'e0000000-0000-0000-0000-bbbbbbbbbbbb', organization_id: ORG_B_ID, status: 'CONTACTED',
    });
    (prisma.stateTaxRate.findFirst as Mock).mockResolvedValue({ tax_rate: 0.0625 });
    (prisma.estimate.create as Mock).mockResolvedValue({
      ...ESTIMATE_FIXTURE, id: 'f0000000-0000-0000-0000-bbbbbbbbbbbb',
      estimate_number: 'E00001', organization_id: ORG_B_ID,
    });
    (prisma.$transaction as Mock).mockImplementation(async (cb: any) => cb(prisma));

    const resB = await request(app)
      .post('/api/estimates')
      .set(authHeader('orgB_admin'))
      .send({ lead_id: 'e0000000-0000-0000-0000-bbbbbbbbbbbb', line_items: [{ description: 'x', quantity: 1, unit_price: 1, is_taxable: true, item_type: 'SERVICE' }] });

    expect(resB.status).toBe(201);
    expect(resB.body.estimate?.estimate_number).toBe('E00001');

    // Confirm create payload assigned organization_id = ORG_B_ID
    const createArgs = (prisma.estimate.create as Mock).mock.calls[0][0];
    expect((createArgs as any).data.organization_id).toBe(ORG_B_ID);
  });

  it('PATCH /api/organization allows estimate_prefix="E" for Org B when Org A also uses "E"', async () => {
    // Prefixes are per-org. Setting Org B's prefix to "E" should succeed
    // even if Org A already uses "E" (no global uniqueness on the prefix).
    mockAuthAs('orgB_admin');
    (prisma.organization.findUnique as Mock).mockResolvedValue({
      id: ORG_B_ID,
      lead_first_issued_at: null, estimate_first_issued_at: null,
      job_first_issued_at: null, invoice_first_issued_at: null,
      customer_first_issued_at: null,
      lead_prefix: 'L', estimate_prefix: 'OLD', job_prefix: 'J', invoice_prefix: 'I',
      customer_prefix: 'C',
    });
    (prisma.organization.update as Mock).mockResolvedValue({ id: ORG_B_ID, estimate_prefix: 'E' });

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('orgB_admin'))
      .send({ estimate_prefix: 'E' });

    expect(res.status).toBe(200);
    expect((prisma.organization.update as Mock).mock.calls[0][0].where.id).toBe(ORG_B_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 9. TIMELINE / ATTACHMENTS LIST — filtered by parent org
// ═══════════════════════════════════════════════════════════════════════
describe('Attack 9 — Timeline / attachment list scoping', () => {
  it('GET /api/jobs/:org-a-job-id/timeline as Org B → 404/403, no events returned', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/jobs/${JOB_FIXTURE.id}/timeline`)
      .set(authHeader('orgB_admin'));

    expect([403, 404]).toContain(res.status);
    everyWhereScopedTo(prisma.job.findUnique as Mock, ORG_B_ID);
  });

  it('GET /api/attachments/LEAD/:org-a-id as Org B → 403/404', async () => {
    mockAuthAs('orgB_admin');
    (prisma.lead.findUnique as Mock).mockResolvedValue(null);

    const res = await request(app)
      .get(`/api/attachments/LEAD/${LEAD_FIXTURE.id}`)
      .set(authHeader('orgB_admin'));

    expect([403, 404]).toContain(res.status);
    everyWhereScopedTo(prisma.lead.findUnique as Mock, ORG_B_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 10. TAGS — cross-org tag attach/remove and list scoping
// ═══════════════════════════════════════════════════════════════════════
const ORG_B_LEAD_ID = 'ba000000-0000-0000-0000-000000000001';

describe('Attack 10 — Tag cross-org IDOR', () => {
  it('GET /api/tags as Org B → query scoped to Org B (no Org A tags)', async () => {
    mockAuthAs('orgB_admin');
    (prisma.tag.findMany as Mock).mockResolvedValue([]);

    const res = await request(app).get('/api/tags').set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    everyWhereScopedTo(prisma.tag.findMany as Mock, ORG_B_ID);
  });

  it('POST /api/leads/:org-a-id/tags as Org B → 404, no tag attached', async () => {
    mockAuthAs('orgB_admin');
    (prisma.lead.findFirst as Mock).mockResolvedValue(null); // lead is in Org A, invisible to B

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/tags`)
      .set(authHeader('orgB_admin'))
      .send({ name: 'PWNED' });

    expect(res.status).toBe(404);
    expect(prisma.tagAssignment.create).not.toHaveBeenCalled();
    everyWhereScopedTo(prisma.lead.findFirst as Mock, ORG_B_ID);
  });

  it('POST /api/leads/:own-id/tags with Org A tag_id as Org B → 404, no link created', async () => {
    mockAuthAs('orgB_admin');
    // A well-formed uuid rather than the old `orgb-lead` placeholder: the tag routes now reject a
    // malformed `:id` before the controller runs, which would short-circuit this request ahead of
    // the tag lookup and leave the org-scoping assertion below with nothing to inspect.
    (prisma.lead.findFirst as Mock).mockResolvedValue({ id: ORG_B_LEAD_ID, organization_id: ORG_B_ID });
    (prisma.tag.findFirst as Mock).mockResolvedValue(null); // tag is in Org A

    const res = await request(app)
      .post(`/api/leads/${ORG_B_LEAD_ID}/tags`)
      .set(authHeader('orgB_admin'))
      .send({ tag_id: 'a0000000-0000-0000-0000-000000000001' });

    expect(res.status).toBe(404);
    expect(prisma.tagAssignment.create).not.toHaveBeenCalled();
    everyWhereScopedTo(prisma.tag.findFirst as Mock, ORG_B_ID);
  });

  it('DELETE /api/leads/:org-a-id/tags/:tagId as Org B → 404, no link removed', async () => {
    mockAuthAs('orgB_admin');
    (prisma.lead.findFirst as Mock).mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/leads/${LEAD_FIXTURE.id}/tags/a0000000-0000-0000-0000-000000000001`)
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    expect(prisma.tagAssignment.delete).not.toHaveBeenCalled();
    everyWhereScopedTo(prisma.lead.findFirst as Mock, ORG_B_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 11. DEPARTMENTS — cross-org mutation must not orphan other orgs' users
// ═══════════════════════════════════════════════════════════════════════
describe('Attack 11 — Department cross-org IDOR', () => {
  it('GET /api/departments as Org B → list scoped to Org B', async () => {
    mockAuthAs('orgB_admin');
    (prisma.department.findMany as Mock).mockResolvedValue([]);

    const res = await request(app).get('/api/departments').set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    everyWhereScopedTo(prisma.department.findMany as Mock, ORG_B_ID);
  });

  it('PATCH /api/departments/:org-a-id as Org B → 404, no rename', async () => {
    mockAuthAs('orgB_admin');
    (prisma.department.findFirst as Mock).mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/departments/d0000000-0000-0000-0000-000000000001')
      .set(authHeader('orgB_admin'))
      .send({ name: 'PWNED' });

    expect(res.status).toBe(404);
    expect(prisma.department.update).not.toHaveBeenCalled();
    everyWhereScopedTo(prisma.department.findFirst as Mock, ORG_B_ID);
  });

  it('DELETE /api/departments/:org-a-id as Org B → 404, no deletion', async () => {
    mockAuthAs('orgB_admin');
    // Atomic deleteMany scoped by id + org filter — returns {count:0} when no Org B match
    (prisma.department.deleteMany as Mock).mockResolvedValue({ count: 0 });

    const res = await request(app)
      .delete('/api/departments/d0000000-0000-0000-0000-000000000001')
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    everyWhereScopedTo(prisma.department.deleteMany as Mock, ORG_B_ID);
  });

  it('POST /api/departments as Org B with name "Service" succeeds even if Org A has same name', async () => {
    mockAuthAs('orgB_admin');
    (prisma.department.findUnique as Mock).mockResolvedValue(null); // no collision within Org B
    (prisma.department.create as Mock).mockResolvedValue({
      id: 'd0000000-0000-0000-0000-000000000099', name: 'Service', created_at: new Date(),
    });

    const res = await request(app)
      .post('/api/departments')
      .set(authHeader('orgB_admin'))
      .send({ name: 'Service' });

    expect(res.status).toBe(201);
    const createCall = (prisma.department.create as Mock).mock.calls[0][0];
    expect(createCall.data.organization_id).toBe(ORG_B_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 12. PRICE BOOK — categories and items cross-org mutation
// ═══════════════════════════════════════════════════════════════════════
describe('Attack 12 — Price book cross-org IDOR', () => {
  it('GET /api/price-book/categories as Org B → query scoped to Org B', async () => {
    mockAuthAs('orgB_admin');
    (prisma.priceBookCategory.findMany as Mock).mockResolvedValue([]);

    const res = await request(app).get('/api/price-book/categories').set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    everyWhereScopedTo(prisma.priceBookCategory.findMany as Mock, ORG_B_ID);
  });

  it('GET /api/price-book/items as Org B → query scoped to Org B (no Org A items)', async () => {
    mockAuthAs('orgB_admin');
    (prisma.priceBookItem.findMany as Mock).mockResolvedValue([]);
    (prisma.priceBookItem.count as Mock).mockResolvedValue(0);

    const res = await request(app).get('/api/price-book/items').set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    everyWhereScopedTo(prisma.priceBookItem.findMany as Mock, ORG_B_ID);
  });

  it('GET /api/price-book/items/search as Org B → query scoped to Org B', async () => {
    mockAuthAs('orgB_admin');
    (prisma.priceBookItem.findMany as Mock).mockResolvedValue([]);

    const res = await request(app)
      .get('/api/price-book/items/search?q=test')
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    everyWhereScopedTo(prisma.priceBookItem.findMany as Mock, ORG_B_ID);
  });

  it('GET /api/price-book/items/:org-a-id as Org B → 404, no leak', async () => {
    mockAuthAs('orgB_admin');
    (prisma.priceBookItem.findFirst as Mock).mockResolvedValue(null);

    const res = await request(app)
      .get('/api/price-book/items/db100000-0000-0000-0000-000000000001')
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    everyWhereScopedTo(prisma.priceBookItem.findFirst as Mock, ORG_B_ID);
  });

  it('PATCH /api/price-book/items/:org-a-id as Org B → 404, no mutation', async () => {
    mockAuthAs('orgB_admin');
    (prisma.priceBookItem.findFirst as Mock).mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/price-book/items/db100000-0000-0000-0000-000000000001')
      .set(authHeader('orgB_admin'))
      .send({ unit_price: 999999 });

    expect(res.status).toBe(404);
    expect(prisma.priceBookItem.update).not.toHaveBeenCalled();
    everyWhereScopedTo(prisma.priceBookItem.findFirst as Mock, ORG_B_ID);
  });

  it('DELETE /api/price-book/items/:org-a-id as Org B → 404, no delete or archive', async () => {
    mockAuthAs('orgB_admin');
    // Hybrid delete gates on a tenant-scoped findFirst before any mutation - mirrors
    // the PATCH case above (updateItem uses the same findFirst-first pattern).
    (prisma.priceBookItem.findFirst as Mock).mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/price-book/items/db100000-0000-0000-0000-000000000001')
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    expect(prisma.priceBookItem.updateMany).not.toHaveBeenCalled();
    expect(prisma.priceBookItem.deleteMany).not.toHaveBeenCalled();
    everyWhereScopedTo(prisma.priceBookItem.findFirst as Mock, ORG_B_ID);
  });

  it('PATCH /api/price-book/categories/:org-a-id as Org B → 404, no mutation', async () => {
    mockAuthAs('orgB_admin');
    (prisma.priceBookCategory.findFirst as Mock).mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/price-book/categories/ca000000-0000-0000-0000-000000000001')
      .set(authHeader('orgB_admin'))
      .send({ name: 'PWNED' });

    expect(res.status).toBe(404);
    expect(prisma.priceBookCategory.update).not.toHaveBeenCalled();
    everyWhereScopedTo(prisma.priceBookCategory.findFirst as Mock, ORG_B_ID);
  });

  it('DELETE /api/price-book/categories/:org-a-id as Org B → 404, no deletion', async () => {
    mockAuthAs('orgB_admin');
    (prisma.priceBookCategory.findFirst as Mock).mockResolvedValue(null);

    const res = await request(app)
      .delete('/api/price-book/categories/ca000000-0000-0000-0000-000000000001')
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    expect(prisma.priceBookCategory.delete).not.toHaveBeenCalled();
    everyWhereScopedTo(prisma.priceBookCategory.findFirst as Mock, ORG_B_ID);
  });
});

// ═══════════════════════════════════════════════════════════════════════
// 13. CROSS-ORG REFERENCE INJECTION — body fields pointing at another org's row
// ═══════════════════════════════════════════════════════════════════════
describe('Attack 13 — Cross-org reference injection', () => {
  it('POST /api/estimates with Org A price_book_item_id as Org B → 400', async () => {
    const ORGB_LEAD_ID = 'e0000000-0000-0000-0000-bbbbbbbbbbbb';
    mockAuthAs('orgB_admin');
    (prisma.lead.findUnique as Mock).mockResolvedValue({
      id: ORGB_LEAD_ID, organization_id: ORG_B_ID, status: 'CONTACTED', lead_assignees: [{ user_id: TEST_USERS.orgB_admin.id }],
    });
    // Org B's view of the price book never sees Org A's item: findMany returns empty.
    (prisma.priceBookItem.findMany as Mock).mockResolvedValue([]);

    const res = await request(app)
      .post('/api/estimates')
      .set(authHeader('orgB_admin'))
      .send({
        lead_id: ORGB_LEAD_ID,
        line_items: [
          {
            description: 'cross-org item',
            quantity: 1,
            unit_price: 1,
            is_taxable: true,
            item_type: 'SERVICE',
            price_book_item_id: 'db100000-0000-0000-0000-000000000001', // Org A's item
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    everyWhereScopedTo(prisma.priceBookItem.findMany as Mock, ORG_B_ID);
  });

  it('POST /api/users with Org A department_id as Org B → 400', async () => {
    mockAuthAs('orgB_admin');
    (prisma.department.findFirst as Mock).mockResolvedValue(null); // department is in Org A

    const res = await request(app)
      .post('/api/users')
      .set(authHeader('orgB_admin'))
      .send({
        email: 'new@orgb.test',
        password: 'StrongPass!1',
        first_name: 'A', last_name: 'B', role: 'SALES',
        department_id: 'd0000000-0000-0000-0000-000000000001', // Org A's dept
      });

    expect(res.status).toBe(400);
    everyWhereScopedTo(prisma.department.findFirst as Mock, ORG_B_ID);
  });

  it('PATCH /api/users/:own-id with Org A department_id as Org B → 400, no role escalation', async () => {
    mockAuthAs('orgB_admin');
    // mockAuthAs wires user.findUnique to TEST_USERS lookup for the authenticate
    // middleware (needs the full user with role for authorize('ADMIN')). The
    // controller now resolves the target via findFirst, so wire that to return
    // the orgB admin (their own row) — we must reach the dept check, not 404.
    (prisma.user.findFirst as Mock).mockResolvedValue(TEST_USERS.orgB_admin);
    (prisma.department.findFirst as Mock).mockResolvedValue(null); // dept is in Org A

    const res = await request(app)
      .patch(`/api/users/${TEST_USERS.orgB_admin.id}`)
      .set(authHeader('orgB_admin'))
      .send({ department_id: 'd0000000-0000-0000-0000-000000000001' });

    expect(res.status).toBe(400);
    expect(prisma.user.update).not.toHaveBeenCalled();
    everyWhereScopedTo(prisma.department.findFirst as Mock, ORG_B_ID);
  });

  it('PATCH /api/estimates/:own-id (revise) with Org A price_book_item_id as Org B → 400', async () => {
    const ORGB_EST_ID = 'f0000000-0000-0000-0000-bbbbbbbbbbbb';
    mockAuthAs('orgB_admin');
    // Estimate self-lookup succeeds (in Org B, DRAFT, sales-accessible)
    (prisma.estimate.findUnique as Mock).mockResolvedValue({
      id: ORGB_EST_ID, status: 'DRAFT', tax_rate: 0.0625,
      discount_type: null, discount_value: null,
      lead: { lead_assignees: [{ user_id: TEST_USERS.orgB_admin.id }] },
    });
    // Cross-org price_book_item_id check fails — findMany returns empty
    (prisma.priceBookItem.findMany as Mock).mockResolvedValue([]);

    const res = await request(app)
      .patch(`/api/estimates/${ORGB_EST_ID}`)
      .set(authHeader('orgB_admin'))
      .send({
        line_items: [
          {
            description: 'cross-org item',
            quantity: 1,
            unit_price: 1,
            is_taxable: true,
            item_type: 'SERVICE',
            price_book_item_id: 'db100000-0000-0000-0000-000000000001', // Org A's item
          },
        ],
      });

    expect(res.status).toBe(400);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    everyWhereScopedTo(prisma.priceBookItem.findMany as Mock, ORG_B_ID);
  });
});
