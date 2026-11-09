#!/usr/bin/env node
/**
 * `npm run test:ci` (#3253): runs the frontend tests once and proves what ran.
 *
 * The Mac job, the hosted fallback shards, the agents' CI-mirror run and a laptop all call this.
 * It starts the test tool with our own reporter (test-ci-reporter.mjs), watches the event file for
 * progress, and prints one verdict line. All decisions are pure functions in test-ci-lib.mjs.
 *
 *   npm run test:ci                              # full run, expected set = tracked test files
 *   npm run test:ci -- --shard=2/6               # a hosted shard: its own slice of the full list
 *   npm run test:ci -- --files-from=list.txt     # run exactly the files in list.txt (seam for selection)
 *
 * Options for drills and the fixture suite: --idle-ms, --test-timeout-ms, --file-margin-ms,
 * --floor, --policy, --config, --events, --summary, --root.
 *
 * After a passed run it also applies the brake on test growth (#3254, test-brake-lib.mjs): the time ceiling
 * on the pull request's own test files (needs the changed-file list: --changed-from, --base, or GITHUB_BASE_REF
 * on a pull_request event), the per-page file-count ceiling, and, on a full run, the budget (test-budget.json).
 * Its verdict is the second line (TEST-BRAKE-VERDICT); exit code 15 when only the brake is red.
 *
 * Test selection (#3257), switched by the TEST_SELECTION variable (the repository variable FRONTEND_TEST_SELECTION in CI):
 * unset or `off` is exactly the full run above, nothing else happens; `shadow` runs the full suite and logs what the
 * selector would have run beside what failed; `on` runs the selection on a pull request into staging. Every doubt is a full run.
 *
 * Exit codes: 0 passed, 10 tests failed, 11 incomplete, 12 stalled, 13 overloaded, 14 cancelled.
 */
import { spawn, execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import os from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  BAIL_ON_PULL_REQUEST, DEFAULT_FILE_MARGIN_MS, DEFAULT_IDLE_MS, DEFAULT_TEST_TIMEOUT_MS, EXIT_CODES,
  USAGE, buildVitestArgs, checkWatchdog, emptySetVerdict, evaluateSafely, expectedFromTracked, failedSoFar, parseEvents,
  parseOptions, parseShard, renderSummary, resolveWorkers, retriedLines, shardSlice, verdictLine, wrapperConfigSource,
} from './test-ci-lib.mjs';
import { selectForRun } from './test-select-io.mjs';
import { failingFiles, normalizeMode, selectionPhrase, shadowReport } from './test-select-lib.mjs';
import { baseCopy, changedFiles, judgeGrowth, TIME_LIST_FILE } from './test-brake-io.mjs';
import {
  BRAKE_EXIT_CODE, NO_BASE_REASON, brakeLine, budgetTable, checkBudget, cpuSecondsOf, cpuWarningLine, judgeReruns, listMayOnlyShrink, renderBrakeSummary,
  slowestFiles, timeCeiling, timeCeilingSkipReason, offenderLine, pageProblemLine, slowestTable,
} from './test-brake-lib.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPORTER = join(HERE, 'test-ci-reporter.mjs');

function printVerdict(verdict, extra) {
  const line = verdictLine(verdict, extra);
  console.log(`\n${line}`);
  for (const l of retriedLines(verdict)) console.log(l); // one line per retried test: the weekly report reads them (#3258)
  return line;
}

function writeSummary(path, text) {
  if (!path) return;
  try {
    appendFileSync(path, `${text}\n`);
  } catch (err) {
    console.error(`test-ci: could not write the job summary: ${err.message}`);
  }
}

function swapInUse() {
  try {
    if (process.platform === 'darwin') {
      const out = execFileSync('sysctl', ['-n', 'vm.swapusage'], { encoding: 'utf8' });
      return /used = ([\d.]+\w)/.exec(out)?.[1] ?? out.trim();
    }
    const mem = readFileSync('/proc/meminfo', 'utf8');
    const get = (k) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(mem)?.[1] ?? 0);
    return `${Math.round((get('SwapTotal') - get('SwapFree')) / 1024)}M`;
  } catch {
    return 'unknown';
  }
}

function otherTestRuns() {
  try {
    const out = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' });
    // Only the tool's own processes (node ... vitest), not shells or the package runner wrapping them.
    return out.split('\n').filter((l) => /^\s*\d+\s+\S*node\b.*[\/.]vitest(?:\.mjs)?\s+(?:run|watch|dev|--)/.test(l) && !/test-ci\.mjs/.test(l)).length;
  } catch {
    return 'unknown';
  }
}

