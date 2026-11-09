/**
 * Guards of the Database check (spec #3234, "Testing Decisions"). They pin behaviour, not workflow text:
 *
 *  - the command's file list holds every real-database test file, once, and each of them is a file the test tool collects;
 *  - every test file that reads the test database setting is in that list (or is one of the three RLS files, which are in it);
 *  - the eight integration suites that never run in CI (#3232) are listed, and the list can only shrink;
 *  - the Database job runs the command and nothing else: no shared-server port, no lock path, no role drop, an always-run stop,
 *    no step that can skip a core check, the required name unchanged;
 *  - the Pick runners job sends the Database job to the reserved runner when it is online, else the general Mac runners, else a
 *    hosted Linux machine (run for real, with the runner list stubbed).
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { expectedFiles } from '../ci-db/decisions';
import { npmBin, trackedFiles } from '../ci-db/files';
import { importsOf, readsOf } from '../ci-db/reach';

const BACKEND = path.resolve(__dirname, '../..');
const CI_FILE = path.resolve(BACKEND, '../.github/workflows/ci.yml');
const CI = readFileSync(CI_FILE, 'utf8');
// js-yaml ships no types of its own; only `load` is used.
const { load } = require('js-yaml') as { load(text: string): unknown };

type Step = { name?: string; run?: string; if?: string | boolean; uses?: string; with?: Record<string, unknown>; 'working-directory'?: string; 'timeout-minutes'?: unknown; env?: Record<string, string> };
type Job = { name?: string; if?: string; 'runs-on'?: string; 'timeout-minutes'?: unknown; needs?: string; outputs?: Record<string, string>; env?: Record<string, string>; steps?: Step[] };
const workflow = load(CI) as { jobs: Record<string, Job> };

// The one condition under which a push to main skips the heavy steps (#3240), as the issue words it: the tree is the tested tree.
const TREE_SKIP_OFF = "needs.pick-runners.outputs.tree_skip != 'true'";

const tracked = trackedFiles(BACKEND);
const expected = expectedFiles(tracked);

describe('the Database command runs every real-database test file (guard)', () => {
  it('has a list of a sensible size, and fails when the list cannot be produced', () => {
    expect(expected.all.length).toBeGreaterThanOrEqual(380);
    expect(() => expectedFiles([])).toThrow(/could not be produced/);
  });

  it('holds every tracked real-database file, the three RLS files and the numbering suite, each once', () => {
    for (const f of tracked.filter((t) => t.endsWith('-db.test.ts'))) expect(expected.all, f).toContain(f);
    for (const f of ['rls-isolation', 'login-lockout-rls', 'rls-coverage']) expect(expected.all).toContain(`src/__tests__/${f}.test.ts`);
    expect(expected.all).toContain('src/__tests__/numbering.integration.test.ts');
    expect(new Set(expected.all).size).toBe(expected.all.length);
    const parts = [...expected.core.map((c) => c.file), ...expected.lanes, ...expected.after.map((a) => a.file)];
    expect([...parts].sort()).toEqual([...expected.all].sort());
  });

  it('lists only files that the test tool collects (its include patterns match every one of them)', () => {
    const r = spawnSync(npmBin(BACKEND, 'vitest'), ['list', '--filesOnly'], { cwd: BACKEND, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    expect(r.status, r.stderr).toBe(0);
    const collected = new Set(r.stdout.split('\n').map((l) => l.trim()).filter((l) => l.endsWith('.test.ts')));
    expect(collected.size).toBeGreaterThan(1000);
    const notCollected = expected.all.filter((f) => !collected.has(f));
    expect(notCollected, 'listed by the command but never collected by the test tool, so it could not run').toEqual([]);
  }, 60_000);

  it('names every test file that reads the test database setting', () => {
    const readers = tracked.filter((f) => f.endsWith('.test.ts')).filter((f) => /process\.env(\.TEST_DATABASE_URL|\[['"]TEST_DATABASE_URL['"]\])/.test(readFileSync(path.join(BACKEND, f), 'utf8')));
    expect(readers.length).toBeGreaterThan(300);
    const missing = readers.filter((f) => !expected.all.includes(f));
    expect(missing, 'reads TEST_DATABASE_URL but the command does not run it: name the file *-db.test.ts').toEqual([]);
  });

  it('puts every authorization-suite and permission real-database file in the list', () => {
    const permission = tracked.filter((f) => /(^|\/)permission-[^/]*-db\.test\.ts$/.test(f));
    expect(permission.length).toBeGreaterThan(50);
    for (const f of permission) expect(expected.all, f).toContain(f);
  });
});

/**
 * The premise of the Database check's path-skip rule (#3238, scripts/ci-db/skip.ts): a pull request that changes only the frontend, the
 * docs folders, the agent-tooling folder or root-level Markdown cannot change what a real-database suite sees. That holds while no suite,
 * and no file one imports, reads a path above the backend folder. The reading of source text is tried on planted source in
 * scripts/ci-db/__tests__/reach.test.ts.
 */
