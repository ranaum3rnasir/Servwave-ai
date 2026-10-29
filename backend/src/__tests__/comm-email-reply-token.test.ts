// Email slice 6 (inbound reply capture) - stamping the reply token on outbound
// compose, so a customer hitting Reply lands back on the right thread.
//
// THE ORDERING IS THE WHOLE POINT of these tests. The compose path creates its
// EmailThread only AFTER a successful dispatch, so a send that never left
// leaves no orphan behind ("a dispatch that never left persists NOTHING"). But
// the reply token has to be inside the Reply-To header OF that dispatch. That
// forces two phases:
//
//   prepare (read-only, before the send) -> dispatch with Reply-To
//     -> persist (after the send, carrying the thread id that now exists)
//
// So the invariants worth locking are: the token in the header is byte-for-byte
// the token in the database; a failed send writes NO token row; and a reply into
// an existing thread reuses its address rather than minting a second one, since
// a fresh address per message would scatter one conversation across as many
// threads as it has messages.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, TEST_USERS } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const ADMIN_ID = TEST_USERS.admin.id;

/**
 * Matches setup.ts's env mock, which deliberately differs from the production
 * default so these assertions fail if the domain is ever hardcoded.
 */
const REPLY_DOMAIN = 'reply.test.com';

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

function replyToOf(sendComposedEmail: any): string | undefined {
  return sendComposedEmail.mock.calls[0][0].replyTo;
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
  p.emailThread.create.mockImplementation((args: any) =>
    Promise.resolve({
      id: 'new-thread-1',
      assigned_to_user_id: args?.data?.assigned_to_user_id ?? null,
      snoozed_until: null,
      archived: false,
      organization_id: args?.data?.organization_id,
    }));
  p.email.create.mockResolvedValue({ id: 'row-9', ts: BigInt(1789000005000), from: {} });
});

describe('POST /api/communication/emails - Reply-To carries a reply token', () => {
  it('stamps Reply-To as <token>@the reply domain on the dispatch', async () => {
    mockAuthAs('admin');
    const sendComposedEmail = await sentDispatch();

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('subject', 'Hi')
      .field('body', JSON.stringify(['hi']));

    expect(res.status).toBe(201);
    const replyTo = replyToOf(sendComposedEmail);
    // 22 base64url chars - the RFC 5321 local-part budget the token design
    // exists to fit inside.
    expect(replyTo).toMatch(new RegExp(`^[A-Za-z0-9_-]{22}@${REPLY_DOMAIN.replace(/\./g, '\\.')}$`));
  });

  it('persists the SAME token that went out in the header', async () => {
    mockAuthAs('admin');
    const sendComposedEmail = await sentDispatch();

    await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['hi']));

    // Byte-for-byte: a regenerated token would leave the customer replying to an
    // address that resolves to nothing.
    const sentToken = replyToOf(sendComposedEmail)!.split('@')[0];
    expect(p.replyToken.create).toHaveBeenCalledTimes(1);
    expect(p.replyToken.create.mock.calls[0][0].data.token).toBe(sentToken);
  });

  it('persists the token against the thread that the send just created', async () => {
    mockAuthAs('admin');
    await sentDispatch();

    await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['hi']));

    // The thread id only exists AFTER the dispatch, which is exactly why the
    // write is a second phase rather than part of minting.
    expect(p.replyToken.create.mock.calls[0][0].data).toMatchObject({
      thread_id: 'new-thread-1',
      organization_id: ALPHA_ORG_ID,
      created_by_user_id: ADMIN_ID,
    });
  });

  it('records the recipient as expected_from, lowercased', async () => {
    mockAuthAs('admin');
    await sentDispatch();

    await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'Angel@Example.COM')
      .field('body', JSON.stringify(['hi']));

    // This is the address the inbound sender check compares against. A customer
    // whose client capitalises their own address must not be demoted to the
    // unmatched queue over it.
    expect(p.replyToken.create.mock.calls[0][0].data.expected_from).toBe('angel@example.com');
  });

  it('never sets expires_at - reply tokens do not expire', async () => {
    mockAuthAs('admin');
    await sentDispatch();

    await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['hi']));

    expect(p.replyToken.create.mock.calls[0][0].data.expires_at).toBeUndefined();
  });
});