/** Re-run one file alone (its own tool process, one worker) and return the events of that run, or null. */
async function rerunAlone({ file, frontend, wrapper, workers, parentEventFile, n }) {
  const events = `${parentEventFile}.rerun-${n}`;
  writeFileSync(events, '');
  const args = buildVitestArgs({ reporterPath: REPORTER, shard: null, bail: 0, files: [file], config: wrapper });
  const vitestBin = join(dirname(createRequire(join(frontend, 'package.json')).resolve('vitest/package.json')), 'vitest.mjs');
  const child = spawn(process.execPath, [vitestBin, ...args], {
    cwd: frontend,
    stdio: 'ignore',
    detached: true,
    env: { ...process.env, VITEST_MAX_WORKERS: '1', TEST_CI_EVENT_FILE: events, TEST_CI_PARENT_PID: String(process.pid), TEST_CI_BRAKE_RERUN: '1' },
  });
  const limit = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } }, 600_000);
  await new Promise((res) => child.on('exit', res));
  clearTimeout(limit);
  try { process.kill(-child.pid, 'SIGKILL'); } catch { /* group already gone */ }
  const parsed = parseEvents(existsSync(events) ? readFileSync(events, 'utf8') : '');
  return parsed.badLines === 0 && parsed.events.length > 0 ? parsed.events : null;
}

/** The brake on test growth (#3254): returns { result, reasons, line, markdown }. Never throws: a failure in the check is red. */
async function applyBrake({ opts, frontend: runRoot, events, mode, verdict, workers, testStepMs, wrapper, eventFile }) {
  const env = process.env;
  // The brake judges `--brake-root` (default: the run root): its sources, its committed files and its git history.
  const frontend = resolve(opts['brake-root'] ?? runRoot);
  const reasons = [];
  // The base: the merge-base with the pull request's base branch. Pages and the test-file count are judged on this
  // change's own difference against it (Ran's R10); with no base (a shallow checkout, a shard, no remote) they are NOT JUDGED and the verdict line says so.
  const g = judgeGrowth(frontend, { base: opts.base, env, overrides: { budget: opts.budget, pageCeilings: opts['page-ceilings'], timeList: opts['time-list'] } });
  const { files, resolved, pages, fileCount, filesNow } = g;
  console.log(`test-brake: ${resolved
    ? `base: merge-base with ${resolved.ref} (${resolved.commit.slice(0, 9)})`
    : 'NO BASE RESOLVED (no origin/staging or origin/$GITHUB_BASE_REF to take a merge-base with): the page ceilings and the test-file count are NOT JUDGED'}`);
  if (pages.status === 'failed') reasons.push('page-ceiling');
  if (fileCount?.status === 'failed') reasons.push(...fileCount.problems);

  // the over-the-line list may only shrink
  const lists = listMayOnlyShrink({ current: files.listed, base: baseCopy(frontend, TIME_LIST_FILE, resolved) });
  if (lists.status === 'failed') reasons.push('over-the-line-list-grew');

  // ratchet 1: time ceiling on the files this pull request added or changed, judged on a lone re-run
  const changed = changedFiles(frontend, { changedFrom: opts['changed-from'], base: opts.base, env });
  let time = timeCeiling({ events, changed, listed: files.listed, skipReason: timeCeilingSkipReason({ event: env.GITHUB_EVENT_NAME, baseRef: env.GITHUB_BASE_REF, headRef: env.GITHUB_HEAD_REF }) });
  if (time.skipped) {
    // R17: the staging -> main promotion is not time-judged; nothing is re-run
  } else if (verdict.result !== 'passed') {
    time = { ...time, status: 'not-judged', reason: 'the run itself was red, see its verdict' };
  } else if (time.status === 'rerun-needed') {
    const rerunEvents = {};
    let n = 0;
    for (const file of time.suspects) {
      console.log(`test-brake: ${file} is over the line; re-running it alone once.`);
      rerunEvents[file] = await rerunAlone({ file, frontend: runRoot, wrapper, workers, parentEventFile: eventFile, n: n++ });
    }
    time = { ...time, final: judgeReruns({ suspects: time.suspects, rerunEvents, listed: files.listed }) };
    if (time.final.status === 'failed') reasons.push('test-time-ceiling');
  }
  if (time.status === 'not-judged') console.log(`test-brake: time ceiling not judged (${time.reason}).`);

  // ratchet 3: the budget, full run only
  const measured = { cpuSeconds: cpuSecondsOf(events), minutes: testStepMs / 60000, files: filesNow, workers: workers.workers };
  const budget = verdict.result === 'passed' || mode !== 'full'
    ? checkBudget({ budget: files.budget, measured, mode, nightly: env.TEST_CI_NIGHTLY === '1' })
    : { status: 'not-judged', reason: 'red-run', problems: [], warnings: [], notes: [] };
  const cpuWarning = budget.warnings?.length ? cpuWarningLine({ budget: files.budget, measured }) : null;
  if (budget.status === 'failed') reasons.push(...budget.problems);

  const slowest = mode === 'full' ? slowestFiles(events) : null;
  // never print a verdict that contradicts the exit: a red main run was not judged for time or budget
  const notJudged = reasons.length === 0 && verdict.result !== 'passed';
  const result = reasons.length ? 'failed' : notJudged ? 'not-judged' : 'passed';
  const notJudgedParts = [];
  if (pages.status === 'not-judged') notJudgedParts.push(`pages=not-judged (${pages.reason})`);
  if (fileCount?.status === 'not-judged') notJudgedParts.push(`files=not-judged (${NO_BASE_REASON})`);
  if (time.skipped) notJudgedParts.push(`time=not-judged (${time.reason})`);
  const line = brakeLine({ result, reasons: notJudged ? ['main-run-red'] : reasons, notJudged: notJudgedParts });
  const markdown = renderBrakeSummary({ time, lists, pages, budget, budgetFigures: mode === 'full' ? budgetTable({ budget: files.budget, measured }) : '', slowest, line, cpuWarning, fileCount });
  for (const o of time.final?.offenders ?? []) console.log(`test-brake: ${offenderLine(o)}`);
  for (const p of pages.problems) console.log(`test-brake: ${pageProblemLine(p)}`);
  for (const g of lists.grown) console.log(`test-brake: the over-the-line list grew: ${g}`);
  if (fileCount?.status === 'failed') console.log(`test-brake: ${fileCount.line}`);
  for (const n of fileCount?.notes ?? []) console.log(`test-brake: ${n}`);
  if (budget.status === 'failed') console.log(`test-brake: over budget (${budget.problems.join(', ')})\n${budgetTable({ budget: files.budget, measured })}`);
  else if (mode === 'full') console.log(`test-brake budget:\n${budgetTable({ budget: files.budget, measured })}`);
  if (cpuWarning) console.log(`test-brake: ${cpuWarning}`);
  for (const n of budget.notes) console.log(`test-brake: ${n}`);
  if (slowest) console.log(`test-brake: ${slowest.length} slowest files\n${slowestTable(slowest)}`);
  return { result, line, markdown };
}

