#!/usr/bin/env tsx
/**
 * Orphan reconciliation for the attachments bucket — operator-run sweep (direct-to-storage
 * PRD, S3). The argv/print wrapper only; all logic is in src/lib/attachment-orphan-sweep.ts,
 * which is where the safety argument is written down and where the tests point.
 *
 *   npm run sweep:attachment-orphans -- (--org=<uuid> | --all-orgs)
 *       [--min-age-hours=N] [--include-orgless-prefixes] [--delete | --dry-run]
 *
 *   --org                       the organization, or a bare storage prefix, to sweep
 *                               (this or --all-orgs)
 *   --all-orgs                  every org in the database. Org-shaped storage prefixes with
 *                               NO Organization row are REPORTED AND SKIPPED unless
 *                               --include-orgless-prefixes is also passed
 *   --include-orgless-prefixes  also sweep those prefixes. Every per-org guard is inert on
 *                               them (no rows to refuse on, none to protect with), so the
 *                               whole prefix is condemned at once — hence the opt-in
 *   --min-age-hours=N           grace window; default 168 (7 days), hard floor 48. Raise only
 *   --delete                    actually delete. WITHOUT THIS THE RUN IS A DRY-RUN
 *   --dry-run                   explicit no-op; the default already. Refused with --delete
 *
 * Each flag at most once, and an unknown flag is refused rather than ignored.
 *
 * ── DRY-RUN IS THE DEFAULT, WHICH INVERTS THIS REPO'S CONVENTION ──
 *
 * Every other script here opts IN to dry-run (`scripts/reseed-builtin-keys.ts --dry-run`).
 * This one opts in to DELETING. The slice requires it, and the reason it requires it is that
 * the failure modes are not comparable: forgetting `--dry-run` on the automation reseeder
 * destroys rows a seeder rebuilds from a registry, while forgetting it here destroys customer
 * video that exists nowhere else. There is no restore. An operator who mistypes a flag on this
 * script must get a report, not an outcome.
 *
 * ── WHAT IT REFUSES TO DO, ALL BEFORE ANY DELETE ──
 *
 *  - a grace window under 48h (a resumable upload has 24h to finish; a shorter window deletes
 *    uploads that are still in flight)
 *  - any run where an Attachment row has neither a storage_path nor a parseable file_url —
 *    that row's object cannot be told apart from an orphan, so the org is refused entirely
 *  - any run where AttachmentEntity has come to claim a path segment another subsystem writes
 *  - the cross-org read happening outside runUnscoped (it would return zero rows under
 *    DB_TENANT_GUARD=on and every object in the bucket would look orphaned)
 *  - deleting any path that is not, re-checked at the call site, an Attachment object in the
 *    org being swept
 *
 * ── SCOPE ──
 *
 * Only `{orgId}/{customer|lead|estimate|job|invoice}/{entityId}/{file}`, matched on whole path
 * segments. The bucket is shared with other subsystems, enumerated once in
 * `KNOWN_FOREIGN_SEGMENTS` (src/lib/attachment-orphan-sweep.ts) rather than counted again
 * here; this sweep never touches them, and never touches any other bucket.
 *
 * Each org is an INDEPENDENT run: one org's refusal does not abort the rest.
 *
 * ── RUNNING IT ──
 *
 * Read the dry-run output before arming it, on staging first. The run prints the storage host
 * it is pointed at; check that line before passing --delete.
 *
 * Runbook (who runs this, how often, the prod precheck order): docs/attachment-orphan-sweep-runbook.md
 *
 * NOTE ON OUTPUT: `--all-orgs` prints real organization NAMES. That is fine on a terminal, but
 * this output is the most likely thing to get pasted into a PR or an issue, which would put a
 * real customer name in the repo. Redact the names, or paste a single `--org=<uuid>` run.
 *
 * Exit codes: 0 = completed (a dry-run with findings is still 0); 1 = bad arguments, a refusal,
 * at least one org failed, or any object failed to delete.
 */
