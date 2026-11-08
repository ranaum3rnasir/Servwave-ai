// Email slice 8b (conversation assignment) + 8c (per-user read state).
//
// 8b: EmailThread is the new normalised home for per-conversation workflow
// state (assignee, shared snooze, archive). A fresh compose creates one; a
// reply resolves and REUSES the existing one under the caller's own
// visibility. Assignment never narrows anchor-inherited visibility (Missive
// rule: "assigned to one, visible to all") - Unassigned/Mine/All are
// ADDITIONAL filters, never a competing gate. Auto-unassign ("owner
// unreachable") is a query-time/read-time reconciliation off User.is_active,
// never a written flag. Traffic Cop (Help Scout's pattern) blocks a reply
// send if the thread moved since the client started composing.
//
// 8c: EmailReadState replaces the shared Email.unread column. THE core
// regression test this rewrite exists for: two different users opening the
// "same" thread must not affect each other's read state (the exact bug
// markThreadRead used to have via a shared updateMany(unread:false)).
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

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const ADMIN_ID = TEST_USERS.admin.id;
const DISPATCHER_ID = TEST_USERS.dispatcher.id;
const TECH_ID = TEST_USERS.technician.id;

// A technician's own job vs. one they cannot see - same shape as
// comm-visibility.test.ts's fixtures, kept local so this file stands alone.
// S8 (D6): OWN_JOB reaches crew through the job's trips, so these rows carry it there.
const MY_JOB = { id: 'ab000000-0000-0000-0000-00000000000a', visits: [{ assignees: [{ user_id: TECH_ID }] }] };
const OTHER_JOB = { id: 'ab000000-0000-0000-0000-00000000000b', visits: [{ assignees: [{ user_id: 'someone-else' }] }] };

/** Grant a TECHNICIAN `update Communication` on top of their default OWN-job
 *  grants, so the assign/archive/snooze visibility scoping is exercised by a
 *  row-scoped role rather than vacuously by an org-wide admin/dispatcher. */
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

function sentDispatchDefault() {
  p.email.create.mockResolvedValue({
    id: 'created-email-1',
    account: 'user',
    from: { name: null, email: 'no-reply@mail.test.com' },
    to: 'angel@example.com',
    subject: 'Hi',
    snippet: 'hi',
    body: ['hi'],
    at: '3:00 PM',
    ts: BigInt(1789000005000),
    unread: false,
    starred: false,
    folder: 'sent',
    thread_id: 'new-thread-1',
    organization_id: ALPHA_ORG_ID,
  });
}

beforeEach(async () => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  // `vi.clearAllMocks()` clears CALL HISTORY, not a `mockResolvedValue` set by
  // an earlier test in this same file - re-pin the 'sent' default every test
  // so one test overriding it to 'skipped'/'failed' cannot bleed into the next.
  const { sendComposedEmail } = await import('../lib/email.js');
  (sendComposedEmail as any).mockResolvedValue({
    status: 'sent',
    providerMessageId: 're_test_compose',
    fromAddress: 'no-reply@mail.test.com',
    fromName: null,
  });
  p.emailThread.create.mockImplementation((args: any) =>
    Promise.resolve({
      id: 'new-thread-1',
      assigned_to_user_id: args?.data?.assigned_to_user_id ?? null,
      snoozed_until: null,
      archived: false,
      organization_id: args?.data?.organization_id,
    }));
});

// ═══ 1. Fresh compose creates a new EmailThread ══════════════════════════════

describe('POST /api/communication/emails - EmailThread creation on fresh compose', () => {
  it('creates a new thread assigned to the sender, and stamps sent_by_user_id', async () => {
    mockAuthAs('admin');
    sentDispatchDefault();

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('subject', 'Hi')
      .field('body', JSON.stringify(['hi']));

    expect(res.status).toBe(201);
    expect(p.emailThread.create).toHaveBeenCalledTimes(1);
    expect(p.emailThread.create.mock.calls[0][0].data).toMatchObject({
      assigned_to_user_id: ADMIN_ID,
      organization_id: ALPHA_ORG_ID,
    });

    const emailData = p.email.create.mock.calls[0][0].data;
    expect(emailData.thread_id).toBe('new-thread-1');
    expect(emailData.sent_by_user_id).toBe(ADMIN_ID);
  });

  it('stamps an EmailReadState for the sender - their own sent message reads as read for them', async () => {
    mockAuthAs('admin');
    sentDispatchDefault();

    await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['hi']));

    expect(p.emailReadState.create).toHaveBeenCalledTimes(1);
    expect(p.emailReadState.create.mock.calls[0][0].data).toMatchObject({
      email_id: 'created-email-1',
      user_id: ADMIN_ID,
      organization_id: ALPHA_ORG_ID,
    });
  });

  it('does not create a thread (or the row, or the read-state) when the dispatch is skipped', async () => {
    mockAuthAs('admin');
    const { sendComposedEmail } = await import('../lib/email.js');
    (sendComposedEmail as any).mockResolvedValue({ status: 'skipped', reason: 'org_disabled' });

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['hi']));

    expect(res.status).toBe(409);
    expect(p.emailThread.create).not.toHaveBeenCalled();
    expect(p.email.create).not.toHaveBeenCalled();
    expect(p.emailReadState.create).not.toHaveBeenCalled();
  });
});

