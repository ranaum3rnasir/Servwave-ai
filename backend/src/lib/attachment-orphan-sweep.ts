/**
 * Orphan reconciliation for the attachments bucket — core logic (direct-to-storage PRD, S3).
 * No CLI here; see scripts/attachment-orphan-sweep.ts for the invokable wrapper.
 *
 * WHAT THIS DELETES, AND WHY THE DEFINITION IS NARROW
 *
 * The direct upload path (S1) lets a client PUT bytes and then never call verify-and-record —
 * it closed the tab, lost signal, crashed, or our own verification read broke and we
 * deliberately left the object rather than destroy someone's upload over our outage. Those
 * objects are invisible to the app and billed forever. This sweep removes them.
 *
 * WHAT THIS DOES NOT DELETE, AND CANNOT
 *
 * S2 made the direct path CHUNKED, and an abandoned chunked transfer is not a stored object
 * at all — it is an incomplete upload held by the storage service. It never appears in a
 * bucket listing, so nothing in this file can find it, and no amount of tuning the grace
 * window changes that. It is a class of residue S2 introduced and this sweep does not cover.
 *
 * Four things produce one: the tab is closed, the retry budget runs out, the client's resume
 * record ages out, or the user cancels. Only the LAST has any cleanup — the client asks the
 * service to terminate the partial — and the service DOES honour that: measured live, the
 * DELETE answers 204 and `storage.s3_multipart_uploads` returns to the zero baseline taken
 * beforehand. It remains best effort in one respect: when the DELETE itself fails the client
 * keeps its resume record rather than discarding the only handle that could remove the
 * partial later. So: real cleanup on one of four causes, and nothing here as a backstop for
 * the other three. If in-progress uploads ever need reclaiming, that is a separate job
 * reading the service's own multipart state, not this one.
 *
 * THE WINDOW AN IN-FLIGHT UPLOAD ACTUALLY HAS
 *
 * The PRD's 24 hours is the storage service's upload-URL lifetime, and it is not the binding
 * constraint. The credential a resumable transfer writes with is the S1 signed token, whose
 * life is `DIRECT_UPLOAD_TTL_SECONDS` — two hours — and the client only honours a resume
 * record for 90 minutes before minting fresh (`RESUME_RECORD_MAX_AGE_MS`, in
 * `frontend/src/lib/attachments/resumableTransport.ts`, which is where that number is
 * argued). So the real window is under two hours, RESUMABLE_UPLOAD_WINDOW_HOURS below is a
 * large over-estimate of it, and the floor derived from it is a wide margin rather than a
 * tight one. The number to watch if this ever changes is the TICKET TTL, not the vendor's
 * URL lifetime.
 *
 * "A stored object with no matching Attachment row" is NOT a safe definition of that, and a
 * sweep built to it deletes live customer data for two independent reasons:
 *
 * 1. THE BUCKET IS SHARED. Several other subsystems write under the same `{orgId}/` root,
 *    each with a different SECOND path segment; `KNOWN_FOREIGN_SEGMENTS` below is the single
 *    authoritative list, so it is not re-counted in prose here or in the script. Only the
 *    `AttachmentEntity` segments (one per enum value) belong to `Attachment`. Ownership is therefore decided on a WHOLE SEGMENT and
 *    never on a string prefix: `job_stage` starts with `job`, and `estimate_scope`,
 *    `estimate_line_item` and `estimate_version` all start with `estimate`. A `startsWith`
 *    implementation sweeps four other subsystems' live photos.
 *
 *    The scope is an ALLOWLIST of what `Attachment` owns, not a denylist of known others. The
 *    writer list has already grown twice while this slice was being specified — when it was
 *    written `mint-estimate-version.ts` did not exist in the main checkout and now it does —
 *    and `estimate_line_item` is the mirror case: no longer written by any code, but its
 *    objects are still in the bucket. A denylist is wrong the moment someone adds a writer;
 *    an allowlist is merely incomplete, which costs storage instead of data.
 *
 * 2. LEGACY ROWS HAVE `storage_path = NULL`. They carry only a public `file_url`. Joining on
 *    `storage_path` alone classifies every one of their objects as an orphan, and those are
 *    real customer files. Their path is recovered with `parseLegacyPublicUrlPath` — the same
 *    parser `deleteAttachment` uses, deliberately shared rather than re-derived.
 *
 *    TWO independent things have to agree before a legacy object can be deleted, which is
 *    worth knowing because it is not obvious from either one. The parser is the first. The
 *    second is `classifyObjectPath`: an object is only ever a candidate if it ALSO matches
 *    `{orgId}/{ownedSegment}/{uuid}/{file}` exactly, so an object written under any older
 *    naming scheme classifies as `unrecognised` and survives even if no row resolves to it.
 *    That is a real second layer, arrived at by making unknown shapes non-deletable rather
 *    than by aiming at legacy data — so do not weaken the shape check on the grounds that it
 *    only rejects oddities.
 *
 * PROTECTION IS NOT TENANT-SCOPED, DELETION IS. The set of protected paths is built from
 * EVERY org's rows in one cross-org read; the objects considered for deletion come only from
 * one org's prefix. The asymmetry is intentional: scoping the deletion is what stops the sweep
 * crossing a tenant boundary, and scoping the protection would only ever cause a row in org B
 * to fail to protect an object it points at in org A.
 *
 * THAT CROSS-ORG READ MUST RUN UNDER `runUnscoped`. With DB_TENANT_GUARD=on a standalone
 * script has no request context, `tenantConfigValues()` returns neither session var, the RLS
 * policies fail CLOSED, and the read comes back EMPTY — which this sweep would then interpret
 * as "no attachment rows exist, every object is an orphan". That is the single worst failure
 * this file can have, so `assertCrossOrgBypassInEffect()` is checked INSIDE the same wrapper
 * as the query. Reading the context afterwards would prove nothing about the context the
 * query ran in. Precedent and rationale: scripts/estimate-container-backfill.ts.
 *
 * PENDING ROWS vs PURE RECONCILIATION — decided: PURE RECONCILIATION. See the block comment
 * above RESUMABLE_UPLOAD_WINDOW_HOURS.
 */