describe('the real-database suites read nothing above the backend folder (premise of the path-skip rule)', () => {
  const MODULE_ENDINGS = ['', '.ts', '.tsx', '.js', '.cjs', '.mjs', '/index.ts', '/index.js'];
  const isFile = (p: string) => existsSync(p) && statSync(p).isFile();
  const resolveModule = (from: string, spec: string): string | undefined => {
    const base = spec.startsWith('@/') ? path.join(BACKEND, 'src', spec.slice(2)) : path.resolve(path.dirname(path.join(BACKEND, from)), spec);
    const stem = base.replace(/\.js$/, '');
    for (const candidate of [base, stem]) for (const ending of MODULE_ENDINGS) if (isFile(candidate + ending) && /\.(ts|tsx|js|cjs|mjs)$/.test(candidate + ending)) return path.relative(BACKEND, candidate + ending).split(path.sep).join('/');
    return undefined;
  };

  /** Every suite, every file it imports (and so on), and every source file or script a suite builds the path of. */
  function closure(): { files: Map<string, string>; above: string[] } {
    const files = new Map<string, string>();
    const above: string[] = [];
    const queue = [...expected.all];
    while (queue.length > 0) {
      const f = queue.pop()!;
      if (files.has(f)) continue;
      const source = readFileSync(path.join(BACKEND, f), 'utf8');
      files.set(f, source);
      const reads = readsOf(source, path.posix.dirname(f));
      for (const a of reads.above) above.push(`${f}: ${a}`);
      for (const spec of importsOf(source)) { const r = resolveModule(f, spec); if (r && !r.startsWith('node_modules/')) queue.push(r); }
      for (const p of reads.inside) if (/\.(ts|tsx|js|cjs|mjs)$/.test(p) && isFile(path.join(BACKEND, p)) && !p.startsWith('node_modules/')) queue.push(p);
    }
    return { files, above };
  }
  const reach = closure();

  it('looked at every suite and at what they import (a scan that found nothing to read would pass for nothing)', () => {
    expect(reach.files.size).toBeGreaterThan(expected.all.length);
    for (const f of expected.all) expect(reach.files.has(f), f).toBe(true);
    expect(reach.files.size).toBeGreaterThan(600);
    // A helper two steps away is in it.
    expect([...reach.files.keys()].some((f) => f.startsWith('src/lib/'))).toBe(true);
  });

  it('no real-database suite, and no helper one imports, reads a path above the backend folder', () => {
    expect(reach.above, 'a suite that reads outside the backend folder means a pull request that changes only that folder must run the lanes: change the skip list in scripts/ci-db/skip.ts, or the suite').toEqual([]);
  });
});

/**
 * The real-database suites that CI does not run (#3232): they read DATABASE_URL behind RUN_INTEGRATION_TESTS, which only the
 * numbering suite gets from the command. This list can only shrink: a suite moved into the command comes off it, and a new
 * integration suite that is not on it fails here until it is run (or, knowingly, listed in #3232).
 */
const NEVER_RUN_IN_CI = [
  'scripts/__tests__/text-company-number-migration.integration.test.ts',
  'src/__tests__/customer-create.integration.test.ts',
  'src/__tests__/lead-status-options.integration.test.ts',
  'src/__tests__/lead-status-walkthrough-backfill.integration.test.ts',
  'src/__tests__/lead-walkthrough-status.integration.test.ts',
  'src/__tests__/number-collision-retry.integration.test.ts',
  'src/__tests__/org-settings.integration.test.ts',
  'src/lib/query/__tests__/filterEngine.count.integration.test.ts',
];

