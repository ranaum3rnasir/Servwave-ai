import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

export default defineConfig({
  testDir: './specs/workflow',
  // Raised: deposit/webhook chains are multi-call and Render/Supabase cold-starts add latency.
  // Heavy rows that loop several full seed-chains (e.g. JOB-02, PAY-02) need headroom; they also
  // set their own test.setTimeout where needed.
  timeout: 75_000,
  expect: { timeout: 8_000 },
  fullyParallel: false,
  workers: 1,
  // One retry to absorb a cold-start flake on the first timed row (§3.6 determinism).
  retries: 1,
  // No browser/storageState here — provision the throwaway org + persist .auth/e2e-org.json.
  globalSetup: path.resolve(__dirname, 'global-setup-api.ts'),
  // Tear down the org + sweep @e2e-qa.invalid Auth users after the run.
  globalTeardown: path.resolve(__dirname, 'global-teardown.ts'),
  reporter: [['list'], ['html', { open: 'never', outputFolder: '../playwright-report-api' }]],
  outputDir: './test-results-api',

  use: {
    baseURL: 'http://localhost:3000',
  },

  webServer: {
    command: 'npm run dev',
    cwd: path.resolve(ROOT, '..', 'backend'),
    port: 3000,
    reuseExistingServer: true,
    timeout: 30_000,
  },
});
