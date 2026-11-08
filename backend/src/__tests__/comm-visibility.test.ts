import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, TEST_USERS } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { matchesWhere, type Row } from './whereMatcher';

/**
 * Communication visibility inheritance (email slice 8a).
 *
 * THE RULE: a comm row is visible to whoever can see the entity it hangs off,
 * with precedence job > lead > customer/vendor. Customer-only, vendor-only and
 * unanchored rows are visible ORG-WIDE - customers and vendors are deliberately
 * not row-restricted.
 *
 * THESE TESTS ASSERT THE FILTER IS IN THE QUERY, NEVER IN THE RESPONSE. Workiz
 * leaks in production precisely because their cascade reads like UI-level hiding
 * over an unscoped query, so every assertion here captures the `where` the
 * handler actually handed prisma and runs fixture rows through it (whereMatcher)
 * - never the rendered payload, and never a component.
 */

const mockPrisma = prisma as any;

const TECH_ID = TEST_USERS.technician.id;
const SALES_ID = TEST_USERS.sales.id;

// ─── Anchor fixtures ─────────────────────────────────────────────────────────

// S8 (D6): OWN_JOB reaches crew through the job's trips, so these rows carry it there.
const MY_JOB = { id: 'ab000000-0000-0000-0000-00000000000a', visits: [{ assignees: [{ user_id: TECH_ID }] }] };
const OTHER_JOB = { id: 'ab000000-0000-0000-0000-00000000000b', visits: [{ assignees: [{ user_id: 'someone-else' }] }] };
const MY_LEAD = {
  id: 'ac000000-0000-0000-0000-00000000000a',
  lead_assignees: [{ user_id: SALES_ID }],
  visits: [{ performers: [{ user_id: TECH_ID }] }],
};
const OTHER_LEAD = {
  id: 'ac000000-0000-0000-0000-00000000000b',
  lead_assignees: [{ user_id: 'someone-else' }],
  visits: [],
};

/** A comm row of any channel, in the anchor shape all four now share. */
function row(id: string, anchors: Partial<Row> = {}): Row {
  return {
    id,
    // Present so the tenant key in a captured `where` evaluates rather than
    // silently excluding every fixture row (which would make a
    // `not.toContain` assertion pass vacuously).
    organization_id: ALPHA_ORG_ID,
    job_id: null,
    job: null,
    lead_id: null,
    lead: null,
    customer_id: null,
    vendor_id: null,
    ...anchors,
  };
}

/** A conversation (MessageThread / WhatsAppChat) holding the given messages. */
function parent(id: string, messages: Row[]): Row {
  return { id, organization_id: ALPHA_ORG_ID, messages };
}

// Fixture ids are real uuids, and every assertion references the constant
// (never a literal), for two reasons. These ids travel through `:id` routes
// whose columns are Postgres `uuid`, so a label-shaped id can no longer reach
// a handler at all - `requireUuidParam` 404s it first. And comparing against a
// literal that no longer matches any fixture would make `not.toContain(...)`
// pass VACUOUSLY, quietly gutting the scoping checks this suite exists for.
const ON_MY_JOB = row('aa000000-0000-4000-8000-000000000001', { job_id: MY_JOB.id, job: MY_JOB });
const ON_OTHER_JOB = row('aa000000-0000-4000-8000-000000000002', { job_id: OTHER_JOB.id, job: OTHER_JOB });
const ON_MY_LEAD = row('aa000000-0000-4000-8000-000000000003', { lead_id: MY_LEAD.id, lead: MY_LEAD });
const ON_OTHER_LEAD = row('aa000000-0000-4000-8000-000000000004', { lead_id: OTHER_LEAD.id, lead: OTHER_LEAD });
const CUSTOMER_ONLY = row('aa000000-0000-4000-8000-000000000005', { customer_id: 'c0000000-0000-0000-0000-000000000001' });
const VENDOR_ONLY = row('aa000000-0000-4000-8000-000000000006', { vendor_id: 'v0000000-0000-0000-0000-000000000001' });
const UNANCHORED = row('aa000000-0000-4000-8000-000000000007');
// THE PRECEDENCE ROW. persistTransactionalEmail stamps customer_id, lead_id AND
// job_id onto the same row, so nearly every job-anchored email is also
// customer-anchored. If the implementation ORs independent anchors instead of
// applying precedence, the customer branch rescues this row and the whole filter
// is theatre. This is the case that catches a wrong implementation.
const ON_OTHER_JOB_AND_CUSTOMER = row('aa000000-0000-4000-8000-000000000008', {
  job_id: OTHER_JOB.id,
  job: OTHER_JOB,
  lead_id: MY_LEAD.id,
  lead: MY_LEAD,
  customer_id: 'c0000000-0000-0000-0000-000000000001',
});

