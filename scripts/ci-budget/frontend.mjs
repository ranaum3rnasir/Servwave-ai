// The Frontend check's part of the weekly CI report (#3258). PURE: run records and log lines in, a report section (text) and a list of
// ticket actions out. Nothing here reads GitHub or writes a ticket; scripts/ci-budget/run.mjs does that around it.
//
// Where the data comes from, and what is NOT available:
//   - durations and queue time: the Frontend job's own timestamps (same as the Database section).
//   - selection mode and reason: the job log's `TEST-CI-VERDICT` line (its `selection=` word) and, in shadow, the
//     `TEST-SELECT-SHADOW` line. With the selection variable off the verdict line has no `selection=` at all: that is "off".
//   - the share of full runs (#3404): the same two lines, for `pull_request` executions only, this week and the week before. Whether a
//     pull request went into staging is read from the reason code (a promotion into main prints `promotion-into-main`).
//   - retried tests: one `TEST-CI-RETRIED` line per retried test, printed by the command since #3258. Runs older than that logged only
//     the COUNT (`retried=N` on the verdict line), never the names (the names live in the job summary, which GitHub's API does not
//     return). Such runs are counted and named in the report as "names not logged"; no name is ever guessed.
//   - the 20 slowest files and the budget figures: the `test-brake:` tables a FULL run prints in its log.
import { createHash } from 'node:crypto';
import { measureWeeks, trend, formatDuration, codeSpan, hasTrailingMarker } from './lib.mjs';

export const FRONTEND_JOB_NAME = 'Frontend (lint + type-check + tests + build)';

/** Error-type fallbacks above this share of a week's runs (strictly above) open or update one ticket. */
export const FALLBACK_THRESHOLD = 0.05;
/** A test retried in at least this many different runs in the week gets a ticket. */
export const RETRY_RUNS_THRESHOLD = 2;

/**
 * The reason codes `frontend/scripts/test-select-lib.mjs` prints when the selector itself broke, as opposed to a deliberate full run
 * (a lockfile change, a promotion, ...): it threw (`selector-threw`), hung (`selector-timeout`), or could not classify the change
 * (`unclassified-path`, `no-changed-list`, `selector-bad-output`, and the checks that its own lists disagree with the tracked files:
 * `listed-not-tracked`, `changed-not-tracked`, `case-mismatch`, `empty-always-run`, `empty-outside-readers`). A test pins that each one is a real code.
 */
export const ERROR_FALLBACK_REASONS = [
  'selector-threw',
  'selector-timeout',
  'unclassified-path',
  'no-changed-list',
  'selector-bad-output',
  'listed-not-tracked',
  'changed-not-tracked',
  'case-mismatch',
  'empty-always-run',
  'empty-outside-readers',
];

/**
 * Deliberate full runs above this share of a week's pull request runs into staging (strictly above) open or update one ticket (#3404).
 * A selector that quietly stops selecting looks green forever: every run passes, only slower. The replay of 60 pull requests with the
 * phase 1 rules of #3400 gives 27%, so 35% leaves room for a week with more workflow or lockfile changes than usual.
 */
export const FULL_RUN_THRESHOLD = 0.35;

/**
 * Reason codes of runs that are not a pull request into staging the selector judges: they are always full, by design, so they are not
 * counted in the share (a promotion into main, a pull request into another branch, a push, the nightly run, a manual run, a hosted shard).
 */
export const NOT_COUNTED_REASONS = ['promotion-into-main', 'base-not-staging', 'not-pull-request', 'nightly', 'manual', 'hosted-shard'];

/** At most this many reason rows are printed in the share table and in its ticket; a log could hold any number of made-up reasons. */
const FULL_RUN_REASON_ROWS = 15;

/** At most this many flaky-test tickets are opened or commented in one run; the rest are counted in the section (the most-retried come first). */
export const MAX_RETRIED_TICKETS = 5;
/** The slowest-retried table in the section lists at most this many tests. */
const RETRIED_ROWS_SHOWN = 20;

