/**
 * The technician job-completion flow, on every device of the full sweep (mobile slice 62; the
 * audit's rubric names it as a required runtime flow and never drove it).
 *
 * A fresh scheduled job (made through the API, so each device gets its own and the shared
 * key-route job is never changed) is opened and worked the way a technician works it: the visit's
 * Mark on the way, Mark on site, Start work and Finish visit, then the job's Complete job (a visit is
 * finished and a job is completed; the visit's last step was "Complete" before Roles & Permissions S04.15).
 * At every step the control must be reachable by the way the device is driven (a tap on a touch
 * screen, a click on the desktop control): inside the viewport, and the
 * topmost element at its centre, so nothing covers it. The job must then read Completed.
 *
 * It signs in as the throwaway org's admin, who holds every technician capability (the seeded
 * technician has no login in the gate). It writes only to the throwaway org, which the run tears
 * down; it never sends anything.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'node:fs';
import { ApiClient } from '../helpers/api-client';
import { gateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import type { GateFixtures } from './routes';
import { scheduledJob } from './seed';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

/** The control is on screen and nothing covers its centre: a person could press it. */
async function expectReachable(page: Page, loc: Locator, label: string) {
  await loc.scrollIntoViewIfNeeded();
  const box = await loc.boundingBox();
  expect(box, `${label} is laid out`).not.toBeNull();
  const vp = page.viewportSize()!;
  expect(box!.x, `${label} left edge on screen`).toBeGreaterThanOrEqual(-1);
  expect(box!.x + box!.width, `${label} right edge on screen at ${vp.width}px`).toBeLessThanOrEqual(vp.width + 1);
  expect(box!.y, `${label} top edge on screen`).toBeGreaterThanOrEqual(-1);
  expect(box!.y + box!.height, `${label} bottom edge on screen at ${vp.height}px`).toBeLessThanOrEqual(vp.height + 1);
  const covered = await loc.evaluate((el, [x, y]) => {
    const top = document.elementFromPoint(x as number, y as number);
    return !top || !(el === top || el.contains(top) || top.contains(el));
  }, [box!.x + box!.width / 2, box!.y + box!.height / 2]);
  expect(covered, `something covers the centre of ${label}`).toBe(false);
}

test('technician flow: work the visit, then Complete job, each in reach', async ({ page, session }, testInfo) => {
  const device = gateDevice(testInfo.project.name);
  const api = await new ApiClient().init();
  let jobId: string;
  try {
    jobId = (await scheduledJob(api, fixtures().techId)).jobId;
  } finally {
    await api.dispose();
  }

  await signIn(page, session, []);
  try {
    await page.goto(`/jobs/${jobId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    await expect(page.getByTestId('error-boundary-fallback')).toHaveCount(0);

    // 1. Work the visit through its lifecycle: the visit card offers ONE next step at a time
    //    (Mark on the way, Mark on site, Start work, Finish visit), and each tap must reveal the next.
    //    The last step is the visit's "Finish visit"; the JOB's "Complete job" is step 2 below.
    const steps = ['Mark on the way', 'Mark on site', 'Start work'];
    for (const [i, label] of steps.entries()) {
      const step = page.getByRole('button', { name: label, exact: true }).first();
      await expect(step, `the visit offers "${label}"`).toBeVisible({ timeout: 20_000 });
      await expectReachable(page, step, label);
      await press(device.touch, step);
      const next = i + 1 < steps.length ? steps[i + 1]! : 'Finish visit';
      await expect(page.getByRole('button', { name: next, exact: true }).first(), `after "${label}" the visit offers "${next}"`).toBeVisible({ timeout: 20_000 });
    }

    // 2. Complete job: the header action from sm up, the bottom dock on a phone. Exactly one.
    const complete = page.getByRole('button', { name: /Complete job/ });
    await expect(complete, 'exactly one Complete job').toHaveCount(1, { timeout: 20_000 });
    await expectReachable(page, complete, 'Complete job');
    await press(device.touch, complete);

    // 3. Done: nothing left to complete, and the job says so.
    await expect(complete, 'Complete job is gone once the job is complete').toHaveCount(0, { timeout: 20_000 });
    await expect(page.getByText(/Completed/).first()).toBeVisible();
    await testInfo.attach('technician-flow.json', { body: JSON.stringify({ device: device.id, job: 'completed' }), contentType: 'application/json' });
  } finally {
    await keepSession(page, session);
  }
});
