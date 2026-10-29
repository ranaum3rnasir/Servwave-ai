import type { ManifestOptions } from 'vite-plugin-pwa';

/**
 * The web app manifest the PWA plugin emits as `manifest.webmanifest`.
 *
 * Its own module (not inline in vite.config.ts) so a unit test can assert on
 * exactly what ships without loading the whole Vite plugin graph:
 * src/__tests__/installed-app-head-and-manifest.test.ts.
 *
 * - theme_color / background_color are the header colour, the `--app` token
 *   (#ffffff) the shell's top bar paints, so the installed app's title bar
 *   and splash match the app. index.html's theme-color meta carries the same
 *   value.
 * - No `orientation`: an installed app must rotate with the device (WCAG
 *   1.3.4). Do not add a portrait lock back.
 * - Icons are generated from the ServWave mark in favicon.svg by
 *   scripts/generate-app-icons.mjs.
 */
export const pwaManifest: Partial<ManifestOptions> = {
  id: '/',
  name: 'ServWave',
  short_name: 'ServWave',
  description: 'Field service management',
  theme_color: '#ffffff',
  background_color: '#ffffff',
  start_url: '/',
  scope: '/',
  display: 'standalone',
  icons: [
    { src: '/icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
    { src: '/icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
  ],
};
