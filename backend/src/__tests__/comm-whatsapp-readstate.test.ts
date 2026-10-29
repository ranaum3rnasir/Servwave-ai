/**
 * #2049 slice 2 - per-user read state for WhatsApp chats: the new marker
 * table (`WhatsAppChatReadState`), the two new routes (`PATCH
 * /whatsapp/:id/read`, `.../unread`), and the per-requester `unread`
 * computation `mapWhatsAppChat`/`getUnreadCounts` now share
 * (`attachCallerUnreadWhatsApp`, comm-whatsapp-email.controller.ts).
 *
 * Reviewer amendment R10 is BINDING: the SMS predicate does not port.
 * `WhatsAppMessage` has no `direction` column, so inbound is `from <> 'us'`
 * (the send path hard-codes `from: 'us'`), and the recency comparison uses
 * `created_at`, never `at` (a display STRING, "9:32 AM").
 *
 * Companion coverage: `comm-thread-readstate.test.ts` (the SMS half this
 * mirrors), `comm-visibility.test.ts` / `comm-email-entitlement.test.ts`
 * (the pre-existing WhatsApp scoping + entitlement suites this slice updates
 * to the new per-user contract rather than deleting).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, TEST_USERS } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearTokenCache } from '../middleware/authenticate';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const p = prisma as unknown as Record<string, any>;

const SALES_ID = TEST_USERS.sales.id;
const DISPATCHER_ID = TEST_USERS.dispatcher.id;
const CHAT_ID = 'b2222222-2222-4222-8222-222222222222';

/** A chat visible to any `access_inbox` holder — WhatsApp carries no anchor
 *  scoping test in this file (comm-visibility.test.ts owns that); the
 *  visibility mock IS the outcome throughout. */
function chatFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: CHAT_ID,
    organization_id: ALPHA_ORG_ID,
    unread: 1,
    messages: [{
      id: 'wm1', from: 'them', created_at: new Date('2026-09-01T10:00:00Z'), at: '10:00 AM',
    }],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearTokenCache();
});

// ═══ 1. PATCH /whatsapp/:id/read and /unread — the route contract ══════════

