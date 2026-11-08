/**
 * Direct-to-storage uploads, slice S1 — the tracer bullet.
 *
 * Video is the one thing the field routinely produces that the proxy path cannot carry: every
 * byte currently lands in the app server's memory first. The direct path moves the bytes
 * browser -> storage and leaves the app server with two jobs, both of which have to be real
 * gates rather than paperwork:
 *
 *   1. mint a scoped upload URL, running EVERY gate the proxy handler runs before any byte
 *      moves (entity in my org, canDo, declared type on the allowlist, declared size in cap);
 *   2. verify the LANDED object — real size off storage metadata, a range-read of the head
 *      sniffed against the declared type (F-35), the per-entity total re-checked — and only
 *      then create the row. Anything that fails deletes the object.
 *
 * The declared numbers are all attacker-controlled, so every assertion below that matters is
 * about the server disbelieving the client: the size comes from `info()`, the path is built
 * from the org id, and the second call re-derives its whole context from a signed ticket
 * rather than from the request body.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import {
  mockAuthAs,
  mockRoleGrantsWithout,
  authHeader,
  TEST_USERS,
  ALPHA_ORG_ID,
  ORG_B_ID,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { signUploadTicket } from '../lib/attachment-direct-upload';
import { MAX_VIDEO_FILE_SIZE, MAX_ENTITY_SIZE } from '../controllers/attachment.controller';
import { sizeLimitLabel } from '../middleware/multerErrors';

const mockPrisma = prisma as unknown as Record<string, any>;

const storage = supabaseAdmin.storage.from('attachments') as unknown as {
  upload: ReturnType<typeof vi.fn>;
  remove: ReturnType<typeof vi.fn>;
  info: ReturnType<typeof vi.fn>;
  createSignedUploadUrl: ReturnType<typeof vi.fn>;
  createSignedUrl: ReturnType<typeof vi.fn>;
};

const JOB_ID = 'j0000000-0000-0000-0000-0000000000d1';
const MB = 1024 * 1024;

/** An ISO-BMFF head that sniffs as video/mp4: 'ftyp' at 4-7, brand 'isom' at 8-11. */
function mp4Head(size = 4096): Buffer {
  const b = Buffer.alloc(size, 0x11);
  b.write('ftyp', 4, 'latin1');
  b.write('isom', 8, 'latin1');
  return b;
}

/** A PDF head — genuine bytes, but a lie when the upload declared video/mp4. */
function pdfHead(size = 4096): Buffer {
  const b = Buffer.alloc(size, 0x20);
  b.write('%PDF-1.7', 0, 'latin1');
  return b;
}

/**
 * A job.findUnique that HONOURS the org filter. A blanket mockResolvedValue answers any
 * `where` at all, which would make the cross-org assertions below vacuous — the exact
 * failure mode this repo has been bitten by.
 */
function orgHonouringJob(orgId = ALPHA_ORG_ID) {
  return async (args: any) => {
    if (args?.where?.organization_id && args.where.organization_id !== orgId) return null;
    if (args?.where?.id !== JOB_ID) return null;
    const out: Record<string, unknown> = { id: JOB_ID };
    if (args?.select?.visits) out.visits = [];
    return out;
  };
}

/**
 * Stub the head range-read the verify step performs against the landed object.
 *
 * `arrayBuffer` is a SPY, not a plain function. A status assertion would also catch the guard
 * being removed, so this is not the only instrument available — it is the better one, because
 * "the body was never read" IS the memory property, where a status code is only a downstream
 * consequence of it that some later refactor could preserve while reading the body anyway.
 */
function stubHeadBytes(buf: Buffer, init: { status?: number; contentLength?: number } = {}) {
  const arrayBuffer = vi.fn(async () =>
    buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength));
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: init.status ?? 206,
    headers: new Headers({ 'content-length': String(init.contentLength ?? buf.length) }),
    arrayBuffer,
  });
  vi.stubGlobal('fetch', fetchMock);
  return Object.assign(fetchMock, { arrayBufferSpy: arrayBuffer });
}

type Principal = 'admin' | 'sales' | 'technician' | 'dispatcher';

async function mint(body: Record<string, unknown>, who: Principal = 'admin') {
  return request(app)
    .post(`/api/attachments/job/${JOB_ID}/direct-upload`)
    .set(authHeader(who))
    .send(body);
}

/**
 * `who` must match the user `mockAuthAs` installed: `authenticate` caches the resolved user
 * per BEARER TOKEN, so reusing the admin header after switching to another principal serves
 * the cached admin and quietly disarms the assertion.
 */