describe('POST /api/communication/emails - a failed dispatch persists no token', () => {
  it.each([
    ['skipped', { status: 'skipped', reason: 'org_disabled' }],
    ['failed', { status: 'failed', error: 'boom' }],
  ])('writes no reply_tokens row when the dispatch is %s', async (_label, result) => {
    mockAuthAs('admin');
    const { sendComposedEmail } = await import('../lib/email.js');
    (sendComposedEmail as any).mockResolvedValue(result);

    await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['hi']));

    // Same invariant as the Email row and the EmailThread: a message that never
    // left leaves nothing behind, including a live reply address pointing at a
    // thread that does not exist.
    expect(p.replyToken.create).not.toHaveBeenCalled();
    expect(p.emailThread.create).not.toHaveBeenCalled();
  });

  it('still passes a Reply-To on the attempt that failed', async () => {
    // The header has to be built BEFORE we know the outcome; only the write is
    // conditional. This documents that prepare/persist really are split.
    mockAuthAs('admin');
    const { sendComposedEmail } = await import('../lib/email.js');
    (sendComposedEmail as any).mockResolvedValue({ status: 'failed', error: 'boom' });

    await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['hi']));

    expect(replyToOf(sendComposedEmail as any)).toContain(`@${REPLY_DOMAIN}`);
  });
});

describe('POST /api/communication/emails - a reply reuses the thread address', () => {
  it('reuses a live token for the same thread and recipient instead of minting another', async () => {
    mockAuthAs('admin');
    const sendComposedEmail = await sentDispatch();
    p.email.findFirst.mockImplementation((args: any) =>
      Promise.resolve(args.orderBy ? null : { thread_id: 'b0000000-0000-4000-8000-000000000006' }));
    p.replyToken.findFirst.mockResolvedValue({
      token: 'ExistingTokenAAAAAAAAA',
      organization_id: ALPHA_ORG_ID,
      thread_id: 'b0000000-0000-4000-8000-000000000006',
      entity_type: null,
      entity_id: null,
      customer_id: null,
      expected_from: 'angel@example.com',
      created_by_user_id: ADMIN_ID,
      expires_at: null,
      revoked_at: null,
    });

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('thread_id', 'b0000000-0000-4000-8000-000000000006')
      .field('body', JSON.stringify(['reply body']));

    expect(res.status).toBe(201);
    // One stable address per (thread, recipient): a fresh one per message would
    // scatter the conversation, and would strand anyone replying to an older
    // message on a different address than the newest.
    expect(replyToOf(sendComposedEmail)).toBe(`ExistingTokenAAAAAAAAA@${REPLY_DOMAIN}`);
    expect(p.replyToken.create).not.toHaveBeenCalled();
  });

  it('scopes the reuse lookup to the thread, the recipient and the org', async () => {
    mockAuthAs('admin');
    await sentDispatch();
    p.email.findFirst.mockImplementation((args: any) =>
      Promise.resolve(args.orderBy ? null : { thread_id: 'b0000000-0000-4000-8000-000000000006' }));

    await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('thread_id', 'b0000000-0000-4000-8000-000000000006')
      .field('body', JSON.stringify(['reply body']));

    // Cross-tenant reuse would hand one org's reply address to another org's
    // customer, and a revoked token must never be handed back out.
    expect(p.replyToken.findFirst.mock.calls[0][0].where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      thread_id: 'b0000000-0000-4000-8000-000000000006',
      expected_from: 'angel@example.com',
      revoked_at: null,
    });
  });

  it('mints a fresh token when the existing one is revoked', async () => {
    mockAuthAs('admin');
    const sendComposedEmail = await sentDispatch();
    p.email.findFirst.mockImplementation((args: any) =>
      Promise.resolve(args.orderBy ? null : { thread_id: 'b0000000-0000-4000-8000-000000000006' }));
    // findFirst already filters revoked_at: null, so a revoked token simply is
    // not returned - the path under test is "no live token found".
    p.replyToken.findFirst.mockResolvedValue(null);

    await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('thread_id', 'b0000000-0000-4000-8000-000000000006')
      .field('body', JSON.stringify(['reply body']));

    expect(p.replyToken.create).toHaveBeenCalledTimes(1);
    const minted = p.replyToken.create.mock.calls[0][0].data;
    expect(minted.thread_id).toBe('b0000000-0000-4000-8000-000000000006');
    expect(replyToOf(sendComposedEmail)).toBe(`${minted.token}@${REPLY_DOMAIN}`);
  });
});