import { AttachmentEntity } from '@prisma/client';
import type { PrismaClient } from '@prisma/client';
import { env } from '../config/env';
import { ATTACHMENTS_BUCKET, parseLegacyPublicUrlPath } from './attachment-access';
import { prisma as defaultPrisma } from './prisma';
import { supabaseAdmin } from './supabase';
import { runUnscoped, tenantConfigValues } from './tenant-context';

// ───────────────────────────────────────────────────────────────────────────
// Scope
// ───────────────────────────────────────────────────────────────────────────

/**
 * The second path segments `Attachment` owns, derived from the Prisma enum rather than typed
 * out, so a new `AttachmentEntity` value cannot leave the sweep silently blind to its objects.
 *
 * Deriving cuts both ways — a new enum value also automatically becomes DELETABLE — which is
 * what `assertNoOwnedForeignCollision` exists to catch.
 */
export const ATTACHMENT_OWNED_SEGMENTS: ReadonlySet<string> = new Set(
  Object.values(AttachmentEntity).map((v) => String(v).toLowerCase()),
);

/**
 * Every second segment measured in this bucket that is NOT `Attachment`'s, with the model or
 * column that owns it. This list is NOT how the sweep decides what to skip — the allowlist
 * above does that, and an unlisted segment is skipped just the same. It exists as a tripwire
 * and as documentation of what is actually down there.
 *
 *   user_profile_photo  User.avatar_path            controllers/user-avatar.controller.ts
 *   asset               inventory assets            controllers/inv-assets.controller.ts
 *   job_stage           JobStageAttachment          controllers/inv-stages.controller.ts
 *   email               EmailAttachment             controllers/comm-whatsapp-email.controller.ts
 *                                                   lib/comm-persist.ts (sent estimate/invoice PDFs)
 *                       NOTE: never swept, so an email object whose row write failed (or whose
 *                       upload timed out and landed late) stays in the bucket - storage, not data.
 *   estimate_scope      EstimateScopePhoto          controllers/estimate-photos.controller.ts
 *                                                   lib/copy-scope-photos.ts
 *   estimate_version    frozen version snapshots    lib/mint-estimate-version.ts
 *   estimate_line_item  RETIRED — no current writer, objects still in the bucket
 */
export const KNOWN_FOREIGN_SEGMENTS: readonly string[] = [
  'user_profile_photo',
  'asset',
  'job_stage',
  'email',
  'estimate_scope',
  'estimate_version',
  'estimate_line_item',
];

/**
 * Refuse to run if `Attachment` has come to claim a segment another subsystem writes.
 *
 * Deriving the allowlist from the enum means adding `AttachmentEntity.ASSET` would silently
 * hand this sweep every inventory asset photo in the bucket. That is a schema change nobody
 * would connect to a deleter, so the deleter checks for itself.
 */
export function assertNoOwnedForeignCollision(
  owned: ReadonlySet<string> = ATTACHMENT_OWNED_SEGMENTS,
): void {
  const collisions = KNOWN_FOREIGN_SEGMENTS.filter((seg) => owned.has(seg));
  if (collisions.length > 0) {
    throw new Error(
      `REFUSING to sweep: AttachmentEntity now claims ${collisions.length} path segment(s) ` +
        `another subsystem writes (${collisions.join(', ')}). Sweeping them would delete that ` +
        `subsystem's live objects. Reconcile the segment names before running this again.`,
    );
  }
}

// ───────────────────────────────────────────────────────────────────────────
// The grace window
// ───────────────────────────────────────────────────────────────────────────

/**
 * How long a resumable upload (S2) has to complete. NOT YET BUILT — this number comes from the
 * PRD, and whoever builds S2 must change it here if the real window differs. Everything below
 * is derived from it, so the floor moves with it.
 *
 * For reference, the S1 ticket already in production lives 2 hours
 * (`DIRECT_UPLOAD_TTL_SECONDS`), so today's real longest legitimate gap between bytes landing
 * and a row appearing is 2 hours, not 24.
 *
 * ── WHY PURE RECONCILIATION AND NOT A PENDING ROW ──
 *
 * The slice requires this to be chosen deliberately. Chosen: pure reconciliation.
 *
 * A pending row would make the in-flight window a non-issue. It would not make the sweep
 * "trivial and safe", though, because neither of the two things that actually make this
 * dangerous goes away: the bucket is still shared with six other writers, and legacy rows
 * still have no `storage_path`. The allowlist and the legacy parser are required either way.
 * A pending row only removes the need for the grace window — and a grace window is the
 * cheapest safety mechanism available here, being one constant and one comparison.
 *
 * Against the pending row, concretely:
 *   - `Attachment` has no upload-status column and no `updated_at`. Adding a state means a
 *     migration plus a new value every existing consumer must learn to exclude — list, count,
 *     the per-entity size total, timeline, search. Missing one shows the user a file that does
 *     not exist yet. That is a large blast radius across shipped, tested code, added in
 *     service of a manually-run cleanup job.
 *   - It does not remove the failure mode, it moves it. A pending row whose bytes never land
 *     is itself garbage needing a sweep, and now the garbage is in the database.
 *   - S1 shipped stateless on purpose: the whole context lives in an HMAC-signed ticket and
 *     the server keeps nothing between the two requests. A pending row reverses that decision
 *     for the whole path, and S1 is in production.
 *
 * The honest cost of this choice: the grace window is the only thing standing between an
 * in-flight upload and deletion, so it is load-bearing and is treated that way — a hard floor
 * (not a suggestion), dry-run as the default, and a strict `>` so the boundary case survives.
 */
