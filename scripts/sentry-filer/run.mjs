#!/usr/bin/env node
/* =============================================================================
   Nightly Sentry -> GitHub issue filer (Slice 1 of the Sentry automation plan,
   md_files/plans/sentry-automation/00-SYNTHESIS-and-recommendation.md §6-7).

   Reconciles production Sentry against GitHub: every unresolved production
   issue active inside the window, whenever it first appeared, that has no
   GitHub issue yet (see candidateQuery / plan in lib.mjs). Because it compares
   state rather than reading a change window, a missed night or a
   slow-building error is caught by the next run. It drops the noise and
   red-list classes described in lib.mjs,
   redacts, and opens ONE deduplicated GitHub issue per Sentry group on
   ranro1/ALPHA_CRM. It never runs an agent and never labels anything
   `ready-for-agent`; Ran does that by hand.

   Dry run by default: prints what it would file and touches nothing.

   Usage:
     SENTRY_FILER_TOKEN=... node scripts/sentry-filer/run.mjs            # dry run
     SENTRY_FILER_TOKEN=... node scripts/sentry-filer/run.mjs --apply    # file issues
     options: --since 24h|7d|30d   only issues active (last seen) inside this window (default 24h)
              --max N              cap on issues filed per run (default 5)
              --min-events N       minimum events over max(14d, --since) (default 2)

   Env:
     SENTRY_FILER_TOKEN  Sentry auth token, read-only scopes: org:read, project:read, event:read
     SENTRY_ORG          default "servwave"
     SENTRY_PROJECTS     default "servwave-backend,servwave-frontend"
     SENTRY_API          default "https://us.sentry.io/api/0"
     SENTRY_PRODUCTION_HOSTS  comma list; default lib.mjs PRODUCTION_HOSTS. A candidate
                         whose latest event URL is on another host is skipped.
     GITHUB_REPOSITORY   default "ranro1/ALPHA_CRM" (set by Actions)
     GH_TOKEN            used by the gh CLI; in Actions, the workflow's GITHUB_TOKEN

   Idempotent: each filed issue carries a hidden marker with the Sentry group
   id, and every run reads existing `source:sentry` issues first. An open
   match is skipped. A closed match whose Sentry group has regressed gets a
   comment and is reopened as `needs-triage` instead of a duplicate.
   ========================================================================== */

import { execFileSync } from 'node:child_process';
import {
  DEFAULTS, FILED_ENVIRONMENTS, SOURCE_LABEL,
  classify, inAppFrames, buildGithubIssue, parseMarker, safeIdent, statsPeriodFor, candidateQuery, plan,
  fromProductionHost, PRODUCTION_HOSTS,
} from './lib.mjs';

const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const opt = (name, fallback) => {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : fallback;
};

const APPLY = flag('--apply');
const SINCE = opt('--since', '24h');
const MAX = Number(opt('--max', DEFAULTS.maxIssuesPerRun));
const MIN_EVENTS = Number(opt('--min-events', DEFAULTS.minEvents));

const TOKEN = process.env.SENTRY_FILER_TOKEN;
const ORG = process.env.SENTRY_ORG || 'servwave';
const PROJECTS = (process.env.SENTRY_PROJECTS || 'servwave-backend,servwave-frontend').split(',').map((s) => s.trim());
const API = (process.env.SENTRY_API || 'https://us.sentry.io/api/0').replace(/\/$/, '');
const REPO = process.env.GITHUB_REPOSITORY || 'ranro1/ALPHA_CRM';
const HOSTS = process.env.SENTRY_PRODUCTION_HOSTS
  ? process.env.SENTRY_PRODUCTION_HOSTS.split(',').map((h) => h.trim())
  : PRODUCTION_HOSTS;

if (!/^\d+[hd]$/.test(SINCE)) fail(`--since must look like 24h or 7d, got ${SINCE}`);
if (!(Number.isInteger(MIN_EVENTS) && MIN_EVENTS >= 1)) fail('--min-events must be a whole number of at least 1');
if (!(Number.isInteger(MAX) && MAX >= 1)) fail('--max must be a whole number of at least 1');
if (!TOKEN) fail('SENTRY_FILER_TOKEN is not set');

function fail(msg) {
  console.error(`sentry-filer: ${msg}`);
  process.exit(1);
}

async function sentry(path, params = {}) {
  const url = new URL(`${API}${path}`);
  for (const [k, v] of Object.entries(params)) {
    for (const item of [].concat(v)) url.searchParams.append(k, item);
  }
  const res = await fetch(url, { headers: { Authorization: `Bearer ${TOKEN}` } });
  if (!res.ok) {
    // Never echo the response body: it can carry event content.
    throw new Error(`Sentry API ${res.status} on ${url.pathname}`);
  }
  return res.json();
}

