/**
 * Mobile slice 22 (A11Y-04, SCR-01, CMP-04, TOUCH-02, CMP-10): the phone navigation drawer, with
 * the account block (clock in/out, Settings, Sign Out) at its top.
 *
 * Every project, on `home`:
 * - phones and the landscape phone (the drawer layout): the trigger is at least 44 px, the drawer
 *   opens as a dialog inside the viewport, its last entry can be scrolled to and is on screen,
 *   Create New expands in place with every label inside the viewport, and the account block is
 *   the first thing in it. The landscape phone (838x390) is wide but short: it must get the drawer
 *   too, not the inline sidebar.
 * - iPad Mini and the desktop control: no trigger, the sidebar is inline, and the avatar menu
 *   still carries Settings and Sign Out.
 *
 * The clock flow runs on the drawer projects with the timeclock API stubbed (the throwaway org has
 * no geofence and the spec must not write punches): clock in, see the running timer and the dot on
 * the trigger, clock out through the existing inline confirm.
 *
 * Sign Out is never tapped: the gate's shared session must stay signed in (it is checked as a
 * visible, named control and, in the unit suite, as a call to logout).
 *
 * MOBILE_GATE_ROUTES selects it by `home`.
 */
import { expect, type Page, type Route } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { tap } from './touch';

const selected = new Set(selectStates().map((s) => s.id));

/** The drawer layout is below md (768) or under the short-height condition (max 500 px tall). */
function drawerLayout(p: { width: number; height: number }) {
  return p.width < 768 || p.height <= 500;
}

async function open(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
}

const trigger = (page: Page) => page.getByRole('button', { name: 'Open navigation' });
const drawer = (page: Page) => page.getByRole('dialog', { name: 'Navigation' });

async function press(page: Page, touch: boolean, target: ReturnType<Page['locator']>) {
  if (touch) await tap(target); else await target.click();
}