export const RESUMABLE_UPLOAD_WINDOW_HOURS = 24;

/**
 * The hard floor. Below this the sweep refuses, in dry-run too.
 *
 * 2x the resumable window. Not a tuning knob — it is the line below which the tool is being
 * asked to do something it cannot do safely, and an operator in a hurry is exactly who needs
 * to be stopped. `--min-age-hours` can raise the window, never lower it past here.
 */
export const MIN_GRACE_HOURS = 2 * RESUMABLE_UPLOAD_WINDOW_HOURS; // 48

/**
 * The default: 7 days.
 *
 * 7x the longest legitimate gap. The asymmetry is the whole argument — waiting longer costs
 * fractions of a cent in storage on a 2.66 GiB bucket, and being early costs a customer's
 * video with no way to get it back. 7 days also means a long weekend, a public holiday or a
 * client that resumes an upload on Monday cannot produce a false positive, and it leaves a
 * week of head-room over the real in-flight window (see the module header).
 */
export const DEFAULT_GRACE_HOURS = 7 * 24; // 168

// ───────────────────────────────────────────────────────────────────────────
// Path classification
// ───────────────────────────────────────────────────────────────────────────

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type PathClassification =
  /** `{orgId}/{ownedSegment}/{entityId}/{fileName}` — the only shape this sweep may delete. */
  | { kind: 'owned'; entitySegment: string; entityId: string; fileName: string }
  /** A segment another subsystem owns. Never touched. */
  | { kind: 'foreign'; segment: string }
  /** Not under the org being swept. Never touched. */
  | { kind: 'other-org' }
  /** Anything else — wrong depth, wrong shape, a placeholder. Never touched. */
  | { kind: 'unrecognised'; reason: string };

/**
 * Decide what a stored object is. Everything that is not unambiguously an `Attachment` object
 * in THIS org is refused, including shapes nobody recognises: a sweep that guesses at an
 * unfamiliar path is a sweep that deletes the next subsystem someone adds.
 *
 * The segment test is `Set.has` on `parts[1]` — a whole segment. Not `startsWith`, which would
 * claim `job_stage`, `estimate_scope`, `estimate_line_item` and `estimate_version`.
 */
export function classifyObjectPath(path: string, orgId: string): PathClassification {
  const parts = path.split('/');
  if (parts[0] !== orgId) return { kind: 'other-org' };

  const segment = parts[1] ?? '';
  if (!ATTACHMENT_OWNED_SEGMENTS.has(segment)) {
    return KNOWN_FOREIGN_SEGMENTS.includes(segment)
      ? { kind: 'foreign', segment }
      : { kind: 'unrecognised', reason: `unowned second segment "${segment}"` };
  }

  // An owned segment is necessary, not sufficient. The builder emits exactly four segments
  // (`buildAttachmentStoragePath`), so anything else under an owned segment was written by
  // something this sweep does not know about.
  if (parts.length !== 4) {
    return { kind: 'unrecognised', reason: `expected 4 path segments, found ${parts.length}` };
  }

  const [, entitySegment, entityId, fileName] = parts as [string, string, string, string];
  if (!UUID_RE.test(entityId)) {
    return { kind: 'unrecognised', reason: `entity id "${entityId}" is not a uuid` };
  }
  if (!fileName) return { kind: 'unrecognised', reason: 'empty file name' };
  // Storage's own marker for an otherwise-empty prefix. Deleting it is harmless but pointless,
  // and it is not an upload, so it has no business in a report about lost uploads.
  if (fileName === '.emptyFolderPlaceholder') {
    return { kind: 'unrecognised', reason: 'storage folder placeholder' };
  }

  return { kind: 'owned', entitySegment, entityId, fileName };
}

// ───────────────────────────────────────────────────────────────────────────
// Storage listing
// ───────────────────────────────────────────────────────────────────────────

/** The subset of the storage SDK this sweep uses. Narrow so tests can supply a real fake. */
export interface StorageEntry {
  name: string;
  /** null marks a PREFIX ("folder") rather than an object — that is the SDK's own signal. */
  id: string | null;
  created_at: string | null;
  updated_at: string | null;
  metadata: { size?: number } | null;
}

export interface SweepStorage {
  list(
    prefix: string,
    opts: { limit: number; offset: number },
  ): Promise<{ data: StorageEntry[] | null; error: { message: string } | null }>;
  remove(paths: string[]): Promise<{ data: unknown; error: { message: string } | null }>;
}

export interface StoredObject {
  path: string;
  createdAt: Date | null;
  size: number;
}

/**
 * Page size per `list` call. The SDK's default is 100; nothing in this repo had ever called
 * `.list()` before this file, so the ceiling is unproven ground. 1000 is the documented
 * maximum and the whole prod bucket is ~3.2k objects, so this is a handful of round trips.
 */
const LIST_PAGE_SIZE = 1000;

