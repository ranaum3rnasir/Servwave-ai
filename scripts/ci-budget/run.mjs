#!/usr/bin/env node
/* =============================================================================
   Weekly CI time budget: the thin I/O around lib.mjs (all the rules live there).

   Reads the last 14 days of the Database check's job data from the GitHub API, measures the last 7 days against the 7 before,
   and when the slowest tenth of run time is above the budget opens ONE ticket (or comments on the one already open).

     node scripts/ci-budget/run.mjs [--dry-run] [--now <iso time>]

   --dry-run reads, prints the report and says what it would have done. It never writes: no label, no ticket, no comment.
   Environment: GITHUB_TOKEN (read access to Actions; write access to issues only for a real run), GITHUB_REPOSITORY,
   GITHUB_API_URL (default https://api.github.com). With no GITHUB_TOKEN a dry run reads through the `gh` CLI.

   The report is a list of sections `{ id, title, breach, markdown }`. The Database section (lib.mjs) opens the one budget ticket when it is
   over its budget. The Frontend section (frontend.mjs, #3258) is its own pure function; it returns the section and a list of ticket
   actions, one per cause (error fallbacks above 5%, each test retried in two or more runs), each found again by its own hidden marker.
   This file only reads the run data and logs, and carries those actions out.

   A source that does not exist yet (no nightly run, a log that has expired) is printed as "Not available: <reason>" in the section;
   nothing is guessed.
   ========================================================================== */
import { execFileSync } from 'node:child_process';
import { appendFileSync, readFileSync } from 'node:fs';
import { measureWeeks, measure, databaseSection, decide, renderReport, slowestFilesFromLog, TICKET_LABELS, MARKER } from './lib.mjs';
import { frontendReport, relevantLines, cleanLine, slowestFilesFromLines, FRONTEND_JOB_NAME } from './frontend.mjs';

const JOB_NAME = 'Database (migrations + RLS)';
const WORKFLOW = 'ci.yml';
const NIGHTLY_WORKFLOW = 'ci-nightly.yml';
const NIGHTLY_JOB_NAME = 'Full Frontend run of staging';
const BUDGET_FILE = new URL('../../frontend/test-budget.json', import.meta.url);
/** How many of the newest counted runs to read logs from while looking for the ten-slowest-files table. */
const LOG_LOOKBACK = 5;

const skippedRuns = [];
const args = process.argv.slice(2);
const dryRun = args.includes('--dry-run');
const nowArg = args.indexOf('--now');
const now = nowArg >= 0 ? new Date(args[nowArg + 1]).toISOString() : new Date().toISOString();

const token = process.env.GITHUB_TOKEN;
const repo = process.env.GITHUB_REPOSITORY || execFileSync('git', ['remote', 'get-url', 'origin'], { encoding: 'utf8' }).trim().replace(/^.*github\.com[:/]/, '').replace(/\.git$/, '');
const base = process.env.GITHUB_API_URL || 'https://api.github.com';

function viaGh(path) {
  return execFileSync('gh', ['api', `repos/${repo}/${path}`], { encoding: 'utf8', maxBuffer: 256 * 1024 * 1024 });
}

