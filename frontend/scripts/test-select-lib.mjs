/**
 * Test selection on pull requests into `staging` (#3257): the policy, as ONE pure function over facts that
 * test-select-io.mjs gathers (git, the test tool's own `list --changed` output, the environment). Nothing
 * here reads the disk, the clock, the network or the environment, so every row is unit-tested with planted
 * facts (src/__tests__/test-select-lib.test.ts).
 *
 * The answer is { mode: 'full' | 'selected', reason, files, total }. `full` is the default answer: every
 * doubt, every error and every shape the policy does not recognise is a full run with a reason code, and the
 * policy never makes a run red by itself. There is no "changed since the last green run" input, ever.
 *
 * Paths: `changed`, `tracked` and `listed` are repository-root relative with forward slashes
 * (`frontend/src/...`). `files` in the answer are relative to the frontend folder (`src/...`), the same
 * spelling the expected set and the reporter use.
 *
 * Every fail-open row is one line tagged `// ROW:<code>` so a revert drill can switch exactly one off.
 */
import { expectedFromTracked, isTestFile } from './test-ci-lib.mjs';

export const FRONTEND_PREFIX = 'frontend/';
/** More changed paths than this is a full run: a change that wide is not one the selector should reason about. */
export const MAX_CHANGED_PATHS = 300;
/** The child process that asks the test tool for the list gets this long, then it is killed and the run is full. */
export const LIST_LIMIT_MS = 60_000;
export const SELECTION_MODES = Object.freeze(['off', 'shadow', 'on']);

/**
 * The selector and its lists, hard-coded HERE and not read from the lists file, so a pull request that edits the
 * lists cannot also edit what counts as "the selector". A change to any of these is a full run.
 */
export const SELECTOR_PATHS = Object.freeze([
  'frontend/scripts/test-*',
  'frontend/scripts/__fixtures__/test-ci/**',
  'frontend/test-budget.json',
  'frontend/test-page-ceilings.json',
  'frontend/test-time-baseline.json',
]);

