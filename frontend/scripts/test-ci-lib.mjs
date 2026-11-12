/**
 * The decisions behind `npm run test:ci` (#3253), as pure functions over a captured event file
 * and an expected-file list. Nothing here reads the disk, the clock or the environment, so every
 * row of the verdict table is unit-tested with planted event files
 * (src/__tests__/test-ci-lib.test.ts). The command itself (test-ci.mjs) only runs the test tool,
 * collects the events and prints what these functions decide.
 *
 * The event file is JSON lines appended by our own reporter (test-ci-reporter.mjs) as events
 * happen. The test tool's own report is written at the end, has no retry count, no real file
 * timings and no "zero tests" status, so it is never the source of truth.
 *
 * Event shapes (every line also carries `t`, epoch milliseconds):
 *   { ev: 'file-start',     file }
 *   { ev: 'file-collected', file, tests }
 *   { ev: 'test',           file, name, status: 'passed'|'failed'|'skipped'|'todo', duration,
 *                           retries, errors: string[],      errors = one message per failed attempt
 *                           attempts?: [{ attempt, ms, status }] }  real per-attempt times from the setup file
 *   { ev: 'file-end',       file, state: 'passed'|'failed'|'skipped', errors: string[], suiteErrors: string[] }
 *   (the reporter also writes a 'test' line for every test the tool knows about at file end that never
 *    got a result callback: `.only` under --allowOnly=false is a failed test with a "[Vitest] Unexpected
 *    .only modifier" error, a throwing beforeAll fails its suite and skips the tests under it)
 *   { ev: 'unhandled',      message }
 *   { ev: 'run-end',        reason }
 */
import { createHash } from 'node:crypto';
import { join } from 'node:path';

/** Result words and their exit codes. 0 is the only green. */
export const EXIT_CODES = Object.freeze({
  passed: 0,
  failed: 10,
  incomplete: 11,
  stalled: 12,
  overloaded: 13,
  cancelled: 14,
});

export const DEFAULT_WORKERS = 4;
export const DEFAULT_IDLE_MS = 240_000;
export const DEFAULT_TEST_TIMEOUT_MS = 30_000;
export const DEFAULT_FILE_MARGIN_MS = 60_000;
export const DEFAULT_MAX_RETRIED = 10;
export const BAIL_ON_PULL_REQUEST = 50;
/** `--retry=N` of the test tool: a failing test runs up to N more times, so a test's share of the clock is (N + 1) attempts. */
export const RETRIES = 2;

const HOOK_TIMEOUT = /hook timed out/i;
const WORKER_DEAD = /worker exited unexpectedly|timeout (?:waiting|terminating) (?:for )?(?:the )?worker|\[vitest-pool\]|worker.*(?:terminated|crashed)/i;
const ONLY_PRESENT = /unexpected \.only/i;

/** The test tool's include pattern (frontend/vitest.config.ts): src/**\/*.test.{ts,tsx}. */
export function isTestFile(path) {
  return path.startsWith('src/') && /\.test\.(ts|tsx)$/.test(path);
}

/** The expected set: tracked files (paths relative to the frontend folder) that the tool would run. */
export function expectedFromTracked(trackedPaths) {
  return [...new Set(trackedPaths.filter(isTestFile))].sort();
}

/**
 * The slice of the full list that shard `index` of `count` runs, computed the way the test tool does
 * (vitest 4 BaseSequencer.shard + calculateShardRange): sort by the sha1 of "/<path relative to the
 * root>", then deal contiguous ranges whose sizes differ by at most one, the larger ones first.
 */
export function shardSlice(files, index, count) {
  const n = files.length;
  const base = Math.floor(n / count);
  const remainder = n % count;
  let start;
  let end;
  if (remainder >= index) {
    start = (base + 1) * (index - 1);
    end = (base + 1) * index;
  } else {
    start = remainder * (base + 1) + (index - remainder - 1) * base;
    end = start + base;
  }
  return files
    .map((file) => ({ file, hash: createHash('sha1').update(`/${file}`).digest('hex') }))
    .sort((a, b) => (a.hash < b.hash ? -1 : a.hash > b.hash ? 1 : 0))
    .slice(start, end)
    .map((x) => x.file);
}