// ═══ 2. Reply reuses the existing thread (not duplicated) ════════════════════

describe('POST /api/communication/emails - a reply reuses the existing thread', () => {
  it('resolves thread_id to the real EmailThread and does NOT mint a new one', async () => {
    mockAuthAs('admin');
    sentDispatchDefault();
    // resolveVisibleThreadId's lookup (no orderBy - discriminates it from the
    // Traffic Cop's "latest message" query below).
    p.email.findFirst.mockImplementation((args: any) =>
      Promise.resolve(args.orderBy ? null : { thread_id: 'b0000000-0000-4000-8000-000000000006' }));

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('thread_id', 'b0000000-0000-4000-8000-000000000006')
      .field('body', JSON.stringify(['reply body']));

    expect(res.status).toBe(201);
    expect(p.emailThread.create).not.toHaveBeenCalled();
    expect(p.email.create.mock.calls[0][0].data.thread_id).toBe('b0000000-0000-4000-8000-000000000006');
  });

  it('falls back to a FRESH thread when the claimed thread_id does not resolve to anything visible', async () => {
    mockAuthAs('admin');
    sentDispatchDefault();
    p.email.findFirst.mockResolvedValue(null); // nothing visible under that id

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('thread_id', 'stale-client-id')
      .field('body', JSON.stringify(['hi']));

    expect(res.status).toBe(201);
    expect(p.emailThread.create).toHaveBeenCalledTimes(1);
    expect(p.email.create.mock.calls[0][0].data.thread_id).toBe('new-thread-1');
  });

  it('a technician cannot reuse a thread anchored to a job they cannot see (resolution is visibility-scoped)', async () => {
    mockAuthAs('technician');
    p.job.findUnique.mockResolvedValue(null); // no job_id on this request, irrelevant
    sentDispatchDefault();

    await request(app)
      .post('/api/communication/emails')
      .set(authHeader('technician'))
      .send({ to: 'a@b.com', body: ['hi'], thread_id: 'b0000000-0000-4000-8000-000000000001' });

    // resolveVisibleThreadId's own findFirst call carries the caller's
    // anchor-visibility filter, not just tenancy.
    const call = p.email.findFirst.mock.calls.find((c: any) => !c[0].orderBy);
    expect(call).toBeTruthy();
    const where = call[0].where;
    expect(matchesWhere({ id: 'x', organization_id: ALPHA_ORG_ID, thread_id: 'b0000000-0000-4000-8000-000000000001', job_id: MY_JOB.id, job: MY_JOB, lead_id: null, lead: null, customer_id: null, vendor_id: null }, where)).toBe(true);
    expect(matchesWhere({ id: 'x', organization_id: ALPHA_ORG_ID, thread_id: 'b0000000-0000-4000-8000-000000000001', job_id: OTHER_JOB.id, job: OTHER_JOB, lead_id: null, lead: null, customer_id: null, vendor_id: null }, where)).toBe(false);
  });
});

// ═══ 3. Traffic Cop ═══════════════════════════════════════════════════════════

