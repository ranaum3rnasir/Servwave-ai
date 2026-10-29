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
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const THREAD = '22222222-2222-2222-2222-222222222222';
const TOKEN = 'v1jSzARGWhcIuV_cVcbJEw';

function inboundRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'inbound-1',
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
    expect(res.body.emails[0].id).toBe('inbound-1');
  });

  it('queries only for rows we refused to attach', async () => {
    mockAuthAs('admin');
    await request(app).get('/api/communication/emails/unmatched').set(authHeader('admin'));

    const where = p.email.findMany.mock.calls[0][0].where;
    expect(where.inbound_match).toEqual({ in: ['UNMATCHED_SENDER', 'UNMATCHED_NO_TOKEN'] });
    // Tenant-stamped like every other read. The queue renders message bodies,
    // so an unscoped query hands over another org's mail outright.
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('scopes a technician to the rows they can already see', async () => {
    // Technicians DO hold Communication read (backfilled by migration
    // 20260804210000) - the boundary is row scope, not the endpoint. Unmatched
    // mail carries no job anchor, so their scope filters it out rather than the
    // route refusing them.
    mockAuthAs('technician');
    const res = await request(app)
      .get('/api/communication/emails/unmatched')
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    const where = p.email.findMany.mock.calls[0][0].where;
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    // The anchor-inherited scope fragment (slice 8a) is present, so this is not
    // an org-wide read wearing a tenant stamp.
    expect(Object.keys(where).length).toBeGreaterThan(2);
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
    p.email.update.mockResolvedValue(inboundRow({ thread_id: THREAD, inbound_match: 'MATCHED' }));
  });

  it('attaches the message to the thread its own token points at', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch('/api/communication/emails/inbound-1/link')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expect(p.email.update.mock.calls[0][0].data).toMatchObject({
      thread_id: THREAD,
      inbound_match: 'MATCHED',
    });
  });

  it('accepts an explicit thread_id, overriding the token', async () => {
    mockAuthAs('admin');
    p.emailThread.findFirst.mockResolvedValue({ id: '44444444-4444-4444-4444-444444444444', organization_id: ALPHA_ORG_ID });

    const res = await request(app)
      .patch('/api/communication/emails/inbound-1/link')
      .set(authHeader('admin'))
      .send({ thread_id: '44444444-4444-4444-4444-444444444444' });

    expect(res.status).toBe(200);
    expect(p.email.update.mock.calls[0][0].data.thread_id).toBe('44444444-4444-4444-4444-444444444444');
  });

  it('resolves an explicit thread inside the tenant, never by id alone', async () => {
    mockAuthAs('admin');
    p.emailThread.findFirst.mockResolvedValue(null); // another org's thread

    const res = await request(app)
      .patch('/api/communication/emails/inbound-1/link')
      .set(authHeader('admin'))
      .send({ thread_id: '55555555-5555-5555-5555-555555555555' });

    // Linking a customer's reply into another tenant's conversation would be a
    // cross-tenant write AND a disclosure of the message body.
    expect(res.status).toBe(404);
    expect(p.email.update).not.toHaveBeenCalled();
  });

  it('404s for an email outside the tenant', async () => {
    mockAuthAs('admin');
    p.email.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/communication/emails/other-org-row/link')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(404);
    expect(p.email.update).not.toHaveBeenCalled();
  });

  it('400s when there is no token to fall back on and no thread given', async () => {
    mockAuthAs('admin');
    p.email.findFirst.mockResolvedValue(inboundRow({ reply_token: null }));

    const res = await request(app)
      .patch('/api/communication/emails/inbound-1/link')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
    expect(p.email.update).not.toHaveBeenCalled();
  });

  it('400s when the token no longer resolves a thread', async () => {
    mockAuthAs('admin');
    p.replyToken.findUnique.mockResolvedValue(null);

    const res = await request(app)
      .patch('/api/communication/emails/inbound-1/link')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(400);
    expect(p.email.update).not.toHaveBeenCalled();
  });

  it('records the sender verdict rather than erasing it', async () => {
    // The operator linked it by hand; that does not retroactively make DMARC
    // pass. inbound_auth is left exactly as received so the thread can still
    // show what was and was not proven.
    mockAuthAs('admin');

    await request(app)
      .patch('/api/communication/emails/inbound-1/link')
      .set(authHeader('admin'))
      .send({});

    expect(p.email.update.mock.calls[0][0].data.inbound_auth).toBeUndefined();
  });

  it('is not reachable without Communication update', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .patch('/api/communication/emails/inbound-1/link')
      .set(authHeader('technician'))
      .send({});

    expect([403, 404]).toContain(res.status);
  });
});
