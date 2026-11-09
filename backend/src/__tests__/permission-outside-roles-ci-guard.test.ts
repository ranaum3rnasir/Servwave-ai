/* =============================================================================
   Roles & Permissions security, ticket 37 (spec story 66): CI's database is made with the two outside roles before the
   migrations run, so the migrations meet them as they would on the hosted database and the open-table checks
   (permission-outside-roles-db.test.ts, rls-coverage.test.ts) run against real roles.

   Pure: reads ci.yml, the role script and the Database command's order of checks. A command that stops creating the roles, or
   creates them after the migrations, fails here. The roles live on the run's own private server, which is deleted with them: no
   step drops them, and a workflow that tried to would fail here.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { spawnSync } from 'child_process';
import { dbCommandList } from './support/db-command-list';

// js-yaml ships no types of its own; only `load` is used.
const { load } = require('js-yaml') as { load(text: string): unknown };

const BACKEND = join(__dirname, '..', '..');
const CI = readFileSync(join(BACKEND, '..', '.github', 'workflows', 'ci.yml'), 'utf8');
const SQL = readFileSync(join(BACKEND, 'scripts', 'ci-outside-roles.sql'), 'utf8');

type Step = { name?: string; run?: string; shell?: string; if?: string | boolean; with?: Record<string, unknown> };
type Job = { if?: string | boolean; steps?: Step[] };
type Workflow = { on?: unknown; jobs: Record<string, Job> };

/** Every `run:` block of ci.yml, read by a YAML parser, as `job › step` and the script the runner gets. */
function runBlocks(): { where: string; script: string }[] {
  const wf = load(CI) as Workflow;
  return Object.entries(wf.jobs).flatMap(([job, j]) => (j.steps ?? [])
    .filter((st) => typeof st.run === 'string' && (st.shell === undefined || st.shell === 'bash'))
    // GitHub fills in each ${{ ... }} before the shell sees the script, so a placeholder stands in for it.
    .map((st) => ({ where: `${job} › ${st.name ?? '(unnamed)'}`, script: st.run!.replace(/\$\{\{[^}]*\}\}/g, 'GHA_EXPR') })));
}

/** Whether bash can parse the script (`bash -n`), and what it said if not. */
function bashParses(script: string): { ok: boolean; error: string } {
  const r = spawnSync('bash', ['-n'], { input: script, encoding: 'utf8' });
  return { ok: r.status === 0, error: (r.stderr ?? '').trim() };
}

describe('CI makes its database with the outside roles (guard)', () => {
  it('creates both roles, unable to sign in, idempotently', () => {
    for (const role of ['anon', 'authenticated']) {
      expect(SQL).toMatch(new RegExp(`IF NOT EXISTS \\(SELECT 1 FROM pg_roles WHERE rolname = '${role}'\\)`));
      expect(SQL).toMatch(new RegExp(`CREATE ROLE ${role} NOLOGIN;`));
    }
  });

  it('has the command create the roles first, before the migrations, with the script that is in the repository', () => {
    const order = dbCommandList().coreOrder;
    expect(order.slice(0, 2)).toEqual(['outside roles', 'migrations apply']);
    expect(SQL.length).toBeGreaterThan(100);
  });

  it('reads back, in the suites that run on every run, that the roles were there before the migrations (CI=true is supplied)', () => {
    const readback = readFileSync(join(BACKEND, 'src', '__tests__', 'permission-outside-roles-db.test.ts'), 'utf8');
    expect(readback).toContain("process.env.CI === 'true'");
    expect(dbCommandList().all).toContain('src/__tests__/permission-outside-roles-db.test.ts');
  });

  it('gives the database the stub auth helpers a guarded migration names once `authenticated` exists', () => {
    expect(SQL).toContain('CREATE SCHEMA IF NOT EXISTS auth;');
    for (const fn of ['uid', 'role', 'jwt']) expect(SQL).toContain(`IF to_regprocedure('auth.${fn}()') IS NULL THEN`);
  });

  it('has no step that drops the roles: the private server is deleted with them, and the shared one is never touched', () => {
    const wf = load(CI) as Workflow;
    const text = JSON.stringify(wf.jobs.database);
    expect(text).not.toMatch(/DROP ROLE|dropdb|\b5432\b/i);
    // Always runs; the one addition is the push-to-main rule of #3240 (nothing was started on a skipped push, so there is nothing to stop).
    expect(wf.jobs.database!.steps!.at(-1)!.if).toBe("${{ always() && needs.pick-runners.outputs.tree_skip != 'true' }}");
  });

  // Round 1 of the old job shipped a cleanup step with an unclosed quote: bash refused the whole script, so the cleanup never ran.
  // Every script CI runs must parse, the command step and the always-run stop above all.
  it('gives bash only scripts it can parse, the command step and the stop step included', () => {
    const blocks = runBlocks();
    expect(blocks.length).toBeGreaterThan(15);
    const names = blocks.map((b) => b.where);
    expect(names).toContain('database › Database check (private server, core checks, lanes, proof every file ran)');
    expect(names).toContain('database › Stop the private database server');
    const broken = blocks.map((b) => ({ ...b, ...bashParses(b.script) })).filter((b) => !b.ok).map((b) => `${b.where}: ${b.error}`);
    expect(broken).toEqual([]);
  });

  it('would catch a script with an unclosed quote', () => {
    expect(bashParses('echo "an unclosed quote\nrmdir /tmp/lock\n').ok).toBe(false);
    expect(bashParses('echo "a closed quote"\nrmdir /tmp/lock\n').ok).toBe(true);
  });
});

