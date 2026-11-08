import { defineConfig, loadEnv } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';
import { sentryVitePlugin } from '@sentry/vite-plugin';
import path from 'path';

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '');
  const frontendPort = parseInt(env.VITE_PORT || '5173');
  const backendPort = env.VITE_BACKEND_PORT || '3000';

  return {
    plugins: [
      react(),
      VitePWA({
        strategies: 'injectManifest',
        srcDir: 'src',
        filename: 'sw.ts',
        registerType: 'autoUpdate',
        injectManifest: {
          globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        },
        manifest: {
          name: 'ServWave',
          short_name: 'ServWave',
          description: 'Field service management',
          theme_color: '#0C2D3A',
          background_color: '#F7F7F2',
          start_url: '/',
          scope: '/',
          display: 'standalone',
          orientation: 'portrait',
        },
        devOptions: {
          enabled: false,
        },
      }),
      // Upload source maps to Sentry at build time so production stack traces are
      // readable. Disabled unless SENTRY_AUTH_TOKEN is present (CI / Vercel), so a
      // local `vite build` is unaffected. Must come after the other plugins.
      sentryVitePlugin({
        org: process.env.SENTRY_ORG,
        project: process.env.SENTRY_PROJECT,
        authToken: process.env.SENTRY_AUTH_TOKEN,
        disable: !process.env.SENTRY_AUTH_TOKEN,
      }),
    ],
    resolve: {
      alias: {
        '@': path.resolve(__dirname, './src'),
        // email-reply-parser (email slice 9's quote-split library) imports
        // Node's `module.createRequire` at its top level - see
        // src/shims/node-module-browser-shim.ts for the full why. Without
        // this alias, `vite build` fails outright and `vite dev` throws at
        // runtime the moment that chunk loads.
        module: path.resolve(__dirname, './src/shims/node-module-browser-shim.ts'),
      },
    },
    build: {
      // 'hidden' generates source maps for Sentry upload without referencing them
      // in the shipped bundles (no sourceMappingURL comment exposed to browsers).
      sourcemap: 'hidden',
      rollupOptions: {
        output: {
          manualChunks: {
            'vendor-react': ['react', 'react-dom', 'react-router-dom'],
            'vendor-query': ['@tanstack/react-query', '@tanstack/react-table'],
            'vendor-radix': [
              '@radix-ui/react-avatar',
              '@radix-ui/react-checkbox',
              '@radix-ui/react-dialog',
              '@radix-ui/react-dropdown-menu',
              '@radix-ui/react-label',
              '@radix-ui/react-popover',
              '@radix-ui/react-select',
              '@radix-ui/react-separator',
              '@radix-ui/react-slot',
              '@radix-ui/react-switch',
              '@radix-ui/react-tabs',
              '@radix-ui/react-toast',
              '@radix-ui/react-tooltip',
            ],
            'vendor-supabase': ['@supabase/supabase-js'],
            'vendor-utils': ['axios', 'date-fns', 'date-fns-tz', 'lucide-react', 'zustand'],
          },
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