describe('PATCH /api/communication/whatsapp/:id/read - DISPATCHER marks a visible chat read', () => {
  it('200s and upserts a marker keyed to the caller, never the body/query', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    p.whatsAppChat.findFirst.mockResolvedValue(chatFixture());
    p.whatsAppChatReadState.upsert.mockResolvedValue({});

    const res = await request(app)
      .patch(`/api/communication/whatsapp/${CHAT_ID}/read`)
      .set(authHeader('dispatcher'))
      // A body-supplied user_id must be ignored (R8) - the caller id comes
      // from the token alone.
      .send({ user_id: SALES_ID });

    expect(res.status).toBe(200);
    expect(p.whatsAppChatReadState.upsert).toHaveBeenCalledTimes(1);
    const call = p.whatsAppChatReadState.upsert.mock.calls[0][0];
    expect(call.where).toEqual({ chat_id_user_id: { chat_id: CHAT_ID, user_id: DISPATCHER_ID } });
    expect(call.create).toMatchObject({
      chat_id: CHAT_ID, user_id: DISPATCHER_ID, organization_id: ALPHA_ORG_ID,
    });
    expect(Object.keys(call.update)).toEqual(['read_at']);
  });

  it('a second access_inbox holder is unaffected by DISPATCHER marking it read', async () => {
    p.whatsAppChatReadState.upsert.mockResolvedValue({});

    mockAuthAs('dispatcher', { is_demo: true });
    p.whatsAppChat.findFirst.mockResolvedValue(chatFixture());
    const dispatcherRes = await request(app)
      .patch(`/api/communication/whatsapp/${CHAT_ID}/read`)
      .set(authHeader('dispatcher'))
      .send({});
    expect(dispatcherRes.status).toBe(200);

    mockAuthAs('admin', { is_demo: true });
    p.whatsAppChat.findFirst.mockResolvedValue(chatFixture());
    p.whatsAppChatReadState.findMany.mockResolvedValue([]); // ADMIN holds no marker
    const adminView = await request(app)
      .get(`/api/communication/whatsapp/${CHAT_ID}`)
      .set(authHeader('admin'));

    expect(adminView.status).toBe(200);
    expect(adminView.body.chat.unread).toBeGreaterThan(0);
    expect(p.whatsAppChatReadState.upsert).toHaveBeenCalledTimes(1);
    expect(p.whatsAppChatReadState.upsert.mock.calls[0][0].where.chat_id_user_id.user_id).toBe(DISPATCHER_ID);
  });

  it('wrong-org / non-existent chat — 404, one non-disclosing body', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    p.whatsAppChat.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/communication/whatsapp/00000000-0000-4000-8000-000000000000/read')
      .set(authHeader('dispatcher'))
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Chat not found' });
    expect(p.whatsAppChatReadState.upsert).not.toHaveBeenCalled();
  });

  it('a malformed (non-uuid) :id — 404 before Prisma ever runs', async () => {
    mockAuthAs('dispatcher', { is_demo: true });

    const res = await request(app)
      .patch('/api/communication/whatsapp/not-a-uuid/read')
      .set(authHeader('dispatcher'))
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Chat not found' });
    expect(p.whatsAppChat.findFirst).not.toHaveBeenCalled();
  });

  it('a real org (non-demo) still 404s via requireDemoOrg, never reaching the marker table', async () => {
    mockAuthAs('dispatcher', { is_demo: false });

    const res = await request(app)
      .patch(`/api/communication/whatsapp/${CHAT_ID}/read`)
      .set(authHeader('dispatcher'))
      .send({});

    expect(res.status).toBe(404);
    expect(p.whatsAppChatReadState.upsert).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/communication/whatsapp/:id/unread - the delete-not-a-flag half', () => {
  it("deletes only the caller's own marker row", async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    p.whatsAppChat.findFirst.mockResolvedValue(chatFixture());
    p.whatsAppChatReadState.deleteMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch(`/api/communication/whatsapp/${CHAT_ID}/unread`)
      .set(authHeader('dispatcher'))
      .send({});

    expect(res.status).toBe(200);
    expect(p.whatsAppChatReadState.deleteMany).toHaveBeenCalledWith({
      where: { chat_id: CHAT_ID, user_id: DISPATCHER_ID, organization_id: ALPHA_ORG_ID },
    });
  });

  it('a malformed :id — 404, same as the read route', async () => {
    mockAuthAs('dispatcher', { is_demo: true });

    const res = await request(app)
      .patch('/api/communication/whatsapp/not-a-uuid/unread')
      .set(authHeader('dispatcher'))
      .send({});

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Chat not found' });
  });
});

// ═══ 2. Per-requester unread - a NUMBER computed from `from`/`created_at` ═══

