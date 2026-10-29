import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// Dedicated UI-tier config for the standalone-invoice browser specs. Runs against a
// PARALLEL doored stack (backend :3100 / frontend :5273) so it never collides with a
// dev server another session may be holding on :3000/:5173. The backend URL is fed to
// global-setup/teardown + ApiClient via E2E_BACKEND_URL; the frontend is reached via
// the project baseURL below. Servers are started manually (reuseExistingServer), so no
// webServer block here.
const FRONTEND = process.env.E2E_FRONTEND_URL || 'http://localhost:5273';

export default defineConfig({
  testDir: './specs/standalone',
  timeout: 120_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  globalTeardown: path.resolve(__dirname, 'global-teardown.ts'),
  reporter: [['list']],
  outputDir: './test-results-standalone',

  use: {
    baseURL: FRONTEND,
    trace: 'retain-on-failure',
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
      use: {
        browserName: 'chromium',
        storageState: path.resolve(__dirname, '.auth', 'admin.json'),
      },
      dependencies: ['setup'],
    },
  ],
});