async function main() {
  let opts;
  try {
    opts = parseOptions(process.argv.slice(2));
  } catch (err) {
    console.error(`test-ci: ${err.message}\n${USAGE}`);
    process.exit(EXIT_CODES.incomplete);
  }
  const frontend = resolve(opts.root ?? join(HERE, '..'));
  const policy = JSON.parse(readFileSync(resolve(opts.policy ?? join(HERE, 'test-ci-policy.json')), 'utf8'));
  if (opts.floor !== undefined) policy.floor = Number(opts.floor);
  // a missing or invalid floor is not defaulted: the verdict turns red with `invalid-floor`
  const summaryPath = opts.summary ?? process.env.GITHUB_STEP_SUMMARY;
  const idleMs = Number(opts['idle-ms'] ?? DEFAULT_IDLE_MS);
  const testTimeoutMs = Number(opts['test-timeout-ms'] ?? DEFAULT_TEST_TIMEOUT_MS);
  const marginMs = Number(opts['file-margin-ms'] ?? DEFAULT_FILE_MARGIN_MS);

  // --- what to run ---
  if (opts.shard && opts['files-from']) {
    console.error('test-ci: refusing --shard together with --files-from (a selection): a shard is a slice of the full list.');
    process.exit(EXIT_CODES.incomplete);
  }
  // --- test selection (#3257): with the variable unset or off this block does nothing and prints nothing ---
  let selection = null;
  if (normalizeMode(process.env.TEST_SELECTION) !== 'off' && !opts['files-from']) {
    const decision = await selectForRun({ frontend, shard: Boolean(opts.shard) });
    selection = { value: normalizeMode(process.env.TEST_SELECTION), decision };
    console.log(`test-select: ${selection.value}: ${selectionPhrase(decision)}${decision.detail ? ` (${decision.detail})` : ''}`);
  }
  let mode = 'full';
  let shard = null;
  let expected;
  let runFiles = [];
  let totalFiles = null;
  if (opts['files-from']) {
    mode = 'selected';
    expected = [...new Set(readFileSync(resolve(opts['files-from']), 'utf8').split('\n').map((l) => l.trim()).filter(Boolean))].sort();
    runFiles = expected;
  } else {
    const tracked = execFileSync('git', ['ls-files', '-z', '--', 'src'], { cwd: frontend, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
      .split('\0').filter(Boolean);
    expected = expectedFromTracked(tracked);
    totalFiles = expected.length;
    if (selection?.value === 'on' && selection.decision.mode === 'selected' && !opts.shard) {
      mode = 'selected';
      expected = selection.decision.files;
      runFiles = expected;
      policy.selectedFloor = selection.decision.alwaysRun;
    }
    if (opts.shard) {
      try {
        shard = parseShard(opts.shard);
      } catch (err) {
        console.error(`test-ci: ${err.message}\n${USAGE}`);
        process.exit(EXIT_CODES.incomplete);
      }
      mode = 'shard';
      expected = shardSlice(expected, shard.index, shard.count);
    }
  }
  const selectionTag = !selection ? null : selection.value === 'shadow' ? 'shadow' : selection.decision.reason;
  const verdictExtra = { mode, shard, selected: mode === 'selected' ? { n: expected.length, of: totalFiles ?? expected.length } : null, selection: selectionTag };
  const selectionNote = !selection ? null
    : selection.value === 'shadow' ? `Selection (shadow): this run ran every test file. The selector would have run: ${selectionPhrase(selection.decision)}.`
      : mode === 'selected' ? `Selection (on): ${selectionPhrase(selection.decision)}. What a green selected run proves is in docs/ci.md.`
        : `Selection (on): full run, reason=${selection.decision.reason}.`;

  const empty = emptySetVerdict(expected, mode);
  if (empty) {
    const line = printVerdict(empty, verdictExtra);
    writeSummary(summaryPath, renderSummary({ verdict: empty, verdictLine: line, preflight: {}, selectionNote }));
    process.exit(empty.code);
  }

  // --- preflight ---
  let workers;
  try {
    workers = resolveWorkers(process.env);
  } catch (err) {
    console.error(`test-ci: ${err.message}`);
    process.exit(EXIT_CODES.incomplete);
  }
  const preflight = {
    workers: `${workers.workers} (${workers.why})`,
    'load (1 min)': os.loadavg()[0].toFixed(2),
    'swap in use': swapInUse(),
    'other test runs seen': otherTestRuns(),
    files: `${expected.length}${mode === 'shard' ? ` (shard ${shard.index}/${shard.count})` : ''}`,
  };
  console.log('test-ci preflight');
  for (const [k, v] of Object.entries(preflight)) console.log(`  ${k}: ${v}`);

  // --- run ---
  const eventFile = resolve(opts.events ?? join(mkdtempSync(join(os.tmpdir(), 'test-ci-')), 'events.jsonl'));
  mkdirSync(dirname(eventFile), { recursive: true });
  writeFileSync(eventFile, '');
  const bail = process.env.GITHUB_EVENT_NAME === 'pull_request' ? BAIL_ON_PULL_REQUEST : 0;
  // The real config plus the per-attempt timing setup file; written beside the node_modules cache, not in the repo's tracked files.
  const configDir = join(frontend, 'node_modules', '.cache', 'test-ci');
  mkdirSync(configDir, { recursive: true });
  const wrapper = join(configDir, `config-${process.pid}.mjs`);
  writeFileSync(wrapper, wrapperConfigSource(resolve(opts.config ?? join(frontend, 'vitest.config.ts')), join(HERE, 'test-ci-attempts-setup.mjs')));
  const args = buildVitestArgs({ reporterPath: REPORTER, shard, bail, files: runFiles, config: wrapper });
  const vitestBin = join(dirname(createRequire(join(frontend, 'package.json')).resolve('vitest/package.json')), 'vitest.mjs');
  const startedAt = Date.now();
  const child = spawn(process.execPath, [vitestBin, ...args], {
    cwd: frontend,
    stdio: 'inherit',
    detached: true, // its own process group, so the watchdog can kill the workers too
    env: { ...process.env, VITEST_MAX_WORKERS: String(workers.workers), TEST_CI_EVENT_FILE: eventFile, TEST_CI_PARENT_PID: String(process.pid) },
  });
  console.log(`test-ci: test tool pid ${child.pid}`);

  let exitCode = null;
  let stalled = null;
  let cancelled = false;
  const exited = new Promise((res) => child.on('exit', (code, signal) => { exitCode = code ?? (signal ? 128 : 1); res(); }));
  const killGroup = () => {
    for (const sig of ['SIGTERM', 'SIGKILL']) {
      try { process.kill(-child.pid, sig); } catch { /* already gone */ }
    }
  };
  const readEvents = () => parseEvents(existsSync(eventFile) ? readFileSync(eventFile, 'utf8') : '');

  const timer = setInterval(() => {
    if (stalled || exitCode !== null) return;
    try {
      const s = checkWatchdog({ events: readEvents().events, now: Date.now(), startedAt, idleMs, testTimeoutMs, marginMs });
      if (s) {
        stalled = s;
        console.error(`\ntest-ci: STALLED (${s.kind}). Last healthy file: ${s.lastHealthyFile ?? 'none'}. Files in flight: ${s.inFlight.join(', ') || 'none'}. Killing the test tool's process group.`);
        killGroup();
      }
    } catch (err) {
      console.error(`test-ci: watchdog error: ${err.message}`);
    }
  }, Math.min(1000, Math.max(100, Math.floor(idleMs / 4))));

  for (const sig of ['SIGTERM', 'SIGINT']) {
    process.on(sig, () => {
      if (cancelled) return;
      cancelled = true;
      const fs = failedSoFar(readEvents().events);
      console.error(`\ntest-ci: ${sig} received. Failed so far (${fs.lines.length}; ${fs.passed} passed; ${fs.inFlight.length} files in flight):`);
      for (const l of fs.lines) console.error(`  ${l}`);
      killGroup();
    });
  }

  await exited;
  // the test step ends here: the lone re-runs of the brake that follow are not part of the budget's minutes
  const testStepMs = Date.now() - startedAt;
  clearInterval(timer);
  // The group may hold stragglers after the leader exits.
  if (stalled || cancelled) killGroup();

  // --- verdict ---
  const { events, badLines } = readEvents();
  const verdict = evaluateSafely({ events, expected, toolExitCode: exitCode, args, policy, mode, badLines, stalled, cancelled });
  const line = printVerdict(verdict, verdictExtra);
  console.log(`test-ci: events at ${eventFile}`);
  writeSummary(summaryPath, renderSummary({ verdict, verdictLine: line, preflight, stalled, selectionNote }));

  // --- shadow mode (#3257): the would-be selection beside what failed. It can never change the exit code. ---
  if (selection?.value === 'shadow') {
    try {
      const report = shadowReport({ decision: selection.decision, failing: failingFiles(verdict.detail) });
      console.log(report.line);
      for (const m of report.misses) console.log(`TEST-SELECT-SHADOW-MISS ${m}`);
      writeSummary(summaryPath, `### Selection (shadow)\n\n\`${report.line}\`\n\n${report.misses.length ? `Failing files outside the would-be selection:\n${report.misses.map((m) => `- ${m}`).join('\n')}` : 'No failing file outside the would-be selection.'}\n`);
    } catch (err) {
      console.error(`test-select: the shadow report failed (ignored, it never changes the result): ${err.message}`);
    }
  }

  // --- the brake on test growth (#3254): never skipped silently, and a failure inside it is red ---
  let exit = verdict.code;
  if (!stalled && !cancelled) {
    try {
      const brake = await applyBrake({ opts, frontend, events, mode, verdict, workers, testStepMs, wrapper, eventFile });
      console.log(`\n${brake.line}`);
      writeSummary(summaryPath, brake.markdown);
      if (brake.result !== 'passed' && exit === 0) exit = BRAKE_EXIT_CODE;
    } catch (err) {
      console.log(`\nTEST-BRAKE-VERDICT result=failed code=${BRAKE_EXIT_CODE} reasons=brake-exception`);
      console.error(`test-brake: the check itself failed: ${err.stack ?? err}`);
      if (exit === 0) exit = BRAKE_EXIT_CODE;
    }
  }
  try { rmSync(wrapper, { force: true }); } catch { /* best effort */ }
  process.exit(exit);
}

main().catch((err) => {
  console.error(`test-ci: internal error: ${err.stack ?? err}`);
  console.log('\nTEST-CI-VERDICT result=incomplete code=11 reasons=check-exception');
  process.exit(EXIT_CODES.incomplete);
});
