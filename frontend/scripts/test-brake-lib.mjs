/**
 * The brake on frontend test growth (#3254), as pure functions. Nothing here reads the disk, the
 * clock, git or the environment: `npm run test:ci` (test-ci.mjs) gathers the facts (the event file of
 * #3253, the changed-file list, the scanned page imports, the committed JSON files and their copies at
 * the pull request's base) and prints what these functions decide. Table-tested in
 * src/__tests__/test-brake-lib.test.ts.
 *
 * Four ratchets, one rule: fail-open on WHICH files are judged (no changed-file list = ratchet 1 judges
 * nothing and says so), never fail-open on a file that is judged.
 *
 *   1. Time ceiling on the pull request's own test files (a test over 2 s or a file over 10 s of body
 *      time), judged on a re-run alone, minus the over-the-line list that may only shrink.
 *   2. Per-page file-count ceiling (how many test files import each page-level module).
 *   3. The budget of a full run (CPU-seconds, minutes of test step, number of test files).
 *   4. The 20 slowest files, printed on every full run.
 */
import ts from 'typescript';
import { isTestFile } from './test-ci-lib.mjs';

export const BRAKE_EXIT_CODE = 15;
/** A test over this many milliseconds of body time fails the check (strictly over). */
export const TEST_LIMIT_MS = 2000;
/** A file over this many milliseconds of summed body time fails the check (strictly over). */
export const FILE_LIMIT_MS = 10_000;
/** A page-level module that is not in the ceilings file starts at this many test files. */
export const NEW_PAGE_START = 3;
export const SLOWEST_COUNT = 20;

/** Body time of one test event: the last attempt's real time when it was retried, else the tool's duration. */
export function bodyMs(testEvent) {
  const attempts = testEvent.attempts;
  if (Array.isArray(attempts) && attempts.length > 0) return Number(attempts[attempts.length - 1].ms) || 0;
  return Number(testEvent.duration) || 0;
}

/** Per-file body facts from an event file: { file -> { ms, tests: [{ name, ms }] } }. */
export function fileTimes(events) {
  const files = new Map();
  for (const e of events) {
    if (e.ev !== 'test' || typeof e.file !== 'string') continue;
    const rec = files.get(e.file) ?? { ms: 0, tests: [] };
    const ms = bodyMs(e);
    rec.ms += ms;
    rec.tests.push({ name: e.name, ms });
    files.set(e.file, rec);
  }
  return files;
}

/** The key of one over-the-line test in the list: `<file> > <test name>`. */
export const testKey = (file, name) => `${file} > ${name}`;

/**
 * Tests and files over the line, in a set of files. `only` limits the judging to those files
 * (the pull request's added or changed test files); `listed` is the over-the-line list (exact entries).
 * Returns { tests: [{file,name,ms}], files: [{file,ms}] } of the unlisted offenders.
 */
export function overTheLine({ events, only, listed = { tests: [], files: [] } }) {
  const judge = only ? new Set(only) : null;
  const listedTests = new Set(listed.tests ?? []);
  const listedFiles = new Set(listed.files ?? []);
  const tests = [];
  const files = [];
  for (const [file, rec] of fileTimes(events)) {
    if (judge && !judge.has(file)) continue;
    for (const t of rec.tests) {
      if (t.ms > TEST_LIMIT_MS && !listedTests.has(testKey(file, t.name))) tests.push({ file, name: t.name, ms: t.ms });
    }
    if (rec.ms > FILE_LIMIT_MS && !listedFiles.has(file)) files.push({ file, ms: rec.ms });
  }
  return { tests, files };
}

/**
 * Why the time ceiling is NOT JUDGED regardless of the changed-file list, or null when it is judged (R17, Ran's decision).
 * Only the staging -> main promotion pull request is skipped: every change in it was already time-judged on its way into
 * staging, and re-running every file alone would take about 24 minutes. A promote/* or hotfix branch, any other head into
 * main, and a missing head are all judged (fail closed toward judging). Pure: the caller reads the three environment values.
 */