// CR-2: AL-14 made ci.yml run on every push to main. On a push GitHub leaves the pull-request context empty
// (`github.base_ref`, `github.head_ref`, `github.event.pull_request.*`), so a step that reads it ran `git fetch origin ""`
// and turned every push to main red. Any step that reads the pull-request context must be limited to pull requests.
const PULL_REQUEST_CONTEXT = /github\.(base_ref|head_ref|event\.pull_request|event\.number)/;
const ONLY_ON_PULL_REQUESTS = /github\.event_name\s*==\s*'pull_request'/;

/** Steps of a workflow that read the pull-request context but are not limited to pull requests. */
function unguardedPullRequestSteps(workflow: Workflow): string[] {
  return Object.entries(workflow.jobs).flatMap(([job, j]) => (j.steps ?? []).flatMap((st, i) => {
    const text = JSON.stringify({ run: st.run, with: st.with });
    if (!PULL_REQUEST_CONTEXT.test(text)) return [];
    const guard = `${typeof j.if === 'string' ? j.if : ''} ${typeof st.if === 'string' ? st.if : ''}`;
    return ONLY_ON_PULL_REQUESTS.test(guard) ? [] : [`${job} › ${st.name ?? `step ${i + 1}`}`];
  }));
}

describe('ci.yml reads the pull-request context only on pull requests (guard)', () => {
  it('limits every step that reads the base branch to pull requests, the changed-lines lint included', () => {
    const wf = load(CI) as Workflow;
    const names = Object.values(wf.jobs).flatMap((j) => (j.steps ?? []).filter((st) => PULL_REQUEST_CONTEXT.test(st.run ?? '')).map((st) => st.name));
    expect(names, 'the changed-lines lint should be the step that reads github.base_ref').toContain('Lint changed lines');
    expect(unguardedPullRequestSteps(wf)).toEqual([]);
  });

  it('would catch a step that reads github.base_ref with no pull-request condition', () => {
    const bare: Workflow = { jobs: { frontend: { steps: [{ name: 'Lint', run: 'git fetch origin "${{ github.base_ref }}"' }] } } };
    expect(unguardedPullRequestSteps(bare)).toEqual(['frontend › Lint']);
    const guarded: Workflow = { jobs: { frontend: { steps: [{ name: 'Lint', if: "github.event_name == 'pull_request'", run: 'git fetch origin "${{ github.base_ref }}"' }] } } };
    expect(unguardedPullRequestSteps(guarded)).toEqual([]);
    const jobGuarded: Workflow = { jobs: { frontend: { if: "github.event_name == 'pull_request'", steps: [{ name: 'Lint', run: 'echo ${{ github.head_ref }}' }] } } };
    expect(unguardedPullRequestSteps(jobGuarded)).toEqual([]);
  });
});
