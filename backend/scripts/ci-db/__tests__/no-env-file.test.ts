import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { withoutEnvFiles } from '../run';

/** What a node process, started with the command's environment in a folder that has env files, can see of them. */
const PROBE = `
const fs = require('node:fs');
const out = {};
const tryIt = (k, f) => { try { out[k] = f(); } catch (e) { out[k] = e.code; } };
tryIt('readFileSync', () => fs.readFileSync('.env', 'utf8').length);
tryIt('readFileSyncLocal', () => fs.readFileSync('.env.local', 'utf8').length);
tryIt('readFileSyncExample', () => fs.readFileSync('.env.example', 'utf8').length);
tryIt('existsSync', () => fs.existsSync('.env'));
tryIt('statSync', () => fs.statSync('.env').size);
tryIt('statSyncQuiet', () => String(fs.statSync('.env', { throwIfNoEntry: false })));
tryIt('urlRead', () => fs.readFileSync(new URL('file://' + process.cwd() + '/.env'), 'utf8').length);
tryIt('dotenv', () => { process.env.DATABASE_URL = ''; delete process.env.DATABASE_URL; require('dotenv').config({ quiet: true }); return process.env.DATABASE_URL; });
fs.promises.readFile('.env').then(() => { out.promise = 'read'; }, (e) => { out.promise = e.code; }).then(() => {
  fs.readFile('.env', (err) => { out.callback = err ? err.code : 'read'; process.stdout.write(JSON.stringify(out)); });
});
`;

describe('the Database command hides env files from its processes', () => {
  let dir = '';
  const probe = (env: NodeJS.ProcessEnv) => {
    const r = spawnSync(process.execPath, ['-e', PROBE], { cwd: dir, env, encoding: 'utf8' });
    return JSON.parse(r.stdout || `{"failed":${JSON.stringify(r.stderr)}}`) as Record<string, unknown>;
  };
  const baseEnv = (): NodeJS.ProcessEnv => ({ PATH: process.env.PATH, NODE_PATH: path.dirname(path.dirname(require.resolve('dotenv/package.json'))) });

  beforeAll(() => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'ci-db-envfile-'));
    writeFileSync(path.join(dir, '.env'), 'DATABASE_URL=postgresql://canary@127.0.0.1:1/x\n');
    writeFileSync(path.join(dir, '.env.local'), 'DIRECT_URL=postgresql://canary@127.0.0.1:1/x\n');
    writeFileSync(path.join(dir, '.env.example'), 'DATABASE_URL=\n');
  });
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it('without the preload the env file is read (so the probe can see a leak)', () => {
    const seen = probe(baseEnv());
    expect(seen.readFileSync).toBeGreaterThan(0);
    expect(seen.dotenv).toContain('canary');
  });

  it('with the command\'s environment every way of reading .env or .env.<mode> finds nothing, and the example file stays readable', () => {
    const seen = probe(withoutEnvFiles(baseEnv()));
    expect(seen).toEqual({
      readFileSync: 'ENOENT', readFileSyncLocal: 'ENOENT', readFileSyncExample: expect.any(Number), existsSync: false, statSync: 'ENOENT',
      statSyncQuiet: 'undefined', urlRead: 'ENOENT', dotenv: undefined, promise: 'ENOENT', callback: 'ENOENT',
    });
  });

  it('keeps the caller\'s own node options', () => {
    expect(withoutEnvFiles({ NODE_OPTIONS: '--max-old-space-size=4096' }).NODE_OPTIONS).toMatch(/^--max-old-space-size=4096 --require ".*no-env-file\.cjs"$/);
  });
});
