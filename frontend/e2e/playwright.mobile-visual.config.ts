import { defineConfig } from '@playwright/test';
import path from 'path';
import { fileURLToPath } from 'url';
import base from './playwright.mobile.config';
import { deviceUse, gateDevice } from './mobile/devices';
import { VISUAL_DEVICES } from './mobile/visual-states';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, '..');

/**
 * The phone visual baselines (mobile slice 74): `mobile/phone-visual.spec.ts`. How it works and what
 * it photographs: that file's header and `mobile/README.md`.
 *
 * It rides the mobile gate's own plumbing: the same doored API on the STAGING database and dev
 * server (ports derived from this checkout, so a run never borrows another worktree's), the same
 * session fixture and the same teardown of the throwaway org. What differs is the part a pixel
 * comparison needs: its own org seeded with fixed literals (`visual-setup.ts`), one worker pair, no
 * retries (a retry that passes hides exactly the instability that makes a baseline worthless), and
 * a pinned rendering environment (locale, timezone, light scheme) like the desktop gate's.
 *
 * PLATFORM LIMITATION, as for `visual-regression.config.ts`: THIS IS A LOCAL, macOS-ONLY DEVELOPER
 * GATE, not a CI gate and never to be described as one. `{platform}` is part of every baseline's
 * name, so a Linux run finds no file, writes its own PNGs to a new path and compares nothing. Run it
 * on macOS or do not claim it ran.
 *
 *   npm run test:mobile:visual                                          # gate
 *   npm run test:mobile:visual:update                                   # re-record
 */
export default defineConfig({
  ...base,
  testMatch: /phone-visual\.spec\.ts/,
  // A visual gate must never retry-mask a flake.
  retries: 0,
  fullyParallel: true,
  workers: Number(process.env.MOBILE_VISUAL_WORKERS || 2),
  reporter: [
    ['list'],
    ['html', { open: 'never', outputFolder: path.resolve(ROOT, 'playwright-report', 'mobile-visual') }],
  ],
  outputDir: './test-results-mobile/visual-artifacts',
  expect: {
    ...base.expect,
    toHaveScreenshot: {
      // Playwright's default per-pixel colour threshold already absorbs font-antialiasing noise;
      // maxDiffPixels is the only tolerance added (see mobile/phone-visual.spec.ts).
      maxDiffPixels: 100,
      animations: 'disabled',
      caret: 'hide',
      scale: 'css',
    },
  },
  // Committed baselines, one file per photograph, device and platform:
  //   e2e/visual-baselines/phone/<state>-<device>-darwin.png
  snapshotPathTemplate: '{testDir}/../visual-baselines/phone/{arg}-{projectName}-{platform}{ext}',
  use: {
    ...base.use,
    locale: 'en-US',
    timezoneId: 'UTC',
    colorScheme: 'light',
    trace: 'retain-on-failure',
    screenshot: 'off',
  },
  projects: [
    { name: 'setup', testMatch: /visual-setup\.ts/ },
    ...VISUAL_DEVICES.map((d) => ({
      name: d.id,
      testMatch: /phone-visual\.spec\.ts/,
      use: deviceUse(gateDevice(d.id)),
      dependencies: ['setup'],
    })),
  ],
});
