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
 * `frontend/test-file-count.json` (the test-file count, #3401) is deliberately NOT here: the brake makes every pull
 * request that adds or deletes a test file move it, and that bookkeeping is not an edit of the selector. The brake
 * still judges the count on every run, selected or full.
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

/** The always-run signal of a test whose import leaves the frontend folder (#3402). Needs the file's path, so it is not a source pattern. */
export const OUTSIDE_IMPORT_SIGNAL = 'imports-outside-frontend';

/**
 * Whether a local specifier, read from a frontend-relative file, resolves outside the frontend folder (`../../../backend/x`
 * from `src/__tests__/a.test.ts`). Path arithmetic only, no disk. `@/` is `src/`.
 */
export function leavesFrontend(fromPath, specifier) {
  const parts = specifier.startsWith('@/') ? ['src', ...specifier.slice(2).split('/')] : [...fromPath.split('/').slice(0, -1), ...specifier.split('/')];
  let depth = 0;
  for (const part of parts) {
    if (part === '' || part === '.') continue;
    if (part === '..') { depth -= 1; if (depth < 0) return true; } else depth += 1;
  }
  return false;
}

/**
 * The imports of each file that leave the frontend folder: [{ path, specifier }]. A file deleted or renamed outside the
 * frontend folder does not force a full run (#3402), which is only safe while every frontend file that imports from out
 * there is an always-run test. The guard test applies this to every file under `src/`.
 */
export function outsideImports(files) {
  return files.flatMap((f) => localImports(f.source).filter((s) => leavesFrontend(f.path, s)).map((specifier) => ({ path: f.path, specifier })));
}

/**
 * What in a workflow's text says it can run a frontend test or pull in another local workflow or action. A workflow on the
 * `workflows` trigger's `except` list must show none of it; the guard test applies this to each one (#3402).
 */
export const WORKFLOW_TEST_SIGNAL = /test:ci|vitest|\bnpm\s+(?:run\s+)?test\b|playwright|uses:\s*\.\/\.github\//;

// ---------------------------------------------------------------- reading outside the frontend folder (#3403)

/** Source text without comments, so a path named in a comment is not taken for one the code builds. */
function stripComments(source) {
  return source.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/(^|[^:'"`\\])\/\/[^\n]*/g, '$1');
}

/** Apply path segments to a folder (an array of names under the frontend folder). Returns null when the path climbs above it. */
function walkPath(start, segments) {
  const at = [...start];
  for (const part of segments) {
    if (part === '' || part === '.') continue;
    if (part === '..') { if (at.length === 0) return null; at.pop(); } else at.push(part);
  }
  return at;
}

/** The arguments of the call whose opening bracket is at `open`, split at top-level commas. Strings and nested brackets are skipped over. */
function callArgs(text, open) {
  const args = [];
  let depth = 0;
  let start = open + 1;
  for (let i = open; i < text.length; i++) {
    const c = text[i];
    if (c === "'" || c === '"' || c === '`') { i += 1; while (i < text.length && text[i] !== c) i += text[i] === '\\' ? 2 : 1; continue; }
    if (c === '(' || c === '[' || c === '{') depth += 1;
    else if (c === ')' || c === ']' || c === '}') { depth -= 1; if (depth === 0) { args.push(text.slice(start, i).trim()); return args.filter((a) => a !== ''); } }
    else if (c === ',' && depth === 1) { args.push(text.slice(start, i).trim()); start = i + 1; }
  }
  return null;
}

const PLAIN_STRING = /^(['"`])((?:(?!\1|\$\{)[^\\])*)\1$/;
const OWN_FILE = /^(?:__filename|import\.meta\.filename|fileURLToPath\(\s*import\.meta\.url\s*\))$/;
const FS_CALL_WITH_CLIMB = /\b(?:readFileSync|readdirSync|existsSync|statSync|lstatSync|openSync|createReadStream|readFile|readdir|stat|access)\(\s*(['"`])\.\.\//;

/**
 * Whether a module builds a path that leaves the frontend folder, or may (#3403). It follows the ways the tests build paths:
 * `resolve(...)` and `join(...)` from `__dirname`, `import.meta.dirname`, `dirname(fileURLToPath(import.meta.url))`, `process.cwd()`
 * (the frontend folder: the tests run from it) or a constant built the same way, with literal segments; `new URL('<path>',
 * import.meta.url)`; and a literal relative path. Returns the reasons found, in a fixed order:
 *
 *   `path-leaves-frontend`     a path that ends above the frontend folder
 *   `climbs-from-unknown-base` a `..` applied to something this cannot follow (a variable, a function result): counted as leaving
 *
 * `mod` is { path (frontend-relative), source }. No disk, no evaluation of code: text only, so it errs toward "leaves".
 */
export function pathsLeavingFrontend(mod) {
  const src = stripComments(mod.source);
  const here = mod.path.split('/').slice(0, -1);
  const consts = new Map();
  const found = new Set();
  const literal = (arg) => PLAIN_STRING.exec(arg)?.[2];
  /** The folder an expression names: an array, `null` when it leaves the frontend folder, `undefined` when it cannot be followed. */
  const folderOf = (expr) => {
    if (expr === '__dirname' || expr === 'import.meta.dirname') return here;
    if (expr === 'process.cwd()') return [];
    if (consts.has(expr)) return consts.get(expr);
    const dir = /^(?:path\.)?dirname\(([\s\S]*)\)$/.exec(expr);
    if (dir) {
      const inner = dir[1].trim();
      if (OWN_FILE.test(inner)) return here;
      const of = folderOf(inner);
      return of && of.length > 0 ? of.slice(0, -1) : of === undefined ? undefined : null;
    }
    const url = /^(?:fileURLToPath\(\s*)?new URL\(\s*(['"])([^'"]*)\1\s*,\s*import\.meta\.url\s*\)(?:\.pathname)?\s*\)?$/.exec(expr);
    if (url) return walkPath(here, url[2].split('/'));
    const call = /^(?:path\.)?(?:resolve|join)\(/.exec(expr);
    if (call && expr.endsWith(')')) return pathCall(callArgs(expr, call[0].length - 1));
    return undefined;
  };
  /** One resolve/join call: the folder it names, as far as its leading arguments can be followed. */
  function pathCall(args) {
    if (!args || args.length === 0) return undefined;
    const first = literal(args[0]);
    let at = first !== undefined ? (first.startsWith('/') ? undefined : walkPath([], first.split('/'))) : folderOf(args[0]);
    for (const arg of args.slice(1)) {
      const text = literal(arg);
      if (text === undefined) break; // a variable segment: what follows cannot be followed, what came before stands
      if (at === undefined) { if (text.split('/').includes('..')) found.add('climbs-from-unknown-base'); continue; }
      if (at === null) break;
      at = walkPath(at, text.split('/'));
    }
    if (at === null) found.add('path-leaves-frontend');
    return at;
  }
  // constants first, in source order, so a path built in two steps (FRONTEND, then REPO = resolve(FRONTEND, '..')) is followed
  for (const m of src.matchAll(/\b(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=;]+)?=\s*/g)) {
    const from = m.index + m[0].length;
    const head = /^(?:path\.)?(?:resolve|join|dirname)\(|^fileURLToPath\(|^new URL\(/.exec(src.slice(from, from + 40));
    if (!head) continue;
    const open = from + src.slice(from).indexOf('(');
    const args = callArgs(src, open);
    if (!args) continue;
    let end = open;
    for (let depth = 0; end < src.length; end++) {
      const c = src[end];
      if (c === "'" || c === '"' || c === '`') { end += 1; while (end < src.length && src[end] !== c) end += src[end] === '\\' ? 2 : 1; continue; }
      if (c === '(') depth += 1; else if (c === ')') { depth -= 1; if (depth === 0) break; }
    }
    const value = folderOf(src.slice(from, end + 1).trim());
    if (value === null) found.add('path-leaves-frontend');
    if (value !== undefined) consts.set(m[1], value);
  }
  for (const m of src.matchAll(/\b(?:path\.)?(?:resolve|join)\(/g)) pathCall(callArgs(src, m.index + m[0].length - 1));
  for (const m of src.matchAll(/new URL\(\s*(['"])([^'"]*)\1\s*,\s*import\.meta\.url/g)) if (walkPath(here, m[2].split('/')) === null) found.add('path-leaves-frontend');
  if (FS_CALL_WITH_CLIMB.test(src)) found.add('path-leaves-frontend'); // a bare relative path handed to the file system is read from the frontend folder
  const withoutImports = src.replace(/(?:^|[\s;{}])(?:import|export)\s[^;'"`]*?from\s+['"][^'"]*['"]/g, ' ').replace(/import\(\s*['"][^'"]*['"]\s*\)/g, ' ');
  for (const m of withoutImports.matchAll(/(['"`])((?:\.\.?\/)[^'"`\n]*)\1/g)) {
    if (m[2].includes('${')) { if (m[2].split('/').includes('..')) found.add('climbs-from-unknown-base'); } else if (walkPath(here, m[2].split('/')) === null) found.add('path-leaves-frontend');
  }
  if (/\$\{[^}]*\}\/\.\.(?:\/|['"`])/.test(src)) found.add('climbs-from-unknown-base');
  return ['path-leaves-frontend', 'climbs-from-unknown-base'].filter((r) => found.has(r));
}

/**
 * What makes a test one that can be affected from OUTSIDE the frontend folder (#3403): it imports a module from out there,
 * runs a child process (what that process reads cannot be seen from here, so it counts), or builds a path that leaves the
 * frontend folder. Judged on one module; `unlistedOutsideReaders` applies it to a test and the modules it imports.
 */
export function outsideReach(mod) {
  const found = [];
  if (localImports(mod.source).some((s) => leavesFrontend(mod.path, s))) found.push(OUTSIDE_IMPORT_SIGNAL);
  if (ALWAYS_RUN_SIGNALS['runs-child-process'].test(mod.source)) found.push('runs-child-process');
  return [...found, ...pathsLeavingFrontend(mod)];
}

/** Every always-run signal one module shows: the source patterns, and an import that leaves the frontend folder. */
function signalsOf(mod) {
  const found = alwaysRunSignals(mod.source);
  return localImports(mod.source).some((s) => leavesFrontend(mod.path, s)) ? [...found, OUTSIDE_IMPORT_SIGNAL] : found;
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
function signalsWithHelpers(file, readLocal, judge = signalsOf, follow = isTestSupportPath) {
  const signals = new Set(judge(file));
  const via = new Set();
  if (readLocal) {
    const seen = new Set([file.path]);
    const queue = [file];
    while (queue.length) {
      const from = queue.shift();
      for (const spec of localImports(from.source)) {
        if (leavesFrontend(from.path, spec)) continue; // judged as an outside import of `from`; nothing out there is read here
        const mod = readLocal(from.path, spec);
        if (!mod || seen.has(mod.path) || !follow(mod.path)) continue;
        seen.add(mod.path);
        const found = judge(mod);
        if (found.length) { found.forEach((s) => signals.add(s)); via.add(mod.path); }
        queue.push(mod);
      }
    }
  }
  return { signals: [...signals], via: [...via] };
}

/** Test support, and anything in the frontend folder that is not under `src/` (its scripts, its end-to-end helpers, its config files): none of it is application code. */
const isNotApplicationCode = (path) => isTestSupportPath(path) || !path.startsWith('src/');

/**
 * The outside-readers guard's check (#3403): test files that can be affected from outside the frontend folder (`outsideReach`, in
 * their own source or in a module they import that is not application code) and match no `outsideReaders` pattern. A pull
 * request that changes nothing under `frontend/` runs only that list, so a test missing from it would be skipped by exactly the
 * change that can break it.
 */
export function unlistedOutsideReaders({ files, outsideReaders, readLocal }) {
  return files
    .map((f) => ({ path: f.path, ...signalsWithHelpers(f, readLocal, outsideReach, isNotApplicationCode) }))
    .filter((f) => f.signals.length > 0 && !matchesAny(FRONTEND_PREFIX + f.path, outsideReaders))
    .map((f) => (f.via.length ? f : { path: f.path, signals: f.signals }));
}

/** The reverse check: tests on the `outsideReaders` list that show no way of being affected from outside the frontend folder. */
export function needlessOutsideReaders({ files, outsideReaders, readLocal }) {
  return files
    .filter((f) => matchesAny(FRONTEND_PREFIX + f.path, outsideReaders))
    .filter((f) => signalsWithHelpers(f, readLocal, outsideReach, isNotApplicationCode).signals.length === 0)
    .map((f) => f.path);
}

/**
 * The always-run guard's check: test files (frontend-relative `path` and `source`) that show a signal (a source pattern, or
 * an import that leaves the frontend folder), in their own source or (with `readLocal`) in a local module they import, and
 * match no always-run pattern. `alwaysRun` patterns are
 * repository-root relative, like the lists file.
 */
export function unlistedTests({ files, alwaysRun, readLocal }) {
  return files
    .map((f) => ({ path: f.path, ...signalsWithHelpers(f, readLocal) }))
    .filter((f) => f.signals.length > 0 && !matchesAny(FRONTEND_PREFIX + f.path, alwaysRun))
    .map((f) => (f.via.length ? f : { path: f.path, signals: f.signals }));
}

const compiledGlobs = new Map();

/** Glob to RegExp: `**` any depth, `*` within one segment, `?` one character, `{a,b}` alternatives. Compiled once per glob. */
export function globToRegExp(glob) {
  const known = compiledGlobs.get(glob);
  if (known) return known;
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
  const compiled = new RegExp(`^${re}$`);
  compiledGlobs.set(glob, compiled);
  return compiled;
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

/**
 * Whether a changed path fires a full-run trigger: it matches one of the trigger's patterns and none of its `except`
 * entries (#3402). `except` names the files under a pattern that cannot reach the frontend tests (the backend's manifest,
 * a workflow that runs no frontend test), so anything new under the pattern is still a full run until it is listed.
 */
export const firesTrigger = (trigger, path) => matchesAny(path, trigger.patterns) && !matchesAny(path, trigger.except ?? []);

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
 * @param {{alwaysRun:string[], outsideReaders?:string[], triggers:{code:string,patterns:string[],except?:string[]}[], knownAreas:string[]}} input.lists
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
    if (allPaths.some((p) => firesTrigger(t, p))) return full(t.code); // ROW:trigger
  }
  // Only inside the frontend folder (#3402): a module a test imports can vanish there without the tool's list showing it. Outside it,
  // the only frontend files that import or read anything are always-run tests (the guard test keeps that true), and those run anyway.
  const goneSource = (p) => p.startsWith(FRONTEND_PREFIX) && !isFrontendTest(p) && !isSnapshot(p);
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

  const reached = input.listed.filter(isFrontendTest).map(toFrontend);
  // Nothing under frontend/ changed (#3403): the only tests such a change can reach are the ones that read, import or run something
  // outside the frontend folder. The always-run tests that read only inside it see nothing new, so they are not run.
  if (allPaths.every((p) => !p.startsWith(FRONTEND_PREFIX))) {
    const outside = totalFiles.filter((f) => matchesAny(FRONTEND_PREFIX + f, lists.outsideReaders ?? []));
    if (outside.length === 0) return full('empty-outside-readers', { total: totalFiles.length }); // ROW:empty-outside-readers
    const files = [...new Set([...outside, ...reached])].sort();
    return { mode: 'selected', reason: 'no-frontend-change', files, total: totalFiles.length, alwaysRun: outside.length, detail: null };
  }

  const snapshotTests = [];
  for (const p of live.filter(isSnapshot)) {
    const dir = p.slice(0, p.lastIndexOf('/__snapshots__/'));
    const test = `${dir}/${p.slice(p.lastIndexOf('/') + 1).replace(/\.snap$/, '')}`;
    if (!trackedSet.has(test) || !isFrontendTest(test)) return full('snapshot-without-test', { detail: p, total: totalFiles.length }); // ROW:snapshot-without-test
    snapshotTests.push(toFrontend(test));
  }
  const changedTests = live.filter(isFrontendTest).map(toFrontend);
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