export function timeCeilingSkipReason({ event, baseRef, headRef }) {
  return event === 'pull_request' && baseRef === 'main' && headRef === 'staging' ? 'PR from staging into main' : null;
}

/**
 * Ratchet 1. First run: events of the whole run. Files over the line (in the changed test files) are
 * re-run alone once, and judged on that run only. `rerunEventsOf(file)` gives the events of that lone
 * re-run (the caller runs it), or null when the re-run produced nothing: a judged file with no re-run
 * result is red, never green.
 *
 * With a `skipReason` (R17: the staging -> main promotion) the time ceiling is not judged and no file is re-run.
 * Without a changed-file list (push, local run) nothing is judged and the result says so.
 */
export function timeCeiling({ events, changed, listed, skipReason = null }) {
  if (skipReason) {
    return { status: 'not-judged', reason: skipReason, skipped: true, judged: [], offenders: [], suspects: [] };
  }
  if (changed == null) {
    return { status: 'not-judged', reason: 'no-changed-file-list', judged: [], offenders: [], suspects: [] };
  }
  const first = overTheLine({ events, only: changed, listed });
  const suspectFiles = [...new Set([...first.tests.map((t) => t.file), ...first.files.map((f) => f.file)])].sort();
  return {
    status: suspectFiles.length === 0 ? 'passed' : 'rerun-needed',
    reason: null,
    judged: changed.filter((f) => /\.test\.tsx?$/.test(f)),
    offenders: [],
    suspects: suspectFiles,
  };
}

/** The final judgement of ratchet 1 once the lone re-runs are in: { file -> events | null }. */
export function judgeReruns({ suspects, rerunEvents, listed }) {
  const offenders = [];
  const cleared = [];
  for (const file of suspects) {
    const events = rerunEvents[file];
    if (!events || !events.some((e) => e.ev === 'test' && e.file === file)) {
      offenders.push({ kind: 'rerun-missing', file, name: null, ms: null });
      continue;
    }
    if (events.some((e) => e.ev === 'test' && e.file === file && e.status === 'failed')) {
      offenders.push({ kind: 'rerun-failed', file, name: null, ms: null });
      continue;
    }
    const again = overTheLine({ events, only: [file], listed });
    for (const t of again.tests) offenders.push({ kind: 'test-over-2s', file, name: t.name, ms: t.ms });
    for (const f of again.files) offenders.push({ kind: 'file-over-10s', file, name: null, ms: f.ms });
    if (again.tests.length === 0 && again.files.length === 0) cleared.push(file);
  }
  return { status: offenders.length ? 'failed' : 'passed', offenders, cleared };
}

/** One line per offender, naming the file (and test). */
export function offenderLine(o) {
  if (o.kind === 'rerun-missing') return `${o.file}: over the line, and its lone re-run reported nothing`;
  if (o.kind === 'rerun-failed') return `${o.file}: over the line, and its lone re-run failed`;
  if (o.kind === 'test-over-2s') return `${o.file} > ${o.name}: ${Math.round(o.ms)} ms, over the ${TEST_LIMIT_MS} ms limit for one test (on a re-run alone)`;
  return `${o.file}: ${Math.round(o.ms)} ms of test time, over the ${FILE_LIMIT_MS} ms limit for one file (on a re-run alone)`;
}

/**
 * The over-the-line list may only shrink: every entry must already be in the copy at the base.
 * `base` null = no base to compare with (push, local, or the file is new in this change): not judged.
 */
export function listMayOnlyShrink({ current, base }) {
  if (base == null) return { status: 'not-judged', grown: [] };
  const had = new Set([...(base.tests ?? []), ...(base.files ?? [])]);
  const grown = [...(current.tests ?? []), ...(current.files ?? [])].filter((e) => !had.has(e));
  return { status: grown.length ? 'failed' : 'passed', grown };
}

/** The list a run writes when asked to generate a baseline: every offender of the whole event file, sorted. */
export function buildBaseline(events) {
  const found = overTheLine({ events });
  return {
    tests: found.tests.map((t) => testKey(t.file, t.name)).sort(),
    files: found.files.map((f) => f.file).sort(),
  };
}