const ALL = [
  ON_MY_JOB,
  ON_OTHER_JOB,
  ON_MY_LEAD,
  ON_OTHER_LEAD,
  CUSTOMER_ONLY,
  VENDOR_ONLY,
  UNANCHORED,
  ON_OTHER_JOB_AND_CUSTOMER,
];

function visible(where: Record<string, unknown>, rows: Row[] = ALL): string[] {
  return rows.filter((r) => matchesWhere(r, where)).map((r) => r.id as string);
}

/** The `where` the handler handed prisma on the Nth call of a mocked delegate. */
function capturedWhere(fn: Mock, call = 0): Record<string, unknown> {
  expect(fn, 'expected the handler to query prisma').toHaveBeenCalled();
  return fn.mock.calls[call][0].where as Record<string, unknown>;
}

/** The nested include filter for a parent's child messages, if the handler set one. */
function capturedMessagesInclude(fn: Mock, call = 0): Record<string, unknown> | undefined {
  const args = fn.mock.calls[call][0];
  const messages = args.include?.messages ?? args.select?.messages;
  return messages?.where as Record<string, unknown> | undefined;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  mockPrisma.callSession.findMany.mockResolvedValue([]);
  mockPrisma.callSession.findFirst.mockResolvedValue(null);
  mockPrisma.messageThread.findMany.mockResolvedValue([]);
  mockPrisma.messageThread.findFirst.mockResolvedValue(null);
  mockPrisma.messageThread.aggregate.mockResolvedValue({ _sum: { unread: 0 } });
  mockPrisma.message.findMany.mockResolvedValue([]);
  mockPrisma.whatsAppChat.findMany.mockResolvedValue([]);
  mockPrisma.whatsAppChat.findFirst.mockResolvedValue(null);
  mockPrisma.whatsAppChat.aggregate.mockResolvedValue({ _sum: { unread: 0 } });
  mockPrisma.whatsAppMessage.findMany.mockResolvedValue([]);
  mockPrisma.email.findMany.mockResolvedValue([]);
  mockPrisma.email.findFirst.mockResolvedValue(null);
  mockPrisma.email.count.mockResolvedValue(0);
  mockPrisma.email.updateMany.mockResolvedValue({ count: 0 });
});

// ═══ 1. Per-channel list endpoints ═══════════════════════════════════════════
//
// Each channel is asserted SEPARATELY on purpose: they did not all share an
// anchor shape before this slice (WhatsApp had no lead_id at all), and a
// copy-paste of the Email fragment onto WhatsApp silently matches NOTHING rather
// than failing loudly.

describe('a TECHNICIAN sees their own job comms and NOT another job comms', () => {
  it('GET /communication/calls', async () => {
    mockAuthAs('technician');
    const res = await request(app).get('/api/communication/calls').set(authHeader('technician'));
    expect(res.status).toBe(200);
    const where = capturedWhere(mockPrisma.callSession.findMany as Mock);
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(visible(where)).toContain(ON_MY_JOB.id);
    expect(visible(where)).not.toContain(ON_OTHER_JOB.id);
  });

  it('GET /communication/emails', async () => {
    mockAuthAs('technician');
    const res = await request(app).get('/api/communication/emails').set(authHeader('technician'));
    expect(res.status).toBe(200);
    const where = capturedWhere(mockPrisma.email.findMany as Mock);
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(visible(where)).toContain(ON_MY_JOB.id);
    expect(visible(where)).not.toContain(ON_OTHER_JOB.id);
  });

  it('GET /communication/threads (SMS: filters the nested messages AND the thread)', async () => {
    mockAuthAs('technician');
    const res = await request(app).get('/api/communication/threads').set(authHeader('technician'));
    expect(res.status).toBe(200);
    const nested = capturedMessagesInclude(mockPrisma.messageThread.findMany as Mock);
    expect(nested, 'the nested messages include must be filtered in SQL').toBeDefined();
    expect(visible(nested!)).toContain(ON_MY_JOB.id);
    expect(visible(nested!)).not.toContain(ON_OTHER_JOB.id);
    // ...and a thread with nothing visible in it must not surface at all (its
    // existence + customer linkage is itself information).
    const threadWhere = capturedWhere(mockPrisma.messageThread.findMany as Mock);
    expect(matchesWhere(parent('t1', [ON_MY_JOB, ON_OTHER_JOB]), threadWhere)).toBe(true);
    expect(matchesWhere(parent('t2', [ON_OTHER_JOB]), threadWhere)).toBe(false);
  });

  it('GET /communication/whatsapp (WhatsApp: same, on its own lead_id column)', async () => {
    // WhatsApp routes 404 via requireDemoOrg for a real org.
    mockAuthAs('technician', { is_demo: true });
    const res = await request(app).get('/api/communication/whatsapp').set(authHeader('technician'));
    expect(res.status).toBe(200);
    const nested = capturedMessagesInclude(mockPrisma.whatsAppChat.findMany as Mock);
    expect(nested, 'the nested messages include must be filtered in SQL').toBeDefined();
    expect(visible(nested!)).toContain(ON_MY_JOB.id);
    expect(visible(nested!)).not.toContain(ON_OTHER_JOB.id);
    const chatWhere = capturedWhere(mockPrisma.whatsAppChat.findMany as Mock);
    expect(matchesWhere(parent('c1', [ON_MY_JOB]), chatWhere)).toBe(true);
    expect(matchesWhere(parent('c2', [ON_OTHER_JOB]), chatWhere)).toBe(false);
  });
});

