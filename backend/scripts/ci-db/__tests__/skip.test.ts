/**
 * The path-skip rule of the Database check (spec #3234, "Path-based skips (fail-open)"; ticket #3238). The rule is a pure function
 * over the event name and the changed paths: skip the lanes only when every changed path is on the list of paths known to be
 * irrelevant, on a pull request. Any doubt runs everything. Fixture inputs in, answers out; nothing is started except, in the second
 * half, real git in a scratch folder (the merge commit against its first parent, rename detection off).
 */
import { afterAll, describe, it, expect } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MAX_CHANGED_PATHS, changedPaths, decideSkip, skipDecisionFor, type Git } from '../skip';

const pr = (paths: string[]) => decideSkip({ event: 'pull_request', changed: { ok: true, paths } });

describe('the path-skip rule: every listed kind of path skips', () => {
  it.each([
    ['a screen in the frontend folder', 'frontend/src/pages/Jobs.tsx'],
    ['a frontend test', 'frontend/src/__tests__/jobs.test.tsx'],
    ['a frontend config file', 'frontend/vite.config.ts'],
    ['a file in the docs folder', 'docs/ci.md'],
    ['a decision record', 'docs/adr/0001-something.md'],
    ['a file in the notes folder', 'md_files/issues/auth/01-show.md'],
    ['a file in the agent-tooling folder', '.claude/skills/api-patterns/SKILL.md'],
    ['a root-level Markdown file', 'README.md'],
    ['another root-level Markdown file', 'CLAUDE.md'],
  ])('%s', (_what, p) => {
    expect(pr([p])).toEqual({ skip: true, reason: 'all-paths-irrelevant' });
  });

  it('several of them together skip', () => {
    expect(pr(['frontend/src/a.tsx', 'docs/ci.md', 'README.md', '.claude/settings.json']).skip).toBe(true);
  });
});

describe('the path-skip rule: anything else runs everything', () => {
  it.each([
    ['a backend source file', 'backend/src/index.ts'],
    ['a backend test', 'backend/src/__tests__/jobs-db.test.ts'],
    ['a migration', 'backend/prisma/migrations/20261101000000_x/migration.sql'],
    ['the Database command itself', 'backend/scripts/ci-db/run.ts'],
    ['a workflow file', '.github/workflows/ci.yml'],
    ['another workflow file', '.github/workflows/dependencies.yml'],
    ['the root manifest', 'package.json'],
    ['the root lockfile', 'package-lock.json'],
    ['the frontend manifest', 'frontend/package.json'],
    ['the frontend lockfile', 'frontend/package-lock.json'],
    ['a manifest in a folder nobody thought of inside the frontend folder', 'frontend/e2e/package.json'],
    ['a manifest inside the docs folder', 'docs/package.json'],
    ['a yarn lockfile in the frontend folder', 'frontend/yarn.lock'],
    ['a package manager setting in the frontend folder', 'frontend/.npmrc'],
    ['an unknown top-level folder', 'tooling/build.sh'],
    ['a top-level folder named like a skipped one', 'docs-extra/readme.txt'],
    ['a top-level folder named like a skipped one with a prefix', 'frontend-old/src/a.ts'],
    ['a root-level file that is not Markdown', 'render.yaml'],
    ['a root-level script folder', 'scripts/deploy.sh'],
    ['a root-level Markdown file in upper case', 'README.MD'],
    ['a Markdown file inside an unknown folder', 'other/notes.md'],
    ['a file with the frontend folder as a suffix', 'backend/frontend/x.ts'],
    ['the frontend folder itself as a bare file name', 'frontend'],
    ['a docs folder as a bare file name', 'docs'],
  ])('%s: %s', (_what, p) => {
    const d = pr([p]);
    expect(d.skip).toBe(false);
    expect(d.reason).toBe(`relevant-path:${p}`);
  });

  it('one relevant path among many irrelevant ones runs everything and names the path', () => {
    const d = pr(['frontend/src/a.tsx', 'docs/ci.md', 'backend/src/lib/x.ts', 'README.md']);
    expect(d).toEqual({ skip: false, reason: 'relevant-path:backend/src/lib/x.ts' });
  });

  it.each([
    ['an empty path', ''],
    ['an absolute path', '/frontend/src/a.tsx'],
    ['a path that climbs out of the folder', 'frontend/../backend/src/index.ts'],
    ['a path that climbs out of the folder at the start', '../frontend/a.ts'],
    ['a path with a current-folder segment', 'frontend/./a.ts'],
    ['a path with an empty segment', 'frontend//a.ts'],
    ['a path with a trailing slash', 'frontend/'],
    ['a path with a backslash', 'frontend\\src\\a.tsx'],
    ['a path with a NUL', 'frontend/a\0b.ts'],
    ['a quoted path as git prints it without -z', '"frontend/caf\\303\\251.tsx"'],
  ])('a malformed path is unknown, so it runs: %s', (_what, p) => {
    expect(pr([p]).skip).toBe(false);
  });
});

