/**
 * #2049 - per-user read state for SMS threads: the new marker table
 * (`MessageThreadReadState`), the two new routes (`PATCH /threads/:id/read`,
 * `.../unread`), the per-requester `unread` computation `mapThread`/
 * `getUnreadCounts` now share (`attachCallerUnread`,
 * comm-threads.controller.ts), and the email re-gate's TECHNICIAN half (the
 * issue names both SALES and TECHNICIAN; SALES's own re-gate cases live in
 * the frozen `repro-2049.test.ts`).
 *
 * Companion coverage: `repro-2049.test.ts` (frozen), `comm-visibility.test.ts`
 * (anchor-scoping of the new routes), `comm-section-gate.test.ts` (the
 * `read Communication`-alone re-gate), `email-thread-readstate.test.ts` (the
 * email `thread-unread` route + the re-gated `thread-read`'s per-user
 * isolation).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  mockAuthAs, authHeader, ALPHA_ORG_ID, TEST_USERS, LEAD_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearTokenCache } from '../middleware/authenticate';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p = prisma as unknown as Record<string, any>;

const SALES_ID = TEST_USERS.sales.id;
const DISPATCHER_ID = TEST_USERS.dispatcher.id;
const TECHNICIAN_ID = TEST_USERS.technician.id;
const LEAD_ID = LEAD_FIXTURE.id;
const THREAD_ID = 'a1111111-1111-4111-8111-111111111111';

/** A thread the caller's own lead-assignment makes visible (smsVisibility). */
function ownLeadThread(overrides: Record<string, unknown> = {}) {
  return {
    id: THREAD_ID,
    organization_id: ALPHA_ORG_ID,
    unread: 1,
    messages: [{
      id: 'm1', direction: 'in', ts: new Date('2026-09-01T10:00:00Z'),
      lead_id: LEAD_ID, job_id: null, job: null, customer_id: null, vendor_id: null,
      lead: { lead_assignees: [{ user_id: SALES_ID }] },
    }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearTokenCache();
});

// ═══ 1. PATCH /threads/:id/read and /unread — the route contract ═══════════

describe('PATCH /api/communication/threads/:id/read - SALES marks their own lead thread', () => {
  it('200s and upserts a marker keyed to the caller, never the body/query', async () => {
    mockAuthAs('sales');
    p.messageThread.findFirst.mockResolvedValue(ownLeadThread());
    p.messageThreadReadState.upsert.mockResolvedValue({});

    const res = await request(app)
      .patch(`/api/communication/threads/${THREAD_ID}/read`)
      .set(authHeader('sales'))
      // A body-supplied user_id must be ignored (R8) - the caller id comes
      // from the token alone.
      .send({ user_id: DISPATCHER_ID });

    expect(res.status).toBe(200);
    expect(p.messageThreadReadState.upsert).toHaveBeenCalledTimes(1);
    const call = p.messageThreadReadState.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ thread_id_user_id: { thread_id: THREAD_ID, user_id: SALES_ID } });
    expect(call.create).toMatchObject({
      thread_id: THREAD_ID, user_id: SALES_ID, organization_id: ALPHA_ORG_ID,
    });
    // The update half only ever bumps read_at - it must never carry a
    // user_id/organization_id key at all (there is nothing to re-key on an
    // existing marker; only its timestamp advances).
    expect(Object.keys(call.update)).toEqual(['read_at']);
  });

  it('a second user (DISPATCHER, also visible on this thread) is unaffected by SALES marking it read', async () => {
    p.messageThreadReadState.upsert.mockResolvedValue({});

    mockAuthAs('sales');
    p.messageThread.findFirst.mockResolvedValue(ownLeadThread());
    const salesRes = await request(app)
      .patch(`/api/communication/threads/${THREAD_ID}/read`)
      .set(authHeader('sales'))
      .send({});
    expect(salesRes.status).toBe(200);

    mockAuthAs('dispatcher');
    p.messageThread.findFirst.mockResolvedValue(ownLeadThread());
    p.messageThreadReadState.findMany.mockResolvedValue([]); // DISPATCHER holds no marker
    const dispatcherView = await request(app)
      .get(`/api/communication/threads/${THREAD_ID}`)
      .set(authHeader('dispatcher'));

    expect(dispatcherView.status).toBe(200);
    expect(dispatcherView.body.thread.unread).toBeGreaterThan(0);
    expect(p.messageThreadReadState.upsert).toHaveBeenCalledTimes(1);
    expect(p.messageThreadReadState.upsert.mock.calls[0][0].where.thread_id_user_id.user_id).toBe(SALES_ID);
  });

  it('wrong-org / non-existent thread — 404, one non-disclosing body', async () => {
    mockAuthAs('sales');
    p.messageThread.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/communication/threads/00000000-0000-4000-8000-000000000000/read')
      .set(authHeader('sales'))
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Thread not found' });
    expect(p.messageThreadReadState.upsert).not.toHaveBeenCalled();
  });

  it('a thread visible to someone else, not this caller — 404, byte-identical to the wrong-org body', async () => {
    mockAuthAs('sales');
    // smsVisibility's scope excludes it - the mock IS the visibility outcome.
    p.messageThread.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch(`/api/communication/threads/${THREAD_ID}/read`)
      .set(authHeader('sales'))
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Thread not found' });
  });

  it('a malformed (non-uuid) :id — 404 before Prisma ever runs', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .patch('/api/communication/threads/not-a-uuid/read')
      .set(authHeader('sales'))
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Thread not found' });
    expect(p.messageThread.findFirst).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/communication/threads/:id/unread - the delete-not-a-flag half', () => {
  it('deletes only the caller\'s own marker row', async () => {
    mockAuthAs('dispatcher');
    p.messageThread.findFirst.mockResolvedValue(ownLeadThread());
    p.messageThreadReadState.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/communication/threads/${THREAD_ID}/unread`)
      .set(authHeader('dispatcher'))
      .send({});

    expect(res.status).toBe(200);
    expect(p.messageThreadReadState.deleteMany).toHaveBeenCalledWith({
      where: { thread_id: THREAD_ID, user_id: DISPATCHER_ID, organization_id: ALPHA_ORG_ID },
    });
  });

  it('a malformed :id — 404, same as the read route', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .patch('/api/communication/threads/not-a-uuid/unread')
      .set(authHeader('dispatcher'))
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Thread not found' });
  });
});

// ═══ 2. Email re-gate — the issue's OTHER named role ════════════════════════

describe('PATCH /api/communication/emails/thread-read - TECHNICIAN (access_inbox, no update) reaches it too', () => {
  it('200s - the re-gate is `read Communication` alone, not update+access_inbox', async () => {
    mockAuthAs('technician');
    p.email.findMany.mockResolvedValue([{ id: 'e-tech-1' }]);
    p.emailReadState.createMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch('/api/communication/emails/thread-read')
      .set(authHeader('technician'))
      .send({ thread_id: THREAD_ID });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
  });
});

// ═══ 2b. PATCH /emails/thread-unread — ZERO coverage before this round ══════
// (validator r1, FAILED CRITERION 3) - the route is registered above
// '/emails/:id' (comm-email.routes.ts:91) and shares markThreadRead's
// UUID_RE/visibility/scoping shape; nothing in the committed suite exercised
// it until now.

describe('PATCH /api/communication/emails/thread-unread', () => {
  it('reaches the handler (not swallowed by a param route) and deletes only the caller\'s own EmailReadState rows for the thread', async () => {
    mockAuthAs('dispatcher');
    p.email.findMany.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }]);
    p.emailReadState.deleteMany.mockResolvedValue({ count: 2 });

    const res = await request(app)
      .patch('/api/communication/emails/thread-unread')
      .set(authHeader('dispatcher'))
      .send({ thread_id: THREAD_ID });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    expect(p.email.findMany.mock.calls[0][0].where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      thread_id: THREAD_ID,
    });
    expect(p.emailReadState.deleteMany).toHaveBeenCalledWith({
      where: {
        email_id: { in: ['e1', 'e2'] },
        user_id: DISPATCHER_ID,
        organization_id: ALPHA_ORG_ID,
      },
    });
  });

  it('an unknown/foreign thread id — non-disclosing 200 with updated: 0, no delete issued', async () => {
    mockAuthAs('sales');
    // Visibility scoping (or a different org) excludes every row - the mock
    // IS the visibility outcome, same shape as markThreadRead's 404 case.
    p.email.findMany.mockResolvedValue([]);

    const res = await request(app)
      .patch('/api/communication/emails/thread-unread')
      .set(authHeader('sales'))
      .send({ thread_id: '00000000-0000-4000-8000-000000000000' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 0 });
    expect(p.emailReadState.deleteMany).not.toHaveBeenCalled();
  });

  it('a non-uuid thread_id — updated: 0, the same way thread-read handles it, before Prisma ever runs', async () => {
    mockAuthAs('sales');

    const res = await request(app)
      .patch('/api/communication/emails/thread-unread')
      .set(authHeader('sales'))
      .send({ thread_id: 'not-a-uuid' });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ updated: 0 });
    expect(p.email.findMany).not.toHaveBeenCalled();

    // thread-read's own non-uuid handling, for the "same way" comparison.
    const readRes = await request(app)
      .patch('/api/communication/emails/thread-read')
      .set(authHeader('sales'))
      .send({ thread_id: 'not-a-uuid' });

    expect(readRes.status).toBe(200);
    expect(readRes.body).toEqual({ updated: 0 });
  });

  it('reachable by a TECHNICIAN-shaped ability (read + access_inbox, no update) — built from real DEFAULT_GRANTS, never a role-name check', async () => {
    mockAuthAs('technician');
    p.email.findMany.mockResolvedValue([{ id: 'e-tech-1' }]);
    p.emailReadState.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch('/api/communication/emails/thread-unread')
      .set(authHeader('technician'))
      .send({ thread_id: THREAD_ID });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(1);
    expect(p.emailReadState.deleteMany.mock.calls[0][0].where.user_id).toBe(TECHNICIAN_ID);
  });
});

// ═══ 3. Per-requester unread - a NUMBER computed from the included messages ═

describe('mapThread.unread is per-requester, computed from included messages (R1, R2)', () => {
  it('a message before the marker is read; one after it is unread - count is exactly 1', async () => {
    mockAuthAs('sales');
    p.messageThread.findFirst.mockResolvedValue({
      id: THREAD_ID, organization_id: ALPHA_ORG_ID, unread: 2,
      messages: [
        { id: 'm-old', direction: 'in', ts: new Date('2026-09-01T09:00:00Z') },
        { id: 'm-new', direction: 'in', ts: new Date('2026-09-01T11:00:00Z') },
      ],
    });
    p.messageThreadReadState.findMany.mockResolvedValue([
      { thread_id: THREAD_ID, read_at: new Date('2026-09-01T10:00:00Z') },
    ]);

    const res = await request(app)
      .get(`/api/communication/threads/${THREAD_ID}`)
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.body.thread.unread).toBe(1);
  });

  it('an outbound message never counts toward unread, even with no marker at all', async () => {
    mockAuthAs('sales');
    p.messageThread.findFirst.mockResolvedValue({
      id: THREAD_ID, organization_id: ALPHA_ORG_ID, unread: 0,
      messages: [{ id: 'm1', direction: 'out', ts: new Date() }],
    });
    p.messageThreadReadState.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/communication/threads/${THREAD_ID}`)
      .set(authHeader('sales'));

    expect(res.body.thread.unread).toBe(0);
  });

  it('listThreads issues exactly ONE messageThreadReadState.findMany for the whole page, never N+1', async () => {
    mockAuthAs('dispatcher');
    p.messageThread.findMany.mockResolvedValue([
      { id: 't1', organization_id: ALPHA_ORG_ID, unread: 1, messages: [{ id: 'm1', direction: 'in', ts: new Date() }] },
      { id: 't2', organization_id: ALPHA_ORG_ID, unread: 1, messages: [{ id: 'm2', direction: 'in', ts: new Date() }] },
      { id: 't3', organization_id: ALPHA_ORG_ID, unread: 0, messages: [] },
    ]);
    p.messageThreadReadState.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(p.messageThreadReadState.findMany).toHaveBeenCalledTimes(1);
    const byId = Object.fromEntries(res.body.threads.map((t: { id: string; unread: number }) => [t.id, t.unread]));
    expect(byId.t1).toBe(1);
    expect(byId.t2).toBe(1);
    expect(byId.t3).toBe(0);
  });

  it('an empty thread list issues no marker query at all', async () => {
    mockAuthAs('dispatcher');
    p.messageThread.findMany.mockResolvedValue([]);

    await request(app).get('/api/communication/threads').set(authHeader('dispatcher'));

    expect(p.messageThreadReadState.findMany).not.toHaveBeenCalled();
  });
});

