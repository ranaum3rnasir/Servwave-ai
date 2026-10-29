/**
 * #2029 slice 5, route level — duplicate and revise actually carry the scope photos.
 *
 * Without these, `copyScopePhotosForward` could be perfectly correct and simply never called,
 * which IS the defect: both operations dropped the photos silently, so the copy was missing
 * evidence the original had.
 *
 * The copy must get its OWN storage objects. Deleting a photo removes the underlying object, so
 * sharing a path with the source means deleting from the copy destroys the original's image.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { mockAuthAs, authHeader, TEST_USERS, ESTIMATE_FIXTURE } from './helpers';

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  estimateScopePhoto: { findMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  copy: ReturnType<typeof vi.fn>;
};

const SOURCE_ID = ESTIMATE_FIXTURE.id;
const NEW_ID = 'a1111111-0000-4000-8000-000000000001';

const SOURCE_PHOTO = {
  id: 'sp-1',
  scope_id: 'scope-1',
  storage_path: `org/estimate_scope/${SOURCE_ID}/scope-1/1-a.jpg`,
  mime_type: 'image/jpeg',
  caption: 'Existing frame',
  uploaded_at: new Date('2026-09-01T00:00:00Z'),
  uploaded_by: 'Rep',
  size_bytes: 2048,
};

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  mockPrisma.estimateScopePhoto.findMany.mockResolvedValue([SOURCE_PHOTO]);
  mockPrisma.estimateScopePhoto.createMany.mockResolvedValue({ count: 1 });
  storage.copy.mockResolvedValue({ data: { path: 'copied' }, error: null });
});

/** The storage_path each newly-written photo row points at. */
function copiedRowPaths(): string[] {
  const call = mockPrisma.estimateScopePhoto.createMany.mock.calls[0];
  if (!call) throw new Error('no photo rows were written');
  return (call[0].data as Array<{ storage_path: string }>).map((r) => r.storage_path);
}

describe('POST /api/estimates/:id/duplicate', () => {
  beforeEach(() => {
    mockPrisma.estimate.findUnique.mockResolvedValue({
      lead_id: ESTIMATE_FIXTURE.lead_id,
      scope_notes: null,
      tax_rate: 0,
      lead: { lead_assignees: [{ user_id: TEST_USERS.sales.id }] },
      line_items: [],
    });
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        estimate: {
          findFirst: vi.fn().mockResolvedValue({ estimate_number: 'E00002' }),
          create: vi.fn().mockResolvedValue({ ...ESTIMATE_FIXTURE, id: NEW_ID, estimate_number: 'E00003' }),
        },
      }),
    );
  });

  it("carries the source's scope photos onto the duplicate", async () => {
    await request(app)
      .post(`/api/estimates/${SOURCE_ID}/duplicate`)
      .set(authHeader('admin'))
      .expect(201);

    expect(mockPrisma.estimateScopePhoto.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ estimate_id: SOURCE_ID }) }),
    );
    expect(storage.copy).toHaveBeenCalledTimes(1);
  });

  it("points the duplicate's photos at their OWN storage objects", async () => {
    await request(app)
      .post(`/api/estimates/${SOURCE_ID}/duplicate`)
      .set(authHeader('admin'))
      .expect(201);

    // Deleting a photo removes the underlying object. A shared path would mean deleting from the
    // copy destroys the original's image — and vice versa.
    for (const path of copiedRowPaths()) {
      expect(path).not.toBe(SOURCE_PHOTO.storage_path);
      expect(path).toContain(NEW_ID);
    }
  });

  it('still duplicates when there is nothing to carry', async () => {
    mockPrisma.estimateScopePhoto.findMany.mockResolvedValue([]);

    await request(app)
      .post(`/api/estimates/${SOURCE_ID}/duplicate`)
      .set(authHeader('admin'))
      .expect(201);

    expect(storage.copy).not.toHaveBeenCalled();
  });

  it('still duplicates when the photo copy fails outright', async () => {
    storage.copy.mockRejectedValue(new Error('storage down'));

    await request(app)
      .post(`/api/estimates/${SOURCE_ID}/duplicate`)
      .set(authHeader('admin'))
      .expect(201);
  });

  // Line items carry their price-book reference through the clone, so their image follows with
  // no photo-copying code at all. Stated as a test so a later change cannot quietly add some.
  it('needs no photo handling for line-item images', async () => {
    mockPrisma.estimateScopePhoto.findMany.mockResolvedValue([]);

    await request(app)
      .post(`/api/estimates/${SOURCE_ID}/duplicate`)
      .set(authHeader('admin'))
      .expect(201);

    expect(mockPrisma.estimateScopePhoto.createMany).not.toHaveBeenCalled();
  });
});
