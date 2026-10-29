/**
 * Mobile slice 47 (PRD module 7): the staff layout loads its create dialogs on demand, and Create
 * New still opens every create flow, on every gate device.
 *
 * `SidebarCreateMenu` no longer imports the New Task and New Estimate dialogs statically (they
 * and what is under them, the date picker and the chunked upload client, were in the first script
 * every staff page downloads). They are lazy chunks, warmed when the page is idle and mounted the
 * first time they are asked for. For each of the six items in the menu this opens it from the
 * navigation drawer (phones, landscape phone) or the sidebar's menu (iPad Mini, desktop) and
 * checks that the thing it promises opens: a dialog for New Estimate and New Task, the create
 * page for the other four. The two dialogs are asked for IMMEDIATELY after the page settles, which
 * is the case where a lazy chunk could still be in flight.
 *
 * Read-only: every dialog is closed with Escape and nothing is saved. MOBILE_GATE_ROUTES selects
 * it by `home`.
 */
import { expect, type Page } from '@playwright/test';
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

const ITEMS: { label: string; dialog?: string; path?: string }[] = [
  { label: 'New Estimate', dialog: 'Create New Estimate' },
  { label: 'New Task', dialog: 'New Task' },
  { label: 'New Lead', path: '/leads/new' },
  { label: 'New Customer', path: '/customers/new' },
  { label: 'New Job', path: '/jobs/new' },
  { label: 'New Invoice', path: '/invoices/new' },
];

async function openHome(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
}

async function press(touch: boolean, target: ReturnType<Page['locator']>) {
  if (touch) await tap(target);
  else await target.click();
}

async function pickCreateItem(page: Page, touch: boolean, label: string) {
  const vp = page.viewportSize()!;
  if (drawerLayout(vp)) {
    await press(touch, page.getByRole('button', { name: 'Open navigation' }));
    const drawer = page.getByRole('dialog', { name: 'Navigation' });
    await expect(drawer).toBeVisible();
    await press(touch, drawer.getByRole('button', { name: 'Create New' }));
    await press(touch, drawer.getByRole('button', { name: label }));
  } else {
    await press(touch, page.locator('aside[data-slot="sidebar"]').getByRole('button', { name: 'Create New' }));
    await press(touch, page.getByRole('menuitem', { name: label }));
  }
}

test.describe('Create New opens every create flow', () => {
  for (const item of ITEMS) {
    test(`${item.label}`, async ({ page, session }, testInfo) => {
      test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
      const device = gateDevice(testInfo.project.name);
      await signIn(page, session, []);
      await openHome(page);

      await pickCreateItem(page, device.touch, item.label);

      if (item.dialog) {
        const dialog = page.getByRole('dialog', { name: item.dialog });
        await expect(dialog).toBeVisible({ timeout: 20_000 });
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        // And again, from the instance that is now mounted.
        await pickCreateItem(page, device.touch, item.label);
        await expect(dialog).toBeVisible({ timeout: 20_000 });
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
      } else {
        await expect.poll(() => new URL(page.url()).pathname, { timeout: 20_000 }).toBe(item.path);
      }
      await keepSession(page, session).catch(() => {});
    });
  }
});