// #2046: the org-wide list endpoints now require `access_inbox`, which SALES does not hold - so
// neither route below reaches anchorInheritedWhere for SALES any more (403 before the handler
// runs). The lead-owned/not-owned OWN_LEAD scoping this block used to prove through these routes
// is unchanged code, still covered for TECHNICIAN above and for SALES through the record-tab
// endpoint (GET /leads/:id/communications, job-communications.test.ts).
describe('a SALES rep — org-wide list endpoints now 403 (#2046)', () => {
  it('GET /communication/calls', async () => {
    mockAuthAs('sales');
    const res = await request(app).get('/api/communication/calls').set(authHeader('sales'));
    expect(res.status).toBe(403);
    expect(mockPrisma.callSession.findMany).not.toHaveBeenCalled();
  });

  it('GET /communication/emails', async () => {
    mockAuthAs('sales');
    const res = await request(app).get('/api/communication/emails').set(authHeader('sales'));
    expect(res.status).toBe(403);
    expect(mockPrisma.email.findMany).not.toHaveBeenCalled();
  });
});

describe('ADMIN and DISPATCHER bypass the inheritance and see everything', () => {
  // Not special-cased anywhere: both hold an unconditional read on Job AND Lead,
  // so both anchor scopes resolve to {} and the filter collapses to {}.
  it('DISPATCHER GET /communication/calls applies no row restriction', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    const where = capturedWhere(mockPrisma.callSession.findMany as Mock);
    expect(where.OR).toBeUndefined();
    expect(visible(where)).toEqual(ALL.map((r) => r.id));
  });

  it('ADMIN GET /communication/emails applies no row restriction', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/communication/emails').set(authHeader('admin'));
    expect(res.status).toBe(200);
    const where = capturedWhere(mockPrisma.email.findMany as Mock);
    expect(where.OR).toBeUndefined();
    expect(visible(where)).toEqual(ALL.map((r) => r.id));
  });

  it('DISPATCHER GET /communication/threads leaves the nested include unfiltered', async () => {
    mockAuthAs('dispatcher');
    await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));
    const nested = capturedMessagesInclude(mockPrisma.messageThread.findMany as Mock);
    expect(nested === undefined || Object.keys(nested).length === 0).toBe(true);
  });
});

describe('unanchored / customer-only / vendor-only rows stay visible ORG-WIDE', () => {
  it('technician GET /communication/calls', async () => {
    mockAuthAs('technician');
    await request(app).get('/api/communication/calls').set(authHeader('technician'));
    const where = capturedWhere(mockPrisma.callSession.findMany as Mock);
    expect(visible(where)).toEqual(expect.arrayContaining([CUSTOMER_ONLY.id, VENDOR_ONLY.id, UNANCHORED.id]));
  });

  // #2046: SALES no longer reaches this list route at all (403 before the handler runs). The
  // "a scoped, non-bypass role still sees unanchored/customer/vendor rows" property this case
  // proved stays covered by the technician case immediately above (same anchorInheritedWhere
  // branch, unchanged code).
  it('sales GET /communication/emails — 403, no query reaches prisma (#2046)', async () => {
    mockAuthAs('sales');
    const res = await request(app).get('/api/communication/emails').set(authHeader('sales'));
    expect(res.status).toBe(403);
    expect(mockPrisma.email.findMany).not.toHaveBeenCalled();
  });
});

// Spec C slice 7. A staff text thread carries NO job id and NO lead id, by
// design (smsRecord.ts: internal lanes never carry job attribution), so it
// lands in anchorInheritedWhere's unconditional third branch and is org-wide
// visible. That is the access decision this feature takes, and it is asserted
// here rather than reasoned about: an automation-created staff thread that a
// restricted requester cannot see is a lane nobody can read.
const STAFF_TEXT = row('aa000000-0000-4000-8000-000000000009');