import { mkdirSync, writeFileSync } from 'fs';
import { join } from 'path';
import { env } from '../src/config/env';
import {
  DEFAULT_GRACE_HOURS,
  MIN_GRACE_HOURS,
  assertDatabaseMatchesStorage,
  databaseProjectRef,
  defaultDeps,
  discoverOrgPrefixes,
  loadKnownAttachmentPaths,
  runOrphanSweepForOrg,
  type KnownAttachmentPaths,
  type SweepResult,
} from '../src/lib/attachment-orphan-sweep';
import { runUnscoped } from '../src/lib/tenant-context';

/**
 * Known flags. Anything else is refused rather than ignored: `--min-age-hourz=720` would
 * otherwise silently run at the default and `--delele` would silently run as a dry-run. Both
 * fail safe, but on a deleter an operator who mistypes should be told, not quietly obeyed in
 * a way they did not intend.
 */
const VALUE_FLAGS = ['--org', '--min-age-hours'] as const;
const BOOL_FLAGS = ['--all-orgs', '--delete', '--dry-run', '--include-orgless-prefixes'] as const;

/**
 * Last-wins would be a guess about intent; a repeated flag is refused instead.
 *
 * The original used `.find`, which is FIRST-wins: `--min-age-hours=48 --min-age-hours=720`
 * silently ran at 48. An operator appending a LARGER window precisely because they wanted to
 * be safer would have got the smaller one.
 *
 * Last-wins is belt-and-braces and today cannot change what the tool DOES: `findArgvProblem`
 * refuses a repeated flag, and every consumer discards the parsed values once `error` is set.
 * Note the tie-break is still observable at this function's own boundary — `argValue` runs
 * before the refusal, so `parseSweepArgs(['--org=a','--org=b'])` really does return
 * `orgId: 'b'` alongside the error. A test could pin that, but it would be asserting a field
 * `main()` returns before ever reading. So the mutation is equivalent at the PROGRAM boundary,
 * not at this function's, and it is left un-pinned deliberately rather than overlooked.
 *
 * It is kept so that relaxing the refusal later degrades to the safer tie-break, not the bug.
 */
function argValue(args: string[], flag: string): string | undefined {
  const hits = args.filter((a) => a.startsWith(`${flag}=`));
  if (hits.length === 0) return undefined;
  return hits[hits.length - 1]!.slice(flag.length + 1);
}

function findArgvProblem(args: string[]): string | undefined {
  const seen = new Map<string, number>();
  for (const arg of args) {
    const name = arg.includes('=') ? arg.slice(0, arg.indexOf('=')) : arg;
    const isValue = (VALUE_FLAGS as readonly string[]).includes(name) && arg.includes('=');
    const isBool = (BOOL_FLAGS as readonly string[]).includes(name) && !arg.includes('=');
    if (!isValue && !isBool) {
      return `unknown or malformed argument "${arg}". Known: ${[...VALUE_FLAGS.map((f) => `${f}=<value>`), ...BOOL_FLAGS].join(', ')}.`;
    }
    seen.set(name, (seen.get(name) ?? 0) + 1);
  }
  const repeated = [...seen].filter(([, n]) => n > 1).map(([f]) => f);
  if (repeated.length > 0) {
    return `${repeated.join(', ')} given more than once. Pass each flag at most once.`;
  }
  return undefined;
}

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface ParsedArgs {
  orgId?: string;
  allOrgs: boolean;
  dryRun: boolean;
  graceHours: number;
  includeOrglessPrefixes: boolean;
  /** Set when the invocation is unusable; `main` prints it and exits 1 without touching storage. */
  error?: string;
}

/**
 * Argument parsing, exported ONLY so the inverted dry-run default is a tested fact rather than
 * a claim in a doc block. It is the acceptance criterion most expensive to get wrong and the
 * easiest to break with a one-character edit, and a test that never exercises the default
 * would pass just as happily with the default flipped.
 */
