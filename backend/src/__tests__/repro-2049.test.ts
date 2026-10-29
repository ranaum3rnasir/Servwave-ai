/**
 * #2049 — Read state is per user across the inbox; SMS threads get a persisted marker and
 * email mark-read stops 403ing for SALES (Sales-Role QA Tracker row 024).
 *
 * Reproduced on prod (Pass A, demo org, commit 1f0d983b079d9e460db5543a7e60308baf4ad1c4):
 *   1. `PATCH /api/communication/emails/thread-read` is gated
 *      `canDo('update','Communication')` THEN `canDo('access_inbox','Communication')`
 *      (comm-email.routes.ts:82) — both run before validate()/the controller, so SALES
 *      (default grants: only `read Communication`, unconditional — defaultGrants.ts:189)
 *      403s for ANY thread_id. Live-verified: SALES → 403; DISPATCHER (holds both) → 200 and
 *      the resulting `EmailReadState` row is genuinely per user (DISPATCHER's mark-read left
 *      the same email `unread: true` for ADMIN).
 *   2. There is NO read-state route for SMS threads at all — `PATCH
 *      /api/communication/threads/:id/read` is unregistered (404 `{"error":"Not found"}`,
 *      Express fallthrough, comm-threads.routes.ts full read confirms no PATCH/POST route
 *      touches read state). The only WRITE to `MessageThread.unread` anywhere in the backend
 *      is the increment in `ctm/ingest.ts:1039`; `mapThread` (comm-threads.controller.ts:191)
 *      returns `unread: t.unread`, a bare passthrough with no per-caller computation.
 *
 * Desired behaviour (issue body, "Agent Brief"): a per-user read marker for SMS threads,
 * modelled like `EmailReadState`; `PATCH /api/communication/threads/:id/read` gated on
 * `read Communication` + anchor visibility, never `update`; the existing email thread-read
 * route re-gated the same way.
 *
 * These tests build SALES's ability from real `DEFAULT_GRANTS` (no hand-injected rows — SALES
 * already holds unconditional `read Communication` today; that is exactly what makes the
 * `update`+`access_inbox` gate on the email route the bug, not a missing grant).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  mockAuthAs, authHeader, ALPHA_ORG_ID, TEST_USERS, LEAD_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearTokenCache } from '../middleware/authenticate';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const SALES_ID = TEST_USERS.sales.id;
const DISPATCHER_ID = TEST_USERS.dispatcher.id;
const LEAD_ID = LEAD_FIXTURE.id;
const THREAD_ID = 'a1111111-1111-4111-8111-111111111111';

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearTokenCache();
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 1. Email thread-read — SALES holds ONLY `read Communication` (real DEFAULT_GRANTS, no
//    hand-injection) and must be able to mark their own thread read. Today: 403.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('#2049 PATCH /api/communication/emails/thread-read must be reachable on `read Communication` alone', () => {
  it('SALES (no `update Communication`) marks a visible thread read — today 403 (comm-email.routes.ts:82)', async () => {
    mockAuthAs('sales');
    mockPrisma.email.findMany.mockResolvedValue([{ id: 'e-sales-1' }]);
    mockPrisma.emailReadState.createMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch('/api/communication/emails/thread-read')
      .set(authHeader('sales'))
      .send({ thread_id: THREAD_ID });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
  });

  it('SALES marking a thread read does not steal or block a DISPATCHER read on the same thread — per-user, both must succeed', async () => {
    mockPrisma.email.findMany.mockResolvedValue([{ id: 'e-shared-1' }]);
    mockPrisma.emailReadState.createMany.mockResolvedValue({ count: 1 });

    mockAuthAs('sales');
    const salesRes = await request(app)
      .patch('/api/communication/emails/thread-read')
      .set(authHeader('sales'))
      .send({ thread_id: THREAD_ID });

    mockAuthAs('dispatcher');
    const dispatcherRes = await request(app)
      .patch('/api/communication/emails/thread-read')
      .set(authHeader('dispatcher'))
      .send({ thread_id: THREAD_ID });

    expect(salesRes.status).toBe(200);
    expect(dispatcherRes.status).toBe(200);
    // Today SALES 403s before the controller ever runs, so only the DISPATCHER call reaches
    // `emailReadState.createMany` — this fails at 2 vs. 1 for the reported reason.
    expect(mockPrisma.emailReadState.createMany).toHaveBeenCalledTimes(2);
    const salesData = mockPrisma.emailReadState.createMany.mock.calls[0][0].data;
    const dispatcherData = mockPrisma.emailReadState.createMany.mock.calls[1][0].data;
    expect(salesData.every((d: { user_id: string }) => d.user_id === SALES_ID)).toBe(true);
    expect(dispatcherData.every((d: { user_id: string }) => d.user_id === DISPATCHER_ID)).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// 2. SMS thread read state — the route does not exist anywhere on the server today
//    (comm-threads.routes.ts full read: no PATCH/POST touching read state). Every assertion
//    below states the desired route's contract; all fail today via a bare Express 404.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('#2049 PATCH /api/communication/threads/:id/read must exist and be per user — today 404, no route registered', () => {
  it('SALES marks their own lead-anchored SMS thread read — today 404 (route does not exist)', async () => {
    mockAuthAs('sales');
    mockPrisma.messageThread.findFirst.mockResolvedValue({
      id: THREAD_ID,
      organization_id: ALPHA_ORG_ID,
      unread: 1,
      messages: [{
        id: 'm1', lead_id: LEAD_ID, job_id: null, job: null, customer_id: null, vendor_id: null,
        lead: { lead_assignees: [{ user_id: SALES_ID }] },
      }],
    });

    const res = await request(app)
      .patch(`/api/communication/threads/${THREAD_ID}/read`)
      .set(authHeader('sales'))
      .send({});

    expect(res.status).toBe(200);
  });

  it('marking it read as SALES leaves a DISPATCHER\'s own view of the same thread unaffected (per-user marker, not the shared `unread` column) — today 404 before any of this can be exercised', async () => {
    mockAuthAs('sales');
    mockPrisma.messageThread.findFirst.mockResolvedValue({
      id: THREAD_ID,
      organization_id: ALPHA_ORG_ID,
      unread: 1,
      messages: [{
        id: 'm1', lead_id: LEAD_ID, job_id: null, job: null, customer_id: null, vendor_id: null,
        lead: { lead_assignees: [{ user_id: SALES_ID }] },
      }],
    });

    const salesRead = await request(app)
      .patch(`/api/communication/threads/${THREAD_ID}/read`)
      .set(authHeader('sales'))
      .send({});
    // The reported bug, stated as the desired contract: this must succeed for SALES.
    expect(salesRead.status).toBe(200);

    mockAuthAs('dispatcher');
    const dispatcherView = await request(app)
      .get(`/api/communication/threads/${THREAD_ID}`)
      .set(authHeader('dispatcher'));

    // The shared `unread` column must not have been zeroed by SALES's read — a DISPATCHER
    // who has not opened the thread still sees it unread. mapThread today is a bare
    // passthrough of `t.unread` with no per-caller computation at all, so this line alone
    // cannot distinguish "fixed" from "never touched"; it exists to fail LOUDLY (via the
    // salesRead assertion above) the moment the marker is per-user rather than a shared write.
    expect(dispatcherView.body.thread?.unread).toBeGreaterThan(0);
  });

  it('a thread on a different organization → 404 (control: trivially true today because no route is registered at all; must stay true once tenantWhere is the reason)', async () => {
    mockAuthAs('sales');
    mockPrisma.messageThread.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/communication/threads/${THREAD_ID}/read`)
      .set(authHeader('sales'))
      .send({});

    expect(res.status).toBe(404);
  });
});
