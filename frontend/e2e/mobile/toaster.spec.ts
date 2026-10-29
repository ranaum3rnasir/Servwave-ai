/**
 * Mobile slice 27 (CMP-16, TOUCH-11, A11Y-03): one toaster, placed for phones, always closable.
 *
 * Every project, on `home`: fire a default toast and a sticky error toast through the older
 * toast API (`use-toast`, the adapter the app's ~77 callers use) and measure the one toaster.
 *
 * - exactly one toaster region is mounted;
 * - below md (the phone layout) the stack is top-centre, entirely below the top bar, and inside
 *   the viewport at 320 wide; md and up keep the bottom-right corner, inside the viewport;
 * - every toast, the error that never auto-dismisses included, has a visible close button with an
 *   accessible name, at least 32 px square, and pressing it removes the toast.
 *
 * Over an open dialog (New Task, whose Radix modal sets pointer-events none on the page), a sticky
 * error toast is reachable (the point on its close hits the toast), its close removes it, and the
 * dialog stays open.
 *
 * MOBILE_GATE_ROUTES selects it by `home`.
 */
import { expect, type Page } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { openOverlay } from './openers';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));

async function fire(page: Page) {
  await page.evaluate(async () => {
    const abs = (p: string) => new URL(p, location.origin).href;
    const appToast = await import(/* @vite-ignore */ abs('/src/components/ui/use-toast.ts'));
    appToast.toast({ title: 'Gate default toast', description: 'Saved.' });
    appToast.toast({ title: 'Gate sticky error toast', variant: 'destructive', duration: Infinity });
  });
  await page.getByText('Gate sticky error toast').first().waitFor({ state: 'visible', timeout: 10_000 });
  await page.getByText('Gate default toast').first().waitFor({ state: 'visible', timeout: 10_000 });
  await page.waitForTimeout(600); // the enter animation
}

test.describe('the one toaster', () => {
  test('is placed for the device and every toast has a named, visible close', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
    const device = gateDevice(testInfo.project.name);
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      await fire(page);
      const vp = page.viewportSize()!;
      const phoneLayout = vp.width < 768;

      await expect(page.locator('[data-sonner-toaster]')).toHaveCount(1);
      const stack = page.locator('[data-sonner-toaster]');
      await expect(stack).toHaveAttribute('data-y-position', phoneLayout ? 'top' : 'bottom');
      await expect(stack).toHaveAttribute('data-x-position', phoneLayout ? 'center' : 'right');

      const toasts = page.locator('[data-sonner-toast]');
      const n = await toasts.count();
      expect(n).toBeGreaterThanOrEqual(2);
      for (let i = 0; i < n; i++) {
        const box = (await toasts.nth(i).boundingBox())!;
        expect(box.x, `toast ${i} left edge`).toBeGreaterThanOrEqual(-0.5);
        expect(box.x + box.width, `toast ${i} right edge`).toBeLessThanOrEqual(vp.width + 0.5);
        expect(box.y + box.height, `toast ${i} bottom edge`).toBeLessThanOrEqual(vp.height + 0.5);
        if (phoneLayout) {
          const bar = (await page.locator('[data-slot="topbar"]').first().boundingBox())!;
          expect(box.y, `toast ${i} must sit below the top bar`).toBeGreaterThanOrEqual(bar.y + bar.height - 0.5);
        }
        const close = toasts.nth(i).getByRole('button', { name: /close/i });
        await expect(close, `toast ${i} close`).toBeVisible();
        // Sonner scales a toast stacked behind the front one to 95%, so the size floor is read on
        // the front toast; the stacked ones must still show a named close.
        if (i === 0) {
          const c = (await close.boundingBox())!;
          expect(c.width, 'front toast close width').toBeGreaterThanOrEqual(32);
          expect(c.height, 'front toast close height').toBeGreaterThanOrEqual(32);
        }
      }

      // The sticky error closes by its button.
      const sticky = page.locator('[data-sonner-toast]', { hasText: 'Gate sticky error toast' });
      await press(device.touch, sticky.getByRole('button', { name: /close/i }));
      await expect(sticky).toHaveCount(0, { timeout: 5_000 });
    } finally {
      await keepSession(page, session).catch(() => {});
    }
  });

  // Staging fix 1: a modal sets pointer-events none on <body>, and that reached the toasts, so an
  // error toast raised from inside Send Estimate / Mark Sent could not be pressed, and pressing it
  // would have counted as a press on the scrim. The close must work, and the dialog must stay.
  test('a toast raised over an open dialog can be closed and leaves the dialog open', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
    const device = gateDevice(testInfo.project.name);
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      await page.goto('/tasks', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      const opened = await openOverlay(page, 'new', device.touch);
      expect(opened.opened, `New Task dialog: ${JSON.stringify(opened)}`).toBe(true);
      const dialog = page.getByRole('dialog').first();
      await expect(dialog).toBeVisible();
      expect(await page.evaluate(() => getComputedStyle(document.body).pointerEvents), 'the modal blocks the page behind it').toBe('none');

      await fire(page);
      const sticky = page.locator('[data-sonner-toast]', { hasText: 'Gate sticky error toast' });
      const close = sticky.getByRole('button', { name: /close/i });
      await expect(close).toBeVisible();
      // The close is what a finger or cursor reaches, not the dialog or its scrim behind it.
      const c = (await close.boundingBox())!;
      const reached = await page.evaluate(
        ({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[data-sonner-toast]'),
        { x: c.x + c.width / 2, y: c.y + c.height / 2 },
      );
      expect(reached, 'the point on the toast close hits the toast, not the dialog or scrim').toBe(true);

      await press(device.touch, close);
      await expect(sticky).toHaveCount(0, { timeout: 5_000 });
      await expect(dialog, 'closing the toast must not close the dialog').toBeVisible();
    } finally {
      await keepSession(page, session).catch(() => {});
    }
  });
});
