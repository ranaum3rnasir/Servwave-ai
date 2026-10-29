import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { mockAuthAs, authHeader, CUSTOMER_FIXTURE, JOB_FIXTURE, LEAD_FIXTURE } from './helpers';

const mockPrisma = prisma as unknown as {
  customer: { findUnique: ReturnType<typeof vi.fn> };
  job: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  attachment: {
    findMany: ReturnType<typeof vi.fn>;
    aggregate: ReturnType<typeof vi.fn>;
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    delete: ReturnType<typeof vi.fn>;
    deleteMany: ReturnType<typeof vi.fn>;
  };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
};

const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  upload: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
};

// ─── magic-byte fixtures (file-sniff.ts contract) ────────────────────────────
function jpegBuf(size = 1024): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
}
function mp4Buf(size = 16): Buffer {
  const b = Buffer.alloc(size);
  b.write('ftyp', 4, 'latin1');
  b.write('isom', 8, 'latin1');
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.attachment.aggregate.mockResolvedValue({ _sum: { file_size: 0 } });
});

describe('GET /api/attachments/customer/:id', () => {
  it('lists attachments for a CUSTOMER entity (200)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.attachment.findMany.mockResolvedValue([]);

    const res = await request(app)
      .get(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.attachments).toEqual([]);
    // entity_type was accepted + uppercased before the query.
    const args = mockPrisma.attachment.findMany.mock.calls[0][0];
    expect(args.where.entity_type).toBe('CUSTOMER');
  });

  it('rejects an unknown entity type (400)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get(`/api/attachments/widget/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
  });
});