function gh(argv, input) {
  return execFileSync('gh', argv, { encoding: 'utf8', input, stdio: [input ? 'pipe' : 'ignore', 'pipe', 'inherit'] });
}

async function projectIds() {
  const all = await sentry(`/organizations/${ORG}/projects/`);
  const ids = all.filter((p) => PROJECTS.includes(p.slug)).map((p) => p.id);
  if (ids.length !== PROJECTS.length) fail(`expected projects ${PROJECTS.join(', ')}; the token sees ${all.map((p) => p.slug).join(', ')}`);
  return ids;
}

async function candidates(ids) {
  // One page of 100, most frequent first. Anything past it is still active
  // tomorrow and is reconciled then.
  return sentry(`/organizations/${ORG}/issues/`, {
    project: ids, environment: FILED_ENVIRONMENTS, query: candidateQuery(SINCE),
    statsPeriod: statsPeriodFor(SINCE), limit: '100', sort: 'freq',
  });
}

async function latestEvent(issueId) {
  return sentry(`/organizations/${ORG}/issues/${issueId}/events/latest/`, { environment: FILED_ENVIRONMENTS });
}

function existingIssues() {
  const out = gh(['issue', 'list', '--repo', REPO, '--label', SOURCE_LABEL, '--state', 'all', '--limit', '1000', '--json', 'number,state,body']);
  const map = new Map();
  for (const it of JSON.parse(out)) {
    const id = parseMarker(it.body);
    if (id) map.set(id, { number: it.number, state: it.state });
  }
  return map;
}

function ensureSourceLabel() {
  gh(['label', 'create', SOURCE_LABEL, '--repo', REPO, '--force', '--color', '5319e7',
    '--description', 'Filed automatically from a production Sentry issue']);
}

async function main() {
  console.log(`sentry-filer: ${APPLY ? 'APPLY' : 'dry run'} | org ${ORG} | projects ${PROJECTS.join(', ')} | env ${FILED_ENVIRONMENTS.join(', ')} | since ${SINCE} | max ${MAX} | min events ${MIN_EVENTS}`);

  const ids = await projectIds();
  const found = await candidates(ids);
  const existing = existingIssues();

  const { toFile, toReopen, log } = plan(found, existing, { minEvents: MIN_EVENTS, max: MAX });
  for (const { action, issue, reason } of log) {
    if (action === 'skip' || action === 'defer') {
      console.log(`  ${action.padEnd(5)} ${safeIdent(issue.shortId, 40)} (${Number(issue.count)} events): ${reason}`);
    }
  }

  if (APPLY && (toFile.length || toReopen.length)) ensureSourceLabel();

  for (const { issue, prior } of toReopen) {
    const note = `Sentry reports [${safeIdent(issue.shortId, 40)}](${issue.permalink}) as **${safeIdent(issue.substatus, 20)}** in production (last seen ${safeIdent(issue.lastSeen, 30)}, ${Number(issue.count)} events). Reopening for triage.`;
    console.log(`  REOPEN #${prior.number} for ${issue.shortId}`);
    if (APPLY) {
      gh(['issue', 'reopen', String(prior.number), '--repo', REPO, '--comment', note]);
      gh(['issue', 'edit', String(prior.number), '--repo', REPO, '--add-label', 'needs-triage']);
      try {
        gh(['issue', 'edit', String(prior.number), '--repo', REPO, '--remove-label', 'ready-for-agent']);
      } catch { /* the label was not on the issue */ }
    }
  }

  let filed = 0;
  let offHost = 0;
  for (const issue of toFile) {
    const event = await latestEvent(issue.id);
    const origin = fromProductionHost(event, HOSTS);
    if (!origin.ok) {
      console.log(`  skip  ${safeIdent(issue.shortId, 40)}: tagged production but the latest event is from ${origin.host}`);
      offHost += 1;
      continue;
    }
    const frames = inAppFrames(event);
    const cls = classify(issue, frames);
    const gi = buildGithubIssue(issue, event, cls, frames);
    console.log(`  FILE  ${gi.title}  [${gi.labels.join(', ')}]`);
    filed += 1;
    if (!APPLY) { console.log(gi.body.split('\n').map((l) => `        | ${l}`).join('\n')); continue; }
    const url = gh(['issue', 'create', '--repo', REPO, '--title', gi.title, '--body-file', '-',
      ...gi.labels.flatMap((l) => ['--label', l])], gi.body).trim();
    console.log(`        -> ${url}`);
  }

  console.log(`sentry-filer: ${filed} ${APPLY ? 'filed' : 'to file'}, ${toReopen.length} ${APPLY ? 'reopened' : 'to reopen'}, ${offHost} off-host, ${found.length} candidates seen${APPLY ? '' : ' (dry run, nothing written)'}`);
}

main().catch((err) => fail(err.message));