/** What makes a test unsafe to leave out by import graph alone. The guard test applies these to every test file. */
export const ALWAYS_RUN_SIGNALS = Object.freeze({
  'reads-disk': /from\s+['"](?:node:)?fs(?:\/promises)?['"]|require\(\s*['"](?:node:)?fs|\b(?:readFileSync|readdirSync|existsSync|statSync|lstatSync|openSync|createReadStream)\b|\bfs\.promises\b|import\.meta\.glob|\?raw['"]/,
  'runs-child-process': /child_process|\b(?:execSync|spawnSync|execFileSync)\b/,
  'computed-import': /import\(\s*[^'"\s)]|import\(\s*`[^`]*\$\{|require\(\s*[^'"\s)]|importActual\(\s*[^'"\s)]/,
});

/** Which signals a test file's source shows. Pure; the guard test and the planted-file test call it. */
export function alwaysRunSignals(source) {
  return Object.entries(ALWAYS_RUN_SIGNALS).filter(([, re]) => re.test(source)).map(([name]) => name);
}

/**
 * The local (relative or `@/`) module specifiers a source imports, re-exports or dynamically imports with a literal.
 * Type-only imports and exports are skipped: they are erased and read nothing at run time.
 */
export function localImports(source) {
  const found = new Set();
  const re = /(?:^|[\s;{}])(?:(import|export)\s+(type\s+)?(?:[^'"`;]*?\s+from\s+)?|import\(\s*)['"]((?:\.{1,2}\/|@\/)[^'"]*)['"]/g;
  for (const m of source.matchAll(re)) if (!m[2]) found.add(m[3]);
  return [...found];
}

/**
 * Whether a frontend-relative path is test support code (a helper, mock, fixture or harness) and not application code.
 * Application code is not followed: the test tool's import graph already sees it, so a change to it selects its tests.
 * Test support is where a disk read hides from the graph (a helper that scans the source tree, say).
 */
export function isTestSupportPath(path) {
  return /(^|\/)(__tests__|__mocks__|__fixtures__|test|tests|testing|test-utils|test-support|support|harness)(\/|$)/.test(path);
}

/**
 * The signals a test shows in its own source and in the local test-support modules it imports, transitively. `readLocal(fromPath,
 * specifier)` returns `{ path, source }` of a local module or null; without it only the test's own source is judged.
 * `via` names the helper files that carry a signal the test itself does not show.
 */
function signalsWithHelpers(file, readLocal) {
  const signals = new Set(alwaysRunSignals(file.source));
  const via = new Set();
  if (readLocal) {
    const seen = new Set([file.path]);
    const queue = [file];
    while (queue.length) {
      const from = queue.shift();
      for (const spec of localImports(from.source)) {
        const mod = readLocal(from.path, spec);
        if (!mod || seen.has(mod.path) || !isTestSupportPath(mod.path)) continue;
        seen.add(mod.path);
        const found = alwaysRunSignals(mod.source);
        if (found.length) { found.forEach((s) => signals.add(s)); via.add(mod.path); }
        queue.push(mod);
      }
    }
  }
  return { signals: [...signals], via: [...via] };
}

/**
 * The always-run guard's check: test files (frontend-relative `path` and `source`) that show a signal, in their own source
 * or (with `readLocal`) in a local module they import, and match no always-run pattern. `alwaysRun` patterns are
 * repository-root relative, like the lists file.
 */
export function unlistedTests({ files, alwaysRun, readLocal }) {
  return files
    .map((f) => ({ path: f.path, ...signalsWithHelpers(f, readLocal) }))
    .filter((f) => f.signals.length > 0 && !matchesAny(FRONTEND_PREFIX + f.path, alwaysRun))
    .map((f) => (f.via.length ? f : { path: f.path, signals: f.signals }));
}

/** Glob to RegExp: `**` any depth, `*` within one segment, `?` one character, `{a,b}` alternatives. */
export function globToRegExp(glob) {
  let re = '';
  let depth = 0;
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        if (glob[i + 2] === '/') { re += '(?:.*/)?'; i += 2; } else { re += '.*'; i += 1; }
      } else re += '[^/]*';
    } else if (c === '?') re += '[^/]';
    else if (c === '{') { re += '(?:'; depth += 1; }
    else if (c === '}' && depth > 0) { re += ')'; depth -= 1; }
    else if (c === ',' && depth > 0) re += '|';
    else re += c.replace(/[.+^$()|[\]\\]/g, '\\$&');
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(path, globs) {
  return globs.some((g) => globToRegExp(g).test(path));
}

/** The variable's value: unset or empty is `off`. Anything that is not exactly off, shadow or on is `invalid` (a full run). */
export function normalizeMode(raw) {
  const v = String(raw ?? '').trim();
  if (v === '') return 'off';
  return SELECTION_MODES.includes(v) ? v : 'invalid';
}

const full = (reason, extra = {}) => ({ mode: 'full', reason, files: [], total: extra.total ?? null, detail: extra.detail ?? null });

/** A repo-relative posix path, nothing else: no control characters, no backslash, not absolute, no `..`. */
export function isCleanPath(p) {
  return typeof p === 'string' && p !== '' && !/[\x00-\x1f\x7f\\]/.test(p) && !p.startsWith('/') && !p.startsWith('./') && !p.split('/').some((s) => s === '..' || s === '');
}

const isFrontendTest = (repoPath) => repoPath.startsWith(FRONTEND_PREFIX) && isTestFile(repoPath.slice(FRONTEND_PREFIX.length));
const isSnapshot = (p) => /(^|\/)__snapshots__\/[^/]+\.snap$/.test(p);
const toFrontend = (repoPath) => repoPath.slice(FRONTEND_PREFIX.length);

/**
 * The rows that need no git: the variable, the hosted shards, the event and the base branch. Returns a full
 * answer, or null when the decision needs the repository's facts.
 */
export function decideEarly({ mode, shard, event, baseRef }) {
  const m = normalizeMode(mode);
  if (m === 'off') return full('off'); // ROW:off
  if (m === 'invalid') return full('invalid-mode'); // ROW:invalid-mode
  if (shard) return full('hosted-shard'); // ROW:hosted-shard
  if (event === 'schedule') return full('nightly'); // ROW:nightly
  if (event === 'workflow_dispatch' || !event) return full('manual'); // ROW:manual
  if (event !== 'pull_request') return full('not-pull-request'); // ROW:not-pull-request
  if (baseRef === 'main') return full('promotion-into-main'); // ROW:promotion-into-main
  if (baseRef !== 'staging') return full('base-not-staging'); // ROW:base-not-staging
  return null;
}

/**
 * @param {object} input
 * @param {string}   [input.mode]          the variable's raw value
 * @param {boolean}  [input.shard]         the command was given --shard (the hosted fallback)
 * @param {string}   [input.event]         GITHUB_EVENT_NAME
 * @param {string}   [input.baseRef]       GITHUB_BASE_REF
 * @param {string}   [input.eventHeadSha]  the pull request's head commit from the event payload
 * @param {string[]|null} input.parents    HEAD's parent commits (a merge ref has two: base tip, then the head)
 * @param {boolean|null} input.shallow     whether the clone is shallow (null = could not tell)
 * @param {string|null} input.mergeBase    the merge base of the two parents
 * @param {string|null} input.baseUsed     the base the test tool was asked about (--changed <baseUsed>)
 * @param {string|null} input.diffTree     the tree the changed-path diff was taken from
 * @param {string|null} input.listTree     the tree the test tool's list was taken from ('dirty' when it differed from HEAD)
 * @param {{status:string,path:string,oldPath?:string}[]|null} input.changed  git name-status of base..HEAD
 * @param {string[]} input.tracked         every tracked path, repository-root relative
 * @param {string[]|null} input.listed     the test tool's `list --changed` files, repository-root relative (null = unreadable)
 * @param {null|'threw'|'timeout'} [input.selectorError]
 * @param {{alwaysRun:string[], triggers:{code:string,patterns:string[]}[], knownAreas:string[]}} input.lists
 */
export function decideSelection(input) {
  const early = decideEarly(input);
  if (early) return early;
  const { lists } = input;
  if (input.selectorError === 'timeout') return full('selector-timeout'); // ROW:selector-timeout
  if (input.selectorError) return full('selector-threw'); // ROW:selector-threw
  if (input.shallow !== false) return full('shallow-clone'); // ROW:shallow-clone
  const parents = input.parents;
  if (!Array.isArray(parents) || parents.length !== 2) return full('not-two-parent-merge'); // ROW:not-two-parent-merge
  if (!input.eventHeadSha || parents[1] !== input.eventHeadSha) return full('head-mismatch'); // ROW:head-mismatch
  if (!input.mergeBase) return full('no-merge-base'); // ROW:no-merge-base
  if (input.baseUsed !== input.mergeBase) return full('base-not-merge-base'); // ROW:base-not-merge-base
  if (!input.diffTree || input.diffTree !== input.listTree) return full('tree-mismatch'); // ROW:tree-mismatch
  const changed = input.changed;
  if (!Array.isArray(changed)) return full('no-changed-list'); // ROW:no-changed-list
  const allPaths = changed.flatMap((c) => [c.path, ...(c.oldPath ? [c.oldPath] : [])]);
  if (allPaths.some((p) => matchesAny(p, SELECTOR_PATHS))) return full('selector-edited'); // ROW:selector-edited
  if (changed.length > MAX_CHANGED_PATHS) return full('too-many-paths'); // ROW:too-many-paths
  const known = (p) => isCleanPath(p) && (matchesAny(p, lists.knownAreas) || lists.triggers.some((t) => matchesAny(p, t.patterns)));
  if (changed.some((c) => !['A', 'M', 'D', 'R'].includes(c.status) || !allPathsOf(c).every(known))) return full('unclassified-path'); // ROW:unclassified-path
  for (const t of lists.triggers) {
    if (allPaths.some((p) => matchesAny(p, t.patterns))) return full(t.code); // ROW:trigger
  }
  const goneSource = (p) => !isFrontendTest(p) && !isSnapshot(p);
  if (changed.some((c) => c.status === 'D' && goneSource(c.path))) return full('deleted-source'); // ROW:deleted-source
  if (changed.some((c) => c.status === 'R' && goneSource(c.oldPath))) return full('renamed-source'); // ROW:renamed-source

  const trackedSet = new Set(input.tracked);
  const lower = new Map();
  let collision = false;
  for (const p of input.tracked) {
    const l = p.toLowerCase();
    if (lower.has(l) && lower.get(l) !== p) collision = true;
    lower.set(l, p);
  }
  if (collision) return full('case-mismatch', { detail: 'two tracked paths differ only in case' }); // ROW:case-mismatch-tracked
  const live = changed.filter((c) => c.status !== 'D').map((c) => c.path);
  const missing = live.find((p) => !trackedSet.has(p));
  if (missing !== undefined) return full(lower.has(missing.toLowerCase()) ? 'case-mismatch' : 'changed-not-tracked', { detail: missing }); // ROW:changed-not-tracked
  if (!Array.isArray(input.listed)) return full('selector-bad-output'); // ROW:selector-bad-output
  const stray = input.listed.find((p) => !trackedSet.has(p));
  if (stray !== undefined) return full(lower.has(stray.toLowerCase()) ? 'case-mismatch' : 'listed-not-tracked', { detail: stray }); // ROW:case-mismatch-listed

  const trackedFrontend = input.tracked.filter((p) => p.startsWith(FRONTEND_PREFIX)).map(toFrontend);
  const totalFiles = expectedFromTracked(trackedFrontend);
  const alwaysRun = totalFiles.filter((f) => matchesAny(FRONTEND_PREFIX + f, lists.alwaysRun));
  if (alwaysRun.length === 0) return full('empty-always-run', { total: totalFiles.length }); // ROW:empty-always-run

  const snapshotTests = [];
  for (const p of live.filter(isSnapshot)) {
    const dir = p.slice(0, p.lastIndexOf('/__snapshots__/'));
    const test = `${dir}/${p.slice(p.lastIndexOf('/') + 1).replace(/\.snap$/, '')}`;
    if (!trackedSet.has(test) || !isFrontendTest(test)) return full('snapshot-without-test', { detail: p, total: totalFiles.length }); // ROW:snapshot-without-test
    snapshotTests.push(toFrontend(test));
  }
  const changedTests = live.filter(isFrontendTest).map(toFrontend);
  const reached = input.listed.filter(isFrontendTest).map(toFrontend);
  const files = [...new Set([...alwaysRun, ...reached, ...changedTests, ...snapshotTests])].sort();
  const extra = files.length - alwaysRun.length;
  return { mode: 'selected', reason: extra > 0 ? 'changed-files' : 'always-run-only', files, total: totalFiles.length, alwaysRun: alwaysRun.length, detail: null };
}

function allPathsOf(c) {
  return [c.path, ...(c.oldPath ? [c.oldPath] : [])];
}

/** "selected N of M, reason" or "full, reason": the one phrase for logs, the summary and the verdict line. */
export function selectionPhrase(d) {
  return d.mode === 'selected' ? `selected ${d.files.length} of ${d.total}, reason=${d.reason}` : `full, reason=${d.reason}`;
}

/** The files that failed in a run (from the verdict's detail), as the reporter spells them. Never throws. */
export function failingFiles(detail) {
  const out = new Set();
  const add = (list) => { for (const e of list ?? []) { const f = typeof e === 'string' ? e : e?.file; if (typeof f === 'string' && f) out.add(f); } };
  for (const key of ['failedTests', 'suiteErrors', 'loadErrors', 'hookTimeouts', 'deadWorkers', 'neverRan', 'missing', 'unfinished', 'zeroTests', 'unreported', 'undeclaredSkips']) add(detail?.[key]);
  return [...out].sort();
}

/** Shadow mode's report: what the selector would have run beside what failed. A miss is a failing file outside the would-be selection. */
export function shadowReport({ decision, failing }) {
  const set = new Set(decision.mode === 'selected' ? decision.files : []);
  const misses = decision.mode === 'selected' ? failing.filter((f) => !set.has(f)) : [];
  const would = decision.mode === 'selected' ? `selected-${decision.files.length}-of-${decision.total}` : 'full';
  const line = `TEST-SELECT-SHADOW would=${would} reason=${decision.reason} failing=${failing.length} misses=${misses.length}`;
  return { line, misses };
}