async function mintVideo(
  overrides: Record<string, unknown> = {},
  who: Principal = 'admin',
) {
  return mint({
    file_name: 'walkthrough.mp4',
    content_type: 'video/mp4',
    file_size: 5 * MB,
    ...overrides,
  }, who);
}

async function complete(body: Record<string, unknown>, who: Principal = 'admin') {
  return request(app)
    .post(`/api/attachments/job/${JOB_ID}/direct-upload/complete`)
    .set(authHeader(who))
    .send(body);
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.unstubAllGlobals();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.job.findUnique.mockImplementation(orgHonouringJob());
  mockPrisma.attachment.aggregate.mockResolvedValue({ _sum: { file_size: 0 } });
  // "No row for this object yet" is the right default. It must be re-established here:
  // vi.clearAllMocks() clears recorded calls but NOT a mockResolvedValue, so the
  // idempotency test's existing-row fixture would otherwise leak into every test after it.
  mockPrisma.attachment.findFirst.mockResolvedValue(null);
  mockPrisma.attachment.create.mockImplementation(async ({ data }: any) => ({
    id: 'att00000-0000-0000-0000-000000000001',
    file_name: data.file_name,
    file_url: '',
    file_type: data.file_type,
    file_size: data.file_size,
    display_name: data.display_name,
    description: data.description,
    created_at: new Date('2026-09-18'),
    uploader: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
  }));
  mockPrisma.timelineEvent.create.mockResolvedValue({ id: 'tl-1' });
  storage.remove.mockResolvedValue({ data: null, error: null });
  storage.createSignedUploadUrl.mockImplementation(async (path: string) => ({
    data: { signedUrl: `https://storage.test/object/upload/sign/attachments/${path}?token=t`, token: 't', path },
    error: null,
  }));
  storage.createSignedUrl.mockImplementation(async (path: string) => ({
    data: { signedUrl: `https://storage.test/object/sign/attachments/${path}?token=r` },
    error: null,
  }));
  storage.info.mockResolvedValue({ data: { size: 5 * MB, contentType: 'video/mp4' }, error: null });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

// ─── 1. Minting the URL ──────────────────────────────────

describe('POST .../direct-upload — minting a scoped upload URL', () => {
  it('returns an upload URL whose path is built from the org id and the entity', async () => {
    const res = await mintVideo();

    expect(res.status).toBe(201);
    expect(res.body.upload.path).toMatch(
      new RegExp(`^${ALPHA_ORG_ID}/job/${JOB_ID}/\\d+-walkthrough\\.mp4$`),
    );
    expect(res.body.upload.ticket).toBeTruthy();
    // The client uploads with { bucket, path, token }; it never reads a URL, so the response
    // does not hand one out. Shipping it would put the storage host in a payload for nothing.
    expect(res.body.upload).not.toHaveProperty('url');
    expect(res.body.upload).not.toHaveProperty('expires_in');
    expect(Object.keys(res.body.upload).sort()).toEqual(['bucket', 'path', 'ticket', 'token']);
    // The app server mints a URL; it must not have been asked to carry any bytes.
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('builds the path from the caller\'s org, never from a client-supplied path', async () => {
    const res = await mintVideo({
      file_name: '../../../other-org/escape.mp4',
      // A client that also tries to dictate the destination outright.
      path: `${ORG_B_ID}/job/${JOB_ID}/planted.mp4`,
      storage_path: `${ORG_B_ID}/job/${JOB_ID}/planted.mp4`,
    });

    expect(res.status).toBe(201);
    expect(res.body.upload.path.startsWith(`${ALPHA_ORG_ID}/`)).toBe(true);
    expect(res.body.upload.path).not.toContain('..');
    expect(res.body.upload.path).not.toContain(ORG_B_ID);
    // The signed URL storage actually issued is for the server-built path only.
    // `{ upsert: false }` pinned, not `expect.anything()`: upsert:true would let a second
    // minted URL overwrite an object already verified and recorded, which is a different
    // file appearing under an existing row.
    expect(storage.createSignedUploadUrl).toHaveBeenCalledWith(
      expect.stringMatching(new RegExp(`^${ALPHA_ORG_ID}/job/${JOB_ID}/`)),
      { upsert: false },
    );
  });

  it('refuses a caller without create Attachment', async () => {
    mockAuthAs('sales');
    mockRoleGrantsWithout('SALES', ['create', 'Attachment']);

    const res = await mintVideo({}, 'sales');

    expect(res.status).toBe(403);
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('refuses an entity in another org', async () => {
    // Same job id, but the caller belongs to org B — the org-honouring fake answers null.
    mockAuthAs('orgB_admin');
    mockPrisma.job.findUnique.mockImplementation(orgHonouringJob(ALPHA_ORG_ID));

    const res = await request(app)
      .post(`/api/attachments/job/${JOB_ID}/direct-upload`)
      .set(authHeader('orgB_admin'))
      .send({ file_name: 'a.mp4', content_type: 'video/mp4', file_size: MB });

    expect(res.status).toBe(404);
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('refuses a declared size over the video cap, before any byte moves', async () => {
    const res = await mintVideo({ file_size: MAX_VIDEO_FILE_SIZE + 1 });

    expect(res.status).toBe(400);
    // Derived from the constant, never restated. A literal here would have kept passing on
    // the day the cap went to 512MB and the API started refusing 513MB files promising 50MB.
    expect(res.body.error).toBe(`File too large. Maximum: ${sizeLimitLabel(MAX_VIDEO_FILE_SIZE)}`);
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('refuses a type that is not video — everything else stays on the proxy path', async () => {
    for (const ct of ['image/jpeg', 'application/pdf', 'text/csv', 'text/plain']) {
      storage.createSignedUploadUrl.mockClear();
      const res = await mintVideo({ file_name: 'f.bin', content_type: ct, file_size: MB });
      expect(res.status, ct).toBe(400);
      expect(storage.createSignedUploadUrl, ct).not.toHaveBeenCalled();
    }
  });

  it('refuses a type that is not on the allowlist at all', async () => {
    const res = await mintVideo({ file_name: 'x.exe', content_type: 'application/x-msdownload' });
    expect(res.status).toBe(400);
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });

  it('refuses when the declared size would already blow the per-entity total', async () => {
    // Positioned relative to MAX_ENTITY_SIZE, never at a figure typed beside it. The total
    // went from 200MB to 2GB and the old fixture (199MB stored + 5MB) silently stopped
    // overflowing anything - the assertion would have survived as a test that cannot fail.
    mockPrisma.attachment.aggregate.mockResolvedValue({
      _sum: { file_size: MAX_ENTITY_SIZE - 4 * MB },
    });

    const res = await mintVideo({ file_size: 5 * MB });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(sizeLimitLabel(MAX_ENTITY_SIZE));
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
  });
});

// ─── 2. Verify and record ────────────────────────────────

describe('POST .../direct-upload/complete — verifying the landed object', () => {
  it('records the row with the size read from storage, not the size the client declared', async () => {
    // The client declared 1MB at mint time; the object that actually landed is 30MB.
    const minted = await mintVideo({ file_size: 1 * MB });
    storage.info.mockResolvedValue({ data: { size: 30 * MB, contentType: 'video/mp4' }, error: null });
    stubHeadBytes(mp4Head());

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Walkthrough',
      description: '',
    });

    expect(res.status).toBe(201);
    expect(storage.info).toHaveBeenCalledWith(minted.body.upload.path);
    expect(mockPrisma.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ file_size: 30 * MB }) }),
    );
    expect(res.body.attachment.file_size).toBe(30 * MB);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('rejects and DELETES an object whose real size exceeds the cap despite a small declared size', async () => {
    const minted = await mintVideo({ file_size: 1 * MB });
    storage.info.mockResolvedValue({
      data: { size: MAX_VIDEO_FILE_SIZE + 1, contentType: 'video/mp4' },
      error: null,
    });
    stubHeadBytes(mp4Head());

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Walkthrough',
      description: '',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`File too large. Maximum: ${sizeLimitLabel(MAX_VIDEO_FILE_SIZE)}`);
    expect(mockPrisma.attachment.create).not.toHaveBeenCalled();
    expect(storage.remove).toHaveBeenCalledWith([minted.body.upload.path]);
  });

  /**
   * The COMPLETE-path boundary, pinned on both sides with LITERAL byte counts.
   *
   * The mint path already had an exactly-512MB case; this one did not, and the asymmetry sat
   * on the precise number the cap was set to. The cost of getting it wrong here is not a
   * refusal, it is destruction: this branch calls `discardStoredObject(ticket.path)`, so an
   * off-by-one turning `>` into `>=` DELETES a 512MB object that fully landed — every byte
   * pushed up a slow field uplink — and then tells the uploader it was too large.
   *
   * 536,870,912 is written out rather than derived from MAX_VIDEO_FILE_SIZE on purpose. A
   * fixture spelled `MAX_VIDEO_FILE_SIZE` moves whenever the constant moves, so it can never
   * catch the constant and the storage ceiling drifting apart — and the ceiling is the thing
   * this number has to keep matching. Measured 2026-09-20: a resumable-upload creation POST
   * declaring 536870912 answers 201, and 536870913 answers 413. The bucket's limit is
   * INCLUSIVE, so exactly 512MiB must be ACCEPTED here, not refused.
   */
  it('accepts an object of exactly 536,870,912 bytes and does NOT discard it', async () => {
    const minted = await mintVideo({ file_size: 1 * MB });
    storage.info.mockResolvedValue({
      data: { size: 536870912, contentType: 'video/mp4' },
      error: null,
    });
    stubHeadBytes(mp4Head());

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Walkthrough',
      description: '',
    });

    expect(res.status).toBe(201);
    // The object survives. This is the assertion that matters: a 400 would be a bad day, but
    // `remove` having been called is the user's file gone.
    expect(storage.remove).not.toHaveBeenCalled();
    expect(mockPrisma.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ file_size: 536870912 }) }),
    );
    expect(res.body.attachment.file_size).toBe(536870912);
  });

  it('refuses an object of 536,870,913 bytes — one past the ceiling — and discards it', async () => {
    const minted = await mintVideo({ file_size: 1 * MB });
    storage.info.mockResolvedValue({
      data: { size: 536870913, contentType: 'video/mp4' },
      error: null,
    });
    stubHeadBytes(mp4Head());

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Walkthrough',
      description: '',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe(`File too large. Maximum: ${sizeLimitLabel(MAX_VIDEO_FILE_SIZE)}`);
    expect(mockPrisma.attachment.create).not.toHaveBeenCalled();
    expect(storage.remove).toHaveBeenCalledWith([minted.body.upload.path]);
  });

  /**
   * The same shape for the per-entity total, which is also a delete-on-refuse branch.
   *
   * Lower stakes — 2GB of attachments on one record is not a total any user reaches — but
   * `>` -> `>=` is green here too, and the consequence is again the landed object being
   * removed. Derived from MAX_ENTITY_SIZE rather than written out: unlike the video cap this
   * number is not pinned to anything outside the process, so there is nothing for a literal
   * to catch it drifting away from.
   */
  it('accepts an object that lands the entity total on exactly MAX_ENTITY_SIZE', async () => {
    mockPrisma.attachment.aggregate.mockResolvedValue({
      _sum: { file_size: MAX_ENTITY_SIZE - 30 * MB },
    });
    const minted = await mintVideo({ file_size: 1 * MB });
    storage.info.mockResolvedValue({ data: { size: 30 * MB, contentType: 'video/mp4' }, error: null });
    stubHeadBytes(mp4Head());

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Walkthrough',
      description: '',
    });

    expect(res.status).toBe(201);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('rejects and DELETES an object whose real bytes disagree with the declared type (F-35)', async () => {
    const minted = await mintVideo();
    stubHeadBytes(pdfHead());

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Walkthrough',
      description: '',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match its declared type/i);
    expect(mockPrisma.attachment.create).not.toHaveBeenCalled();
    expect(storage.remove).toHaveBeenCalledWith([minted.body.upload.path]);
  });

  it('re-checks the per-entity total against the REAL size and deletes on overflow', async () => {
    mockPrisma.attachment.aggregate.mockResolvedValue({
      _sum: { file_size: MAX_ENTITY_SIZE - 29 * MB },
    });
    // Declared 1MB leaves 28MB of headroom and passes the mint precheck; the 30MB that really
    // landed overflows by 1MB. Both sides derived, so the gap survives the cap moving.
    const minted = await mintVideo({ file_size: 1 * MB });
    expect(minted.status).toBe(201);
    storage.info.mockResolvedValue({ data: { size: 30 * MB, contentType: 'video/mp4' }, error: null });
    stubHeadBytes(mp4Head());

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Walkthrough',
      description: '',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toContain(sizeLimitLabel(MAX_ENTITY_SIZE));
    expect(mockPrisma.attachment.create).not.toHaveBeenCalled();
    expect(storage.remove).toHaveBeenCalledWith([minted.body.upload.path]);
  });

  it('reads only the first 8KB of the object — the app server never holds the file', async () => {
    const minted = await mintVideo();
    storage.info.mockResolvedValue({ data: { size: 40 * MB, contentType: 'video/mp4' }, error: null });
    const fetchMock = stubHeadBytes(mp4Head(8192));

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Walkthrough',
      description: '',
    });

    expect(res.status).toBe(201);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [, init] = fetchMock.mock.calls[0];
    expect(init.headers.Range).toBe('bytes=0-8191');
    // And nothing streamed through the proxy uploader on the way past.
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('refuses a ticket minted for another org', async () => {
    // Mint as org B's admin against org B's own job, then replay the ticket as the Alpha admin.
    mockAuthAs('orgB_admin');
    mockPrisma.job.findUnique.mockImplementation(orgHonouringJob(ORG_B_ID));
    const minted = await request(app)
      .post(`/api/attachments/job/${JOB_ID}/direct-upload`)
      .set(authHeader('orgB_admin'))
      .send({ file_name: 'a.mp4', content_type: 'video/mp4', file_size: MB });
    expect(minted.status).toBe(201);
    expect(minted.body.upload.path.startsWith(`${ORG_B_ID}/`)).toBe(true);

    mockAuthAs('admin');
    mockPrisma.job.findUnique.mockImplementation(orgHonouringJob(ALPHA_ORG_ID));
    stubHeadBytes(mp4Head());

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Planted',
      description: '',
    });

    expect(res.status).toBe(403);
    expect(mockPrisma.attachment.create).not.toHaveBeenCalled();
    // Somebody else's object must NOT be deleted on a rejected replay.
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('refuses a tampered ticket', async () => {
    const minted = await mintVideo();
    const [body, sig] = String(minted.body.upload.ticket).split('.');
    const forged = Buffer.from(
      JSON.stringify({
        ...JSON.parse(Buffer.from(body, 'base64url').toString('utf8')),
        path: `${ORG_B_ID}/job/${JOB_ID}/planted.mp4`,
      }),
    ).toString('base64url');
    stubHeadBytes(mp4Head());

    const res = await complete({ ticket: `${forged}.${sig}`, display_name: 'X', description: '' });

    expect(res.status).toBe(400);
    expect(mockPrisma.attachment.create).not.toHaveBeenCalled();
  });

  it('ignores a storage path supplied in the request body', async () => {
    const minted = await mintVideo();
    stubHeadBytes(mp4Head());

    const res = await complete({
      ticket: minted.body.upload.ticket,
      storage_path: `${ORG_B_ID}/job/${JOB_ID}/planted.mp4`,
      path: `${ORG_B_ID}/job/${JOB_ID}/planted.mp4`,
      file_size: 1,
      display_name: 'Walkthrough',
      description: '',
    });

    expect(res.status).toBe(201);
    expect(storage.info).toHaveBeenCalledWith(minted.body.upload.path);
    expect(mockPrisma.attachment.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          storage_path: minted.body.upload.path,
          file_size: 5 * MB,
        }),
      }),
    );
  });

  it('refuses a caller who has lost create Attachment between mint and verify', async () => {
    const minted = await mintVideo();
    mockAuthAs('sales');
    mockRoleGrantsWithout('SALES', ['create', 'Attachment']);
    stubHeadBytes(mp4Head());

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'X',
      description: '',
    }, 'sales');

    expect(res.status).toBe(403);
    expect(mockPrisma.attachment.create).not.toHaveBeenCalled();
  });

  it('404s when the object never landed', async () => {
    const minted = await mintVideo();
    storage.info.mockResolvedValue({ data: null, error: { message: 'Object not found', statusCode: '404' } });

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'X',
      description: '',
    });

    expect(res.status).toBe(404);
    expect(mockPrisma.attachment.create).not.toHaveBeenCalled();
  });
});