describe('Traffic Cop - compose-time race guard on a reply', () => {
  const THREAD_ID = 'b0000000-0000-4000-8000-000000000002';
  const COMPOSING_SINCE = '2026-08-05T10:00:00.000Z';

  function mockResolvedThread() {
    p.email.findFirst.mockImplementation((args: any) => {
      if (args.orderBy) return Promise.resolve(null); // set per-test
      return Promise.resolve({ thread_id: THREAD_ID });
    });
  }

  it('409s THREAD_CHANGED and sends nothing when the thread has a newer message', async () => {
    mockAuthAs('admin');
    p.email.findFirst.mockImplementation((args: any) => {
      if (args.orderBy) return Promise.resolve({ created_at: new Date('2026-08-05T10:05:00.000Z') });
      return Promise.resolve({ thread_id: THREAD_ID });
    });
    p.email.findMany.mockResolvedValue([
      {
        id: 'new-msg-1',
        account: 'user',
        from: { name: 'Someone', email: 'someone@example.com' },
        to: 'me@example.com',
        subject: 'Re: Hi',
        snippet: 'wait',
        body: ['wait'],
        at: '10:05 AM',
        ts: BigInt(1),
        unread: true,
        starred: false,
        folder: 'inbox',
        created_at: new Date('2026-08-05T10:05:00.000Z'),
      },
    ]);
    const { sendComposedEmail } = await import('../lib/email.js');

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .send({ to: 'a@b.com', body: ['reply'], thread_id: THREAD_ID, composing_since: COMPOSING_SINCE });

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('THREAD_CHANGED');
    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].id).toBe('new-msg-1');
    expect(sendComposedEmail).not.toHaveBeenCalled();
    expect(p.email.create).not.toHaveBeenCalled();
    expect(p.emailThread.create).not.toHaveBeenCalled();
  });

  it('proceeds normally when nothing changed since composing_since', async () => {
    mockAuthAs('admin');
    mockResolvedThread();
    p.email.findFirst.mockImplementation((args: any) => {
      if (args.orderBy) return Promise.resolve({ created_at: new Date('2026-08-05T09:00:00.000Z') });
      return Promise.resolve({ thread_id: THREAD_ID });
    });
    sentDispatchDefault();
    const { sendComposedEmail } = await import('../lib/email.js');

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .send({ to: 'a@b.com', body: ['reply'], thread_id: THREAD_ID, composing_since: COMPOSING_SINCE });

    expect(res.status).toBe(201);
    expect(sendComposedEmail).toHaveBeenCalledTimes(1);
    expect(p.email.create.mock.calls[0][0].data.thread_id).toBe(THREAD_ID);
  });

  it('does not fire without composing_since, even if the thread actually changed', async () => {
    mockAuthAs('admin');
    p.email.findFirst.mockImplementation((args: any) => {
      if (args.orderBy) return Promise.resolve({ created_at: new Date('2026-08-05T23:00:00.000Z') });
      return Promise.resolve({ thread_id: THREAD_ID });
    });
    sentDispatchDefault();
    const { sendComposedEmail } = await import('../lib/email.js');

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .send({ to: 'a@b.com', body: ['reply'], thread_id: THREAD_ID });

    expect(res.status).toBe(201);
    expect(sendComposedEmail).toHaveBeenCalledTimes(1);
    // The "latest message" query is never issued at all - nothing to compare against.
    expect(p.email.findFirst.mock.calls.some((c: any) => c[0].orderBy)).toBe(false);
  });
});

// ═══ 4. PATCH /emails/threads/:id/assign ═════════════════════════════════════

