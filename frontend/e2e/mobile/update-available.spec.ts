/**
 * Mobile slice 67 (PWA-03): "Update available", applied without losing work.
 *
 * The service worker cannot be installed by the gate's dev server, so each test swaps in a small
 * stand-in for `navigator.serviceWorker` BEFORE the app boots: a page that already has a
 * controlling worker, and a registration the test can hand a "new version installed and waiting"
 * to (`window.__sw.install()`). Posting SKIP_WAITING to that waiting worker makes the stand-in
 * announce the controller change, exactly as the browser does when a real worker takes over, so
 * the app's own detection, prompt, apply and reload run unchanged.
 *
 * - With a dirty New Task form open, a waiting update shows NO prompt (it would cover the title
 *   field and could not be tapped) and is never applied: no SKIP_WAITING, no reload, the typed
 *   title still there, even with the page backgrounded. Discarding the form closes the dialog and
 *   the prompt appears; a tap on Update applies it.
 * - On a clean page, tapping Update applies it and the page reloads.
 *
 * Every device project, selected by the `tasks` route id (MOBILE_GATE_ROUTES).
 */
import { expect, type Page } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));
const TITLE = 'Half-typed task for the update check';

declare global {
  interface Window {
    __sw: { install: () => void; posted: number };
    __bootMarker?: number;
  }
}

async function installFakeWorker(page: Page) {
  await page.addInitScript(() => {
    const containerListeners: Record<string, Array<() => void>> = {};
    const regListeners: Record<string, Array<() => void>> = {};
    const workerListeners: Record<string, Array<() => void>> = {};
    const state = { install() {}, posted: 0 };
    const worker = {
      state: 'installing',
      addEventListener: (t: string, fn: () => void) => (workerListeners[t] ??= []).push(fn),
      postMessage: (msg: { type?: string }) => {
        if (msg?.type !== 'SKIP_WAITING') return;
        state.posted += 1;
        // The browser fires this on the page once the worker has taken over.
        setTimeout(() => (containerListeners.controllerchange ?? []).forEach((fn) => fn()), 50);
      },
    };
    const registration = {
      waiting: null as unknown,
      installing: null as unknown,
      update: () => Promise.resolve(),
      addEventListener: (t: string, fn: () => void) => (regListeners[t] ??= []).push(fn),
    };
    state.install = () => {
      registration.installing = worker;
      (regListeners.updatefound ?? []).forEach((fn) => fn());
      worker.state = 'installed';
      (workerListeners.statechange ?? []).forEach((fn) => fn());
    };
    Object.defineProperty(navigator, 'serviceWorker', {
      configurable: true,
      value: {
        controller: {},
        register: () => Promise.resolve(registration),
        addEventListener: (t: string, fn: () => void) => (containerListeners[t] ??= []).push(fn),
      },
    });
    window.__sw = state;
  });
}

async function openNewTask(page: Page, touch: boolean) {
  await page.goto('/tasks', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
  const btn = page.locator('main').getByRole('button', { name: /^\s*New Task\s*$/ }).first();
  await expect(btn).toBeVisible({ timeout: 20_000 });
  await press(touch, btn, { timeout: 15_000 });
  const dialog = page.getByRole('dialog', { name: 'New Task' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500); // the open animation
  return dialog;
}

const posted = (page: Page) => page.evaluate(() => window.__sw.posted);
const marker = (page: Page) => page.evaluate(() => window.__bootMarker ?? null);
/** A value on this page load only: a reload throws it away. */
const stampPage = (page: Page) => page.evaluate(() => { window.__bootMarker = 1; });

test.describe('update available', () => {
  test('a dirty New Task is never reloaded under or covered; discarding it lets the prompt and the update through', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('tasks'), 'MOBILE_GATE_ROUTES does not select tasks');
    const device = gateDevice(testInfo.project.name);
    await installFakeWorker(page);
    await signIn(page, session, []);
    try {
      const dialog = await openNewTask(page, device.touch);
      const title = dialog.getByPlaceholder('Task title');
      await title.fill(TITLE);

      await stampPage(page);
      await page.evaluate(() => window.__sw.install());

      // The prompt stays down while the dialog is open: on a phone it would sit over the Task
      // title the user is typing in, and an open dialog makes it untappable anyway.
      await page.waitForTimeout(1_000);
      await expect(page.getByText('Update available')).toHaveCount(0);

      // Backgrounding the page is a safe moment ONLY when nothing is unsaved. Here it is not.
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
        document.dispatchEvent(new Event('visibilitychange'));
      });
      await page.waitForTimeout(1_500);
      expect(await posted(page), 'no SKIP_WAITING while the form is dirty').toBe(0);
      expect(await marker(page), 'the page did not reload').toBe(1);
      await expect(title).toHaveValue(TITLE);
      await page.evaluate(() => {
        Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' });
        document.dispatchEvent(new Event('visibilitychange'));
      });

      // Discarding the form closes the dialog: the waiting update now shows its prompt (a visible
      // page waits for the tap), and a real tap on Update applies it and reloads.
      await page.keyboard.press('Escape');
      const question = page.getByRole('dialog', { name: 'Discard your changes?' });
      await expect(question).toBeVisible();
      await press(device.touch, question.getByRole('button', { name: 'Discard' }), { timeout: 10_000 });
      await expect(page.getByText('Update available')).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(1_000);
      expect(await posted(page), 'a visible, clean page waits for the tap').toBe(0);
      expect(await marker(page)).toBe(1);
      await press(device.touch, page.getByRole('button', { name: 'Update', exact: true }), { timeout: 10_000 });
      await expect.poll(() => marker(page).catch(() => null), { timeout: 15_000 }).toBeNull();
    } finally {
      await keepSession(page, session).catch(() => {});
    }
  });

  test('on a clean page, tapping Update applies it and reloads', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('tasks'), 'MOBILE_GATE_ROUTES does not select tasks');
    const device = gateDevice(testInfo.project.name);
    await installFakeWorker(page);
    await signIn(page, session, []);
    try {
      await page.goto('/tasks', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, []);
      await stampPage(page);
      await page.evaluate(() => window.__sw.install());
      await expect(page.getByText('Update available')).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(1_000);
      expect(await posted(page), 'a visible, clean page waits for the tap').toBe(0);
      expect(await marker(page)).toBe(1);

      const update = page.getByRole('button', { name: 'Update', exact: true });
      const box = await update.boundingBox();
      expect(box, 'the Update button is on screen').not.toBeNull();
      // A 36px button plus a 4px hit area above and below is a 44px target.
      expect(box!.height, 'Update is a thumb-sized button').toBeGreaterThanOrEqual(36);
      await press(device.touch, update, { timeout: 10_000 });
      await expect.poll(() => marker(page).catch(() => null), { timeout: 15_000 }).toBeNull();
    } finally {
      await keepSession(page, session).catch(() => {});
    }
  });
});
