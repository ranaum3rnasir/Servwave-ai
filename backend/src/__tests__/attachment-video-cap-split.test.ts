/**
 * The two video caps are DIFFERENT NUMBERS, and that difference is load-bearing.
 *
 * Raising video to 512MB is only safe because the bytes never enter this process: the browser
 * sends them straight at storage in resumable chunks and the app server mints a scoped URL and
 * then verifies the landed object. The multipart proxy handler has the opposite property — its
 * multer uses `memoryStorage()`, so the whole file sits in `file.buffer` before the handler
 * runs — against an instance documented at 512MB of memory. A single shared constant would
 * have told the proxy to accept a 512MB file into that heap.
 *
 * So the split is the whole safety argument, and this file is the thing that makes it fail if
 * someone collapses it back into one constant. Both halves are asserted from the SAME file, at
 * the boundary, through the real routes: one constant serving both paths cannot make both of
 * these pass.
 *
 * The sizes are derived from the constants rather than typed, so the pair keeps testing the
 * boundary when either cap moves. Only the proxy side allocates real buffers (50MB, which
 * supertest must actually send); the direct side declares its size in JSON and allocates
 * nothing, which is precisely the property under test.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { mockAuthAs, authHeader, CUSTOMER_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import {
  MAX_VIDEO_FILE_SIZE,
  MAX_PROXY_VIDEO_FILE_SIZE,
} from '../controllers/attachment.controller';
import { sizeLimitLabel } from '../middleware/multerErrors';

const mockPrisma = prisma as unknown as Record<string, any>;

const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  upload: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  createSignedUploadUrl: ReturnType<typeof vi.fn>;
};

const JOB_ID = 'j0000000-0000-0000-0000-0000000000d1';

/** An ISO-BMFF buffer that sniffs as video/mp4: 'ftyp' at 4-7, brand 'isom' at 8-11. */
function mp4Buf(size: number): Buffer {
  const b = Buffer.alloc(size);
  b.write('ftyp', 4, 'latin1');
  b.write('isom', 8, 'latin1');
  return b;
}

function postProxy(buf: Buffer) {
  return request(app)
    .post(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}`)
    .set(authHeader('admin'))
    .field('display_name', 'walkthrough clip')
    .field('description', '')
    .attach('file', buf, { filename: 'clip.mp4', contentType: 'video/mp4' });
}

function mintDirect(fileSize: number) {
  return request(app)
    .post(`/api/attachments/job/${JOB_ID}/direct-upload`)
    .set(authHeader('admin'))
    .send({ file_name: 'walkthrough.mp4', content_type: 'video/mp4', file_size: fileSize });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
  mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_ID });
  mockPrisma.attachment.aggregate.mockResolvedValue({ _sum: { file_size: 0 } });
  storage.createSignedUploadUrl.mockImplementation(async (path: string) => ({
    data: { signedUrl: `https://storage.test/${path}?token=t`, token: 't', path },
    error: null,
  }));
});

describe('the video cap is split between the two transports', () => {
  it('holds the two constants apart — one shared number is the bug this file exists to catch', () => {
    expect(MAX_VIDEO_FILE_SIZE).toBe(512 * 1024 * 1024);
    expect(MAX_PROXY_VIDEO_FILE_SIZE).toBe(50 * 1024 * 1024);
    expect(MAX_PROXY_VIDEO_FILE_SIZE).toBeLessThan(MAX_VIDEO_FILE_SIZE);
  });

  // ─── the buffering path stays at 50MB ──────────────────────────────────────

  it('the proxy handler still accepts a video at exactly its own cap', async () => {
    const res = await postProxy(mp4Buf(MAX_PROXY_VIDEO_FILE_SIZE));

    expect(res.status).toBe(201);
    expect(storage.upload).toHaveBeenCalled();
  });

  it('the proxy handler refuses a video one byte over its own cap', async () => {
    const res = await postProxy(mp4Buf(MAX_PROXY_VIDEO_FILE_SIZE + 1));

    expect(res.status).toBe(400);
    // Quotes the PROXY cap. If this handler ever reads MAX_VIDEO_FILE_SIZE again it would
    // either accept the file (the OOM) or promise 512MB while refusing at 50MB (the lie).
    expect(res.body.error).toBe(
      `File too large. Maximum: ${sizeLimitLabel(MAX_PROXY_VIDEO_FILE_SIZE)}`,
    );
    expect(res.body.error).not.toContain(sizeLimitLabel(MAX_VIDEO_FILE_SIZE));
    expect(storage.upload).not.toHaveBeenCalled();
  });

  // ─── the direct path goes to 512MB ─────────────────────────────────────────

  it('the direct path mints a URL for a video far past the proxy cap', async () => {
    const res = await mintDirect(MAX_PROXY_VIDEO_FILE_SIZE + 1);

    expect(res.status).toBe(201);
    expect(res.body.upload.path).toContain(`${ALPHA_ORG_ID}/job/${JOB_ID}/`);
    // Nothing was carried by this process: the mint call hands back a scoped URL only.
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('the direct path mints a URL for a video at exactly 512MB', async () => {
    const res = await mintDirect(MAX_VIDEO_FILE_SIZE);

    expect(res.status).toBe(201);
    expect(storage.createSignedUploadUrl).toHaveBeenCalledTimes(1);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('the direct path refuses one byte past 512MB, before any byte moves', async () => {
    const res = await mintDirect(MAX_VIDEO_FILE_SIZE + 1);

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`File too large. Maximum: ${sizeLimitLabel(MAX_VIDEO_FILE_SIZE)}`);
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });
});