/** "2/6" -> { index: 2, count: 6 }; anything else throws. */
export function parseShard(text) {
  const m = /^(\d+)\/(\d+)$/.exec(String(text));
  if (!m) throw new Error(`bad --shard "${text}" (want N/M)`);
  const index = Number(m[1]);
  const count = Number(m[2]);
  if (index < 1 || count < 1 || index > count) throw new Error(`bad --shard "${text}" (want 1 <= N <= M)`);
  return { index, count };
}

/**
 * Worker count: never above an explicitly set FRONTEND_TEST_WORKERS or VITEST_MAX_WORKERS, 4 when
 * neither is set. A fixed number, never sensed from load.
 */
export function resolveWorkers(env) {
  const set = [];
  for (const name of ['FRONTEND_TEST_WORKERS', 'VITEST_MAX_WORKERS']) {
    const raw = env[name];
    if (raw === undefined || raw === '') continue;
    const n = Number(raw);
    if (!Number.isInteger(n) || n < 1) throw new Error(`${name}="${raw}" is not a positive whole number`);
    set.push({ name, n });
  }
  if (set.length === 0) return { workers: DEFAULT_WORKERS, why: `default ${DEFAULT_WORKERS} (no worker variable set)` };
  const lowest = set.reduce((a, b) => (b.n < a.n ? b : a));
  return { workers: lowest.n, why: `${lowest.name}=${lowest.n}` };
}

/** Where the compiled-code cache lives, relative to `frontend/`: inside node_modules, so a clean install empties it. */
export const COMPILE_CACHE_DIR = 'node_modules/.cache/test-ci/compile-cache';

/**
 * Node's compile cache for the test tool and its workers (docs/ci.md, "The compile cache"). Every test file runs in a
 * fresh worker process, and each one compiles the same tool code again (the fake browser, the test library, React).
 * With one shared directory a worker reuses what an earlier worker compiled. Returns the variables to add to the
 * tool's environment and a line for the preflight block. A NODE_COMPILE_CACHE the caller set is left alone, and so is
 * NODE_DISABLE_COMPILE_CACHE, Node's own off switch.
 */
export function compileCache(env, frontend) {
  if (env.NODE_DISABLE_COMPILE_CACHE) return { vars: {}, why: 'off (NODE_DISABLE_COMPILE_CACHE is set)' };
  if (env.NODE_COMPILE_CACHE) return { vars: {}, why: 'the directory in NODE_COMPILE_CACHE (set by the caller)' };
  return { vars: { NODE_COMPILE_CACHE: join(frontend, COMPILE_CACHE_DIR) }, why: COMPILE_CACHE_DIR };
}

/** Arguments for the test tool. `--retry=2`, explicit `--allowOnly=false`, `--bail=50` on pull requests. */
export function buildVitestArgs({ reporterPath, shard, bail, files, config }) {
  const args = ['run', '--reporter=default', `--reporter=${reporterPath}`, `--retry=${RETRIES}`, '--allowOnly=false'];
  if (config) args.push(`--config=${config}`);
  if (bail) args.push(`--bail=${bail}`);
  if (shard) args.push(`--shard=${shard.index}/${shard.count}`);
  if (files && files.length > 0) args.push(...files);
  return args;
}