test.describe('phone navigation drawer', () => {
  test('is a dialog inside the viewport, with Create New, the account block and a reachable last entry', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
    const device = gateDevice(testInfo.project.name);
    await signIn(page, session, []);
    await open(page);
    const vp = page.viewportSize()!;

    if (!drawerLayout(vp)) {
      // md and up on a tall screen: unchanged. No trigger; the inline sidebar; the avatar menu.
      await expect(trigger(page)).toHaveCount(0);
      await expect(page.locator('aside[data-slot="sidebar"]')).toBeVisible();
      await expect(page.getByRole('region', { name: 'Account' })).toHaveCount(0);
      await page.locator('[data-slot="topbar-user"]').click();
      await expect(page.getByRole('menuitem', { name: 'Settings' })).toBeVisible();
      await expect(page.getByRole('menuitem', { name: 'Sign Out' })).toBeVisible();
      await keepSession(page, session).catch(() => {});
      return;
    }

    // The drawer layout: no inline sidebar, a 44 px trigger.
    await expect(page.locator('aside[data-slot="sidebar"]')).toHaveCount(0);
    const t = (await trigger(page).boundingBox())!;
    expect(t.width, 'trigger width').toBeGreaterThanOrEqual(44);
    expect(t.height, 'trigger height').toBeGreaterThanOrEqual(44);

    await press(page, device.touch, trigger(page));
    const dlg = drawer(page);
    await expect(dlg).toBeVisible();
    await page.waitForTimeout(500); // the open animation
    const box = (await dlg.boundingBox())!;
    expect(box.x).toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 0.5);
    expect(box.y).toBeGreaterThanOrEqual(-0.5);
    expect(box.y + box.height, 'the drawer takes the visible height').toBeLessThanOrEqual(vp.height + 0.5);
    expect(box.height).toBeGreaterThanOrEqual(vp.height - 1);

    // The account block is the first thing in it.
    const account = dlg.getByRole('region', { name: 'Account' });
    await expect(account).toBeVisible();
    await expect(account.getByRole('button', { name: 'Settings' })).toBeVisible();
    await expect(account.getByRole('button', { name: 'Sign Out' })).toBeVisible();
    const accountTop = (await account.boundingBox())!.y;
    const createTop = (await dlg.getByRole('button', { name: 'Create New' }).boundingBox())!.y;
    expect(accountTop).toBeLessThan(createTop);

    // Create New expands in place; every row is inside the viewport.
    await press(page, device.touch, dlg.getByRole('button', { name: 'Create New' }));
    const rows = dlg.locator('.sb-create-row');
    await expect(rows.first()).toBeVisible();
    for (const row of await rows.all()) {
      await row.scrollIntoViewIfNeeded();
      const b = (await row.boundingBox())!;
      expect(b.x, 'a Create New row starts inside the viewport').toBeGreaterThanOrEqual(0);
      expect(b.x + b.width, 'a Create New row ends inside the viewport').toBeLessThanOrEqual(vp.width + 0.5);
      if (device.touch) expect(b.height, 'a Create New row is at least 44 px').toBeGreaterThanOrEqual(43.5);
    }
    // The text itself is not clipped by the row.
    const clipped = await rows.evaluateAll((els) => els.filter((e) => e.scrollWidth > e.clientWidth + 1).length);
    expect(clipped).toBe(0);

    // The last entry is reachable: scroll the drawer to its end and it is on screen and not covered.
    const last = dlg.locator('aside[data-slot="sidebar"] a, aside[data-slot="sidebar"] button').last();
    await last.scrollIntoViewIfNeeded();
    const lb = (await last.boundingBox())!;
    expect(lb.y + lb.height).toBeLessThanOrEqual(vp.height + 0.5);
    expect(lb.y).toBeGreaterThanOrEqual(-0.5);
    const covered = await last.evaluate((el) => {
      const r = el.getBoundingClientRect();
      const top = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      return !(top && (el === top || el.contains(top)));
    });
    expect(covered, 'the last entry is not covered').toBe(false);

    // Escape closes it and puts focus back on the trigger.
    await page.keyboard.press('Escape');
    await expect(dlg).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
    await keepSession(page, session).catch(() => {});
  });

  test('clock in, the running timer and the dot, then clock out through the existing confirm', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
    const device = gateDevice(testInfo.project.name);
    await signIn(page, session, []);
    const vp = page.viewportSize()!;
    test.skip(!drawerLayout(vp), 'the drawer layout only');

    const punches: Array<Record<string, unknown>> = [];
    const punch = (type: 'IN' | 'OUT') => ({
      id: `p-${punches.length + 1}`, userId: 'u', userName: 'Gate Admin', type, ts: Date.now(),
      lat: 40, lng: -74, matchedZoneId: null, matchedZoneLabel: null, matchedZoneKind: null, matchedJobNumber: null,
      distanceM: 0, status: 'in_zone', review: 'none',
    });
    await page.context().route(/\/api\/timeclock\/punches/, async (route: Route) => {
      const req = route.request();
      if (req.method() === 'POST') {
        const body = req.postDataJSON() as { type: 'IN' | 'OUT' };
        const p = punch(body.type);
        punches.push(p);
        return route.fulfill({ status: 201, contentType: 'application/json', body: JSON.stringify({ punch: p }) });
      }
      return route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ punches }) });
    });
    await page.context().grantPermissions(['geolocation']);
    await page.context().setGeolocation({ latitude: 40, longitude: -74 });

    await open(page);
    await expect(trigger(page)).not.toHaveAccessibleDescription('On the clock');

    // Two taps: the trigger, then Clock In.
    await press(page, device.touch, trigger(page));
    const account = drawer(page).getByRole('region', { name: 'Account' });
    await press(page, device.touch, account.getByRole('button', { name: /Clock In/ }));
    await expect(account.getByText(/On the clock/)).toBeVisible();
    await expect(account.getByText(/\d\d:\d\d:\d\d/)).toBeVisible();
    const clockBox = (await account.getByRole('button', { name: /Clock Out/ }).boundingBox())!;
    expect(clockBox.x + clockBox.width).toBeLessThanOrEqual(vp.width + 0.5);
    if (device.touch) expect(clockBox.height, 'Clock Out is at least 44 px').toBeGreaterThanOrEqual(43.5);

    // Shut the drawer: the dot is on the trigger, with its description.
    await page.keyboard.press('Escape');
    await expect(trigger(page)).toHaveAccessibleDescription('On the clock');
    await expect(trigger(page).locator('[data-slot="topbar-nav-status"]')).toBeAttached();

    // Clock out through the inline confirm.
    await press(page, device.touch, trigger(page));
    await press(page, device.touch, account.getByRole('button', { name: /Clock Out/ }));
    await expect(account.getByText(/End your shift after/)).toBeVisible();
    await press(page, device.touch, account.getByRole('button', { name: 'Clock Out', exact: true }));
    await expect(account.getByRole('button', { name: /Clock In/ })).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(trigger(page)).not.toHaveAccessibleDescription('On the clock');
    await keepSession(page, session).catch(() => {});
  });
});
