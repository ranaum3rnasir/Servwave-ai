/**
 * The disk and git side of the brake (#3254): reads the committed JSON files, scans the sources, asks git
 * for the pull request's changed files and for the base's copy of a file. All decisions are in
 * test-brake-lib.mjs; this file only gathers facts and returns them as plain values.
 *
 * Ratchet 1 needs the pull request's changed-file list: `--changed-from=FILE` (one path per line, relative
 * to the frontend folder) or, on a pull request run, the base branch from GITHUB_BASE_REF. On a push or a
 * local run there is no base and the list is `null`: ratchet 1 judges nothing and says so.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve, sep } from 'node:path';
import { COUNT_IN_OLD_PLACE_REASON, checkFileCount, countTestFiles, isPageModule, pageCeilings, pagesGrownBy, scanPageImports } from './test-brake-lib.mjs';

export const BUDGET_FILE = 'test-budget.json';
/** The test-file count (#3401). Its own file, NOT on the selector's guarded list: moving the count with the files is not an edit of the selector. */
export const FILE_COUNT_FILE = 'test-file-count.json';
export const PAGE_CEILINGS_FILE = 'test-page-ceilings.json';
export const TIME_LIST_FILE = 'test-time-baseline.json';

const git = (cwd, args) => execFileSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, stdio: ['ignore', 'pipe', 'pipe'] });

