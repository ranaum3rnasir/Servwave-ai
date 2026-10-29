#!/usr/bin/env node
/**
 * The full mobile sweep, run locally before each promotion to main (mobile slice 62).
 *
 *   npm run test:mobile:sweep                    # from frontend/
 *   npm run test:mobile:lighthouse               # only the Lighthouse budget (no report)
 *
 * One command: build the production bundle, then one Playwright run that provisions one throwaway
 * org on the staging database and runs, in it, (1) every key route and overlay on the six gate
 * devices, with all their targeted specs, (2) the same routes plus the audit's unswept routes on
 * the rest of the device matrix (iPhone 17 Pro Max, Pixel 7, iPhone SE landscape, Pixel 7
 * landscape, Fold cover and unfolded, iPad Mini landscape, Galaxy Tab S9 at exactly sm, Firefox),
 * (3) the technician job-completion flow, (4) the Lighthouse mobile budget on the public pages and
 * the technician landing page, and (5) the self-tests that show each check and the budget can go red.
 * It then writes ONE report, and the exit code is 1 unless that report passed.
 *
 * Where the report is kept: e2e/test-results-mobile/sweep/<UTC time>-<commit>/report.{md,json},
 * and the newest is copied to sweep/latest.{md,json}. Override the base with MOBILE_SWEEP_REPORT_DIR.
 * The promotion check (`npm run test:mobile:sweep:check`) reads latest.json. Not in CI.
 *
 * A run cut short (the runner killed, no summary) still gets a FAIL report; the org it left on the
 * staging database is torn down here, or named in the report for `npm run test:mobile:teardown`.
 *
 * Needs, once per machine/worktree: `npm ci` at the repo root, `npx prisma generate` in backend/,
 * backend/.env and frontend/.env copied in, and `npx playwright install` (firefox included).
 */
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { buildSweepReport, renderSweepMarkdown } from '../../scripts/mobile-sweep-lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const FRONTEND = path.resolve(HERE, '..', '..');
const E2E = path.resolve(FRONTEND, 'e2e');
const RESULTS = path.join(E2E, 'test-results-mobile');
const CONFIG = 'e2e/playwright.mobile.config.ts';
const ORG_FILE = path.join(E2E, '.auth', 'e2e-org.json'); // the throwaway org of a run that has not torn it down

const args = process.argv.slice(2);
const flag = (n) => args.includes(`--${n}`);
const opt = (n) => args.find((a) => a.startsWith(`--${n}=`))?.slice(n.length + 3);
const lighthouseOnly = flag('lighthouse-only');
const partial = !!(opt('routes') || opt('projects') || flag('skip-build') || process.env.MOBILE_GATE_ROUTES);

