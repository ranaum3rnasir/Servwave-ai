import { defineConfig, devices } from '@playwright/test';

/**
 * Platform specs (mobile slice 08: stale-chunk recovery).
 *
 * These run against a PRODUCTION BUILD, because only a build has hashed lazy chunks to block:
 *
 *   npx vite build --outDir /tmp/sw-dist
 *   npx vite preview --outDir /tmp/sw-dist --port 4273 --strictPort
 *   npx playwright test --config=e2e/playwright.platform.config.ts
 *
 * E2E_FRONTEND_URL points it elsewhere (a deployed staging frontend works too: the spec only
 * visits the public sign-in page and never signs in). No backend, no fixtures, no org.
 *
 * The six projects are the mobile programme's device set, Desktop Chrome being the control.
 * Service workers are blocked so `page.route` sees every chunk request.
 */
const FRONTEND = process.env.E2E_FRONTEND_URL || 'http://localhost:4273';

export default defineConfig({
  testDir: './platform',
  timeout: 60_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  retries: 0,
  reporter: [['list']],
  outputDir: '../test-results/platform',

  use: {
    baseURL: FRONTEND,
    serviceWorkers: 'block',
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },

  projects: [
    { name: 'iphone-se', use: { ...devices['iPhone SE'] } },
    { name: 'galaxy-s24', use: { ...devices['Galaxy S24'] } },
    { name: 'iphone-15', use: { ...devices['iPhone 15'] } },
    {
      name: 'landscape-phone',
      use: { ...devices['Galaxy S24 landscape'], viewport: { width: 838, height: 390 } },
    },
    { name: 'ipad-mini', use: { ...devices['iPad Mini'] } },
    { name: 'desktop-chrome', use: { ...devices['Desktop Chrome'], viewport: { width: 1280, height: 720 } } },
  ],
});
