const DAY_MS = 86_400_000;

const seconds = (fromIso, toIso) => Math.round((Date.parse(toIso) - Date.parse(fromIso)) / 1000);

/** Nearest-rank percentile of an ascending list. */
const rank = (sorted, p) => sorted[Math.max(0, Math.ceil(p * sorted.length) - 1)];

const median = (sorted) => {
  const mid = sorted.length / 2;
  return Number.isInteger(mid) ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[Math.floor(mid)];
};

function figures(values) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return { typicalSec: median(sorted), slowestTenthSec: rank(sorted, 0.9), longestSec: sorted[sorted.length - 1] };
}

/** Hosted machines carry a hosted image label (ubuntu-latest, ubuntu-24.04, macos-14, ...) or sit in the hosted runner group. */
const isHosted = (r) => r.runnerGroup === 'GitHub Actions' || (r.labels ?? []).some((l) => /^(ubuntu|windows|macos)-/.test(l));

/**
 * Figures for one set of executions of the Database job. Only a successful FIRST execution on a self-hosted machine counts; the
 * others are tallied in `left` so a report can say what was left out. A record that has not finished is ignored without a tally.
 */
export function measure(records) {
  const left = { rerun: 0, cancelled: 0, notPassed: 0, hosted: 0 };
  const counted = [];
  for (const r of records) {
    if (!r.startedAt || !r.completedAt || !r.createdAt) continue;
    if (r.runAttempt !== 1) left.rerun += 1;
    else if (isHosted(r)) left.hosted += 1;
    else if (r.conclusion === 'cancelled') left.cancelled += 1;
    else if (r.conclusion !== 'success') left.notPassed += 1;
    else counted.push(r);
  }
  return {
    runs: counted.length,
    left,
    run: figures(counted.map((r) => seconds(r.startedAt, r.completedAt))),
    queue: figures(counted.map((r) => seconds(r.createdAt, r.startedAt))),
  };
}

export function measureWeeks(records, now) {
  const end = Date.parse(now);
  const within = (r, from, to) => Date.parse(r.completedAt) > from && Date.parse(r.completedAt) <= to;
  return {
    current: measure(records.filter((r) => within(r, end - 7 * DAY_MS, end))),
    previous: measure(records.filter((r) => within(r, end - 14 * DAY_MS, end - 7 * DAY_MS))),
  };
}

// ---- the budget ---------------------------------------------------------------------------------------------------------------

export const BUDGET_SEC = 8 * 60;

/** True only when the slowest tenth of RUN time is strictly above the budget. Queue time never counts. */
export const overBudget = (week) => week.run !== null && week.run.slowestTenthSec > BUDGET_SEC;

/** This week against the previous one; null when either has no runs. */
export function trend({ current, previous }) {
  if (!current.run || !previous.run) return null;
  return {
    runsDelta: current.runs - previous.runs,
    typicalDeltaSec: current.run.typicalSec - previous.run.typicalSec,
    slowestTenthDeltaSec: current.run.slowestTenthSec - previous.run.slowestTenthSec,
  };
}

export function formatDuration(sec) {
  const s = Math.round(sec);
  return `${Math.floor(s / 60)} min ${String(s % 60).padStart(2, '0')} s`;
}

// ---- the ten slowest files, from the Database command's job log ---------------------------------------------------------------

// These two lines are what `backend/scripts/ci-db/summary.ts` prints; a test reads that file and fails if they drift apart.
export const SLOWEST_FILES_HEADING = '### Ten slowest files';
export const SLOWEST_FILES_HEADER_ROW = '| File | Lane | Time |';

const cells = (line) => line.split(/(?<!\\)\|/).slice(1, -1).map((c) => c.trim().replace(/\\\|/g, '|'));

/** The table of ten slowest files in a job log (each line starts with a timestamp), or null when the log has none. */
export function slowestFilesFromLog(log) {
  const lines = log.split('\n').map((l) => l.replace(/\r$/, '').replace(/^\S+Z /, ''));
  const at = lines.findIndex((l) => l.trim() === SLOWEST_FILES_HEADING);
  if (at < 0) return null;
  let i = at + 1;
  while (i < lines.length && lines[i].trim() === '') i += 1;
  if (lines[i]?.trim() !== SLOWEST_FILES_HEADER_ROW) return null;
  i += 2; // the header row and its separator
  const files = [];
  for (; i < lines.length && lines[i].startsWith('|'); i += 1) {
    const [file, lane, time] = cells(lines[i]);
    files.push({ file, lane, time });
  }
  return files.length ? files : null;
}

// ---- the report ----------------------------------------------------------------------------------------------------------------

/** A hidden marker in every report body: it is how the one open ticket is found again. */
export const MARKER = '<!-- ci-weekly-budget -->';

/**
 * Text that came out of a job log is written by whoever's code ran in that job, so it never goes into a ticket, a comment or the
 * report as live markdown. It becomes ONE code span: newlines and control characters become spaces, a backtick becomes an
 * apostrophe (so the span cannot be closed from inside), `<!--` and `-->` are broken up, a `|` is escaped when `table` is set, and the
 * length is capped. Inside a code span GitHub does not notify an `@name`, nor link a `#123`.
 */