describe('a staff text thread is visible to a requester with a RESTRICTED comm scope', () => {
  it('technician GET /communication/threads keeps the thread AND its message', async () => {
    mockAuthAs('technician');
    const res = await request(app).get('/api/communication/threads').set(authHeader('technician'));
    expect(res.status).toBe(200);

    // The technician's scope really is restricted here - otherwise this whole
    // assertion would be vacuous.
    const threadWhere = capturedWhere(mockPrisma.messageThread.findMany as Mock);
    expect(matchesWhere(parent('customer-thread', [ON_OTHER_JOB]), threadWhere)).toBe(false);

    // ...and the staff thread survives it, message included.
    expect(matchesWhere(parent('staff-thread', [STAFF_TEXT]), threadWhere)).toBe(true);
    const nested = capturedMessagesInclude(mockPrisma.messageThread.findMany as Mock);
    expect(visible(nested!, [STAFF_TEXT])).toContain(STAFF_TEXT.id);
  });

  it('technician GET /communication/threads/:id keeps it on the detail read too', async () => {
    mockAuthAs('technician');
    await request(app).get('/api/communication/threads/t1').set(authHeader('technician'));
    // The detail `where` pins the row id too, so the fixture has to BE t1.
    const where = capturedWhere(mockPrisma.messageThread.findFirst as Mock);
    expect(matchesWhere(parent('t1', [STAFF_TEXT]), where)).toBe(true);
  });
});

describe('anchor precedence: a row carrying BOTH job_id and customer_id is governed by the JOB', () => {
  it('technician GET /communication/emails hides it when the job is not theirs', async () => {
    mockAuthAs('technician');
    await request(app).get('/api/communication/emails').set(authHeader('technician'));
    const where = capturedWhere(mockPrisma.email.findMany as Mock);
    expect(visible(where)).not.toContain(ON_OTHER_JOB_AND_CUSTOMER.id);
    // Repointed at a job that IS theirs, the same row becomes visible - proving
    // the job is what decides, not the presence of the customer/lead stamps.
    expect(matchesWhere({ ...ON_OTHER_JOB_AND_CUSTOMER, job_id: MY_JOB.id, job: MY_JOB }, where)).toBe(true);
  });

  // #2046: SALES no longer reaches this list route at all (403 before the handler runs). The
  // job-beats-lead precedence property this case proved stays covered by the technician case
  // immediately above (same anchorInheritedWhere precedence, unchanged code).
  it('sales GET /communication/calls — 403, no query reaches prisma (#2046)', async () => {
    mockAuthAs('sales');
    const res = await request(app).get('/api/communication/calls').set(authHeader('sales'));
    expect(res.status).toBe(403);
    expect(mockPrisma.callSession.findMany).not.toHaveBeenCalled();
  });
});

// ═══ 2. Detail, recording, transcript ════════════════════════════════════════
//
// A scoped list with an unscoped detail route is the classic hole, and the two
// call sub-resources are the worst of it: /recording mints a 300s signed URL into
// the private recordings bucket and /transcript returns transcript content.