export function readJson(path) {
  return JSON.parse(readFileSync(path, 'utf8'));
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    if (name === 'node_modules') continue;
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

/** Every `src/**` file as a posix path relative to the frontend folder. */
export function sourceFiles(frontend) {
  return walk(join(frontend, 'src')).map((f) => relative(frontend, f).split(sep).join('/'));
}

/** { path -> count } of test files per page-level module, scanned from the sources on disk. */
export function scanPages(frontend) {
  const all = sourceFiles(frontend);
  const pages = all.filter(isPageModule);
  const tests = all.filter((p) => /\.test\.tsx?$/.test(p)).map((p) => ({ path: p, source: readFileSync(join(frontend, p), 'utf8') }));
  return { counts: scanPageImports({ tests, pages }), testFiles: tests.length, pages };
}

/**
 * The ref a pull request's own change is measured against, in ONE place (changedFiles and resolveBase both use it).
 * `--base=REF` wins; else origin/$GITHUB_BASE_REF (a pull request into main too: the merge-base with origin/main).
 * Returns null when no ref applies; `fallback` is used when there is no GITHUB_BASE_REF at all.
 */
function baseRef({ base, env, fallback = null }) {
  if (base) return base;
  return env.GITHUB_BASE_REF ? `origin/${env.GITHUB_BASE_REF}` : fallback;
}

/**
 * The files the pull request added or changed, relative to the frontend folder; `null` when there is no base.
 * `--changed-from` wins; else GITHUB_BASE_REF on a pull_request event; `--base=REF` for a local drill.
 */
export function changedFiles(frontend, { changedFrom, base, env }) {
  if (changedFrom) return readFileSync(resolve(changedFrom), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean);
  const ref = base ?? (env.GITHUB_EVENT_NAME === 'pull_request' ? baseRef({ env }) : null);
  if (!ref) return null;
  try {
    const out = git(frontend, ['diff', '--name-only', '--relative', '--diff-filter=AMRC', '-z', `${ref}...HEAD`, '--', '.']);
    return out.split('\0').filter(Boolean);
  } catch {
    return null; // base not fetched: nothing is judged, and the summary says so
  }
}

/**
 * The pull request's base: the merge-base of HEAD with `--base=REF`, else origin/$GITHUB_BASE_REF else origin/staging.
 * The merge-base, not the tip of the base branch: a number another pull request changed after this one branched is not
 * this pull request's change, so it can never fail it. `null` when no base can be resolved (a local run with no remote,
 * a shallow checkout without the base branch): the callers then say so and do NOT judge the page ceilings or the file count, and say so (never a pass).
 * Returns { ref, commit }.
 */
export function resolveBase(frontend, { base, env }) {
  const ref = baseRef({ base, env, fallback: 'origin/staging' });
  try {
    const commit = git(frontend, ['merge-base', ref, 'HEAD']).trim();
    return commit ? { ref, commit } : null;
  } catch {
    return null;
  }
}

/** The base's copy of a committed JSON file, or null when there is no base or the file is new in this change. */
export function baseCopy(frontend, name, resolved) {
  if (!resolved) return null;
  try {
    return JSON.parse(git(frontend, ['show', `${resolved.commit}:./${name}`]));
  } catch {
    return null;
  }
}

/** Count of test files the tool runs at the base commit, or at HEAD's index when `resolved` is null. */
export function trackedTestCount(frontend, resolved) {
  const out = resolved
    ? git(frontend, ['ls-tree', '-r', '-z', '--name-only', resolved.commit, '--', 'src'])
    : git(frontend, ['ls-files', '-z', '--', 'src']);
  return countTestFiles(out.split('\0').filter(Boolean));
}

/**
 * The test files this pull request added, changed or renamed, with their text now and at the base:
 * [{ path, source, baseSource }] (baseSource null for an added file). Deleted files are not in it.
 */
export function changedTestSources(frontend, resolved) {
  const out = git(frontend, ['diff', '--name-status', '-M', '-z', '--relative', resolved.commit, '--', 'src']).split('\0').filter(Boolean);
  const rows = [];
  for (let i = 0; i < out.length;) {
    const status = out[i++];
    const kind = status[0];
    const first = out[i++];
    const second = kind === 'R' || kind === 'C' ? out[i++] : null;
    rows.push({ kind, oldPath: first, path: second ?? first });
  }
  const sources = [];
  for (const r of rows) {
    if (r.kind === 'D' || !/\.test\.tsx?$/.test(r.path)) continue;
    const full = join(frontend, r.path);
    if (!existsSync(full)) continue;
    let baseSource = null;
    if (r.kind !== 'A' && r.kind !== 'C') {
      try { baseSource = git(frontend, ['show', `${resolved.commit}:./${r.oldPath}`]); } catch { baseSource = null; }
    }
    sources.push({ path: r.path, source: readFileSync(full, 'utf8'), baseSource });
  }
  return sources;
}

export function loadBrakeFiles(frontend, overrides = {}) {
  const at = (name, key) => resolve(overrides[key] ?? join(frontend, name));
  const listPath = at(TIME_LIST_FILE, 'timeList');
  const budgetFile = readJson(at(BUDGET_FILE, 'budget'));
  const countPath = at(FILE_COUNT_FILE, 'fileCount');
  // Loud, never a silent pass: a count in the old place or no count file at all is an error, not "not judged".
  if ('maxTestFiles' in budgetFile) throw new Error(`${BUDGET_FILE} carries maxTestFiles: the count lives in ${FILE_COUNT_FILE} (#3401). Move it there.`);
  if (!existsSync(countPath)) throw new Error(`${FILE_COUNT_FILE} is missing: maxTestFiles lives there (#3401).`);
  return {
    // The count is read from its own file and carried on the budget object, so the budget table and the weekly report keep one shape.
    budget: { ...budgetFile, maxTestFiles: readJson(countPath).maxTestFiles },
    ceilings: readJson(at(PAGE_CEILINGS_FILE, 'pageCeilings')),
    listed: existsSync(listPath) ? readJson(listPath) : { tests: [], files: [] },
  };
}

export function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

/**
 * Ratchets 2 and the test-file count, judged on this change's own difference against its base (Ran's R10).
 * The file count is judged on every run. Returns the loaded files, the resolved base (or null:
 * then both checks are not-judged, and each result says so), the scan and the two verdicts.
 */
export function judgeGrowth(frontend, { base, env, overrides = {} }) {
  const files = loadBrakeFiles(frontend, overrides);
  const resolved = resolveBase(frontend, { base, env });
  const scan = scanPages(frontend);
  const grown = resolved ? pagesGrownBy({ changed: changedTestSources(frontend, resolved), pages: scan.pages }) : null;
  const pages = pageCeilings({ actual: scan.counts, ceilings: files.ceilings, baseCeilings: baseCopy(frontend, PAGE_CEILINGS_FILE, resolved), grown });
  // On EVERY run, selected and shard runs too: the count is a `git ls-files` count and does not depend on which tests ran. Judged only
  // on full runs, a selected pull request that adds a file and forgets maxTestFiles would go green and turn the promotion red later.
  // With no base the count is not judged anyway, so a root that is not a git work tree (a fixture, a copied folder) is not an error there.
  let filesNow = 0;
  try { filesNow = trackedTestCount(frontend, null); } catch (e) { if (resolved) throw e; }
  const baseCount = baseCopy(frontend, FILE_COUNT_FILE, resolved);
  const baseFiles = resolved && Number.isInteger(baseCount?.maxTestFiles) ? { files: trackedTestCount(frontend, resolved), maxTestFiles: baseCount.maxTestFiles } : null;
  // A base from before #3401 keeps the count in the budget file: this change's own difference cannot be read from it, so the
  // count is NOT JUDGED and the verdict line and the summary say why (never a silent pass).
  const inOldPlace = !baseFiles && Number.isInteger(baseCopy(frontend, BUDGET_FILE, resolved)?.maxTestFiles);
  const fileCount = checkFileCount({ files: filesNow, maxTestFiles: files.budget.maxTestFiles, base: baseFiles, reason: inOldPlace ? COUNT_IN_OLD_PLACE_REASON : undefined });
  return { files, resolved, scan, pages, fileCount, filesNow };
}
