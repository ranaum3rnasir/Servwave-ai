/**
 * Mobile slice 70 (TOUCH-10 scheduler, PERF-04 scheduler): below lg the unscheduled-jobs bucket
 * and the search panel are not a side column but a sheet that a toolbar button opens, and a tap on
 * a job in it opens the scheduling form (date, time, crew). Native drag never starts on iOS, so
 * this is the touch path for the buckets. At lg and up the side panel stays.
 *
 * Driven on the six device projects with the slice 19 touch helpers (real touch input on the
 * touch projects, the mouse on the desktop control):
 *   - the panel is not in the DOM below lg (and, with the bucket closed, the page is under 1,500
 *     nodes at phone width), and is in the DOM at the desktop control;
 *   - the toolbar's button (in the More sheet on a phone and a phone held sideways, in the row on
 *     a tablet) is a 44 px target and opens a sheet that sits inside the screen;
 *   - tapping a job opens the form with Schedule inside the screen; Schedule saves it, and the job
 *     is on the board;
 *   - the desktop control still shows the side panel with draggable cards and has no such button.
 *
 * It creates its own unscheduled job in the gate's throwaway org (a customer and a standalone job
 * through the API, neutral names), schedules it by tap and deletes it, so MOBILE_GATE_ROUTES selects
 * it with `schedule`.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { ApiClient } from '../helpers/api-client';
import { gateCustomerWithLocation } from './gate-customer';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));
const TARGET = 44;
/** Tailwind `lg`: the side panel is a panel from here up. */
const LG = 1024;
/** The audit's budget for a phone-width page with the bucket closed. */
const NODE_BUDGET = 1500;
const PHONE_WIDTH = 768;

/**
 * An unscheduled job: a customer with a location and a standalone job, never assigned. No lead and
 * no walkthrough, so it adds nothing to the shared org's board but the one card this test moves
 * (and deletes afterwards): the gate's own checks of the schedule page measure that board.
 */
async function unscheduledJob(): Promise<{ id: string; number: string; api: ApiClient }> {
  const api = await new ApiClient().init();
  try {
    const { customerId, locationId } = await gateCustomerWithLocation(api);
    const created = await api.createJob({ customer_id: customerId, service_location_id: locationId });
    if (!created.res.ok()) throw new Error(`seed: create job failed ${created.res.status()} ${JSON.stringify(created.body).slice(0, 200)}`);
    return { id: created.body.job.id as string, number: created.body.job.job_number as string, api };
  } catch (e) {
    await api.dispose();
    throw e;
  }
}

const nodeCount = (page: Page) => page.evaluate(() => document.querySelectorAll('*').length);
const stack = (page: Page) => page.getByTestId('unassigned-buckets');

/** The bucket card for one job: the stack's own card (the one with the type accent bar). */
const card = (page: Page, number: string): Locator => stack(page).locator('div.border-l-4', { hasText: number }).first();

async function insideViewport(page: Page, el: Locator, what: string) {
  // A sheet slides in: measure where it ends, not where it is on the way.
  await el.evaluate((node) => Promise.all(node.getAnimations().map((a) => a.finished.catch(() => undefined))));
  const vp = await page.evaluate(() => ({ width: document.documentElement.clientWidth, height: window.innerHeight }));
  const b = (await el.boundingBox())!;
  expect(b, `${what} has a box`).toBeTruthy();
  expect(b.x, `${what} left edge`).toBeGreaterThanOrEqual(-0.5);
  expect(b.y, `${what} top edge`).toBeGreaterThanOrEqual(-0.5);
  expect(b.x + b.width, `${what} right edge`).toBeLessThanOrEqual(vp.width + 1);
  expect(b.y + b.height, `${what} bottom edge`).toBeLessThanOrEqual(vp.height + 1);
}