describe('PATCH /api/communication/emails/threads/:id/assign', () => {
  it('assigns a thread (admin, unrestricted)', async () => {
    mockAuthAs('admin');
    p.user.findFirst.mockResolvedValue({ id: DISPATCHER_ID });
    p.emailThread.updateMany.mockResolvedValue({ count: 1 });
    p.emailThread.findFirst.mockResolvedValue({
      id: 'a1111111-1111-4111-8111-111111111111', assigned_to_user_id: DISPATCHER_ID, archived: false, snoozed_until: null,
      assigned_to: { id: DISPATCHER_ID, is_active: true },
    });

    const res = await request(app)
      .patch('/api/communication/emails/threads/d0000000-0000-4000-8000-000000000001/assign')
      .set(authHeader('admin'))
      .send({ user_id: DISPATCHER_ID });

    expect(res.status).toBe(200);
    expect(res.body.thread.assignedToUserId).toBe(DISPATCHER_ID);
    expect(p.emailThread.updateMany.mock.calls[0][0].data).toEqual({ assigned_to_user_id: DISPATCHER_ID });
  });

  it('clears assignment when user_id is null', async () => {
    mockAuthAs('admin');
    p.emailThread.updateMany.mockResolvedValue({ count: 1 });
    p.emailThread.findFirst.mockResolvedValue({
      id: 'a1111111-1111-4111-8111-111111111111', assigned_to_user_id: null, archived: false, snoozed_until: null, assigned_to: null,
    });

    const res = await request(app)
      .patch('/api/communication/emails/threads/d0000000-0000-4000-8000-000000000001/assign')
      .set(authHeader('admin'))
      .send({ user_id: null });

    expect(res.status).toBe(200);
    expect(res.body.thread.assignedToUserId).toBeNull();
    expect(p.user.findFirst).not.toHaveBeenCalled();
    expect(p.emailThread.updateMany.mock.calls[0][0].data).toEqual({ assigned_to_user_id: null });
  });

  it('404s assigning to a user outside this org', async () => {
    mockAuthAs('admin');
    p.user.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/communication/emails/threads/d0000000-0000-4000-8000-000000000001/assign')
      .set(authHeader('admin'))
      .send({ user_id: '99999999-9999-9999-9999-999999999999' });

    expect(res.status).toBe(404);
    expect(p.emailThread.updateMany).not.toHaveBeenCalled();
  });

  it('a technician cannot assign a thread anchored to a job they cannot see', async () => {
    mockRowScopedEditor();
    p.user.findFirst.mockResolvedValue({ id: DISPATCHER_ID });
    p.emailThread.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .patch('/api/communication/emails/threads/d0000000-0000-4000-8000-000000000002/assign')
      .set(authHeader('technician'))
      .send({ user_id: DISPATCHER_ID });

    expect(res.status).toBe(404);
    const where = p.emailThread.updateMany.mock.calls[0][0].where;
    const parentRow = (job: Row): Row => ({
      id: 'd0000000-0000-4000-8000-000000000002',
      organization_id: ALPHA_ORG_ID,
      emails: [{ job_id: (job as any).id, job, lead_id: null, lead: null, customer_id: null, vendor_id: null }],
    });
    expect(matchesWhere(parentRow(MY_JOB as Row), where)).toBe(true);
    expect(matchesWhere(parentRow(OTHER_JOB as Row), where)).toBe(false);
  });

  it('a technician CAN assign a thread anchored to their own job', async () => {
    mockRowScopedEditor();
    p.user.findFirst.mockResolvedValue({ id: TECH_ID });
    p.emailThread.updateMany.mockResolvedValue({ count: 1 });
    p.emailThread.findFirst.mockResolvedValue({
      id: 'th-my-job', assigned_to_user_id: TECH_ID, archived: false, snoozed_until: null,
      assigned_to: { id: TECH_ID, is_active: true },
    });

    const res = await request(app)
      .patch('/api/communication/emails/threads/d0000000-0000-4000-8000-000000000003/assign')
      .set(authHeader('technician'))
      .send({ user_id: TECH_ID });

    expect(res.status).toBe(200);
    expect(res.body.thread.assignedToUserId).toBe(TECH_ID);
  });
});

// ═══ 5. Archive / snooze - same scoping pattern as assign ════════════════════

describe('PATCH /api/communication/emails/threads/:id/archive', () => {
  it('archives a thread', async () => {
    mockAuthAs('admin');
    p.emailThread.updateMany.mockResolvedValue({ count: 1 });
    p.emailThread.findFirst.mockResolvedValue({
      id: 'a1111111-1111-4111-8111-111111111111', assigned_to_user_id: null, archived: true, snoozed_until: null, assigned_to: null,
    });

    const res = await request(app)
      .patch('/api/communication/emails/threads/d0000000-0000-4000-8000-000000000001/archive')
      .set(authHeader('admin'))
      .send({ archived: true });

    expect(res.status).toBe(200);
    expect(res.body.thread.archived).toBe(true);
    expect(p.emailThread.updateMany.mock.calls[0][0].data).toEqual({ archived: true });
  });

  it('a technician cannot archive a thread anchored to a job they cannot see', async () => {
    mockRowScopedEditor();
    p.emailThread.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .patch('/api/communication/emails/threads/d0000000-0000-4000-8000-000000000002/archive')
      .set(authHeader('technician'))
      .send({ archived: true });

    expect(res.status).toBe(404);
    const where = p.emailThread.updateMany.mock.calls[0][0].where;
    const parentRow = (job: Row): Row => ({
      id: 'd0000000-0000-4000-8000-000000000002',
      organization_id: ALPHA_ORG_ID,
      emails: [{ job_id: (job as any).id, job, lead_id: null, lead: null, customer_id: null, vendor_id: null }],
    });
    expect(matchesWhere(parentRow(OTHER_JOB as Row), where)).toBe(false);
  });
});