/**
 * Depth guard for the WALK, which sees every subsystem, not just Attachment's. Attachment
 * paths are 4 segments; estimate_scope and estimate_version are 5, so 4 would be wrong here.
 * 8 leaves slack for a future writer nesting more deeply.
 */
const MAX_LIST_DEPTH = 8;

/**
 * Runaway guard on the paging loop. 100 pages x 1000 = 100k objects under ONE prefix, ~30x
 * the entire bucket. It was 10,000, which is ~10M objects buffered in memory before the guard
 * could fire — the process would OOM first, so the guard was decorative.
 */
const MAX_LIST_PAGES = 100;

/**
 * Every object under `prefix`, recursively.
 *
 * `list` is NOT recursive and returns one page of immediate children, so this walks prefixes
 * and pages each level.
 *
 * TERMINATION IS ON AN EMPTY PAGE, NOT A SHORT ONE, and `offset` advances by what actually
 * came back rather than by what was asked for. A short page cannot be read as "last page":
 * the service is free to cap `limit` below what we requested, in which case every page is
 * short and a stop-on-short loop returns only the first one — a silent, plausible-looking
 * truncation. Found by the pagination test, which caps the fake at 2 per page: the first
 * version of this loop returned 2 of 7 objects and reported success.
 *
 * A storage error THROWS. It must never degrade to an empty list: to this sweep an empty
 * listing reads as "nothing to delete", so a swallowed error is a silently useless run rather
 * than a dangerous one — but the next person to refactor it could easily invert that, and a
 * deleter should not depend on which way a swallowed error happens to fall.
 */
export interface ListResult {
  objects: StoredObject[];
  /**
   * Prefixes the walk refused to descend past MAX_LIST_DEPTH. Nothing under them is listed, so
   * nothing under them can be deleted — but "invisible" and "absent" must not look the same in
   * a report about a bucket, so they are carried out and printed.
   */
  truncatedAtDepth: string[];
}

export async function listObjectsUnderPrefix(
  storage: SweepStorage,
  prefix: string,
  depth = 0,
): Promise<ListResult> {
  if (depth >= MAX_LIST_DEPTH) return { objects: [], truncatedAtDepth: [prefix] };

  const out: StoredObject[] = [];
  const truncatedAtDepth: string[] = [];
  const childPrefixes: string[] = [];

  let offset = 0;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const { data, error } = await storage.list(prefix, { limit: LIST_PAGE_SIZE, offset });
    if (error) {
      throw new Error(`Could not list "${prefix}" in ${ATTACHMENTS_BUCKET}: ${error.message}`);
    }
    const entries = data ?? [];
    if (entries.length === 0) break;

    for (const entry of entries) {
      const full = `${prefix}/${entry.name}`;
      if (entry.id === null) {
        childPrefixes.push(full);
      } else {
        out.push({
          path: full,
          createdAt: entry.created_at ? new Date(entry.created_at) : null,
          size: entry.metadata?.size ?? 0,
        });
      }
    }
    offset += entries.length;

    if (page === MAX_LIST_PAGES - 1) {
      throw new Error(
        `Could not list "${prefix}" in ${ATTACHMENTS_BUCKET}: still returning rows after ` +
          `${MAX_LIST_PAGES} pages. Refusing to act on a listing that may be incomplete.`,
      );
    }
  }

  for (const child of childPrefixes) {
    const sub = await listObjectsUnderPrefix(storage, child, depth + 1);
    out.push(...sub.objects);
    truncatedAtDepth.push(...sub.truncatedAtDepth);
  }
  return { objects: out, truncatedAtDepth };
}

/**
 * The org-shaped top-level prefixes that actually exist in the bucket.
 *
 * A sweep that enumerates orgs from the `organizations` table is structurally blind to the
 * biggest source of genuine orphans there is: `Attachment.organization_id` cascade-deletes
 * with the Organization, so deleting an org removes every row that could have named its
 * objects while leaving every object in place. Measured on live staging — 6 objects under two
 * prefixes with no Organization row, invisible to a DB-driven run.
 *
 * Non-UUID top-level entries and loose files at the root are ignored rather than swept: they
 * are not org prefixes, so nothing here owns them.
 */
export async function discoverOrgPrefixes(storage: SweepStorage): Promise<string[]> {
  const found: string[] = [];
  let offset = 0;
  for (let page = 0; page < MAX_LIST_PAGES; page += 1) {
    const { data, error } = await storage.list('', { limit: LIST_PAGE_SIZE, offset });
    if (error) {
      throw new Error(`Could not list the root of ${ATTACHMENTS_BUCKET}: ${error.message}`);
    }
    const entries = data ?? [];
    if (entries.length === 0) break;
    for (const entry of entries) {
      // `id === null` marks a prefix. A root-level OBJECT is not an org and is left alone.
      if (entry.id === null && UUID_RE.test(entry.name)) found.push(entry.name);
    }
    offset += entries.length;

    // Same contract as listObjectsUnderPrefix: a listing that will not terminate is a listing
    // that may be incomplete, and this one decides which prefixes get swept at all.
    if (page === MAX_LIST_PAGES - 1) {
      throw new Error(
        `Could not list the root of ${ATTACHMENTS_BUCKET}: still returning rows after ` +
          `${MAX_LIST_PAGES} pages. Refusing to act on a prefix list that may be incomplete.`,
      );
    }
  }
  return found;
}

// ───────────────────────────────────────────────────────────────────────────
// The protected set
// ───────────────────────────────────────────────────────────────────────────

export interface SweepDeps {
  prisma: PrismaClient;
  storage: SweepStorage;
}

