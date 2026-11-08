/**
 * #2029 slice 2 — the per-estimate photo cap, and the renderable-format invariant.
 *
 * A hard cap so a document cannot become unusable to send or open, and a warning well before it
 * so the salesperson is not surprised mid-walkthrough. Enforced HERE, not only in the client: the
 * client's own count is a courtesy, and a document that has to render is not something to leave
 * to a browser.
 *
 * The format allowlist narrows for the same reason. The client converts every pick to JPEG before
 * upload, and the server's image library cannot decode HEIC pixels at all — so a HEIC that
 * reached storage would be a photo no PDF could ever render. The endpoint refuses it, and the
 * invariant holds even if a client bypasses conversion.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ESTIMATE_PHOTO_CAP, ESTIMATE_PHOTO_WARN_AT } from '../controllers/estimate-photos.controller';

const mockPrisma = prisma as unknown as {
  estimate: { findUnique: ReturnType<typeof vi.fn> };
  estimateScopePhoto: { count: ReturnType<typeof vi.fn>; create: ReturnType<typeof vi.fn> };
};

const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  upload: ReturnType<typeof vi.fn>;
};

const ESTIMATE_ID = 'f0000000-0000-0000-0000-000000000001';
const SCOPE_ID = 'cc000000-0000-0000-0000-000000000003';

function jpegBuf(size = 1024): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
}
/** ftyp box declaring `heic` — what an iPhone hands over. */
function heicBuf(): Buffer {
  const b = Buffer.alloc(32);
  b.write('ftypheic', 4, 'ascii');
  b[3] = 0x20;
  return b;
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.estimate.findUnique.mockResolvedValue({
    id: ESTIMATE_ID,
    status: 'DRAFT',
    organization_id: ALPHA_ORG_ID,
    scopes: [{ id: SCOPE_ID, title: 'Doors', body: '', flat_price: 100, is_taxable: true, internal_cost: null }],
    line_items: [],
    invoices: [],
    lead: { lead_assignees: [] },
    created_by: 'u1',
    organization: { lock_on_send: false },
  });
  mockPrisma.estimateScopePhoto.count.mockResolvedValue(0);
  mockPrisma.estimateScopePhoto.create.mockResolvedValue({
    id: 'ee000000-0000-0000-0000-000000000001',
    storage_path: 'p',
    mime_type: 'image/jpeg',
    caption: null,
    uploaded_at: new Date(),
    uploaded_by: 'Test Admin',
    size_bytes: 1024,
  });
  storage.upload.mockResolvedValue({ data: { path: 'p' }, error: null });
});

function upload(buf: Buffer, filename: string, contentType: string) {
  return request(app)
    .post(`/api/estimates/${ESTIMATE_ID}/scopes/${SCOPE_ID}/photos`)
    .set(authHeader('admin'))
    .attach('file', buf, { filename, contentType });
}

describe('the per-estimate photo cap', () => {
  it('is refused past the cap, with a message naming the limit', async () => {
    mockPrisma.estimateScopePhoto.count.mockResolvedValue(ESTIMATE_PHOTO_CAP);

    const res = await upload(jpegBuf(), 'a.jpg', 'image/jpeg');

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(String(ESTIMATE_PHOTO_CAP));
    expect(mockPrisma.estimateScopePhoto.create).not.toHaveBeenCalled();
  });

  it('accepts the one that fills the cap exactly', async () => {
    mockPrisma.estimateScopePhoto.count.mockResolvedValue(ESTIMATE_PHOTO_CAP - 1);

    expect((await upload(jpegBuf(), 'a.jpg', 'image/jpeg')).status).toBe(201);
  });

  it('counts every scope block on the estimate, not just the one being added to', async () => {
    await upload(jpegBuf(), 'a.jpg', 'image/jpeg');

    expect(mockPrisma.estimateScopePhoto.count).toHaveBeenCalledWith(
      expect.objectContaining({ where: expect.objectContaining({ estimate_id: ESTIMATE_ID }) }),
    );
    // Scoped to the estimate ONLY — never narrowed to this scope_id, or deleting a photo from a
    // sibling block would not free a slot.
    const where = mockPrisma.estimateScopePhoto.count.mock.calls[0][0].where;
    expect(where).not.toHaveProperty('scope_id');
  });

  it('reports how many remain, so the client can warn before the cap', async () => {
    mockPrisma.estimateScopePhoto.count.mockResolvedValue(ESTIMATE_PHOTO_WARN_AT - 1);

    const res = await upload(jpegBuf(), 'a.jpg', 'image/jpeg');

    expect(res.body.photo_count).toBe(ESTIMATE_PHOTO_WARN_AT);
    expect(res.body.photo_cap).toBe(ESTIMATE_PHOTO_CAP);
  });

  it('warns well before it refuses', () => {
    expect(ESTIMATE_PHOTO_WARN_AT).toBeLessThan(ESTIMATE_PHOTO_CAP);
  });
});

describe('the renderable-format invariant', () => {
  it('refuses a HEIC even though a phone will happily offer one', async () => {
    const res = await upload(heicBuf(), 'IMG_0421.HEIC', 'image/heic');

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/JPG|PNG/i);
    expect(mockPrisma.estimateScopePhoto.create).not.toHaveBeenCalled();
  });

  it('still accepts the JPEG the client converts it into', async () => {
    expect((await upload(jpegBuf(), 'IMG_0421.jpg', 'image/jpeg')).status).toBe(201);
  });
});