describe('PATCH /api/communication/emails/threads/:id/snooze', () => {
  it('sets a shared snooze', async () => {
    mockAuthAs('admin');
    p.emailThread.updateMany.mockResolvedValue({ count: 1 });
    const snoozedUntil = new Date('2026-08-10T09:00:00.000Z');
    p.emailThread.findFirst.mockResolvedValue({
      id: 'a1111111-1111-4111-8111-111111111111', assigned_to_user_id: null, archived: false, snoozed_until: snoozedUntil, assigned_to: null,
    });

    const res = await request(app)
      .patch('/api/communication/emails/threads/d0000000-0000-4000-8000-000000000001/snooze')
      .set(authHeader('admin'))
      .send({ snoozed_until: '2026-08-10T09:00:00.000Z' });

    expect(res.status).toBe(200);
    expect(new Date(res.body.thread.snoozedUntil).toISOString()).toBe(snoozedUntil.toISOString());
    expect(p.emailThread.updateMany.mock.calls[0][0].data.snoozed_until).toEqual(snoozedUntil);
  });

  it('clears a snooze with null', async () => {
    mockAuthAs('admin');
    p.emailThread.updateMany.mockResolvedValue({ count: 1 });
    p.emailThread.findFirst.mockResolvedValue({
      id: 'a1111111-1111-4111-8111-111111111111', assigned_to_user_id: null, archived: false, snoozed_until: null, assigned_to: null,
    });

    const res = await request(app)
      .patch('/api/communication/emails/threads/d0000000-0000-4000-8000-000000000001/snooze')
      .set(authHeader('admin'))
      .send({ snoozed_until: null });

    expect(res.status).toBe(200);
    expect(p.emailThread.updateMany.mock.calls[0][0].data.snoozed_until).toBeNull();
  });
});

// ═══ 6. Unassigned / Mine / All filtering ═════════════════════════════════════

describe('GET /api/communication/emails?assignment=... filtering', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    p.email.findMany.mockResolvedValue([]);
  });

  it('assignment=mine filters to threads assigned to the caller', async () => {
    await request(app).get('/api/communication/emails?assignment=mine').set(authHeader('admin'));
    const where = p.email.findMany.mock.calls[0][0].where;
    expect(where.thread).toEqual({ assigned_to_user_id: ADMIN_ID });
  });

  it('assignment=unassigned folds in auto-unassign (no thread, no assignee, OR inactive assignee)', async () => {
    await request(app).get('/api/communication/emails?assignment=unassigned').set(authHeader('admin'));
    const where = p.email.findMany.mock.calls[0][0].where;

    const noThread: Row = { id: 'e1', organization_id: ALPHA_ORG_ID, thread_id: null };
    const unassignedThread: Row = { id: 'e2', organization_id: ALPHA_ORG_ID, thread_id: 't1', thread: { assigned_to_user_id: null } };
    const assignedActiveThread: Row = {
      id: 'e3', organization_id: ALPHA_ORG_ID, thread_id: 't2', thread: { assigned_to_user_id: 'u1', assigned_to: { is_active: true } },
    };
    const assignedButDeactivated: Row = {
      id: 'e4', organization_id: ALPHA_ORG_ID, thread_id: 't3', thread: { assigned_to_user_id: 'u1', assigned_to: { is_active: false } },
    };

    expect(matchesWhere(noThread, where)).toBe(true);
    expect(matchesWhere(unassignedThread, where)).toBe(true);
    expect(matchesWhere(assignedButDeactivated, where)).toBe(true);
    expect(matchesWhere(assignedActiveThread, where)).toBe(false);
  });

  it('assignment=all (or omitted) applies no additional filter', async () => {
    await request(app).get('/api/communication/emails?assignment=all').set(authHeader('admin'));
    const where = p.email.findMany.mock.calls[0][0].where;
    expect(where.thread).toBeUndefined();
    expect(where.OR).toBeUndefined();

    p.email.findMany.mockClear();
    await request(app).get('/api/communication/emails').set(authHeader('admin'));
    const where2 = p.email.findMany.mock.calls[0][0].where;
    expect(where2.thread).toBeUndefined();
    expect(where2.OR).toBeUndefined();
  });

  // Regression: `commVisibilityWhere` ALSO emits a top-level `OR` for any
  // row-scoped caller. Naively spreading assignmentFilter's own `OR` on top
  // (a plain object spread) makes the second `OR` key silently clobber the
  // first, replacing anchor-inherited visibility instead of narrowing it -
  // the admin-only test above can never catch this, since an admin's
  // `commVisibilityWhere` resolves to `{}` (no `OR` key to collide with).
  it('a row-scoped caller\'s assignment=unassigned NARROWS visibility, never replaces it', async () => {
    mockRowScopedEditor();
    await request(app).get('/api/communication/emails?assignment=unassigned').set(authHeader('technician'));
    const where = p.email.findMany.mock.calls[0][0].where;

    const base = { organization_id: ALPHA_ORG_ID, lead_id: null, lead: null, customer_id: null, vendor_id: null };
    const myJobUnassigned: Row = { ...base, id: 'e1', thread_id: 't1', job_id: MY_JOB.id, job: MY_JOB, thread: { assigned_to_user_id: null } };
    const otherJobUnassigned: Row = { ...base, id: 'e2', thread_id: 't2', job_id: OTHER_JOB.id, job: OTHER_JOB, thread: { assigned_to_user_id: null } };
    const myJobAssignedActive: Row = {
      ...base, id: 'e3', thread_id: 't3', job_id: MY_JOB.id, job: MY_JOB,
      thread: { assigned_to_user_id: 'someone-else', assigned_to: { is_active: true } },
    };

    // Visible (own job) AND unassigned -> shows.
    expect(matchesWhere(myJobUnassigned, where)).toBe(true);
    // Unassigned, but on a job this technician cannot see -> visibility must
    // still exclude it. This is the exact case the OR-collision bug got wrong.
    expect(matchesWhere(otherJobUnassigned, where)).toBe(false);
    // Visible, but assigned (and active) -> the assignment filter excludes it.
    expect(matchesWhere(myJobAssignedActive, where)).toBe(false);
  });
});