/**
 * Whose log lines may become ticket text. A pull request's Frontend job runs the pull request's own code, merged or not, so its log is
 * not trusted: only pushes to `staging` or `main` count (reviewed code). The nightly full run (a separate list, see tallyWeek) counts too.
 */
export const TRUSTED_PUSH_BRANCHES = ['staging', 'main'];
export const isTrustedRun = (r) => r.event === 'push' && TRUSTED_PUSH_BRANCHES.includes(r.headBranch);

/** A word the selector or the command prints stays plain when it holds only letters, digits and `_ . : = -`; anything else (log text) is code-spanned. */
const logWord = (t) => (/^[A-Za-z0-9 _.:=-]*$/.test(String(t)) ? String(t) : codeSpan(t, { table: true }));

export const TICKET_LABELS_FALLBACK = ['priority:medium', 'module:general', 'ci-budget'];
export const TICKET_LABELS_RETRIED = ['priority:low', 'module:general', 'ci-budget'];

/** Hidden markers: how the one open ticket per cause is found again. Distinct from the Database ticket's marker. */
export const FALLBACK_MARKER = '<!-- ci-weekly-frontend:error-fallbacks -->';
export const FULL_RUN_MARKER = '<!-- ci-weekly-frontend:full-run-share -->';
export const retriedKey = (file, test) => createHash('sha1').update(`${file}\n${test}`).digest('hex').slice(0, 12);
export const retriedMarker = (file, test) => `<!-- ci-weekly-frontend:retried:${retriedKey(file, test)} -->`;

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const pct = (part, whole) => `${(Math.round((part / whole) * 1000) / 10).toString()}%`;

// ---- reading the log ---------------------------------------------------------------------------------------------------------

