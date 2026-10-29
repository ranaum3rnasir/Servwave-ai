import { describe, it, expect, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { runUnscoped } from '../tenant-context';
import { parseLegacyPublicUrlPath } from '../attachment-access';
import {
  ATTACHMENT_OWNED_SEGMENTS,
  KNOWN_FOREIGN_SEGMENTS,
  DEFAULT_GRACE_HOURS,
  MIN_GRACE_HOURS,
  RESUMABLE_UPLOAD_WINDOW_HOURS,
  assertCrossOrgBypassInEffect,
  assertDatabaseMatchesStorage,
  assertNoOwnedForeignCollision,
  classifyObjectPath,
  discoverOrgPrefixes,
  listObjectsUnderPrefix,
  loadKnownAttachmentPaths,
  removeOrphanObjects,
  resolveRowObjectPath,
  runOrphanSweepForOrg,
  type StorageEntry,
  type SweepStorage,
} from '../attachment-orphan-sweep';

/**
 * S3 — orphan reconciliation.
 *
 * This suite guards a DELETER that runs against a production bucket, so the bias of every
 * assertion is towards "did NOT delete". The four behaviours whose absence destroys customer
 * data each have a dedicated test and were each verified by mutation:
 *
 *   1. whole-SEGMENT ownership matching (a `startsWith` sweeps job_stage + three estimate_*)
 *   2. legacy `storage_path = NULL` rows resolved from their public `file_url`
 *   3. the grace-window comparison
 *   4. the `runUnscoped` wrapper round the cross-org row read
 *
 * tenant-context is left REAL throughout: the bypass assertion has to be tested against actual
 * AsyncLocalStorage propagation, not a spy that would pass with the wrapper deleted.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */

const ORG_A = 'aaaaaaaa-0000-4000-8000-000000000001';
const ORG_B = 'bbbbbbbb-0000-4000-8000-000000000002';
const ENTITY = '11111111-0000-4000-8000-0000000000ff';
/** Matches the host in `publicUrl()` below — the fake project this suite pretends to be. */
const STORAGE_HOST = 'test.supabase.co';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-09-18T12:00:00.000Z');

/** An object that landed `hoursAgo` before NOW. */
function aged(name: string, hoursAgo: number, size = 1024): StorageEntry {
  return {
    name,
    id: `obj-${name}`,
    created_at: new Date(NOW.getTime() - hoursAgo * HOUR).toISOString(),
    updated_at: null,
    metadata: { size },
  };
}

/** A Supabase "folder" row — `id: null` is how the SDK signals a prefix, not an object. */
function folder(name: string): StorageEntry {
  return { name, id: null, created_at: null, updated_at: null, metadata: null };
}

/**
 * A fake bucket built from a flat map of full path -> entry, exposing the same
 * non-recursive, offset-paginated `list` the storage SDK does. `pageSize` is deliberately
 * settable so the pagination tests can force more than one page without 100 fixtures.
 */
function makeStorage(
  objects: Record<string, StorageEntry>,
  opts: { pageSize?: number; removeError?: string } = {},
): SweepStorage & { listCalls: string[]; removed: string[][] } {
  const pageSize = opts.pageSize ?? 1000;
  const listCalls: string[] = [];
  const removed: string[][] = [];

  return {
    listCalls,
    removed,
    async list(prefix: string, { limit, offset }: { limit: number; offset: number }) {
      listCalls.push(`${prefix}@${offset}`);
      const base = prefix === '' ? '' : `${prefix}/`;
      const children = new Map<string, StorageEntry>();
      for (const [full, entry] of Object.entries(objects)) {
        if (!full.startsWith(base)) continue;
        const rest = full.slice(base.length);
        if (rest === '') continue;
        const slash = rest.indexOf('/');
        if (slash === -1) children.set(rest, { ...entry, name: rest });
        else {
          const dir = rest.slice(0, slash);
          if (!children.has(dir)) children.set(dir, folder(dir));
        }
      }
      const all = [...children.values()].sort((a, b) => a.name.localeCompare(b.name));
      const effective = Math.min(limit, pageSize);
      return { data: all.slice(offset, offset + effective), error: null };
    },
    async remove(paths: string[]) {
      removed.push(paths);
      if (opts.removeError) return { data: null, error: { message: opts.removeError } };
      return { data: paths.map((p) => ({ name: p })), error: null };
    },
  };
}

type Row = { id: string; organization_id: string; storage_path: string | null; file_url: string };

function makePrisma(rows: Row[], orgs: Array<{ id: string; name: string }> = []) {
  return {
    attachment: { findMany: vi.fn(async () => rows) },
    organization: { findMany: vi.fn(async () => orgs) },
  } as unknown as PrismaClient;
}

function publicUrl(path: string): string {
  return `https://test.supabase.co/storage/v1/object/public/attachments/${path}`;
}

// ───────────────────────────────────────────────────────────────────────────
// A. Ownership is decided on a WHOLE path segment, never a prefix
// ───────────────────────────────────────────────────────────────────────────

describe('classifyObjectPath — whole-segment ownership', () => {
  // `task` joined with files on a task (visits-and-task-categories slice 12): the sweep covers a
  // deleted task's leftover objects because the segment is derived from the enum.
  it('claims the six AttachmentEntity segments', () => {
    for (const seg of ['customer', 'lead', 'estimate', 'job', 'invoice', 'task']) {
      const c = classifyObjectPath(`${ORG_A}/${seg}/${ENTITY}/1750000000000-clip.mp4`, ORG_A);
      expect(c, seg).toMatchObject({ kind: 'owned', entitySegment: seg, entityId: ENTITY });
    }
  });

  // THE test this slice exists for. Every one of these begins with an owned segment as a
  // STRING; none of them is an owned SEGMENT. A `startsWith` implementation deletes all five.
  it.each([
    ['job_stage', `${ORG_A}/job_stage/${ENTITY}/1750000000000-photo.jpg`],
    ['estimate_scope', `${ORG_A}/estimate_scope/${ENTITY}/${ENTITY}/photo.jpg`],
    ['estimate_line_item', `${ORG_A}/estimate_line_item/${ENTITY}/photo.jpg`],
    ['estimate_version', `${ORG_A}/estimate_version/${ENTITY}/${ENTITY}/photo.jpg`],
    ['invoices_archive', `${ORG_A}/invoices_archive/${ENTITY}/x.pdf`],
  ])('does NOT claim %s — it merely starts with an owned segment', (_label, path) => {
    expect(classifyObjectPath(path, ORG_A).kind).not.toBe('owned');
  });

  it.each([
    ['user_profile_photo', `${ORG_A}/user_profile_photo/${ENTITY}/1-avatar.jpg`],
    ['asset', `${ORG_A}/asset/${ENTITY}/1-a.jpg`],
    ['email', `${ORG_A}/email/${ENTITY}/1-a.pdf`],
  ])('does NOT claim the unrelated subsystem %s', (_label, path) => {
    expect(classifyObjectPath(path, ORG_A).kind).toBe('foreign');
  });

  it('refuses a path rooted in another org', () => {
    expect(classifyObjectPath(`${ORG_B}/job/${ENTITY}/x.mp4`, ORG_A).kind).toBe('other-org');
  });

  it.each([
    ['too shallow', `${ORG_A}/job/x.mp4`],
    ['too deep', `${ORG_A}/job/${ENTITY}/nested/x.mp4`],
    ['non-uuid entity id', `${ORG_A}/job/not-a-uuid/x.mp4`],
    ['empty filename', `${ORG_A}/job/${ENTITY}/`],
  ])('treats an unrecognised shape (%s) as NOT owned', (_label, path) => {
    expect(classifyObjectPath(path, ORG_A).kind).toBe('unrecognised');
  });

  it("never claims Supabase's own empty-folder placeholder", () => {
    const p = `${ORG_A}/job/${ENTITY}/.emptyFolderPlaceholder`;
    expect(classifyObjectPath(p, ORG_A).kind).toBe('unrecognised');
  });
});

describe('owned-segment set', () => {
  it('is derived from AttachmentEntity, lowercased', () => {
    expect([...ATTACHMENT_OWNED_SEGMENTS].sort()).toEqual([
      'customer',
      'estimate',
      'invoice',
      'job',
      'lead',
      'task',
    ]);
  });

  // A tripwire, not a tautology: if AttachmentEntity ever gains a value that collides with a
  // segment another subsystem already writes, the sweep must refuse to run rather than adopt
  // that subsystem's objects.
  it('is disjoint from every known foreign segment', () => {
    expect(() => assertNoOwnedForeignCollision()).not.toThrow();
    for (const seg of KNOWN_FOREIGN_SEGMENTS) {
      expect(ATTACHMENT_OWNED_SEGMENTS.has(seg), seg).toBe(false);
    }
  });

  it('refuses when a foreign segment is claimed as owned', () => {
    expect(() => assertNoOwnedForeignCollision(new Set(['job', 'email']))).toThrow(/email/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// B. Legacy rows carry no storage_path — their object must still be protected
// ───────────────────────────────────────────────────────────────────────────

describe('parseLegacyPublicUrlPath', () => {
  it('recovers the bucket path from a public URL', () => {
    expect(parseLegacyPublicUrlPath(publicUrl(`${ORG_A}/job/${ENTITY}/old.pdf`), 'attachments'))
      .toBe(`${ORG_A}/job/${ENTITY}/old.pdf`);
  });

  it('url-decodes the recovered path', () => {
    expect(parseLegacyPublicUrlPath(publicUrl(`${ORG_A}/job/${ENTITY}/my%20file.pdf`), 'attachments'))
      .toBe(`${ORG_A}/job/${ENTITY}/my file.pdf`);
  });

  it('returns null for a URL that is not a public object URL for this bucket', () => {
    expect(parseLegacyPublicUrlPath('https://test.supabase.co/storage/v1/object/public/org-assets/x.png', 'attachments')).toBeNull();
    expect(parseLegacyPublicUrlPath('', 'attachments')).toBeNull();
    expect(parseLegacyPublicUrlPath('not a url at all', 'attachments')).toBeNull();
  });
});

// ───────────────────────────────────────────────────────────────────────────
// C. The cross-org row read must run under runUnscoped or it silently reads nothing
// ───────────────────────────────────────────────────────────────────────────

describe('cross-org bypass', () => {
  it('throws when there is no tenant context at all', () => {
    expect(() => assertCrossOrgBypassInEffect()).toThrow(/bypass/i);
  });

  it('passes inside runUnscoped', () => {
    expect(() => runUnscoped(() => assertCrossOrgBypassInEffect())).not.toThrow();
  });

  // The mutation-killer: this is called with NO ambient context, so it can only succeed if
  // loadKnownAttachmentPaths establishes runUnscoped itself.
  it('loadKnownAttachmentPaths establishes the bypass on its own', async () => {
    const prisma = makePrisma([
      { id: 'r1', organization_id: ORG_A, storage_path: `${ORG_A}/job/${ENTITY}/a.mp4`, file_url: '' },
    ]);
    const known = await loadKnownAttachmentPaths({ prisma });
    expect(known.paths.has(`${ORG_A}/job/${ENTITY}/a.mp4`)).toBe(true);
    expect(known.unresolved).toEqual([]);
  });

  it('resolves a legacy NULL-storage_path row through its public file_url', async () => {
    const legacy = `${ORG_A}/job/${ENTITY}/legacy.pdf`;
    const prisma = makePrisma([
      { id: 'r1', organization_id: ORG_A, storage_path: null, file_url: publicUrl(legacy) },
    ]);
    const known = await loadKnownAttachmentPaths({ prisma });
    expect(known.paths.has(legacy)).toBe(true);
    expect(known.unresolved).toEqual([]);
  });

  // Measured on live staging: 7 seed rows carry a file_url on pdfobject.com / w3.org /
  // loremflickr.com. A URL on a host that is not our storage cannot name an object in our
  // bucket under ANY path, so it is not ambiguous — it is simply not ours. Treating it as
  // unresolvable refused all 13 staging orgs and swept nothing.
  it('treats a file_url on a foreign host as external, not unresolvable', async () => {
    const prisma = makePrisma([
      { id: 'seed1', organization_id: ORG_A, storage_path: null, file_url: 'https://loremflickr.com/800/600/door/all?lock=11' },
      { id: 'seed2', organization_id: ORG_A, storage_path: null, file_url: 'https://pdfobject.com/pdf/sample.pdf' },
    ]);
    const known = await loadKnownAttachmentPaths({ prisma }, { storageHost: STORAGE_HOST });
    expect(known.unresolved).toEqual([]);
    // Per HOST, not a bare count. On staging this prints third-party seed hosts and an
    // operator nods; in prod, `<old-project-ref>.supabase.co: 412` is the line that stops them.
    expect(known.external).toEqual({ 'loremflickr.com': 1, 'pdfobject.com': 1 });
  });

  // The genuinely ambiguous case: it IS on our storage host, but not in a shape this parser
  // understands (a signed URL, say). That row's object could be anywhere in the bucket.
  // The refusal message is the only thing an operator gets, and the different-host case is
  // the newest and least expected guard. Being told "neither a storage_path nor a parseable
  // file_url" about a URL that looks perfectly parseable, with no mention of the host, sends
  // them looking in the wrong place entirely.
  it('carries the per-row reason through to the refusal, naming the host', async () => {
    const url = `https://someotherref.supabase.co/storage/v1/object/public/attachments/${ORG_A}/job/${ENTITY}/x.pdf`;
    const prisma = makePrisma([
      { id: 'moved', organization_id: ORG_A, storage_path: null, file_url: url },
    ]);
    const known = await loadKnownAttachmentPaths({ prisma }, { storageHost: STORAGE_HOST });
    expect(known.unresolved[0]?.reason).toMatch(/someotherref\.supabase\.co/);

    // `DIFFERENT host`, not the hostname: the hostname also appears in the `file_url` this
    // refusal echoes, so matching on it passes even when the reason is dropped from the
    // printed message — which is how the reason reached the struct but never the screen.
    // This phrase exists ONLY in the reason.
    await expect(
      sweep({ [`${ORG_A}/job/${ENTITY}/x.pdf`]: aged('x.pdf', 9999) }, [
        { id: 'moved', organization_id: ORG_A, storage_path: null, file_url: url },
      ]),
    ).rejects.toThrow(/DIFFERENT host/);
  });

  it('reports a URL on OUR storage host that it cannot parse as unresolvable', async () => {
    const prisma = makePrisma([
      { id: 'broken', organization_id: ORG_A, storage_path: null, file_url: `https://${STORAGE_HOST}/storage/v1/object/sign/attachments/x?token=y` },
    ]);
    const known = await loadKnownAttachmentPaths({ prisma }, { storageHost: STORAGE_HOST });
    expect(known.unresolved.map((r) => r.id)).toEqual(['broken']);
  });

  it('reports a row with neither a storage_path nor any file_url as unresolvable', async () => {
    const prisma = makePrisma([
      { id: 'empty', organization_id: ORG_A, storage_path: null, file_url: '' },
    ]);
    const known = await loadKnownAttachmentPaths({ prisma }, { storageHost: STORAGE_HOST });
    expect(known.unresolved.map((r) => r.id)).toEqual(['empty']);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// M1 — the protected set can be silently SHORT, and only these notice
// ───────────────────────────────────────────────────────────────────────────

describe('a legacy URL on a DIFFERENT host that is still our storage product', () => {
  // The dangerous case is not an unparseable SUPABASE_URL (that fails safe) but a VALID,
  // different one: a project migration, a custom storage domain, a CDN. The row would take
  // the `external` branch, never join `paths`, and its object — which IS in the bucket under
  // the same key — would classify as owned, miss the set, and be deleted. Silent and total,
  // on precisely the irreplaceable rows. This repo has already done one project cutover.
  const OTHER = 'someotherref.supabase.co';
  const url = `https://${OTHER}/storage/v1/object/public/attachments/${ORG_A}/job/${ENTITY}/legacy.pdf`;

  it('is NOT treated as external — the path shape proves it is our storage, elsewhere', () => {
    const r = resolveRowObjectPath({ storage_path: null, file_url: url }, STORAGE_HOST, 'attachments');
    expect(r.kind).toBe('unresolved');
  });

  it('refuses the org rather than silently unprotecting its legacy objects', async () => {
    const obj = `${ORG_A}/job/${ENTITY}/legacy.pdf`;
    await expect(
      sweep({ [obj]: aged('legacy.pdf', 9999) }, [
        { id: 'moved', organization_id: ORG_A, storage_path: null, file_url: url },
      ]),
    ).rejects.toThrow(/moved/);
  });

  it('still treats a genuinely third-party host as external', () => {
    const r = resolveRowObjectPath(
      { storage_path: null, file_url: 'https://loremflickr.com/800/600/door' },
      STORAGE_HOST,
      'attachments',
    );
    expect(r.kind).toBe('external');
  });
});

describe('the protected set must be plausible before anything is condemned', () => {
  // The ONLY thing protecting Attachment's own objects is membership in known.paths. If that
  // set comes back short for any reason, every object past the grace window is condemned and
  // the report says so confidently. A local DATABASE_URL pointed at a remote SUPABASE_URL is
  // an ordinary dev setup and produces exactly this.
  // These bypass the ballast row on purpose — an empty database IS the condition under test.
  const bare = (objects: Record<string, StorageEntry>) =>
    runOrphanSweepForOrg(
      { prisma: makePrisma([]), storage: makeStorage(objects) },
      { orgId: ORG_A, now: NOW, graceMs: GRACE_MS, dryRun: true },
    );

  it('refuses when there are zero attachment rows but the bucket holds owned objects', async () => {
    await expect(bare({ [`${ORG_A}/job/${ENTITY}/real.mp4`]: aged('real.mp4', 9999) }))
      .rejects.toThrow(/protected set is empty/i);
  });

  it('does not refuse an empty org in an empty database', async () => {
    expect((await bare({})).orphans).toEqual([]);
  });

  it('does not refuse when the bucket holds only other subsystems objects', async () => {
    expect((await bare({ [`${ORG_A}/email/${ENTITY}/x.pdf`]: aged('x.pdf', 9999) })).counters.foreign).toBe(1);
  });
});

describe('assertDatabaseMatchesStorage', () => {
  // scripts checked the STORAGE host and never the database. The two env vars are
  // independent, so a local Postgres beside a remote bucket passes the host check and
  // arrives with an empty protected set. Precedent: lib/e2e-org.ts, which refuses on a
  // DATABASE_URL project ref for a far less destructive tool.
  const STORAGE = 'https://abcdefghijklmnop.supabase.co';
  const MATCHING_DB = 'postgresql://postgres.abcdefghijklmnop:pw@aws-1-us-east-1.pooler.supabase.com:5432/postgres';
  const OTHER_DB = 'postgresql://postgres.zzzzzzzzzzzzzzzz:pw@aws-1-us-east-1.pooler.supabase.com:5432/postgres';
  const LOCAL_DB = 'postgresql://test:test@localhost:5432/test';

  it('passes when the database and the bucket are the same project', () => {
    expect(() => assertDatabaseMatchesStorage(MATCHING_DB, STORAGE, false)).not.toThrow();
  });

  it('accepts the direct db.<ref> host form too', () => {
    expect(() =>
      assertDatabaseMatchesStorage('postgresql://postgres:pw@db.abcdefghijklmnop.supabase.co:5432/postgres', STORAGE, false),
    ).not.toThrow();
  });

  it('refuses a database belonging to a DIFFERENT project, in dry-run too', () => {
    expect(() => assertDatabaseMatchesStorage(OTHER_DB, STORAGE, false)).toThrow(/different project/i);
    expect(() => assertDatabaseMatchesStorage(OTHER_DB, STORAGE, true)).toThrow(/different project/i);
  });

  it('refuses an unverifiable pairing when ARMED, and allows it in dry-run', () => {
    expect(() => assertDatabaseMatchesStorage(LOCAL_DB, STORAGE, false)).toThrow(/could not confirm/i);
    expect(() => assertDatabaseMatchesStorage(LOCAL_DB, STORAGE, true)).not.toThrow();
  });
});

describe('resolveRowObjectPath', () => {
  it.each([
    ['canonical storage_path wins', { storage_path: `${ORG_A}/job/${ENTITY}/a.mp4`, file_url: 'https://elsewhere/x' }, 'path'],
    ['legacy public url on our host', { storage_path: null, file_url: publicUrl(`${ORG_A}/job/${ENTITY}/a.pdf`) }, 'path'],
    ['foreign host', { storage_path: null, file_url: 'https://loremflickr.com/800/600/x' }, 'external'],
    ['our host, unparseable shape', { storage_path: null, file_url: `https://${STORAGE_HOST}/storage/v1/object/sign/attachments/x` }, 'unresolved'],
    ['no url at all', { storage_path: null, file_url: '' }, 'unresolved'],
    ['not a url', { storage_path: null, file_url: 'nonsense' }, 'unresolved'],
  ])('%s', (_label, row, expected) => {
    expect(
      resolveRowObjectPath(row as { storage_path: string | null; file_url: string }, STORAGE_HOST, 'attachments').kind,
    ).toBe(expected);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// D. Recursive, paginated listing — nothing in this repo had ever called .list()
// ───────────────────────────────────────────────────────────────────────────

describe('listObjectsUnderPrefix', () => {
  it('descends folders and returns full paths', async () => {
    const storage = makeStorage({
      [`${ORG_A}/job/${ENTITY}/a.mp4`]: aged('a.mp4', 200),
      [`${ORG_A}/email/${ENTITY}/b.pdf`]: aged('b.pdf', 200),
    });
    const found = (await listObjectsUnderPrefix(storage, ORG_A)).objects;
    expect(found.map((o) => o.path).sort()).toEqual([
      `${ORG_A}/email/${ENTITY}/b.pdf`,
      `${ORG_A}/job/${ENTITY}/a.mp4`,
    ]);
  });

  it('pages past the first page at every level', async () => {
    const objects: Record<string, StorageEntry> = {};
    for (let i = 0; i < 7; i += 1) {
      objects[`${ORG_A}/job/${ENTITY}/file-${String(i).padStart(2, '0')}.mp4`] = aged(`file-${i}.mp4`, 200);
    }
    const storage = makeStorage(objects, { pageSize: 2 });
    const found = (await listObjectsUnderPrefix(storage, ORG_A)).objects;
    expect(found).toHaveLength(7);
    // 4 pages for 7 entries at pageSize 2 (2+2+2+1, then a final empty page).
    const leafCalls = storage.listCalls.filter((c) => c.startsWith(`${ORG_A}/job/${ENTITY}@`));
    expect(leafCalls.length).toBeGreaterThan(1);
  });

  // Measured on live staging: 6 objects sit under two org prefixes whose Organization row no
  // longer exists. An org delete cascades every Attachment row away and leaves its objects in
  // the bucket, so those are the single largest batch of genuine orphans there is — and a
  // sweep that enumerates orgs from the DB can never see them. The prefixes must come from
  // STORAGE as well.
  it('discovers org prefixes from storage, including ones with no Organization row', async () => {
    const GONE = 'cccccccc-0000-4000-8000-000000000003';
    const storage = makeStorage({
      [`${ORG_A}/job/${ENTITY}/a.mp4`]: aged('a.mp4', 200),
      [`${GONE}/job/${ENTITY}/b.mp4`]: aged('b.mp4', 200),
    });
    expect((await discoverOrgPrefixes(storage)).sort()).toEqual([ORG_A, GONE].sort());
  });

  it('ignores top-level entries that are not org-shaped', async () => {
    const storage = makeStorage({
      [`${ORG_A}/job/${ENTITY}/a.mp4`]: aged('a.mp4', 200),
      'not-an-org/job/x.mp4': aged('x.mp4', 200),
      'stray-file-at-root.txt': aged('stray-file-at-root.txt', 200),
    });
    expect(await discoverOrgPrefixes(storage)).toEqual([ORG_A]);
  });

  it('refuses a root listing that never stops advancing rather than truncating it', async () => {
    // Same contract listObjectsUnderPrefix already had. A storage service that ignores
    // `offset` would otherwise hand back a silently short list of org prefixes.
    const stuck: SweepStorage = {
      async list() {
        return { data: [folder(ORG_A)], error: null };
      },
      async remove() {
        return { data: null, error: null };
      },
    };
    await expect(discoverOrgPrefixes(stuck)).rejects.toThrow(/pages/i);
  });

  it('surfaces a storage error rather than reporting an empty bucket', async () => {
    const storage: SweepStorage = {
      async list() {
        return { data: null, error: { message: 'boom' } };
      },
      async remove() {
        return { data: null, error: null };
      },
    };
    await expect(listObjectsUnderPrefix(storage, ORG_A)).rejects.toThrow(/boom/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// E. The sweep itself
// ───────────────────────────────────────────────────────────────────────────

const GRACE_MS = DEFAULT_GRACE_HOURS * HOUR;

/**
 * A row standing in for "the rest of the database". Without it every fixture would describe a
 * world with ZERO attachment rows anywhere, which the protected-set plausibility guard
 * correctly refuses — and rightly so: an environment worth sweeping always has rows. It
 * resolves to a path no fixture uses, so it protects nothing and changes no outcome.
 */
const BALLAST_ROW: Row = {
  id: 'ballast',
  organization_id: 'ffffffff-0000-4000-8000-00000000000f',
  storage_path: 'ffffffff-0000-4000-8000-00000000000f/job/11111111-0000-4000-8000-00000000000e/other.pdf',
  file_url: '',
};

async function sweep(
  objects: Record<string, StorageEntry>,
  rows: Row[],
  opts: { dryRun?: boolean; graceMs?: number; orgId?: string } = {},
) {
  const storage = makeStorage(objects);
  const prisma = makePrisma([...rows, BALLAST_ROW]);
  const result = await runOrphanSweepForOrg(
    { prisma, storage },
    {
      orgId: opts.orgId ?? ORG_A,
      now: NOW,
      graceMs: opts.graceMs ?? GRACE_MS,
      dryRun: opts.dryRun ?? true,
    },
  );
  return { result, storage };
}

describe('runOrphanSweepForOrg', () => {
  it('sweeps an object that was uploaded but never recorded, once past the grace window', async () => {
    const orphan = `${ORG_A}/job/${ENTITY}/1750000000000-lost.mp4`;
    const { result } = await sweep({ [orphan]: aged('lost.mp4', DEFAULT_GRACE_HOURS + 1) }, []);
    expect(result.orphans.map((o) => o.path)).toEqual([orphan]);
  });

  // Acceptance criterion, stated with the hard case: the row's object is OLDER than the grace
  // window, so age alone would condemn it. Only the join saves it.
  it('never sweeps an object that belongs to a real attachment, however old', async () => {
    const live = `${ORG_A}/job/${ENTITY}/1700000000000-real.mp4`;
    const { result } = await sweep(
      { [live]: aged('real.mp4', DEFAULT_GRACE_HOURS * 10) },
      [{ id: 'r1', organization_id: ORG_A, storage_path: live, file_url: '' }],
    );
    expect(result.orphans).toEqual([]);
    expect(result.counters.matchedToRow).toBe(1);
  });

  // Same, for the legacy shape. This row has NO storage_path; only the file_url parser saves it.
  it('never sweeps a legacy NULL-storage_path attachment, however old', async () => {
    const live = `${ORG_A}/job/${ENTITY}/1600000000000-legacy.pdf`;
    const { result } = await sweep(
      { [live]: aged('legacy.pdf', DEFAULT_GRACE_HOURS * 10) },
      [{ id: 'r1', organization_id: ORG_A, storage_path: null, file_url: publicUrl(live) }],
    );
    expect(result.orphans).toEqual([]);
    expect(result.counters.matchedToRow).toBe(1);
  });

  it('refuses the org when one of ITS OWN rows has an unresolvable path', async () => {
    const orphan = `${ORG_A}/job/${ENTITY}/1750000000000-lost.mp4`;
    await expect(
      sweep({ [orphan]: aged('lost.mp4', DEFAULT_GRACE_HOURS + 1) }, [
        { id: 'broken', organization_id: ORG_A, storage_path: null, file_url: `https://${STORAGE_HOST}/storage/v1/object/sign/attachments/x` },
      ]),
    ).rejects.toThrow(/broken/);
  });

  // Measured on live staging: 7 unresolvable seed rows in ONE org refused all 13 orgs and the
  // run swept nothing. A row cannot name an object outside its own org's prefix — the path
  // builder puts the row's org id at the front of every key — so the blast radius of an
  // unresolvable row is exactly its own org.
  it('does NOT refuse an org because some OTHER org has an unresolvable row', async () => {
    const orphan = `${ORG_A}/job/${ENTITY}/1750000000000-lost.mp4`;
    const { result } = await sweep({ [orphan]: aged('lost.mp4', DEFAULT_GRACE_HOURS + 1) }, [
      { id: 'broken', organization_id: ORG_B, storage_path: null, file_url: `https://${STORAGE_HOST}/storage/v1/object/sign/attachments/x` },
    ]);
    expect(result.orphans.map((o) => o.path)).toEqual([orphan]);
  });

  it('leaves an in-flight upload inside the grace window alone', async () => {
    const inflight = `${ORG_A}/job/${ENTITY}/1750000000000-uploading.mp4`;
    const { result } = await sweep({ [inflight]: aged('uploading.mp4', 1) }, []);
    expect(result.orphans).toEqual([]);
    expect(result.counters.withinGrace).toBe(1);
  });

  it('leaves an object exactly at the grace boundary alone', async () => {
    const edge = `${ORG_A}/job/${ENTITY}/1750000000000-edge.mp4`;
    const { result } = await sweep({ [edge]: aged('edge.mp4', DEFAULT_GRACE_HOURS) }, []);
    expect(result.orphans).toEqual([]);
    expect(result.counters.withinGrace).toBe(1);
  });

  it('leaves an object with no readable timestamp alone, and says so', async () => {
    const undated = `${ORG_A}/job/${ENTITY}/1750000000000-undated.mp4`;
    const entry: StorageEntry = { ...aged('undated.mp4', 500), created_at: null };
    const { result } = await sweep({ [undated]: entry }, []);
    expect(result.orphans).toEqual([]);
    expect(result.counters.undated).toBe(1);
  });

  it('leaves every other subsystem in the shared bucket untouched', async () => {
    const foreign = {
      [`${ORG_A}/job_stage/${ENTITY}/old.jpg`]: aged('old.jpg', 9999),
      [`${ORG_A}/estimate_scope/${ENTITY}/${ENTITY}/old.jpg`]: aged('old.jpg', 9999),
      [`${ORG_A}/estimate_version/${ENTITY}/${ENTITY}/old.jpg`]: aged('old.jpg', 9999),
      [`${ORG_A}/user_profile_photo/${ENTITY}/old.jpg`]: aged('old.jpg', 9999),
      [`${ORG_A}/email/${ENTITY}/old.pdf`]: aged('old.pdf', 9999),
      [`${ORG_A}/asset/${ENTITY}/old.jpg`]: aged('old.jpg', 9999),
    };
    const { result } = await sweep(foreign, []);
    expect(result.orphans).toEqual([]);
    expect(result.counters.foreign).toBe(6);
  });

  it('only ever lists under its own org prefix', async () => {
    const { storage } = await sweep(
      {
        [`${ORG_A}/job/${ENTITY}/a.mp4`]: aged('a.mp4', 9999),
        [`${ORG_B}/job/${ENTITY}/b.mp4`]: aged('b.mp4', 9999),
      },
      [],
    );
    for (const call of storage.listCalls) {
      expect(call.startsWith(ORG_A), call).toBe(true);
    }
  });

  it('is protected by rows from OTHER orgs too — protection is never tenant-scoped', async () => {
    // A row mis-stored under org B but pointing into org A's prefix must still protect its
    // object. Deletion is scoped to one org; protection deliberately is not.
    const crossed = `${ORG_A}/job/${ENTITY}/crossed.mp4`;
    const { result } = await sweep({ [crossed]: aged('crossed.mp4', 9999) }, [
      { id: 'r1', organization_id: ORG_B, storage_path: crossed, file_url: '' },
    ]);
    expect(result.orphans).toEqual([]);
  });

  // The library default, asserted by OMITTING the option rather than passing it. Every other
  // test here passes `dryRun` explicitly, so without this one the default could be flipped to
  // `false` and the whole suite would stay green — which is exactly what happened when this
  // mutation was first run.
  it('defaults to a dry-run when the caller does not say', async () => {
    const orphan = `${ORG_A}/job/${ENTITY}/gone.mp4`;
    const storage = makeStorage({ [orphan]: aged('gone.mp4', 9999) });
    const result = await runOrphanSweepForOrg(
      { prisma: makePrisma([BALLAST_ROW]), storage },
      { orgId: ORG_A, now: NOW, graceMs: GRACE_MS },
    );
    expect(result.dryRun).toBe(true);
    expect(result.orphans).toHaveLength(1);
    expect(storage.removed).toEqual([]);
  });

  it('deletes nothing in dry-run, which is what the caller gets by default', async () => {
    const orphan = `${ORG_A}/job/${ENTITY}/gone.mp4`;
    const { result, storage } = await sweep({ [orphan]: aged('gone.mp4', 9999) }, [], { dryRun: true });
    expect(result.orphans).toHaveLength(1);
    expect(storage.removed).toEqual([]);
    expect(result.removed).toEqual([]);
    expect(result.dryRun).toBe(true);
  });

  it('removes exactly the orphans when armed, and reports every path it removed', async () => {
    const orphan = `${ORG_A}/job/${ENTITY}/gone.mp4`;
    const live = `${ORG_A}/job/${ENTITY}/stay.mp4`;
    const { result, storage } = await sweep(
      { [orphan]: aged('gone.mp4', 9999), [live]: aged('stay.mp4', 9999) },
      [{ id: 'r1', organization_id: ORG_A, storage_path: live, file_url: '' }],
      { dryRun: false },
    );
    expect(storage.removed).toEqual([[orphan]]);
    expect(result.removed).toEqual([orphan]);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// F. The deleter's own last-line guard
// ───────────────────────────────────────────────────────────────────────────

// ───────────────────────────────────────────────────────────────────────────
// E2. Guards the sweep must actually INVOKE, not merely contain
// ───────────────────────────────────────────────────────────────────────────

describe('guards invoked by runOrphanSweepForOrg', () => {
  // Survivor found in review: deleting the `assertNoOwnedForeignCollision()` CALL from the
  // sweep left every test green, because only the function's own body was covered. That
  // tripwire is the only thing that would catch a future AttachmentEntity.JOB_STAGE quietly
  // making job-stage photos deletable, so the call site needs its own assertion.
  it('runs the owned/foreign collision tripwire BEFORE listing anything', async () => {
    const owned = ATTACHMENT_OWNED_SEGMENTS as Set<string>;
    owned.add('email'); // simulate AttachmentEntity gaining a colliding value
    try {
      const storage = makeStorage({});
      await expect(
        runOrphanSweepForOrg(
          { prisma: makePrisma([]), storage },
          { orgId: ORG_A, now: NOW, graceMs: GRACE_MS, dryRun: true },
        ),
      ).rejects.toThrow(/email/);
      expect(storage.listCalls).toEqual([]);
    } finally {
      owned.delete('email');
    }
  });

  // Survivor found in review: swapping the library's graceMs fallback from DEFAULT_GRACE_HOURS
  // (168h) to MIN_GRACE_HOURS (48h) left every test green, because the CLI always passes
  // graceMs explicitly. 100h sits between the two, so only the real default keeps this object.
  it('defaults the grace window to 7 days, not to the 48h floor', async () => {
    const obj = `${ORG_A}/job/${ENTITY}/x.mp4`;
    const result = await runOrphanSweepForOrg(
      { prisma: makePrisma([BALLAST_ROW]), storage: makeStorage({ [obj]: aged('x.mp4', 100) }) },
      { orgId: ORG_A, now: NOW, dryRun: true },
    );
    expect(result.orphans).toEqual([]);
    expect(result.counters.withinGrace).toBe(1);
  });

  it('reports prefixes it stopped descending into instead of dropping them silently', async () => {
    const deep = `${ORG_A}/job/${ENTITY}/a/b/c/d/e/f/g/h/deep.mp4`;
    const result = await runOrphanSweepForOrg(
      { prisma: makePrisma([]), storage: makeStorage({ [deep]: aged('deep.mp4', 9999) }) },
      { orgId: ORG_A, now: NOW, graceMs: GRACE_MS, dryRun: true },
    );
    expect(result.orphans).toEqual([]);
    expect(result.deepPrefixesSkipped.length).toBeGreaterThan(0);
  });
});

describe('removeOrphanObjects', () => {
  it('refuses a batch containing anything it does not own, before calling storage', async () => {
    const storage = makeStorage({});
    await expect(
      removeOrphanObjects(storage, ORG_A, [
        `${ORG_A}/job/${ENTITY}/ok.mp4`,
        `${ORG_A}/email/${ENTITY}/not-ours.pdf`,
      ]),
    ).rejects.toThrow(/not-ours/);
    expect(storage.removed).toEqual([]);
  });

  it('refuses a batch containing another org’s path, before calling storage', async () => {
    const storage = makeStorage({});
    await expect(
      removeOrphanObjects(storage, ORG_A, [`${ORG_B}/job/${ENTITY}/x.mp4`]),
    ).rejects.toThrow(/x\.mp4/);
    expect(storage.removed).toEqual([]);
  });

  it('reports what storage says it removed, not what it was asked to remove', async () => {
    // A partial success is indistinguishable from a total one if you just echo the request,
    // and this report is the only record that a delete happened.
    const gone = `${ORG_A}/job/${ENTITY}/gone.mp4`;
    const stuck = `${ORG_A}/job/${ENTITY}/stuck.mp4`;
    const storage: SweepStorage = {
      async list() {
        return { data: [], error: null };
      },
      async remove() {
        return { data: [{ name: gone }], error: null };
      },
    };
    const out = await removeOrphanObjects(storage, ORG_A, [gone, stuck]);
    expect(out.removed).toEqual([gone]);
    expect(out.failed.map((f) => f.path)).toEqual([stuck]);
  });

  it('writes the manifest before the first delete, never after', async () => {
    // There is no restore, so the list of keys is the most valuable thing the run produces.
    // It has to exist on disk before anything is destroyed, not after.
    const orphan = `${ORG_A}/job/${ENTITY}/gone.mp4`;
    const order: string[] = [];
    const storage = makeStorage({ [orphan]: aged('gone.mp4', 9999) });
    const wrapped: SweepStorage = {
      list: storage.list.bind(storage),
      async remove(paths) {
        order.push('remove');
        return storage.remove(paths);
      },
    };
    await runOrphanSweepForOrg(
      { prisma: makePrisma([BALLAST_ROW]), storage: wrapped },
      {
        orgId: ORG_A,
        now: NOW,
        graceMs: GRACE_MS,
        dryRun: false,
        beforeDelete: async (paths) => {
          order.push(`manifest:${paths.length}`);
        },
      },
    );
    expect(order).toEqual(['manifest:1', 'remove']);
  });

  it('reports a storage failure instead of claiming the delete succeeded', async () => {
    const storage = makeStorage({}, { removeError: 'permission denied' });
    const out = await removeOrphanObjects(storage, ORG_A, [`${ORG_A}/job/${ENTITY}/x.mp4`]);
    expect(out.removed).toEqual([]);
    expect(out.failed).toHaveLength(1);
    expect(out.failed[0]?.reason).toMatch(/permission denied/);
  });
});

// ───────────────────────────────────────────────────────────────────────────
// G. The grace window's own floor
// ───────────────────────────────────────────────────────────────────────────

describe('grace window constants', () => {
  it('comfortably exceeds the resumable-upload window', () => {
    expect(MIN_GRACE_HOURS).toBeGreaterThanOrEqual(2 * RESUMABLE_UPLOAD_WINDOW_HOURS);
    expect(DEFAULT_GRACE_HOURS).toBeGreaterThanOrEqual(MIN_GRACE_HOURS);
  });

  it('refuses a grace window below the floor', async () => {
    await expect(
      sweep({}, [], { graceMs: (MIN_GRACE_HOURS - 1) * HOUR }),
    ).rejects.toThrow(/grace/i);
  });
});