export function codeSpan(text, { max = 160, table = false } = {}) {
  let t = String(text)
    .replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029]+/g, ' ')
    .replace(/`/g, "'")
    .replace(/<!--/g, '<! --')
    .replace(/-->/g, '-- >')
    .trim();
  if (t.length > max) t = `${t.slice(0, max - 3)}...`;
  return `\`${table ? t.replace(/\|/g, '\\|') : t}\``;
}

/** True when `body` ends with `marker` as its own last line: the position only this job writes. A marker anywhere else is just text. */
export function hasTrailingMarker(body, marker) {
  const t = String(body ?? '').trimEnd();
  return t === marker || t.endsWith(`\n${marker}`);
}

const plural = (n, word) => `${n} ${word}${n === 1 ? '' : 's'}`;
const signed = (sec) => (sec === 0 ? 'unchanged' : `${sec > 0 ? 'up' : 'down'} ${formatDuration(Math.abs(sec))}`);

function leftOut(left) {
  const parts = [];
  if (left.rerun) parts.push(plural(left.rerun, 're-run'));
  if (left.cancelled) parts.push(`${left.cancelled} cancelled`);
  if (left.notPassed) parts.push(`${left.notPassed} not passed`);
  if (left.hosted) parts.push(`${left.hosted} on a hosted machine`);
  return parts.length ? parts.join(', ') : 'nothing';
}

/**
 * The Database check's part of the weekly report. A section is `{ id, title, breach, markdown }`; the report is a list of them, so
 * another check adds its own section by returning one more object of this shape.
 */
export function databaseSection({ weeks, slowest }) {
  const { current, previous } = weeks;
  const out = [];
  if (!current.run) {
    out.push('No successful first execution on a self-hosted machine in the last 7 days, so there is nothing to measure.');
  } else {
    const over = overBudget(current);
    out.push(
      `Slowest tenth: **${formatDuration(current.run.slowestTenthSec)}**. Budget: ${formatDuration(BUDGET_SEC)}. ${over ? '**Over the budget.**' : 'Within the budget.'}`,
      '',
      `Counted: ${plural(current.runs, 'run')} (successful first executions on a self-hosted machine). Left out: ${leftOut(current.left)}.`,
      '',
      '#### Run time (from the job starting to it finishing)',
      '',
      `- Typical run: ${formatDuration(current.run.typicalSec)}`,
      `- Slowest tenth: ${formatDuration(current.run.slowestTenthSec)}`,
      `- Longest run: ${formatDuration(current.run.longestSec)}`,
      '',
      '#### Queue time (waiting for the reserved runner; never part of the budget)',
      '',
      `- Typical wait: ${formatDuration(current.queue.typicalSec)}`,
      `- Slowest tenth of waits: ${formatDuration(current.queue.slowestTenthSec)}`,
      `- Longest wait: ${formatDuration(current.queue.longestSec)}`,
      '',
    );
    const t = trend(weeks);
    if (previous.run) {
      out.push(
        `Previous week: ${plural(previous.runs, 'run')}; typical ${formatDuration(previous.run.typicalSec)}, slowest tenth ${formatDuration(previous.run.slowestTenthSec)}.`,
        `Trend: slowest tenth ${signed(t.slowestTenthDeltaSec)}, typical run ${signed(t.typicalDeltaSec)}.`,
        '',
      );
    } else out.push('Previous week: no runs to compare with.', '');
  }
  out.push('#### Ten slowest files (from the latest run that printed them)', '');
  if (slowest?.files?.length) {
    out.push(`Source: ${slowest.source}.`, '', '| File | Lane | Time |', '|---|---|---|', ...slowest.files.map((f) => `| ${codeSpan(f.file, { table: true })} | ${codeSpan(f.lane, { table: true })} | ${codeSpan(f.time, { table: true })} |`));
  } else out.push('Not available: none of the most recent runs printed the table.');
  return { id: 'database', title: 'Database check', breach: overBudget(current), markdown: out.join('\n') };
}

export function renderReport(sections, now) {
  const head = now ? `## Weekly CI time budget (week to ${now.slice(0, 10)})` : '## Weekly CI time budget';
  return [head, '', ...sections.flatMap((s) => [`### ${s.title}`, '', s.markdown, '']), MARKER, ''].join('\n');
}

// ---- the one open ticket -------------------------------------------------------------------------------------------------------

export const TICKET_LABELS = ['priority:medium', 'module:general', 'ci-budget'];

/**
 * What to do with a finished report: nothing when no section is over budget; otherwise open the one ticket, or comment on the
 * open one (found by MARKER; a pull request never matches). With two marked tickets open the oldest gets the comment.
 */
export function decide({ sections, openTickets }, now) {
  const breached = sections.filter((s) => s.breach);
  if (breached.length === 0) return { kind: 'none' };
  const body = renderReport(sections, now);
  const marked = openTickets.filter((t) => !t.pull_request && hasTrailingMarker(t.body, MARKER)).sort((a, b) => a.number - b.number);
  if (marked.length === 0) {
    return { kind: 'open', title: `CI weekly time budget is over: ${breached.map((s) => s.title).join(', ')}`, labels: TICKET_LABELS, body };
  }
  const others = marked.slice(1).map((t) => `#${t.number}`);
  return { kind: 'comment', number: marked[0].number, body: others.length ? `${body}\nAlso open with the same marker: ${others.join(', ')}.\n` : body };
}