// ═══ 4. GET /unread-counts sms half - per-user THREAD count ═════════════════

describe('GET /communication/unread-counts - sms counts unread THREADS for the caller, not messages', () => {
  it('two unread threads (one holding two unread messages) count as 2, not 3', async () => {
    mockAuthAs('dispatcher');
    p.messageThread.findMany.mockResolvedValue([
      { id: 't1', messages: [{ direction: 'in', ts: new Date() }, { direction: 'in', ts: new Date() }] },
      { id: 't2', messages: [{ direction: 'in', ts: new Date() }] },
      { id: 't3', messages: [] },
    ]);
    p.messageThreadReadState.findMany.mockResolvedValue([]);
    p.email.count.mockResolvedValue(0);
    p.whatsAppChat.aggregate.mockResolvedValue({ _sum: { unread: 0 } });

    const res = await request(app).get('/api/communication/unread-counts').set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.sms).toBe(2);
  });
});

// ═══ 5. Idempotent double-read, and unread-after-read ═══════════════════════

describe('mark-read is idempotent; mark-unread genuinely resets it', () => {
  it('reading twice upserts twice with the same key - no duplicate-row error, no special-casing', async () => {
    mockAuthAs('sales');
    p.messageThread.findFirst.mockResolvedValue(ownLeadThread());
    p.messageThreadReadState.upsert.mockResolvedValue({});

    const first = await request(app).patch(`/api/communication/threads/${THREAD_ID}/read`).set(authHeader('sales')).send({});
    const second = await request(app).patch(`/api/communication/threads/${THREAD_ID}/read`).set(authHeader('sales')).send({});

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(p.messageThreadReadState.upsert).toHaveBeenCalledTimes(2);
    expect(p.messageThreadReadState.upsert.mock.calls[0][0].where).toEqual(
      p.messageThreadReadState.upsert.mock.calls[1][0].where,
    );
  });

  it('read then unread then a fresh GET reports unread again (the marker was deleted, not flagged)', async () => {
    mockAuthAs('sales');
    p.messageThread.findFirst.mockResolvedValue(ownLeadThread());
    p.messageThreadReadState.upsert.mockResolvedValue({});
    p.messageThreadReadState.deleteMany.mockResolvedValue({ count: 1 });

    const read = await request(app).patch(`/api/communication/threads/${THREAD_ID}/read`).set(authHeader('sales')).send({});
    expect(read.status).toBe(200);

    const unread = await request(app).patch(`/api/communication/threads/${THREAD_ID}/unread`).set(authHeader('sales')).send({});
    expect(unread.status).toBe(200);

    // No marker survives the delete - the by-id GET must see the thread as
    // unread again (empty findMany result, matching the delete).
    p.messageThreadReadState.findMany.mockResolvedValue([]);
    const view = await request(app).get(`/api/communication/threads/${THREAD_ID}`).set(authHeader('sales'));
    expect(view.body.thread.unread).toBeGreaterThan(0);
  });
});