describe('the path-skip rule: every doubt runs everything', () => {
  it('an empty diff runs', () => {
    expect(pr([])).toEqual({ skip: false, reason: 'no-changed-paths' });
  });

  it('an error reading the changed paths runs, and says why', () => {
    expect(decideSkip({ event: 'pull_request', changed: { ok: false, error: 'git diff exited 128' } })).toEqual({ skip: false, reason: 'changed-paths-unreadable: git diff exited 128' });
  });

  it('too many paths run (a list that long may be cut off)', () => {
    const many = Array.from({ length: MAX_CHANGED_PATHS + 1 }, (_, i) => `frontend/src/f${i}.tsx`);
    expect(pr(many)).toEqual({ skip: false, reason: 'too-many-paths' });
    expect(pr(many.slice(0, MAX_CHANGED_PATHS)).skip).toBe(true);
  });

  it.each([
    ['a push', 'push', 'push'],
    ['no event at all (a laptop, the agents\' runner)', undefined, '(none)'],
    ['an empty event name', '', '(none)'],
    ['a scheduled run', 'schedule', 'schedule'],
    ['a manual run', 'workflow_dispatch', 'workflow_dispatch'],
    ['a target-branch pull request event', 'pull_request_target', 'pull_request_target'],
    ['an event name in another case', 'Pull_Request', 'Pull_Request'],
  ])('%s runs, even when every path is irrelevant', (_what, event, shown) => {
    expect(decideSkip({ event, changed: { ok: true, paths: ['frontend/src/a.tsx', 'docs/ci.md'] } })).toEqual({ skip: false, reason: `not-a-pull-request: ${shown}` });
  });
});

// ---- the changed paths, from git ------------------------------------------------------------------------------------------------

const ok = (stdout: string) => ({ status: 0, stdout, stderr: '' });

/** A fake git that answers by the first words of the command. */
function fakeGit(answers: { parents?: string; diff?: ReturnType<typeof ok> | { status: number | null; stdout: string; stderr: string; error?: Error }; head?: string }): Git {
  return (args) => {
    if (args[0] === 'rev-parse') return ok(`${answers.head ?? 'headsha'}\n`);
    if (args[0] === 'rev-list') return ok(answers.parents ?? 'headsha parent1 parent2\n');
    if (args[0] === 'diff') return answers.diff ?? ok('');
    throw new Error(`unexpected git command ${args.join(' ')}`);
  };
}