// ═══ 7. Auto-unassign reflected in a single email's mapped response ══════════

describe('auto-unassign: a deactivated assignee reads as Unassigned on the mapped row', () => {
  it('GET /emails/:id reports threadAssignedToUserId: null for an inactive assignee', async () => {
    mockAuthAs('admin');
    p.email.findFirst.mockResolvedValue({
      id: 'e1', account: 'user', from: {}, to: 'x', subject: 's', snippet: 's', body: ['s'],
      at: '1:00', ts: 1n, unread: true, starred: false, folder: 'inbox',
      thread_id: 't1',
      thread: {
        id: 't1', assigned_to_user_id: 'deactivated-user', archived: false, snoozed_until: null,
        assigned_to: { id: 'deactivated-user', is_active: false },
      },
    });
    p.emailReadState.findMany.mockResolvedValue([]);

    const res = await request(app).get('/api/communication/emails/e1').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.email.threadAssignedToUserId).toBeNull();
  });
});

// ═══ 8. markThreadRead - per-user isolation (THE core regression test) ═══════

describe('markThreadRead affects ONLY the calling user - two users, "same" thread', () => {
  it('creates EmailReadState scoped to whichever user called it, never the other', async () => {
    p.email.findMany.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }]);
    p.emailReadState.createMany.mockResolvedValue({ count: 2 });

    mockAuthAs('admin');
    await request(app)
      .patch('/api/communication/emails/thread-read')
      .set(authHeader('admin'))
      .send({ thread_id: 'b0000000-0000-4000-8000-000000000003' });

    mockAuthAs('dispatcher');
    await request(app)
      .patch('/api/communication/emails/thread-read')
      .set(authHeader('dispatcher'))
      .send({ thread_id: 'b0000000-0000-4000-8000-000000000003' });

    expect(p.emailReadState.createMany).toHaveBeenCalledTimes(2);
    const adminData = p.emailReadState.createMany.mock.calls[0][0].data;
    const dispatcherData = p.emailReadState.createMany.mock.calls[1][0].data;
    expect(adminData.every((d: any) => d.user_id === ADMIN_ID)).toBe(true);
    expect(dispatcherData.every((d: any) => d.user_id === DISPATCHER_ID)).toBe(true);
    // Neither call ever touches the shared Email.unread column.
    expect(p.email.updateMany).not.toHaveBeenCalled();
  });

  it('respects visibility - only creates read-state for rows the caller can see', async () => {
    mockRowScopedEditor();
    p.email.findMany.mockResolvedValue([{ id: 'visible-1' }]); // the mock IS the visibility filter's result
    p.emailReadState.createMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .patch('/api/communication/emails/thread-read')
      .set(authHeader('technician'))
      .send({ thread_id: 'a1111111-1111-4111-8111-111111111111' });

    expect(res.status).toBe(200);
    const findWhere = p.email.findMany.mock.calls[0][0].where;
    expect(matchesWhere({ id: 'on-other-job', organization_id: ALPHA_ORG_ID, thread_id: 'a1111111-1111-4111-8111-111111111111', job_id: OTHER_JOB.id, job: OTHER_JOB, lead_id: null, lead: null, customer_id: null, vendor_id: null }, findWhere)).toBe(false);
    expect(matchesWhere({ id: 'on-my-job', organization_id: ALPHA_ORG_ID, thread_id: 'a1111111-1111-4111-8111-111111111111', job_id: MY_JOB.id, job: MY_JOB, lead_id: null, lead: null, customer_id: null, vendor_id: null }, findWhere)).toBe(true);
  });

  it('two users reading the "same" message have independent unread state on GET /emails/:id', async () => {
    const emailRow = {
      id: 'e1', account: 'in', from: { name: 'Cust', email: 'c@x.com' }, to: 'me@x.com',
      subject: 's', snippet: 's', body: ['s'], at: '1:00', ts: 1n, unread: true, starred: false, folder: 'inbox',
    };
    p.email.findFirst.mockResolvedValue(emailRow);
    // Only the admin has read it; the dispatcher has not.
    p.emailReadState.findMany.mockImplementation((args: any) =>
      Promise.resolve(args.where.user_id === ADMIN_ID ? [{ email_id: 'e1' }] : []));

    mockAuthAs('admin');
    const asAdmin = await request(app).get('/api/communication/emails/e1').set(authHeader('admin'));
    expect(asAdmin.body.email.unread).toBe(false);

    mockAuthAs('dispatcher');
    const asDispatcher = await request(app).get('/api/communication/emails/e1').set(authHeader('dispatcher'));
    expect(asDispatcher.body.email.unread).toBe(true);
  });
});

