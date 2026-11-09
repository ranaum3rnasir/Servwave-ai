/**
 * What the test configuration actually resolves to (#3250): hooks get the same limit as tests,
 * and the worker count is exactly what CI sets (never raised, none when unset).
 *
 * The config is evaluated by the bundler's own loader in a child node process: importing it into
 * this jsdom test would pull the bundler into the wrong environment.
 */
import { execFileSync } from 'node:child_process';
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
});
