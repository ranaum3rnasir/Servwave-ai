import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

/**
 * Post-QA fix validation config (calendar-entries, 2026-08-25).
 *
 * Dedicated ports 3022 / 5194 so this cannot collide with the dev servers other sessions
 * hold on :3000 / :3010 / :3021 - and those backends do not carry E2E_TEST_DOORS, so
 * borrowing one would fail global-setup's /api/test/provision-org with a 404 that reads
 * like a product bug.
 *
 * `reuseExistingServer: true` on purpose, unlike the verification config: four validation
 * specs run one after another against this same build, and rebooting Vite and the API
 * between each would cost more than the checks themselves.
 */
export default defineConfig({
  testDir: './specs',
  timeout: 120_000,
  expect: { timeout: 15_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalTeardown: path.resolve(__dirname, 'global-teardown.ts'),
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../playwright-report-qa' }]],
  outputDir: './test-results-qa',

  use: {
    baseURL: 'http://localhost:5194',
    trace: 'retain-on-failure',
    screenshot: 'on',
    video: 'off',
  },

  projects: [
    { name: 'setup', testDir: '.', testMatch: /global-setup\.ts/ },
    {
      name: 'chromium',
      testMatch: /qa-.*\.spec\.ts/,
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
      port: 3022,
      reuseExistingServer: true,
      timeout: 90_000,
      stdout: 'pipe',
      stderr: 'pipe',
    },
    {
      command: 'npm run dev -- --port 5194 --strictPort',
      cwd: ROOT,
      port: 5194,
      reuseExistingServer: true,
      timeout: 90_000,
    },
  ],
});