export function defaultDeps(): SweepDeps {
  return {
    prisma: defaultPrisma as unknown as PrismaClient,
    storage: supabaseAdmin.storage.from(ATTACHMENTS_BUCKET) as unknown as SweepStorage,
  };
}

/** A row whose object path could not be determined — see the refusal in `runOrphanSweepForOrg`. */
export interface UnresolvedRow {
  id: string;
  organizationId: string;
  fileUrl: string;
  /**
   * Why this row could not be resolved, from `resolveRowObjectPath`. Carried rather than
   * recomputed at the refusal: the three causes want three different responses, and the
   * different-host one is the newest and least expected guard. Telling an operator a row has
   * "no parseable file_url" about a URL that parses fine, without naming the host, sends them
   * looking in the wrong place.
   */
  reason: string;
}

export interface KnownAttachmentPaths {
  paths: ReadonlySet<string>;
  unresolved: UnresolvedRow[];
  /**
   * Rows pointing at a host that is not our storage, COUNTED BY HOST. Per-host and not a bare
   * total on purpose: the number alone cannot tell `loremflickr.com: 2` (seed data, shrug)
   * from `<old-project-ref>.supabase.co: 412` (a migration, and 412 unprotected legacy rows).
   * One of those should stop the run and the other should not, and only the host says which.
   */
  external: Record<string, number>;
  rowCount: number;
}

export type RowPathResolution =
  | { kind: 'path'; path: string }
  | { kind: 'external'; host: string }
  | { kind: 'unresolved'; reason: string };

/**
 * What object, if any, an `Attachment` row names in OUR bucket.
 *
 * The three-way answer exists because of a measurement, not a hunch. The first version of this
 * was two-way — a path, or "unresolvable" — and on live staging it refused all 13 orgs and
 * swept nothing: 7 seed rows carry a `file_url` on pdfobject.com, w3.org and loremflickr.com.
 *
 * A URL on a host that is not our storage cannot name an object in our bucket under ANY path,
 * so it is not ambiguous at all — it is simply not ours, and it endangers nothing. The
 * genuinely ambiguous case is narrower and is still refused: a URL that IS on our storage host
 * but is not in the public-object shape this parser understands (a signed URL, say). That row
 * points somewhere in this bucket and we cannot say where.
 */
/** Swap a URL's host for ours so the ONE public-object parser can judge its path shape. */
function fileUrlWithHost(fileUrl: string, host: string): string {
  try {
    const u = new URL(fileUrl);
    u.host = host;
    return u.toString();
  } catch {
    return '';
  }
}

export function resolveRowObjectPath(
  row: { storage_path: string | null; file_url: string },
  storageHost: string,
  bucket: string = ATTACHMENTS_BUCKET,
): RowPathResolution {
  if (row.storage_path) return { kind: 'path', path: row.storage_path };
  if (!row.file_url) return { kind: 'unresolved', reason: 'no storage_path and no file_url' };

  let host: string;
  try {
    host = new URL(row.file_url).host;
  } catch {
    return { kind: 'unresolved', reason: 'file_url is not a URL' };
  }
  if (host !== storageHost) {
    // A DIFFERENT host is only harmless if the object really is somebody else's. If the URL
    // carries our storage product's own public-object path for this bucket, then it names a
    // key in a bucket like ours at another project — a migration, a custom storage domain, a
    // CDN — and that key very likely exists in OUR bucket too. Calling that "external" would
    // drop the row out of the protected set while its object sits there classified as owned:
    // silent deletion of exactly the legacy files this whole path exists to protect.
    //
    // The path shape is the discriminator, not a guess at the domain. Refuse and let a human
    // look, rather than decide which of two plausible readings is true.
    if (parseLegacyPublicUrlPath(fileUrlWithHost(row.file_url, storageHost), bucket)) {
      return {
        kind: 'unresolved',
        reason: `points at ${bucket} on a DIFFERENT host (${host}) — same storage layout, other project`,
      };
    }
    return { kind: 'external', host };
  }

  const path = parseLegacyPublicUrlPath(row.file_url, bucket);
  if (path) return { kind: 'path', path };
  return {
    kind: 'unresolved',
    reason: `on our storage host but not a public ${bucket} object URL`,
  };
}

/** The host of our own storage, used to tell "not ours" from "ours but unparseable". */
export function defaultStorageHost(): string {
  try {
    return new URL(env.SUPABASE_URL).host;
  } catch {
    // An unreadable host makes every legacy URL look foreign, which would silently stop
    // protecting legacy objects. Empty matches no real host, so every legacy URL becomes
    // "unresolved" instead and the sweep refuses — the safe direction to fail.
    return '';
  }
}

/**
 * Refuse unless DATABASE_URL and SUPABASE_URL are the SAME project.
 *
 * The storage-host banner covers half the environment. The two variables are independent
 * (config/env.ts), so a local Postgres beside a remote SUPABASE_URL — an ordinary dev setup —
 * passes every check this tool had and arrives at a real bucket with an EMPTY protected set,
 * which condemns every attachment object past the grace window and reports it confidently.
 *
 * Precedent: lib/e2e-org.ts refuses on the DATABASE_URL project ref for a far less
 * destructive tool, with a comment that a host-only check is too weak. This needs no new env
 * var, because the two URLs can be checked against EACH OTHER: the ref appears in the storage
 * host as `<ref>.supabase.co` and in the connection string as either the pooler username
 * `postgres.<ref>` or the direct host `db.<ref>.supabase.co`.
 *
 * A mismatch is unambiguous and refuses in dry-run too. Being UNABLE to extract either ref (a
 * local database, a custom domain) is not proof of a problem, so it refuses only when armed —
 * an operator can still read a dry-run on an unusual setup, but cannot delete from one.
 */