export function parseSweepArgs(args: string[]): ParsedArgs {
  const orgId = argValue(args, '--org');
  const allOrgs = args.includes('--all-orgs');
  // Opt IN to deleting. Every other script in this repo opts in to dry-run; see the header.
  const dryRun = !args.includes('--delete');
  const includeOrglessPrefixes = args.includes('--include-orgless-prefixes');

  const rawHours = argValue(args, '--min-age-hours');
  const graceHours = rawHours === undefined ? DEFAULT_GRACE_HOURS : Number(rawHours);
  const base = { orgId, allOrgs, dryRun, graceHours, includeOrglessPrefixes };

  const argvProblem = findArgvProblem(args);
  if (argvProblem) return { ...base, error: argvProblem };

  // `dryRun = !args.includes('--delete')` resolves the PAIR toward deletion, so an operator
  // hedging with both flags would get the outcome instead of the report — the exact failure
  // the inverted default exists to prevent. Neither reading is obviously right, so refuse.
  if (args.includes('--delete') && args.includes('--dry-run')) {
    return {
      ...base,
      dryRun: true,
      error: '--delete and --dry-run contradict each other. Pass exactly one.',
    };
  }

  if (!allOrgs && (!orgId || !UUID_RE.test(orgId))) {
    return { ...base, error: USAGE };
  }
  if (!Number.isFinite(graceHours)) {
    return { ...base, error: `--min-age-hours must be a number, got "${rawHours}".` };
  }
  // Re-asserted inside the sweep so a library caller cannot slip past it either. Checking here
  // as well turns it into a readable usage error, before a single storage call.
  if (graceHours < MIN_GRACE_HOURS) {
    return {
      ...base,
      error:
        `--min-age-hours=${graceHours} is below the floor of ${MIN_GRACE_HOURS}h. A resumable ` +
        'upload has 24h to complete; a shorter window deletes uploads still in flight. This ' +
        'floor cannot be overridden from the command line.',
    };
  }
  return base;
}

export const ORGLESS_LABEL = '(NO ORGANIZATION ROW - deleted org)';

/**
 * Which prefixes a `--all-orgs` run actually sweeps.
 *
 * A prefix with no Organization row is REPORTED AND SKIPPED unless explicitly asked for, and
 * the reason is that every per-org safety net this tool has is inert exactly there. The
 * unresolvable-row refusal filters on `organizationId === orgId` and so is always empty; the
 * protected-path set holds nothing, because deleting an org cascade-deletes every row that
 * could have named its objects. The condemnation is therefore 100% by construction, with no
 * mechanism left that could disagree.
 *
 * And the tool cannot tell "org deleted, objects are garbage" from "Organization row not
 * visible to THIS query" — a future soft-delete column, a `where` clause growing on that
 * findMany, or a replica read all produce an identical, total condemnation. On staging this
 * path accounted for 6 of 13 orphans, so it is load-bearing, not hypothetical.
 *
 * No capability is lost: `--org=<the dead prefix> --delete` still sweeps it, and having to
 * name it is the opt-in.
 */
export function selectSweepTargets(
  dbOrgs: Array<{ id: string; name: string }>,
  storagePrefixes: string[],
  includeOrgless: boolean,
): { targets: Array<{ id: string; name: string }>; skippedOrgless: string[] } {
  const byId = new Map(dbOrgs.map((o) => [o.id, o.name]));
  const orgless = storagePrefixes.filter((p) => !byId.has(p));

  if (includeOrgless) for (const p of orgless) byId.set(p, ORGLESS_LABEL);

  const targets = [...byId]
    .map(([id, name]) => ({ id, name }))
    .sort((a, b) => a.name.localeCompare(b.name));
  return { targets, skippedOrgless: includeOrgless ? [] : orgless };
}

/** Exported so a test can assert it names every flag the parser accepts. */
export const USAGE =
  'Usage: npm run sweep:attachment-orphans -- (--org=<uuid> | --all-orgs)\n' +
  '         [--min-age-hours=N] [--include-orgless-prefixes] [--delete | --dry-run]\n' +
  '  --org=<uuid>                one organization, or a bare storage prefix\n' +
  '  --all-orgs                  every org; orgless storage prefixes are reported, not swept\n' +
  '  --include-orgless-prefixes  also sweep prefixes with no Organization row\n' +
  '  --min-age-hours=N           grace window, default 168, floor 48\n' +
  '  --delete                    actually delete (default is a dry-run)\n' +
  '  --dry-run                   explicit no-op; cannot be combined with --delete';

function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return '';
  }
}