async function call(method, path, body) {
  const res = await fetch(`${base}/repos/${repo}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw Object.assign(new Error(`${method} ${path}: HTTP ${res.status}`), { status: res.status });
  return res;
}

/** A read is tried up to three times: GitHub (or a proxy in front of it) now and then answers a read with a 5xx for one call. */
async function withRetries(read) {
  for (let attempt = 1; ; attempt += 1) {
    try { return await read(); } catch (e) {
      const transient = (e.status ?? 0) >= 500 || /HTTP 5\d\d|ECONNRESET|ETIMEDOUT|fetch failed/.test(String(e.message));
      if (!transient || attempt === 3) throw e;
      await new Promise((r) => setTimeout(r, 1000 * attempt));
    }
  }
}
const getText = (path) => withRetries(async () => (token ? (await call('GET', path)).text() : viaGh(path)));
const get = async (path) => JSON.parse(await getText(path));

async function paged(path, pick) {
  const out = [];
  for (let page = 1; ; page += 1) {
    const body = await get(`${path}${path.includes('?') ? '&' : '?'}per_page=100&page=${page}`);
    const items = pick(body);
    out.push(...items);
    if (items.length < 100) return out;
  }
}

/** One record per execution of the Database or the Frontend job whose run started in the last 14 days (every attempt, so re-runs show up as such). */
async function collectRecords() {
  const since = new Date(Date.parse(now) - 15 * 86_400_000).toISOString().slice(0, 10);
  const runs = await paged(`actions/workflows/${WORKFLOW}/runs?created=${encodeURIComponent(`>=${since}`)}`, (b) => b.workflow_runs);
  const records = [];
  const queue = [...runs];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let run = queue.shift(); run; run = queue.shift()) {
      let jobs;
      try { jobs = await paged(`actions/runs/${run.id}/jobs?filter=all`, (b) => b.jobs); } catch (e) {
        skippedRuns.push(run.id); // fail soft: one run whose job list GitHub will not return is left out and named, never a failed report
        console.error(`note: the jobs of run ${run.id} could not be read (${String(e.message).split('\n').pop()}), left out`);
        continue;
      }
      for (const j of jobs.filter((x) => x.name === JOB_NAME || x.name === FRONTEND_JOB_NAME)) {
        records.push({
          job: j.name === JOB_NAME ? 'database' : 'frontend', runId: run.id, jobId: j.id, runAttempt: j.run_attempt, conclusion: j.conclusion, labels: j.labels, runnerGroup: j.runner_group_name,
          createdAt: j.created_at, startedAt: j.started_at, completedAt: j.completed_at,
          event: run.event, headBranch: run.head_branch, // who may steer a ticket: see isTrustedRun in frontend.mjs
        });
      }
    }
  }));
  return records;
}

/** The ten slowest files from the newest counted runs' logs: the first run that printed the table wins. */
async function findSlowest(records) {
  const newest = records
    .filter((r) => measure([r]).runs === 1)
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
    .slice(0, LOG_LOOKBACK);
  for (const r of newest) {
    let log;
    try { log = await getText(`actions/jobs/${r.jobId}/logs`); } catch { continue; }
    const files = slowestFilesFromLog(log);
    if (files) return { files, source: `run ${r.runId}, finished ${r.completedAt}` };
  }
  return null;
}

const openTickets = () => paged('issues?state=open&labels=ci-budget', (b) => b);

/** Run `fn` over `items`, six at a time. */
async function pool(items, fn) {
  const queue = [...items];
  await Promise.all(Array.from({ length: 6 }, async () => {
    for (let item = queue.shift(); item; item = queue.shift()) await fn(item);
  }));
}

/** The log lines the Frontend section reads, for each Frontend execution that finished in the last 7 days. `lines` is null when the log cannot be read. */
async function readFrontendLogs(frontend) {
  const from = Date.parse(now) - 7 * 86_400_000;
  const week = frontend.filter((r) => r.completedAt && Date.parse(r.completedAt) > from && Date.parse(r.completedAt) <= Date.parse(now));
  await pool(week, async (r) => {
    try { r.lines = relevantLines(await getText(`actions/jobs/${r.jobId}/logs`)); } catch { r.lines = null; }
  });
}

/**
 * The scheduled nightly full runs that finished in the last 7 days, with their relevant log lines: the only runs besides pushes to
 * staging/main whose retried tests count (a manual dispatch can name any ref, so it does not).
 */
async function readNightlyRuns() {
  const from = Date.parse(now) - 7 * 86_400_000;
  const out = [];
  try {
    const runs = (await get(`actions/workflows/${NIGHTLY_WORKFLOW}/runs?per_page=20&status=completed&event=schedule`)).workflow_runs
      .filter((r) => Date.parse(r.updated_at) > from && Date.parse(r.updated_at) <= Date.parse(now));
    await pool(runs, async (run) => {
      try {
        const job = (await paged(`actions/runs/${run.id}/jobs`, (b) => b.jobs)).find((j) => j.name === NIGHTLY_JOB_NAME);
        if (job?.completed_at) out.push({ runId: run.id, completedAt: job.completed_at, lines: relevantLines(await getText(`actions/jobs/${job.id}/logs`)) });
      } catch { /* a log that cannot be read adds no retried tests; nothing is guessed */ }
    });
  } catch { /* no nightly runs yet */ }
  return out;
}

/**
 * The newest full run whose log can be read: the latest nightly full run, else (until one exists) the newest full pull request run,
 * said so in the report. Returns { kind, source, lines } or { unavailable: reason }.
 */
async function findNightly(frontend) {
  let why = 'no nightly full run exists yet (the nightly workflow has not run on the default branch)';
  try {
    const runs = (await get(`actions/workflows/${NIGHTLY_WORKFLOW}/runs?per_page=10&status=completed`)).workflow_runs
      .filter((r) => ['success', 'failure'].includes(r.conclusion));
    for (const run of runs) {
      const job = (await paged(`actions/runs/${run.id}/jobs`, (b) => b.jobs)).find((j) => j.name === NIGHTLY_JOB_NAME);
      if (!job) continue;
      let lines;
      try { lines = (await getText(`actions/jobs/${job.id}/logs`)).split('\n').map(cleanLine); } catch { why = 'the latest nightly run\'s log could not be read'; continue; }
      if (slowestFilesFromLines(lines)) return { kind: 'nightly', source: `run ${run.id}, finished ${job.completed_at}`, lines };
    }
    if (runs.length) why = 'the latest nightly runs printed no table of slowest files';
  } catch (e) {
    if (e.status !== 404 && !/HTTP 404|Not Found/.test(String(e.message))) why = `the nightly runs could not be read (${String(e.message).split('\n')[0]})`;
  }
  const newest = frontend
    .filter((r) => r.conclusion === 'success' && r.completedAt)
    .sort((a, b) => Date.parse(b.completedAt) - Date.parse(a.completedAt))
    .slice(0, LOG_LOOKBACK);
  for (const r of newest) {
    let lines;
    try { lines = (await getText(`actions/jobs/${r.jobId}/logs`)).split('\n').map(cleanLine); } catch { continue; }
    if (slowestFilesFromLines(lines)) return { kind: 'pull-request', source: `run ${r.runId}, finished ${r.completedAt}`, lines };
  }
  return { unavailable: why };
}

async function ensureLabel() {
  try {
    await call('POST', 'labels', { name: 'ci-budget', color: 'ededed', description: 'Opened by the weekly CI time budget job' });
  } catch (e) {
    if (e.status !== 422) throw e; // 422 = the label already exists
  }
}

const records = await collectRecords();
const dbRecords = records.filter((r) => r.job === 'database');
const feRecords = records.filter((r) => r.job === 'frontend');
const weeks = measureWeeks(dbRecords, now);
await readFrontendLogs(feRecords);
const budget = JSON.parse(readFileSync(BUDGET_FILE, 'utf8'));
const nightly = await findNightly(feRecords);
const nightlyRuns = await readNightlyRuns();
const frontendInput = async () => ({ now, runs: feRecords, nightly, nightlyRuns, budget, openTickets: await openTickets() });
const fe = frontendReport(await frontendInput());
const sections = [databaseSection({ weeks, slowest: await findSlowest(dbRecords) }), fe.section];
const decision = decide({ sections, openTickets: await openTickets() }, now);
const report = renderReport(sections, now);

console.log(report.replace(MARKER, '').trimEnd());
if (skippedRuns.length) console.log(`\nLeft out: ${skippedRuns.length} run(s) whose job list could not be read (${skippedRuns.join(', ')}).`);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${report}\n`);

// ---- the Database ticket -----------------------------------------------------------------------------------------------------
console.log('');
if (decision.kind === 'none') console.log('Database decision: within budget, nothing to do.');
else if (dryRun) {
  console.log(decision.kind === 'open'
    ? `Database decision (dry run, nothing written): would open one ticket "${decision.title}" with labels ${TICKET_LABELS.join(', ')}.`
    : `Database decision (dry run, nothing written): would comment on the open ticket #${decision.number}.`);
} else if (decision.kind === 'open') {
  // Look the ticket up once more right before opening: the lookup above ran before the slow log reads.
  const again = decide({ sections, openTickets: await openTickets() }, now);
  if (again.kind === 'comment') {
    await call('POST', `issues/${again.number}/comments`, { body: again.body });
    console.log(`Commented on ticket #${again.number} (it appeared while this run was measuring).`);
  } else {
    await ensureLabel();
    const created = await (await call('POST', 'issues', { title: decision.title, body: decision.body, labels: decision.labels })).json();
    console.log(`Opened ticket #${created.number}.`);
  }
} else {
  await call('POST', `issues/${decision.number}/comments`, { body: decision.body });
  console.log(`Commented on ticket #${decision.number}.`);
}

// ---- the Frontend tickets: one open ticket per cause ----------------------------------------------------------------------------
if (fe.actions.length === 0) console.log('Frontend decision: no cause is over its line, nothing to do.');
else if (dryRun) {
  for (const a of fe.actions) {
    console.log(a.kind === 'open'
      ? `Frontend decision (dry run, nothing written): would open one ticket "${a.title}" with labels ${a.labels.join(', ')} [${a.cause}].`
      : `Frontend decision (dry run, nothing written): would comment on the open ticket #${a.number} [${a.cause}].`);
  }
} else {
  // Look every cause's ticket up again right before writing (the lookup above ran before the slow log reads). The writer queue
  // (one concurrency group) keeps a second run from looking in between.
  const again = frontendReport(await frontendInput());
  if (again.actions.some((a) => a.kind === 'open')) await ensureLabel();
  for (const a of again.actions) {
    if (a.kind === 'open') {
      const created = await (await call('POST', 'issues', { title: a.title, body: a.body, labels: a.labels })).json();
      console.log(`Opened ticket #${created.number} [${a.cause}].`);
    } else {
      await call('POST', `issues/${a.number}/comments`, { body: a.body });
      console.log(`Commented on ticket #${a.number} [${a.cause}].`);
    }
  }
}
