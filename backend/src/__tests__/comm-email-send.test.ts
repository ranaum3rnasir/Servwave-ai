// Email slice 7 - the Resend send path. POST /api/communication/emails is now
// multipart/form-data and every org (not just the demo org) gets a real send:
// dispatch through sendComposedEmail (routed through dispatchEmail's org
// email_sending_enabled kill switch + locked From header), and only on
// status==='sent' persist an Email row. A dispatch that was skipped or failed
// persists NOTHING - there is no more record-only demo branch.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

function sentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'row-9',
    account: 'user',
    from: { name: null, email: 'no-reply@mail.test.com' },
    to: 'angel@example.com',
    subject: 'Re: Quote',
    snippet: 'Sounds good.',
    body: ['Sounds good.'],
    body_html: null,
    at: '3:42 PM',
    ts: BigInt(1789000005000),
    unread: false,
    starred: false,
    folder: 'sent',
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
    direction: 'out',
    provider_message_id: 're_test_compose',
    delivery_status: 'SENT',
    customer: null,
    lead: null,
    vendor: null,
    organization_id: ALPHA_ORG_ID,
    ...overrides,
  };
}

function noIdentityMatches() {
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
}

async function sentDispatch(overrides: Record<string, unknown> = {}) {
  const { sendComposedEmail } = await import('../lib/email.js');
  (sendComposedEmail as any).mockResolvedValue({
    status: 'sent',
    providerMessageId: 're_test_compose',
    fromAddress: 'no-reply@mail.test.com',
    fromName: null,
    ...overrides,
  });
  return sendComposedEmail;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  noIdentityMatches();
});

