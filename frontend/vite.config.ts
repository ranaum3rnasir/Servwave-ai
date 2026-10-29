import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';
import { pwaManifest } from './pwa-manifest';
import { servePublicPage } from './public-page-routing';
import { publicEntryBuild } from './public-entry-build';
import { publicEarlyScriptPlugin } from './public-early-script';
import { vendorChunk } from './vendor-chunks';

/**
 * Upload source maps to Sentry at build time so production stack traces are readable. Disabled
 * unless SENTRY_AUTH_TOKEN is present (CI / Vercel), so a local `vite build` is unaffected. Must
 * come after the other plugins. A function because the customer's page is built by its own
 * nested build (public-entry-build.ts) and needs its own instance.
 */
function sentryPlugin() {
  return sentryVitePlugin({
    org: process.env.SENTRY_ORG,
    project: process.env.SENTRY_PROJECT,
    authToken: process.env.SENTRY_AUTH_TOKEN,
    disable: !process.env.SENTRY_AUTH_TOKEN,
  });
}

export default defineConfig(({ mode }) => {
  const resolve = {
    // One copy of the error-reporting core. The install leaves an identical copy of it inside
    // each of the SDK's own packages (browser, browser-utils, react, replay: `node_modules/
    // @sentry/<pkg>/node_modules/@sentry/core`, all the same version), and the bundler treats
    // each path as a different module, so the core (spans, scopes, fetch and console
    // instrumentation) shipped three or four times in the first download. Resolving it from the
    // project root gives every package the one hoisted copy (mobile slice 61, PERF-01).
    dedupe: ['@sentry/core'],
    alias: {
      '@': path.resolve(__dirname, './src'),
      // email-reply-parser (email slice 9's quote-split library) imports
      // Node's `module.createRequire` at its top level - see
      // src/shims/node-module-browser-shim.ts for the full why. Without
      // this alias, `vite build` fails outright and `vite dev` throws at
      // runtime the moment that chunk loads.
      module: path.resolve(__dirname, './src/shims/node-module-browser-shim.ts'),
      // The auth/realtime client builds a database, a file-storage and a functions client eagerly,
      // and the app calls none of them (about 12 KB gzipped in the staff first download). They
      // are replaced by inert classes; see the shim for why and the guard test that backs it
      // (mobile slice 61, PERF-02).
      '@supabase/functions-js': path.resolve(__dirname, './src/shims/unused-data-clients-shim.ts'),
      '@supabase/postgrest-js': path.resolve(__dirname, './src/shims/unused-data-clients-shim.ts'),
      '@supabase/storage-js': path.resolve(__dirname, './src/shims/unused-data-clients-shim.ts'),
      // The realtime client opens a WebSocket to the auth provider, and a failed one makes every
      // browser print the provider's address in the console. The bell polls instead, so the client
      // is an inert stand-in whose `setAuth` is a no-op (mobile slice 75 follow-up).
      '@supabase/realtime-js': path.resolve(__dirname, './src/shims/unused-data-clients-shim.ts'),
    },
  };

  const env = loadEnv(mode, process.cwd(), '');
  const frontendPort = parseInt(env.VITE_PORT || '5173');
  const backendPort = env.VITE_BACKEND_PORT || '3000';

  return {
    plugins: [
      react(),
      // /p/* is answered by public.html, as vercel.json does on the host.
      servePublicPage(),
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        registerType: 'autoUpdate',
        // The plugin's injected `registerSW.js` ran on EVERY page, public estimates included.
        // The staff entry registers the worker itself (src/lib/platform/registerServiceWorker.ts)
        // and the public entry never does (mobile slice 47).
        injectRegister: false,
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        },
        manifest: pwaManifest,
        devOptions: {
          enabled: false,
        },
      }),
      sentryPlugin(),
      // Served in dev and preview; written into dist/ by the customer page's own build below.
      publicEarlyScriptPlugin({ root: __dirname, apiBase: env.VITE_API_URL, emit: false }),
      publicEntryBuild({
        plugins: () => [react(), sentryPlugin(), publicEarlyScriptPlugin({ root: __dirname, apiBase: env.VITE_API_URL, emit: true })],
        resolve,
        manualChunks: vendorChunk,
      }),
    ],
    resolve,
    build: {
      // 'hidden' generates source maps for Sentry upload without referencing them
      // in the shipped bundles (no sourceMappingURL comment exposed to browsers).
      sourcemap: 'hidden',
      rollupOptions: {
        // The staff app. The light page customers get for a public estimate or invoice link
        // (mobile slice 47; vercel.json routes /p/* to it) is built right after it, on its own, by
        // `publicEntryBuild` above (mobile slice 61).
        input: {
          main: path.resolve(__dirname, 'index.html'),
        },
        output: {
          // Which packages get a fixed chunk, and why, is in vendor-chunks.ts.
          manualChunks: vendorChunk,
        },
      },
    },
    server: {
      port: frontendPort,
      strictPort: true,
      proxy: {
        '/api': {
          target: `http://localhost:${backendPort}`,
          changeOrigin: true,
        },
      },
    },
  };
});