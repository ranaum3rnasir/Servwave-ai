/**
 * user-avatar.test.ts — staff profile photo upload/remove (2026-08-04 plan,
 * md_files/plans/frontend/2026-08-04-user-avatars-initials-and-upload.md, phase 2).
 *
 * Mirrors estimate-photos.test.ts's conventions (magic-byte fixtures, storage mock handles,
 * upload-before-DB-write ordering) applied to the self/admin avatar surface: `/me/avatar` has no
 * capability check (any authenticated user manages their own), `/:id/avatar` is gated
 * `canDo('update', 'User')` and shares the same handler — only the resolved target id and the
 * capability check differ.
 *
 * Harness: supertest against app, prisma + supabase + sharp mocked.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import sharp from 'sharp';
import { mockAuthAs, authHeader, TEST_USERS } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

vi.mock('sharp', () => ({
  default: vi.fn().mockReturnValue({
    rotate: vi.fn().mockReturnThis(),
    resize: vi.fn().mockReturnThis(),
    jpeg: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('normalized-jpeg-bytes')),
  }),
}));

const mockPrisma = prisma as unknown as {
  user: {
    findFirst: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
};

const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  upload: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  createSignedUrls: ReturnType<typeof vi.fn>;
};

const ADMIN_ID = TEST_USERS.admin.id;
const TECH_ID = TEST_USERS.technician.id;
const ORG_B_USER_ID = TEST_USERS.orgB_admin.id;

function jpegBuf(size = 1024): Buffer {
  const b = Buffer.alloc(size);
  b[0] = 0xff; b[1] = 0xd8; b[2] = 0xff;
  return b;
}
const pdfBuf = () => Buffer.from('%PDF-1.4\n');
// minimal ISO-BMFF box: size + 'ftyp' + brand — HEIC
const heicBuf = () => Buffer.concat([Buffer.from([0, 0, 0, 0x18]), Buffer.from('ftypheic')]);

function userRow(over: Record<string, unknown> = {}) {
  return { id: TECH_ID, avatar_path: null, ...over };
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.user.findFirst.mockResolvedValue(userRow({ id: ADMIN_ID }));
  mockPrisma.user.update.mockImplementation((args: { where: { id: string }; data: Record<string, unknown> }) =>
    Promise.resolve({ id: args.where.id, ...args.data }),
  );
});

// ═══ POST /api/users/me/avatar ═════════════════════════════════════════════════

describe('POST /api/users/me/avatar', () => {
  it('happy path: normalises through sharp, uploads under org/user_profile_photo/:id, persists avatar_path, 200s a signed url', async () => {
    const res = await request(app)
      .post('/api/users/me/avatar')
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'me.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);

    const sharpDefault = sharp as unknown as ReturnType<typeof vi.fn>;
    expect(sharpDefault).toHaveBeenCalledTimes(1);
    const chain = sharpDefault.mock.results[0]!.value;
    expect(chain.resize).toHaveBeenCalledWith(256, 256, { fit: 'cover' });
    expect(chain.jpeg).toHaveBeenCalledWith({ quality: 82 });

    const [path, buf, opts] = storage.upload.mock.calls[0];
    expect(path).toMatch(new RegExp(`^${TEST_USERS.admin.organization_id}/user_profile_photo/${ADMIN_ID}/\\d+-avatar\\.jpg$`));
    expect(Buffer.isBuffer(buf)).toBe(true);
    expect(opts).toEqual({ contentType: 'image/jpeg', upsert: false });

    const data = mockPrisma.user.update.mock.calls[0][0];
    expect(data.where.id).toBe(ADMIN_ID);
    expect(data.data.avatar_path).toBe(path);

    expect(res.body.avatar_url).toContain('/object/sign/');
  });

  it('uploads to Storage BEFORE the DB write', async () => {
    const order: string[] = [];
    storage.upload.mockImplementationOnce(async () => {
      order.push('storage');
      return { data: { path: 'x' }, error: null };
    });
    mockPrisma.user.update.mockImplementationOnce(async (args: { where: { id: string }; data: Record<string, unknown> }) => {
      order.push('db');
      return { id: args.where.id, ...args.data };
    });

    const res = await request(app)
      .post('/api/users/me/avatar')
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'me.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(order).toEqual(['storage', 'db']);
  });

  it('replaces: removes the superseded storage object after the new one is committed', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userRow({ id: ADMIN_ID, avatar_path: 'org1/user_profile_photo/u1/old-avatar.jpg' }));

    const res = await request(app)
      .post('/api/users/me/avatar')
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'me.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(storage.remove).toHaveBeenCalledWith(['org1/user_profile_photo/u1/old-avatar.jpg']);
  });

  it('400s with no file provided', async () => {
    const res = await request(app).post('/api/users/me/avatar').set(authHeader('admin'));
    expect(res.status).toBe(400);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('400s a PDF (image-only allowlist)', async () => {
    const res = await request(app)
      .post('/api/users/me/avatar')
      .set(authHeader('admin'))
      .attach('file', pdfBuf(), { filename: 'doc.pdf', contentType: 'application/pdf' });
    expect(res.status).toBe(400);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('400s HEIC with a specific message rather than the generic type-rejection message', async () => {
    const res = await request(app)
      .post('/api/users/me/avatar')
      .set(authHeader('admin'))
      .attach('file', heicBuf(), { filename: 'me.heic', contentType: 'image/heic' });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/heic/i);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('400s on a magic-byte/declared-type mismatch (PDF bytes declared image/jpeg)', async () => {
    const res = await request(app)
      .post('/api/users/me/avatar')
      .set(authHeader('admin'))
      .attach('file', pdfBuf(), { filename: 'fake.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('400s a file over the 8MB cap', async () => {
    const res = await request(app)
      .post('/api/users/me/avatar')
      .set(authHeader('admin'))
      .attach('file', jpegBuf(9 * 1024 * 1024), { filename: 'huge.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(400);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('500s and writes NO row when the Storage upload fails', async () => {
    storage.upload.mockResolvedValueOnce({ data: null, error: { message: 'denied' } });
    const res = await request(app)
      .post('/api/users/me/avatar')
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'me.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(500);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('any authenticated user (no capability check) can set their own avatar', async () => {
    mockAuthAs('technician');
    mockPrisma.user.findFirst.mockResolvedValue(userRow({ id: TECH_ID }));
    const res = await request(app)
      .post('/api/users/me/avatar')
      .set(authHeader('technician'))
      .attach('file', jpegBuf(), { filename: 'me.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(200);
  });
});

// ═══ DELETE /api/users/me/avatar ═══════════════════════════════════════════════

describe('DELETE /api/users/me/avatar', () => {
  it('clears avatar_path, removes the storage object, 200s avatar_url: null', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userRow({ id: ADMIN_ID, avatar_path: 'org1/user_profile_photo/u1/1-avatar.jpg' }));

    const res = await request(app).delete('/api/users/me/avatar').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.avatar_url).toBeNull();
    expect(storage.remove).toHaveBeenCalledWith(['org1/user_profile_photo/u1/1-avatar.jpg']);
    expect(mockPrisma.user.update).toHaveBeenCalledWith({
      where: { id: ADMIN_ID },
      data: { avatar_path: null },
    });
  });

  it('is idempotent when no avatar is set — no Storage call, still 200s', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userRow({ id: ADMIN_ID, avatar_path: null }));

    const res = await request(app).delete('/api/users/me/avatar').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.avatar_url).toBeNull();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });
});

// ═══ POST/DELETE /api/users/:id/avatar (admin-on-behalf-of) ════════════════════

describe('POST /api/users/:id/avatar', () => {
  it('an admin can set another user’s avatar', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userRow({ id: TECH_ID }));

    const res = await request(app)
      .post(`/api/users/${TECH_ID}/avatar`)
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'tech.jpg', contentType: 'image/jpeg' });

    expect(res.status).toBe(200);
    expect(mockPrisma.user.update.mock.calls[0][0].where.id).toBe(TECH_ID);
  });

  it('403s a non-admin (no update User capability)', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .post(`/api/users/${ADMIN_ID}/avatar`)
      .set(authHeader('technician'))
      .attach('file', jpegBuf(), { filename: 'x.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(403);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('404s a cross-org target id (tenantWhere scoping)', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(null); // simulates tenantWhere excluding org B's row
    const res = await request(app)
      .post(`/api/users/${ORG_B_USER_ID}/avatar`)
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'x.jpg', contentType: 'image/jpeg' });
    expect(res.status).toBe(404);
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('logs the audit event with the target as resourceId and the admin as the actor', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userRow({ id: TECH_ID }));
    await request(app)
      .post(`/api/users/${TECH_ID}/avatar`)
      .set(authHeader('admin'))
      .attach('file', jpegBuf(), { filename: 'tech.jpg', contentType: 'image/jpeg' });

    const auditCreate = prisma.auditLog.create as ReturnType<typeof vi.fn>;
    const [call] = auditCreate.mock.calls.filter(([args]) => args.data.action === 'user.avatar_set');
    expect(call).toBeTruthy();
    expect(call[0].data.resource_id).toBe(TECH_ID);
    expect(call[0].data.actor_id).toBe(ADMIN_ID);
  });
});

describe('DELETE /api/users/:id/avatar', () => {
  it('an admin can remove another user’s avatar', async () => {
    mockPrisma.user.findFirst.mockResolvedValue(userRow({ id: TECH_ID, avatar_path: 'org1/user_profile_photo/u4/1.jpg' }));

    const res = await request(app).delete(`/api/users/${TECH_ID}/avatar`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(storage.remove).toHaveBeenCalledWith(['org1/user_profile_photo/u4/1.jpg']);
  });

  it('403s a non-admin (no update User capability)', async () => {
    mockAuthAs('technician');
    const res = await request(app).delete(`/api/users/${ADMIN_ID}/avatar`).set(authHeader('technician'));
    expect(res.status).toBe(403);
    expect(storage.remove).not.toHaveBeenCalled();
  });
});