describe('POST /api/communication/emails', () => {
  it('sends through sendComposedEmail and persists a real row on 201 for ANY org (no more demo-only branch)', async () => {
    mockAuthAs('admin');
    await sentDispatch();
    p.email.create.mockResolvedValue(sentRow());

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('subject', 'Re: Quote')
      .field('body', JSON.stringify(['Sounds good.']));

    expect(res.status).toBe(201);
    expect(res.body.email.id).toBe('row-9');
    expect(res.body.email.folder).toBe('sent');

    expect(p.email.create).toHaveBeenCalledTimes(1);
    const data = p.email.create.mock.calls[0][0].data;
    expect(data.to).toBe('angel@example.com');
    expect(data.subject).toBe('Re: Quote');
    expect(data.snippet).toBe('Sounds good.');
    expect(data.body).toEqual(['Sounds good.']);
    expect(data.folder).toBe('sent');
    expect(data.direction).toBe('out');
    expect(data.provider_message_id).toBe('re_test_compose');
    expect(data.delivery_status).toBe('SENT');
    // Every write stays tenant-stamped.
    expect(data.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('the organization row is never read for an is_demo check any more', async () => {
    mockAuthAs('admin');
    await sentDispatch();
    p.email.create.mockResolvedValue(sentRow());

    await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'x@y.z')
      .field('body', JSON.stringify(['hi']));

    expect(p.organization.findUnique).not.toHaveBeenCalled();
  });

  it('never lets a client mark its own mail as app-generated', async () => {
    // `emails.account === 'system'` means "the app sent this by itself". A
    // person composing in the app must not be able to claim it, so the column
    // is server-owned and `account` is not in sendEmailSchema at all.
    mockAuthAs('admin');
    await sentDispatch();
    p.email.create.mockResolvedValue(sentRow());

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['Hi']))
      .field('account', 'system');

    expect(res.status).toBe(201);
    const data = p.email.create.mock.calls[0][0].data;
    expect(data.account).not.toBe('system');
    expect(data.account).toBe('user');
  });

  it('dispatches with the caller org id', async () => {
    mockAuthAs('admin');
    const sendComposedEmail = await sentDispatch();
    p.email.create.mockResolvedValue(sentRow());

    await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('subject', 'Hi')
      .field('body', JSON.stringify(['line one', 'line two']));

    expect(sendComposedEmail).toHaveBeenCalledTimes(1);
    const args = (sendComposedEmail as any).mock.calls[0][0];
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.to).toBe('angel@example.com');
    expect(args.subject).toBe('Hi');
    // Paragraph array joined back into one text body for the actual send.
    expect(args.text).toBe('line one\n\nline two');
  });

  it('persists cc/bcc directly on the row when submitted', async () => {
    mockAuthAs('admin');
    await sentDispatch();
    p.email.create.mockResolvedValue(sentRow({ cc: 'cc@example.com', bcc: 'bcc@example.com' }));

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('cc', 'cc@example.com')
      .field('bcc', 'bcc@example.com')
      .field('body', JSON.stringify(['hi']));

    expect(res.status).toBe(201);
    // Returned to the caller, not just persisted - a client rendering the
    // response straight into the Sent view must see the cc/bcc it just sent.
    expect(res.body.email.cc).toBe('cc@example.com');
    expect(res.body.email.bcc).toBe('bcc@example.com');
    const data = p.email.create.mock.calls[0][0].data;
    expect(data.cc).toBe('cc@example.com');
    expect(data.bcc).toBe('bcc@example.com');

    const sendComposedEmail = (await import('../lib/email.js')).sendComposedEmail as any;
    expect(sendComposedEmail.mock.calls[0][0].cc).toBe('cc@example.com');
    expect(sendComposedEmail.mock.calls[0][0].bcc).toBe('bcc@example.com');
  });

  // SECURITY: body_html is re-exposed to every org member who can see the
  // thread via mapEmail's `bodyHtml`, and InboxPage.tsx renders it straight
  // through dangerouslySetInnerHTML with no client-side sanitizer (see that
  // file's own comment). Storing it unsanitized is a stored-XSS hole any
  // Communication-create grant (every role, unconditionally) could exploit
  // against an admin who later opens the thread.
  it('sanitizes body_html before both dispatching and persisting it (stored XSS hardening)', async () => {
    mockAuthAs('admin');
    const sendComposedEmail = await sentDispatch();
    p.email.create.mockResolvedValue(sentRow());

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['hi']))
      .field('body_html', '<p>Hi</p><script>alert(1)</script><div onclick="evil()">bye</div>');

    expect(res.status).toBe(201);
    const data = p.email.create.mock.calls[0][0].data;
    expect(data.body_html).not.toContain('<script');
    expect(data.body_html).not.toContain('alert(1)');
    expect(data.body_html).not.toContain('onclick');
    expect(data.body_html).toContain('<p>Hi</p>');
    expect(data.body_html).toContain('bye');

    // The SAME sanitized value is what actually goes out - what the Sent view
    // renders back must match what was really dispatched.
    expect((sendComposedEmail as any).mock.calls[0][0].html).toBe(data.body_html);
  });

  it('409s and persists nothing when the org kill switch skipped the send', async () => {
    mockAuthAs('admin');
    await sentDispatch({ status: 'skipped', reason: 'org_disabled', providerMessageId: undefined, fromAddress: undefined, fromName: undefined });
    // Override with the exact skipped shape (no sent fields at all).
    const { sendComposedEmail } = await import('../lib/email.js');
    (sendComposedEmail as any).mockResolvedValue({ status: 'skipped', reason: 'org_disabled' });

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['hi']));

    expect(res.status).toBe(409);
    expect(p.email.create).not.toHaveBeenCalled();
  });

  it('502s and persists nothing when Resend is not configured', async () => {
    mockAuthAs('admin');
    const { sendComposedEmail } = await import('../lib/email.js');
    (sendComposedEmail as any).mockResolvedValue({ status: 'skipped', reason: 'no_api_key' });

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['hi']));

    expect(res.status).toBe(502);
    expect(p.email.create).not.toHaveBeenCalled();
  });

  it('502s and persists nothing when Resend rejects the message', async () => {
    mockAuthAs('admin');
    const { sendComposedEmail } = await import('../lib/email.js');
    (sendComposedEmail as any).mockResolvedValue({ status: 'failed', error: 'domain not verified' });

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['hi']));

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('domain not verified');
    expect(p.email.create).not.toHaveBeenCalled();
  });

  it('400s without a recipient (before dispatch is ever called)', async () => {
    mockAuthAs('admin');
    const { sendComposedEmail } = await import('../lib/email.js');

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('subject', 'Hi')
      .field('body', JSON.stringify(['Hello']));

    expect(res.status).toBe(400);
    expect(p.email.create).not.toHaveBeenCalled();
    expect(sendComposedEmail).not.toHaveBeenCalled();
  });

  it('404s a job_id the caller cannot see, before ever dispatching', async () => {
    mockAuthAs('admin');
    p.job.findUnique.mockResolvedValue(null);
    const { sendComposedEmail } = await import('../lib/email.js');

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('job_id', '11111111-1111-1111-1111-111111111111')
      .field('body', JSON.stringify(['hi']));

    expect(res.status).toBe(404);
    expect(sendComposedEmail).not.toHaveBeenCalled();
  });

  it('stamps job attribution onto the persisted row when job_id is given and visible', async () => {
    mockAuthAs('admin');
    const jobId = '11111111-1111-1111-1111-111111111112';
    p.job.findUnique.mockResolvedValue({ id: jobId, job_number: 'J00001' });
    await sentDispatch();
    p.email.create.mockResolvedValue(sentRow({ job_id: jobId, job_label: 'J00001' }));

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('job_id', jobId)
      .field('body', JSON.stringify(['hi']));

    expect(res.status).toBe(201);
    const data = p.email.create.mock.calls[0][0].data;
    expect(data.job_id).toBe(jobId);
    expect(data.job_label).toBe('J00001');
  });
});