describe('detail routes are scoped, not just the lists', () => {
  it('GET /communication/calls/:id', async () => {
    mockAuthAs('technician');
    await request(app).get(`/api/communication/calls/${ON_OTHER_JOB.id}`).set(authHeader('technician'));
    const where = capturedWhere(mockPrisma.callSession.findFirst as Mock);
    // The `where` pins THIS row's id, so only the visibility filter can exclude it.
    expect(visible(where)).not.toContain(ON_OTHER_JOB.id);
    expect(matchesWhere({ ...ON_MY_JOB, id: ON_OTHER_JOB.id }, where)).toBe(true);
  });

  it('GET /communication/calls/:id/recording (signed URL into the private bucket)', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .get(`/api/communication/calls/${ON_OTHER_JOB.id}/recording`)
      .set(authHeader('technician'));
    expect(res.status).toBe(404);
    const where = capturedWhere(mockPrisma.callSession.findFirst as Mock);
    expect(visible(where)).not.toContain(ON_OTHER_JOB.id);
  });

  it('GET /communication/calls/:id/transcript', async () => {
    mockAuthAs('technician');
    await request(app)
      .get(`/api/communication/calls/${ON_OTHER_JOB.id}/transcript`)
      .set(authHeader('technician'));
    const where = capturedWhere(mockPrisma.callSession.findFirst as Mock);
    expect(visible(where)).not.toContain(ON_OTHER_JOB.id);
  });

  it('GET /communication/emails/:id', async () => {
    mockAuthAs('technician');
    await request(app).get(`/api/communication/emails/${ON_OTHER_JOB.id}`).set(authHeader('technician'));
    const where = capturedWhere(mockPrisma.email.findFirst as Mock);
    // The id in the `where` IS this row's id, so the only thing that can exclude
    // it is the visibility filter.
    expect(visible(where)).not.toContain(ON_OTHER_JOB.id);
    expect(matchesWhere({ ...ON_MY_JOB, id: ON_OTHER_JOB.id }, where)).toBe(true);
  });

  // Email slice 7's new sub-resource - same class of hole as
  // calls/:id/recording above (mints a signed URL into a PRIVATE storage
  // bucket), so it needs the same "the row lookup, not just the response
  // status" proof.
  it('GET /communication/emails/:id/attachments/:index (signed URL into the private attachments bucket)', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .get(`/api/communication/emails/${ON_OTHER_JOB.id}/attachments/0`)
      .set(authHeader('technician'));
    expect(res.status).toBe(404);
    const where = capturedWhere(mockPrisma.email.findFirst as Mock);
    expect(visible(where)).not.toContain(ON_OTHER_JOB.id);
    expect(matchesWhere({ ...ON_MY_JOB, id: ON_OTHER_JOB.id }, where)).toBe(true);
    expect(mockPrisma.emailAttachment.findMany).not.toHaveBeenCalled();
  });

  it('GET /communication/threads/:id', async () => {
    mockAuthAs('technician');
    await request(app).get('/api/communication/threads/t1').set(authHeader('technician'));
    const where = capturedWhere(mockPrisma.messageThread.findFirst as Mock);
    expect(matchesWhere(parent('t1', [ON_OTHER_JOB]), where)).toBe(false);
    expect(matchesWhere(parent('t1', [ON_MY_JOB]), where)).toBe(true);
  });

  it('GET /communication/whatsapp/:id', async () => {
    // WhatsApp routes 404 via requireDemoOrg for a real org.
    mockAuthAs('technician', { is_demo: true });
    await request(app).get('/api/communication/whatsapp/c1').set(authHeader('technician'));
    const where = capturedWhere(mockPrisma.whatsAppChat.findFirst as Mock);
    expect(matchesWhere(parent('c1', [ON_OTHER_JOB]), where)).toBe(false);
    expect(matchesWhere(parent('c1', [UNANCHORED]), where)).toBe(true);
  });
});

// ═══ 3. Unread counts ════════════════════════════════════════════════════════

describe('GET /communication/unread-counts is scoped on all three channels', () => {
  it('technician', async () => {
    // WhatsApp is demo-only (requireDemoOrg) - a real org's count is gated to 0
    // before it ever reaches prisma, so this must run as a demo org to exercise
    // the WhatsApp scoping this test is actually checking.
    mockAuthAs('technician', { is_demo: true });
    const res = await request(app).get('/api/communication/unread-counts').set(authHeader('technician'));
    expect(res.status).toBe(200);
    const emailWhere = capturedWhere(mockPrisma.email.count as Mock);
    expect(visible(emailWhere)).not.toContain(ON_OTHER_JOB.id);
    // #2049: sms counts per-user unread THREADS via messageThread.findMany
    // (never the retired messageThread.aggregate) - same parent-visibility
    // scoping as before.
    const smsWhere = capturedWhere(mockPrisma.messageThread.findMany as Mock);
    expect(matchesWhere(parent('t', [ON_OTHER_JOB]), smsWhere)).toBe(false);
    // #2049 slice 2: whatsapp counts per-user unread CHATS via
    // whatsAppChat.findMany (never the retired whatsAppChat.aggregate) - same
    // parent-visibility scoping as before.
    const waWhere = capturedWhere(mockPrisma.whatsAppChat.findMany as Mock);
    expect(matchesWhere(parent('c', [ON_OTHER_JOB]), waWhere)).toBe(false);
  });
});

// ═══ 4. Mutations that take a comm row id ════════════════════════════════════
//
// The reassign REFETCHES used a WEAKER filter than the update they follow. That
// was benign only while the guard was pure tenancy (the updateMany already
// 404'd); it stops being benign the moment the guard becomes a visibility
// predicate, because the refetch is what renders back to the caller.

// Only DISPATCHER/ADMIN hold `update Communication` by default, and both are
// org-wide, which would make a mutation assertion vacuous. An org can grant the
// verb to a row-scoped role in Roles & Permissions, so model exactly that: the
// technician's own conditional Job/Lead reads PLUS `update Communication`.
function mockRowScopedEditor() {
  mockAuthAs('technician');
  const grants = DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN').map(
    ({ role: _role, ...g }) => g,
  );
  (prisma.rolePermission.findMany as Mock).mockResolvedValue([
    ...grants,
    { action: 'update', subject: 'Communication', conditions: null },
  ]);
}