// ═══ 9. getUnreadCounts - genuinely per-user ══════════════════════════════════

describe('GET /communication/unread-counts - email count is per-user', () => {
  it('counts via email_read_states: { none: { user_id } }, not the shared unread column', async () => {
    mockAuthAs('admin');
    p.email.count.mockResolvedValue(0);
    p.messageThread.aggregate.mockResolvedValue({ _sum: { unread: 0 } });
    p.whatsAppChat.aggregate.mockResolvedValue({ _sum: { unread: 0 } });

    await request(app).get('/api/communication/unread-counts').set(authHeader('admin'));

    const where = p.email.count.mock.calls[0][0].where;
    expect(where.unread).toBeUndefined();
    expect(where.email_read_states).toEqual({ none: { user_id: ADMIN_ID } });
  });

  it('two different callers get independently-keyed queries', async () => {
    p.email.count.mockResolvedValue(0);
    p.messageThread.aggregate.mockResolvedValue({ _sum: { unread: 0 } });
    p.whatsAppChat.aggregate.mockResolvedValue({ _sum: { unread: 0 } });

    mockAuthAs('admin');
    await request(app).get('/api/communication/unread-counts').set(authHeader('admin'));
    mockAuthAs('dispatcher');
    await request(app).get('/api/communication/unread-counts').set(authHeader('dispatcher'));

    expect(p.email.count.mock.calls[0][0].where.email_read_states).toEqual({ none: { user_id: ADMIN_ID } });
    expect(p.email.count.mock.calls[1][0].where.email_read_states).toEqual({ none: { user_id: DISPATCHER_ID } });
  });
});

// ═══ 10. listEmails/getEmail per-row unread - one query, never N+1 ═══════════

describe('listEmails computes per-caller unread with exactly ONE extra query', () => {
  it('a 3-email list issues exactly one emailReadState.findMany, not one per row', async () => {
    mockAuthAs('admin');
    p.email.findMany.mockResolvedValue([
      { id: 'e1', account: 'user', from: {}, to: 'x', subject: 's', snippet: 's', body: ['s'], at: '1', ts: 1n, unread: true, starred: false, folder: 'inbox' },
      { id: 'e2', account: 'user', from: {}, to: 'x', subject: 's', snippet: 's', body: ['s'], at: '1', ts: 1n, unread: true, starred: false, folder: 'inbox' },
      { id: 'e3', account: 'user', from: {}, to: 'x', subject: 's', snippet: 's', body: ['s'], at: '1', ts: 1n, unread: true, starred: false, folder: 'inbox' },
    ]);
    p.emailReadState.findMany.mockResolvedValue([{ email_id: 'e2' }]);

    const res = await request(app).get('/api/communication/emails').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(p.emailReadState.findMany).toHaveBeenCalledTimes(1);
    const byId = Object.fromEntries(res.body.emails.map((e: any) => [e.id, e.unread]));
    expect(byId.e1).toBe(true);
    expect(byId.e2).toBe(false);
    expect(byId.e3).toBe(true);
  });

  it('an empty list issues no read-state query at all', async () => {
    mockAuthAs('admin');
    p.email.findMany.mockResolvedValue([]);

    await request(app).get('/api/communication/emails').set(authHeader('admin'));

    expect(p.emailReadState.findMany).not.toHaveBeenCalled();
  });
});