// ═══ 6. Migration sanity (prior art: whatsapp-message-lead-id-migration.test.ts) ═

describe('20260913120000_message_thread_read_state migration - pinned to schema.prisma', () => {
  const sql = readFileSync(
    join(__dirname, '../../prisma/migrations/20260913120000_message_thread_read_state/migration.sql'),
    'utf8',
  );
  const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
  const model = schema.slice(
    schema.indexOf('model MessageThreadReadState {'),
    schema.indexOf('}', schema.indexOf('@@map("message_thread_read_states")')),
  );

  it('declares the table the schema declares (id, thread_id, user_id, read_at, organization_id)', () => {
    expect(model).toMatch(/thread_id\s+String\s+@db\.Uuid/);
    expect(model).toMatch(/user_id\s+String\s+@db\.Uuid/);
    expect(model).toMatch(/read_at\s+DateTime\s+@default\(now\(\)\)/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "message_thread_read_states"/);
    expect(sql).toContain('"thread_id"       UUID NOT NULL');
    expect(sql).toContain('"user_id"         UUID NOT NULL');
  });

  it('the unique(thread_id, user_id) index matches Prisma default naming', () => {
    expect(model).toMatch(/@@unique\(\[thread_id, user_id\]\)/);
    expect(sql).toContain('"message_thread_read_states_thread_id_user_id_key"');
  });

  it('FKs cascade on delete (thread AND user), restrict on organization', () => {
    expect(sql).toMatch(/message_thread_read_states_thread_id_fkey[\s\S]*?ON DELETE CASCADE/);
    expect(sql).toMatch(/message_thread_read_states_user_id_fkey[\s\S]*?ON DELETE CASCADE/);
    expect(sql).toMatch(/message_thread_read_states_organization_id_fkey[\s\S]*?ON DELETE RESTRICT/);
  });

  it('is idempotent: IF NOT EXISTS everywhere, FKs behind pg_constraint guards', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
    expect(sql.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g)?.length).toBe(3);
    expect(sql).toContain('ON CONFLICT ("thread_id", "user_id") DO NOTHING');
  });

  it('backfills per-org (R7a) with gen_random_uuid() ids (R7b), only for threads reading as read today', () => {
    expect(sql).toMatch(/JOIN "users" u ON u\.organization_id = t\.organization_id AND u\.is_active/);
    expect(sql).toMatch(/WHERE t\.unread = 0/);
    expect(sql).toContain('SELECT gen_random_uuid(), t.id, u.id, now(), t.organization_id');
  });

  it('is portable: every Supabase-only touch sits behind a pg_roles guard', () => {
    expect(sql.match(/FROM pg_roles WHERE rolname = '(anon|authenticated)'/g)?.length).toBe(2);
  });

  it('enables + FORCEs row-level security with the standard tenant_isolation policy', () => {
    expect(sql).toMatch(/ALTER TABLE "message_thread_read_states" ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE "message_thread_read_states" FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "tenant_isolation" ON "message_thread_read_states"/);
  });

  it('never ran `prisma migrate` from a worktree - no generated-diff header', () => {
    expect(sql).not.toMatch(/This is an empty migration/);
    expect(sql.trimStart().startsWith('--')).toBe(true);
  });
});