describe('reassign mutations are scoped on the update AND the refetch', () => {
  it('PATCH /communication/calls/:id/job', async () => {
    mockRowScopedEditor();
    mockPrisma.callSession.findMany.mockResolvedValue([{ id: ON_MY_JOB.id, customer_id: null }]);
    mockPrisma.callSession.updateMany.mockResolvedValue({ count: 1 });
    const res = await request(app)
      .patch(`/api/communication/calls/${ON_MY_JOB.id}/job`)
      .set(authHeader('technician'))
      .send({ job_id: null });
    expect(res.status).toBe(200);
    const updateWhere = capturedWhere(mockPrisma.callSession.updateMany as Mock);
    expect(visible(updateWhere)).not.toContain(ON_OTHER_JOB.id);
    // The refetch is what renders back to the caller; it must not be broader
    // than the update it follows.
    const refetchWhere = capturedWhere(mockPrisma.callSession.findMany as Mock);
    expect(visible(refetchWhere)).not.toContain(ON_OTHER_JOB.id);
  });

  it('PATCH /communication/sms/:id/lead', async () => {
    mockRowScopedEditor();
    mockPrisma.message.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.message.findMany.mockResolvedValue([{ id: 'm1', direction: 'out', body: 'x', ts: new Date() }]);
    const res = await request(app)
      .patch('/api/communication/sms/m1/lead')
      .set(authHeader('technician'))
      .send({ lead_id: null });
    expect(res.status).toBe(200);
    // The update also carries the internal-lane guard (`thread: {kind ...}`), so
    // evaluate against rows that satisfy it - otherwise the assertion passes for
    // the wrong reason.
    const onCustomerThread = (r: Row) => ({ ...r, thread: { kind: 'customer' } });
    const rows = [ON_MY_JOB, ON_OTHER_JOB, UNANCHORED].map(onCustomerThread);
    const updateWhere = capturedWhere(mockPrisma.message.updateMany as Mock);
    expect(visible(updateWhere, rows)).not.toContain(ON_OTHER_JOB.id);
    expect(visible(updateWhere, rows.map((r) => ({ ...r, id: 'm1' })))).toHaveLength(2);
    const refetchWhere = capturedWhere(mockPrisma.message.findMany as Mock);
    expect(visible(refetchWhere, rows)).not.toContain(ON_OTHER_JOB.id);
  });

  // The email mirror. It landed in a parallel slice (slice 2 attribution) while
  // the visibility filter was being written, so it was the ONE comm mutation
  // that never received it - and it is the worst one to miss: the clear path
  // (`job_id: null`) skips every pre-check and hands the refetched row straight
  // back through mapEmail, which carries `body`/`bodyHtml`. That is not an
  // existence oracle, it is the message content.
  it('PATCH /communication/emails/:id/job (clear path: the refetch renders the body back)', async () => {
    mockRowScopedEditor();
    mockPrisma.email.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.email.findFirst.mockResolvedValue({ id: ON_OTHER_JOB.id, ts: 0n, customer_id: null });
    const res = await request(app)
      .patch(`/api/communication/emails/${ON_OTHER_JOB.id}/job`)
      .set(authHeader('technician'))
      .send({ job_id: null });
    expect(res.status).toBe(200);
    const updateWhere = capturedWhere(mockPrisma.email.updateMany as Mock);
    expect(visible(updateWhere)).not.toContain(ON_OTHER_JOB.id);
    // The refetch is what renders back to the caller; it must not be broader
    // than the update it follows.
    const refetchWhere = capturedWhere(mockPrisma.email.findFirst as Mock);
    expect(visible(refetchWhere)).not.toContain(ON_OTHER_JOB.id);
  });

  it('PATCH /communication/emails/:id/job (assign path: pre-read AND target job are scoped)', async () => {
    mockRowScopedEditor();
    mockPrisma.email.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.email.findFirst.mockResolvedValue({ id: ON_MY_JOB.id, ts: 0n, customer_id: null });
    mockPrisma.job.findUnique.mockResolvedValue({ id: MY_JOB.id, job_number: 'J00001', customer_id: null });
    const res = await request(app)
      .patch(`/api/communication/emails/${ON_MY_JOB.id}/job`)
      .set(authHeader('technician'))
      .send({ job_id: MY_JOB.id });
    expect(res.status).toBe(200);
    // The pre-read reads customer_id off a row the caller may not be allowed to
    // see, so it carries the filter too.
    const preReadWhere = capturedWhere(mockPrisma.email.findFirst as Mock, 0);
    expect(visible(preReadWhere)).not.toContain(ON_OTHER_JOB.id);
    // And the TARGET job resolves under the caller's own Job scope: attributing
    // an email onto a job you cannot see both hides the row from yourself and
    // publishes it to that job's crew (and would empty the refetch).
    // Both fixtures are pinned to the requested id so the ONLY thing that can
    // separate them is the grant-derived scope, never the id or the tenant key.
    const asTarget = (j: Row) => ({ ...j, id: MY_JOB.id, organization_id: ALPHA_ORG_ID });
    const jobWhere = capturedWhere(mockPrisma.job.findUnique as Mock);
    expect(matchesWhere(asTarget(MY_JOB as Row), jobWhere)).toBe(true);
    expect(matchesWhere(asTarget(OTHER_JOB as Row), jobWhere)).toBe(false);
  });
});

