// Email slice 7 - real file attachments on a compose-window send.
//
// POST /api/communication/emails is multipart/form-data; files ride under the
// `files` field (multer.memoryStorage, reused ALLOWED_MIME_TYPES + sniff from
// attachment.controller.ts). On a real send, each file uploads into the shared
// `attachments` Supabase bucket at `${orgId}/email/${emailId}/${ts}-${name}`
// and gets its own EmailAttachment row. A dispatch that never sent persists
// NOTHING - no email row, no uploads, no attachment rows.
//
// GET /api/communication/emails/:id/attachments/:index mints a fresh signed
// URL for one attachment (never persisted), mirroring
// GET /api/communication/calls/:id/recording's { url } contract exactly.
//
// GET /api/communication/emails/attach-source?job_id=... reuses the generic
// Attachment model + attachment.controller.ts's own signed-url minting so a
// compose window can pull in a file already uploaded elsewhere on the record.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ORG_B_ID, TEST_USERS } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

// setup.ts's storage.from is a mockReturnValue of ONE shared object per bucket call.
const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  upload: ReturnType<typeof vi.fn>;
  createSignedUrl: ReturnType<typeof vi.fn>;
};

// ─── magic-byte fixtures (file-sniff.ts contract) ────────────────────────────
function jpegBuf(size = 1024): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
}
const pdfBuf = () => Buffer.from('%PDF-1.4\n');

function sentRow(overrides: Record<string, unknown> = {}) {
  return {
    id: 'email-1',
    account: 'user',
    from: { name: null, email: 'no-reply@mail.test.com' },
    to: 'angel@example.com',
    subject: 'Photos',
    snippet: 'See attached',
    body: ['See attached'],
    body_html: null,
    at: '3:42 PM',
    ts: BigInt(1789000005000),
    unread: false,
    starred: false,
    folder: 'sent',
    labels: null,
    has_attachment: true,
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

async function sentDispatch() {
  const { sendComposedEmail } = await import('../lib/email.js');
  (sendComposedEmail as any).mockResolvedValue({
    status: 'sent',
    providerMessageId: 're_test_compose',
    fromAddress: 'no-reply@mail.test.com',
    fromName: null,
  });
  return sendComposedEmail;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  storage.upload.mockResolvedValue({ data: { path: 'ignored' }, error: null });
  storage.createSignedUrl.mockResolvedValue({
    data: { signedUrl: 'https://test.supabase.co/storage/v1/object/sign/attachments/mock?token=mock' },
    error: null,
  });
  p.emailAttachment.create.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: `att-${(args.data as any).position}`, ...args.data }),
  );
});