/** The project ref embedded in a connection string, or undefined if it carries none. */
export function databaseProjectRef(databaseUrl: string): string | undefined {
  return (
    /(?:^|[:/@])postgres\.([a-z0-9]{16,})(?::|@)/i.exec(databaseUrl)?.[1] ??
    /^db\.([a-z0-9]{16,})\.supabase\.co$/i.exec(hostOf(databaseUrl))?.[1]
  );
}

export function assertDatabaseMatchesStorage(
  databaseUrl: string,
  supabaseUrl: string,
  dryRun: boolean,
): void {
  const storageRef = /^([a-z0-9]{16,})\.supabase\.co$/i.exec(hostOf(supabaseUrl))?.[1];
  const dbRef = databaseProjectRef(databaseUrl);

  if (storageRef && dbRef && storageRef !== dbRef) {
    throw new Error(
      `REFUSING to sweep: the database and the bucket belong to a different project. ` +
        `DATABASE_URL is project "${dbRef}" and SUPABASE_URL is project "${storageRef}". The ` +
        'protected set would be built from one environment and applied to another, which ' +
        "condemns every object the other environment's rows point at.",
    );
  }
  if (!storageRef || !dbRef) {
    if (dryRun) return;
    throw new Error(
      'REFUSING to delete: could not confirm that DATABASE_URL and SUPABASE_URL are the same ' +
        `project (database ref ${dbRef ?? 'unknown'}, storage ref ${storageRef ?? 'unknown'}). ` +
        'A database that is not the one behind this bucket yields an empty protected set and ' +
        'condemns everything in it. Re-run without --delete to inspect.',
    );
  }
}

/** `hostname`, not `host`: a connection string carries `:5432` and would never match. */
function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

/**
 * Throw unless the cross-tenant bypass is actually in effect for the CURRENT context.
 *
 * Pure and in-process — no round trip. Inside `runUnscoped` this is always true regardless of
 * DB_TENANT_GUARD, so it is really an assertion that the wrapper is present at the point the
 * query runs. Delete the wrapper and this fires immediately instead of the sweep quietly
 * reading zero rows and condemning every object in the bucket.
 */
export function assertCrossOrgBypassInEffect(): void {
  const tenant = tenantConfigValues();
  if (tenant.bypass !== 'on') {
    throw new Error(
      'REFUSING to sweep: the cross-org bypass is not in effect (tenantConfigValues().bypass !== ' +
        '"on"), so the attachment read would be scoped away rather than genuinely cross-org. ' +
        'With DB_TENANT_GUARD=on the RLS policies fail CLOSED and this read returns zero rows, ' +
        'which this sweep would read as "every stored object is an orphan". The read must run ' +
        'inside runUnscoped().',
    );
  }
}

/**
 * Every storage path any `Attachment` row anywhere points at.
 *
 * Cross-org on purpose (see the header): protection must not be tenant-scoped. The rows are
 * read in one pass rather than per-org because `storage_path` is nullable, non-unique and
 * UNINDEXED — this is a table scan, and doing it once is the difference between one scan and
 * one per org.
 */
export async function loadKnownAttachmentPaths(
  deps: Pick<SweepDeps, 'prisma'>,
  opts: { storageHost?: string } = {},
): Promise<KnownAttachmentPaths> {
  const storageHost = opts.storageHost ?? defaultStorageHost();
  return runUnscoped(async () => {
    assertCrossOrgBypassInEffect();

    const rows = await deps.prisma.attachment.findMany({
      select: { id: true, organization_id: true, storage_path: true, file_url: true },
    });

    const paths = new Set<string>();
    const unresolved: UnresolvedRow[] = [];
    const external: Record<string, number> = {};
    for (const row of rows) {
      const resolved = resolveRowObjectPath(row, storageHost, ATTACHMENTS_BUCKET);
      if (resolved.kind === 'path') paths.add(resolved.path);
      else if (resolved.kind === 'external') {
        external[resolved.host] = (external[resolved.host] ?? 0) + 1;
      }
      else {
        unresolved.push({
          id: row.id,
          organizationId: row.organization_id,
          fileUrl: row.file_url,
          reason: resolved.reason,
        });
      }
    }
    return { paths, unresolved, external, rowCount: rows.length };
  });
}

// ───────────────────────────────────────────────────────────────────────────
// Deletion
// ───────────────────────────────────────────────────────────────────────────

export interface RemoveOutcome {
  removed: string[];
  failed: Array<{ path: string; reason: string }>;
}

/** Storage caps a bulk remove; batching also keeps one bad path from sinking the whole run. */
const REMOVE_BATCH_SIZE = 100;

/**
 * Delete objects, re-checking every single path against the classifier first.
 *
 * The caller already filtered — this checks again anyway, and throws WITHOUT calling storage if
 * anything in the batch is not an owned object in `orgId`. It is the last line before an
 * irreversible operation, the only place that sees the literal argument to `remove()`, and the
 * classifier is the one thing standing between this tool and another subsystem's photos. A
 * duplicated check here is worth more than the line it costs.
 */
