/**
 * S4 — the caps themselves, and the three ways they can be raised wrongly.
 *
 * Ran decided 2026-09-20: 512MB per video file (the storage bucket's own `file_size_limit`),
 * against the 2GB per-entity total he set on 2026-09-18. The numbers are pinned
 * here as LITERALS on purpose. Every other test in the repo derives its expectation from the
 * constant it is testing, which is right for copy — a derived message cannot lie — but it
 * means the whole suite stays green if someone quietly retunes a constant. Something has to
 * assert the decision itself, and this is it. If a later slice moves a number, this file is
 * where the decision is re-taken rather than drifted past.
 *
 * The three failure shapes this covers, all of which a "just change the number" edit hits:
 *
 *  1. THE LOWEST CAP SILENTLY WINS. Four separate gates enforce a size — the two per-file
 *     constants, the per-entity aggregate and multer's route ceiling — and a file has to clear
 *     every one of them. Raising three of four buys nothing.
 *  2. THE ENTITY TOTAL SWALLOWS THE PER-FILE CAP. If the per-entity total is not several times
 *     the per-file cap, the first large upload onto an empty entity fails against a limit the
 *     user was never told about.
 *  3. THE PROXY ROUTE INHERITS A CAP IT CANNOT CARRY. `attachment.routes.ts` uses
 *     `multer.memoryStorage()`, so whatever number sits in its `limits` can be buffered whole
 *     in the Node process. The direct path's 512MB must not reach it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import {
  MAX_FILE_SIZE,
  MAX_VIDEO_FILE_SIZE,
  MAX_PROXY_VIDEO_FILE_SIZE,
  MAX_ENTITY_SIZE,
} from '../controllers/attachment.controller';
import { PROXY_ROUTE_CEILING_BYTES } from '../routes/attachment.routes';
import { sizeLimitLabel } from '../middleware/multerErrors';

const mockPrisma = prisma as unknown as Record<string, any>;

const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  upload: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  createSignedUploadUrl: ReturnType<typeof vi.fn>;
  createSignedUrl: ReturnType<typeof vi.fn>;
};

const MB = 1024 * 1024;
const GB = 1024 * MB;
const JOB_ID = 'j0000000-0000-0000-0000-0000000000d1';

async function mintVideo(overrides: Record<string, unknown> = {}) {
  return request(app)
    .post(`/api/attachments/job/${JOB_ID}/direct-upload`)
    .set(authHeader('admin'))
    .send({
      file_name: 'walkthrough.mp4',
      content_type: 'video/mp4',
      file_size: 5 * MB,
      ...overrides,
    });
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.job.findUnique.mockImplementation(async (args: any) => {
    if (args?.where?.organization_id && args.where.organization_id !== ALPHA_ORG_ID) return null;
    if (args?.where?.id !== JOB_ID) return null;
    return { id: JOB_ID };
  });
  mockPrisma.attachment.aggregate.mockResolvedValue({ _sum: { file_size: 0 } });
  mockPrisma.attachment.findFirst.mockResolvedValue(null);
  storage.createSignedUploadUrl.mockImplementation(async (path: string) => ({
    data: { signedUrl: `https://storage.test/upload/${path}`, token: 't', path },
    error: null,
  }));
});

// ─── 1. The decided numbers ──────────────────────────────

describe('the caps Ran decided', () => {
  it('carries a 512MB video file', () => {
    // 512MB is the storage bucket's own `file_size_limit` (Ran, 2026-09-20), so the app cap
    // EQUALS the infrastructure ceiling and has no headroom above it. Lowering the bucket
    // without lowering this first moves the refusal from our 400 to storage's 413.
    expect(MAX_VIDEO_FILE_SIZE).toBe(512 * MB);
  });

  it('carries a 2GB per-entity total', () => {
    expect(MAX_ENTITY_SIZE).toBe(2 * GB);
  });

  it('leaves the non-video per-file cap at 25MB', () => {
    // Unchanged by S4 deliberately: nothing in the PRD's evidence is about PDFs and photos,
    // and S6 owns the non-video path. Pinned so a sweeping "raise the caps" edit that moved
    // it too has to say so here.
    expect(MAX_FILE_SIZE).toBe(25 * MB);
  });
});

// ─── 2. The invariants between them ──────────────────────

describe('S4 — a cap that contradicts another cap', () => {
  it('leaves room for several files at the per-file cap inside one entity', () => {
    // "Several times the per-file cap" is Ran's wording and the reason 2GB was chosen over,
    // say, 1GB: at parity the FIRST 512MB upload onto an empty job would be refused by the
    // entity total, against a limit no surface ever showed the user.
    expect(MAX_ENTITY_SIZE).toBeGreaterThan(MAX_VIDEO_FILE_SIZE);
    expect(MAX_ENTITY_SIZE / MAX_VIDEO_FILE_SIZE).toBeGreaterThanOrEqual(3);
  });

  it('keeps the proxy route ceiling above the caps the proxy handler enforces', () => {
    // The ceiling exists to sit ABOVE the handler's real caps so an oversized file gets the
    // handler's precise sentence rather than multer's abort. That only holds while it is
    // above both of them.
    expect(PROXY_ROUTE_CEILING_BYTES).toBeGreaterThan(MAX_FILE_SIZE);
    expect(PROXY_ROUTE_CEILING_BYTES).toBeGreaterThan(MAX_PROXY_VIDEO_FILE_SIZE);
  });

  it('never lets the direct path\'s cap reach the buffering proxy route', () => {
    // `multer.memoryStorage()` holds the whole file in the Node process. The instance this
    // runs on is documented at 512MB (`src/index.ts`), so a 512MB ceiling here is one request
    // away from taking the process down — and two concurrent ones guarantee it.
    expect(PROXY_ROUTE_CEILING_BYTES).toBeLessThan(MAX_VIDEO_FILE_SIZE);
    expect(MAX_PROXY_VIDEO_FILE_SIZE).toBeLessThan(MAX_VIDEO_FILE_SIZE);
  });
});

// ─── 3. The per-entity total, at its own boundary ────────

describe('S4 — the per-entity total is enforced at the new number', () => {
  it('accepts a file that exactly fills the entity total', async () => {
    // Arithmetic against the constant, never against a figure typed next to it: a fixture
    // that says "1.9GB" stops testing the boundary the moment the boundary moves.
    mockPrisma.attachment.aggregate.mockResolvedValue({
      _sum: { file_size: MAX_ENTITY_SIZE - MAX_VIDEO_FILE_SIZE },
    });

    const res = await mintVideo({ file_size: MAX_VIDEO_FILE_SIZE });

    expect(res.status).toBe(201);
    expect(storage.createSignedUploadUrl).toHaveBeenCalled();
  });

  it('refuses the single byte past it', async () => {
    mockPrisma.attachment.aggregate.mockResolvedValue({
      _sum: { file_size: MAX_ENTITY_SIZE - MAX_VIDEO_FILE_SIZE },
    });

    const res = await mintVideo({ file_size: MAX_VIDEO_FILE_SIZE + 1 });

    expect(res.status).toBe(400);
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('accepts a whole file at the per-file cap onto an empty entity', async () => {
    // The shape of failure mode 2, made executable: with the entity total at or below the
    // per-file cap this is the upload that can never succeed.
    mockPrisma.attachment.aggregate.mockResolvedValue({ _sum: { file_size: 0 } });

    const res = await mintVideo({ file_size: MAX_VIDEO_FILE_SIZE });

    expect(res.status).toBe(201);
  });
});

// ─── 4. The sentence the user reads ──────────────────────

describe('S4 — the entity-total refusal names the real total', () => {
  /** Just over the total, derived — so the figure cannot drift from the cap it is testing. */
  async function overTheTotal() {
    mockPrisma.attachment.aggregate.mockResolvedValue({ _sum: { file_size: MAX_ENTITY_SIZE } });
    return mintVideo({ file_size: 1 });
  }

  it('quotes the cap the request was actually measured against', async () => {
    const res = await overTheTotal();

    expect(res.status).toBe(400);
    // `sizeLimitLabel` is asserted rather than a literal "2GB" so this cannot become the
    // thing that has to be hand-edited next time. The literal decision is pinned above.
    expect(res.body.error).toContain(sizeLimitLabel(MAX_ENTITY_SIZE));
  });

  it('does not still say 200MB', async () => {
    // The specific rot this guards: the message was a hand-written string carrying "200MB"
    // while the constant beside it was the thing enforced. A message that lies about the
    // limit is worse than no message, because the user believes it.
    const res = await overTheTotal();

    expect(res.body.error).not.toContain('200MB');
  });

  it('reads as a total rather than as a per-file refusal', async () => {
    // A phrase unique to THIS gate. "File too large. Maximum: ..." is the per-file sentence
    // and is echoed all over this controller; asserting only on a size would pass if the
    // entity check were deleted and the per-file one happened to fire instead.
    const res = await overTheTotal();

    expect(res.body.error).toMatch(/total attachments for this entity/i);
  });
});