describe('the changed paths: the merge commit against its first parent', () => {
  it('reads the NUL-separated names', () => {
    expect(changedPaths(fakeGit({ diff: ok('frontend/a.tsx\0docs/b.md\0') }), {})).toEqual({ ok: true, paths: ['frontend/a.tsx', 'docs/b.md'] });
  });

  it('asks git for the first parent against the merge commit, names only, with rename detection off', () => {
    const seen: string[][] = [];
    const git: Git = (args) => { seen.push(args); return fakeGit({ diff: ok('a\0') })(args); };
    changedPaths(git, {});
    const diff = seen.find((a) => a.includes('diff'))!;
    expect(diff).toEqual(expect.arrayContaining(['--name-only', '--no-renames', '-z']));
    expect(diff.slice(-2)).toEqual(['HEAD^1', 'HEAD']);
  });

  it('a failed git command is an error (so the rule runs everything)', () => {
    expect(changedPaths(fakeGit({ diff: { status: 128, stdout: '', stderr: 'fatal: bad revision HEAD^1' } }), {})).toMatchObject({ ok: false });
    expect(changedPaths(fakeGit({ diff: { status: null, stdout: '', stderr: '', error: new Error('spawn git ENOENT') } }), {})).toMatchObject({ ok: false });
  });

  it('output that was cut off (too long for the buffer, or not ending in a separator) is an error', () => {
    expect(changedPaths(fakeGit({ diff: { status: null, stdout: 'frontend/a.tsx\0', stderr: '', error: Object.assign(new Error('spawnSync git ENOBUFS'), { code: 'ENOBUFS' }) } }), {})).toMatchObject({ ok: false });
    expect(changedPaths(fakeGit({ diff: ok('frontend/a.tsx\0docs/b') }), {})).toMatchObject({ ok: false });
  });

  it('a checkout that is not a merge commit (one parent, or none: a shallow cut) is an error, because the diff would show one commit only', () => {
    expect(changedPaths(fakeGit({ parents: 'headsha parent1\n', diff: ok('frontend/a.tsx\0') }), {})).toMatchObject({ ok: false });
    expect(changedPaths(fakeGit({ parents: 'headsha\n', diff: ok('frontend/a.tsx\0') }), {})).toMatchObject({ ok: false });
  });

  it('a checkout that is not the commit the event is about is an error', () => {
    expect(changedPaths(fakeGit({ head: 'aaa', diff: ok('frontend/a.tsx\0') }), { GITHUB_SHA: 'bbb' })).toMatchObject({ ok: false });
    expect(changedPaths(fakeGit({ head: 'aaa', diff: ok('frontend/a.tsx\0') }), { GITHUB_SHA: 'aaa' })).toMatchObject({ ok: true });
  });
});

describe('the whole decision for a run (event, then git)', () => {
  it('asks git nothing when the event is not a pull request', () => {
    const git: Git = () => { throw new Error('git must not be asked'); };
    expect(skipDecisionFor(git, { GITHUB_EVENT_NAME: 'push' })).toEqual({ skip: false, reason: 'not-a-pull-request: push' });
    expect(skipDecisionFor(git, {})).toEqual({ skip: false, reason: 'not-a-pull-request: (none)' });
  });

  it('a pull request of screens only skips', () => {
    expect(skipDecisionFor(fakeGit({ diff: ok('frontend/src/a.tsx\0') }), { GITHUB_EVENT_NAME: 'pull_request' })).toEqual({ skip: true, reason: 'all-paths-irrelevant' });
  });

  it('a pull request whose paths cannot be read runs', () => {
    expect(skipDecisionFor(fakeGit({ diff: { status: 128, stdout: '', stderr: 'boom' } }), { GITHUB_EVENT_NAME: 'pull_request' }).skip).toBe(false);
  });

  it('a git that throws runs', () => {
    const git: Git = () => { throw new Error('git is not installed'); };
    expect(skipDecisionFor(git, { GITHUB_EVENT_NAME: 'pull_request' }).skip).toBe(false);
  });
});

// ---- real git: a real merge commit in a scratch folder --------------------------------------------------------------------------------