// ---------------------------------------------------------------- ratchet 2: per-page file counts

/**
 * Every module specifier a source file imports: static, side-effect, type-only, export-from, dynamic `import('x')`
 * and `require('x')`, read by the TypeScript lexer, so comments and strings can never hide or fake an import
 * (a hand-written comment stripper did: a block-comment opener inside a line comment swallowed the imports after it).
 * A `vi.mock('x')` is NOT an import: a test that only stubs a page does not mount it, so it does not count against the
 * page's file ceiling.
 */
export function importSpecifiers(source) {
  return ts.preProcessFile(source, true, true).importedFiles.map((f) => f.fileName);
}

const posixDir = (p) => p.split('/').slice(0, -1).join('/');
function normalize(path) {
  const out = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop();
    else out.push(part);
  }
  return out.join('/');
}
const stripExt = (p) => p.replace(/\.(?:[cm]?[jt]sx?)$/, '');

/** Where a specifier points, as a path without extension relative to the frontend folder, or null for a package. */
export function resolveSpecifier(specifier, fromFile) {
  if (specifier.startsWith('@/')) return stripExt(normalize(`src/${specifier.slice(2)}`));
  if (specifier.startsWith('.')) return stripExt(normalize(`${posixDir(fromFile)}/${specifier}`));
  return null;
}

/** A page-level module: a tracked `*Page.tsx` under src/pages that is not a test. */
export function isPageModule(path) {
  return /^src\/pages\/.*Page\.tsx$/.test(path) && !/(^|\/)__tests__\//.test(path) && !/\.test\.tsx?$/.test(path);
}

/**
 * The ONE place that says which harness mounts which page (#3259, decision D14). A test file mounts a page when it
 * imports the page OR that page's harness, so moving a file onto the harness never lowers the page's number by itself:
 * ceilings fall only when files are really merged. Page path -> harness module paths (relative to the frontend folder).
 */
export const PAGE_HARNESSES = {
  'src/pages/v2/jobs/JobDetailPage.tsx': ['src/__tests__/harness/jobDetailPage.tsx'],
  'src/pages/v2/leads/LeadDetailPage.tsx': ['src/__tests__/harness/leadDetailPage.tsx'],
  'src/pages/v2/estimates/EstimateWorkspacePage.tsx': ['src/__tests__/harness/estimateWorkspacePage.tsx'],
  'src/pages/v2/schedule/SchedulePage.tsx': ['src/__tests__/harness/schedulePage.tsx'],
  'src/pages/v2/auth-public/PublicEstimatePage.tsx': ['src/__tests__/harness/publicEstimatePage.tsx'],
  'src/pages/v2/invoices/InvoiceDetailPage.tsx': ['src/__tests__/harness/invoiceDetailPage.tsx'],
  'src/pages/v2/inventory/InventoryPage.tsx': ['src/__tests__/harness/inventoryPage.tsx'],
  'src/pages/v2/dashboard/DashboardPage.tsx': ['src/__tests__/harness/dashboardPage.tsx'],
  'src/pages/v2/communication/InboxPage.tsx': ['src/__tests__/harness/inboxPage.tsx'],
  'src/pages/v2/leads/LeadFormPage.tsx': ['src/__tests__/harness/leadFormPage.tsx'],
};

/**
 * Which registered pages each module of the app reaches by imports (static, dynamic, `import.meta.glob`), so that the
 * guard of `page-harnesses.guard.test.ts` can check a test which mounts a page through a route table or the public app.
 * It is NOT part of the brake's count: a test of a route table imports every page through it and mounts one.
 * `modules` = [{ path, source }] for the non-test sources outside any `__tests__` folder; `pages` = the pages to follow.
 * Returns { <module path without extension>: [page paths] } for the modules that reach at least one page. Pages are the
 * end of a walk: what a page itself imports is the page's business.
 */