describe('POST /api/communication/emails (attachments)', () => {
  it('uploads a valid file, persists an EmailAttachment row, and dispatches the buffer to Resend', async () => {
    mockAuthAs('admin');
    const sendComposedEmail = await sentDispatch();
    p.email.create.mockResolvedValue(sentRow());

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('subject', 'Photos')
      .field('body', JSON.stringify(['See attached']))
      .attach('files', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);

    // The email row is created BEFORE the upload (storage_path needs its id).
    const emailData = p.email.create.mock.calls[0][0].data;
    expect(emailData.has_attachment).toBe(true);

    // Dispatch carries the raw buffer straight through - no extra fetch.
    const dispatchArgs = (sendComposedEmail as any).mock.calls[0][0];
    expect(dispatchArgs.attachments).toHaveLength(1);
    expect(dispatchArgs.attachments[0].filename).toBe('a.jpg');
    expect(Buffer.isBuffer(dispatchArgs.attachments[0].content)).toBe(true);

    expect(p.emailAttachment.create).toHaveBeenCalledTimes(1);
    const attData = p.emailAttachment.create.mock.calls[0][0].data;
    expect(attData.email_id).toBe('email-1');
    expect(attData.file_name).toBe('a.jpg');
    expect(attData.content_type).toBe('image/jpeg');
    expect(attData.position).toBe(0);
    expect(attData.organization_id).toBe(ALPHA_ORG_ID);
    expect(attData.storage_path).toMatch(new RegExp(`^${ALPHA_ORG_ID}/email/email-1/\\d+-a\\.jpg$`));

    expect(storage.upload).toHaveBeenCalledTimes(1);
    expect(storage.upload.mock.calls[0][0]).toBe(attData.storage_path);
  });

  it('assigns sequential positions across multiple files', async () => {
    mockAuthAs('admin');
    await sentDispatch();
    p.email.create.mockResolvedValue(sentRow());

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['hi']))
      .attach('files', jpegBuf(), { filename: 'one.jpg', contentType: 'image/jpeg' })
      .attach('files', pdfBuf(), { filename: 'two.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(201);
    expect(p.emailAttachment.create).toHaveBeenCalledTimes(2);
    expect(p.emailAttachment.create.mock.calls[0][0].data.position).toBe(0);
    expect(p.emailAttachment.create.mock.calls[0][0].data.file_name).toBe('one.jpg');
    expect(p.emailAttachment.create.mock.calls[1][0].data.position).toBe(1);
    expect(p.emailAttachment.create.mock.calls[1][0].data.file_name).toBe('two.pdf');
  });

  it('400s a file whose content does not match its declared type, before ever dispatching', async () => {
    mockAuthAs('admin');
    const sendComposedEmail = await sentDispatch();

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['hi']))
      // PNG bytes declared as image/jpeg - sniff must disagree and reject.
      .attach('files', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0]), {
        filename: 'sneaky.jpg',
        contentType: 'image/jpeg',
      });

    expect(res.status).toBe(400);
    expect(sendComposedEmail).not.toHaveBeenCalled();
    expect(p.email.create).not.toHaveBeenCalled();
    expect(p.emailAttachment.create).not.toHaveBeenCalled();
  });

  // text/plain used to be the example here. It is on the allowlist now (office-documents
  // slice), so the case moved to an executable, which no widening should ever admit.
  it('400s a disallowed declared mime type', async () => {
    mockAuthAs('admin');
    const sendComposedEmail = await sentDispatch();

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['hi']))
      .attach('files', Buffer.from('MZ '), { filename: 'setup.exe', contentType: 'application/x-msdownload' });

    expect(res.status).toBe(400);
    expect(sendComposedEmail).not.toHaveBeenCalled();
  });

  it('accepts a CSV attachment now that documents are on the allowlist', async () => {
    mockAuthAs('admin');
    const sendComposedEmail = await sentDispatch();

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['hi']))
      .attach('files', Buffer.from('name,qty\nfilter,2\n'), { filename: 'parts.csv', contentType: 'text/csv' });

    expect(res.status).toBe(201);
    expect(sendComposedEmail).toHaveBeenCalled();
  });

  it('does not persist anything for a dispatch the org kill switch skipped, even with files attached', async () => {
    mockAuthAs('admin');
    const { sendComposedEmail } = await import('../lib/email.js');
    (sendComposedEmail as any).mockResolvedValue({ status: 'skipped', reason: 'org_disabled' });

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['hi']))
      .attach('files', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(409);
    expect(p.email.create).not.toHaveBeenCalled();
    expect(p.emailAttachment.create).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('keeps the send a 201 when a storage upload fails - the email already sent, only that file is skipped', async () => {
    mockAuthAs('admin');
    await sentDispatch();
    p.email.create.mockResolvedValue(sentRow());
    storage.upload.mockResolvedValueOnce({ data: null, error: { message: 'network blip' } });

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('body', JSON.stringify(['hi']))
      .attach('files', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(p.emailAttachment.create).not.toHaveBeenCalled();
  });
});

describe('GET /api/communication/emails/:id/attachments/:index', () => {
  it('mints a fresh signed url for a valid index', async () => {
    mockAuthAs('admin');
    p.email.findFirst.mockResolvedValue({ id: 'email-1' });
    p.emailAttachment.findMany.mockResolvedValue([
      { id: 'att-0', storage_path: `${ALPHA_ORG_ID}/email/email-1/1-a.jpg`, position: 0 },
      { id: 'att-1', storage_path: `${ALPHA_ORG_ID}/email/email-1/2-b.pdf`, position: 1 },
    ]);

    const res = await request(app)
      .get('/api/communication/emails/email-1/attachments/1')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.url).toBe('https://test.supabase.co/storage/v1/object/sign/attachments/mock?token=mock');
    expect(storage.createSignedUrl).toHaveBeenCalledWith(`${ALPHA_ORG_ID}/email/email-1/2-b.pdf`, expect.any(Number));
  });

  it('404s when the email is not found or not visible to the caller', async () => {
    mockAuthAs('admin');
    p.email.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .get('/api/communication/emails/email-1/attachments/0')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });

  // Not just "404 on a bare null mock" - proves organization_id is actually
  // IN the where clause, so this would fail if tenantWhere were ever dropped
  // from the row lookup (mirrors ctm-recordings.test.ts's playback-endpoint
  // cross-tenant test for the sibling GET .../recording route).
  it("404s for another org's email id (tenantWhere keeps org B out)", async () => {
    mockAuthAs('orgB_admin');
    p.email.findFirst.mockResolvedValue(null); // row invisible under org B scoping

    const res = await request(app)
      .get('/api/communication/emails/email-1/attachments/0')
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    expect(p.email.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'email-1', organization_id: ORG_B_ID }),
      }),
    );
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
  });

  it('404s an out-of-range index instead of 500ing', async () => {
    mockAuthAs('admin');
    p.email.findFirst.mockResolvedValue({ id: 'email-1' });
    p.emailAttachment.findMany.mockResolvedValue([{ id: 'att-0', storage_path: 'p', position: 0 }]);

    const res = await request(app)
      .get('/api/communication/emails/email-1/attachments/5')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
  });
});

