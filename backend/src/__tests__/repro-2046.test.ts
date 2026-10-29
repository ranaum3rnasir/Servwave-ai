/**
 * #2046 — SALES must not see the Communication section: sidebar group, /communication/*
 * pages, org-wide inbox list endpoints. The lead/job Communication TAB stays reachable.
 *
 * Reproduced on prod (Pass A, demo org, commit 272d4f7e998face0ccf2864e638eb4bc9bbcb9a8):
 * SALES holds an unconditional `read Communication` CASL grant (defaultGrants.ts:174), and
 * EVERY org-wide Communication-section endpoint is gated on nothing more specific than that one
 * grant (canDo('read'|'create'|'update'|'delete', 'Communication') — comm-threads.routes.ts:14,
 * comm-calls.routes.ts:20, comm-whatsapp-email.controller's routers, comm-shared.routes.ts:33-34,
 * comm-config.routes.ts:14, comm-agents.routes.ts:14, comm-numbers.routes.ts:32). There is no
 * separate "may see the section" gate today.
 *
 * Chosen gate: a NEW action `access_inbox` on the EXISTING subject `Communication` — NOT a new
 * `Inbox` subject. This mirrors the `log_past` precedent exactly (catalog.ts:54/267,
 * roleViewModel.ts:87): a sensitive-bundle toggle on Communication, independent of the CRUD verbs,
 * requiring one catalog row + one roleViewModel bundle rather than new Subject plumbing across
 * both backend catalog.ts AND frontend ability.ts (MODULES, ScopeResource, nav-registry, etc. all
 * key off the Subject union). CASL's (action, subject) pair already treats `access_inbox` as
 * fully independent of `read Communication`, so a role can hold one without the other — exactly
 * the shape Ran's decision needs (DISPATCHER/TECHNICIAN/ADMIN hold it; SALES does not).
 *
 * These cases are hand-injected grants (`access_inbox` does not exist in the Action catalog type
 * yet — that is the fix stage's job), following the #2042 precedent's
 * `mockSalesReadPurchaseOrderScoped` pattern: extend a role's real DEFAULT_GRANTS with one grant
 * row the fix is expected to add, and prove today's routes ignore it (RED) or already permit
 * default behaviour (GREEN control).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  mockAuthAs, authHeader,
  LEAD_FIXTURE, JOB_FIXTURE,
} from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearTokenCache } from '../middleware/authenticate';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const LEAD_ID = LEAD_FIXTURE.id;
const JOB_ID = JOB_FIXTURE.id;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearTokenCache();

  // Safe defaults for every org-wide list controller under test — mirrors
  // comm-visibility.test.ts's beforeEach, so a request that reaches its handler
  // today (SALES currently CAN) returns 200 with an empty, harmless payload
  // rather than a 500 from an un-mocked delegate. A 500 would make the RED
  // assertion (200 today) fail for the WRONG reason (setup, not the reported
  // leak) — the red-flag TDD skill explicitly warns against that.
  mockPrisma.callSession.findMany.mockResolvedValue([]);
  mockPrisma.messageThread.findMany.mockResolvedValue([]);
  mockPrisma.messageThread.aggregate.mockResolvedValue({ _sum: { unread: 0 } });
  mockPrisma.message.findMany.mockResolvedValue([]);
  mockPrisma.whatsAppChat.findMany.mockResolvedValue([]);
  mockPrisma.whatsAppChat.aggregate.mockResolvedValue({ _sum: { unread: 0 } });
  mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);
  mockPrisma.email.findMany.mockResolvedValue([]);
  mockPrisma.email.count.mockResolvedValue(0);
  mockPrisma.user.findMany.mockResolvedValue([]);
  mockPrisma.phoneAgent.findMany.mockResolvedValue([]);
  mockPrisma.phoneNumber.findMany.mockResolvedValue([]);
  mockPrisma.callFlow.findMany.mockResolvedValue([]);
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// RED — SALES holds `read Communication` (the ONLY gate today) but must NOT hold the new
// section gate. Every org-wide Communication list must 403. Today every one of them 200s.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('#2046 SALES on org-wide Communication-section endpoints — must 403, today 200', () => {
  it('GET /api/communication/threads (SMS/team inbox list) — comm-threads.routes.ts:14', async () => {
    mockAuthAs('sales');
    const res = await request(app).get('/api/communication/threads').set(authHeader('sales'));
    expect(res.status).toBe(403);
  });

  it('GET /api/communication/calls (call log list) — comm-calls.routes.ts:20', async () => {
    mockAuthAs('sales');
    const res = await request(app).get('/api/communication/calls').set(authHeader('sales'));
    expect(res.status).toBe(403);
  });

  it('GET /api/communication/emails (email inbox list) — comm-email.routes.ts:63', async () => {
    mockAuthAs('sales');
    const res = await request(app).get('/api/communication/emails').set(authHeader('sales'));
    expect(res.status).toBe(403);
  });

  it('GET /api/communication/whatsapp (WhatsApp chat list) — comm-whatsapp.routes.ts:34', async () => {
    // WhatsApp routes 404 via requireDemoOrg for a real org (comm-whatsapp.routes.ts) — run
    // against the demo org so the request actually reaches canDo, matching comm-visibility.test.ts.
    mockAuthAs('sales', { is_demo: true });
    const res = await request(app).get('/api/communication/whatsapp').set(authHeader('sales'));
    expect(res.status).toBe(403);
  });

  it('GET /api/communication/unread-counts (section badge) — comm-shared.routes.ts:33', async () => {
    mockAuthAs('sales');
    const res = await request(app).get('/api/communication/unread-counts').set(authHeader('sales'));
    expect(res.status).toBe(403);
  });

  it('GET /api/communication/team-members (org directory, messaging shape) — comm-shared.routes.ts:34', async () => {
    mockAuthAs('sales');
    const res = await request(app).get('/api/communication/team-members').set(authHeader('sales'));
    expect(res.status).toBe(403);
  });

  it('GET /api/communication/call-flows (config, section-only) — comm-config.routes.ts:14', async () => {
    mockAuthAs('sales');
    const res = await request(app).get('/api/communication/call-flows').set(authHeader('sales'));
    expect(res.status).toBe(403);
  });

  it('GET /api/communication/agents (phone agents, section-only) — comm-agents.routes.ts:14', async () => {
    mockAuthAs('sales');
    const res = await request(app).get('/api/communication/agents').set(authHeader('sales'));
    expect(res.status).toBe(403);
  });

  it('GET /api/communication/numbers (numbers platform, section-only) — comm-numbers.routes.ts:32', async () => {
    mockAuthAs('sales');
    const res = await request(app).get('/api/communication/numbers').set(authHeader('sales'));
    expect(res.status).toBe(403);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// GREEN (must stay) — the lead/job Communication TAB is a separate, already anchor-scoped code
// path (job-communications.controller.ts) and must keep 200ing for SALES on their own record,
// whatever the section gate ends up doing to the org-wide lists above.
// ═══════════════════════════════════════════════════════════════════════════════════════════

describe('#2046 the lead/job Communication tab stays reachable for SALES on their own record', () => {
  function mockEmptyChannels() {
    mockPrisma.callSession.findMany.mockResolvedValue([]);
    mockPrisma.message.findMany.mockResolvedValue([]);
    mockPrisma.email.findMany.mockResolvedValue([]);
    mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);
  }

  it('GET /api/leads/:id/communications — the OWNING SALES rep still gets 200', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({ id: LEAD_ID });
    // canAccessRow's OWN_LEAD scope check.
    mockPrisma.lead.findFirst.mockResolvedValue({ id: LEAD_ID });
    mockEmptyChannels();

    const res = await request(app).get(`/api/leads/${LEAD_ID}/communications`).set(authHeader('sales'));
    expect(res.status).toBe(200);
  });

  it('GET /api/jobs/:id/communications — the OWNING SALES rep still gets 200', async () => {
    mockAuthAs('sales');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
    // canAccessRow's OWN_JOB_VIA_ESTIMATE scope check.
    mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_ID });
    mockEmptyChannels();

    const res = await request(app).get(`/api/jobs/${JOB_ID}/communications`).set(authHeader('sales'));
    expect(res.status).toBe(200);
  });
});

// ═══════════════════════════════════════════════════════════════════════════════════════════
// GREEN (control) — a role holding the new section gate (hand-injected, the shape the fix's
// migration is expected to write) keeps 200ing the org-wide lists. Already true today (these
// roles hold `read Communication` unconditionally), so this stays green before AND after the fix
// — it exists to prove the fix must not narrow DISPATCHER/ADMIN while it narrows SALES.
// ═══════════════════════════════════════════════════════════════════════════════════════════

function mockDispatcherWithAccessInbox() {
  const rows = [
    ...DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER'),
    { role: 'DISPATCHER', action: 'access_inbox', subject: 'Communication' },
  ];
  mockPrisma.rolePermission.findMany.mockResolvedValue(rows);
  clearPermissionCache();
}

describe('#2046 a role holding the section gate keeps org-wide access', () => {
  it('DISPATCHER + access_inbox → GET /api/communication/threads is 200', async () => {
    mockAuthAs('dispatcher');
    mockDispatcherWithAccessInbox();
    const res = await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
  });

  it('DISPATCHER + access_inbox → GET /api/communication/calls is 200', async () => {
    mockAuthAs('dispatcher');
    mockDispatcherWithAccessInbox();
    const res = await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
  });

  it('ADMIN (manage-all bypass, no grant row needed) → GET /api/communication/threads is 200', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/communication/threads').set(authHeader('admin'));
    expect(res.status).toBe(200);
  });
});