describe('the ticket binds the upload to one org, one entity and one moment', () => {
  it('refuses an EXPIRED ticket without touching storage', async () => {
    // Signed through the real signer with a negative TTL: a genuinely expired, genuinely
    // well-signed ticket. Tampering would be caught by the signature and would prove nothing
    // about expiry.
    const expired = signUploadTicket(
      {
        org: ALPHA_ORG_ID,
        et: 'JOB',
        eid: JOB_ID,
        path: `${ALPHA_ORG_ID}/job/${JOB_ID}/1757000000000-old.mp4`,
        mime: 'video/mp4',
        name: 'old.mp4',
        uid: TEST_USERS.admin.id,
      },
      -60,
    );
    stubHeadBytes(mp4Head());

    const res = await complete({ ticket: expired, display_name: 'Old', description: '' });

    expect(res.status).toBe(400);
    expect(mockPrisma.attachment.create).not.toHaveBeenCalled();
    // Rejected before the object is even looked at, let alone deleted. The name of this test
    // says "without touching storage", so every storage call is checked rather than the two
    // that happened to be interesting — a name that promises more than it checks is how the
    // next reader forms a wrong belief about what is covered.
    expect(storage.info).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(storage.createSignedUrl).not.toHaveBeenCalled();
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('accepts the same ticket while it is still live — the control for expiry', async () => {
    const live = signUploadTicket({
      org: ALPHA_ORG_ID,
      et: 'JOB',
      eid: JOB_ID,
      path: `${ALPHA_ORG_ID}/job/${JOB_ID}/1757000000000-old.mp4`,
      mime: 'video/mp4',
      name: 'old.mp4',
      uid: TEST_USERS.admin.id,
    });
    stubHeadBytes(mp4Head());

    const res = await complete({ ticket: live, display_name: 'Old', description: '' });

    expect(res.status).toBe(201);
  });

  it('refuses a ticket replayed onto a DIFFERENT entity id', async () => {
    const minted = await mintVideo();
    stubHeadBytes(mp4Head());
    const otherJob = 'j0000000-0000-0000-0000-0000000000d9';

    const res = await request(app)
      .post(`/api/attachments/job/${otherJob}/direct-upload/complete`)
      .set(authHeader('admin'))
      .send({ ticket: minted.body.upload.ticket, display_name: 'Planted', description: '' });

    expect(res.status).toBe(400);
    expect(mockPrisma.attachment.create).not.toHaveBeenCalled();
    expect(storage.info).not.toHaveBeenCalled();
  });

  it('refuses a ticket replayed onto a DIFFERENT entity type', async () => {
    const minted = await mintVideo();
    stubHeadBytes(mp4Head());

    const res = await request(app)
      .post(`/api/attachments/customer/${JOB_ID}/direct-upload/complete`)
      .set(authHeader('admin'))
      .send({ ticket: minted.body.upload.ticket, display_name: 'Planted', description: '' });

    expect(res.status).toBe(400);
    expect(mockPrisma.attachment.create).not.toHaveBeenCalled();
    expect(storage.info).not.toHaveBeenCalled();
  });

  it('refuses a ticket completed by a different user, even inside the same org', async () => {
    const minted = await mintVideo();

    // A dispatcher in the SAME org, holding create Attachment. Only the minting user's id
    // separates them, which is the point.
    mockAuthAs('dispatcher');
    mockPrisma.job.findUnique.mockImplementation(orgHonouringJob(ALPHA_ORG_ID));
    stubHeadBytes(mp4Head());

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Someone else\'s upload',
      description: '',
    }, 'dispatcher');

    expect(res.status).toBe(403);
    expect(mockPrisma.attachment.create).not.toHaveBeenCalled();
    // Not this caller's object to destroy either.
    expect(storage.remove).not.toHaveBeenCalled();
  });
});

