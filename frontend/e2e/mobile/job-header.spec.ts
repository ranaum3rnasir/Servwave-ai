/**
 * Mobile slice 41: the job page header on the six device projects.
 *
 * Below sm (640 px) the header stacks: a Back control beside the title, the status row, and every
 * secondary action inside one Actions menu. Complete job lives in a bottom dock that stays inside
 * the viewport (open question with Ran: dock only on phones, header only from sm up). From sm up
 * it is the old inline cluster: no Back control, no dock.
 *
 * Read-only: Complete job is measured, never pressed.
 */
import { expect } from '@playwright/test';
import fs from 'fs';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test } from './session';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));
const SM = 640;

test('job header: Back, Actions and Complete job are in reach and 44 px on a phone; unchanged from sm up', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('job-detail'), 'MOBILE_GATE_ROUTES does not select job-detail');
  const vp = page.viewportSize()!;
  const phone = vp.width < SM;
  await signIn(page, session, []);
  try {
    await page.goto(`/jobs/${fixtures().jobId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);

    const header = page.getByTestId('detail-header');
    await expect(header).toBeVisible();
    const complete = page.getByRole('button', { name: /Complete job/ });
    const actions = header.getByRole('button', { name: 'Actions' });
    await expect(complete, 'exactly one Complete job on the page').toHaveCount(1);

    const inViewport = async (loc: typeof complete, label: string) => {
      const box = await loc.boundingBox();
      expect(box, `${label} is laid out`).not.toBeNull();
      expect(box!.x, `${label} left edge on screen`).toBeGreaterThanOrEqual(-1);
      expect(box!.x + box!.width, `${label} right edge on screen at ${vp.width}px`).toBeLessThanOrEqual(vp.width + 1);
      expect(box!.y + box!.height, `${label} bottom edge on screen at ${vp.height}px`).toBeLessThanOrEqual(vp.height + 1);
      return box!;
    };

    await testInfo.attach('job-header.json', {
      body: JSON.stringify({ width: vp.width, phone, complete: await complete.boundingBox(), actions: await actions.boundingBox() }, null, 1),
      contentType: 'application/json',
    });

    if (phone) {
      const back = page.getByRole('button', { name: 'Back to jobs' });
      await expect(back).toBeVisible();
      const backBox = await inViewport(back, 'Back');
      expect(backBox.width, 'Back is at least 44 px wide').toBeGreaterThanOrEqual(43.5);
      expect(backBox.height, 'Back is at least 44 px tall').toBeGreaterThanOrEqual(43.5);

      const dock = page.getByTestId('detail-dock');
      await expect(dock).toBeVisible();
      await expect(dock.getByRole('button', { name: /Complete job/ })).toBeVisible();
      const box = await inViewport(complete, 'Complete job');
      expect(box.height, 'Complete job is at least 44 px tall').toBeGreaterThanOrEqual(43.5);
      const dockBox = (await dock.boundingBox())!;
      expect(dockBox.y + dockBox.height, 'the dock sits at the bottom of the screen').toBeGreaterThan(vp.height - 80);

      const aBox = await inViewport(actions, 'Actions');
      expect(aBox.height, 'Actions is at least 44 px tall').toBeGreaterThanOrEqual(43.5);
      // The job number is readable: the heading is on screen and not clipped to nothing.
      const heading = page.getByRole('heading', { level: 1 }).first();
      const hBox = (await heading.boundingBox())!;
      expect(hBox.x + hBox.width, 'the job number heading fits the width').toBeLessThanOrEqual(vp.width + 1);
      expect(hBox.width, 'the job number has room').toBeGreaterThan(80);

      // The menu holds the folded-in actions and stays on screen.
      await actions.click();
      const item = page.getByRole('menuitem', { name: /New Task/ });
      await expect(item).toBeVisible();
      await inViewport(item, 'New Task menu item');
      await page.keyboard.press('Escape');
    } else {
      await expect(page.getByRole('button', { name: 'Back to jobs' })).toHaveCount(0);
      await expect(page.getByTestId('detail-dock')).toHaveCount(0);
      await inViewport(complete, 'Complete job');
      await inViewport(actions, 'Actions');
      await expect(header.getByRole('button', { name: /New Task/ })).toBeVisible();
      // Nothing in the header sticks out sideways (the iPad project is 768 px).
      const over = await header.evaluate((el) => el.scrollWidth - el.clientWidth);
      expect(over, `the header fits at ${vp.width}px`).toBeLessThanOrEqual(1);
    }
  } finally {
    await keepSession(page, session);
  }
});