describe('the integration suites that never run in CI (#3232)', () => {
  const integration = tracked.filter((f) => f.endsWith('.test.ts')).filter((f) => /process\.env(\.RUN_INTEGRATION_TESTS|\[['"]RUN_INTEGRATION_TESTS['"]\])/.test(readFileSync(path.join(BACKEND, f), 'utf8')));

  it('are exactly the eight listed, plus the numbering suite which the command runs', () => {
    expect([...integration].sort()).toEqual([...NEVER_RUN_IN_CI, 'src/__tests__/numbering.integration.test.ts'].sort());
  });

  it('are not in the command\'s list: one that is comes off this list', () => {
    for (const f of NEVER_RUN_IN_CI) expect(expected.all, f).not.toContain(f);
  });
});

// ---- the workflow ------------------------------------------------------------------------------------------------------------------

const database = workflow.jobs.database!;
const steps = database.steps ?? [];
const databaseText = JSON.stringify(database);

describe('ci.yml: the Database job runs the command (guard)', () => {
  it('keeps the required check names exactly', () => {
    const names = Object.values(workflow.jobs).map((j) => j.name);
    for (const required of [
      'Frontend (lint + type-check + tests + build)', 'Backend (build + tests)', 'Database (migrations + RLS)',
      'Secret scan (gitleaks)', 'Workflow lint (actionlint)', 'Pick runners',
    ]) expect(names, required).toContain(required);
  });

  it('is checkout, Node, install, build, the command, and an always-run stop (plus the notice and the record of #3240)', () => {
    expect(steps.map((s) => s.uses ?? (s.run?.startsWith('npm') ? s.run : s.name))).toEqual([
      'Identical tree already tested',
      'actions/checkout@v7', 'actions/setup-node@v7', 'npm ci', 'npm run build', 'npm run test:db',
      'Read the tested tree', 'Tested tree ${{ steps.tree.outputs.tree }} full', 'npm run test:db:stop',
    ]);
    const stop = steps.at(-1)!;
    const command = steps.find((s) => s.run === 'npm run test:db')!;
    expect(command['working-directory']).toBe('backend');
    expect(stop['working-directory']).toBe('backend');
    // Still always-run: the only addition is the one condition of #3240 (nothing was started, so nothing is stopped).
    expect(stop.if).toBe(`\${{ always() && ${TREE_SKIP_OFF} }}`);
  });

  it('checks out two commits (the merge commit and its first parent) for the path-skip rule, and no more', () => {
    const checkout = steps.find((s) => s.uses === 'actions/checkout@v7')!;
    expect(checkout.with?.['fetch-depth']).toBe(2);
  });

  // The workflow can skip these steps in ONE case only (#3240): a push to main whose tree the merged pull request's run already tested
  // (the rule and its table are in scripts/ci-main-skip/lib.test.mjs). Every other condition on this job is the record of that rule.
  it('has one condition on the command, the push-to-main rule of #3240, so no core check is skipped by anything else', () => {
    const command = steps.find((s) => s.run === 'npm run test:db')!;
    expect(command.if).toBe(`\${{ ${TREE_SKIP_OFF} }}`);
    const conditioned = steps.filter((s) => s.if !== undefined).map((s) => s.name ?? s.uses);
    expect(conditioned).toEqual(steps.map((s) => s.name ?? s.uses));
    for (const s of steps.filter((x) => !['Read the tested tree', 'Stop the private database server'].includes(x.name ?? '') && !(x.name ?? '').startsWith('Tested tree '))) {
      expect(s.if, s.name ?? s.uses).toBe(s.name === 'Identical tree already tested' ? `\${{ needs.pick-runners.outputs.tree_skip == 'true' }}` : `\${{ ${TREE_SKIP_OFF} }}`);
    }
  });

  it('touches no shared server, lock, container or role drop, and has no step time limits', () => {
    for (const forbidden of [/\b5432\b/, /\b5433\b/, /\b3111\b/, /ci-native-pg/, /\.lock\b/, /DROP ROLE/i, /dropdb/, /docker/i, /postgres:16/, /ci-db-suites/, /DB_SUITES_SKIP/, /PG_URL/]) {
      expect(databaseText, String(forbidden)).not.toMatch(forbidden);
    }
    for (const s of steps) expect(s['timeout-minutes'], s.name).toBeUndefined();
    expect(typeof database['timeout-minutes']).toBe('string');
  });

  it('sends the job to the label the Pick runners job chose, the reserved runner by default', () => {
    expect(database['runs-on']).toContain("needs.pick-runners.outputs.database || '[\"database\"]'");
    expect(database.env?.DB_LANES).toContain('needs.pick-runners.outputs.database_lanes');
  });

  it('retires the old sharding: the dealing script, its skip list and the lock', () => {
    expect(existsSync(path.join(BACKEND, 'scripts/ci-db-suites.sh'))).toBe(false);
    expect(CI).not.toMatch(/ci-db-suites|DB_SUITES_SKIP|ci-native-pg-database\.lock/);
  });
});

// ---- Pick runners, run for real with the runner list stubbed -----------------------------------------------------------------------

// The step runs on a GitHub-hosted Linux machine (the Pick runners job's runs-on), which has bash and jq. The test owns everything
// else the step reads: its environment is exactly the variables below (nothing inherited from the runner but PATH), and the
// runner-list request is a shell function defined ahead of the step, so the stub runs without executing a file from the temp
// directory (a temp directory mounted without exec rights used to turn every case into "the list request failed").
const hasJq = spawnSync('bash', ['-c', 'command -v jq'], { encoding: 'utf8' }).status === 0;

describe('ci.yml: Pick runners sends the Database job to the reserved runner, else the Mac runners, else a hosted Linux machine', () => {
  const pick = workflow.jobs['pick-runners']!.steps![0]!.run!;

  it('runs on a hosted Linux machine, where the jq the step reads the runner list with is installed', () => {
    expect(workflow.jobs['pick-runners']!['runs-on']).toBe('ubuntu-latest');
    expect(pick).toMatch(/\bjq\b/);
  });

  function runPick(o: { runners?: { name: string; status: string; labels: string[] }[]; mode?: string; token?: string; curlFails?: boolean }) {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'pick-runners-'));
    try {
      const body = JSON.stringify({ runners: (o.runners ?? []).map((r) => ({ name: r.name, status: r.status, labels: r.labels.map((name) => ({ name })) })) });
      const curl = o.curlFails ? 'curl() { return 22; }\n' : `curl() {\ncat <<'EOF'\n${body}\nEOF\n}\n`;
      const output = path.join(dir, 'output');
      writeFileSync(output, '');
      writeFileSync(path.join(dir, 'summary'), '');
      const r = spawnSync('bash', ['-c', curl + pick.replace(/\$\{\{[^}]*\}\}/g, '')], {
        encoding: 'utf8',
        env: {
          PATH: process.env.PATH, GH_TOKEN: o.token ?? 'fake', MODE: o.mode ?? '',
          GITHUB_OUTPUT: output, GITHUB_STEP_SUMMARY: path.join(dir, 'summary'), GITHUB_API_URL: 'https://api.invalid', GITHUB_REPOSITORY: 'org/repo',
        },
      });
      expect(r.status, r.stderr).toBe(0);
      return Object.fromEntries(readFileSync(output, 'utf8').split('\n').filter(Boolean).map((l) => [l.slice(0, l.indexOf('=')), l.slice(l.indexOf('=') + 1)])) as Record<string, string>;
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }

  const reserved = { name: 'r1', status: 'online', labels: ['database'] };
  const mac = { name: 'm1', status: 'online', labels: ['self-hosted', 'macOS', 'ARM64'] };
  const linux = { name: 'l1', status: 'online', labels: ['self-hosted', 'Linux'] };

  // The cases that reach the runner list read it with jq. A machine without jq cannot run them faithfully (the step would take its
  // fail-safe and every case would read "hosted"), so they are skipped there, under a title that says why, rather than failing.
  describe.runIf(hasJq)(hasJq ? 'reading the runner list' : 'reading the runner list (skipped: no jq on this machine)', () => {
    it('reserved runner online: the Database job goes there, with six lanes, whatever else is online', () => {
      const out = runPick({ runners: [reserved, mac, linux] });
      expect(out.database).toBe('["database"]');
      expect(out.database_lanes).toBe('6');
      expect(out.mac).toBe('["self-hosted","macOS"]');
    });

    it('reserved runner offline, general Mac runners online: the Database job goes to them, with no lane setting', () => {
      const out = runPick({ runners: [{ ...reserved, status: 'offline' }, mac, linux] });
      expect(out.database).toBe('["self-hosted","macOS"]');
      expect(out.database_lanes).toBe('');
    });

    it('only the reserved runner online: still there (the general Mac runners being offline changes nothing for it)', () => {
      const out = runPick({ runners: [reserved] });
      expect(out.database).toBe('["database"]');
      expect(out.mac).toBe('"ubuntu-latest"');
    });

    it('no Mac runner at all: a hosted Linux machine, never a hosted macOS one', () => {
      const out = runPick({ runners: [{ ...reserved, status: 'offline' }, linux] });
      expect(out.database).toBe('"ubuntu-latest"');
      expect(out.database_lanes).toBe('');
      expect(JSON.stringify(out)).not.toMatch(/macos-/i);
    });
  });

  it('cannot tell (no token, or the list request fails): hosted, so the job never hangs on an unseen runner', () => {
    expect(runPick({ token: '' }).database).toBe('"ubuntu-latest"');
    expect(runPick({ curlFails: true }).database).toBe('"ubuntu-latest"');
  });

  it('CI_RUNNERS overrides it: hosted forces hosted Linux; self-hosted forces the old (general Mac) labels', () => {
    expect(runPick({ runners: [reserved, mac], mode: 'hosted' }).database).toBe('"ubuntu-latest"');
    const forced = runPick({ runners: [], mode: 'self-hosted' });
    expect(forced.database).toBe('["self-hosted","macOS"]');
    expect(forced.database_lanes).toBe('');
  });

  it('gives the job a longer limit on a hosted machine and shorter on the Mac, from the same output', () => {
    expect(String(database['timeout-minutes'])).toContain("needs.pick-runners.outputs.database == '\"ubuntu-latest\"' && 60 || 25");
  });

  // ---- The Frontend job: same pick, its own reserved label (`frontend`, and no other) ----
  describe('the Frontend job (reserved runner, else the Mac runners, else hosted)', () => {
    const frontendRunner = { name: 'f1', status: 'online', labels: ['frontend'] };
    const frontendJob = workflow.jobs.frontend!;

    it('Pick runners declares a frontend output, and the Frontend job reads it with the reserved label as the last-resort literal', () => {
      expect(workflow.jobs['pick-runners']!.outputs!.frontend).toBe('${{ steps.pick.outputs.frontend }}');
      expect(frontendJob['runs-on']).toBe("${{ fromJSON(needs.pick-runners.outputs.frontend || '[\"frontend\"]') }}");
      expect(frontendJob.name).toBe('Frontend (lint + type-check + tests + build)');
    });

    it('the reserved label is exactly `frontend`, and the hosted shards still follow the Mac output (routing unchanged)', () => {
      expect(pick).toContain(`reserved_frontend='["frontend"]'`);
      expect(String(workflow.jobs['frontend-tests']!['runs-on'])).toBe('ubuntu-latest');
      expect(String(workflow.jobs['frontend-tests']!.if)).toContain(`needs.pick-runners.outputs.mac == '"ubuntu-latest"'`);
    });

    it('its time limit follows the frontend output, so a reserved runner with no Mac runners online still gets the self-hosted limit', () => {
      expect(String(frontendJob['timeout-minutes'])).toBe("${{ needs.pick-runners.outputs.frontend == '\"ubuntu-latest\"' && 30 || 45 }}");
    });

    describe.runIf(hasJq)(hasJq ? 'reading the runner list' : 'reading the runner list (skipped: no jq on this machine)', () => {
      it('reserved runner online: the Frontend job goes there, whatever else is online', () => {
        expect(runPick({ runners: [frontendRunner, mac, linux, reserved] }).frontend).toBe('["frontend"]');
      });
      it('reserved runner offline, Mac runners online: the Mac runners', () => {
        expect(runPick({ runners: [{ ...frontendRunner, status: 'offline' }, mac, linux] }).frontend).toBe('["self-hosted","macOS"]');
      });
      it('only the reserved runner online: still there, and the Mac output goes hosted', () => {
        const out = runPick({ runners: [frontendRunner] });
        expect(out.frontend).toBe('["frontend"]');
        expect(out.mac).toBe('"ubuntu-latest"');
      });
      it('no Mac runner and no reserved runner: a hosted Linux machine, never a hosted macOS one', () => {
        const out = runPick({ runners: [{ ...frontendRunner, status: 'offline' }, linux] });
        expect(out.frontend).toBe('"ubuntu-latest"');
        expect(JSON.stringify(out)).not.toMatch(/macos-/i);
      });
      it('the Database runner does not stand in for the Frontend runner, nor the other way round', () => {
        expect(runPick({ runners: [reserved] }).frontend).toBe('"ubuntu-latest"');
        expect(runPick({ runners: [frontendRunner] }).database).toBe('"ubuntu-latest"');
      });
    });

    it('cannot tell: hosted. CI_RUNNERS: hosted forces hosted, self-hosted forces the Mac labels', () => {
      expect(runPick({ token: '' }).frontend).toBe('"ubuntu-latest"');
      expect(runPick({ curlFails: true }).frontend).toBe('"ubuntu-latest"');
      expect(runPick({ runners: [frontendRunner, mac], mode: 'hosted' }).frontend).toBe('"ubuntu-latest"');
      expect(runPick({ runners: [], mode: 'self-hosted' }).frontend).toBe('["self-hosted","macOS"]');
    });
  });
});