describe('mapWhatsAppChat.unread is per-requester (R10: `from <> \'us\'`, ordered by created_at, never `at`)', () => {
  it('an inbound message before the marker is read; one after it is unread - count is exactly 1', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    p.whatsAppChat.findFirst.mockResolvedValue({
      id: CHAT_ID, organization_id: ALPHA_ORG_ID, unread: 2,
      messages: [
        { id: 'wm-old', from: 'them', created_at: new Date('2026-09-01T09:00:00Z'), at: 'stale display label' },
        { id: 'wm-new', from: 'them', created_at: new Date('2026-09-01T11:00:00Z'), at: 'stale display label' },
      ],
    });
    p.whatsAppChatReadState.findMany.mockResolvedValue([
      { chat_id: CHAT_ID, read_at: new Date('2026-09-01T10:00:00Z') },
    ]);

    const res = await request(app)
      .get(`/api/communication/whatsapp/${CHAT_ID}`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.chat.unread).toBe(1);
  });

  it('an outbound ("us") message never counts toward unread, even with no marker at all', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    p.whatsAppChat.findFirst.mockResolvedValue({
      id: CHAT_ID, organization_id: ALPHA_ORG_ID, unread: 0,
      messages: [{ id: 'wm1', from: 'us', created_at: new Date() }],
    });
    p.whatsAppChatReadState.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/communication/whatsapp/${CHAT_ID}`)
      .set(authHeader('dispatcher'));

    expect(res.body.chat.unread).toBe(0);
  });

  it('a bogus/misleading `at` display string never influences the comparison — only created_at does', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    p.whatsAppChat.findFirst.mockResolvedValue({
      id: CHAT_ID, organization_id: ALPHA_ORG_ID, unread: 1,
      // `at` claims this message is ancient ("Yesterday"), but created_at is
      // genuinely newer than the marker — the real column must win.
      messages: [{ id: 'wm1', from: 'them', created_at: new Date('2026-09-02T00:00:00Z'), at: 'Yesterday 1:00 AM' }],
    });
    p.whatsAppChatReadState.findMany.mockResolvedValue([
      { chat_id: CHAT_ID, read_at: new Date('2026-09-01T00:00:00Z') },
    ]);

    const res = await request(app)
      .get(`/api/communication/whatsapp/${CHAT_ID}`)
      .set(authHeader('dispatcher'));

    expect(res.body.chat.unread).toBe(1);
  });

  it('listWhatsAppChats issues exactly ONE whatsAppChatReadState.findMany for the whole page, never N+1', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    p.whatsAppChat.findMany.mockResolvedValue([
      { id: 'c1', organization_id: ALPHA_ORG_ID, unread: 1, messages: [{ id: 'm1', from: 'them', created_at: new Date() }] },
      { id: 'c2', organization_id: ALPHA_ORG_ID, unread: 1, messages: [{ id: 'm2', from: 'them', created_at: new Date() }] },
      { id: 'c3', organization_id: ALPHA_ORG_ID, unread: 0, messages: [] },
    ]);
    p.whatsAppChatReadState.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/communication/whatsapp').set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(p.whatsAppChatReadState.findMany).toHaveBeenCalledTimes(1);
    const byId = Object.fromEntries(res.body.chats.map((c: { id: string; unread: number }) => [c.id, c.unread]));
    expect(byId.c1).toBe(1);
    expect(byId.c2).toBe(1);
    expect(byId.c3).toBe(0);
  });

  it('an empty chat list issues no marker query at all', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    p.whatsAppChat.findMany.mockResolvedValue([]);

    await request(app).get('/api/communication/whatsapp').set(authHeader('dispatcher'));

    expect(p.whatsAppChatReadState.findMany).not.toHaveBeenCalled();
  });
});

// ═══ 3. GET /unread-counts whatsapp half - per-user CHAT count ══════════════

describe('GET /communication/unread-counts - whatsapp counts unread CHATS for the caller, not messages', () => {
  it('two unread chats (one holding two unread messages) count as 2, not 3', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    p.messageThread.findMany.mockResolvedValue([]);
    p.messageThreadReadState.findMany.mockResolvedValue([]);
    p.whatsAppChat.findMany.mockResolvedValue([
      { id: 'c1', messages: [{ from: 'them', created_at: new Date() }, { from: 'them', created_at: new Date() }] },
      { id: 'c2', messages: [{ from: 'them', created_at: new Date() }] },
      { id: 'c3', messages: [] },
    ]);
    p.whatsAppChatReadState.findMany.mockResolvedValue([]);
    p.email.count.mockResolvedValue(0);

    const res = await request(app).get('/api/communication/unread-counts').set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.whatsapp).toBe(2);
    expect(p.whatsAppChat.aggregate).not.toHaveBeenCalled();
  });
});

// ═══ 4. Idempotent double-read, and unread-after-read ═══════════════════════

describe('mark-read is idempotent; mark-unread genuinely resets it', () => {
  it('reading twice upserts twice with the same key - no duplicate-row error, no special-casing', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    p.whatsAppChat.findFirst.mockResolvedValue(chatFixture());
    p.whatsAppChatReadState.upsert.mockResolvedValue({});

    const first = await request(app).patch(`/api/communication/whatsapp/${CHAT_ID}/read`).set(authHeader('dispatcher')).send({});
    const second = await request(app).patch(`/api/communication/whatsapp/${CHAT_ID}/read`).set(authHeader('dispatcher')).send({});

    expect(first.status).toBe(200);
    expect(second.status).toBe(200);
    expect(p.whatsAppChatReadState.upsert).toHaveBeenCalledTimes(2);
    expect(p.whatsAppChatReadState.upsert.mock.calls[0][0].where).toEqual(
      p.whatsAppChatReadState.upsert.mock.calls[1][0].where,
    );
  });

  it('read then unread then a fresh GET reports unread again (the marker was deleted, not flagged)', async () => {
    mockAuthAs('dispatcher', { is_demo: true });
    p.whatsAppChat.findFirst.mockResolvedValue(chatFixture());
    p.whatsAppChatReadState.upsert.mockResolvedValue({});
    p.whatsAppChatReadState.deleteMany.mockResolvedValue({ count: 1 });

    const read = await request(app).patch(`/api/communication/whatsapp/${CHAT_ID}/read`).set(authHeader('dispatcher')).send({});
    expect(read.status).toBe(200);

    const unread = await request(app).patch(`/api/communication/whatsapp/${CHAT_ID}/unread`).set(authHeader('dispatcher')).send({});
    expect(unread.status).toBe(200);

    p.whatsAppChatReadState.findMany.mockResolvedValue([]);
    const view = await request(app).get(`/api/communication/whatsapp/${CHAT_ID}`).set(authHeader('dispatcher'));
    expect(view.body.chat.unread).toBeGreaterThan(0);
  });
});

// ═══ 5. Migration sanity (prior art: whatsapp-message-lead-id-migration.test.ts) ═

describe('20260913130000_whatsapp_chat_read_state migration - pinned to schema.prisma', () => {
  const sql = readFileSync(
    join(__dirname, '../../prisma/migrations/20260913130000_whatsapp_chat_read_state/migration.sql'),
    'utf8',
  );
  const schema = readFileSync(join(__dirname, '../../prisma/schema.prisma'), 'utf8');
  const model = schema.slice(
    schema.indexOf('model WhatsAppChatReadState {'),
    schema.indexOf('}', schema.indexOf('@@map("whatsapp_chat_read_states")')),
  );

  it('declares the table the schema declares (id, chat_id, user_id, read_at, organization_id)', () => {
    expect(model).toMatch(/chat_id\s+String\s+@db\.Uuid/);
    expect(model).toMatch(/user_id\s+String\s+@db\.Uuid/);
    expect(model).toMatch(/read_at\s+DateTime\s+@default\(now\(\)\)/);
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS "whatsapp_chat_read_states"/);
    expect(sql).toContain('"chat_id"         UUID NOT NULL');
    expect(sql).toContain('"user_id"         UUID NOT NULL');
  });

  it('the unique(chat_id, user_id) index matches Prisma default naming', () => {
    expect(model).toMatch(/@@unique\(\[chat_id, user_id\]\)/);
    expect(sql).toContain('"whatsapp_chat_read_states_chat_id_user_id_key"');
  });

  it('FKs cascade on delete (chat AND user), restrict on organization', () => {
    expect(sql).toMatch(/whatsapp_chat_read_states_chat_id_fkey[\s\S]*?ON DELETE CASCADE/);
    expect(sql).toMatch(/whatsapp_chat_read_states_user_id_fkey[\s\S]*?ON DELETE CASCADE/);
    expect(sql).toMatch(/whatsapp_chat_read_states_organization_id_fkey[\s\S]*?ON DELETE RESTRICT/);
  });

  it('is idempotent: IF NOT EXISTS everywhere, FKs behind pg_constraint guards', () => {
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS');
    expect(sql).toContain('CREATE UNIQUE INDEX IF NOT EXISTS');
    expect(sql.match(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint/g)?.length).toBe(3);
    expect(sql).toContain('ON CONFLICT ("chat_id", "user_id") DO NOTHING');
  });

  it('backfills per-org (R7a) with gen_random_uuid() ids (R7b), only for chats reading as read today', () => {
    expect(sql).toMatch(/JOIN "users" u ON u\.organization_id = c\.organization_id AND u\.is_active/);
    expect(sql).toMatch(/WHERE c\.unread = 0/);
    expect(sql).toContain('SELECT gen_random_uuid(), c.id, u.id, now(), c.organization_id');
  });

  it('is portable: every Supabase-only touch sits behind a pg_roles guard', () => {
    expect(sql.match(/FROM pg_roles WHERE rolname = '(anon|authenticated)'/g)?.length).toBe(2);
  });

  it('enables + FORCEs row-level security with the standard tenant_isolation policy', () => {
    expect(sql).toMatch(/ALTER TABLE "whatsapp_chat_read_states" ENABLE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/ALTER TABLE "whatsapp_chat_read_states" FORCE ROW LEVEL SECURITY/);
    expect(sql).toMatch(/DROP POLICY IF EXISTS "tenant_isolation" ON "whatsapp_chat_read_states"/);
  });

  it('never ran `prisma migrate` from a worktree - no generated-diff header', () => {
    expect(sql).not.toMatch(/This is an empty migration/);
    expect(sql.trimStart().startsWith('--')).toBe(true);
  });

  it('sorts after slice 1\'s SMS migration (20260913120000)', () => {
    expect('20260913130000_whatsapp_chat_read_state' > '20260913120000_message_thread_read_state').toBe(true);
  });
});
