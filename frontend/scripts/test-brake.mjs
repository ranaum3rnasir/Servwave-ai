#!/usr/bin/env node
/**
 * Generators and the stand-alone page check of the test-growth brake (#3254).
 *
 *   node scripts/test-brake.mjs page-ceilings            # check the page file counts against test-page-ceilings.json
 *   node scripts/test-brake.mjs page-ceilings --write    # rewrite test-page-ceilings.json from the scan
 *   node scripts/test-brake.mjs baseline --events=FILE   # write test-time-baseline.json from the event file of a FULL run
 *                                                        # (the file `npm run test:ci` prints as "events at ...")
 *
 * `--write` for the ceilings never raises a number: a page whose count grew keeps its old ceiling and is
 * reported, so the file can be regenerated after tests were removed without hiding a regression.
 */
import { dirname, join, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { BUDGET_FILE, PAGE_CEILINGS_FILE, TIME_LIST_FILE, readJson, scanPages, writeJson } from './test-brake-io.mjs';
import { NEW_PAGE_START, buildBaseline, pageCeilings, pageProblemLine } from './test-brake-lib.mjs';
import { parseEvents as parseEventsText } from './test-ci-lib.mjs';

const FRONTEND = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...rest] = process.argv.slice(2);
const flags = Object.fromEntries(rest.map((a) => { const m = /^--([\w-]+)(?:=(.*))?$/.exec(a); return m ? [m[1], m[2] ?? true] : [a, true]; }));

if (cmd === 'page-ceilings') {
  const { counts, testFiles } = scanPages(FRONTEND);
  const path = join(FRONTEND, PAGE_CEILINGS_FILE);
  let current = {};
  try { current = readJson(path); } catch { /* first generation */ }
  if (flags.write) {
    const next = {};
    for (const [page, n] of Object.entries(counts)) next[page] = Math.min(n, current[page] ?? n);
    writeJson(path, next);
    console.log(`wrote ${PAGE_CEILINGS_FILE}: ${Object.keys(next).length} pages (of ${testFiles} test files)`);
  }
  const verdict = pageCeilings({ actual: counts, ceilings: flags.write ? readJson(path) : current, baseCeilings: null });
  for (const p of verdict.problems) console.log(`FAIL ${pageProblemLine(p)}`);
  console.log(`page ceilings: ${verdict.status} (new pages start at ${NEW_PAGE_START})`);
  process.exit(verdict.status === 'passed' ? 0 : 1);
} else if (cmd === 'baseline') {
  if (!flags.events || flags.events === true) { console.error('baseline wants --events=FILE (the event file of a full run)'); process.exit(2); }
  const { events, badLines } = parseEventsText(readFileSync(resolve(flags.events), 'utf8'));
  if (badLines > 0 || events.length === 0) { console.error(`event file unusable (${events.length} events, ${badLines} bad lines)`); process.exit(2); }
  const list = buildBaseline(events);
  writeJson(join(FRONTEND, TIME_LIST_FILE), list);
  console.log(`wrote ${TIME_LIST_FILE}: ${list.tests.length} tests and ${list.files.length} files over the line`);
} else {
  console.error(`usage: node scripts/test-brake.mjs page-ceilings [--write] | baseline --events=FILE  (budget lives in ${BUDGET_FILE})`);
  process.exit(2);
}