export async function removeOrphanObjects(
  storage: SweepStorage,
  orgId: string,
  paths: string[],
): Promise<RemoveOutcome> {
  const rejected = paths.filter((p) => classifyObjectPath(p, orgId).kind !== 'owned');
  if (rejected.length > 0) {
    throw new Error(
      `REFUSING to delete ${rejected.length} path(s) this sweep does not own — the check runs ` +
        `before the first call, so NOTHING was deleted at all:\n` +
        rejected.map((p) => `  - ${p}`).join('\n'),
    );
  }

  const outcome: RemoveOutcome = { removed: [], failed: [] };
  for (let i = 0; i < paths.length; i += REMOVE_BATCH_SIZE) {
    const batch = paths.slice(i, i + REMOVE_BATCH_SIZE);
    const { data, error } = await storage.remove(batch);
    if (error) {
      for (const p of batch) outcome.failed.push({ path: p, reason: error.message });
      continue;
    }

    // Report what storage SAYS it removed, not what we asked it to. A partial success — some
    // keys gone, some not — is indistinguishable from total success if you just echo the
    // request, and for a deleter with no restore this report is the only record of what
    // actually happened. Fall back to the batch only if the response carries no names.
    const names = Array.isArray(data)
      ? (data as Array<{ name?: string }>).map((d) => d?.name).filter((n): n is string => !!n)
      : [];
    if (names.length === 0) {
      outcome.removed.push(...batch);
      continue;
    }
    const confirmed = new Set(names);
    for (const p of batch) {
      if (confirmed.has(p)) outcome.removed.push(p);
      else outcome.failed.push({ path: p, reason: 'storage did not report this key as removed' });
    }
  }
  return outcome;
}

// ───────────────────────────────────────────────────────────────────────────
// The sweep
// ───────────────────────────────────────────────────────────────────────────

export interface SweepOpts {
  orgId: string;
  /** Injected so the grace comparison is testable without faking the clock globally. */
  now?: Date;
  graceMs?: number;
  dryRun?: boolean;
  /** Reuse a set already loaded by an --all-orgs run instead of re-scanning the table. */
  knownPaths?: KnownAttachmentPaths;
  /**
   * Called with the exact key list, BEFORE the first delete. There is no restore, so the
   * manifest has to be durable before anything is destroyed — written afterwards it would be
   * missing precisely when the run died halfway. Throwing here aborts the delete.
   */
  beforeDelete?: (paths: string[]) => Promise<void> | void;
}

export interface OrphanCandidate {
  path: string;
  sizeBytes: number;
  ageHours: number;
  entitySegment: string;
  entityId: string;
}

export interface SweepCounters {
  listed: number;
  owned: number;
  foreign: number;
  unrecognised: number;
  otherOrg: number;
  matchedToRow: number;
  withinGrace: number;
  undated: number;
  orphans: number;
}

export interface SweepResult {
  orgId: string;
  dryRun: boolean;
  counters: SweepCounters;
  orphans: OrphanCandidate[];
  removed: string[];
  failed: Array<{ path: string; reason: string }>;
  /** Unowned segments actually seen under this org, with counts — a drift detector. */
  foreignBySegment: Record<string, number>;
  unrecognisedSamples: string[];
  /** Prefixes too deeply nested to walk. Never swept; surfaced so they are not invisible. */
  deepPrefixesSkipped: string[];
  bytesReclaimable: number;
}

/** Cap on how many odd paths get echoed; a report nobody reads is not a report. */
const UNRECOGNISED_SAMPLE_CAP = 20;

