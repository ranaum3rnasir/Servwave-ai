/**
 * Mobile slice 34 (SCR-01, SCR-03, VP-04, VP-06, VP-12): the page frame fits the visible screen and
 * scrolls correctly.
 *
 * - login and the invite form: html/body never scroll, so the page's own bounded scroller must carry
 *   the form to its last control on every device (the 390 px tall landscape phone is the hard one).
 *   Reached means: scrolled into view and hit-testing to the control (so a tap lands on it). Nothing
 *   is tapped, because the controls start a sign-in with the auth provider.
 * - the shell's scroller: a forward navigation from a scrolled list opens the next page at the top,
 *   Back returns to the scroll position the list was left at.
 * - the frame is the dynamic viewport height, and the page scroller contains overscroll.
 *
 * MOBILE_GATE_ROUTES selects by state id: `login`, `accept-invite`, `customers`.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';

const selected = new Set(selectStates().map((s) => s.id));

/**
 * Bring `target` into view the way a USER can: only through a scroller the user can drive
 * (overflow auto or scroll). Playwright's own scrollIntoView would also move an overflow:hidden
 * box that no finger or wheel can move, and so hide exactly the defect this guards. Then hit-test
 * the target's centre, so a tap lands on it.
 */
async function reachable(page: Page, target: Locator, what: string) {
  await target.evaluate((el) => {
    for (let a = el.parentElement; a; a = a.parentElement) {
      if (!/(auto|scroll)/.test(getComputedStyle(a).overflowY) || a.scrollHeight <= a.clientHeight) continue;
      const ar = a.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const bottom = Math.min(innerHeight, ar.bottom);
      const top = Math.max(0, ar.top);
      if (r.bottom > bottom) a.scrollTop += r.bottom - bottom + 8;
      else if (r.top < top) a.scrollTop -= top - r.top + 8;
    }
  });
  await page.waitForTimeout(300);
  const result = await target.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const cx = Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2));
    const cy = Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2));
    const hit = document.elementFromPoint(cx, cy);
    return {
      inView: r.top >= -1 && r.bottom <= innerHeight + 1,
      topmost: !!hit && (hit === el || el.contains(hit) || (hit.tagName === 'LABEL' && (hit as HTMLLabelElement).control === el)),
      rect: [Math.round(r.top), Math.round(r.bottom), innerHeight],
    };
  });
  expect(result.inView, `${what} is on screen (top, bottom, viewport: ${result.rect.join(', ')})`).toBe(true);
  expect(result.topmost, `${what} is the topmost element at its centre`).toBe(true);
}

test.describe('page frame (mobile slice 34)', () => {
  test('login: the social sign-in button can be scrolled to and tapped', async ({ page }) => {
    test.skip(!selected.has('login'), 'login not selected');
    const notes: string[] = [];
    await page.goto('/login', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, notes);
    await reachable(page, page.getByRole('button', { name: 'Sign in with Google' }), 'Sign in with Google');
    // The document must not be the thing that scrolled: html/body are fixed to the screen.
    expect(await page.evaluate(() => document.scrollingElement!.scrollTop)).toBe(0);
  });

  test('accept-invite: the form scrolls to its last control', async ({ page }) => {
    test.skip(!selected.has('accept-invite'), 'accept-invite not selected');
    const notes: string[] = [];
    // A valid invite, answered locally: the real lookup would need a live single-use token.
    await page.route('**/api/auth/invite', (route) =>
      route.fulfill({ json: { email: 'gate.invitee@example.com', first_name: 'Gate', phone: null, phone_ext: null } }),
    );
    await page.goto('/accept-invite?token=gate-token', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, notes);
    await expect(page.getByLabel('Confirm password')).toBeVisible({ timeout: 20_000 });
    await reachable(page, page.getByLabel('Phone number'), 'the Phone number field');
    // The consent row is the form's last field; the buttons below it stay disabled until it is ticked.
    const consent = page.getByRole('checkbox');
    await reachable(page, consent, 'the consent checkbox');
    await consent.click();
    await reachable(page, page.getByRole('button', { name: 'Set password & sign in' }), 'Set password & sign in');
    await reachable(page, page.getByRole('button', { name: 'Continue with Google' }), 'Continue with Google');
    await reachable(page, page.getByLabel('Password', { exact: true }), 'the first field (Password)');
  });

  test('customers: forward opens at the top, Back restores the scroll position', async ({ page, session }) => {
    test.skip(!selected.has('customers'), 'customers not selected');
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      await page.goto('/customers', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      // Make every page tall enough to scroll on any device, whatever the throwaway org holds.
      await page.addStyleTag({ content: 'main[data-slot="app-canvas-body"] > * { min-height: 2400px; }' });
      const main = page.locator('main[data-slot="app-canvas-body"]');
      // Add Customer is a router navigation (a PUSH) from the top of the list.
      const link = main.getByRole('button', { name: 'Add Customer' });
      await expect(link).toBeAttached({ timeout: 20_000 });

      await main.evaluate((el) => { el.scrollTop = 600; });
      await page.waitForTimeout(300);
      const before = await main.evaluate((el) => el.scrollTop);
      expect(before, 'the list scrolled').toBeGreaterThan(300);

      await link.evaluate((el) => (el as HTMLElement).click()); // the button navigates with a PUSH
      await page.waitForURL(/\/customers\/new$/, { timeout: 20_000 });
      await settle(page, notes);
      await page.waitForTimeout(500);
      expect(await main.evaluate((el) => el.scrollTop), 'the page reached by a forward navigation opens at the top').toBe(0);

      await page.goBack();
      await page.waitForURL(/\/customers$/, { timeout: 20_000 });
      await expect.poll(() => main.evaluate((el) => Math.round(el.scrollTop)), { timeout: 5_000 }).toBeGreaterThan(before - 2);
      expect(await main.evaluate((el) => Math.round(el.scrollTop))).toBeLessThanOrEqual(before + 2);
    } finally {
      await keepSession(page, session);
    }
  });

  test('customers: the frame is the dynamic viewport and the page scroller contains overscroll', async ({ page, session }) => {
    test.skip(!selected.has('customers'), 'customers not selected');
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      await page.goto('/customers', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      const frame = await page.evaluate(() => {
        const app = document.querySelector('[data-slot="app-shell"]')!;
        const main = document.querySelector('main[data-slot="app-canvas-body"]')!;
        const probe = document.createElement('div');
        probe.style.cssText = 'position:fixed;visibility:hidden;height:100dvh;width:1px';
        document.body.append(probe);
        const dvh = probe.getBoundingClientRect().height;
        probe.remove();
        return {
          app: Math.round(app.getBoundingClientRect().height),
          dvh: Math.round(dvh),
          overscroll: getComputedStyle(main).overscrollBehaviorY,
          appHeightRule: getComputedStyle(app).height,
        };
      });
      expect(frame.app, 'the frame is exactly the dynamic viewport height').toBe(frame.dvh);
      expect(frame.overscroll).toBe('contain');
    } finally {
      await keepSession(page, session);
    }
  });
});
