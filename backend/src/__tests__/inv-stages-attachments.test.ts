/**
 * inv-stages-attachments.test.ts — P5 §5: staging attachments → Supabase Storage
 *
 * First REAL persistence path for JobStageAttachment (the FE "upload" was
 * mock-era local state). New uploads: multer → withOrgContext → sniff →
 * per-kind caps → Storage upload OUTSIDE any $transaction → row with
 * data_url:'' + storage_path canonical. Read path: ONE batch createSignedUrls
 * call; legacy data-URI rows flow through untouched (no backfill). Delete:
 * best-effort SDK remove + row delete.
 *
 * Harness: supertest against app, prisma + supabase mocked (setup.ts).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, JOB_STAGE_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  jobStage: { findMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  jobStageAttachment: {
    findFirst: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
  };
  $transaction: ReturnType<typeof vi.fn>;
};

// setup.ts's storage.from is a mockReturnValue of ONE shared object — grab the handles.
const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  upload: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  createSignedUrls: ReturnType<typeof vi.fn>;
};

const STAGE_ID = JOB_STAGE_FIXTURE.id;
const ATT_ID = 'eeeeeeee-0000-0000-0000-000000000001';

// ─── magic-byte fixtures (file-sniff.ts contract) ────────────────────────────
function jpegBuf(size = 1024): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
}
function pngBuf(): Buffer {
  return Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
}
function mp4Buf(): Buffer {
  const b = Buffer.alloc(16);
  b.write('ftyp', 4, 'latin1');
  b.write('isom', 8, 'latin1');
  return b;
}
const pdfBuf = () => Buffer.from('%PDF-1.4\n');

function stagePhoto(over: Record<string, unknown> = {}) {
  return {
    id: 'pppppppp-0000-0000-0000-000000000001',
    job_stage_id: STAGE_ID,
    kind: 'image',
    data_url: 'data:image/png;base64,legacyAAA',
    storage_path: null,
    mime_type: 'image/png',
    caption: null,
    uploaded_at: new Date('2026-07-01T10:00:00Z'),
    uploaded_by: 'Legacy Uploader',
    source: null,
    pdf_page_number: null,
    pdf_file_name: null,
    duration_seconds: null,
    size_bytes: null,
    po_number: null,
    organization_id: ALPHA_ORG_ID,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.jobStage.findFirst.mockResolvedValue({ id: STAGE_ID });
  mockPrisma.jobStageAttachment.create.mockImplementation((args: { data: Record<string, unknown> }) =>
    Promise.resolve({ id: ATT_ID, ...args.data }),
  );
  mockPrisma.jobStageAttachment.delete.mockResolvedValue({});
});

// ═══ Upload ═══════════════════════════════════════════════════════════════════

describe('POST /api/inventory/job-stages/:id/attachments', () => {
  it('happy path: uploads to Storage, persists data_url:"" + storage_path canonical, 201 with a signed URL', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .post(`/api/inventory/job-stages/${STAGE_ID}/attachments`)
      .set(authHeader('admin'))
      .field('caption', 'Front door lockset')
      .field('source', 'camera')
      .attach('file', jpegBuf(), { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);

    // Storage got the bytes under the org-first key namespace
    const [path, buf, opts] = storage.upload.mock.calls[0];
    expect(path).toMatch(new RegExp(`^${ALPHA_ORG_ID}/job_stage/${STAGE_ID}/\\d+-photo\\.jpg$`));
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(opts).toEqual({ contentType: 'image/jpeg', upsert: false });

    // Row: data_url '' (storage_path is canonical), kind derived from mime
    const data = mockPrisma.jobStageAttachment.create.mock.calls[0][0].data;
    expect(data.job_stage_id).toBe(STAGE_ID);
    expect(data.data_url).toBe('');
    expect(data.storage_path).toBe(path);
    expect(data.kind).toBe('image');
    expect(data.mime_type).toBe('image/jpeg');
    expect(data.caption).toBe('Front door lockset');
    expect(data.source).toBe('camera');
    expect(data.size_bytes).toBe(1024);
    expect(data.uploaded_by).toBe('Test Admin');
    expect(data.organization_id).toBe(ALPHA_ORG_ID);

    // Response carries a freshly-minted signed URL, not the raw path
    expect(res.body.attachment.dataUrl).toContain('/object/sign/');
    expect(res.body.attachment.dataUrl).toContain(path);
  });

  it('uploads BEFORE the row insert and never inside a $transaction (orphaned object ok; row-without-object not)', async () => {
    mockAuthAs('admin');
    const order: string[] = [];
    storage.upload.mockImplementationOnce(async () => {
      order.push('storage');
      return { data: { path: 'x' }, error: null };
    });
    mockPrisma.jobStageAttachment.create.mockImplementationOnce(async (args: { data: Record<string, unknown> }) => {
      order.push('db');
      return { id: ATT_ID, ...args.data };
    });

    const res = await request(app)
      .post(`/api/inventory/job-stages/${STAGE_ID}/attachments`)
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(order).toEqual(['storage', 'db']);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('500s and writes NO row when the Storage upload fails', async () => {
    mockAuthAs('admin');
    storage.upload.mockResolvedValueOnce({ data: null, error: { message: 'denied' } });

    const res = await request(app)
      .post(`/api/inventory/job-stages/${STAGE_ID}/attachments`)
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(500);
    expect(mockPrisma.jobStageAttachment.create).not.toHaveBeenCalled();
  });

  it('404s a cross-org/missing stage (tenantWhere) before touching Storage', async () => {
    mockAuthAs('admin');
    mockPrisma.jobStage.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .post(`/api/inventory/job-stages/${STAGE_ID}/attachments`)
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(404);
    expect(mockPrisma.jobStage.findFirst.mock.calls[0][0].where.organization_id).toBe(ALPHA_ORG_ID);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('400s when no file part is present', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post(`/api/inventory/job-stages/${STAGE_ID}/attachments`)
      .set(authHeader('admin'))
      .field('caption', 'no file');
    expect(res.status).toBe(400);
  });

  it('400s a PDF — the dialog rasterizes PDFs client-side, the server never accepts one', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post(`/api/inventory/job-stages/${STAGE_ID}/attachments`)
      .set(authHeader('admin'))
      .attach('file', pdfBuf(), { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('400s on a magic-byte/declared-type mismatch (PNG bytes declared image/jpeg)', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post(`/api/inventory/job-stages/${STAGE_ID}/attachments`)
      .set(authHeader('admin'))
      .attach('file', pngBuf(), { filename: 'sneaky.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('400s an image over the 8MB per-kind cap (video cap rides the 100MB multer limit)', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post(`/api/inventory/job-stages/${STAGE_ID}/attachments`)
      .set(authHeader('admin'))
      .attach('file', jpegBuf(8 * 1024 * 1024 + 1), { filename: 'big.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('accepts a video with kind:"video" and the pdf-page metadata fields as integers', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post(`/api/inventory/job-stages/${STAGE_ID}/attachments`)
      .set(authHeader('admin'))
      .field('durationSeconds', '12')
      .field('pdfPageNumber', '3')
      .field('pdfFileName', 'packing-list.pdf')
      .field('source', 'pdf-page')
      .field('poNumber', 'PO-1001')
      .attach('file', mp4Buf(), { filename: 'clip.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(201);
    const data = mockPrisma.jobStageAttachment.create.mock.calls[0][0].data;
    expect(data.kind).toBe('video');
    expect(data.duration_seconds).toBe(12);
    expect(data.pdf_page_number).toBe(3);
    expect(data.pdf_file_name).toBe('packing-list.pdf');
    expect(data.source).toBe('pdf-page');
    expect(data.po_number).toBe('PO-1001');
  });
});

// ═══ Read path — both generations ═════════════════════════════════════════════

describe('stage read path — legacy data-URIs + signed Storage rows', () => {
  it('legacy row (data_url, null storage_path) round-trips dataUrl untouched; no sign call', async () => {
    mockAuthAs('admin');
    mockPrisma.jobStage.findMany.mockResolvedValue([
      { ...JOB_STAGE_FIXTURE, photos: [stagePhoto()] },
    ]);

    const res = await request(app).get('/api/inventory/job-stages').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.jobStages[0].photos[0].dataUrl).toBe('data:image/png;base64,legacyAAA');
    expect(storage.createSignedUrls).not.toHaveBeenCalled();
  });

  it('Storage row resolves dataUrl via ONE batch createSignedUrls call', async () => {
    mockAuthAs('admin');
    const path = `${ALPHA_ORG_ID}/job_stage/${STAGE_ID}/123-a.jpg`;
    mockPrisma.jobStage.findMany.mockResolvedValue([
      {
        ...JOB_STAGE_FIXTURE,
        photos: [
          stagePhoto(),
          stagePhoto({ id: 'pppppppp-0000-0000-0000-000000000002', data_url: '', storage_path: path }),
        ],
      },
    ]);

    const res = await request(app).get('/api/inventory/job-stages').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(storage.createSignedUrls).toHaveBeenCalledTimes(1);
    expect(storage.createSignedUrls.mock.calls[0][0]).toEqual([path]);
    const photos = res.body.jobStages[0].photos;
    expect(photos[0].dataUrl).toBe('data:image/png;base64,legacyAAA'); // legacy untouched
    expect(photos[1].dataUrl).toContain(`/object/sign/${path}`);
  });

  it('degrades to "" (not 500) when signing fails', async () => {
    mockAuthAs('admin');
    const path = `${ALPHA_ORG_ID}/job_stage/${STAGE_ID}/123-a.jpg`;
    storage.createSignedUrls.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });
    mockPrisma.jobStage.findMany.mockResolvedValue([
      { ...JOB_STAGE_FIXTURE, photos: [stagePhoto({ data_url: '', storage_path: path })] },
    ]);

    const res = await request(app).get('/api/inventory/job-stages').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.jobStages[0].photos[0].dataUrl).toBe('');
  });

  it('getJobStage signs too (single-stage path)', async () => {
    mockAuthAs('admin');
    const path = `${ALPHA_ORG_ID}/job_stage/${STAGE_ID}/456-b.jpg`;
    mockPrisma.jobStage.findFirst.mockResolvedValue({
      ...JOB_STAGE_FIXTURE,
      photos: [stagePhoto({ data_url: '', storage_path: path })],
    });

    const res = await request(app).get(`/api/inventory/job-stages/${STAGE_ID}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.jobStage.photos[0].dataUrl).toContain(`/object/sign/${path}`);
  });
});

// ═══ Delete ═══════════════════════════════════════════════════════════════════

describe('DELETE /api/inventory/job-stages/:id/attachments/:attachmentId', () => {
  it('removes the Storage object (SDK, best-effort) and deletes the row', async () => {
    mockAuthAs('admin');
    const path = `${ALPHA_ORG_ID}/job_stage/${STAGE_ID}/123-a.jpg`;
    mockPrisma.jobStageAttachment.findFirst.mockResolvedValue(stagePhoto({ id: ATT_ID, data_url: '', storage_path: path }));

    const res = await request(app)
      .delete(`/api/inventory/job-stages/${STAGE_ID}/attachments/${ATT_ID}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ success: true });
    expect(storage.remove).toHaveBeenCalledWith([path]);
    expect(mockPrisma.jobStageAttachment.delete).toHaveBeenCalledWith({ where: { id: ATT_ID } });
    // scoped lookup: attachment must belong to THIS stage and org
    const where = mockPrisma.jobStageAttachment.findFirst.mock.calls[0][0].where;
    expect(where).toMatchObject({ id: ATT_ID, job_stage_id: STAGE_ID, organization_id: ALPHA_ORG_ID });
  });

  it('still deletes the row when the Storage remove fails (log-warn, not 500)', async () => {
    mockAuthAs('admin');
    storage.remove.mockResolvedValueOnce({ data: null, error: { message: 'gone already' } });
    mockPrisma.jobStageAttachment.findFirst.mockResolvedValue(
      stagePhoto({ id: ATT_ID, data_url: '', storage_path: 'some/path.jpg' }),
    );

    const res = await request(app)
      .delete(`/api/inventory/job-stages/${STAGE_ID}/attachments/${ATT_ID}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(mockPrisma.jobStageAttachment.delete).toHaveBeenCalled();
  });

  it('skips Storage entirely for a legacy data-URI row', async () => {
    mockAuthAs('admin');
    mockPrisma.jobStageAttachment.findFirst.mockResolvedValue(stagePhoto({ id: ATT_ID }));

    const res = await request(app)
      .delete(`/api/inventory/job-stages/${STAGE_ID}/attachments/${ATT_ID}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(mockPrisma.jobStageAttachment.delete).toHaveBeenCalled();
  });

  it('404s an unknown/cross-org attachment and deletes nothing', async () => {
    mockAuthAs('admin');
    mockPrisma.jobStageAttachment.findFirst.mockResolvedValue(null);

    const res = await request(app)
      .delete(`/api/inventory/job-stages/${STAGE_ID}/attachments/${ATT_ID}`)
      .set(authHeader('admin'));
    expect(res.status).toBe(404);
    expect(storage.remove).not.toHaveBeenCalled();
    expect(mockPrisma.jobStageAttachment.delete).not.toHaveBeenCalled();
  });
});