function realGit(dir: string): Git {
  return (args) => {
    const r = spawnSync('git', ['-C', dir, ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  };
}

/** A repository whose main branch has `base` committed, and a branch that does `change` and is merged with a merge commit. */
function repoWithMerge(base: Record<string, string>, change: (dir: string, git: (...a: string[]) => void) => void): { dir: string; git: Git } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'skip-rule-'));
  const run = (...a: string[]) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'user.name=t', '-c', 'user.email=t@example.invalid', '-c', 'commit.gpgsign=false', ...a], { encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`);
  };
  run('init', '-q', '-b', 'main');
  for (const [f, body] of Object.entries(base)) { mkdirSync(path.dirname(path.join(dir, f)), { recursive: true }); writeFileSync(path.join(dir, f), body); }
  run('add', '-A'); run('commit', '-q', '-m', 'base');
  run('checkout', '-q', '-b', 'feature');
  change(dir, run);
  run('add', '-A'); run('commit', '-q', '-m', 'change');
  run('checkout', '-q', 'main');
  // The target branch moved on, as it does while a pull request is open, so the merge is a real merge commit.
  writeFileSync(path.join(dir, 'moved-on.txt'), 'x'); run('add', '-A'); run('commit', '-q', '-m', 'moved on');
  run('merge', '-q', '--no-ff', '-m', 'merge', 'feature');
  return { dir, git: realGit(dir) };
}

describe('real git: a pull request is its merge commit against its first parent', () => {
  const event = { GITHUB_EVENT_NAME: 'pull_request' };
  const body = 'x'.repeat(200);
  const cleanup: string[] = [];
  const make = (...a: Parameters<typeof repoWithMerge>) => { const r = repoWithMerge(...a); cleanup.push(r.dir); return r; };
  const decide = (git: Git) => skipDecisionFor(git, event);

  it('a pull request that changes only a screen skips (and the target branch moving on does not count)', () => {
    const { git } = make({ 'backend/src/a.ts': body, 'frontend/src/Screen.tsx': 'v1' }, (dir) => writeFileSync(path.join(dir, 'frontend/src/Screen.tsx'), 'v2'));
    expect(changedPaths(git, event)).toEqual({ ok: true, paths: ['frontend/src/Screen.tsx'] });
    expect(decide(git)).toEqual({ skip: true, reason: 'all-paths-irrelevant' });
  });

  it('a pull request that changes a backend file runs', () => {
    const { git } = make({ 'backend/src/a.ts': 'v1' }, (dir) => writeFileSync(path.join(dir, 'backend/src/a.ts'), 'v2'));
    expect(decide(git)).toEqual({ skip: false, reason: 'relevant-path:backend/src/a.ts' });
  });

  it('a pull request that renames a file out of the backend folder runs everything (rename detection is off)', () => {
    const { git } = make({ 'backend/src/a.ts': body }, (dir, run) => { mkdirSync(path.join(dir, 'frontend/src'), { recursive: true }); run('mv', 'backend/src/a.ts', 'frontend/src/a.ts'); });
    const changed = changedPaths(git, event);
    expect(changed).toEqual({ ok: true, paths: expect.arrayContaining(['backend/src/a.ts', 'frontend/src/a.ts']) });
    expect(decide(git)).toEqual({ skip: false, reason: 'relevant-path:backend/src/a.ts' });
  });

  it('a pull request that changes a workflow file runs', () => {
    const { git } = make({ '.github/workflows/ci.yml': 'v1', 'frontend/a.tsx': 'v1' }, (dir) => { writeFileSync(path.join(dir, '.github/workflows/ci.yml'), 'v2'); writeFileSync(path.join(dir, 'frontend/a.tsx'), 'v2'); });
    expect(decide(git).skip).toBe(false);
  });

  it('a file with an awkward name is read exactly (no quoting), and a name that is not on the list runs', () => {
    const { git } = make({ 'frontend/a.tsx': 'v1' }, (dir) => { writeFileSync(path.join(dir, 'frontend/café "x".tsx'), 'v1'); writeFileSync(path.join(dir, 'tooling é.sh'), 'v1'); });
    const changed = changedPaths(git, event);
    expect(changed).toEqual({ ok: true, paths: expect.arrayContaining(['frontend/café "x".tsx', 'tooling é.sh']) });
    expect(decide(git).skip).toBe(false);
  });

  it('a checkout that is only the tip commit (no first parent in the history) runs', () => {
    const { dir } = make({ 'frontend/a.tsx': 'v1' }, (d) => writeFileSync(path.join(d, 'frontend/a.tsx'), 'v2'));
    const shallow = mkdtempSync(path.join(os.tmpdir(), 'skip-rule-shallow-'));
    cleanup.push(shallow);
    spawnSync('git', ['clone', '-q', '--depth=1', `file://${dir}`, shallow]);
    const d = decide(realGit(shallow));
    expect(d.skip).toBe(false);
    expect(d.reason).toMatch(/^changed-paths-unreadable/);
  });

  it('a push of the same merge commit runs, whatever it changed', () => {
    const { git } = make({ 'frontend/a.tsx': 'v1' }, (dir) => writeFileSync(path.join(dir, 'frontend/a.tsx'), 'v2'));
    expect(skipDecisionFor(git, { GITHUB_EVENT_NAME: 'push' }).skip).toBe(false);
  });

  afterAll(() => { for (const d of cleanup) rmSync(d, { recursive: true, force: true }); });
});
