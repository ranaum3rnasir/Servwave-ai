/**
 * Mobile slice 29: Settings > Users & Teams and Settings > Roles & Permissions on a phone and an
 * iPad, with the shared Settings shell around them.
 *
 * Measured on staging before the slice (and handed over by slice 17's verifier): at 320 px the
 * roles matrix box was 29 px wide and its pinned Module column sat at -67 px (module names cut to
 * "Cu", "Le"), because a fixed 224 px roles list sat beside the detail at every width. On the iPad
 * the Settings side nav (224 px) beside the app sidebar left the page about 260 px, which pushed
 * the header strip's Close (and Users' Invite User) past the right edge.
 *
 * On every device project it measures:
 *   - the page never scrolls sideways;
 *   - the header strip's Save Changes and Close settings, and Users' Invite User, sit inside the
 *     viewport;
 *   - below 1024 px the page picker replaces the side nav (both cannot fit beside the app
 *     sidebar there); from 1024 px the side nav is shown, as before;
 *   - Roles: the switch editor does not make the page scroll sideways; every role in the roles list
 *     is on screen;
 *   - Users: below md (768 px) the users render as cards with no table; from md the table, as
 *     before.
 *
 * Runs with the gate (same projects, same session slots). MOBILE_GATE_ROUTES selects it with
 * `settings-roles` and `settings-users`. Read-only: it never saves.
 */
import { expect, type Page } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';

const selected = new Set(selectStates().map((s) => s.id));

interface Edges { left: number; right: number; width: number }

async function edges(page: Page, selector: string): Promise<Edges | null> {
  return page.evaluate((sel) => {
    const el = document.querySelector(sel) as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return null;
    return { left: r.left, right: r.right, width: r.width };
  }, selector);
}

async function expectInViewport(page: Page, name: string, box: Edges | null) {
  const vw = await page.evaluate(() => document.documentElement.clientWidth);
  expect(box, `${name} is rendered`).not.toBeNull();
  expect(box!.left, `${name} starts inside the viewport`).toBeGreaterThanOrEqual(-1);
  expect(box!.right, `${name} ends inside the viewport (${vw} px)`).toBeLessThanOrEqual(vw + 1);
}

async function shellChecks(page: Page, viewportWidth: number) {
  const r = await page.evaluate(() => ({
    pageScroll: document.documentElement.scrollWidth,
    vw: document.documentElement.clientWidth,
  }));
  expect(r.pageScroll, 'the page itself never scrolls sideways').toBeLessThanOrEqual(r.vw);

  const save = page.getByRole('button', { name: /^(Save Changes|Saving\.\.\.)$/ });
  const sb = await save.boundingBox();
  await expectInViewport(page, 'Save Changes', sb ? { left: sb.x, right: sb.x + sb.width, width: sb.width } : null);
  await expectInViewport(page, 'Close settings', await edges(page, 'button[aria-label="Close settings"]'));

  const sideNav = await edges(page, 'nav[aria-label="Settings"]');
  const picker = await edges(page, '[aria-label="Settings page"]');
  if (viewportWidth < 1024) {
    expect(sideNav, 'below 1024 px the Settings side nav is hidden').toBeNull();
    expect(picker, 'below 1024 px the page picker is shown').not.toBeNull();
  } else {
    expect(sideNav, 'from 1024 px the Settings side nav is shown').not.toBeNull();
    expect(picker, 'from 1024 px the page picker is hidden').toBeNull();
  }
}

test('settings roles: the switch editor fits the screen and the roles list is reachable', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('settings-roles'), 'MOBILE_GATE_ROUTES does not select settings-roles');
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  try {
    await page.goto('/settings/roles', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, notes);
    // From xl the roles are a side column of buttons; below it they are one picker.
    const list = page.locator('[data-roles-list]');
    const picker = page.getByRole('combobox', { name: 'Role' });
    await expect(list.or(picker)).toBeVisible({ timeout: 20_000 });
    await page.evaluate(() => document.fonts.ready);
    const asColumn = await list.isVisible();
    // Pick the second role, which draws the switch editor (the first is the Administrator's full-access box).
    if (asColumn) {
      await list.locator('button').nth(1).click();
    } else {
      await picker.click();
      await page.getByRole('option').nth(1).click();
    }
    await expect(page.getByRole('region', { name: 'Data Scope' })).toBeVisible({ timeout: 20_000 });

    const m = await page.evaluate((column) => {
      const vw = document.documentElement.clientWidth;
      const roleControls = column ? '[data-roles-list] button' : '[role="combobox"][aria-label="Role"]';
      const roleButtonsOff = [...document.querySelectorAll(roleControls)]
        .filter((x) => { const r = x.getBoundingClientRect(); return r.left < -1 || r.right > vw + 1; })
        .map((x) => (x as HTMLElement).innerText.trim());
      return {
        pageScrollsSideways: document.documentElement.scrollWidth > vw + 1,
        roleButtonsOff,
        roleButtons: document.querySelectorAll(roleControls).length,
      };
    }, asColumn);
    await testInfo.attach('roles-editor.json', { body: JSON.stringify({ device: device.id, asColumn, ...m, notes }, null, 1), contentType: 'application/json' });

    expect(m.pageScrollsSideways, 'the switch editor makes the page scroll sideways').toBe(false);
    expect(m.roleButtons, 'the roles list is rendered').toBeGreaterThan(0);
    expect(m.roleButtonsOff, 'roles in the roles list that are off screen').toEqual([]);
    await shellChecks(page, (page.viewportSize()?.width ?? 0));
  } finally {
    await keepSession(page, session);
  }
});

test('settings users: cards below md, and Invite User and Close are on screen', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('settings-users'), 'MOBILE_GATE_ROUTES does not select settings-users');
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  try {
    await page.goto('/settings/users', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, notes);
    const invite = page.getByRole('button', { name: '+ Invite User' });
    await expect(invite).toBeVisible({ timeout: 20_000 });
    const ib = await invite.boundingBox();
    await expectInViewport(page, 'Invite User', ib ? { left: ib.x, right: ib.x + ib.width, width: ib.width } : null);

    const table = page.locator('[data-mobile-scroll-x="settings-users"]');
    const cards = page.getByRole('list', { name: 'Users' });
    if ((page.viewportSize()?.width ?? 0) < 768) {
      await expect(cards, 'below md the users render as cards').toBeVisible({ timeout: 20_000 });
      await expect(cards.getByRole('listitem').first()).toBeVisible();
      await expect(table, 'below md there is no users table').toHaveCount(0);
      const off = await page.evaluate(() => {
        const vw = document.documentElement.clientWidth;
        return [...document.querySelectorAll('[aria-label="Users"] li *')]
          .filter((x) => { const r = x.getBoundingClientRect(); return r.width > 0 && (r.left < -1 || r.right > vw + 1); })
          .map((x) => `${x.tagName} ${(x as HTMLElement).innerText?.trim().slice(0, 30)}`);
      });
      expect(off, 'card content past the viewport edge').toEqual([]);
    } else {
      await expect(table, 'from md the users table, as before').toBeVisible({ timeout: 20_000 });
      await expect(cards).toHaveCount(0);
    }
    await shellChecks(page, (page.viewportSize()?.width ?? 0));
  } finally {
    await keepSession(page, session);
  }
});
