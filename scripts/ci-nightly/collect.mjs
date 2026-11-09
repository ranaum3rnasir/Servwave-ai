#!/usr/bin/env node
/* Run job, after the one command has finished: turn what it printed and wrote into one report (lib.mjs), show it in the job
   summary and hand it to the report job as a one-line JSON output. It never decides anything and never writes an issue.

     node scripts/ci-nightly/collect.mjs --log FILE --events FILE --summary FILE --exit-code N --seconds N --ref REF --sha SHA

   --summary is the markdown file the command wrote (its budget figures are copied into the report). Environment: GITHUB_STEP_SUMMARY and
   GITHUB_OUTPUT when set. Imports the frontend's own event reader so the failed files are read the way the command reads them. */
import { execFileSync } from 'node:child_process';
import { appendFileSync, existsSync, readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { parseEvents, failedSoFar } from '../../frontend/scripts/test-ci-lib.mjs';
import { buildReport, renderSummary, normalizeRef } from './lib.mjs';

const { values: a } = parseArgs({
  options: { log: { type: 'string' }, events: { type: 'string' }, summary: { type: 'string' }, 'exit-code': { type: 'string' }, seconds: { type: 'string' }, ref: { type: 'string' }, sha: { type: 'string' } },
});
/** The branch the checkout actually landed on (a checkout of any spelling of a branch name leaves HEAD on that branch); else the input, normalized. */
function resolvedRef(input) {
  try {
    const name = execFileSync('git', ['symbolic-ref', '-q', '--short', 'HEAD'], { encoding: 'utf8' }).trim();
    if (name) return name;
  } catch { /* detached HEAD: a tag or a commit, not a branch */ }
  return normalizeRef(input);
}
const read = (p) => (p && existsSync(p) ? readFileSync(p, 'utf8') : '');

const report = buildReport({
  ref: resolvedRef(a.ref), sha: a.sha, exitCode: Number(a['exit-code']), runSeconds: Number(a.seconds),
  log: read(a.log), summaryMd: read(a.summary),
  failedLines: failedSoFar(parseEvents(read(a.events)).events).lines,
});

const text = renderSummary(report);
console.log(text);
if (process.env.GITHUB_STEP_SUMMARY) appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${read(a.summary)}\n${text}\n`);
if (process.env.GITHUB_OUTPUT) appendFileSync(process.env.GITHUB_OUTPUT, `report=${JSON.stringify(report)}\n`);