// ═══ 4b. The three composers resolve their anchor under the CALLER's scope ═══
//
// `create Communication` is a UNIVERSAL grant (defaultGrants.ts: role-agnostic,
// every role in a comm-enabled org holds it), so all three of these are reachable
// by a row-scoped role. Attaching a send to a job the sender cannot see writes the
// row straight out of their own view and INTO that job's crew timeline - the
// inverse of the read leak, reached through a write. WhatsApp and email already
// resolved their target under the caller's Job scope; SMS did not.

describe('composers cannot attribute a send to an anchor the sender cannot see', () => {
  const THREAD_UUID = '11111111-1111-1111-1111-111111111111';

  /** Both fixtures pinned to the requested id, so only the scope can separate them. */
  function assertJobScoped(fn: Mock, targetId: string) {
    const asTarget = (j: Row) => ({ ...j, id: targetId, organization_id: ALPHA_ORG_ID });
    const where = capturedWhere(fn);
    expect(matchesWhere(asTarget(MY_JOB as Row), where)).toBe(true);
    expect(matchesWhere(asTarget(OTHER_JOB as Row), where)).toBe(false);
  }

  it('POST /communication/sms resolves jobId under the caller Job scope', async () => {
    mockAuthAs('technician');
    mockPrisma.messageThread.findFirst.mockResolvedValue({
      id: 'a1111111-1111-4111-8111-111111111111', kind: 'customer', customer_id: null, vendor_id: null, lead_id: null,
    });
    mockPrisma.job.findUnique.mockResolvedValue({ id: MY_JOB.id, job_number: 'J00001', customer_id: null });
    mockPrisma.message.create.mockResolvedValue({ id: 'm1', direction: 'out', body: 'hi', ts: new Date() });
    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('technician'))
      .send({ threadId: THREAD_UUID, body: 'hi', jobId: MY_JOB.id });
    expect(res.status).toBe(201);
    assertJobScoped(mockPrisma.job.findUnique as Mock, MY_JOB.id);
  });

  it('POST /communication/sms resolves leadId under the caller Lead scope', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findFirst.mockResolvedValue({ id: MY_LEAD.id, customer_id: null });
    mockPrisma.messageThread.findFirst.mockResolvedValue({
      id: 'a1111111-1111-4111-8111-111111111111', kind: 'customer', customer_id: null, vendor_id: null, lead_id: null,
    });
    mockPrisma.message.create.mockResolvedValue({ id: 'm1', direction: 'out', body: 'hi', ts: new Date() });
    const res = await request(app)
      .post('/api/communication/sms')
      .set(authHeader('sales'))
      .send({ threadId: THREAD_UUID, body: 'hi', leadId: MY_LEAD.id });
    expect(res.status).toBe(201);
    const asTarget = (l: Row) => ({ ...l, id: MY_LEAD.id, organization_id: ALPHA_ORG_ID });
    const where = capturedWhere(mockPrisma.lead.findFirst as Mock);
    expect(matchesWhere(asTarget(MY_LEAD as Row), where)).toBe(true);
    expect(matchesWhere(asTarget(OTHER_LEAD as Row), where)).toBe(false);
  });

  it('POST /communication/whatsapp already resolves job_id under the caller Job scope', async () => {
    // WhatsApp routes 404 via requireDemoOrg for a real org, before ever
    // reaching the controller this test is exercising.
    mockAuthAs('technician', { is_demo: true });
    mockPrisma.whatsAppChat.findFirst.mockResolvedValue({ id: 'c1', lead_id: null });
    mockPrisma.job.findUnique.mockResolvedValue({ id: MY_JOB.id, job_number: 'J00001' });
    await request(app)
      .post('/api/communication/whatsapp')
      .set(authHeader('technician'))
      .send({ chat_id: '11111111-1111-1111-1111-111111111111', text: 'hi', job_id: MY_JOB.id });
    assertJobScoped(mockPrisma.job.findUnique as Mock, MY_JOB.id);
  });

  it('POST /communication/emails already resolves job_id under the caller Job scope', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockResolvedValue({ id: MY_JOB.id, job_number: 'J00001' });
    await request(app)
      .post('/api/communication/emails')
      .set(authHeader('technician'))
      .send({ to: 'a@b.com', subject: 's', body: ['hi'], job_id: MY_JOB.id });
    assertJobScoped(mockPrisma.job.findUnique as Mock, MY_JOB.id);
  });
});