/** Parse the JSON-lines event file. Lines that are not valid JSON objects are counted, not dropped silently. */
export function parseEvents(text) {
  const events = [];
  let badLines = 0;
  for (const line of String(text).split('\n')) {
    if (line.trim() === '') continue;
    try {
      const obj = JSON.parse(line);
      if (obj && typeof obj === 'object' && typeof obj.ev === 'string') events.push(obj);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return { events, badLines };
}

function firstLine(text) {
  return String(text ?? '').split('\n').find((l) => l.trim() !== '')?.trim() ?? '';
}

/** Per-file facts from the events, in one pass. */
function foldEvents(events) {
  const files = new Map();
  const get = (f) => {
    let rec = files.get(f);
    if (!rec) {
      rec = { starts: 0, ends: 0, collected: null, tests: [], moduleErrors: [], suiteErrors: [], state: null, lastT: 0, firstT: null };
      files.set(f, rec);
    }
    return rec;
  };
  const unhandled = [];
  let runEnd = null;
  for (const e of events) {
    if (e.ev === 'unhandled') {
      unhandled.push(String(e.message ?? ''));
    } else if (e.ev === 'run-end') {
      runEnd = e;
    } else if (typeof e.file === 'string') {
      const rec = get(e.file);
      rec.lastT = Math.max(rec.lastT, e.t ?? 0);
      if (e.ev === 'file-start') {
        rec.starts += 1;
        rec.firstT ??= e.t ?? null;
      } else if (e.ev === 'file-collected') rec.collected = e.tests ?? 0;
      else if (e.ev === 'test') rec.tests.push(e);
      else if (e.ev === 'file-end') {
        rec.ends += 1;
        rec.state = e.state;
        rec.moduleErrors.push(...(e.errors ?? []));
        rec.suiteErrors.push(...(e.suiteErrors ?? []));
      }
    }
  }
  return { files, unhandled, runEnd };
}

/**
 * The verdict.
 *
 * @param {object} input
 * @param {object[]} input.events          parsed event lines
 * @param {string[]} input.expected        expected test files (paths as the reporter writes them)
 * @param {number|null} input.toolExitCode the test tool's exit code (null when it was killed)
 * @param {string[]} input.args            the arguments the tool was started with
 * @param {object} input.policy            { floor, skipAllowList: {file: count}, maxRetried }
 * @param {'full'|'selected'|'shard'} [input.mode]  floor is enforced for full only
 * @param {number} [input.badLines]        unreadable event lines
 * @param {object|null} [input.stalled]    set by the watchdog: { kind, lastHealthyFile, inFlight }
 * @param {boolean} [input.cancelled]
 */
export function evaluate(input) {
  const { events, expected, toolExitCode, args, policy } = input;
  const mode = input.mode ?? 'full';
  const reasons = { failed: [], incomplete: [], overloaded: [] };
  const detail = {
    missing: [], extra: [], duplicated: [], zeroTests: [], unfinished: [], undeclaredSkips: [],
    failedTests: [], suiteErrors: [], neverRan: [], unreported: [], retried: [], loadErrors: [], unhandled: [], hookTimeouts: [], deadWorkers: [],
  };

  const { files, unhandled, runEnd } = foldEvents(events);
  const expectedSet = new Set(expected);

  // --- completeness: the ran set equals the expected set, each file once ---
  for (const f of expectedSet) if (!files.has(f) || files.get(f).starts === 0) detail.missing.push(f);
  for (const f of files.keys()) if (!expectedSet.has(f)) detail.extra.push(f);
  for (const [f, rec] of files) {
    if (rec.starts > 1 || rec.ends > 1) detail.duplicated.push(f);
    if (rec.starts >= 1 && rec.ends === 0) detail.unfinished.push(f);
  }

  // --- counts, retries, skips ---
  let passed = 0;
  let failed = 0;
  let skipped = 0;
  const skipsByFile = new Map();
  for (const [f, rec] of files) {
    let filePassed = 0;
    let fileSkipped = 0;
    for (const t of rec.tests) {
      const retries = t.retries ?? 0;
      const errors = t.errors ?? [];
      if (t.status === 'passed') filePassed += 1;
      else if (t.status === 'failed' && errors.some((m) => ONLY_PRESENT.test(m))) {
        reasons.incomplete.push('only-present');
      } else if (t.status === 'failed') {
        failed += 1;
        detail.failedTests.push({ file: f, name: t.name, firstError: firstLine(errors[errors.length - 1] ?? errors[0]) });
      } else if (t.status === 'skipped' || t.status === 'todo') fileSkipped += 1;
      else detail.neverRan.push({ file: f, name: t.name, status: t.status });
      if (retries > 0) {
        detail.retried.push({
          file: f, name: t.name, attempts: retries + 1, status: t.status, duration: t.duration ?? 0,
          attemptTimes: t.attempts ?? null, firstError: firstLine(errors[0]),
        });
      }
      if (errors.some((m) => HOOK_TIMEOUT.test(m))) detail.hookTimeouts.push({ file: f, name: t.name });
    }
    passed += filePassed;
    skipped += fileSkipped;
    skipsByFile.set(f, fileSkipped);
    const allowed = policy.skipAllowList?.[f] ?? 0;
    if (fileSkipped > allowed) detail.undeclaredSkips.push({ file: f, skipped: fileSkipped, allowed });
    // zero tests: nothing passed, unless the whole file is the declared skipped file
    const declaredWhole = allowed > 0 && fileSkipped > 0 && fileSkipped <= allowed && rec.tests.every((t) => t.status === 'skipped' || t.status === 'todo');
    if (rec.starts >= 1 && rec.ends >= 1 && filePassed === 0 && !declaredWhole) {
      const loadFailed = rec.state === 'failed' && rec.tests.length === 0;
      if (!loadFailed) detail.zeroTests.push(f);
    }
    if (rec.ends >= 1 && rec.collected != null && rec.tests.length < rec.collected) detail.unreported.push(f);
    // suite-level errors (a throwing beforeAll in a describe)
    for (const m of rec.suiteErrors) {
      if (ONLY_PRESENT.test(m)) reasons.incomplete.push('only-present');
      else if (HOOK_TIMEOUT.test(m)) detail.hookTimeouts.push({ file: f, name: '(suite hook)' });
      else if (WORKER_DEAD.test(m)) detail.deadWorkers.push({ file: f, message: firstLine(m) });
      else detail.suiteErrors.push({ file: f, message: firstLine(m) });
    }
    // module-level errors: a file that failed to load, `.only`, a dead worker
    for (const m of rec.moduleErrors) {
      if (ONLY_PRESENT.test(m)) reasons.incomplete.push('only-present');
      else if (HOOK_TIMEOUT.test(m)) detail.hookTimeouts.push({ file: f, name: '(file hook)' });
      else if (WORKER_DEAD.test(m)) detail.deadWorkers.push({ file: f, message: firstLine(m) });
      else detail.loadErrors.push({ file: f, message: firstLine(m) });
    }
    if (rec.ends >= 1 && rec.state === 'failed' && rec.moduleErrors.length === 0 && rec.suiteErrors.length === 0 && rec.tests.every((t) => t.status !== 'failed')) {
      detail.loadErrors.push({ file: f, message: 'file failed without a failed test or an error' });
    }
  }
  for (const m of unhandled) {
    if (ONLY_PRESENT.test(m)) reasons.incomplete.push('only-present');
    else if (WORKER_DEAD.test(m)) detail.deadWorkers.push({ file: null, message: firstLine(m) });
    else detail.unhandled.push(firstLine(m));
  }

  const retriedCount = detail.retried.length;

  // --- failed: tests, load errors, unhandled errors, hook timeouts, dead workers ---
  if (failed > 0) reasons.failed.push('tests-failed');
  if (detail.loadErrors.length > 0) reasons.failed.push('file-failed-to-load');
  if (detail.suiteErrors.length > 0) reasons.failed.push('suite-failed');
  if (detail.unhandled.length > 0) reasons.failed.push('unhandled-error');
  if (detail.deadWorkers.length > 0) reasons.failed.push('dead-worker');
  // A hook timeout is never covered by a retry, even when the retry passed.
  if (detail.hookTimeouts.length > 0) reasons.failed.push('hook-timeout');

  // --- incomplete ---
  if (detail.missing.length > 0) reasons.incomplete.push('file-missing');
  if (detail.extra.length > 0) reasons.incomplete.push('file-extra');
  if (detail.duplicated.length > 0) reasons.incomplete.push('file-seen-twice');
  if (detail.unfinished.length > 0) reasons.incomplete.push('file-unfinished');
  if (detail.neverRan.length > 0) reasons.incomplete.push('test-never-ran');
  if (detail.unreported.length > 0) reasons.incomplete.push('test-unreported');
  if (detail.zeroTests.length > 0) reasons.incomplete.push('zero-tests');
  if (detail.undeclaredSkips.length > 0) reasons.incomplete.push('undeclared-skip');
  if (!Number.isInteger(policy.floor) || policy.floor < 1) reasons.incomplete.push('invalid-floor');
  else if (mode === 'full' && passed < policy.floor) reasons.incomplete.push('floor-not-met');
  // a selected run's floor (#3257) is the always-run list's size, passed in by the command; every file needs one passed test anyway
  if (mode === 'selected' && Number.isInteger(policy.selectedFloor) && passed < policy.selectedFloor) reasons.incomplete.push('floor-not-met');
  if (!args.includes('--allowOnly=false')) reasons.incomplete.push('allow-only-not-false');
  if ((input.badLines ?? 0) > 0) reasons.incomplete.push('unreadable-event-line');
  if (runEnd === null && !input.stalled && !input.cancelled) reasons.incomplete.push('run-never-ended');
  if (toolExitCode !== 0 && !input.stalled && !input.cancelled && reasons.failed.length === 0 && reasons.incomplete.length === 0) {
    reasons.incomplete.push('tool-exit-nonzero-clean-report');
  }

  // --- overloaded ---
  if (retriedCount > (policy.maxRetried ?? DEFAULT_MAX_RETRIED)) reasons.overloaded.push('too-many-retries');

  let result = 'passed';
  let why = [];
  if (input.cancelled) { result = 'cancelled'; why = ['runner-cancel']; }
  else if (input.stalled) { result = 'stalled'; why = [input.stalled.kind]; }
  else if (reasons.failed.length > 0) { result = 'failed'; why = reasons.failed; }
  else if (reasons.incomplete.length > 0) { result = 'incomplete'; why = [...new Set(reasons.incomplete)]; }
  else if (reasons.overloaded.length > 0) { result = 'overloaded'; why = reasons.overloaded; }

  return {
    result,
    code: EXIT_CODES[result],
    reasons: why,
    allReasons: { ...reasons, incomplete: [...new Set(reasons.incomplete)] },
    counts: { filesExpected: expectedSet.size, filesRan: files.size, passed, failed, skipped, retried: retriedCount },
    detail,
  };
}

/** `evaluate`, but an exception inside the check is red ("incomplete"), never "unknown" and never green. */
export function evaluateSafely(input) {
  try {
    return evaluate(input);
  } catch (err) {
    return {
      result: 'incomplete',
      code: EXIT_CODES.incomplete,
      reasons: ['check-exception'],
      allReasons: { failed: [], incomplete: ['check-exception'], overloaded: [] },
      counts: { filesExpected: 0, filesRan: 0, passed: 0, failed: 0, skipped: 0, retried: 0 },
      detail: { checkError: String(err?.message ?? err) },
    };
  }
}

/** The one machine-readable verdict line. */
export function verdictLine(verdict, { mode = 'full', shard = null, selected = null, selection = null } = {}) {
  const c = verdict.counts;
  const modeText = shard ? `shard-${shard.index}-of-${shard.count}` : selected ? `selected-${selected.n}-of-${selected.of}` : mode;
  return [
    'TEST-CI-VERDICT',
    `result=${verdict.result}`,
    `code=${verdict.code}`,
    `reasons=${verdict.reasons.length ? verdict.reasons.join(',') : 'none'}`,
    `mode=${modeText}`,
    // test selection (#3257): why this run is full or selected; absent when the selection variable is off, so that line is unchanged
    ...(selection ? [`selection=${selection}`] : []),
    `files=${c.filesRan}/${c.filesExpected}`,
    `passed=${c.passed}`,
    `failed=${c.failed}`,
    `retried=${c.retried}`,
  ].join(' ');
}

/**
 * One log line per retried test (#3258): `TEST-CI-RETRIED attempts=<n> file=<file> test=<name>`. The job log is the only record of a run
 * that GitHub's API gives back (the job summary is not), so the weekly CI report reads these lines to count the same test across runs.
 * The test name is last and has its whitespace collapsed, so a line is always one line.
 */
export function retriedLines(verdict) {
  return (verdict?.detail?.retried ?? []).map((r) => `TEST-CI-RETRIED attempts=${r.attempts} file=${r.file} test=${String(r.name).replace(/\s+/g, ' ').trim()}`);
}

/**
 * The watchdog's decision. `null` while healthy. Stalled when no reporter event has arrived for
 * `idleMs`, or when one file has been running longer than its share: testTimeoutMs x its test count x the attempts a
 * test may take (retries + 1) + margin. The reporter writes nothing for a test until its last attempt ends, so a test
 * that passes on its last attempt has legitimately used all of them.
 */
export function checkWatchdog({ events, now, startedAt, idleMs = DEFAULT_IDLE_MS, testTimeoutMs = DEFAULT_TEST_TIMEOUT_MS, marginMs = DEFAULT_FILE_MARGIN_MS, retries = RETRIES }) {
  const { files } = foldEvents(events);
  const inFlight = [];
  let lastHealthyFile = null;
  let lastHealthyT = -1;
  for (const [f, rec] of files) {
    if (rec.starts >= 1 && rec.ends === 0) inFlight.push({ file: f, startedAt: rec.firstT, tests: rec.collected });
    if (rec.ends >= 1 && rec.state !== 'failed' && rec.lastT >= lastHealthyT) {
      lastHealthyT = rec.lastT;
      lastHealthyFile = f;
    }
  }
  const lastEventT = events.reduce((m, e) => Math.max(m, e.t ?? 0), startedAt);
  const quiet = now - lastEventT;
  if (quiet > idleMs) {
    return { kind: 'no-event', quietMs: quiet, lastHealthyFile, inFlight: inFlight.map((x) => x.file) };
  }
  for (const f of inFlight) {
    if (f.startedAt == null) continue;
    const allowed = testTimeoutMs * (retries + 1) * Math.max(1, f.tests ?? 1) + marginMs;
    if (now - f.startedAt > allowed) {
      return { kind: 'file-overrun', file: f.file, runningMs: now - f.startedAt, allowedMs: allowed, lastHealthyFile, inFlight: inFlight.map((x) => x.file) };
    }
  }
  return null;
}

/** What to print when the runner cancels the job: everything that has failed so far. */
export function failedSoFar(events) {
  const { files, unhandled } = foldEvents(events);
  const lines = [];
  let passed = 0;
  for (const [f, rec] of files) {
    for (const t of rec.tests) {
      if (t.status === 'passed') passed += 1;
      if (t.status === 'failed') lines.push(`FAILED ${f} > ${t.name}: ${firstLine((t.errors ?? [])[(t.errors ?? []).length - 1])}`);
    }
    for (const m of rec.moduleErrors) lines.push(`FAILED ${f} (file): ${firstLine(m)}`);
    for (const m of rec.suiteErrors) lines.push(`FAILED ${f} (suite): ${firstLine(m)}`);
  }
  for (const m of unhandled) lines.push(`UNHANDLED ${firstLine(m)}`);
  const inFlight = [...files].filter(([, r]) => r.starts >= 1 && r.ends === 0).map(([f]) => f);
  return { passed, lines, inFlight };
}

/** The job summary (markdown): verdict, preflight, every retried test, failures, problems. */
export function renderSummary({ verdict, verdictLine: line, preflight, stalled, selectionNote = null }) {
  const d = verdict.detail;
  const out = [];
  out.push('## Frontend tests');
  out.push('');
  out.push('```');
  out.push(line);
  out.push('```');
  out.push('');
  if (selectionNote) {
    out.push(selectionNote);
    out.push('');
  }
  out.push('### Preflight');
  out.push('');
  for (const [k, v] of Object.entries(preflight ?? {})) out.push(`- ${k}: ${v}`);
  out.push('');
  out.push(`### Retried tests (${verdict.counts.retried})`);
  out.push('');
  if (d.retried?.length) {
    out.push('| File | Test | Attempts | Time | First error |');
    out.push('|---|---|---|---|---|');
    for (const r of d.retried) {
      const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');
      const time = r.attemptTimes?.length ? r.attemptTimes.map((x) => `attempt ${x.attempt} ${x.status} ${Math.round(x.ms)} ms`).join('; ') : 'per-attempt times not recorded';
      out.push(`| ${cell(r.file)} | ${cell(r.name)} | ${r.attempts} | ${time} | ${cell(r.firstError)} |`);
    }
  } else out.push('None.');
  out.push('');
  const problems = [];
  if (stalled) problems.push(`Stalled (${stalled.kind}). Last healthy file: ${stalled.lastHealthyFile ?? 'none'}. In flight: ${(stalled.inFlight ?? []).join(', ') || 'none'}.`);
  for (const t of (d.failedTests ?? []).slice(0, 50)) problems.push(`Failed: ${t.file} > ${t.name}: ${t.firstError}`);
  for (const e of d.loadErrors ?? []) problems.push(`Failed to load: ${e.file}: ${e.message}`);
  for (const e of d.suiteErrors ?? []) problems.push(`Suite failed: ${e.file}: ${e.message}`);
  for (const e of d.neverRan ?? []) problems.push(`Test never ran: ${e.file} > ${e.name} (${e.status})`);
  for (const e of d.unhandled ?? []) problems.push(`Unhandled error: ${e}`);
  for (const e of d.deadWorkers ?? []) problems.push(`Dead worker: ${e.file ?? ''} ${e.message}`);
  for (const e of d.hookTimeouts ?? []) problems.push(`Hook timeout (never covered by a retry): ${e.file} > ${e.name}`);
  for (const f of d.missing ?? []) problems.push(`Expected file never ran: ${f}`);
  for (const f of d.extra ?? []) problems.push(`File ran that was not expected: ${f}`);
  for (const f of d.duplicated ?? []) problems.push(`File seen twice: ${f}`);
  for (const f of d.unfinished ?? []) problems.push(`File started and never finished: ${f}`);
  for (const f of d.zeroTests ?? []) problems.push(`File has no passed test: ${f}`);
  for (const s of d.undeclaredSkips ?? []) problems.push(`Undeclared skip: ${s.file} (${s.skipped} skipped, ${s.allowed} allowed)`);
  if (d.checkError) problems.push(`The check itself failed: ${d.checkError}`);
  out.push('### Problems');
  out.push('');
  out.push(problems.length ? problems.map((p) => `- ${p}`).join('\n') : 'None.');
  out.push('');
  return out.join('\n');
}

/** The options the command accepts. Anything else is refused, never ignored into a silent full run. */
export const KNOWN_OPTIONS = ['shard', 'files-from', 'idle-ms', 'test-timeout-ms', 'file-margin-ms', 'floor', 'policy', 'config', 'events', 'summary', 'root', 'changed-from', 'base', 'budget', 'page-ceilings', 'time-list', 'brake-root'];

export const USAGE = `usage: npm run test:ci [-- options]
  --shard=N/M          run shard N of M of the full list (hosted fallback)
  --files-from=FILE    run exactly the files listed in FILE (the expected set is a parameter)
  --floor=N            override the passed-test floor of a full run
  --idle-ms=N --test-timeout-ms=N --file-margin-ms=N   watchdog windows (default 240000 / 30000 / 60000)
  --policy=FILE --config=FILE --events=FILE --summary=FILE --root=DIR
  --changed-from=FILE --base=REF   the pull request's changed files (else GITHUB_BASE_REF on a pull_request event); none = the time ceiling judges nothing
  --budget=FILE --page-ceilings=FILE --time-list=FILE   the brake's committed files (defaults beside package.json)
  --brake-root=DIR     the folder the brake scans, reads its files from and takes git history of (default: --root)`;

/** Parse argv strictly: unknown options and non-numeric numbers throw. */
export function parseOptions(argv) {
  const opts = {};
  const numeric = ['idle-ms', 'test-timeout-ms', 'file-margin-ms', 'floor'];
  for (const a of argv) {
    const m = /^--([\w-]+)=(.+)$/.exec(a);
    if (!m) throw new Error(`unknown or incomplete argument "${a}"`);
    if (!KNOWN_OPTIONS.includes(m[1])) throw new Error(`unknown option --${m[1]}`);
    if (numeric.includes(m[1]) && !/^\d+$/.test(m[2])) throw new Error(`--${m[1]} wants a whole number, got "${m[2]}"`);
    opts[m[1]] = m[2];
  }
  return opts;
}

/** The verdict for a run that has nothing to run: an empty shard slice, or an empty expected set. Null when there is something. */
export function emptySetVerdict(expected, mode) {
  if (expected.length > 0) return null;
  return {
    result: 'incomplete',
    code: EXIT_CODES.incomplete,
    reasons: [mode === 'shard' ? 'empty-slice' : 'empty-expected-set'],
    allReasons: { failed: [], incomplete: [mode === 'shard' ? 'empty-slice' : 'empty-expected-set'], overloaded: [] },
    counts: { filesExpected: 0, filesRan: 0, passed: 0, failed: 0, skipped: 0, retried: 0 },
    detail: {},
  };
}

/**
 * Source of the config handed to the test tool: the real config plus the per-attempt timing setup file.
 * A static import, so the tool's own config loader bundles the real config exactly as it would alone.
 */
export function wrapperConfigSource(baseConfigPath, setupFilePath) {
  return `import base from ${JSON.stringify(baseConfigPath)};
const resolved = typeof base === 'function' ? await base({ command: 'serve', mode: 'test' }) : base;
export default {
  ...resolved,
  test: { ...resolved.test, setupFiles: [...(resolved.test?.setupFiles ?? []), ${JSON.stringify(setupFilePath)}] },
};
`;
}
