import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

export default defineConfig({
  testDir: './specs',
  testMatch: /visual-screenshots\.spec\.ts/,
  timeout: 30_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],

  use: {
    baseURL: 'http://localhost:5173',
    storageState: path.resolve(__dirname, '.auth', 'admin.json'),
    trace: 'off',
    screenshot: 'off',
  },

  projects: [
    {
      name: 'setup',
      testDir: '.',
      testMatch: /global-setup\.ts/,
      use: { storageState: undefined },
    },
    {
      name: 'chromium',
      use: { browserName: 'chromium' },
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