export function pageReach({ modules, pages }) {
  const wanted = new Set(pages);
  const byBase = new Map();
  for (const m of modules) {
    byBase.set(stripExt(m.path), m.path);
    if (/\/index\.[cm]?[jt]sx?$/.test(m.path)) byBase.set(m.path.replace(/\/index\.[cm]?[jt]sx?$/, ''), m.path);
  }
  const edges = new Map();
  for (const m of modules) {
    const to = new Set();
    for (const spec of importSpecifiers(m.source)) {
      const target = resolveSpecifier(spec, m.path);
      const file = target && byBase.get(target);
      if (file) to.add(file);
    }
    for (const g of m.source.matchAll(/import\.meta\.glob(?:<[^>]*>)?\(\s*['"]([^'"]+)['"]/g)) {
      const pattern = normalize(`${posixDir(m.path)}/${g[1]}`);
      const re = new RegExp(`^${pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '(?:.*/)?').replace(/\*/g, '[^/]*')}$`);
      for (const candidate of byBase.values()) if (re.test(candidate)) to.add(candidate);
    }
    edges.set(m.path, to);
  }
  const memo = new Map();
  const walk = (path, stack) => {
    if (memo.has(path)) return memo.get(path);
    if (stack.has(path)) return new Set();
    stack.add(path);
    const out = new Set();
    for (const next of edges.get(path) ?? []) {
      if (wanted.has(next)) out.add(next);
      else if (!isPageModule(next)) for (const p of walk(next, stack)) out.add(p);
    }
    stack.delete(path);
    memo.set(path, out);
    return out;
  };
  const reach = {};
  for (const m of modules) {
    if (wanted.has(m.path)) continue;
    const found = walk(m.path, new Set());
    if (!found.size) continue;
    const list = [...found].sort();
    reach[stripExt(m.path)] = list;
    if (/\/index\.[cm]?[jt]sx?$/.test(m.path)) reach[m.path.replace(/\/index\.[cm]?[jt]sx?$/, '')] = list;
  }
  return reach;
}

/**
 * How many test files mount each page-level module (import the page, or its harness from PAGE_HARNESSES).
 * `tests` = [{ path, source }]; `pages` = page module paths; `harnesses` = the page-to-harness map (default PAGE_HARNESSES).
 * A test file counts once per page. Pages nobody mounts are left out (they are not in the count file).
 */
export function scanPageImports({ tests, pages, harnesses = PAGE_HARNESSES }) {
  const byBase = new Map(pages.map((p) => [stripExt(p), p]));
  for (const [page, files] of Object.entries(harnesses)) {
    if (pages.includes(page)) for (const h of files) byBase.set(stripExt(h), page);
  }
  const counts = {};
  for (const t of tests) {
    const hit = new Set();
    for (const spec of importSpecifiers(t.source)) {
      const target = resolveSpecifier(spec, t.path);
      const page = target && byBase.get(target);
      if (page) hit.add(page);
    }
    for (const page of hit) counts[page] = (counts[page] ?? 0) + 1;
  }
  return Object.fromEntries(Object.entries(counts).sort(([a], [b]) => a.localeCompare(b)));
}

/**
 * The page-level modules this pull request grew: a changed or added test file that imports a page now and did not
 * before. `changed` = [{ path, source, baseSource }]; `baseSource` is the file's text at the base (null for an added
 * file), read from the old path when the file was renamed. Judging only these pages is what makes a ceiling the
 * pull request's own business: a page it did not touch can never fail it (#3254, Ran's decision R10).
 */
export function pagesGrownBy({ changed, pages }) {
  const grown = new Set();
  for (const c of changed) {
    const now = scanPageImports({ tests: [{ path: c.path, source: c.source }], pages });
    const before = c.baseSource == null ? {} : scanPageImports({ tests: [{ path: c.path, source: c.baseSource }], pages });
    for (const page of Object.keys(now)) if (!before[page]) grown.add(page);
  }
  return [...grown].sort();
}

/**
 * Ratchet 2. `actual` = the scan; `ceilings` = the committed file; `baseCeilings` = the file at the pull request's
 * base (null when there is none: not compared); `grown` = the pages this pull request's own test files newly mount
 * (see pagesGrownBy), or null when there is no base to tell (then the ceilings are NOT JUDGED, and the result says
 * so: never a pass).
 * A page fails its ceiling only if the pull request grew it AND it is over (a page missing from the file starts at 3).
 * A ceiling raised above the base's number fails, and so does a new page's ceiling above 3. Lowering is free.
 */
export const NO_BASE_REASON = 'no base: shallow checkout or no remote';
export function pageCeilings({ actual, ceilings, baseCeilings, grown = null }) {
  // No base (a shallow checkout, a shard, a local run with no remote): the ceilings are NOT JUDGED and the result says
  // so. Never a pass, and never an absolute check: with no base the run cannot tell this change's pages from the rest.
  if (grown == null) return { status: 'not-judged', problems: [], comparedToBase: false, judged: 'none', reason: NO_BASE_REASON };
  const problems = [];
  const judge = new Set(grown);
  for (const [page, n] of Object.entries(actual)) {
    if (!judge.has(page)) continue;
    const ceiling = ceilings[page] ?? NEW_PAGE_START;
    if (n > ceiling) problems.push({ kind: 'over-ceiling', page, actual: n, ceiling });
  }
  if (baseCeilings != null) {
    for (const [page, ceiling] of Object.entries(ceilings)) {
      const was = baseCeilings[page];
      if (was === undefined && ceiling > NEW_PAGE_START) problems.push({ kind: 'new-page-over-start', page, ceiling, was: NEW_PAGE_START });
      else if (was !== undefined && ceiling > was) problems.push({ kind: 'ceiling-raised', page, ceiling, was });
    }
  }
  return { status: problems.length ? 'failed' : 'passed', problems, comparedToBase: baseCeilings != null, judged: 'own-change' };
}

export function pageProblemLine(p) {
  if (p.kind === 'over-ceiling') return `${p.page}: ${p.actual} test files import it, the ceiling is ${p.ceiling}. Add the cases to an existing test file of that page.`;
  if (p.kind === 'ceiling-raised') return `${p.page}: the ceiling was raised from ${p.was} to ${p.ceiling}. A ceiling may only go down.`;
  return `${p.page}: a new page starts at ${NEW_PAGE_START} test files, the file says ${p.ceiling}.`;
}

// ---------------------------------------------------------------- ratchet 3: the budget of a full run

/** Total CPU-seconds from the `cpu` event the reporter writes at run end. null when not measured. */
export function cpuSecondsOf(events) {
  const e = [...events].reverse().find((x) => x.ev === 'cpu');
  return e && Number.isFinite(e.seconds) ? e.seconds : null;
}

/**
 * Ratchet 3, for a FULL run only (a selected or sharded run is never judged against the full budget).
 * `measured` = { cpuSeconds|null, minutes, files, workers }. Minutes are judged only when `nightly` is true (the
 * nightly full run on the idle machine) and only at the budget's worker count; at another count they are reported, not judged. A figure that could not be
 * measured is red (`cpu-not-measured`), never silently green.
 *
 * `budget.cpuEnforcement` ("warn" | "fail") decides what CPU over budget does: "warn" puts `cpu-over-budget`
 * in `warnings` (printed and in the job summary, exit unchanged) until a 6-worker Mac baseline exists;
 * "fail" makes it a problem (exit 15). Missing or unknown is invalid and reads as "fail", with a note, so a
 * typo can never switch the brake off. Every other reason is unaffected.
 */
export const CPU_ENFORCEMENTS = ['warn', 'fail'];
export function checkBudget({ budget, measured, mode, nightly = false }) {
  if (mode !== 'full') return { status: 'not-judged', reason: `${mode}-run`, problems: [], warnings: [], notes: [] };
  const problems = [];
  const warnings = [];
  const notes = [];
  const valid = CPU_ENFORCEMENTS.includes(budget.cpuEnforcement);
  if (!valid) notes.push(`cpuEnforcement is missing or invalid (${JSON.stringify(budget.cpuEnforcement) ?? 'missing'}): treated as "fail". Use "warn" or "fail".`);
  const cpuEnforcement = valid ? budget.cpuEnforcement : 'fail';
  if (measured.cpuSeconds == null) problems.push('cpu-not-measured');
  else if (measured.cpuSeconds > budget.maxCpuSeconds) (cpuEnforcement === 'warn' ? warnings : problems).push('cpu-over-budget');
  // The minutes budget is the idle machine's (#3249): a pull request or push run shares the Mac with the Backend and Database checks,
  // so its minutes are only reported. The nightly full run (TEST_CI_NIGHTLY=1, ci-nightly.yml) is the one that compares them.
  if (!nightly) notes.push(`minutes not judged: only the nightly run on the idle machine is compared (this run: ${Number(measured.minutes).toFixed(1)} minutes at ${measured.workers} workers, budget ${Number(budget.maxMinutes).toFixed(1)})`);
  else if (measured.workers === budget.workers) {
    if (measured.minutes > budget.maxMinutes) problems.push('minutes-over-budget');
  } else notes.push(`minutes not judged: run at ${measured.workers} workers, budget at ${budget.workers}`);
  return { status: problems.length ? 'failed' : 'passed', reason: null, problems, warnings, notes };
}

/** How many tracked paths are test files the tool runs (the expected set of test:ci). */
export function countTestFiles(trackedPaths) {
  return new Set(trackedPaths.filter(isTestFile)).size;
}

/**
 * The test-file count, judged on the pull request's OWN change (Ran's decision R10, on top of R2's exact count):
 * the net change in test files against the base must equal this pull request's change to maxTestFiles in the same
 * diff (adding k files = raising the budget by k; deleting = lowering it). A number the pull request did not change
 * can never fail it, so two pull requests that each add a file and merge cleanly never turn a third one red.
 *
 * `base` = { files, maxTestFiles } at the merge-base, or null when there is no base (a shallow checkout, a local run
 * without a remote, or maxTestFiles is new in this change): then the count is NOT JUDGED and the note says so.
 */
export function checkFileCount({ files, maxTestFiles, base }) {
  if (base == null) {
    return {
      status: 'not-judged', judged: 'none', problems: [],
      notes: [`test files: not judged (${NO_BASE_REASON})`],
      line: null,
    };
  }
  const filesDelta = files - base.files;
  const budgetDelta = maxTestFiles - base.maxTestFiles;
  const ok = filesDelta === budgetDelta;
  const sign = (n) => (n >= 0 ? `+${n}` : `${n}`);
  return {
    status: ok ? 'passed' : 'failed', judged: 'own-change',
    problems: ok ? [] : ['file-count-not-in-budget'],
    notes: [],
    line: ok ? null : `this change moves the test files by ${sign(filesDelta)} (${base.files} -> ${files}) but maxTestFiles by ${sign(budgetDelta)} (${base.maxTestFiles} -> ${maxTestFiles}). Move maxTestFiles by ${sign(filesDelta)} in the same diff.`,
  };
}

/** The line printed and shown in the summary when CPU is over a budget that is warn only. */
export function cpuWarningLine({ budget, measured }) {
  return `WARNING: CPU-seconds ${Math.round(measured.cpuSeconds)} over the budget of ${budget.maxCpuSeconds} (warn only, not enforced)`;
}

/** The budget figures for the job summary: measured against the budget, on every full run. */
export function budgetTable({ budget, measured }) {
  const cpu = measured.cpuSeconds == null ? 'not measured' : `${Math.round(measured.cpuSeconds)}`;
  return [
    '| Figure | Measured | Budget |',
    '|---|---|---|',
    `| CPU-seconds | ${cpu} | ${budget.maxCpuSeconds} |`,
    `| Minutes of test step (${measured.workers} workers) | ${measured.minutes.toFixed(1)} | ${budget.maxMinutes.toFixed(1)} (at ${budget.workers} workers) |`,
    `| Test files (moves with maxTestFiles) | ${measured.files} | ${budget.maxTestFiles} |`,
  ].join('\n');
}

// ---------------------------------------------------------------- ratchet 4: the slowest files

/** The slowest files of a run by summed body time, slowest first. */
export function slowestFiles(events, count = SLOWEST_COUNT) {
  return [...fileTimes(events)]
    .map(([file, rec]) => ({ file, ms: rec.ms, tests: rec.tests.length }))
    .sort((a, b) => b.ms - a.ms || a.file.localeCompare(b.file))
    .slice(0, count);
}

export function slowestTable(rows) {
  return ['| # | File | Seconds | Tests |', '|---|---|---|---|', ...rows.map((r, i) => `| ${i + 1} | ${r.file} | ${(r.ms / 1000).toFixed(1)} | ${r.tests} |`)].join('\n');
}

// ---------------------------------------------------------------- the whole brake, one verdict

export function brakeLine({ result, reasons, notJudged = [] }) {
  const extra = notJudged.map((n) => ` ${n}`).join('');
  return `TEST-BRAKE-VERDICT result=${result} code=${result === 'failed' ? BRAKE_EXIT_CODE : 0} reasons=${reasons.length ? reasons.join(',') : 'none'}${extra}`;
}

/** The job summary section of the brake: markdown. */
export function renderBrakeSummary({ time, lists, pages, budget, budgetFigures, slowest, line, cpuWarning = null, fileCount = null }) {
  const out = ['## Test growth brake', '', '```', line, '```', ''];
  out.push('### Time ceiling (files this pull request added or changed)', '');
  if (time.status === 'not-judged') out.push(`Not judged: ${time.reason === 'no-changed-file-list' ? 'no pull request base, so no list of changed files' : time.skipped ? `${time.reason}, the time of a promotion is not judged` : time.reason}. Nothing was checked.`);
  else if (time.final?.offenders?.length) out.push(...time.final.offenders.map((o) => `- ${offenderLine(o)}`));
  else out.push(`${time.judged.length} changed test file(s) judged. None over the line${time.final?.cleared?.length ? ` after a lone re-run (${time.final.cleared.join(', ')})` : ''}.`);
  out.push('', '### Over-the-line list', '');
  out.push(lists.status === 'not-judged' ? 'Not compared with the base (no base copy). Nothing was checked.' : lists.grown.length ? lists.grown.map((e) => `- grew: ${e}`).join('\n') : 'Did not grow.');
  out.push('', '### Test files per page', '');
  if (pages.status === 'not-judged') out.push(`Not judged (${pages.reason}). The ceilings were not checked.`);
  else out.push('Judged on the pages this pull request added test files for.');
  if (pages.status !== 'not-judged') out.push(pages.problems.length ? pages.problems.map((p) => `- ${pageProblemLine(p)}`).join('\n') : `Within the ceilings${pages.comparedToBase ? '' : ' (no base copy: raising was not compared)'}.`);
  if (fileCount) {
    out.push('', '### Test file count', '');
    out.push(fileCount.status === 'failed' ? `- ${fileCount.line}` : fileCount.status === 'not-judged' ? 'Not judged. The count was not checked.' : 'This change moves maxTestFiles by exactly the change in test files.', ...fileCount.notes.map((n) => `- ${n}`));
  }
  out.push('', '### Budget', '');
  if (budget.status === 'not-judged') out.push(`Not judged on a ${budget.reason.replace('-run', '')} run.`);
  else out.push(budgetFigures, '', budget.problems.length ? budget.problems.map((p) => `- ${p}`).join('\n') : budget.warnings?.length ? (cpuWarning ?? budget.warnings.join(', ')) : 'Within budget.', ...budget.notes.map((n) => `- ${n}`));
  if (slowest) out.push('', `### ${slowest.length} slowest files`, '', slowestTable(slowest));
  out.push('');
  return out.join('\n');
}
