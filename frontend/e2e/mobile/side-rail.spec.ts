/**
 * Mobile slice 56: the activity side rail on the six device projects.
 *
 * Below md (768 px) the rail reserves no width: the page content runs to the canvas edge, the
 * rail's trigger is an "Activity" entry in the header's overflow menu, and its panel opens as an
 * overlay sheet fully inside the viewport that traps focus and closes on Escape (focus goes back to
 * the menu button). From md up (iPad Mini, the landscape phone, the desktop control) the rail keeps
 * its 40 px column; its panel opens beside it inside the viewport and below the real top bar, and a
 * closed panel is inert.
 *
 * Read-only: nothing is saved. A note is never typed.
 * MOBILE_GATE_ROUTES selects it by the detail route ids below.
 */
import { expect, type Page } from '@playwright/test';
import fs from 'fs';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test } from './session';
import { gateDevice } from './devices';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));
const MD = 768;
const RAIL_PX = 40;

const CASES: Array<{ id: string; path: (f: GateFixtures) => string }> = [
  { id: 'job-detail', path: (f) => `/jobs/${f.jobId}` },
  { id: 'lead-detail', path: (f) => `/leads/${f.leadId}` },
  { id: 'invoice-detail', path: (f) => `/invoices/${f.invoiceOpen.id}` },
];

/** Whether focus is inside the open dialog (the trap's whole promise). */
const focusInside = (page: Page) =>
  page.evaluate(() => {
    const dialog = document.querySelector('[data-testid="icon-rail-sheet"]');
    return Boolean(dialog && document.activeElement && dialog.contains(document.activeElement));
  });

for (const c of CASES) {
  test(`side rail: ${c.id}`, async ({ page, session }, testInfo) => {
    test.skip(!selected.has(c.id), `MOBILE_GATE_ROUTES does not select ${c.id}`);
    const vp = page.viewportSize()!;
    const phone = vp.width < MD;
    const touch = gateDevice(testInfo.project.name).touch;
    await signIn(page, session, []);
    try {
      await page.goto(c.path(fixtures()), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, []);

      const content = page.getByTestId('icon-rail-content');
      await expect(content).toBeVisible();
      // The gutter on each side of the content, inside the canvas's own scrollbar: equal on a phone
      // (nothing is taken off the right); from md up the rail's 40 px column is extra on the right.
      const gutters = await page.evaluate(() => {
        const canvas = document.querySelector('[data-slot="app-canvas-body"]')!;
        const item = document.querySelector('[data-testid="icon-rail-content"]')!;
        const c = canvas.getBoundingClientRect();
        const k = item.getBoundingClientRect();
        return { left: k.left - c.left, right: c.left + canvas.clientWidth - k.right, width: k.width };
      });
      const extra = gutters.right - gutters.left;
      const cBox = (await content.boundingBox())!;

      await testInfo.attach('side-rail.json', {
        body: JSON.stringify({ width: vp.width, phone, content: cBox, gutters, extra }, null, 1),
        contentType: 'application/json',
      });

      if (phone) {
        await expect(page.getByTestId('icon-rail'), 'no rail column on a phone').toHaveCount(0);
        expect(extra, `no ${RAIL_PX}px column reserved at ${vp.width}px (gutters ${JSON.stringify(gutters)})`).toBeLessThanOrEqual(1);

        const trigger = page.getByTestId('detail-header').first().locator('[data-slot="detail-actions-trigger"]');
        await expect(trigger).toBeVisible();
        await press(touch, trigger, { timeout: 15_000 });
        await press(touch, page.getByRole('menuitem', { name: 'Activity' }), { timeout: 15_000 });

        const sheet = page.getByRole('dialog', { name: 'Activity' });
        await expect(sheet).toBeVisible();
        await page.waitForTimeout(500); // the slide-in finishes before the geometry is read
        const s = (await sheet.boundingBox())!;
        expect(s.x, 'sheet left edge on screen (was -40)').toBeGreaterThanOrEqual(-1);
        expect(s.y, 'sheet top edge on screen').toBeGreaterThanOrEqual(-1);
        expect(s.x + s.width, `sheet right edge on screen at ${vp.width}px (was 280)`).toBeLessThanOrEqual(vp.width + 1);
        expect(s.y + s.height, `sheet bottom edge on screen at ${vp.height}px`).toBeLessThanOrEqual(vp.height + 1);
        expect(s.width, 'the sheet fills the width').toBeGreaterThanOrEqual(vp.width - 1);

        // Focus is trapped: however far Tab goes, it stays in the sheet.
        expect(await focusInside(page), 'focus moved into the sheet').toBe(true);
        for (let i = 0; i < 12; i += 1) {
          await page.keyboard.press('Tab');
          expect(await focusInside(page), `focus still in the sheet after Tab ${i + 1}`).toBe(true);
        }

        await page.keyboard.press('Escape');
        await expect(sheet).toHaveCount(0);
        await expect(trigger, 'focus returns to the header menu button').toBeFocused();
      } else {
        const rail = page.getByTestId('icon-rail');
        await expect(rail).toBeVisible();
        expect(extra, `the rail keeps its ${RAIL_PX}px column at ${vp.width}px (gutters ${JSON.stringify(gutters)})`).toBeGreaterThanOrEqual(RAIL_PX - 1);
        const topbar = (await page.locator('[data-slot="topbar"]').boundingBox())!;
        const r = (await rail.boundingBox())!;
        expect(Math.abs(r.y - (topbar.y + topbar.height)), 'the rail starts at the real top bar edge').toBeLessThanOrEqual(1);

        const panel = page.getByTestId('icon-rail-panel');
        await expect(panel, 'a closed panel is inert').toHaveAttribute('inert', '');
        await press(touch, rail.getByRole('button', { name: 'Activity' }), { timeout: 15_000 });
        await expect(panel).not.toHaveAttribute('inert', '');
        await page.waitForTimeout(500);
        const p = (await panel.boundingBox())!;
        expect(p.x, 'panel left edge on screen').toBeGreaterThanOrEqual(-1);
        expect(p.x + p.width, `panel right edge on screen at ${vp.width}px`).toBeLessThanOrEqual(vp.width + 1);
        expect(p.y, 'panel starts below the top bar').toBeGreaterThanOrEqual(topbar.y + topbar.height - 1);
        expect(p.y + p.height, `panel bottom edge on screen at ${vp.height}px`).toBeLessThanOrEqual(vp.height + 1);
      }
    } finally {
      await keepSession(page, session);
    }
  });
}
