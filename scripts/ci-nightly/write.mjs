#!/usr/bin/env node
/* Report job: read the run job's report and keep ONE open issue current (rules in lib.mjs, decide()).

     node scripts/ci-nightly/write.mjs [--dry-run]

   Environment: RUN_REF (the ref that was run: set by the workflow from its own input, the ONLY source of the ref that decides anything; the report's ref is shown, never trusted), REPORT (JSON from collect.mjs; empty when the run job produced none), JOB_RESULT (the run job's result),
   GITHUB_TOKEN (issues: write for a real run), GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID, GITHUB_API_URL.
   --dry-run prints the decision and writes nothing: no label, no issue, no comment, no close. */
import { decide, ISSUE_LABELS } from './lib.mjs';

const dryRun = process.argv.includes('--dry-run');
const repo = process.env.GITHUB_REPOSITORY;
const base = process.env.GITHUB_API_URL || 'https://api.github.com';
const token = process.env.GITHUB_TOKEN;
const runUrl = process.env.GITHUB_RUN_ID ? `${process.env.GITHUB_SERVER_URL || 'https://github.com'}/${repo}/actions/runs/${process.env.GITHUB_RUN_ID}` : null;
const report = process.env.REPORT ? JSON.parse(process.env.REPORT) : null;
const jobResult = process.env.JOB_RESULT || 'failure';

async function call(method, path, body) {
  const res = await fetch(`${base}/repos/${repo}/${path}`, {
    method,
    headers: { Authorization: `Bearer ${token}`, Accept: 'application/vnd.github+json', ...(body ? { 'Content-Type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  if (!res.ok) throw Object.assign(new Error(`${method} ${path}: HTTP ${res.status}`), { status: res.status });
  return res;
}

async function openIssues() {
  const out = [];
  for (let page = 1; ; page += 1) {
    const items = await (await call('GET', `issues?state=open&labels=ci-nightly&per_page=100&page=${page}`)).json();
    out.push(...items);
    if (items.length < 100) return out;
  }
}

const plan = async () => decide({ report, jobResult, openIssues: await openIssues(), runUrl, ref: process.env.RUN_REF });

let d = await plan();
console.log(`Decision: ${d.kind}${d.why ? ` (${d.why})` : ''}`);
if (dryRun || d.kind === 'none') {
  if (dryRun) console.log(JSON.stringify(d, null, 2));
  process.exit(0);
}
if (d.kind === 'open') {
  // Look once more right before opening, so a run that finished a moment ago is found (the group in the workflow queues the writers).
  d = await plan();
}
if (d.kind === 'open') {
  try {
    await call('POST', 'labels', { name: 'ci-nightly', color: 'ededed', description: 'Opened by the nightly full run of staging' });
  } catch (e) {
    if (e.status !== 422) throw e; // 422 = the label already exists
  }
  const created = await (await call('POST', 'issues', { title: d.title, body: d.body, labels: ISSUE_LABELS })).json();
  console.log(`Opened issue #${created.number}.`);
} else if (d.kind === 'comment') {
  // The state first: if the comment then fails, the recorded refs are already right (a stale state could let a drill close a real failure).
  await call('PATCH', `issues/${d.number}`, { body: d.issueBody });
  await call('POST', `issues/${d.number}/comments`, { body: d.body });
  console.log(`Updated issue #${d.number}.`);
} else if (d.kind === 'close') {
  for (const n of d.numbers) {
    await call('POST', `issues/${n}/comments`, { body: d.body });
    await call('PATCH', `issues/${n}`, { state: 'closed', state_reason: 'completed' });
    console.log(`Closed issue #${n}.`);
  }
}