// Email slice 8c REWRITE: markThreadRead no longer flips the shared
// Email.unread column (updateMany) - it upserts a per-caller EmailReadState
// row for every visible message in the thread. Full coverage (per-user
// isolation, the core regression test for the bug this rewrite fixes) lives
// in email-thread-readstate.test.ts; this block just keeps the basic
// happy/400 contract green here alongside the rest of the send-path suite.
describe('PATCH /api/communication/emails/thread-read', () => {
  it('marks every visible message in the thread read for the CALLING user only', async () => {
    mockAuthAs('admin');
    p.email.findMany.mockResolvedValue([{ id: 'e1' }, { id: 'e2' }, { id: 'e3' }]);
    p.emailReadState.createMany.mockResolvedValue({ count: 3 });

    const res = await request(app)
      .patch('/api/communication/emails/thread-read')
      .set(authHeader('admin'))
      .send({ thread_id: 'a9999999-9999-4999-8999-999999999999' });

    expect(res.status).toBe(200);
    expect(res.body.updated).toBe(3);
    const findArgs = p.email.findMany.mock.calls[0][0];
    expect(findArgs.where).toMatchObject({
      organization_id: ALPHA_ORG_ID,
      thread_id: 'a9999999-9999-4999-8999-999999999999',
    });
    const createArgs = p.emailReadState.createMany.mock.calls[0][0];
    expect(createArgs.data).toEqual([
      { email_id: 'e1', user_id: expect.any(String), read_at: expect.any(Date), organization_id: ALPHA_ORG_ID },
      { email_id: 'e2', user_id: expect.any(String), read_at: expect.any(Date), organization_id: ALPHA_ORG_ID },
      { email_id: 'e3', user_id: expect.any(String), read_at: expect.any(Date), organization_id: ALPHA_ORG_ID },
    ]);
    expect(createArgs.skipDuplicates).toBe(true);
  });

  it('400s without a thread_id', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .patch('/api/communication/emails/thread-read')
      .set(authHeader('admin'))
      .send({});
    expect(res.status).toBe(400);
  });
});