test('below lg the panel is a sheet from a toolbar button and a tap schedules a job; desktop keeps the side panel', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('schedule'), 'MOBILE_GATE_ROUTES does not select schedule');
  test.setTimeout(240_000);
  const device = gateDevice(testInfo.project.name);
  const vp = page.viewportSize()!;
  const belowLg = vp.width < LG;
  const compactToolbar = vp.width < PHONE_WIDTH || vp.height <= 500;
  const job = await unscheduledJob();
  await signIn(page, session, []);
  try {
    await page.goto('/schedule?view=day', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);

    if (!belowLg) {
      // Desktop control: the side panel is as it was, a drag source, and nothing asks for a button.
      await expect(stack(page), 'the side panel is mounted').toBeVisible({ timeout: 20_000 });
      await expect(card(page, job.number), 'the job is in the panel').toBeVisible({ timeout: 20_000 });
      await expect(card(page, job.number)).toHaveAttribute('draggable', 'true');
      await expect(page.getByRole('button', { name: /^Unscheduled jobs/ })).toHaveCount(0);
      return;
    }

    // Bucket closed: nothing of the panel is in the DOM, and the page is under the node budget.
    await expect(page.getByRole('button', { name: 'More schedule options' }).or(page.getByRole('button', { name: /^Unscheduled jobs/ })).first()).toBeVisible({ timeout: 20_000 });
    const nodes = await nodeCount(page);
    console.log(`[slice70] ${testInfo.project.name} ${vp.width}x${vp.height}: ${nodes} DOM nodes with the bucket closed`);
    testInfo.annotations.push({ type: 'dom-nodes', description: `${nodes} nodes with the bucket closed at ${vp.width}x${vp.height}` });
    if (vp.width < PHONE_WIDTH) expect(nodes, `DOM nodes at ${vp.width} with the bucket closed`).toBeLessThan(NODE_BUDGET);
    await expect(stack(page), 'the panel is not mounted').toHaveCount(0);
    await expect(page.getByPlaceholder('Search schedule...'), 'the search box is not mounted').toHaveCount(0);

    // The toolbar's way in: a row button on a tablet, a button in More on a phone.
    if (compactToolbar) {
      await press(device.touch, page.getByRole('button', { name: 'More schedule options' }));
      const options = page.getByRole('dialog', { name: 'Schedule options' });
      const entry = options.getByRole('button', { name: /^Unscheduled jobs/ });
      await expect(entry).toBeVisible();
      expect((await entry.boundingBox())!.height, 'entry height in More').toBeGreaterThanOrEqual(TARGET - 0.5);
      await press(device.touch, entry);
    } else {
      const button = page.getByRole('button', { name: /^Unscheduled jobs/ });
      await expect(button).toBeVisible();
      const b = (await button.boundingBox())!;
      expect(b.height, 'toolbar button height').toBeGreaterThanOrEqual(TARGET - 0.5);
      expect(b.width, 'toolbar button width').toBeGreaterThanOrEqual(TARGET - 0.5);
      await press(device.touch, button);
    }

    const sheet = page.getByRole('dialog', { name: 'Unscheduled jobs' });
    await expect(sheet).toBeVisible();
    await insideViewport(page, sheet, 'the sheet');
    await expect(sheet.getByPlaceholder('Search schedule...')).toBeVisible();
    const target = card(page, job.number);
    await expect(target, 'the new job is in the sheet').toBeVisible({ timeout: 20_000 });
    await expect(target, 'cards in the sheet are tapped, not dragged').toHaveAttribute('draggable', 'false');
    await insideViewport(page, target, 'the job card');

    // Tap the job: the scheduling form, with its Schedule button on screen.
    await press(device.touch, target);
    const form = page.getByRole('dialog', { name: /^Schedule/ });
    await expect(form, 'the scheduling form opens').toBeVisible();
    await expect(sheet, 'the sheet gives way to the form').toHaveCount(0);
    await expect(form.getByText('Start date')).toBeVisible();
    await expect(form.getByText('Crew')).toBeVisible();
    const save = form.getByRole('button', { name: 'Schedule', exact: true });
    await expect(save).toBeVisible();
    await insideViewport(page, form, 'the scheduling form');
    await insideViewport(page, save, 'the Schedule button');
    expect((await save.boundingBox())!.height, 'Schedule height').toBeGreaterThanOrEqual(TARGET - 0.5);

    await press(device.touch, save);
    // Nobody is on the crew: the deliberate "needs crew" confirmation stands between the tap and the save.
    const anyway = page.getByRole('button', { name: 'Schedule anyway' });
    await expect(anyway).toBeVisible();
    await press(device.touch, anyway);

    // Saved: the job is no longer unscheduled, and it is on the board the user is looking at.
    await expect.poll(async () => (await job.api.getJob(job.id)).scheduled_start, { message: 'the job was scheduled', timeout: 20_000 }).toBeTruthy();
    await expect(page.locator('.schedule-cal').getByText(job.number).first(), 'the job is on the board').toBeVisible({ timeout: 20_000 });
  } finally {
    await keepSession(page, session).catch(() => {});
    await job.api.deleteJob(job.id).catch(() => {});
    await job.api.dispose();
  }
});
