/**
 * A rejected upload has to say WHY (#1605).
 *
 * The .docx outage was invisible from the client: the app-side allow-list, the magic-byte sniff
 * and the size caps all passed, Supabase Storage rejected the object on the bucket's OWN
 * allowed_mime_types, and the handler logged that reason and replaced it with a blanket
 * `500 { error: 'Failed to upload file' }`. Winston is console-only, so on Render the reason was
 * gone. The only way anyone found it was reading the storage logs in the Supabase dashboard.
 *
 * These lock in that the rejection gets a status that reflects what actually happened, that its
 * reason is logged (the response carries ServWave copy only - see below), and that a failed DB
 * insert does not leave the object orphaned in the bucket.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';
import { mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';

const mockPrisma = prisma as unknown as {
  customer: { findUnique: ReturnType<typeof vi.fn> };
  attachment: { aggregate: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
};

const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  upload: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

function jpegBuf(size = 1024): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
}

function upload() {
  return request(app)
    .post(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}`)
    .set(authHeader('admin'))
    .field('display_name', 'evaluation')
    .field('description', '')
    .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });
}

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
  mockPrisma.attachment.aggregate.mockResolvedValue({ _sum: { file_size: 0 } });
  storage.upload.mockResolvedValue({ data: { path: 'test/file.jpg' }, error: null });
  storage.remove.mockResolvedValue({ data: null, error: null });
});

/**
 * The reason is logged, never shown. CLAUDE.md: an error that reaches the UI through
 * extractApiError is user-visible copy, and the storage service's own sentence can name the
 * vendor, the bucket and the object path. So the RESPONSE carries ServWave copy - specific
 * where the user can act on it, generic otherwise - and the storage service's text goes only to
 * the server log, which is where #1605's diagnosis needs it.
 */
const PROVIDER_ERRORS = [
  { statusCode: '400', error: 'invalid_mime_type', message: 'mime type application/vnd.openxmlformats-officedocument.wordprocessingml.document is not supported' },
  { statusCode: '413', error: 'Payload too large', message: 'The object exceeded the maximum allowed size' },
  { statusCode: '409', error: 'Duplicate', message: 'The resource already exists' },
  { statusCode: '500', error: 'InternalError', message: 'upstream unavailable' },
  { statusCode: '501', error: 'Not Implemented', message: 'supabase storage: POST /storage/v1/object/attachments/org-1/customer/c-1/1790-a.jpg not implemented' },
  { statusCode: '403', error: 'Unauthorized', message: 'new row violates row-level security policy for table "objects"' },
];

function rawFragments(err: { error: string; message: string }): string[] {
  return [err.message, err.error, 'supabase', 'storage/v1', 'bucket', 'attachments/', 'Storage rejected'];
}

describe('storage rejections reach the client as ServWave copy', () => {
  it('reports a bucket mime rejection as 415, in plain words', async () => {
    storage.upload.mockResolvedValue({ data: null, error: PROVIDER_ERRORS[0] });

    const res = await upload();

    expect(res.status).toBe(415);
    expect(res.body.error).toBe("This file type couldn't be saved. Try saving it as a PDF, or contact support.");
  });

  it('reports an over-size storage rejection as 413, in plain words', async () => {
    storage.upload.mockResolvedValue({ data: null, error: PROVIDER_ERRORS[1] });

    const res = await upload();

    expect(res.status).toBe(413);
    expect(res.body.error).toBe('This file is too large to save. Try a smaller file, or contact support to send it another way.');
  });

  it('reports a duplicate object as 409, with the generic retry sentence', async () => {
    storage.upload.mockResolvedValue({ data: null, error: PROVIDER_ERRORS[2] });

    const res = await upload();

    expect(res.status).toBe(409);
    expect(res.body.error).toBe("The file couldn't be saved. Please try again.");
  });

  it('reports anything else as 502 rather than a bare 500, with the generic retry sentence', async () => {
    storage.upload.mockResolvedValue({ data: null, error: PROVIDER_ERRORS[3] });

    const res = await upload();

    expect(res.status).toBe(502);
    expect(res.body.error).toBe("The file couldn't be saved. Please try again.");
  });

  it.each(PROVIDER_ERRORS)('never repeats the storage service\'s own text ($error)', async (providerError) => {
    storage.upload.mockResolvedValue({ data: null, error: providerError });

    const res = await upload();

    const body = JSON.stringify(res.body).toLowerCase();
    for (const fragment of rawFragments(providerError)) {
      expect(body).not.toContain(fragment.toLowerCase());
    }
  });

  it('keeps the storage service\'s reason in the server log', async () => {
    storage.upload.mockResolvedValue({ data: null, error: PROVIDER_ERRORS[0] });

    await upload();

    expect(logger.error).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({ storageMessage: PROVIDER_ERRORS[0].message, status: 415 }),
    );
  });

  it('removes the uploaded object when the row insert fails, instead of orphaning it', async () => {
    mockPrisma.attachment.create.mockRejectedValue(new Error('db down'));

    const res = await upload();

    expect(res.status).toBe(500);
    expect(storage.remove).toHaveBeenCalledWith([expect.stringContaining('/customer/')]);
  });
});