// ─── 5. The proxy path did not inherit the direct cap ────

describe('S4 — the multipart proxy path keeps its own, smaller video cap', () => {
  beforeEach(() => {
    mockPrisma.customer.findUnique.mockResolvedValue({ id: 'c0000000-0000-0000-0000-000000000001' });
  });

  /** An ISO-BMFF head that sniffs as video/mp4, padded to `size`. */
  function mp4Buf(size: number): Buffer {
    const b = Buffer.alloc(size, 0x11);
    b.write('ftyp', 4, 'latin1');
    b.write('isom', 8, 'latin1');
    return b;
  }

  it('refuses a video one byte over the PROXY cap, with the proxy cap in the message', async () => {
    const res = await request(app)
      .post('/api/attachments/customer/c0000000-0000-0000-0000-000000000001')
      .set(authHeader('admin'))
      .field('display_name', 'clip')
      .field('description', '')
      .attach('file', mp4Buf(MAX_PROXY_VIDEO_FILE_SIZE + 1), {
        filename: 'clip.mp4',
        contentType: 'video/mp4',
      });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(sizeLimitLabel(MAX_PROXY_VIDEO_FILE_SIZE));
    // The whole point of the separate constant. Promising 512MB on a route that buffers the
    // file in a 512MB process is how this change would take production down.
    expect(res.body.error).not.toContain(sizeLimitLabel(MAX_VIDEO_FILE_SIZE));
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('never promises the direct cap when multer itself aborts the stream', async () => {
    const res = await request(app)
      .post('/api/attachments/customer/c0000000-0000-0000-0000-000000000001')
      .set(authHeader('admin'))
      .field('display_name', 'clip')
      .field('description', '')
      .attach('file', mp4Buf(PROXY_ROUTE_CEILING_BYTES + 1), {
        filename: 'clip.mp4',
        contentType: 'video/mp4',
      });

    expect(res.status).toBe(413);
    expect(res.body.error).not.toContain(sizeLimitLabel(MAX_VIDEO_FILE_SIZE));
    expect(res.body.error).toContain(sizeLimitLabel(MAX_PROXY_VIDEO_FILE_SIZE));
    expect(storage.upload).not.toHaveBeenCalled();
  });
});

// ─── 6. Rendering a cap that is no longer a whole MB ─────

describe('sizeLimitLabel — a limit past 1GB still reads like a limit', () => {
  it('renders the per-file caps in MB', () => {
    expect(sizeLimitLabel(25 * MB)).toBe('25MB');
    expect(sizeLimitLabel(512 * MB)).toBe('512MB');
  });

  it('renders the entity total in GB rather than as 2048MB', () => {
    expect(sizeLimitLabel(2 * GB)).toBe('2GB');
  });

  it('falls back to MB for a size that is not a whole number of GB', () => {
    expect(sizeLimitLabel(1536 * MB)).toBe('1536MB');
  });
});