describe('an infrastructure failure is not the user\'s file being wrong', () => {
  /**
   * `readStoredObjectHead` returns null for four reasons that have nothing to do with the
   * file: the read URL could not be minted, fetch threw, storage ignored the Range, or the
   * response was not OK. Reporting those as "your file content does not match its declared
   * type" blames the user for our outage — and deletes their upload on the way out.
   */
  it('answers 502 and KEEPS the object when the head read fails for infrastructure reasons', async () => {
    const minted = await mintVideo();
    // Storage is reachable enough to stat the object, but the head read fails outright.
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('ECONNRESET')));

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Walkthrough',
      description: '',
    });

    expect(res.status).toBe(502);
    expect(res.body.error).not.toMatch(/does not match its declared type/i);
    expect(mockPrisma.attachment.create).not.toHaveBeenCalled();
    // The bytes are probably fine. Deleting them because OUR read failed loses the user's
    // upload for a reason that has nothing to do with it.
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('still answers 400 and deletes when the bytes really do disagree', async () => {
    const minted = await mintVideo();
    stubHeadBytes(pdfHead());

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Walkthrough',
      description: '',
    });

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/does not match its declared type/i);
    expect(storage.remove).toHaveBeenCalledWith([minted.body.upload.path]);
  });
});

describe('completing the same upload twice', () => {
  /**
   * `storage_path` is nullable and NOT unique, so two completes of one live ticket would make
   * two rows for one object. Deleting either removes the object unconditionally, leaving the
   * other pointing at nothing — a broken attachment the user cannot repair. Today's client
   * does not double-submit; S2 wraps retries around exactly this call.
   */
  it('returns the existing row instead of creating a second one', async () => {
    const minted = await mintVideo();
    stubHeadBytes(mp4Head());

    const first = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Walkthrough',
      description: '',
    });
    expect(first.status).toBe(201);
    expect(mockPrisma.attachment.create).toHaveBeenCalledTimes(1);

    // The object is now recorded. Replaying the same ticket must find it, not duplicate it.
    mockPrisma.attachment.findFirst.mockResolvedValue({
      id: first.body.attachment.id,
      file_name: 'walkthrough.mp4',
      file_url: '',
      file_type: 'video/mp4',
      file_size: 5 * MB,
      display_name: 'Walkthrough',
      description: '',
      created_at: new Date('2026-09-18'),
      uploader: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
    });
    stubHeadBytes(mp4Head());

    const second = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Walkthrough',
      description: '',
    });

    expect(second.status).toBe(200);
    expect(second.body.attachment.id).toBe(first.body.attachment.id);
    expect(mockPrisma.attachment.create).toHaveBeenCalledTimes(1);
    // A replay is not a second upload: no duplicate timeline entry either.
    expect(mockPrisma.timelineEvent.create).toHaveBeenCalledTimes(1);
    expect(storage.remove).not.toHaveBeenCalled();
  });

  /**
   * The replay must short-circuit BEFORE the per-entity total is recomputed.
   *
   * On a replay the existing row's bytes are already inside the aggregate, so adding
   * `realSize` again counts the same video twice. Near the cap that tips the sum over, and
   * the overflow branch calls `discardStoredObject` — deleting the object while a perfectly
   * valid row still points at it, which is the exact breakage the idempotency guard exists to
   * prevent, reached from the other side.
   *
   * Every other test in this suite uses `_sum: 0`, which is precisely why none of them could
   * see it. The resumable transport's retries turn replays from exotic into routine, and a
   * 512MB per-file cap makes each double-count ten times larger, so a job needs far fewer
   * videos to reach it.
   */
  it('does not double-count the existing row against the entity total', async () => {
    const minted = await mintVideo();
    // Stored total INCLUDING this upload's own 5MB row, placed so the double-count is
    // decisive: the aggregate alone is 4MB under the cap, and counting the 5MB row twice puts
    // it 1MB over. Derived, because the fixed 196MB this used to say stopped overflowing
    // anything the moment the total went to 2GB - leaving a guard against a deletion bug that
    // could no longer fail.
    mockPrisma.attachment.aggregate.mockResolvedValue({
      _sum: { file_size: MAX_ENTITY_SIZE - 4 * MB },
    });
    mockPrisma.attachment.findFirst.mockResolvedValue({
      id: 'att00000-0000-0000-0000-000000000001',
      file_name: 'walkthrough.mp4',
      file_url: '',
      file_type: 'video/mp4',
      file_size: 5 * MB,
      display_name: 'Walkthrough',
      description: '',
      created_at: new Date('2026-09-18'),
      uploader: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
    });
    stubHeadBytes(mp4Head());

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Walkthrough',
      description: '',
    });

    // Asserted FIRST because it is the actual harm. A wrong status is a bad response; a
    // deleted object under a live row is data the user cannot get back.
    expect(storage.remove).not.toHaveBeenCalled();
    expect(res.status).toBe(200);
    expect(mockPrisma.attachment.create).not.toHaveBeenCalled();
  });

  it('short-circuits a replay without re-verifying the object', async () => {
    const minted = await mintVideo();
    mockPrisma.attachment.findFirst.mockResolvedValue({
      id: 'att00000-0000-0000-0000-000000000001',
      file_name: 'walkthrough.mp4',
      file_url: '',
      file_type: 'video/mp4',
      file_size: 5 * MB,
      display_name: 'Walkthrough',
      description: '',
      created_at: new Date('2026-09-18'),
      uploader: { id: TEST_USERS.admin.id, first_name: 'Test', last_name: 'Admin' },
    });
    const fetchMock = stubHeadBytes(mp4Head());

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Walkthrough',
      description: '',
    });

    expect(res.status).toBe(200);
    // The row is the proof the object was verified once already, so none of the verification
    // calls run again: no stat, no head read, no delete. Each one skipped is a branch that
    // cannot misfire on a path where nothing new is happening.
    //
    // NOT "no storage calls". `buildAccessUrl` still mints one read URL to populate
    // `file_url` on the row it returns, exactly as the first response did — the caller gets
    // the same shape either way. These three are the ones the short-circuit actually avoids,
    // and naming them is the honest version of the claim.
    expect(storage.info).not.toHaveBeenCalled();
    expect(fetchMock).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
    expect(storage.createSignedUrl).toHaveBeenCalledTimes(1);
  });

  it('scopes the duplicate lookup to the caller\'s org', async () => {
    const minted = await mintVideo();
    stubHeadBytes(mp4Head());

    await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Walkthrough',
      description: '',
    });

    expect(mockPrisma.attachment.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          storage_path: minted.body.upload.path,
          organization_id: ALPHA_ORG_ID,
        }),
      }),
    );
  });
});

