// Email slice 6 (inbound reply capture) - the unmatched queue.
//
// A message lands here when the reply token resolved a thread and we REFUSED to
// attach it, because the From address was not the one we sent to or DMARC said
// the From was forged. That refusal is the feature: attaching a forged reply to
// a customer's thread is worse than making an operator look at it.
//
// Which makes the manual link the other half of the feature. The row keeps its
// reply_token precisely so linking is one click rather than a search - and the
// link is an explicit human decision to trust a sender we would not trust
// automatically, so it must be scoped and audited like any other write, never
// inferred.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { env } from '../config/env';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';

// PRD 10, S10.18: WHO sees a held message, and which conversations a person may link one into, are decided by the Needs review
// scope (lib/communication/needsReview.ts, proved against the real tables in permission-email-needs-review-db.test.ts). This file
// proves what the two routes do WITH that answer, so the answer is a stub here.
const { visibilityWhere, listWhere, reachWhere } = vi.hoisted(() => ({
  visibilityWhere: { organization_id: '00000000-0000-0000-0000-000000000001', review_reason: { not: null }, AND: ['visible'] },
  listWhere: { AND: ['visible', 'selection'] },
  reachWhere: { id: { in: ['reachable'] } },
}));
vi.mock('../lib/communication/needsReview', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/communication/needsReview')>()),
  needsReviewVisibilityForReq: vi.fn(async () => ({ scope: 'linked_to_me', where: visibilityWhere, own: null, main: null, readable: [] })),
  needsReviewListWhereForReq: vi.fn(async () => ({ where: listWhere, selection: { kind: 'mine' }, visibility: {} })),
  // By id (the link action and the item a bell opens): the same answer, and the widening for a reply from an address we did not send
  // to is proved against the real tables in permission-email-unmatched-reply-bells-db.test.ts.
  needsReviewItemWhereForReq: vi.fn(async (_req: unknown, id: string) => ({ AND: [{ id }, visibilityWhere] })),
}));
vi.mock('../lib/communication/communicationScope', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/communication/communicationScope')>()),
  emailThreadReachWhereForReq: vi.fn(async () => reachWhere),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const THREAD = '22222222-2222-2222-2222-222222222222';
const TOKEN = 'v1jSzARGWhcIuV_cVcbJEw';

function inboundRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'b1000000-0000-4000-8000-000000000001',
    account: 'user',
    from: { name: 'Stranger', email: 'stranger@elsewhere.com' },
    to: `${TOKEN}@reply.test.com`,
    subject: 'Re: Quote',
    snippet: 'Sounds good.',
    body: ['Sounds good.'],
    body_html: null,
    at: '1:43 PM',
    ts: BigInt(1789000005000),
    unread: true,
    starred: false,
    folder: 'inbox',
    labels: null,
    has_attachment: false,
    attachments: null,
    thread_id: null,
    important: false,
    snoozed_until: null,
    customer_id: null,
    lead_id: null,
    vendor_id: null,
    job_id: null,
    job_label: null,
    cc: null,
    bcc: null,
    direction: 'in',
    provider_message_id: 'rec_abc123',
    delivery_status: null,
    reply_token: TOKEN,
    inbound_match: 'UNMATCHED_SENDER',
    inbound_auth: 'PASS',
    review_reason: 'sender_mismatch',
    review_mailbox_id: '33333333-3333-3333-3333-333333333333',
    review_thread_id: null,
    customer: null,
    lead: null,
    vendor: null,
    organization_id: ALPHA_ORG_ID,
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  p.email.findMany.mockResolvedValue([inboundRow()]);
  p.emailReadState.findMany.mockResolvedValue([]);
});

