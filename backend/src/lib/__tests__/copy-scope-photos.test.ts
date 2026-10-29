/**
 * #2029 slice 5 — duplicating or revising an estimate carries its scope photos forward.
 *
 * Both operations silently dropped them, so the copy was missing evidence the original had.
 *
 * THE COPY MUST GET ITS OWN STORAGE OBJECTS. Deleting a photo removes the underlying object, so a
 * copy sharing a storage path with its source means deleting from the copy destroys the
 * original's image — and the original is the document a customer may already be holding a link
 * to. The files are copied, not just the rows.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../prisma';
import { supabaseAdmin } from '../supabase';
import { copyScopePhotosForward } from '../copy-scope-photos';

const mockPrisma = prisma as unknown as {
  estimateScopePhoto: { findMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> };
};

const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  copy: ReturnType<typeof vi.fn>;
};

const SOURCE = 'est-source';
const TARGET = 'est-target';
const ORG = 'org-1';

function photo(over: Record<string, unknown> = {}) {
  return {
    id: 'sp-1',
    scope_id: 'scope-1',
    storage_path: `${ORG}/estimate_scope/${SOURCE}/scope-1/1-a.jpg`,
    mime_type: 'image/jpeg',
    caption: 'Existing frame',
    uploaded_at: new Date('2026-09-01T00:00:00Z'),
    uploaded_by: 'Rep',
    size_bytes: 2048,
    ...over,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.estimateScopePhoto.findMany.mockResolvedValue([photo()]);
  mockPrisma.estimateScopePhoto.createMany.mockResolvedValue({ count: 1 });
  storage.copy.mockResolvedValue({ data: { path: 'copied' }, error: null });
});

describe('carrying scope photos forward', () => {
  it("copies the stored FILE, not just the row — the copy owns its own object", async () => {
    await copyScopePhotosForward({ sourceEstimateId: SOURCE, targetEstimateId: TARGET, orgId: ORG });

    expect(storage.copy).toHaveBeenCalledTimes(1);
    const [from, to] = storage.copy.mock.calls[0];
    expect(from).toBe(`${ORG}/estimate_scope/${SOURCE}/scope-1/1-a.jpg`);
    expect(to).not.toBe(from);
    // The new path is anchored on the TARGET estimate, so nothing about it can be mistaken for
    // the source's.
    expect(to).toContain(`estimate_scope/${TARGET}/scope-1/`);
  });

  it('writes a row per photo, pointing at the copy', async () => {
    await copyScopePhotosForward({ sourceEstimateId: SOURCE, targetEstimateId: TARGET, orgId: ORG });

    const rows = mockPrisma.estimateScopePhoto.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      estimate_id: TARGET,
      scope_id: 'scope-1',
      caption: 'Existing frame',
      organization_id: ORG,
    });
    expect(rows[0].storage_path).not.toBe(photo().storage_path);
  });

  it('keeps a photo under the same scope block it was attached to', async () => {
    mockPrisma.estimateScopePhoto.findMany.mockResolvedValue([
      photo({ id: 'sp-1', scope_id: 'scope-1' }),
      photo({ id: 'sp-2', scope_id: 'scope-9' }),
    ]);

    await copyScopePhotosForward({ sourceEstimateId: SOURCE, targetEstimateId: TARGET, orgId: ORG });

    const rows = mockPrisma.estimateScopePhoto.createMany.mock.calls[0][0].data;
    expect(rows.map((r: { scope_id: string }) => r.scope_id)).toEqual(['scope-1', 'scope-9']);
  });

  it('does nothing at all when the source has no photos', async () => {
    mockPrisma.estimateScopePhoto.findMany.mockResolvedValue([]);

    await copyScopePhotosForward({ sourceEstimateId: SOURCE, targetEstimateId: TARGET, orgId: ORG });

    expect(storage.copy).not.toHaveBeenCalled();
    expect(mockPrisma.estimateScopePhoto.createMany).not.toHaveBeenCalled();
  });

  it('writes no row for a photo whose file could not be copied', async () => {
    mockPrisma.estimateScopePhoto.findMany.mockResolvedValue([
      photo({ id: 'sp-1', scope_id: 'scope-1' }),
      photo({ id: 'sp-2', scope_id: 'scope-2' }),
    ]);
    storage.copy
      .mockResolvedValueOnce({ data: { path: 'copied' }, error: null })
      .mockResolvedValueOnce({ data: null, error: { message: 'source gone' } });

    await copyScopePhotosForward({ sourceEstimateId: SOURCE, targetEstimateId: TARGET, orgId: ORG });

    // A row whose object does not exist is a broken image on a customer's document. An orphaned
    // object is merely wasted bytes — the same asymmetry the upload path is built around.
    const rows = mockPrisma.estimateScopePhoto.createMany.mock.calls[0][0].data;
    expect(rows.map((r: { scope_id: string }) => r.scope_id)).toEqual(['scope-1']);
  });

  it('never fails the duplicate over a photo — the estimate matters more than its evidence', async () => {
    storage.copy.mockRejectedValue(new Error('storage down'));

    await expect(
      copyScopePhotosForward({ sourceEstimateId: SOURCE, targetEstimateId: TARGET, orgId: ORG }),
    ).resolves.toBeUndefined();
  });
});