// ─── 3. The memory bound, stated as a behaviour ──────────

describe('the direct routes cannot be made to buffer a file', () => {
  /**
   * The fail-closed guard in `readStoredObjectHead`, which is the single line standing
   * between this process and a large video in its heap.
   *
   * Storage is not obliged to honour a Range request. If it answers 200 with the WHOLE
   * object, reading that body is exactly the memory profile the direct path exists to
   * eliminate — and it would look like a success, because the sniff would pass on bytes that
   * are genuinely the file's.
   *
   * The primary assertion is that `arrayBuffer` was never called. The status is also asserted
   * and would also catch the guard's removal, but it is the weaker instrument: it observes a
   * consequence, where the spy observes the property itself.
   */
  it('refuses a full-object 200 instead of reading it, when storage ignores the Range', async () => {
    const minted = await mintVideo();
    storage.info.mockResolvedValue({ data: { size: 40 * MB, contentType: 'video/mp4' }, error: null });
    // Range ignored: a 200 carrying the entire 40MB object, whose leading bytes are a
    // perfectly valid mp4 head — so nothing but the guard can reject this.
    const fetchMock = stubHeadBytes(mp4Head(), { status: 200, contentLength: 40 * MB });

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Walkthrough',
      description: '',
    });

    // Never read. This is the assertion the guard exists for.
    expect(fetchMock.arrayBufferSpy).not.toHaveBeenCalled();
    // And the request was aborted rather than left streaming in the background.
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(true);
    // Storage ignoring a Range is OUR side failing, not the user's file being wrong, so it
    // reads as 502 and the object survives — see the infrastructure-split suite above.
    expect(res.status).toBe(502);
    expect(mockPrisma.attachment.create).not.toHaveBeenCalled();
    expect(storage.remove).not.toHaveBeenCalled();
  });

  it('reads the body when storage DOES honour the Range — the control for that guard', async () => {
    const minted = await mintVideo();
    storage.info.mockResolvedValue({ data: { size: 40 * MB, contentType: 'video/mp4' }, error: null });
    const fetchMock = stubHeadBytes(mp4Head(8192), { status: 206, contentLength: 8192 });

    const res = await complete({
      ticket: minted.body.upload.ticket,
      display_name: 'Walkthrough',
      description: '',
    });

    expect(res.status).toBe(201);
    expect(fetchMock.arrayBufferSpy).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][1].signal.aborted).toBe(false);
  });

  /**
   * CHARACTERISATION, not test-first: `express.json({ limit: '1mb' })` predates this slice.
   * It is asserted here because it is the concrete half of "the app server never holds the
   * file". Neither direct route has any multipart middleware — the proxy route's 60MB multer
   * ceiling does not exist on them — so the largest body either can be handed is 1MB, and a
   * 512MB video has nowhere to land in this process even if a client tries to post it.
   *
   * The status is asserted as "some 4xx/5xx, and nothing was minted" rather than 413 because
   * body-parser's PayloadTooLargeError currently falls through to the blanket 500 in app.ts —
   * the same shape as the MulterError fall-through that this PRD's origin bug came from, and
   * fixed on its own branch rather than here. Pinning 413 would be asserting a fix this slice
   * does not make; pinning 500 would cement the wrong status. What matters for THIS slice is
   * the memory bound: the request is refused and no upload is started.
   */
  it('refuses a body larger than the JSON limit instead of buffering it', async () => {
    const res = await request(app)
      .post(`/api/attachments/job/${JOB_ID}/direct-upload`)
      .set(authHeader('admin'))
      .send({ file_name: 'a'.repeat(2 * MB), content_type: 'video/mp4', file_size: MB });

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(storage.createSignedUploadUrl).not.toHaveBeenCalled();
    expect(mockPrisma.attachment.create).not.toHaveBeenCalled();
  });
});

// ─── 4. Nothing user-visible names the storage vendor ────

describe('the new path keeps vendor names out of user-visible copy', () => {
  it('never puts a vendor name in an error body', async () => {
    const attempts = [
      await mintVideo({ content_type: 'image/jpeg' }),
      await mintVideo({ file_size: 999 * MB }),
      await mint({ file_name: '', content_type: 'video/mp4', file_size: 1 }),
    ];

    for (const res of attempts) {
      expect(JSON.stringify(res.body)).not.toMatch(/supabase|render\.com|calltrackingmetrics|\bCTM\b/i);
    }
  });

  it('does not repeat the storage service\'s own wording when minting fails', async () => {
    storage.createSignedUploadUrl.mockResolvedValue({
      data: null,
      error: { statusCode: '500', error: 'InternalError', message: 'supabase storage: upstream unavailable' },
    });

    const res = await mintVideo();

    expect(res.status).toBeGreaterThanOrEqual(400);
    expect(JSON.stringify(res.body)).not.toMatch(/supabase/i);
    expect(res.body.error).toBeTruthy();
  });
});
