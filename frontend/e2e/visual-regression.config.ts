import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

/**
 * Verification layer 1 of the UI Component Architecture Program (program plan §4.1):
 * the real visual-regression gate. `specs/visual-screenshots.spec.ts` writes raw PNGs and
 * asserts nothing - it is a screenshotting tool. This config runs the one spec that calls
 * `expect(page).toHaveScreenshot()`, so a pixel change in either tracer page fails the run.
 *
 * DEDICATED PORTS, deliberately. The other configs use 3000/5173 with
 * `reuseExistingServer: true`. During the phase-7 program a dev server from the MAIN
 * checkout is routinely already listening on 5173, and reusing it would baseline the wrong
 * source tree while reporting success. 3100/5273 are this config's alone, and
 * `reuseExistingServer: false` makes a stale listener a hard error rather than a silent
 * wrong-tree run. The worktree's `backend/.env` PORT and `frontend/.env.local`
 * VITE_BACKEND_PORT are set to match; the `env` blocks below restate them so the config is
 * self-describing and wins regardless (dotenv never overrides an inherited process.env).
 *
 * Prerequisites are the QA suite's (see e2e/README-qa-suite.md): `backend/.env` must carry
 * E2E_TEST_DOORS=true plus the E2E_ALLOWED_DB_HOSTS / E2E_ALLOWED_DB_REF staging allowlist,
 * or `global-setup` cannot provision the throwaway org.
 *
 * PLATFORM LIMITATION, stated plainly: THIS IS A LOCAL, macOS-ONLY DEVELOPER GATE. It is not
 * a standing CI gate and must not be described as one. The only committed baselines are
 * `e2e/visual-baselines/invoices-list-chromium-darwin.png` and
 * `e2e/visual-baselines/invoice-detail-chromium-darwin.png`. The `{platform}` segment of
 * `snapshotPathTemplate` below resolves to the platform of the machine running the test, so on
 * a Linux runner Playwright looks for the `-chromium-linux` pair, finds nothing, and reports
 * "snapshot doesn't exist" - it writes the run's own PNG to that new path instead of comparing.
 * Nothing is diffed and no pixel is verified: whatever such a run reports is about a missing
 * file, never about a visual change. A Linux run therefore proves nothing about either page.
 * Run this on macOS or do not claim the gate ran. Nothing in CI invokes this config today, and
 * wiring it into a Linux workflow would add a check that cannot catch a regression.
 *
 *   npm run test:visual                                                           # gate
 *   npm run test:visual:update                                                    # re-record
 *
 *   npx playwright test --config=e2e/visual-regression.config.ts                  # gate
 *   npx playwright test --config=e2e/visual-regression.config.ts --update-snapshots
 */

// global-setup.ts / global-teardown.ts read this to reach the backend. They default to
// :3000, which is not where this config's backend lives.
process.env.E2E_BACKEND_URL = process.env.E2E_BACKEND_URL || 'http://localhost:3100';

const BACKEND_PORT = '3100';
const FRONTEND_PORT = '5273';

export default defineConfig({
  testDir: './specs',
  testMatch: /visual-regression\.spec\.ts/,
  // The spec seeds a full customer -> lead -> estimate -> job -> invoice -> payment chain
  // against staging over HTTP in beforeAll before it renders anything.
  timeout: 180_000,
  expect: {
    timeout: 15_000,
    toHaveScreenshot: {
      // Playwright's default per-pixel colour threshold (0.2, YIQ) already absorbs
      // font-antialiasing noise. maxDiffPixels is the only tolerance added, and it is set
      // two orders of magnitude below the smallest change worth catching: a 4px height
      // move on a single 80px-wide control is ~320 differing pixels, and any real
      // token/geometry regression is far larger. It exists only so a stray sub-pixel row
      // cannot red the gate.
      maxDiffPixels: 100,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  fullyParallel: false,
  workers: 1,
  // A visual gate must never retry-mask a flake: a retry that passes would hide exactly the
  // instability that makes a baseline worthless.
  retries: 0,
  globalTeardown: path.resolve(__dirname, 'global-teardown.ts'),
  // Both run artifacts are written INSIDE directories `.gitignore` already covers
  // (`frontend/playwright-report/`, `frontend/test-results/`), so a failed run cannot leave
  // multi-megabyte traces and diff PNGs staged for someone else to commit by accident. The
  // committed artifact of this suite is `visual-baselines/` and nothing else.
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: path.resolve(ROOT, 'playwright-report', 'visual') }],
  ],
  outputDir: path.resolve(ROOT, 'test-results', 'visual'),

  // Baselines live beside the spec suite, not under test-results (which is gitignored).
  // These PNGs are the reviewed artifact and are committed. `{platform}` is part of the name
  // on purpose: font rasterisation differs between macOS and Linux, so a darwin baseline can
  // never be compared against a linux run. Committing `-darwin` files makes that explicit
  // instead of letting a future CI run diff against pixels it could never reproduce.
  snapshotPathTemplate: '{testDir}/../visual-baselines/{arg}-{projectName}-{platform}{ext}',

  use: {
    // NOTE: storageState is set ONLY on the chromium project, never here - a top-level
    // storageState is inherited by the `setup` project, which then tries to load
    // .auth/admin.json before setup has created it. Same trap documented in
    // playwright.config.ts.
    baseURL: `http://localhost:${FRONTEND_PORT}`,
    trace: 'retain-on-failure',
    screenshot: 'off',
    // Pinned rendering environment. `toLocaleDateString()` appears on both pages, so an
    // unpinned locale or timezone would make the baseline machine-specific.
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    viewport: { width: 1440, height: 900 },
    deviceScaleFactor: 1,
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

  webServer: [
    {
      command: 'npm run dev',
      cwd: path.resolve(ROOT, '..', 'backend'),
      port: Number(BACKEND_PORT),
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        PORT: BACKEND_PORT,
        // The /api/test/* doors global-setup provisions through. Boot-guarded: the whole
        // block is skipped when NODE_ENV=production.
        E2E_TEST_DOORS: 'true',
      },
    },
    {
      command: 'npm run dev',
      cwd: ROOT,
      port: Number(FRONTEND_PORT),
      reuseExistingServer: false,
      timeout: 60_000,
      env: {
        VITE_PORT: FRONTEND_PORT,
        VITE_BACKEND_PORT: BACKEND_PORT,
      },
    },
  ],
});