const run = (cmd, a, o = {}) => spawnSync(cmd, a, { cwd: FRONTEND, stdio: 'inherit', ...o });
const out = (cmd, a) => {
  const r = spawnSync(cmd, a, { cwd: FRONTEND, encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() : '';
};
const fail = (msg) => { console.error(`\n[sweep] ${msg}`); process.exit(1); };

// ── preflight ────────────────────────────────────────────────────────────────────────────────────
for (const f of ['backend/.env', 'frontend/.env']) {
  if (!fs.existsSync(path.resolve(FRONTEND, '..', f))) fail(`${f} is missing: copy it from the main checkout (it is not committed).`);
}
if (!lighthouseOnly) {
  for (const b of ['firefox', 'webkit', 'chromium']) {
    const probe = spawnSync('node', ['-e', `const p=require('@playwright/test').${b}.executablePath();process.exit(require('fs').existsSync(p)?0:1)`], { cwd: FRONTEND });
    if (probe.status !== 0) fail(`the ${b} browser is not installed: run \`npx playwright install ${b}\` in frontend/.`);
  }
}

// A sweep of ~2,900 tests across nine browsers writes browser profiles, dev-server caches and a
// record per test. A full disk ended one mid-run with no summary and no report, so refuse to start
// without room, and say how much was needed.
const MIN_FREE_GB = Number(process.env.MOBILE_SWEEP_MIN_FREE_GB || 3);
try {
  const st = fs.statfsSync(FRONTEND);
  const freeGb = (st.bavail * st.bsize) / 1024 ** 3;
  if (freeGb < MIN_FREE_GB) fail(`only ${freeGb.toFixed(1)} GB free on this disk; the sweep needs at least ${MIN_FREE_GB} GB (set MOBILE_SWEEP_MIN_FREE_GB to change it). A full disk ends the run with no report.`);
} catch (err) {
  console.log(`[sweep] could not read the free disk space (${String(err)}); continuing.`);
}

const startedAt = new Date().toISOString();
const commit = out('git', ['rev-parse', 'HEAD']);
const branch = out('git', ['rev-parse', '--abbrev-ref', 'HEAD']);
out('git', ['fetch', 'origin', 'staging']);
const stagingSha = out('git', ['rev-parse', 'origin/staging']);
// Tracked changes only: a sweep of an edited tree does not describe a commit. Untracked files
// (a developer's scratch notes) cannot change what the build contains.
const dirty = out('git', ['status', '--porcelain', '--untracked-files=no']).length > 0;
if (commit !== stagingSha) console.log(`[sweep] note: HEAD ${commit.slice(0, 9)} is not origin/staging ${stagingSha.slice(0, 9)}. The promotion check wants the report to cover the commit being promoted.`);

// ── 1. the production build the Lighthouse run measures ──────────────────────────────────────────
let buildOk = true;
if (!flag('skip-build')) {
  console.log('[sweep] building the production bundle (vite build) ...');
  buildOk = run('npx', ['vite', 'build'], { env: { ...process.env, VITE_DASHBOARD_USE_MOCK: 'false' } }).status === 0 && run('node', ['scripts/check-public-bundle-budget.mjs']).status === 0;
  if (!buildOk && !lighthouseOnly) console.error('[sweep] the production build (or its public-bundle budget) failed; Lighthouse cannot run.');
}
if (!buildOk && lighthouseOnly) process.exit(1);

// ── 2. the run ───────────────────────────────────────────────────────────────────────────────────
fs.rmSync(path.join(RESULTS, 'sweep-playwright.json'), { force: true });
fs.rmSync(path.join(RESULTS, 'sweep-plan.json'), { force: true });
fs.rmSync(path.join(RESULTS, 'lighthouse'), { recursive: true, force: true });
const env = { ...process.env, MOBILE_GATE_WORKERS: process.env.MOBILE_GATE_WORKERS || '4' };
let pwArgs;
if (lighthouseOnly) {
  env.MOBILE_GATE_LIGHTHOUSE = '1';
  pwArgs = ['playwright', 'test', `--config=${CONFIG}`, '--project=lighthouse', '--project=selftest-lighthouse'];
} else {
  env.MOBILE_GATE_SWEEP = '1';
  pwArgs = ['playwright', 'test', `--config=${CONFIG}`];
  if (opt('projects')) for (const p of opt('projects').split(',')) pwArgs.push(`--project=${p}`);
}
if (opt('routes')) env.MOBILE_GATE_ROUTES = opt('routes');
const command = `npx ${pwArgs.join(' ')}${env.MOBILE_GATE_ROUTES ? ` (MOBILE_GATE_ROUTES=${env.MOBILE_GATE_ROUTES})` : ''}`;
console.log(`[sweep] ${command}`);
const t0 = Date.now();
const pw = run('npx', pwArgs, { env });
const exitCode = pw.status ?? 1;
// A Playwright process killed from outside (an out-of-memory kill, a closed laptop) never runs its
// global teardown: the org it provisioned is still recorded in e2e-org.json. Try the teardown here,
// and record what is left in the report.
if (fs.existsSync(ORG_FILE) && process.env.MOBILE_GATE_KEEP_ORG !== '1') {
  console.log('[sweep] the run left its throwaway org recorded (its teardown did not finish): tearing it down ...');
  run('npm', ['run', 'test:mobile:teardown']);
}
let leftoverOrg = null;
if (fs.existsSync(ORG_FILE) && process.env.MOBILE_GATE_KEEP_ORG !== '1') {
  try { leftoverOrg = JSON.parse(fs.readFileSync(ORG_FILE, 'utf8')).organizationId ?? 'unknown'; } catch { leftoverOrg = 'unknown'; }
}
if (lighthouseOnly) process.exit(exitCode);

// ── 3. the report ────────────────────────────────────────────────────────────────────────────────
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
const plan = readJson(path.join(RESULTS, 'sweep-plan.json')) ?? { devices: [], states: [] };
const playwright = readJson(path.join(RESULTS, 'sweep-playwright.json'));
const lighthouse = [];
const lhDir = path.join(RESULTS, 'lighthouse');
if (fs.existsSync(lhDir)) for (const f of fs.readdirSync(lhDir).sort()) lighthouse.push(readJson(path.join(lhDir, f)));

let reportPairs = 0;
const recordsDir = path.join(RESULTS, 'records');
if (fs.existsSync(recordsDir)) {
  for (const d of fs.readdirSync(recordsDir)) {
    for (const f of fs.readdirSync(path.join(recordsDir, d))) {
      const rec = readJson(path.join(recordsDir, d, f));
      for (const v of Object.values(rec?.verdicts ?? {})) if (v?.status === 'allowed') reportPairs += 1;
    }
  }
}

const report = buildSweepReport({
  meta: {
    startedAt,
    finishedAt: new Date().toISOString(),
    commit,
    stagingSha,
    branch,
    dirty,
    partial,
    command,
    exitCode,
    signal: pw.signal ?? null,
    leftoverOrg,
    node: process.version,
  },
  playwright,
  knownFailing: readJson(path.join(HERE, 'known-failing.json'))?.entries ?? [],
  devices: plan.devices,
  expectedStates: plan.states,
  lighthouse: lighthouse.filter(Boolean),
  records: { reportPairs },
  build: { ok: buildOk },
});

const base = process.env.MOBILE_SWEEP_REPORT_DIR ? path.resolve(process.env.MOBILE_SWEEP_REPORT_DIR) : path.join(RESULTS, 'sweep');
const stamp = report.meta.finishedAt.replace(/[-:]/g, '').replace(/\..*/, 'Z');
const dir = path.join(base, `${stamp}-${commit.slice(0, 9)}`);
fs.mkdirSync(dir, { recursive: true });
const md = renderSweepMarkdown(report);
fs.writeFileSync(path.join(dir, 'report.json'), JSON.stringify(report, null, 1));
fs.writeFileSync(path.join(dir, 'report.md'), md);
fs.writeFileSync(path.join(base, 'latest.json'), JSON.stringify(report, null, 1));
fs.writeFileSync(path.join(base, 'latest.md'), md);

const mins = Math.round((Date.now() - t0) / 60000);
console.log(`\n[sweep] ${report.overall.toUpperCase()} in ${mins} min. Report: ${path.join(dir, 'report.md')}`);
for (const p of report.problems) console.log(`[sweep]   - ${p}`);
process.exit(report.overall === 'pass' ? 0 : 1);
