import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { InfraError } from './errors';
import type { Git } from './skip';

/**
 * Every file the repository holds, tracked or new and not ignored (a test file written today runs before it is added), as paths
 * relative to the folder: the input of the expected file set.
 */
export function trackedFiles(cwd: string): string[] {
  const r = spawnSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new InfraError('wiring', `git ls-files failed: ${(r.stderr ?? '').trim()}`);
  return r.stdout.split('\n').filter(Boolean);
}

/** A program installed by npm, from the backend's own folder or the workspace root's (where `npm ci` puts it). */
export function npmBin(backendDir: string, name: string): string {
  for (const dir of [path.join(backendDir, 'node_modules/.bin'), path.join(backendDir, '..', 'node_modules/.bin')]) {
    if (existsSync(path.join(dir, name))) return path.join(dir, name);
  }
  throw new InfraError('wiring', `${name} is not installed (run npm ci)`);
}

/**
 * Runs git in the repository that holds `dir`. Paths in its output are relative to the repository root whatever `diff.relative` says
 * (the path-skip rule compares them with root-level folder names). Never throws: a missing git is a result with `error`.
 */
export function gitIn(dir: string): Git {
  return (args) => {
    const r = spawnSync('git', ['-C', dir, '-c', 'diff.relative=false', ...args], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '', error: r.error };
  };
}