describe('GET /api/communication/emails/attach-source', () => {
  it('lists an existing job attachment with a freshly-signed url', async () => {
    mockAuthAs('admin');
    // ADMIN's checkEntityAccess branch falls through to checkEntityExists,
    // which reads the job row directly - org isolation, not a permission
    // grant, is what ADMIN/DISPATCHER are gated on.
    p.job.findUnique.mockResolvedValue({ id: 'job-1' });
    p.attachment.findMany.mockResolvedValue([
      {
        id: 'a-1',
        file_name: 'permit.pdf',
        file_url: '',
        storage_path: 'org/job/job-1/1-permit.pdf',
        file_type: 'application/pdf',
        file_size: 1024,
        display_name: 'Permit',
        created_at: new Date('2026-01-01'),
      },
    ]);

    const res = await request(app)
      .get('/api/communication/emails/attach-source')
      .query({ job_id: 'job-1' })
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.attachments[0].file_url).toBe('https://test.supabase.co/storage/v1/object/sign/attachments/mock?token=mock');
    const args = p.attachment.findMany.mock.calls[0][0];
    expect(args.where.entity_type).toBe('JOB');
    expect(args.where.entity_id).toBe('job-1');
  });

  // SECURITY: without checkEntityAccess, this endpoint scoped only by
  // tenantWhere would let ANY in-org caller (technician included - `read
  // Communication` is an unconditional grant) mint signed download URLs for
  // attachments on a job they have no visibility into anywhere else in the
  // app. Same class of hole as the attachments/:index route above.
  it("403s a technician's lookup on a job they are not assigned to, and never queries Attachment", async () => {
    mockAuthAs('technician');
    // S8 (D6): checkEntityAccess asks "on one of its TRIPS" - `job_assignees` is gone.
    p.job.findUnique.mockResolvedValue({ visits: [{ assignees: [{ user_id: 'someone-else' }] }] });

    const res = await request(app)
      .get('/api/communication/emails/attach-source')
      .query({ job_id: 'job-1' })
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expect(p.attachment.findMany).not.toHaveBeenCalled();
  });

  it('200s a technician looking up a job they ARE assigned to', async () => {
    mockAuthAs('technician');
    p.job.findUnique.mockResolvedValue({ visits: [{ assignees: [{ user_id: TEST_USERS.technician.id }] }] });
    p.attachment.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get('/api/communication/emails/attach-source')
      .query({ job_id: 'job-1' })
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.attachments).toEqual([]);
  });

  it('400s when no recognized query param is given', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .get('/api/communication/emails/attach-source')
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(p.attachment.findMany).not.toHaveBeenCalled();
  });
});

// ─── multer limit reporting (the 10-attachment ceiling) ──────────────────────
//
// `.array('files', MAX_EMAIL_ATTACHMENTS)` alone does NOT make an over-count reportable as
// an over-count: that number is multer's own per-field tally and exceeding it raises
// LIMIT_UNEXPECTED_FILE, the code that means "a file arrived under a field I did not ask
// for". An 11th attachment was therefore answered 400 "That upload was not formed
// correctly" — true of a malformed body, false of this one, and it never told the sender
// the limit was 10. LIMIT_FILE_COUNT comes only from busboy's `filesLimit` event, which
// busboy emits only when `limits.files` is set, so the route now sets it.
describe('POST /api/communication/emails — multer count/size limits', () => {
  function sendWith(files: number) {
    let req = request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('subject', 'Photos')
      .field('body', JSON.stringify(['See attached']));
    for (let i = 0; i < files; i += 1) {
      req = req.attach('files', jpegBuf(), { filename: `a${i}.jpg`, contentType: 'image/jpeg' });
    }
    return req;
  }

  it('names the real 10-file ceiling when an 11th attachment arrives', async () => {
    mockAuthAs('admin');

    const res = await sendWith(11);

    expect(res.status).toBe(413);
    expect(res.status).not.toBe(500);
    expect(res.body.error).toBe('Too many files. You can attach up to 10 files at a time.');
    // The pre-fix answer: LIMIT_UNEXPECTED_FILE's "malformed" copy, which is both wrong
    // about the cause and silent about the limit.
    expect(res.body.error).not.toContain('not formed correctly');
    expect(res.body.error).not.toContain('Internal server error');
  });

  it('still accepts a send at exactly the 10-file ceiling', async () => {
    mockAuthAs('admin');
    const sendComposedEmail = await sentDispatch();
    p.email.create.mockResolvedValue(sentRow());

    const res = await sendWith(10);

    expect(res.status).toBe(201);
    expect((sendComposedEmail as any).mock.calls[0][0].attachments).toHaveLength(10);
  });

  it('still reports a file under an unexpected field name as malformed (400, not 413)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post('/api/communication/emails')
      .set(authHeader('admin'))
      .field('to', 'angel@example.com')
      .field('subject', 'Photos')
      .field('body', JSON.stringify(['See attached']))
      .attach('not_files', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('not formed correctly');
  });
});
