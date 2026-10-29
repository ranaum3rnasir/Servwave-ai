/**
 * Mobile slice 61 (PERF-03): the customer's page is built on its own, after the staff app, by the
 * same `vite build`.
 *
 * Pinned here: where the nested build writes (the staff build's output folder, never emptied, no
 * second copy of `public/`), what it builds (`public.html` alone, and the staff build no longer
 * builds it), when it runs (after the staff build, never after a failed one) and that the two
 * builds share one resolve table. The result on a real build (3 scripts, under the file ceiling,
 * the staff worker's precache without the customer's page) is checked by
 * `scripts/check-public-bundle-budget.mjs`, the last step of `npm run build`.
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { publicEntryBuild, publicEntryConfig, type PublicEntryShared } from '../../public-entry-build';

const FRONTEND = resolve(__dirname, '../..');
const RESOLVED = {
  root: FRONTEND,
  mode: 'production',
  base: '/',
  logLevel: 'info' as const,
  build: { outDir: 'dist', sourcemap: 'hidden' as const, minify: 'esbuild' as const },
};
const shared: PublicEntryShared = {
  plugins: () => [{ name: 'a-plugin' }],
  resolve: { alias: { '@': '/src' } },
  manualChunks: () => undefined,
};

describe('publicEntryConfig', () => {
  const config = publicEntryConfig(RESOLVED as never, shared);

  it('builds public.html alone, into the staff build output, without emptying it', () => {
    expect(config.build?.rollupOptions?.input).toEqual({ public: resolve(FRONTEND, 'public.html') });
    expect(config.build?.outDir).toBe(resolve(FRONTEND, 'dist'));
    expect(config.build?.emptyOutDir).toBe(false);
  });

  it('does not copy public/ a second time and does not re-read vite.config.ts', () => {
    expect(config.publicDir).toBe(false);
    expect(config.configFile).toBe(false);
  });

  it('follows the staff build where it was pointed (an --outDir on the command line)', () => {
    const elsewhere = publicEntryConfig({ ...RESOLVED, build: { ...RESOLVED.build, outDir: '/tmp/somewhere' } } as never, shared);
    expect(elsewhere.build?.outDir).toBe('/tmp/somewhere');
  });

  it('shares the plugins, the resolve table and the chunking with the staff build', () => {
    expect(config.plugins).toEqual([{ name: 'a-plugin' }]);
    expect(config.resolve).toBe(shared.resolve);
    expect(config.build?.sourcemap).toBe('hidden');
  });
});

describe('publicEntryBuild plugin', () => {
  const build = vi.fn(async () => ({}));
  beforeEach(() => build.mockClear());

  const run = async (error?: Error) => {
    const plugin = publicEntryBuild(shared, build) as unknown as {
      configResolved: (c: unknown) => void;
      buildEnd: (e?: Error) => void;
      closeBundle: { order: string; sequential: boolean; handler: () => Promise<void> };
    };
    plugin.configResolved(RESOLVED);
    if (error) plugin.buildEnd(error);
    await plugin.closeBundle.handler();
    return plugin;
  };

  it('runs the nested build once, after everything else has closed', async () => {
    const plugin = await run();
    expect(build).toHaveBeenCalledTimes(1);
    expect(plugin.closeBundle.order).toBe('post');
    expect(plugin.closeBundle.sequential).toBe(true);
  });

  it('does not start it after a failed staff build', async () => {
    await run(new Error('boom'));
    expect(build).not.toHaveBeenCalled();
  });
});

describe('vite.config.ts wiring', () => {
  const config = readFileSync(resolve(FRONTEND, 'vite.config.ts'), 'utf8');

  it('leaves public.html out of the staff build and hands it to the plugin', () => {
    expect(config).toMatch(/input: \{\s*main: path\.resolve\(__dirname, 'index\.html'\),\s*\}/);
    expect(config).not.toMatch(/public: path\.resolve\(__dirname, 'public\.html'\)/);
    expect(config).toMatch(/publicEntryBuild\(\{/);
  });

  it('puts the plugin last, so its post-order close runs after the service-worker plugin', () => {
    const plugins = config.slice(config.indexOf('plugins: ['), config.indexOf('    ],\n    resolve,'));
    expect(plugins.lastIndexOf('publicEntryBuild(')).toBeGreaterThan(plugins.indexOf('VitePWA('));
  });
});