describe('GET /api/communication/emails/unmatched', () => {
  it('returns the unmatched inbound messages', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get('/api/communication/emails/unmatched')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.emails).toHaveLength(1);
    expect(res.body.emails[0].id).toBe('b1000000-0000-4000-8000-000000000001');
  });

  it('reads exactly the held messages the Needs review scope allows, newest first, one page at a time', async () => {
    mockAuthAs('admin');
    p.email.count.mockResolvedValue(1);
    const res = await request(app).get('/api/communication/emails/unmatched?limit=20&offset=40').set(authHeader('admin'));

    const query = p.email.findMany.mock.calls[0][0];
    expect(query.where).toBe(listWhere);
    expect(query.orderBy).toEqual([{ ts: 'desc' }, { id: 'asc' }]);
    expect(query).toMatchObject({ skip: 40, take: 20 });
    expect(p.email.count.mock.calls[0][0].where).toBe(listWhere);
    expect(res.body).toMatchObject({ total: 1, limit: 20, offset: 40, selected: 'mine' });
  });

  it('says why each message is held', async () => {
    mockAuthAs('admin');
    p.email.count.mockResolvedValue(1);
    const res = await request(app).get('/api/communication/emails/unmatched').set(authHeader('admin'));

    expect(res.body.emails[0]).toMatchObject({ id: 'b1000000-0000-4000-8000-000000000001', reviewReason: 'sender_mismatch', reviewMailboxId: '33333333-3333-3333-3333-333333333333', linkTo: null });
  });

  it('marks a message sent to one of our reply addresses, so the screen can say what it is instead of printing the token', async () => {
    mockAuthAs('admin');
    p.email.count.mockResolvedValue(3);
    p.email.findMany.mockResolvedValue([
      inboundRow({ id: 'token', to: `${TOKEN}@${env.EMAIL_REPLY_DOMAIN}` }),
      inboundRow({ id: 'named', to: `Office <${TOKEN}@${env.EMAIL_REPLY_DOMAIN}>` }),
      inboundRow({ id: 'mailbox', to: 'dana.ops.acme@mail.example.test', review_reason: 'automatic' }),
    ]);
    const res = await request(app).get('/api/communication/emails/unmatched').set(authHeader('admin'));

    expect(res.body.emails.map((e: { id: string; toReplyAddress?: boolean }) => [e.id, e.toReplyAddress ?? false])).toEqual([
      ['token', true], ['named', true], ['mailbox', false],
    ]);
  });

  it('marks it on the one item a bell opens as well', async () => {
    mockAuthAs('admin');
    p.email.findFirst.mockResolvedValue(inboundRow({ to: `${TOKEN}@${env.EMAIL_REPLY_DOMAIN}` }));
    const res = await request(app).get('/api/communication/emails/unmatched/b1000000-0000-4000-8000-000000000001').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.email.toReplyAddress).toBe(true);
  });

  it('names the conversation a reply belongs to only when the person can reach it', async () => {
    mockAuthAs('admin');
    p.email.count.mockResolvedValue(2);
    p.email.findMany.mockResolvedValue([
      inboundRow({ id: 'a', review_thread_id: THREAD }),
      inboundRow({ id: 'b', review_thread_id: '99999999-9999-9999-9999-999999999999' }),
    ]);
    p.emailThread.findMany.mockResolvedValue([{ id: THREAD, emails: [{ subject: 'Your invoice' }] }]);
    const res = await request(app).get('/api/communication/emails/unmatched').set(authHeader('admin'));

    // The conversations are read inside the tenant and under the person's reach.
    expect(p.emailThread.findMany.mock.calls[0][0].where.AND).toEqual([{ id: { in: [THREAD, '99999999-9999-9999-9999-999999999999'] } }, { organization_id: ALPHA_ORG_ID }, reachWhere]);
    expect(res.body.emails.map((e: { linkTo: unknown }) => e.linkTo)).toEqual([{ threadId: THREAD, subject: 'Your invoice' }, null]);
  });

  it('does not collide with the /emails/:id param route', async () => {
    // A literal path registered after a param route on the same prefix is
    // swallowed by it - 'unmatched' would be read as an id.
    mockAuthAs('admin');
    await request(app).get('/api/communication/emails/unmatched').set(authHeader('admin'));

    expect(p.email.findMany).toHaveBeenCalled();
    expect(p.email.findFirst).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/communication/emails/:id/link', () => {
  beforeEach(() => {
    p.email.findFirst.mockResolvedValue(inboundRow());
    p.emailThread.findFirst.mockResolvedValue({ id: THREAD });
    p.replyToken.findUnique.mockResolvedValue({
      token: TOKEN,
      organization_id: ALPHA_ORG_ID,
      thread_id: THREAD,
      entity_type: null,
      entity_id: null,
      customer_id: null,
      expected_from: 'angel@example.com',
      created_by_user_id: null,
      expires_at: null,
      revoked_at: null,
    });
    p.email.updateMany.mockResolvedValue({ count: 1 });
  });

  const link = (body: object = {}, id = 'b1000000-0000-4000-8000-000000000001', as: 'admin' | 'technician' = 'admin') => {
    mockAuthAs(as);
    return request(app).patch(`/api/communication/emails/${id}/link`).set(authHeader(as)).send(body);
  };

  it('attaches the message to the conversation it was a reply to, when it names one', async () => {
    p.email.findFirst.mockResolvedValueOnce(inboundRow({ review_thread_id: THREAD, reply_token: null }));
    const res = await link();

    expect(res.status).toBe(200);
    expect(p.email.updateMany.mock.calls[0][0].data).toMatchObject({
      thread_id: THREAD, inbound_match: 'MATCHED', folder: 'inbox', review_reason: null, review_mailbox_id: null, review_thread_id: null,
    });
  });

  it('falls back to the thread its own token points at for a message held before conversations were recorded', async () => {
    const res = await link();

    expect(res.status).toBe(200);
    expect(p.email.updateMany.mock.calls[0][0].data.thread_id).toBe(THREAD);
  });

  it('reads the held message only through the Needs review scope', async () => {
    await link();
    expect(p.email.findFirst.mock.calls[0][0].where).toEqual({ AND: [{ id: 'b1000000-0000-4000-8000-000000000001' }, visibilityWhere] });
  });

  it('accepts an explicit thread_id, overriding the token', async () => {
    const explicit = '44444444-4444-4444-4444-444444444444';
    p.emailThread.findFirst.mockResolvedValue({ id: explicit });
    const res = await link({ thread_id: explicit });

    expect(res.status).toBe(200);
    expect(p.email.updateMany.mock.calls[0][0].data.thread_id).toBe(explicit);
  });

  it('resolves the conversation inside the tenant AND under the person\'s reach, never by id alone', async () => {
    const explicit = '55555555-5555-5555-5555-555555555555';
    p.emailThread.findFirst.mockResolvedValue(null); // another company's, or one they cannot open
    const res = await link({ thread_id: explicit });

    // Linking a customer's reply into a conversation the person cannot open would be a way to read it through the back door.
    expect(res.status).toBe(404);
    expect(p.emailThread.findFirst.mock.calls[0][0].where.AND).toEqual([{ id: explicit }, { organization_id: ALPHA_ORG_ID }, reachWhere]);
    expect(p.email.updateMany).not.toHaveBeenCalled();
  });

  it('404s for a message the person cannot see', async () => {
    p.email.findFirst.mockResolvedValue(null);
    const res = await link({}, 'other-org-row');

    expect(res.status).toBe(404);
    expect(p.email.updateMany).not.toHaveBeenCalled();
  });

  it('400s when there is no conversation to go to and none given', async () => {
    p.email.findFirst.mockResolvedValue(inboundRow({ reply_token: null }));
    const res = await link();

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('NO_REPLY_TOKEN');
    expect(p.email.updateMany).not.toHaveBeenCalled();
  });

  it('400s when the token no longer resolves a thread', async () => {
    p.replyToken.findUnique.mockResolvedValue(null);
    const res = await link();

    expect(res.status).toBe(400);
    expect(res.body.code).toBe('TOKEN_THREAD_GONE');
    expect(p.email.updateMany).not.toHaveBeenCalled();
  });

  it('answers 409 when somebody linked the message first', async () => {
    p.email.updateMany.mockResolvedValue({ count: 0 });
    const res = await link();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('ALREADY_LINKED');
  });

  it('records the sender verdict rather than erasing it', async () => {
    // Linking it by hand does not retroactively make a sender check pass: inbound_auth is left exactly as received so the
    // conversation can still show what was and was not proven.
    await link();
    expect(p.email.updateMany.mock.calls[0][0].data.inbound_auth).toBeUndefined();
  });

  it('is not reachable without Communication update', async () => {
    const res = await link({}, 'b1000000-0000-4000-8000-000000000001', 'technician');
    expect([403, 404]).toContain(res.status);
  });
});