// ═══ 11. Traffic Cop 409 payload - unread must be caller-computed too ════════

describe('THREAD_CHANGED 409 payload computes unread the same way as every other read path', () => {
  it('messages[].unread reflects the caller\'s own EmailReadState, not the dead shared column', async () => {
    mockAuthAs('admin');
    const THREAD_ID = 'b0000000-0000-4000-8000-000000000007';
    const COMPOSING_SINCE = '2026-08-05T10:00:00.000Z';
    p.email.findFirst.mockImplementation((args: any) => {
      if (args.orderBy) return Promise.resolve({ created_at: new Date('2026-08-05T10:05:00.000Z') });
      return Promise.resolve({ thread_id: THREAD_ID });
    });
    p.email.findMany.mockResolvedValue([
      {
        id: 'new-msg-unread-1',
        account: 'user',
        from: { name: 'Someone', email: 'someone@example.com' },
        to: 'me@example.com',
        subject: 'Re: Hi',
        snippet: 'wait',
        body: ['wait'],
        at: '10:05 AM',
        ts: BigInt(1),
        // The dead shared column deliberately says read - if the response
        // fell back to this instead of calling attachCallerUnread, it would
        // report unread:false and this assertion would fail.
        unread: false,
        starred: false,
        folder: 'inbox',
        created_at: new Date('2026-08-05T10:05:00.000Z'),
      },
    ]);
    // The caller has NOT read this message per-user.
    p.emailReadState.findMany.mockResolvedValue([]);

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .send({ to: 'a@b.com', body: ['reply'], thread_id: THREAD_ID, composing_since: COMPOSING_SINCE });

    expect(res.status).toBe(409);
    // Exactly one extra query for the whole batch - same contract as
    // attachCallerUnread's other callers, never N+1.
    expect(p.emailReadState.findMany).toHaveBeenCalledTimes(1);
    expect(res.body.messages[0].unread).toBe(true);
  });
});

// ═══ 12. Cross-org + snooze scoping gaps (test-coverage review) ══════════════

describe('EmailThread scoping - remaining gaps on the shared updateEmailThread path', () => {
  it('a technician cannot snooze a thread anchored to a job they cannot see', async () => {
    mockRowScopedEditor();
    p.emailThread.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .patch('/api/communication/emails/threads/d0000000-0000-4000-8000-000000000002/snooze')
      .set(authHeader('technician'))
      .send({ snoozed_until: '2026-08-10T09:00:00.000Z' });

    expect(res.status).toBe(404);
    const where = p.emailThread.updateMany.mock.calls[0][0].where;
    const parentRow = (job: Row): Row => ({
      id: 'd0000000-0000-4000-8000-000000000002',
      organization_id: ALPHA_ORG_ID,
      emails: [{ job_id: (job as any).id, job, lead_id: null, lead: null, customer_id: null, vendor_id: null }],
    });
    expect(matchesWhere(parentRow(MY_JOB as Row), where)).toBe(true);
    expect(matchesWhere(parentRow(OTHER_JOB as Row), where)).toBe(false);
  });

  it('404s archiving a thread that belongs to a different organization (not just a different assignee)', async () => {
    mockAuthAs('admin');
    p.emailThread.updateMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .patch('/api/communication/emails/threads/d0000000-0000-4000-8000-000000000004/archive')
      .set(authHeader('admin'))
      .send({ archived: true });

    expect(res.status).toBe(404);
    const where = p.emailThread.updateMany.mock.calls[0][0].where;
    expect(matchesWhere({ id: 'd0000000-0000-4000-8000-000000000004', organization_id: 'some-other-org-id' }, where)).toBe(false);
    expect(matchesWhere({ id: 'd0000000-0000-4000-8000-000000000004', organization_id: ALPHA_ORG_ID }, where)).toBe(true);
  });
});
