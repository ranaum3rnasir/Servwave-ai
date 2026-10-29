#!/usr/bin/env node
/**
 * The promotion check (mobile slice 62): is there a passing full-sweep report for what is about
 * to be promoted to main?
 *
 *   npm run test:mobile:sweep:check                        # the staging head, the newest report
 *   npm run test:mobile:sweep:check -- --sha <commit>      # a staging commit being cherry-picked
 *   npm run test:mobile:sweep:check -- --report <file> --max-age-hours 48
 *
 * Exit 0: the report passed, swept a commit that contains `--sha`, covers every device and every
 * Lighthouse page, and is fresh. Exit 1 otherwise, with each reason. The ship-to-main checklist
 * (docs/promotion-parity-check.md, axis 5) requires this to be green first.
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { checkSweepReport } from '../../scripts/mobile-sweep-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, '..', '..');
const args = process.argv.slice(2);
const opt = (n) => { const i = args.indexOf(`--${n}`); return i >= 0 ? args[i + 1] : args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3); };
const git = (...a) => spawnSync('git', a, { cwd: FRONTEND, encoding: 'utf8' });

const base = process.env.MOBILE_SWEEP_REPORT_DIR ? path.resolve(process.env.MOBILE_SWEEP_REPORT_DIR) : path.join(FRONTEND, 'e2e', 'test-results-mobile', 'sweep');
const file = opt('report') ?? path.join(base, 'latest.json');
let report = null;
try { report = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { /* reported below */ }

let sha = opt('sha');
if (!sha) {
  git('fetch', 'origin', 'staging');
  sha = git('rev-parse', 'origin/staging').stdout.trim();
}
const swept = report?.meta?.commit;
const reportContainsSha = swept && sha ? git('merge-base', '--is-ancestor', sha, swept).status === 0 : false;

const verdict = checkSweepReport(report, { sha, reportContainsSha, maxAgeHours: Number(opt('max-age-hours') ?? 72) });
console.log(`[sweep-check] report: ${file}`);
console.log(`[sweep-check] promoting: ${sha || '(unknown)'}${swept ? `   swept: ${swept}` : ''}`);
if (verdict.ok) {
  console.log('[sweep-check] OK: a passing full sweep covers this commit. Quote the report path and its first lines in the promotion PR.');
  process.exit(0);
}
for (const p of verdict.problems) console.log(`[sweep-check] - ${p}`);
console.log('[sweep-check] NOT OK: do not promote to main until `npm run test:mobile:sweep` passes on this commit.');
process.exit(1);