function mib(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(2)} MiB`;
}

function printResult(label: string, result: SweepResult): void {
  const c = result.counters;
  console.log(`\n${label} — ${result.dryRun ? 'DRY-RUN' : 'DELETE'}:`);
  console.log(`  objects listed:      ${c.listed}`);
  console.log(`  ...attachment-owned: ${c.owned}`);
  console.log(`  ...other subsystems: ${c.foreign}`);
  console.log(`  ...unrecognised:     ${c.unrecognised}`);
  console.log(`  matched to a row:    ${c.matchedToRow}`);
  console.log(`  within grace:        ${c.withinGrace}`);
  console.log(`  no timestamp:        ${c.undated}`);
  console.log(`  ORPHANS:             ${c.orphans} (${mib(result.bytesReclaimable)})`);

  const foreign = Object.entries(result.foreignBySegment).sort((a, b) => b[1] - a[1]);
  if (foreign.length > 0) {
    console.log('\n  Other subsystems seen under this org (never touched):');
    for (const [seg, n] of foreign) console.log(`    ${seg}: ${n}`);
  }

  if (result.unrecognisedSamples.length > 0) {
    console.log(
      '\n  WARN - paths in a shape this sweep does not recognise (never touched — a new ' +
        'writer may have appeared):',
    );
    for (const p of result.unrecognisedSamples) console.log(`    ${p}`);
  }

  if (result.deepPrefixesSkipped.length > 0) {
    console.log(
      `\n  WARN - ${result.deepPrefixesSkipped.length} prefix(es) nested deeper than this walk ` +
        'goes. Nothing under them was listed, so nothing under them can be swept:',
    );
    for (const p of result.deepPrefixesSkipped) console.log(`    ${p}`);
  }

  if (result.orphans.length > 0) {
    console.log(`\n  ${result.dryRun ? 'Would delete' : 'Deleting'}:`);
    for (const o of result.orphans) {
      console.log(`    ${o.path}  (${mib(o.sizeBytes)}, ${o.ageHours}h old)`);
    }
  }

  if (!result.dryRun) {
    console.log(`\n  removed: ${result.removed.length}`);
    for (const p of result.removed) console.log(`    OK - ${p}`);
    if (result.failed.length > 0) {
      console.log(`  FAILED to remove: ${result.failed.length}`);
      for (const f of result.failed) console.log(`    FAIL - ${f.path}: ${f.reason}`);
    }
  }
}

/**
 * Append the exact keys about to be destroyed to a timestamped manifest, before the first
 * delete. There is no restore, so this list is the most valuable thing an armed run produces,
 * and terminal scrollback is not a record. It also makes "what the dry-run promised" and
 * "what the armed run did" diffable, which is impossible from the console alone.
 *
 * A failure to write ABORTS the delete (it throws): running without the record is exactly the
 * situation the manifest exists to prevent.
 */
function makeManifestWriter(runStartedAt: string, dbHost: string, storageHost: string) {
  // Relative to this FILE's package, never process.cwd(). `npx tsx backend/scripts/...` from
  // the repo root would otherwise write an un-ignored top-level tmp/ full of destroyed storage
  // keys — precisely what the gitignore entry promises cannot happen.
  const dir = join(__dirname, '..', 'tmp', 'attachment-orphan-sweep');
  const file = join(dir, `${runStartedAt.replace(/[:.]/g, '-')}.manifest.jsonl`);
  let announced = false;
  return {
    file,
    write(orgId: string, paths: string[]): void {
      mkdirSync(dir, { recursive: true });
      const line = JSON.stringify({
        run_started_at: runStartedAt,
        deleted_at: new Date().toISOString(),
        database_host: dbHost,
        storage_host: storageHost,
        organization_id: orgId,
        keys: paths,
      });
      writeFileSync(file, `${line}\n`, { flag: 'a' });
      if (!announced) {
        console.log(`\n  Manifest of deleted keys: ${file}`);
        announced = true;
      }
    },
  };
}

/**
 * The run's exit condition, extracted so it is testable — `main()` has no harness, and the
 * delete-failure half of this went untested and could be deleted with the suite still green.
 * That half exists for cron and `&&` chains, which is exactly where nobody reads the output.
 *
 * Returns undefined for a clean run, or the message to fail with.
 */
export function sweepExitProblem(
  failedOrgs: number,
  failedObjects: number,
): string | undefined {
  if (failedOrgs === 0 && failedObjects === 0) return undefined;
  return `${failedOrgs} org(s) refused, ${failedObjects} object(s) failed to delete.`;
}

async function main(): Promise<void> {
  const { orgId, allOrgs, dryRun, graceHours, includeOrglessPrefixes, error } =
    parseSweepArgs(process.argv.slice(2));
  if (error) {
    console.error(error === USAGE ? error : `FAIL - ${error}`);
    process.exit(1);
    return;
  }

  const graceMs = graceHours * 60 * 60 * 1000;
  const deps = defaultDeps();

  // The environment banner. It prints BOTH halves because they are independent settings: a
  // local DATABASE_URL beside a remote SUPABASE_URL is an ordinary dev setup and would point
  // this tool at a real bucket with an empty protected set. The assertion below is what
  // actually stops that; the banner is what lets an operator see it.
  const host = hostOf(env.SUPABASE_URL) || '(unparseable)';
  const dbHost = hostOf(env.DATABASE_URL) || '(unparseable)';
  // The pooler hostname is IDENTICAL for every project — the ref lives in the username — so
  // the host alone carries no environment information at all. Print the ref beside it, which
  // is the part that actually differs and the part the assertion below compares.
  const dbRef = databaseProjectRef(env.DATABASE_URL) ?? '(not identifiable)';
  console.log(`Attachment orphan sweep — storage host: ${host}`);
  console.log(`                          database:     ${dbHost}  project=${dbRef}`);
  console.log(`  grace window: ${graceHours}h    mode: ${dryRun ? 'DRY-RUN' : 'DELETE'}`);
  if (dryRun) {
    console.log('  Nothing will be deleted. Re-run with --delete once you have read this.');
  } else {
    console.log('  WARN - objects listed below WILL be deleted. There is no restore.');
  }

  try {
    assertDatabaseMatchesStorage(env.DATABASE_URL, env.SUPABASE_URL, dryRun);
  } catch (err) {
    console.error(`FAIL - ${err instanceof Error ? err.message : err}`);
    process.exit(1);
    return;
  }

  // ONE cross-org read of the whole attachments table, shared by every org in this run.
  // `storage_path` is nullable, non-unique and unindexed, so this is a table scan; doing it
  // per-org would be one scan per org for an identical answer. Protection is deliberately NOT
  // tenant-scoped — a row anywhere protects the object it points at, wherever that object is.
  let known: KnownAttachmentPaths;
  try {
    known = await loadKnownAttachmentPaths(deps);
  } catch (err) {
    console.error(`FAIL - ${err instanceof Error ? err.message : err}`);
    process.exit(1);
    return;
  }
  const externalHosts = Object.entries(known.external).sort((a, b) => b[1] - a[1]);
  const externalTotal = externalHosts.reduce((n, [, c]) => n + c, 0);
  console.log(`  attachment rows: ${known.rowCount} -> ${known.paths.size} distinct object path(s)`);
  if (externalTotal > 0) {
    // BY HOST, deliberately. `loremflickr.com: 2` is seed data and an operator nods;
    // `<some-other-ref>.supabase.co: 412` is a project migration and 412 legacy rows that
    // protect nothing. A bare total cannot tell those apart, and one of them should stop the
    // run. (A URL carrying our own bucket's public path shape on another host is refused
    // outright upstream and never reaches this line.)
    console.log(`  ${externalTotal} row(s) point at a host that is not our storage:`);
    for (const [h, n] of externalHosts) console.log(`    ${h}: ${n}`);
  }
  if (known.unresolved.length > 0) {
    console.log(
      `  WARN - ${known.unresolved.length} row(s) have an unresolvable object path; the org(s) ` +
        'owning them will be refused below.',
    );
  }

  // --all-orgs considers the union of the org table and the bucket's own top-level prefixes.
  // The table alone is blind to the largest orphan source there is (an org delete cascades
  // every Attachment row away and leaves every object behind), but a prefix with no
  // Organization row is only REPORTED unless --include-orgless-prefixes is passed — see
  // selectSweepTargets for why that case gets its own opt-in.
  let targets: Array<{ id: string; name: string }>;
  let skippedOrgless: string[] = [];
  if (allOrgs) {
    const dbOrgs = await runUnscoped(async () =>
      deps.prisma.organization.findMany({ select: { id: true, name: true }, orderBy: { name: 'asc' } }),
    );
    const selection = selectSweepTargets(
      dbOrgs,
      await discoverOrgPrefixes(deps.storage),
      includeOrglessPrefixes,
    );
    targets = selection.targets;
    skippedOrgless = selection.skippedOrgless;
    if (selection.skippedOrgless.length > 0) {
      console.log(
        `\n  WARN - ${selection.skippedOrgless.length} storage prefix(es) have NO Organization ` +
          'row and were SKIPPED. Their attachment rows were cascade-deleted with the org, so ' +
          'every per-org guard here is inert and the whole prefix would be condemned at once. ' +
          'Sweep one deliberately with --org=<prefix>, or pass --include-orgless-prefixes:',
      );
      for (const p of selection.skippedOrgless) console.log(`    ${p}`);
    }
  } else {
    targets = [{ id: orgId as string, name: orgId as string }];
  }

  if (targets.length === 0) {
    console.log('Nothing to do: no organizations or org-shaped prefixes to sweep.');
    return;
  }

  const runStartedAt = new Date().toISOString();
  const manifest = dryRun ? null : makeManifestWriter(runStartedAt, dbHost, host);

  let failedOrgs = 0;
  let totalOrphans = 0;
  let totalBytes = 0;
  let totalRemoved = 0;
  let totalRemoveFailures = 0;
  const orgsWithFindings: string[] = [];

  for (const org of targets) {
    try {
      const result = await runOrphanSweepForOrg(deps, {
        orgId: org.id,
        graceMs,
        dryRun,
        knownPaths: known,
        beforeDelete: manifest ? (paths) => manifest.write(org.id, paths) : undefined,
      });
      printResult(`${org.name} (${org.id})`, result);
      totalOrphans += result.counters.orphans;
      totalBytes += result.bytesReclaimable;
      totalRemoved += result.removed.length;
      totalRemoveFailures += result.failed.length;
      if (result.counters.orphans > 0) orgsWithFindings.push(`${org.name} (${org.id})`);
    } catch (err) {
      // One org's refusal must not stop the sweep, and must not be mistaken for a clean run.
      failedOrgs += 1;
      console.error(`\n${org.name} (${org.id}) FAILED — nothing deleted for this org:`);
      console.error(err instanceof Error ? err.message : err);
    }
  }

  // A closing block, because --all-orgs is thirteen orgs x ~25 lines and every warning
  // printed above it has scrolled away by now. This is the part that gets read at 2am.
  console.log('\n════ SUMMARY ════');
  console.log(`  storage ${host}  /  database ${dbHost} project=${dbRef}`);
  console.log(`  mode: ${dryRun ? 'DRY-RUN (nothing deleted)' : 'DELETE'}    grace: ${graceHours}h`);
  console.log(`  orgs swept:          ${targets.length - failedOrgs} of ${targets.length}`);
  if (failedOrgs > 0) console.log(`  FAIL - orgs refused: ${failedOrgs} (nothing deleted for those)`);
  if (skippedOrgless.length > 0) {
    console.log(`  WARN - orgless prefixes skipped: ${skippedOrgless.length} (--include-orgless-prefixes to sweep)`);
    for (const p of skippedOrgless) console.log(`      ${p}`);
  }
  console.log(`  orphans ${dryRun ? 'found' : 'targeted'}:     ${totalOrphans} (${mib(totalBytes)})`);
  if (!dryRun) {
    console.log(`  removed:             ${totalRemoved}`);
    if (totalRemoveFailures > 0) console.log(`  FAIL - not removed:  ${totalRemoveFailures}`);
    if (manifest) console.log(`  manifest:            ${manifest.file}`);
  }
  if (orgsWithFindings.length > 0) {
    console.log(`  orgs with findings:`);
    for (const o of orgsWithFindings) console.log(`      ${o}`);
  }

  // Delete failures reach the exit code. They used to be printed and nothing else, so
  // "storage rejected all 12 removals" exited 0 — indistinguishable from success to cron or
  // to a `&&` chain, which is the only place an exit code is read at all.
  const exitProblem = sweepExitProblem(failedOrgs, totalRemoveFailures);
  if (exitProblem) throw new Error(exitProblem);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error('Sweep failed:', err instanceof Error ? err.message : err);
      process.exit(1);
    });
}