describe('PATCH /communication/emails/thread-read is scoped (read state is a write on rows)', () => {
  it('a row-scoped editor cannot create read-state for rows they cannot see', async () => {
    mockRowScopedEditor();
    mockPrisma.email.findMany.mockResolvedValue([]);
    const res = await request(app)
      .patch('/api/communication/emails/thread-read')
      .set(authHeader('technician'))
      .send({ thread_id: 'a1111111-1111-4111-8111-111111111111' });
    expect(res.status).toBe(200);
    // markThreadRead now selects the VISIBLE rows via findMany (not an
    // unscoped updateMany) before creating any EmailReadState - the where it
    // hands prisma must still exclude a row on a job this caller cannot see.
    const where = capturedWhere(mockPrisma.email.findMany as Mock);
    expect(visible(where)).not.toContain(ON_OTHER_JOB.id);
  });
});

// ═══ 5. The three entity timelines ═══════════════════════════════════════════

describe('entity timelines', () => {
  it('GET /api/leads/:id/communications applies the row filter, not just the lead gate', async () => {
    // A row can carry THIS lead's lead_id and a job the requester cannot see.
    // canAccessRow(Lead) passes, so without the row filter precedence is violated.
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockResolvedValue({ id: MY_LEAD.id });
    mockPrisma.lead.findFirst.mockResolvedValue({ id: MY_LEAD.id });
    const res = await request(app)
      .get(`/api/leads/${MY_LEAD.id}/communications`)
      .set(authHeader('sales'));
    expect(res.status).toBe(200);
    const where = capturedWhere(mockPrisma.email.findMany as Mock);
    expect(where.lead_id).toBe(MY_LEAD.id);
    expect(matchesWhere({ ...ON_OTHER_JOB, lead_id: MY_LEAD.id, lead: MY_LEAD }, where)).toBe(false);
  });

  it('GET /api/customers/:id/communications gains the row check its siblings have', async () => {
    mockAuthAs('sales');
    // #2041: the customer roll-up now row-scopes via `canReadCustomerById` - give the fixture an
    // OWN_CUSTOMER proof (created_by_id) so this test stays about the anchor-inheritance
    // behaviour it names, not about #2041's row scope (that's customers-row-scope.test.ts's job).
    mockPrisma.customer.findUnique.mockResolvedValue({ id: 'c0000000-0000-0000-0000-000000000001', created_by_id: SALES_ID });
    const res = await request(app)
      .get('/api/customers/c0000000-0000-0000-0000-000000000001/communications')
      .set(authHeader('sales'));
    expect(res.status).toBe(200);
    const where = capturedWhere(mockPrisma.email.findMany as Mock);
    expect(visible(where)).toContain(CUSTOMER_ONLY.id);
    // The roll-up unions every row stamped with this customer, INCLUDING rows
    // that also carry a job the requester cannot see. That is the live hole:
    // job > lead > customer means the job decides, so this must not come back.
    expect(visible(where)).not.toContain(ON_OTHER_JOB_AND_CUSTOMER.id);
  });

  it('GET /api/customers/:id/communications 403s a requester with no Customer read', async () => {
    // TECHNICIAN holds no `read Customer`. Before slice 8a they could not reach
    // this route at all (no `read Communication`); now they can, so the customer
    // roll-up needs the gate the tasks visibility helper already uses for the
    // non-ScopeResource CUSTOMER case.
    mockAuthAs('technician');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: 'c0000000-0000-0000-0000-000000000001' });
    const res = await request(app)
      .get('/api/customers/c0000000-0000-0000-0000-000000000001/communications')
      .set(authHeader('technician'));
    expect(res.status).toBe(403);
  });
});

// ═══ 6. The customer directory behind the comm module ════════════════════════

describe('GET /communication/contacts requires `read Customer`, not just `read Communication`', () => {
  it('403s a TECHNICIAN (who newly holds read Communication but never read Customer)', async () => {
    mockAuthAs('technician');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/communication/contacts').set(authHeader('technician'));
    expect(res.status).toBe(403);
    expect(mockPrisma.customer.findMany).not.toHaveBeenCalled();
  });

  it('still serves a DISPATCHER', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.customer.findMany.mockResolvedValue([]);
    const res = await request(app).get('/api/communication/contacts').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
  });
});
