/**
 * What the test configuration actually resolves to (#3250): hooks get the same limit as tests,
 * and the worker count is exactly what CI sets (never raised, none when unset).
 *
 * The config is evaluated by the bundler's own loader in a child node process: importing it into
 * this jsdom test would pull the bundler into the wrong environment.
 */
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';

const FRONTEND = resolve(__dirname, '../..');

function loadTestConfig(workers?: string): Record<string, unknown> {
  const env = { ...process.env };
  delete env.VITEST_MAX_WORKERS;
  if (workers !== undefined) env.VITEST_MAX_WORKERS = workers;
  const script =
    "import('vite').then(async (v) => {" +
    "const r = await v.loadConfigFromFile({ command: 'serve', mode: 'test' }, process.argv[1]);" +
    'console.log(JSON.stringify(r.config.test));})';
  const out = execFileSync(process.execPath, ['-e', script, resolve(FRONTEND, 'vitest.config.ts')], {
    cwd: FRONTEND,
    env,
    encoding: 'utf8',
  });
  return JSON.parse(out);
}

describe('vitest config', () => {
  it('gives hooks the same limit as tests, 30 seconds', () => {
    const t = loadTestConfig();
    expect(t.testTimeout).toBe(30000);
    expect(t.hookTimeout).toBe(t.testTimeout);
  });

  it('uses the worker count CI sets, as given', () => {
    expect(loadTestConfig('4').maxWorkers).toBe(4);
  });

  it('sets no worker cap when the variable is unset (local runs)', () => {
    expect(loadTestConfig().maxWorkers).toBeUndefined();
  });

  it('runs on a fake browser from 30.1.3 up: 27 and 28 compute styles several times slower (docs/ci.md)', () => {
    // The copy the test tool itself loads, read from disk (this file is on the selection always-run list).
    const { version } = createRequire(import.meta.url)('jsdom/package.json') as { version: string };
    const [major, minor, patch] = version.split('.').map((n) => Number.parseInt(n, 10)) as [number, number, number];
    const atLeast = major > 30 || (major === 30 && (minor > 1 || (minor === 1 && patch >= 3)));
    expect(atLeast, `jsdom ${version} is installed; the Frontend tests need 30.1.3 or later`).toBe(true);
  });

  it('pre-bundles the date packages, whose entry files load about 300 files each', () => {
    const client = (loadTestConfig().deps as { optimizer: { client: { enabled: boolean; include: string[] } } }).optimizer.client;
    expect(client.enabled).toBe(true);
    expect(client.include).toEqual(expect.arrayContaining(['date-fns', 'date-fns/locale', 'date-fns-tz', 'react-day-picker']));
  });
});
