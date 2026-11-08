import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

export default defineConfig({
  testDir: './specs',
  // UI rows seed full pipelines via ApiClient in beforeAll (many staging round-trips) before
  // driving the browser — 30s is too tight for those hooks. 120s covers seed + render + screenshot.
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 1,
  // Tear down the provisioned throwaway org + sweep @e2e-qa.invalid Auth users after the run.
  globalTeardown: path.resolve(__dirname, 'global-teardown.ts'),
  reporter: [['html', { open: 'never' }]],
  outputDir: './test-results',

  use: {
    // NOTE: storageState is set ONLY on the chromium project, NOT here. A globally-set
    // storageState is inherited by the `setup` project (project-level `undefined` does not
    // reliably clear it), which then fails to load .auth/admin.json before setup creates it.
    baseURL: 'http://localhost:5173',
    trace: 'on-first-retry',
    screenshot: 'only-on-failure',
  },

  projects: [
    {
      name: 'setup',
      testDir: '.',
      testMatch: /global-setup\.ts/,
    },
    {
      name: 'chromium',
      // Tier 🔧 (backend-integration ApiClient specs) lives under specs/workflow/** and is
      // driven ONLY by playwright.api.config.ts. testDir './specs' would otherwise match it,
      // double-running those HTTP tests in the browser. Exclude it here.
      //
      // Same reason for the visual-regression spec: it is owned ONLY by
      // visual-regression.config.ts, which pins the clock, stubs every /api/ route, runs on
      // dedicated ports 3100/5273 with reuseExistingServer false and retries 0, and overrides
      // snapshotPathTemplate so the committed baselines under e2e/visual-baselines/ are found.
      // This config supplies none of that: its default snapshotPathTemplate looks in
      // specs/visual-regression.spec.ts-snapshots/, which does not exist, so collecting the
      // spec here can only ever fail. Exclude it too.
      testIgnore: ['**/specs/workflow/**', '**/specs/visual-regression.spec.ts'],
      use: {
        browserName: 'chromium',
        storageState: path.resolve(__dirname, '.auth', 'admin.json'),
      },
      dependencies: ['setup'],
    },
  ],

  webServer: [
    {
      command: 'npm run dev',
      cwd: path.resolve(ROOT, '..', 'backend'),
      port: 3000,
      reuseExistingServer: true,
      timeout: 30_000,
    },
    {
      command: 'npm run dev',
      cwd: ROOT,
      port: 5173,
      reuseExistingServer: true,
      timeout: 30_000,
    },
  ],
});
