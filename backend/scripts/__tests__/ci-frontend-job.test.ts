/**
 * The Frontend job in ci.yml (#3250): worker count from a repository variable (default 4, hosted
 * shards stay at 2), and one type-check per job (the build step runs the bundler and the bundle
 * budget without a second `tsc`). The required check name stays exactly as it is.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import path from 'node:path';

const ROOT = path.resolve(__dirname, '../../..');
const CI = readFileSync(path.join(ROOT, '.github/workflows/ci.yml'), 'utf8');
const FRONTEND_PKG = JSON.parse(readFileSync(path.join(ROOT, 'frontend/package.json'), 'utf8'));

/** The text of one top-level job (two-space indent) up to the next job. */
function job(id: string): string {
  const m = new RegExp(`^  ${id}:\\n([\\s\\S]*?)(?=^  [a-z][\\w-]*:\\n|(?![\\s\\S]))`, 'm').exec(CI);
  if (!m) throw new Error(`job ${id} not found in ci.yml`);
  return m[1];
}

/** The text of one step (by exact name) up to the next step. */
function step(jobText: string, name: string): string {
  const m = new RegExp(`^      - name: ${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\n([\\s\\S]*?)(?=^      - |(?![\\s\\S]))`, 'm').exec(jobText);
  if (!m) throw new Error(`step "${name}" not found`);
  return m[1].split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

/** Lines of a job that are not comments. */
function code(text: string): string {
  return text.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
}

describe('Frontend job in ci.yml', () => {
  it('keeps the required check name', () => {
    expect(job('frontend')).toContain('name: Frontend (lint + type-check + tests + build)');
  });

  it('takes the Mac worker count from a repository variable, 4 when unset', () => {
    const tests = step(job('frontend'), 'Tests');
    expect(tests).toMatch(/VITEST_MAX_WORKERS: \$\{\{ vars\.FRONTEND_TEST_WORKERS \|\| 4 \}\}/);
  });

  it('keeps the hosted fallback shards at 2 workers', () => {
    const shards = job('frontend-tests');
    expect(shards).toMatch(/VITEST_MAX_WORKERS: 2\s*$/m);
    expect(shards).not.toContain('vars.');
  });

  it('type-checks once: exactly one tsc in the whole job, and no `npm run build` (it starts with tsc -b)', () => {
    const f = job('frontend');
    const code = f.split('\n').filter((l) => !/^\s*#/.test(l)).join('\n');
    expect(step(f, 'Type-check')).toContain('npx tsc --noEmit');
    expect(code.match(/\btsc\b/g)).toHaveLength(1);
    expect(code).not.toMatch(/npm run build\b/);
    const build = step(f, 'Build');
    expect(build).toContain('npx vite build');
    expect(build).toContain('node scripts/check-public-bundle-budget.mjs');
  });

  it('runs the bundle budget after the bundler, so a bundle over budget still fails the step', () => {
    const build = step(job('frontend'), 'Build');
    expect(build.indexOf('vite build')).toBeGreaterThan(-1);
    expect(build.indexOf('check-public-bundle-budget')).toBeGreaterThan(build.indexOf('vite build'));
    expect(build).toMatch(/run: npx vite build && node scripts\/check-public-bundle-budget\.mjs/);
  });

  it('deletes the build-info folder under node_modules at the start of the Type-check step, always', () => {
    const tc = step(job('frontend'), 'Type-check');
    expect(tc.indexOf('rm -rf node_modules/.tmp')).toBeGreaterThan(-1);
    expect(tc.indexOf('rm -rf node_modules/.tmp')).toBeLessThan(tc.indexOf('npx tsc --noEmit'));
  });

  it('leaves `npm run build` as it was for local use and the hosting provider', () => {
    expect(FRONTEND_PKG.scripts.build).toBe('tsc -b && vite build && node scripts/check-public-bundle-budget.mjs');
  });

  it('runs the tests through the one command on the Mac path (#3253)', () => {
    const tests = step(job('frontend'), 'Tests');
    expect(tests).toMatch(/run: npm run test:ci\s*$/m);
    expect(tests).not.toMatch(/npm test\b|vitest/);
    expect(FRONTEND_PKG.scripts['test:ci']).toBe('node scripts/test-ci.mjs');
  });

  it('runs every hosted shard through the same command, with its --shard (#3253)', () => {
    const tests = step(job('frontend-tests'), 'Tests');
    expect(tests).toMatch(/run: npm run test:ci -- --shard=\$\{\{ matrix\.shard \}\}\/6\s*$/m);
    expect(tests).not.toMatch(/npm test\b|vitest/);
  });

  it('has no step time limits in the Frontend job: one job-level limit, 45 minutes on the Mac (#3253)', () => {
    const f = code(job('frontend'));
    expect(f).not.toMatch(/^ {8}timeout-minutes:/m);
    expect(f.match(/timeout-minutes:/g)).toHaveLength(1);
    expect(f).toMatch(/^ {4}timeout-minutes: \$\{\{ needs\.pick-runners\.outputs\.frontend == '"ubuntu-latest"' && 30 \|\| 45 \}\}$/m);
  });

  it('gives the shards job-level limits only, no step limits (#3253)', () => {
    expect(code(job('frontend-tests'))).not.toMatch(/^ {8}timeout-minutes:/m);
  });
});
