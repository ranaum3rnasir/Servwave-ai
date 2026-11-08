// `Email.thread_id` is `String? @db.Uuid`. Postgres therefore rejects any value
// that is not a UUID, and Prisma raises P2023 ("Inconsistent column data: Error
// creating UUID") BEFORE the query runs - an exception, not an empty result.
//
// Both email endpoints that accept a caller-supplied thread id validated it as
// `z.string().min(1)` and passed it straight into a `where`, so a client that
// sent anything else got a 500. The Inbox does exactly that: a fresh compose
// has no thread to reply to, so it mints a local placeholder (`t_<epoch>`) for
// its optimistic row and submitted that as `thread_id`. Every new compose 500'd
// in production while every reply worked, because a reply carries a real UUID.
//
// The whole suite mocks Prisma, so no mocked test can reproduce P2023 - which
// is precisely why this class survived to production, and why these tests
// assert the thing that is actually true in either world: a non-UUID thread id
// is never handed to the database at all. It is treated as "no such thread",
// which is what both endpoints already promise for an id that does not resolve.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

/** What the Inbox's compose window actually put on the wire. */
const CLIENT_PLACEHOLDER = 't_1754500000000';
const REAL_THREAD_ID = '3f1c0a52-9d4e-4b7a-8c31-6e2f5a9b0d17';

async function sentDispatch() {
  const { sendComposedEmail } = await import('../lib/email.js');
  (sendComposedEmail as any).mockResolvedValue({
    status: 'sent',
    providerMessageId: 're_test_compose',
    fromAddress: 'no-reply@mail.test.com',
    fromName: null,
  });
  return sendComposedEmail as any;
}

/** Every thread_id this test's Prisma mock was ever asked to filter on. */
function threadIdsQueried(): unknown[] {
  const calls = [
    ...p.email.findFirst.mock.calls,
    ...p.email.findMany.mock.calls,
  ];
  return calls
    .map((c: any[]) => c[0]?.where?.thread_id)
    .filter((v: unknown) => v !== undefined);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  p.replyToken.findFirst.mockResolvedValue(null);
  p.email.findFirst.mockResolvedValue(null);
  p.email.findMany.mockResolvedValue([]);
  p.emailThread.create.mockResolvedValue({ id: 'new-thread-1' });
  p.email.create.mockResolvedValue({ id: 'row-9', ts: BigInt(1789000005000), from: {} });
});

describe('POST /api/communication/emails - a non-UUID thread_id', () => {
  it('sends instead of 500ing when the client submits its local placeholder id', async () => {
    mockAuthAs('admin');
    await sentDispatch();

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('subject', 'New quote')
      .field('body', JSON.stringify(['Here it is.']))
      .field('thread_id', CLIENT_PLACEHOLDER);

    expect(res.status).toBe(201);
  });

  it('never hands the placeholder to the database', async () => {
    mockAuthAs('admin');
    await sentDispatch();

    await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['Here it is.']))
      .field('thread_id', CLIENT_PLACEHOLDER);

    expect(threadIdsQueried()).not.toContain(CLIENT_PLACEHOLDER);
  });

  it('treats it as a fresh compose and mints a real thread', async () => {
    mockAuthAs('admin');
    await sentDispatch();

    await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['Here it is.']))
      .field('thread_id', CLIENT_PLACEHOLDER);

    expect(p.emailThread.create).toHaveBeenCalledTimes(1);
    expect(p.email.create.mock.calls[0][0].data.thread_id).toBe('new-thread-1');
  });

  it('skips the Traffic Cop rather than comparing against a thread that cannot exist', async () => {
    // composing_since only means something against a resolved thread. An
    // unresolvable id has no baseline to compare, so the guard must not fire -
    // and must not query for one either.
    mockAuthAs('admin');
    await sentDispatch();

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['Here it is.']))
      .field('thread_id', CLIENT_PLACEHOLDER)
      .field('composing_since', new Date(1789000000000).toISOString());

    expect(res.status).toBe(201);
    expect(threadIdsQueried()).not.toContain(CLIENT_PLACEHOLDER);
  });

  it('still resolves and reuses a real UUID thread', async () => {
    // The guard must not cost replies their thread - the case that worked all
    // along, kept honest here.
    mockAuthAs('admin');
    await sentDispatch();
    p.email.findFirst.mockResolvedValue({ thread_id: REAL_THREAD_ID });

    await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['Replying.']))
      .field('thread_id', REAL_THREAD_ID);

    expect(threadIdsQueried()).toContain(REAL_THREAD_ID);
    expect(p.emailThread.create).not.toHaveBeenCalled();
    expect(p.email.create.mock.calls[0][0].data.thread_id).toBe(REAL_THREAD_ID);
  });
});

describe('PATCH /api/communication/emails/thread-read - a non-UUID thread_id', () => {
  it('reports nothing read instead of 500ing', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch('/api/communication/emails/thread-read')
      .set(authHeader('admin'))
      .send({ thread_id: CLIENT_PLACEHOLDER });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(0);
  });

  it('never hands the placeholder to the database', async () => {
    mockAuthAs('admin');

    await request(app)
      .patch('/api/communication/emails/thread-read')
      .set(authHeader('admin'))
      .send({ thread_id: CLIENT_PLACEHOLDER });

    expect(threadIdsQueried()).not.toContain(CLIENT_PLACEHOLDER);
    expect(p.emailReadState.createMany).not.toHaveBeenCalled();
  });

  it('still marks a real UUID thread read', async () => {
    mockAuthAs('admin');
    p.email.findMany.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }]);
    p.emailReadState.createMany.mockResolvedValue({ count: 2 });

    const res = await request(app)
      .patch('/api/communication/emails/thread-read')
      .set(authHeader('admin'))
      .send({ thread_id: REAL_THREAD_ID });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(2);
    expect(p.email.findMany.mock.calls[0][0].where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      thread_id: REAL_THREAD_ID,
    });
  });
});

describe('PATCH /api/communication/emails/threads/:id - a non-UUID thread id', () => {
  // `EmailThread.id` is `@db.Uuid` too, and the shared updateEmailThread path
  // behind assign/archive/snooze took `req.params.id` raw. Reachable the same
  // way as the compose bug: a send inside its undo window shows an optimistic
  // row whose thread exists only on the client.
  it.each([
    ['assign', { user_id: null }],
    ['archive', { archived: true }],
    ['snooze', { snoozed_until: null }],
  ])('404s %s without querying the database', async (action, body) => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch(`/api/communication/emails/threads/${CLIENT_PLACEHOLDER}/${action}`)
      .set(authHeader('admin'))
      .send(body);

    expect(res.status).toBe(404);
    expect(p.emailThread.updateMany).not.toHaveBeenCalled();
  });

  it('still reaches the database for a real UUID', async () => {
    mockAuthAs('admin');
    p.emailThread.updateMany.mockResolvedValue({ count: 1 });
    p.emailThread.findFirst.mockResolvedValue({ id: REAL_THREAD_ID, assigned_to: null });

    const res = await request(app)
      .patch(`/api/communication/emails/threads/${REAL_THREAD_ID}/archive`)
      .set(authHeader('admin'))
      .send({ archived: true });

    expect(res.status).toBe(200);
    expect(p.emailThread.updateMany.mock.calls[0][0].where).toMatchObject({ id: REAL_THREAD_ID });
  });
});

