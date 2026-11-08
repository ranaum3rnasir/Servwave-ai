/**
 * Inventory P4 — asset photo upload (Attachment pattern, exactly).
 *
 * Multipart → multer → withOrgContext (AFTER multer — the ALS learning) →
 * MIME allowlist (images only) → magic-byte sniff (F-35) → Storage upload to the
 * `attachments` bucket under an org-namespaced key → persist the canonical PATH
 * (never a signed URL, never a data-URI) → best-effort old-object cleanup.
 * Upload happens OUTSIDE any $transaction.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ASSET_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  asset: {
    findFirst: ReturnType<typeof vi.fn>;
    updateMany: ReturnType<typeof vi.fn>;
  };
  auditLog: { create: ReturnType<typeof vi.fn> };
};

// setup.ts mocks storage.from with mockReturnValue → the SAME object every call.
const storageApi = (supabaseAdmin.storage.from as any)();

// Real PNG magic bytes so the content sniff (F-35) sees a genuine image.
const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

const URL = `/api/inventory/assets/${ASSET_FIXTURE.id}/photo`;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.asset.findFirst.mockResolvedValue(ASSET_FIXTURE);
  mockPrisma.asset.updateMany.mockResolvedValue({ count: 1 });
});

describe('POST /api/inventory/assets/:id/photo', () => {
  it('happy PNG: org-namespaced key, path (not URL) persisted, signed URL returned, audited', async () => {
    // Re-read after the updateMany carries the stored path.
    const storedPath = `${ALPHA_ORG_ID}/asset/${ASSET_FIXTURE.id}/1-drill_photo.png`;
    mockPrisma.asset.findFirst
      .mockResolvedValueOnce(ASSET_FIXTURE) // 404/ownership check (no prior photo)
      .mockResolvedValueOnce({ ...ASSET_FIXTURE, photo_url: storedPath }); // response re-read

    const res = await request(app).post(URL).set(authHeader('admin'))
      .attach('file', PNG_BYTES, { filename: 'drill photo.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(supabaseAdmin.storage.from).toHaveBeenCalledWith('attachments');

    const [key, buf, opts] = storageApi.upload.mock.calls[0];
    expect(key).toMatch(new RegExp(`^${ALPHA_ORG_ID}/asset/${ASSET_FIXTURE.id}/\\d+-drill_photo\\.png$`));
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(opts).toMatchObject({ contentType: 'image/png', upsert: false });

    // DB persists the canonical PATH, never the signed URL.
    const upd = mockPrisma.asset.updateMany.mock.calls[0][0];
    expect(upd.where).toMatchObject({ id: ASSET_FIXTURE.id, organization_id: ALPHA_ORG_ID });
    expect(upd.data.photo_url).toBe(key);
    expect(upd.data.photo_url).not.toContain('http');

    // Response carries a freshly minted signed URL.
    expect(res.body.asset.photo_url).toBe('https://test.supabase.co/storage/v1/object/sign/test/file.jpg?token=mock');

    expect(mockPrisma.auditLog.create).toHaveBeenCalledTimes(1);
    const audit = mockPrisma.auditLog.create.mock.calls[0][0].data;
    expect(audit.action).toBe('inventory.asset_photo_uploaded');
  });

  it('no file → 400', async () => {
    const res = await request(app).post(URL).set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(storageApi.upload).not.toHaveBeenCalled();
  });

  it('non-image MIME (application/pdf) → 400, no upload', async () => {
    const res = await request(app).post(URL).set(authHeader('admin'))
      .attach('file', Buffer.from('%PDF-1.4 not a photo'), { filename: 'doc.pdf', contentType: 'application/pdf' });

    expect(res.status).toBe(400);
    expect(storageApi.upload).not.toHaveBeenCalled();
    expect(mockPrisma.asset.updateMany).not.toHaveBeenCalled();
  });

  it('sniff mismatch (PNG bytes declared image/jpeg) → 400 (F-35)', async () => {
    const res = await request(app).post(URL).set(authHeader('admin'))
      .attach('file', PNG_BYTES, { filename: 'photo.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(400);
    expect(storageApi.upload).not.toHaveBeenCalled();
  });

  it('storage upload error → 500 and NO dangling DB pointer', async () => {
    storageApi.upload.mockResolvedValueOnce({ data: null, error: { message: 'bucket on fire' } });

    const res = await request(app).post(URL).set(authHeader('admin'))
      .attach('file', PNG_BYTES, { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(500);
    expect(mockPrisma.asset.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.auditLog.create).not.toHaveBeenCalled();
  });

  it('replacing an existing photo best-effort removes the old object', async () => {
    const oldPath = `${ALPHA_ORG_ID}/asset/${ASSET_FIXTURE.id}/1-old.png`;
    mockPrisma.asset.findFirst.mockResolvedValue({ ...ASSET_FIXTURE, photo_url: oldPath });

    const res = await request(app).post(URL).set(authHeader('admin'))
      .attach('file', PNG_BYTES, { filename: 'new.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(storageApi.remove).toHaveBeenCalledWith([oldPath]);
  });

  it('cross-org asset → 404 before any storage call', async () => {
    mockPrisma.asset.findFirst.mockResolvedValue(null);

    const res = await request(app).post(URL).set(authHeader('admin'))
      .attach('file', PNG_BYTES, { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(404);
    expect(storageApi.upload).not.toHaveBeenCalled();
  });

  it.each(['sales', 'technician'] as const)('%s (no update Inventory) → 403', async (role) => {
    mockAuthAs(role);

    const res = await request(app).post(URL).set(authHeader(role))
      .attach('file', PNG_BYTES, { filename: 'photo.png', contentType: 'image/png' });

    expect(res.status).toBe(403);
    expect(storageApi.upload).not.toHaveBeenCalled();
  });
});