const ANSI = /\x1b\[[0-9;]*m/g; // eslint-disable-line no-control-regex
/** A log line without its timestamp and colour codes. */
export const cleanLine = (l) => l.replace(/\r$/, '').replace(ANSI, '').replace(/^\S+Z /, '');

const KEEP = /^(TEST-CI-VERDICT |TEST-CI-RETRIED |TEST-SELECT-SHADOW |test-select: )/;
/** The lines of a job log this report reads (verdict, shadow, retried, selector), so a log can be dropped as soon as it is read. */
export const relevantLines = (log) => log.split('\n').map(cleanLine).filter((l) => KEEP.test(l));

const kv = (line) => Object.fromEntries(line.split(' ').slice(1).filter((t) => t.includes('=')).map((t) => [t.slice(0, t.indexOf('=')), t.slice(t.indexOf('=') + 1)]));

/** What one execution's lines say. `verdict` is null when the command never printed one (cancelled early, hosted shards, ...). */
export function parseRunLines(lines) {
  const ofKind = (prefix) => lines.filter((l) => l.startsWith(prefix));
  const v = ofKind('TEST-CI-VERDICT ').at(-1);
  const s = ofKind('TEST-SELECT-SHADOW ').filter((l) => !l.startsWith('TEST-SELECT-SHADOW-MISS')).at(-1);
  const verdict = v ? kv(v) : null;
  const shadow = s ? kv(s) : null;
  const retried = ofKind('TEST-CI-RETRIED ').flatMap((l) => {
    const m = /^TEST-CI-RETRIED attempts=(\d+) file=(\S+) test=(.*)$/.exec(l);
    return m ? [{ file: m[2], test: m[3] }] : [];
  });
  return { verdict, shadow, retried };
}

/** How the selection treated one run: { selection: off|shadow|on|shard|none, ran, reason, would }. */
export function classify(parsed) {
  const { verdict, shadow } = parsed;
  if (!verdict) return { selection: 'none', ran: '-', reason: 'no verdict line', would: '-' };
  const mode = verdict.mode ?? 'full';
  if (mode.startsWith('shard-')) return { selection: 'shard', ran: 'shard', reason: 'hosted shard', would: '-' };
  const ran = mode.startsWith('selected-') ? 'selected' : 'full';
  if (verdict.selection === undefined) return { selection: 'off', ran, reason: 'selection off', would: '-' };
  if (verdict.selection === 'shadow') {
    const would = shadow?.would === undefined ? 'unknown' : shadow.would.startsWith('selected-') ? 'selected' : shadow.would;
    return { selection: 'shadow', ran, reason: shadow?.reason ?? 'unknown (no shadow line)', would };
  }
  return { selection: 'on', ran, reason: verdict.selection, would: '-' };
}

const isErrorFallback = (c) => (c.selection === 'shadow' || c.selection === 'on') && ERROR_FALLBACK_REASONS.includes(c.reason);

// ---- tables printed by a full run --------------------------------------------------------------------------------------------

const cells = (line) => line.split('|').slice(1, -1).map((c) => c.trim());
const tableAfter = (lines, header) => {
  const at = lines.findIndex((l) => l.trim() === header);
  if (at < 0) return null;
  const rows = [];
  for (let i = at + 2; i < lines.length && lines[i].startsWith('|'); i += 1) rows.push(cells(lines[i]));
  return rows;
};

/** The slowest files of a full run: [{ rank, file, seconds, tests }] (as many as the run printed), or null when it printed none. */
export function slowestFilesFromLines(lines) {
  const rows = tableAfter(lines, '| # | File | Seconds | Tests |');
  if (!rows?.length) return null;
  return rows.map(([rank, file, seconds, tests]) => ({ rank: Number(rank), file, seconds: Number(seconds), tests: Number(tests) }));
}

/** The measured figures of a full run: { cpuSeconds, minutes, workers, files } (any may be null), or null when the run printed no budget table. */
export function measuredFromLines(lines) {
  const rows = tableAfter(lines, '| Figure | Measured | Budget |');
  if (!rows?.length) return null;
  const out = { cpuSeconds: null, minutes: null, workers: null, files: null };
  for (const [name, measured] of rows) {
    const n = Number(measured);
    if (name.startsWith('CPU-seconds') && Number.isFinite(n)) out.cpuSeconds = n;
    else if (name.startsWith('Minutes of test step') && Number.isFinite(n)) {
      out.minutes = n;
      out.workers = Number(/\((\d+) workers\)/.exec(name)?.[1]) || null;
    } else if (name.startsWith('Test files') && Number.isFinite(n)) out.files = n;
  }
  return out;
}

/** The measured figures against the budget file's: one row per figure with its verdict. Minutes are comparable only at the budget's worker count. */
export function budgetRows(measured, budget) {
  const status = (value, limit) => (value === null || limit === undefined ? 'not measured' : value > limit ? 'OVER' : 'within');
  const sameWorkers = measured.workers !== null && measured.workers === budget.workers;
  return [
    { figure: 'CPU-seconds', measured: measured.cpuSeconds, budget: budget.maxCpuSeconds, status: status(measured.cpuSeconds, budget.maxCpuSeconds) },
    {
      figure: `Minutes of test step (budget is at ${budget.workers} workers)`,
      measured: measured.minutes,
      budget: budget.maxMinutes,
      status: measured.minutes === null ? 'not measured' : sameWorkers ? status(measured.minutes, budget.maxMinutes) : `not comparable (run at ${measured.workers ?? '?'} workers)`,
    },
    { figure: 'Test files', measured: measured.files, budget: budget.maxTestFiles, status: status(measured.files, budget.maxTestFiles) },
  ];
}

// ---- the week ----------------------------------------------------------------------------------------------------------------

const DAY_MS = 86_400_000;
const inWeek = (r, end) => Boolean(r.completedAt) && Date.parse(r.completedAt) > end - 7 * DAY_MS && Date.parse(r.completedAt) <= end;

function addRetried(retried, names, runId) {
  for (const t of names) {
    const k = `${t.file}\u0000${t.test}`;
    const e = retried.get(k) ?? { file: t.file, test: t.test, runIds: new Set() };
    e.runIds.add(runId);
    retried.set(k, e);
  }
}

/**
 * Everything the report says, from the week's executions of the Frontend job.
 * `runs`: [{ runId, runAttempt, conclusion, labels, runnerGroup, createdAt, startedAt, completedAt, lines }], `lines` being the
 * relevant log lines (or null when the log could not be read).
 */
export function tallyWeek(runs, now, nightlyRuns = []) {
  const end = Date.parse(now);
  const week = runs.filter((r) => r.startedAt && inWeek(r, end));
  const counted = [];
  let logsMissing = 0;
  for (const r of week) {
    if (!Array.isArray(r.lines)) { logsMissing += 1; continue; }
    counted.push({ run: r, parsed: parseRunLines(r.lines) });
  }
  const withVerdict = counted.filter((c) => c.parsed.verdict);
  const noVerdict = counted.length - withVerdict.length;

  const groups = new Map();
  const errorByReason = new Map();
  const errorRunIds = [];
  for (const c of withVerdict) {
    const k = classify(c.parsed);
    const key = [k.selection, k.ran, k.reason, k.would].join('\u0000');
    groups.set(key, { ...k, runs: (groups.get(key)?.runs ?? 0) + 1 });
    if (isErrorFallback(k)) {
      errorByReason.set(k.reason, (errorByReason.get(k.reason) ?? 0) + 1);
      errorRunIds.push(c.run.runId);
    }
  }
  const modeRows = [...groups.values()].sort((a, b) => b.runs - a.runs || (a.reason < b.reason ? -1 : 1));
  const errorFallbacks = errorRunIds.length;

  // retried: distinct workflow runs per test (two attempts of one run are one run)
  const retried = new Map();
  let retriedUnnamed = 0;
  for (const c of withVerdict) {
    const names = c.parsed.retried;
    if (names.length === 0 && Number(c.parsed.verdict.retried) > 0) retriedUnnamed += 1;
    if (isTrustedRun(c.run)) addRetried(retried, names, c.run.runId);
  }
  for (const n of nightlyRuns.filter((x) => x.completedAt && inWeek(x, end) && Array.isArray(x.lines))) addRetried(retried, parseRunLines(n.lines).retried, n.runId);
  const retriedTests = [...retried.values()]
    .map((e) => ({ file: e.file, test: e.test, runs: e.runIds.size, runIds: [...e.runIds].sort((a, b) => a - b) }))
    .sort((a, b) => b.runs - a.runs || (`${a.file} ${a.test}` < `${b.file} ${b.test}` ? -1 : 1));

  return { executions: week.length, logsMissing, noVerdict, runsWithVerdict: withVerdict.length, modeRows, errorFallbacks, errorByReason, errorRunIds, retriedTests, retriedUnnamed };
}

// ---- the share of full runs (#3404) ------------------------------------------------------------------------------------------

/**
 * What the selector decided, or in shadow would have decided, for one execution: `{ decided: 'full' | 'selected', reason, source }`,
 * or `{ skipped: why }` when the execution is not a pull request into staging with a decision to count.
 */
export function decisionOf(run, parsed) {
  if (run.event !== 'pull_request') return { skipped: 'not-a-pull-request' };
  const k = classify(parsed);
  if (k.selection === 'none' || k.selection === 'shard') return { skipped: 'no-decision' };
  if (k.selection === 'off') return { skipped: 'selection-off' };
  if (NOT_COUNTED_REASONS.includes(k.reason)) return { skipped: 'always-full' };
  const decided = k.selection === 'shadow' ? k.would : k.ran;
  if (decided !== 'full' && decided !== 'selected') return { skipped: 'no-decision' };
  return { decided, reason: k.reason, source: k.selection };
}

/**
 * The share of full runs among the pull request runs into staging that finished in the 7 days up to `end`. Pure.
 * `deliberate` are the full runs that are not error-type fallbacks (those have a line and a ticket of their own).
 */
export function fullRunShare(runs, end) {
  const out = { runs: 0, full: 0, selected: 0, deliberate: 0, shadow: 0, on: 0, selectionOff: 0, byReason: new Map() };
  for (const r of runs) {
    if (!r.startedAt || !inWeek(r, end) || !Array.isArray(r.lines)) continue;
    const parsed = parseRunLines(r.lines);
    if (!parsed.verdict) continue;
    const d = decisionOf(r, parsed);
    if (d.skipped) { if (d.skipped === 'selection-off') out.selectionOff += 1; continue; }
    out.runs += 1;
    out[d.source] += 1;
    if (d.decided === 'selected') { out.selected += 1; continue; }
    out.full += 1;
    if (!ERROR_FALLBACK_REASONS.includes(d.reason)) out.deliberate += 1;
    out.byReason.set(d.reason, (out.byReason.get(d.reason) ?? 0) + 1);
  }
  return out;
}

/** Whether a week's deliberate full runs are over the line (strictly above it; a week with no counted run is never over). */
export const fullRunsOverLine = (share) => share.runs > 0 && share.deliberate / share.runs > FULL_RUN_THRESHOLD;

/** The reason rows of the share table: this week's count beside the previous week's, the most frequent first, capped. */
function fullRunReasonRows(current, previous) {
  const reasons = [...new Set([...current.byReason.keys(), ...previous.byReason.keys()])]
    .map((reason) => ({ reason, now: current.byReason.get(reason) ?? 0, before: previous.byReason.get(reason) ?? 0 }))
    .sort((a, b) => b.now - a.now || b.before - a.before || (a.reason < b.reason ? -1 : 1));
  const shown = reasons.slice(0, FULL_RUN_REASON_ROWS).map((r) => `| ${logWord(r.reason)}${ERROR_FALLBACK_REASONS.includes(r.reason) ? ' (error-type)' : ''} | ${r.now} | ${r.before} |`);
  return { shown, more: Math.max(0, reasons.length - FULL_RUN_REASON_ROWS) };
}

/** "12 of 40 (30%)", or "none counted" for a week with no pull request run into staging that printed a decision. */
const shareText = (part, whole) => (whole === 0 ? 'none counted' : `${part} of ${whole} (${pct(part, whole)})`);

// ---- tickets: exactly one open ticket per cause ----------------------------------------------------------------------------------

/**
 * One cause -> one action. The open ticket for a cause is found by its hidden marker (a pull request never matches); with none the
 * action is to open one, otherwise to comment on it. With two marked tickets open the oldest gets the comment and the body names the
 * other. The cause key is unique within the list, so a run can never open two tickets for one cause.
 */
export function actionFor(cause, openTickets) {
  const marked = openTickets.filter((t) => !t.pull_request && hasTrailingMarker(t.body, cause.marker)).sort((a, b) => a.number - b.number);
  const body = `${cause.body}\n${cause.marker}\n`;
  if (marked.length === 0) return { kind: 'open', cause: cause.key, title: cause.title, labels: cause.labels, body };
  const others = marked.slice(1).map((t) => `#${t.number}`);
  return { kind: 'comment', cause: cause.key, number: marked[0].number, body: others.length ? `${body}\nAlso open with the same marker: ${others.join(', ')}.\n` : body };
}

function causesOf(tally, now, share) {
  const causes = [];
  if (share && fullRunsOverLine(share.current)) {
    const { current, previous } = share;
    const rows = fullRunReasonRows(current, previous);
    causes.push({
      key: 'full-run-share',
      marker: FULL_RUN_MARKER,
      title: `CI: more than ${FULL_RUN_THRESHOLD * 100}% of this week's pull request runs were full Frontend runs`,
      labels: TICKET_LABELS_FALLBACK,
      body: [
        `## Share of full Frontend runs (week to ${now.slice(0, 10)})`,
        '',
        `**${shareText(current.deliberate, current.runs)}** of the pull request runs into staging ${current.shadow > 0 && current.on === 0 ? 'would have been' : 'were'} deliberate full runs. The line is ${FULL_RUN_THRESHOLD * 100}%. Previous week: ${shareText(previous.deliberate, previous.runs)}.`,
        '',
        '| Reason for the full run | This week | Previous week |',
        '|---|---|---|',
        ...rows.shown,
        ...(rows.more ? ['', `and ${rows.more} more reasons not listed.`] : []),
        '',
        'A full run is right for a lockfile, a CI workflow or a selector change. A share this high usually means one rule fires on changes that cannot affect the frontend tests, as the file-count rule did before #3401. Look at the top reason first: read the pull requests that hit it, and narrow the rule if their changes could not reach a test (docs/ci.md, "Selected runs"). Raising the line is not a remedy.',
      ].join('\n'),
    });
  }
  if (tally.runsWithVerdict > 0 && tally.errorFallbacks / tally.runsWithVerdict > FALLBACK_THRESHOLD) {
    const reasons = [...tally.errorByReason].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1));
    causes.push({
      key: 'error-fallbacks',
      marker: FALLBACK_MARKER,
      title: 'CI: test selection fell back on an error in more than 5% of this week\'s runs',
      labels: TICKET_LABELS_FALLBACK,
      body: [
        `## Test selection error fallbacks (week to ${now.slice(0, 10)})`,
        '',
        `**${plural(tally.errorFallbacks, 'run')} of ${tally.runsWithVerdict} (${pct(tally.errorFallbacks, tally.runsWithVerdict)})** ran everything because the selector itself failed (it threw, hung or could not classify the change). The line is 5%.`,
        '',
        '| Reason | Runs |',
        '|---|---|',
        ...reasons.map(([r, n]) => `| ${r} | ${n} |`),
        '',
        `Workflow runs: ${tally.errorRunIds.slice(0, 20).join(', ')}${tally.errorRunIds.length > 20 ? ', ...' : ''}.`,
        '',
        'The reason codes are explained in docs/ci.md, "Selected runs". The remedy is to fix the selector or its lists, never to switch selection off to silence this.',
      ].join('\n'),
    });
  }
  for (const t of tally.retriedTests.filter((x) => x.runs >= RETRY_RUNS_THRESHOLD).slice(0, MAX_RETRIED_TICKETS)) {
    causes.push({
      key: `retried:${retriedKey(t.file, t.test)}`,
      marker: retriedMarker(t.file, t.test),
      title: `Flaky test: ${codeSpan(`${t.file} > ${t.test}`, { max: 180 })}`,
      labels: TICKET_LABELS_RETRIED,
      body: [
        `## Test retried in ${plural(t.runs, 'run')} this week (week to ${now.slice(0, 10)})`,
        '',
        `- File: ${codeSpan(t.file)}`,
        `- Test: ${codeSpan(t.test)}`,
        `- Workflow runs: ${t.runIds.join(', ')}`,
        '',
        'A retry hides a failure that happened once. Two runs in a week is a flake that is growing: fix the test (a real wait on the condition, not a longer timeout). Close this ticket when it has not been retried for a week.',
      ].join('\n'),
    });
  }
  return causes;
}