export async function runOrphanSweepForOrg(
  deps: SweepDeps,
  opts: SweepOpts,
): Promise<SweepResult> {
  const now = opts.now ?? new Date();
  // DEFAULT_GRACE_HOURS, never MIN_GRACE_HOURS. The floor is the line below which the tool
  // refuses; it is not a default. Pinned by a test because the CLI always passes graceMs, so
  // this fallback is only reachable by a library caller and swapping the two stayed green.
  const graceMs = opts.graceMs ?? DEFAULT_GRACE_HOURS * 60 * 60 * 1000;
  const dryRun = opts.dryRun ?? true;

  // Refusals FIRST, before a single listing call, and in dry-run too: a dry-run that prints a
  // plan built on a broken grace window teaches an operator to trust the next real run.
  assertNoOwnedForeignCollision();
  if (graceMs < MIN_GRACE_HOURS * 60 * 60 * 1000) {
    throw new Error(
      `REFUSING to sweep: the grace window (${(graceMs / 3_600_000).toFixed(1)}h) is below the ` +
        `floor of ${MIN_GRACE_HOURS}h. A resumable upload has ` +
        `${RESUMABLE_UPLOAD_WINDOW_HOURS}h to complete, so a shorter window deletes uploads ` +
        'that are still in flight.',
    );
  }

  const known = opts.knownPaths ?? (await loadKnownAttachmentPaths(deps));

  // A row whose object path cannot be determined is a row whose object cannot be protected, so
  // the only safe move is to refuse and let a human look. Deliberately NOT overridable by a
  // flag: the override would get used the first time it appeared, which is the moment it
  // matters.
  //
  // Scoped to THIS ORG's rows, not all of them. An unresolvable row can only endanger objects
  // it might name, and it cannot name one outside its own org's prefix: every key this system
  // has ever written starts with the row's own organization_id (`buildAttachmentStoragePath`,
  // and the direct path re-derives it from `req.user` for exactly this reason). Refusing
  // globally was measured on staging as refusing all 13 orgs over 7 seed rows in one of them —
  // a guard that never lets the tool run is a guard nobody keeps.
  const blocking = known.unresolved.filter((r) => r.organizationId === opts.orgId);
  if (blocking.length > 0) {
    const lines = blocking
      .slice(0, UNRECOGNISED_SAMPLE_CAP)
      .map((r) => `  - attachment ${r.id}: ${r.reason}\n      file_url=${r.fileUrl || '(empty)'}`);
    throw new Error(
      `REFUSING to sweep org ${opts.orgId}: ${blocking.length} of its attachment row(s) have ` +
        'no storage_path and a file_url this sweep cannot turn into a key in THIS bucket, so ' +
        'their objects cannot be told apart from orphans. NOTHING was deleted for this org. ' +
        'Repair or delete these rows, then re-run:\n' +
        lines.join('\n') +
        (blocking.length > UNRECOGNISED_SAMPLE_CAP
          ? `\n  ... and ${blocking.length - UNRECOGNISED_SAMPLE_CAP} more`
          : ''),
    );
  }

  // Scoped by PREFIX, which is what makes crossing a tenant boundary impossible rather than
  // merely unlikely: no object outside `{orgId}/` is ever even enumerated. `classifyObjectPath`
  // re-asserts it per path anyway, and `removeOrphanObjects` once more before deleting.
  const { objects, truncatedAtDepth } = await listObjectsUnderPrefix(deps.storage, opts.orgId);

  const counters: SweepCounters = {
    listed: objects.length,
    owned: 0,
    foreign: 0,
    unrecognised: 0,
    otherOrg: 0,
    matchedToRow: 0,
    withinGrace: 0,
    undated: 0,
    orphans: 0,
  };
  const foreignBySegment: Record<string, number> = {};
  const unrecognisedSamples: string[] = [];
  const ownedPaths: string[] = [];
  const orphans: OrphanCandidate[] = [];

  for (const obj of objects) {
    const cls = classifyObjectPath(obj.path, opts.orgId);

    if (cls.kind === 'other-org') {
      counters.otherOrg += 1;
      continue;
    }
    if (cls.kind === 'foreign') {
      counters.foreign += 1;
      foreignBySegment[cls.segment] = (foreignBySegment[cls.segment] ?? 0) + 1;
      continue;
    }
    if (cls.kind === 'unrecognised') {
      counters.unrecognised += 1;
      if (unrecognisedSamples.length < UNRECOGNISED_SAMPLE_CAP) unrecognisedSamples.push(obj.path);
      continue;
    }

    counters.owned += 1;
    ownedPaths.push(obj.path);

    if (known.paths.has(obj.path)) {
      counters.matchedToRow += 1;
      continue;
    }

    // No timestamp means no way to know it is not in flight. Report it, never delete it.
    if (!obj.createdAt || Number.isNaN(obj.createdAt.getTime())) {
      counters.undated += 1;
      continue;
    }

    const ageMs = now.getTime() - obj.createdAt.getTime();
    // Strict `>`: an object exactly at the boundary is NOT past it. The boundary case is the
    // one an operator is least likely to think about and the one a `>=` silently eats.
    if (!(ageMs > graceMs)) {
      counters.withinGrace += 1;
      continue;
    }

    orphans.push({
      path: obj.path,
      sizeBytes: obj.size,
      ageHours: Math.floor(ageMs / 3_600_000),
      entitySegment: cls.entitySegment,
      entityId: cls.entityId,
    });
  }

  // THE protected set is the only thing standing between Attachment's own objects and
  // deletion — everything else in this file protects OTHER subsystems. So before condemning
  // anything, assert the set is not implausibly empty. A database that is not the one behind
  // this bucket, an RLS scope that ate the read, a schema the query no longer matches: all of
  // them look identical from here, and all of them present as "every object is an orphan".
  if (ownedPaths.length > 0 && (known.rowCount === 0 || known.paths.size === 0)) {
    throw new Error(
      `REFUSING to sweep org ${opts.orgId}: the bucket holds ${ownedPaths.length} ` +
        `attachment-owned object(s) but the protected set is empty (${known.rowCount} ` +
        `attachment row(s), ${known.paths.size} resolved path(s)) — so EVERY one of them ` +
        'would be condemned. That is far more likely to be a database pointed at the wrong ' +
        'environment, or a read that was scoped away, than a bucket of pure garbage. ' +
        'NOTHING was deleted. Verify with: SELECT count(*) FROM attachments;',
    );
  }
  // KNOWN LIMIT: this catches a TOTALLY empty protected set, not a partially short one. A
  // read that returned 40 of 1922 rows — right project, wrong filter — passes here and
  // condemns the rest. Closing it needs a plausibility BAND, and a band needs a defensible
  // threshold that nothing currently gives us; a guessed one would either not fire or fire
  // constantly. Left open deliberately, and the runbook's census is the compensating control.

  counters.orphans = orphans.length;
  const bytesReclaimable = orphans.reduce((n, o) => n + o.sizeBytes, 0);

  if (dryRun || orphans.length === 0) {
    return {
      orgId: opts.orgId,
      dryRun,
      counters,
      orphans,
      removed: [],
      failed: [],
      foreignBySegment,
      unrecognisedSamples,
      deepPrefixesSkipped: truncatedAtDepth,
      bytesReclaimable,
    };
  }

  const doomed = orphans.map((o) => o.path);
  if (opts.beforeDelete) await opts.beforeDelete(doomed);
  const outcome = await removeOrphanObjects(deps.storage, opts.orgId, doomed);

  return {
    orgId: opts.orgId,
    dryRun,
    counters,
    orphans,
    removed: outcome.removed,
    failed: outcome.failed,
    foreignBySegment,
    unrecognisedSamples,
    deepPrefixesSkipped: truncatedAtDepth,
    bytesReclaimable,
  };
}
