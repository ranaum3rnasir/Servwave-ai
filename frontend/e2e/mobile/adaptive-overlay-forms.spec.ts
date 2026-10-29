/**
 * Mobile slice 26 (CMP-03, CMP-08, VP-04 overlays, SCR-01 overlays, TOUCH-02 close): the four
 * first form dialogs of the adaptive overlay (New Task, Add Item, New Plan, New Estimate).
 *
 * - Phones (320, 360, 393) and the landscape phone (838x390, wide but short): the dialog fills the
 *   whole screen, the close is at least 44 px, the primary action (where the dialog has one) is
 *   on screen without scrolling, and a field focused at the end of the form sits between the
 *   header's close and the footer's action, never behind them.
 * - The tablet (768x1024) and the desktop control: still a centred card, as today.
 *
 * The red side of this slice is the Vitest suite adaptive-overlay.test.tsx, seen failing before the
 * change; this spec was not re-run against the old dialogs. MOBILE_GATE_ROUTES selects each dialog by
 * its page's route id (`tasks`, `inventory`, `service-plans`, `estimates`). Nothing is saved.
 */
import { expect, type Page } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));

interface Dialog {
  route: string;
  path: string;
  opener: RegExp;
  dialogName: string;
  /** The footer action the user must always be able to reach; none where the dialog has no footer. */
  action: string | null;
}

const DIALOGS: Dialog[] = [
  { route: 'tasks', path: '/tasks', opener: /^\s*New Task\s*$/, dialogName: 'New Task', action: 'Create' },
  { route: 'inventory', path: '/inventory', opener: /^\s*Add Item\s*$/, dialogName: 'Add Item to Stock', action: 'Save Item' },
  { route: 'service-plans', path: '/service-plans', opener: /^\s*New Plan\s*$/, dialogName: 'New service plan', action: 'Create draft' },
  { route: 'estimates', path: '/estimates', opener: /^\s*New Estimate\s*$/, dialogName: 'Create New Estimate', action: null },
];

/** Full-screen devices: below md (the three phones) or a short landscape window. */
const FULLSCREEN = new Set(['iphone-se', 'galaxy-s24', 'iphone-15', 'landscape-phone']);

async function open(page: Page, d: Dialog, touch: boolean) {
  await page.goto(d.path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
  const btn = page.locator('main').getByRole('button', { name: d.opener }).first();
  await expect(btn).toBeVisible({ timeout: 20_000 });
  await press(touch, btn, { timeout: 15_000 });
  const dialog = page.getByRole('dialog', { name: d.dialogName });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500); // the open animation
  return dialog;
}

for (const d of DIALOGS) {
  test(`${d.dialogName}: full-screen with Close and the action in reach on phones, a card elsewhere`, async ({ page, session }, testInfo) => {
    test.skip(!selected.has(d.route), `MOBILE_GATE_ROUTES does not select ${d.route}`);
    const device = gateDevice(testInfo.project.name);
    await signIn(page, session, []);
    try {
      const dialog = await open(page, d, device.touch);
      const vp = page.viewportSize()!;
      const box = (await dialog.boundingBox())!;
      const close = dialog.getByRole('button', { name: 'Close', exact: true }).first();
      const closeBox = (await close.boundingBox())!;

      if (FULLSCREEN.has(device.id)) {
        expect(Math.round(box.x), 'starts at the left edge').toBe(0);
        expect(Math.round(box.y), 'starts at the top edge').toBe(0);
        expect(Math.round(box.width), 'spans the width').toBe(vp.width);
        expect(Math.round(box.height), 'spans the whole (short) height').toBe(vp.height);
        expect(closeBox.width, 'close is 44 px wide').toBeGreaterThanOrEqual(43.5);
        expect(closeBox.height, 'close is 44 px tall').toBeGreaterThanOrEqual(43.5);
        expect(closeBox.x + closeBox.width, 'close inside the right edge').toBeLessThanOrEqual(vp.width + 0.5);
        expect(closeBox.y, 'close inside the top edge').toBeGreaterThanOrEqual(0);

        let actionTop = vp.height;
        if (d.action) {
          const action = dialog.getByRole('button', { name: d.action, exact: true });
          await expect(action).toBeVisible();
          const a = (await action.boundingBox())!;
          expect(a.y + a.height, 'the action is on screen without scrolling').toBeLessThanOrEqual(vp.height + 0.5);
          expect(a.y, 'the action is below the header').toBeGreaterThan(closeBox.y + closeBox.height - 1);
          actionTop = a.y;
        }

        // A field focused at the end of the form is never behind the header or the footer.
        const last = dialog.locator('input:visible:not([type=checkbox]):not([type=radio]):not([type=file]), textarea:visible').last();
        await last.focus();
        await page.waitForTimeout(300);
        const f = (await last.boundingBox())!;
        expect(f.y, 'the focused field is below the close').toBeGreaterThanOrEqual(closeBox.y + closeBox.height - 1);
        expect(f.y + f.height, 'the focused field is above the footer action').toBeLessThanOrEqual(actionTop + 0.5);
      } else {
        expect(box.width, 'a card, not edge to edge').toBeLessThan(vp.width);
        expect(box.x, 'a card, centred with room each side').toBeGreaterThan(8);
      }
    } finally {
      await keepSession(page, session).catch(() => {});
    }
  });
}