// ---- the section ---------------------------------------------------------------------------------------------------------------

const num = (n) => (n === null || n === undefined ? 'not measured' : String(n));

/**
 * The Frontend check's part of the weekly report and the ticket actions it calls for.
 * `nightly`: { kind: 'nightly' | 'pull-request', source, lines } for the newest full run that can be read, or { unavailable: reason }.
 * `nightlyRuns`: [{ runId, completedAt, lines }] of the scheduled nightly runs (their retried tests count; see isTrustedRun for pull request runs).
 * `budget`: the parsed frontend/test-budget.json. `openTickets`: the open issues labelled ci-budget (REST shape).
 */
export function frontendReport({ now, runs, nightly, budget, openTickets = [], nightlyRuns = [] }) {
  const tally = tallyWeek(runs, now, nightlyRuns);
  const weeks = measureWeeks(runs, now);
  const out = [];

  // 1. selection mode and reason
  out.push('#### Runs by selection mode and reason (last 7 days)', '');
  if (tally.executions === 0) out.push('No Frontend check finished in the last 7 days, so there is nothing to tally.', '');
  else {
    out.push(`${plural(tally.executions, 'execution')} of the Frontend check finished (every attempt counts). ${plural(tally.runsWithVerdict, 'execution')} printed a verdict and are tallied below.`);
    if (tally.noVerdict) out.push(`Not tallied: ${tally.noVerdict} with no verdict line (the run predates the one test command, was cancelled before the tests, or skipped them).`);
    if (tally.logsMissing) out.push(`Not tallied: ${tally.logsMissing} whose log could not be read.`);
    out.push('');
    if (tally.runsWithVerdict > 0) {
      out.push('| Selection | Ran | Reason | Would have run (shadow) | Runs |', '|---|---|---|---|---|', ...tally.modeRows.map((r) => `| ${r.selection} | ${r.ran} | ${logWord(r.reason)} | ${logWord(r.would)} | ${r.runs} |`), '');
      const off = tally.modeRows.filter((r) => r.selection === 'off').reduce((n, r) => n + r.runs, 0);
      if (off === tally.runsWithVerdict) out.push('Test selection is off: every run was full.', '');
      out.push(
        `Error-type fallbacks (the selector threw, hung or could not classify): **${tally.errorFallbacks} of ${tally.runsWithVerdict} (${pct(tally.errorFallbacks, tally.runsWithVerdict)})**. Line: ${FALLBACK_THRESHOLD * 100}%, ${tally.errorFallbacks / tally.runsWithVerdict > FALLBACK_THRESHOLD ? '**over it**' : 'within it'}.`,
        '',
      );
    }
  }

  // 1b. the share of full runs among pull request runs into staging (#3404)
  const end = Date.parse(now);
  const share = { current: fullRunShare(runs, end), previous: fullRunShare(runs, end - 7 * DAY_MS) };
  out.push('#### Share of full runs on pull requests into staging (last 7 days beside the 7 before)', '');
  if (share.current.runs === 0 && share.previous.runs === 0) {
    out.push(share.current.selectionOff + share.previous.selectionOff > 0
      ? 'Test selection is off, so no run printed a decision to count: every run was full.'
      : 'No pull request run into staging printed a selection decision in the last 14 days.', '');
  } else {
    const { current, previous } = share;
    const shadowOnly = current.shadow + previous.shadow > 0 && current.on + previous.on === 0;
    if (current.shadow + previous.shadow > 0) {
      out.push(shadowOnly
        ? 'Selection is in shadow mode: every run ran every test. The figures below are what the selector would have done.'
        : `Some runs were in shadow mode (${current.shadow} this week, ${previous.shadow} the week before): for those the figures are what the selector would have done.`, '');
    }
    const rows = fullRunReasonRows(current, previous);
    out.push(
      '| | This week | Previous week |', '|---|---|---|',
      `| Pull request runs into staging | ${current.runs} | ${previous.runs} |`,
      `| Full runs | ${shareText(current.full, current.runs)} | ${shareText(previous.full, previous.runs)} |`,
      `| Selected runs | ${current.selected} | ${previous.selected} |`,
      '',
    );
    if (rows.shown.length) {
      out.push('| Reason for the full run | This week | Previous week |', '|---|---|---|', ...rows.shown, '');
      if (rows.more) out.push(`and ${rows.more} more reasons not listed.`, '');
    }
    out.push(
      `Deliberate full runs (full runs that are not error-type fallbacks): **${shareText(current.deliberate, current.runs)}**. Line: ${FULL_RUN_THRESHOLD * 100}%, ${fullRunsOverLine(current) ? 'over' : 'not over'}.`,
      'Not counted, because they are always full: promotion pull requests into main, pushes, the nightly run, manual runs and hosted shards.',
      '',
    );
  }

  // 2. retried tests
  out.push('#### Tests retried in two or more runs this week', '');
  const flaky = tally.retriedTests.filter((t) => t.runs >= RETRY_RUNS_THRESHOLD);
  if (flaky.length) {
    out.push('| File | Test | Runs |', '|---|---|---|', ...flaky.slice(0, RETRIED_ROWS_SHOWN).map((t) => `| ${codeSpan(t.file, { table: true })} | ${codeSpan(t.test, { table: true })} | ${t.runs} |`), '');
    if (flaky.length > RETRIED_ROWS_SHOWN) out.push(`and ${flaky.length - RETRIED_ROWS_SHOWN} more not listed.`, '');
    if (flaky.length > MAX_RETRIED_TICKETS) {
      out.push(`${plural(flaky.length - MAX_RETRIED_TICKETS, 'more test')} ${flaky.length - MAX_RETRIED_TICKETS === 1 ? 'is' : 'are'} over the line and got no ticket this run (at most ${MAX_RETRIED_TICKETS} tickets per run, the most-retried first).`, '');
    }
  } else out.push('None.', '');
  if (tally.retriedUnnamed) {
    out.push(`${plural(tally.retriedUnnamed, 'execution')} retried tests whose names were not logged (runs from before the command printed a \`TEST-CI-RETRIED\` line per test); they cannot be counted by test.`, '');
  }

  // 3. the 20 slowest files and the budget, from the latest full run
  out.push('#### Slowest test files and the budget (latest full run)', '');
  if (!nightly || nightly.unavailable) out.push(`Not available: ${nightly?.unavailable ?? 'no full run was read'}.`, '');
  else {
    const slowest = slowestFilesFromLines(nightly.lines);
    const measured = measuredFromLines(nightly.lines);
    out.push(`Source: ${nightly.kind === 'nightly' ? 'the latest nightly full run' : 'the newest full pull request run (no nightly full run has been read yet)'}, ${nightly.source}.`, '');
    if (measured) {
      out.push('| Figure | Measured | Budget | |', '|---|---|---|---|', ...budgetRows(measured, budget).map((r) => `| ${r.figure} | ${num(r.measured)} | ${num(r.budget)} | ${r.status} |`), '');
    } else out.push('That run printed no budget table, so the budget figures are not available.', '');
    if (slowest) out.push('| # | File | Seconds | Tests |', '|---|---|---|---|', ...slowest.slice(0, 20).map((f) => `| ${f.rank} | ${codeSpan(f.file, { table: true })} | ${f.seconds} | ${f.tests} |`), '');
    else out.push('That run printed no table of slowest files.', '');
  }

  // 4. durations
  out.push('#### The Frontend check\'s duration (job start to job end)', '');
  const { current, previous } = weeks;
  if (!current.run) out.push('No successful first execution on a self-hosted machine in the last 7 days, so there is nothing to measure.', '');
  else {
    out.push(
      `Counted: ${plural(current.runs, 'run')} (successful first executions on a self-hosted machine).`,
      '',
      `- Typical run: ${formatDuration(current.run.typicalSec)}`,
      `- Slowest tenth: ${formatDuration(current.run.slowestTenthSec)}`,
      `- Longest run: ${formatDuration(current.run.longestSec)}`,
      '',
      '#### Frontend queue time (waiting for a runner; reported on its own, never added to the run time)',
      '',
      `- Typical wait: ${formatDuration(current.queue.typicalSec)}`,
      `- Slowest tenth of waits: ${formatDuration(current.queue.slowestTenthSec)}`,
      `- Longest wait: ${formatDuration(current.queue.longestSec)}`,
      '',
    );
    const t = trend(weeks);
    if (t) out.push(`Previous week: ${plural(previous.runs, 'run')}; typical ${formatDuration(previous.run.typicalSec)}, slowest tenth ${formatDuration(previous.run.slowestTenthSec)}.`, '');
    else out.push('Previous week: no runs to compare with.', '');
  }

  const causes = causesOf(tally, now, share);
  const actions = causes.map((c) => actionFor(c, openTickets));
  // The Frontend causes have tickets of their own (above), so this section never opens the Database ticket: breach is false.
  return { section: { id: 'frontend', title: 'Frontend check', breach: false, markdown: out.join('\n').trimEnd() }, actions };
}

