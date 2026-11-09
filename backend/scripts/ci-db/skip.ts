/*
 * The path-skip rule of the Database check (spec #3234, "Path-based skips (fail-open)"; ticket #3238).
 *
 * A pull request whose every changed path is on a list of paths known to be irrelevant to the check skips the lanes and what follows
 * them (the migrations, the boot check, the RLS suites and the seed still run on every pull request). Anything else runs everything:
 * a path nobody thought of, a failed git command, an empty or truncated list, a push, no event at all. The decision is a pure function;
 * the shell around it asks git for the merge commit against its first parent, with rename detection off.
 */

/** More changed paths than this run everything: a list that long may have been cut off, and a change that large is not "a screen". */
export const MAX_CHANGED_PATHS = 3000;

export interface SkipDecision {
  skip: boolean;
  /** A short code for the summary and the tests: why it skips, or why it runs. */
  reason: string;
}

export type ChangedPaths = { ok: true; paths: readonly string[] } | { ok: false; error: string };

// ---- the list of paths known to be irrelevant ------------------------------------------------------------------------------------

/**
 * Top-level folders whose contents no real-database suite or helper reads (pinned by the guard in scripts/__tests__/ci-db-suites.test.ts):
 * the frontend, the docs folders and the agent-tooling folder. Folder names are matched whole and in lower case; anything else runs.
 */
const IRRELEVANT_FOLDERS: readonly string[] = ['frontend', 'docs', 'md_files', '.claude'];

/**
 * Files that decide which packages `npm ci` installs, wherever they sit: a change to one is relevant even inside an irrelevant folder.
 * The frontend is a workspace of the root install, so its manifest and lockfile are the ones that matter most.
 */
const PACKAGE_FILES: readonly string[] = ['package.json', 'package-lock.json', 'npm-shrinkwrap.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb', '.npmrc'];

/** A path as `git diff --name-only -z` prints it: relative, forward slashes, no empty or dot segments. Anything else is unknown. */
function wellFormed(p: string): boolean {
  if (p === '' || p.startsWith('/') || p.includes('\\') || p.includes('\0') || p.startsWith('"')) return false;
  return p.split('/').every((s) => s !== '' && s !== '.' && s !== '..');
}

/** True when the path is on the list. A path that is malformed is not. */
export function isIrrelevantPath(p: string): boolean {
  if (!wellFormed(p)) return false;
  const segments = p.split('/');
  if (PACKAGE_FILES.includes(segments[segments.length - 1]!)) return false;
  if (segments.length === 1) return p.endsWith('.md');
  return IRRELEVANT_FOLDERS.includes(segments[0]!);
}

// ---- the decision -----------------------------------------------------------------------------------------------------------------

/** The only event the rule applies to. Anything else (a push, a manual or scheduled run, no event) runs everything. */
export const SKIPPABLE_EVENT = 'pull_request';

export function decideSkip(input: { event: string | undefined; changed: ChangedPaths }): SkipDecision {
  if (input.event !== SKIPPABLE_EVENT) return { skip: false, reason: `not-a-pull-request: ${input.event || '(none)'}` };
  if (!input.changed.ok) return { skip: false, reason: `changed-paths-unreadable: ${input.changed.error}` };
  const { paths } = input.changed;
  if (paths.length === 0) return { skip: false, reason: 'no-changed-paths' };
  if (paths.length > MAX_CHANGED_PATHS) return { skip: false, reason: 'too-many-paths' };
  const relevant = paths.find((p) => !isIrrelevantPath(p));
  if (relevant !== undefined) return { skip: false, reason: `relevant-path:${relevant}` };
  return { skip: true, reason: 'all-paths-irrelevant' };
}

// ---- the changed paths, from git ---------------------------------------------------------------------------------------------------

export interface GitResult { status: number | null; stdout: string; stderr: string; error?: Error }
/** Runs `git <args>` in the repository the checkout is. */
export type Git = (args: string[]) => GitResult;

const fail = (error: string): ChangedPaths => ({ ok: false, error });

/**
 * The paths of the merge commit against its first parent (what the pull request changes against the branch it merges into), with
 * rename detection off so a file moved out of a folder shows as a delete there. An error when: git fails or its output was cut off;
 * HEAD is not a merge commit (the diff would show one commit only); HEAD is not the commit the event is about.
 */
export function changedPaths(git: Git, env: NodeJS.ProcessEnv): ChangedPaths {
  const head = git(['rev-parse', 'HEAD']);
  if (head.error || head.status !== 0) return fail(`git rev-parse HEAD failed: ${(head.error?.message ?? head.stderr).trim().slice(0, 200)}`);
  if (env.GITHUB_SHA && head.stdout.trim() !== env.GITHUB_SHA) return fail('the checkout is not the commit this event is about');

  const parents = git(['rev-list', '--parents', '-n', '1', 'HEAD']);
  if (parents.error || parents.status !== 0) return fail(`git rev-list failed: ${(parents.error?.message ?? parents.stderr).trim().slice(0, 200)}`);
  // "<commit> <first parent> <second parent>": a merge commit has exactly two parents.
  if (parents.stdout.trim().split(/\s+/).length !== 3) return fail('the checked-out commit is not a merge commit with two parents');

  const diff = git(['diff', '--name-only', '--no-renames', '-z', 'HEAD^1', 'HEAD']);
  if (diff.error) return fail(`git diff failed: ${diff.error.message.slice(0, 200)}`);
  if (diff.status !== 0) return fail(`git diff exited ${diff.status}: ${diff.stderr.trim().slice(0, 200)}`);
  // -z ends every name with a NUL, so output that does not was cut off.
  if (diff.stdout !== '' && !diff.stdout.endsWith('\0')) return fail('the list of changed paths was cut off');
  return { ok: true, paths: diff.stdout.split('\0').filter((p) => p !== '') };
}

/** The decision for this run: asks git only when the event is a pull request, and treats anything that throws as an error. */
export function skipDecisionFor(git: Git, env: NodeJS.ProcessEnv): SkipDecision {
  const event = env.GITHUB_EVENT_NAME;
  if (event !== SKIPPABLE_EVENT) return decideSkip({ event, changed: { ok: true, paths: [] } });
  let changed: ChangedPaths;
  try {
    changed = changedPaths(git, env);
  } catch (e) {
    changed = fail(e instanceof Error ? e.message.slice(0, 200) : String(e).slice(0, 200));
  }
  return decideSkip({ event, changed });
}
