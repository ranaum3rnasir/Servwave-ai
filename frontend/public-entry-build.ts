import type { InlineConfig, Plugin, ResolvedConfig } from 'vite';
import path from 'path';

/**
 * The customer's page (`public.html`) is built on its own, right after the staff app, by the same
 * `vite build` (mobile slice 61, PERF-03).
 *
 * Built in one pass with the staff app, the bundler cut every module the customer's page shares
 * with a lazy staff page into a chunk of its own: 35 files, most of them a few hundred bytes, for
 * a page with two pieces of code that matter. Lighthouse's mobile run models a plain HTTP/1.1
 * connection (six requests at a time, 150 ms each way), so a page of 37 scripts spent about 0.6 s
 * of its first paint on request rounds and measured 3.5 s with only 183 KB to fetch. Built alone,
 * the same page is the entry, one shared chunk for the framework, one stylesheet and the font: 8
 * requests, about 160 KB gzipped, and 2.3 s on the same run. A customer on a phone gets the same
 * shape from the host.
 *
 * Why a plugin and not a second npm script: `npx vite build` is how the mobile gate, the
 * promotion check and the service-worker spec build, and each of them needs both pages in `dist/`.
 *
 * The nested build writes into the same output folder without emptying it, after the staff build
 * and its service worker, so the staff worker's precache does not carry the customer's page.
 * `build.rollupOptions.input` of the staff build is `index.html` alone.
 */

/** What the two builds share, handed in by vite.config.ts so there is one copy of it. */
export interface PublicEntryShared {
  plugins: () => NonNullable<InlineConfig['plugins']>;
  resolve: NonNullable<InlineConfig['resolve']>;
  manualChunks: (id: string) => string | undefined;
}

/** The nested build's config. Pure, so a test can pin where it writes and what it leaves alone. */
export function publicEntryConfig(resolved: Pick<ResolvedConfig, 'root' | 'mode' | 'base' | 'logLevel' | 'build'>, shared: PublicEntryShared): InlineConfig {
  return {
    root: resolved.root,
    mode: resolved.mode,
    base: resolved.base,
    logLevel: resolved.logLevel,
    // Everything it needs is passed here; reading vite.config.ts again would build this plugin again.
    configFile: false,
    // The staff build already copied `public/` (fonts, icons, the early-request script).
    publicDir: false,
    plugins: shared.plugins(),
    resolve: shared.resolve,
    build: {
      outDir: path.resolve(resolved.root, resolved.build.outDir),
      // Never empty it: the staff build's files are in there.
      emptyOutDir: false,
      sourcemap: resolved.build.sourcemap,
      minify: resolved.build.minify,
      rollupOptions: {
        input: { public: path.resolve(resolved.root, 'public.html') },
        output: { manualChunks: shared.manualChunks },
      },
    },
  };
}

/** Runs a nested build; vite itself unless a test hands in its own. */
export type RunBuild = (config: InlineConfig) => Promise<unknown>;

export function publicEntryBuild(shared: PublicEntryShared, runBuild?: RunBuild): Plugin {
  let resolved: ResolvedConfig | undefined;
  let failed = false;
  return {
    name: 'public-entry-build',
    apply: 'build',
    configResolved(config) {
      resolved = config;
    },
    buildEnd(error) {
      if (error) failed = true;
    },
    closeBundle: {
      // After every other plugin's closeBundle, the service-worker plugin's in particular.
      order: 'post',
      sequential: true,
      async handler() {
        if (failed || !resolved) return;
        const run = runBuild ?? (await import('vite')).build;
        await run(publicEntryConfig(resolved, shared));
      },
    },
  };
}
