/*
 * The files the Database command runs and the order of its checks, as the command itself answers (`cli.ts list`). The guards
 * under src/__tests__ read it this way because the command's folder is outside this project's source root and cannot be imported.
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';

const BACKEND = path.resolve(__dirname, '../../..');

export interface DbCommandList {
  all: string[];
  core: { phase: string; file: string }[];
  lanes: string[];
  after: { phase: string; file: string }[];
  coreOrder: string[];
  afterOrder: string[];
  /** What the path-skip rule decides for a run in this environment (#3238). */
  skip: { skip: boolean; reason: string };
}

export function dbCommandList(env: NodeJS.ProcessEnv = {}): DbCommandList {
  const tsx = [path.join(BACKEND, 'node_modules/.bin/tsx'), path.join(BACKEND, '../node_modules/.bin/tsx')].find(existsSync);
  if (!tsx) throw new Error('tsx is not installed (run npm ci)');
  const r = spawnSync(tsx, ['scripts/ci-db/cli.ts', 'list'], { cwd: BACKEND, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { ...process.env, ...env } });
  if (r.status !== 0) throw new Error(`the Database command could not list its files: ${r.stderr.slice(0, 500)}`);
  return JSON.parse(r.stdout) as DbCommandList;
}