describe('GET /api/attachments/JOB/:id?include_lead=true', () => {
  it('forwards EVERY attachment on the lead, not just a subset', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.attachment.findMany
      .mockResolvedValueOnce([
      {
        id: 'att-job-1',
        file_name: 'job-photo.jpg',
        file_url: 'https://example.com/job-photo.jpg',
        storage_path: null,
        file_type: 'image/jpeg',
        file_size: 12345,
        display_name: null,
        description: null,
        created_at: new Date('2026-01-25'),
        uploader: { id: 'u1', first_name: 'Test', last_name: 'Admin' },
      },
      ])
      // This used to honour the `where` the controller sends, so the test would fail if the
      // per-context filter ever came back. That filter is now unrepresentable -- the `context`
      // column is dropped -- so the mock returns the rows plainly and the guarantee is carried
      // by the assertions below instead.
      .mockResolvedValueOnce([
      {
        id: 'att-lead-wt',
        file_name: 'walkthrough-photo.jpg',
        file_url: 'https://example.com/walkthrough-photo.jpg',
        storage_path: null,
        file_type: 'image/jpeg',
        file_size: 11111,
        display_name: null,
        description: null,
        created_at: new Date('2026-01-20'),
        uploader: { id: 'u1', first_name: 'Test', last_name: 'Admin' },
      },
      {
        id: 'att-lead-other',
        file_name: 'lead-tab-file.jpg',
        file_url: 'https://example.com/lead-tab-file.jpg',
        storage_path: null,
        file_type: 'image/jpeg',
        file_size: 11111,
        display_name: null,
        description: null,
        created_at: new Date('2026-01-20'),
        uploader: { id: 'u1', first_name: 'Test', last_name: 'Admin' },
      },
      ]);
    mockPrisma.job.findFirst.mockResolvedValue({
      lead_id: LEAD_FIXTURE.id,
      estimate: { lead_id: LEAD_FIXTURE.id },
    });

    const res = await request(app)
      .get(`/api/attachments/JOB/${JOB_FIXTURE.id}?include_lead=true`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const sources = res.body.attachments.map((a: { source: string }) => a.source);
    expect(sources).toEqual(['JOB', 'LEAD', 'LEAD']);

    // The regression this guards: a file uploaded on the lead's own Attachments tab
    // reaches the job. The filter this replaced listed only the walkthrough photo
    // contexts, so this row was silently dropped on conversion.
    const ids = res.body.attachments.map((a: { id: string }) => a.id);
    expect(ids).toContain('att-lead-other');

    // The lead query is scoped by entity alone.
    const secondCall = mockPrisma.attachment.findMany.mock.calls[1][0];
    expect(secondCall.where.entity_type).toBe('LEAD');
    expect(secondCall.where.entity_id).toBe(LEAD_FIXTURE.id);
  });

  it('resolves the lead via Job.lead_id when the job has no estimate (multi-estimate job)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.attachment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
          id: 'att-lead-other',
          file_name: 'lead-tab-file.jpg',
          file_url: 'https://example.com/lead-tab-file.jpg',
          storage_path: null,
          file_type: 'image/jpeg',
          file_size: 11111,
          display_name: null,
          description: null,
          context: 'OTHER',
          created_at: new Date('2026-01-20'),
          uploader: { id: 'u1', first_name: 'Test', last_name: 'Admin' },
        }]);
    // A job converted from SEVERAL estimates carries no estimate_id, so the old
    // estimate hop resolved null and forwarded nothing. lead_id still points home.
    mockPrisma.job.findFirst.mockResolvedValue({
      lead_id: LEAD_FIXTURE.id,
      estimate: null,
    });

    const res = await request(app)
      .get(`/api/attachments/JOB/${JOB_FIXTURE.id}?include_lead=true`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.attachment.findMany.mock.calls).toHaveLength(2);
    expect(res.body.attachments.map((a: { source: string }) => a.source)).toEqual(['LEAD']);
  });

  it('falls back to the estimate hop when Job.lead_id is null (pre-backfill job)', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.attachment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
      id: 'att-lead-wt',
      file_name: 'walkthrough-photo.jpg',
      file_url: 'https://example.com/walkthrough-photo.jpg',
      storage_path: null,
      file_type: 'image/jpeg',
      file_size: 11111,
      display_name: null,
      description: null,
      context: 'WALKTHROUGH',
      created_at: new Date('2026-01-20'),
      uploader: { id: 'u1', first_name: 'Test', last_name: 'Admin' },
        }]);
    mockPrisma.job.findFirst.mockResolvedValue({
      lead_id: null,
      estimate: { lead_id: LEAD_FIXTURE.id },
    });

    const res = await request(app)
      .get(`/api/attachments/JOB/${JOB_FIXTURE.id}?include_lead=true`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const secondCall = mockPrisma.attachment.findMany.mock.calls[1][0];
    expect(secondCall.where.entity_id).toBe(LEAD_FIXTURE.id);
  });

  it('still honours the legacy include_walkthrough alias', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.attachment.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
      id: 'att-lead-other',
      file_name: 'lead-tab-file.jpg',
      file_url: 'https://example.com/lead-tab-file.jpg',
      storage_path: null,
      file_type: 'image/jpeg',
      file_size: 11111,
      display_name: null,
      description: null,
      context: 'OTHER',
      created_at: new Date('2026-01-20'),
      uploader: { id: 'u1', first_name: 'Test', last_name: 'Admin' },
        }]);
    mockPrisma.job.findFirst.mockResolvedValue({
      lead_id: LEAD_FIXTURE.id,
      estimate: null,
    });

    const res = await request(app)
      .get(`/api/attachments/JOB/${JOB_FIXTURE.id}?include_walkthrough=true`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.attachments.map((a: { source: string }) => a.source)).toEqual(['LEAD']);
  });

  it('JOB attachments backward-compat: no source key without the flag', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.attachment.findMany.mockResolvedValueOnce([
      {
        id: 'att-job-1',
        file_name: 'job-photo.jpg',
        file_url: 'https://example.com/job-photo.jpg',
        storage_path: null,
        file_type: 'image/jpeg',
        file_size: 12345,
        display_name: null,
        description: null,
        context: 'JOB_WORK',
        created_at: new Date('2026-01-25'),
        uploader: { id: 'u1', first_name: 'Test', last_name: 'Admin' },
      },
    ]);

    const res = await request(app)
      .get(`/api/attachments/JOB/${JOB_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.attachments).toHaveLength(1);
    expect(res.body.attachments[0]).not.toHaveProperty('source');
    expect(mockPrisma.attachment.findMany.mock.calls).toHaveLength(1);
  });

  it('JOB attachments: only job rows when the job has no lead at all', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockResolvedValue({ id: JOB_FIXTURE.id });
    mockPrisma.attachment.findMany.mockResolvedValueOnce([]);
    // A from-scratch job: no lead_id, no estimate.
    mockPrisma.job.findFirst.mockResolvedValue({ lead_id: null, estimate: null });

    const res = await request(app)
      .get(`/api/attachments/JOB/${JOB_FIXTURE.id}?include_lead=true`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(mockPrisma.attachment.findMany.mock.calls).toHaveLength(1);
  });
});

/**
 * THE PROXY PATH'S caps. The 50MB below is MAX_PROXY_VIDEO_FILE_SIZE, not the 512MB video
 * cap — this route's multer buffers the whole file in the process, so it deliberately kept
 * the ceiling it had when video moved to the direct-to-storage path. Do not "correct" these
 * numbers upward to match the direct path; `attachment-video-cap-split.test.ts` holds the
 * two apart and explains why.
 */
describe('POST /api/attachments/:entityType/:entityId — size caps', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
  });

  it('accepts a video up to 50MB', async () => {
    const res = await request(app)
      .post(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .field('display_name', 'walkthrough clip')
      .field('description', '')
      .attach('file', mp4Buf(50 * 1024 * 1024), { filename: 'clip.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(201);
    expect(storage.upload).toHaveBeenCalled();
  });

  it('rejects a video over 50MB (400, not a raw multer 500)', async () => {
    const res = await request(app)
      .post(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .field('display_name', 'walkthrough clip')
      .field('description', '')
      .attach('file', mp4Buf(50 * 1024 * 1024 + 1), { filename: 'clip.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('50MB');
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('still rejects a non-video file over 25MB', async () => {
    const res = await request(app)
      .post(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .field('display_name', 'big photo')
      .field('description', '')
      .attach('file', jpegBuf(25 * 1024 * 1024 + 1), { filename: 'big.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain('25MB');
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('accepts a non-video file at exactly 25MB', async () => {
    const res = await request(app)
      .post(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .field('display_name', 'photo')
      .field('description', '')
      .attach('file', jpegBuf(25 * 1024 * 1024), { filename: 'a.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(201);
    expect(storage.upload).toHaveBeenCalled();
  });

  // Past the 60MB ROUTE ceiling multer aborts the stream itself, so the handler's own
  // per-kind checks above never run. Before the MulterError handler existed that abort
  // fell through to app.ts's blanket final middleware and the technician's toast read
  // "Upload failed - Video .mp4: Internal server error" - a size problem wearing a crash's
  // clothes. It must read as a size problem, and it must carry the `error` key, because
  // that is the only key the frontend's extractApiError reads.
  it('rejects a file past multer\'s own route ceiling with 413, never a raw 500', async () => {
    const res = await request(app)
      .post(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .field('display_name', 'walkthrough clip')
      .field('description', '')
      .attach('file', mp4Buf(60 * 1024 * 1024 + 1), { filename: 'clip.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(413);
    expect(res.status).not.toBe(500);
    expect(res.body.error).toBeTypeOf('string');
    expect(res.body.error).not.toContain('Internal server error');
    // States the caps the user is actually subject to (25/50MB), never multer's 60MB ceiling.
    expect(res.body.error).toContain('50MB');
    expect(res.body.error).toContain('25MB');
    expect(res.body.error).not.toContain('60MB');
    expect(storage.upload).not.toHaveBeenCalled();
  });

  // Asserts the TOAST TEXT, not merely the shape of the body.
  //
  // An earlier version of this test checked only `Object.keys(res.body) === ['error']`,
  // which passes on the UNFIXED code too - the blanket 500 body is also `{error: ...}`, so
  // it proved nothing about this defect. What only holds after the fix is the pairing: a
  // 413 whose `error` carries the real caps. The literal string is spelled out here rather
  // than rebuilt from the constants, so that retuning a cap fails this test and forces
  // someone to look at the copy the user reads.
  it('renders the caps as the toast reason extractApiError will pull out', async () => {
    const res = await request(app)
      .post(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .field('display_name', 'walkthrough clip')
      .field('description', '')
      .attach('file', mp4Buf(60 * 1024 * 1024 + 1), { filename: 'clip.mp4', contentType: 'video/mp4' });

    expect(res.status).toBe(413);
    expect(res.body.error).toBe(
      'That file is too large to upload. Videos can be up to 50MB and other files up to 25MB.',
    );
    // extractApiError reads `details[]` BEFORE `error`, so anything that outranks the
    // message would silently replace it in the toast. Nothing may.
    expect(res.body.details).toBeUndefined();
    expect(res.body.message).toBeUndefined();
    expect(Object.keys(res.body)).toEqual(['error']);
  });

  // A second file in a single-file field is LIMIT_UNEXPECTED_FILE, not a size problem:
  // 400, and still never the blanket 500.
  it('rejects an unexpected extra file with 400, never a raw 500', async () => {
    const res = await request(app)
      .post(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .field('display_name', 'photo')
      .field('description', '')
      .attach('file', jpegBuf(1024), { filename: 'a.jpg', contentType: 'image/jpeg' })
      .attach('file', jpegBuf(1024), { filename: 'b.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(res.status).not.toBe(500);
    expect(res.body.error).toBeTypeOf('string');
    expect(res.body.error).not.toContain('Internal server error');
    expect(storage.upload).not.toHaveBeenCalled();
  });
});
// Guards the shape of the queries, not just the outcome. Prisma enumerates EVERY column of the
// model when a query carries no `select`, using the client generated from that deploy's
// schema.prisma. So a bare query keeps naming a column that a later migration drops, and the
// still-running previous build 500s the moment the migration lands -- which is exactly the window
// expand/contract exists to close. These assertions fail if someone drops the `select` back off.
describe('DELETE /api/attachments/:entityType/:entityId/:attachmentId', () => {
  it('names its columns explicitly and deletes without a RETURNING row', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.attachment.findFirst.mockResolvedValue({
      storage_path: 'attachments/org/file.jpg',
      file_url: '',
      display_name: 'a file',
      file_name: 'file.jpg',
    });
    mockPrisma.attachment.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.timelineEvent.create.mockResolvedValue({ id: 'tl-1' });

    const res = await request(app)
      .delete(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}/att-1`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);

    // The lookup must ask for named columns, never the whole row.
    const lookup = mockPrisma.attachment.findFirst.mock.calls[0][0];
    expect(lookup.select).toBeDefined();
    // `uploaded_by` joined the list with task files (slice 12): an uploader may remove their own
    // file on a task without the delete grant. It is a long-standing required column, so naming
    // it cannot trip the expand/contract window this test guards.
    expect(Object.keys(lookup.select).sort()).toEqual(
      ['display_name', 'file_name', 'file_url', 'storage_path', 'uploaded_by'],
    );

    // `delete` returns the deleted row, so Prisma emits RETURNING with every column.
    // `deleteMany` returns a count and enumerates nothing.
    expect(mockPrisma.attachment.deleteMany).toHaveBeenCalledWith({ where: { id: 'att-1' } });
    expect(mockPrisma.attachment.delete).not.toHaveBeenCalled();
  });

  // An EMPTY storage_path, not a null one. This is the row shape the whole legacy-protection
  // path exists for, and it is the one that distinguishes `||` from `??`: `??` keeps the empty
  // string, finds it falsy at the `if (storagePath)` guard, and silently skips the storage
  // delete — leaking the object while telling the user it was deleted. The parser extraction
  // (S3) briefly introduced exactly that, and nothing here would have caught it.
  it('falls back to the legacy file_url when storage_path is EMPTY, not just null', async () => {
    mockAuthAs('admin');
    storage.remove.mockClear();
    mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
    mockPrisma.attachment.findFirst.mockResolvedValue({
      storage_path: '',
      file_url:
        'https://test.supabase.co/storage/v1/object/public/attachments/org-1/customer/c-1/legacy.pdf',
      display_name: 'a legacy file',
      file_name: 'legacy.pdf',
    });
    mockPrisma.attachment.deleteMany.mockResolvedValue({ count: 1 });
    mockPrisma.timelineEvent.create.mockResolvedValue({ id: 'tl-1' });

    const res = await request(app)
      .delete(`/api/attachments/customer/${CUSTOMER_FIXTURE.id}/att-1`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(storage.remove).toHaveBeenCalledWith(['org-1/customer/c-1/legacy.pdf']);
  });
});
