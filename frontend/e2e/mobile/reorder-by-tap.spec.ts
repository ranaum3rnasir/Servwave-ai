/**
 * Mobile slice 48 (PRD stories 128, 129; rubric TOUCH-10 for settings and widgets): reorder the
 * three drag-only settings lists and the dashboard widgets by TAP.
 *
 * On every device project, in the throwaway org and through the real UI and API:
 *
 *  - each of decline reasons, job sub-statuses and the Job Types list on Payments &
 *    Lists has Move up / Move down beside the drag handle; the first row cannot go up and the last
 *    cannot go down; the buttons are 44 px targets on a touch screen; tapping Move down swaps the
 *    row with the next one and the order is still there after a reload (for Job Types, after Save,
 *    as that page always saved); and the page does not scroll sideways;
 *  - the home page in edit mode has the same pair on every widget and the order persists. Below md
 *    the catalog opens as a sheet from the toolbar (it does not open with edit mode and cover the
 *    widgets), a widget hidden with its X comes back through the sheet's Add; from md up the
 *    catalog is the rail beside the widgets, as before;
 *  - on the desktop control (a mouse) drag still reorders all three lists and the widgets.
 *
 * MOBILE_GATE_ROUTES selects it with `settings-decline-reasons`,
 * `settings-job-sub-statuses`, `settings-payments` and `home`. How to run: ./README.md.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { ApiClient } from '../helpers/api-client';
import { gateDevice } from './devices';
import { settle } from './measure';
import { AUTH_DIR } from './paths';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));
/** Below md (768): the phone layout. */
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 768;

const moveUp = (page: Page) => page.locator('button[aria-label^="Move "][aria-label$=" up"]');
const moveDown = (page: Page) => page.locator('button[aria-label^="Move "][aria-label$=" down"]');

/** The names of the rows that have a Move up button, top to bottom (optionally only some of them). */
async function names(page: Page, only?: RegExp): Promise<string[]> {
  const labels = await moveUp(page).evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  const all = labels.map((l) => l.replace(/^Move /, '').replace(/ up$/, ''));
  return only ? all.filter((n) => only.test(n)) : all;
}

async function expectTouchTarget(loc: Locator, label: string) {
  await loc.scrollIntoViewIfNeeded();
  const b = (await loc.boundingBox())!;
  expect(b, `${label} is on screen`).not.toBeNull();
  expect(b.height, `${label} height`).toBeGreaterThanOrEqual(44 - 0.5);
  expect(b.width, `${label} width`).toBeGreaterThanOrEqual(44 - 0.5);
}

async function expectInsideScreen(page: Page, loc: Locator, label: string) {
  const vw = await page.evaluate(() => document.documentElement.clientWidth);
  const b = (await loc.boundingBox())!;
  expect(b, `${label} is rendered`).not.toBeNull();
  expect(b.x, `${label} starts inside the screen`).toBeGreaterThanOrEqual(-1);
  expect(b.x + b.width, `${label} ends inside the screen (${vw} px)`).toBeLessThanOrEqual(vw + 1);
}

async function expectNoSidewaysScroll(page: Page, label: string) {
  const r = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, w: window.innerWidth }));
  expect(r.doc, `${label}: the page is no wider than the screen`).toBeLessThanOrEqual(r.w);
}

/**
 * The three settings lists belong to the ORGANISATION, and the device projects run side by side in
 * one throwaway org, so two devices reordering the same list at once would corrupt each other's
 * expectations. One list test at a time, across workers, through a lock directory (mkdir is
 * atomic); a lock older than ten minutes is a crashed run's and is taken over.
 */
const LOCK = path.join(AUTH_DIR, 'reorder-by-tap.lock');
async function withListLock<T>(fn: () => Promise<T>): Promise<T> {
  const deadline = Date.now() + 15 * 60_000;
  for (;;) {
    try {
      fs.mkdirSync(LOCK);
      break;
    } catch {
      try {
        if (Date.now() - fs.statSync(LOCK).mtimeMs > 10 * 60_000) fs.rmSync(LOCK, { recursive: true, force: true });
      } catch { /* released between the two calls */ }
      if (Date.now() > deadline) throw new Error('reorder-by-tap: the list lock was never released');
      await new Promise((r) => setTimeout(r, 750));
    }
  }
  try {
    return await fn();
  } finally {
    fs.rmSync(LOCK, { recursive: true, force: true });
  }
}

const swapFirstTwo = (list: string[]) => [list[1]!, list[0]!, ...list.slice(2)];

interface ListCase {
  /** Route id (selects the spec). */
  id: string;
  path: string;
  /** Rows to consider (the seeded or built-in ones). */
  only?: RegExp;
  /** The request that saves a reorder (a tap's request is identical to a drag's). */
  saves: RegExp;
  /** For a list that saves with the page's own Save button. */
  saveButton?: boolean;
  /** Row selector for the desktop drag. */
  draggable: string;
  dragFrom: { x: number; y: number };
}

const LISTS: ListCase[] = [
  { id: 'settings-decline-reasons', path: '/settings/decline-reasons', saves: /\/lost-reason-options\/reorder/, draggable: 'div[draggable="true"]', dragFrom: { x: 10, y: 12 } },
  { id: 'settings-job-sub-statuses', path: '/settings/job-sub-statuses', only: /^Gate sub /, saves: /\/job-sub-statuses\/reorder/, draggable: 'div[draggable="true"]', dragFrom: { x: 10, y: 12 } },
  { id: 'settings-payments', path: '/settings/payments', only: /^Gate type /, saves: /\/api\/organization/, saveButton: true, draggable: 'span[draggable="true"]', dragFrom: { x: 6, y: 10 } },
];

const reorderSaved = (page: Page, re: RegExp) =>
  page.waitForResponse((r) => re.test(r.url()) && r.request().method() !== 'GET' && r.ok(), { timeout: 20_000 });

for (const list of LISTS) {
  test(`${list.id}: Move up / Move down reorder by tap, the order persists, drag still works`, async ({ page, session }, info) => {
    test.skip(!selected.has(list.id), `${list.id} not selected`);
    test.setTimeout(420_000);
    await withListLock(() => runList(list, page, session, info));
  });
}

async function runList(list: ListCase, page: Page, session: Parameters<typeof signIn>[1], info: { project: { name: string } }) {
    const device = gateDevice(info.project.name);
    const notes: string[] = [];

    // Seed what the list needs, through the API, in the throwaway org.
    const api = await new ApiClient().init();
    try {
      if (list.id === 'settings-job-sub-statuses') {
        // Once per run: the six device projects share one org, so a second device finds them there.
        const { body } = await api.raw('get', '/api/job-sub-statuses');
        const have = new Set<string>(((body.job_sub_statuses ?? []) as Array<{ label: string }>).map((r) => r.label));
        for (const label of ['Gate sub A', 'Gate sub B', 'Gate sub C']) {
          if (!have.has(label)) await api.raw('post', '/api/job-sub-statuses', { parent: 'IN_PROGRESS', label });
        }
      }
      if (list.id === 'settings-payments') {
        await api.raw('patch', '/api/organization', { job_type_options: ['Gate type A', 'Gate type B', 'Gate type C'] });
      }
    } finally {
      await api.dispose();
    }

    await signIn(page, session, notes);
    try {
      await page.goto(list.path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      await moveUp(page).first().waitFor({ state: 'visible', timeout: 30_000 });
      const tap = (loc: Locator) => press(device.touch, loc, { timeout: 15_000 });

      const before = await names(page, list.only);
      expect(before.length, 'at least two rows to reorder').toBeGreaterThanOrEqual(2);
      const [first, second] = before as [string, string];
      const last = before[before.length - 1]!;

      // The ends have nowhere to go.
      await expect(page.getByRole('button', { name: `Move ${first} down`, exact: true })).toBeEnabled();
      await expect(page.getByRole('button', { name: `Move ${second} up`, exact: true })).toBeEnabled();
      await expect(page.getByRole('button', { name: `Move ${last} down`, exact: true })).toBeDisabled();
      if (!list.only) await expect(moveUp(page).first(), 'the first row cannot go up').toBeDisabled();

      if (device.touch) {
        for (const [what, loc] of [['Move down', page.getByRole('button', { name: `Move ${first} down`, exact: true })], ['Move up', page.getByRole('button', { name: `Move ${second} up`, exact: true })]] as const) {
          await expectTouchTarget(loc, `${list.id} ${what}`);
        }
      }
      await expectInsideScreen(page, page.getByRole('button', { name: `Move ${first} down`, exact: true }), 'Move down');
      await expectNoSidewaysScroll(page, list.id);

      const save = async () => {
        if (!list.saveButton) return;
        const saved = reorderSaved(page, list.saves);
        await tap(page.getByRole('button', { name: /^Save Changes$/ }));
        await saved;
      };
      const reload = async () => {
        await page.reload({ waitUntil: 'domcontentloaded' });
        await settle(page, notes);
        await moveUp(page).first().waitFor({ state: 'visible', timeout: 30_000 });
      };

      // ---- tap Move down: the row swaps with the next one and the order is kept ----
      const saved = list.saveButton ? null : reorderSaved(page, list.saves);
      await tap(page.getByRole('button', { name: `Move ${first} down`, exact: true }));
      await saved;
      await expect.poll(() => names(page, list.only), { message: 'Move down swaps with the next row', timeout: 15_000 }).toEqual(swapFirstTwo(before));
      await save();
      await reload();
      await expect.poll(() => names(page, list.only), { message: 'the order is kept after a reload', timeout: 15_000 }).toEqual(swapFirstTwo(before));

      // ---- tap Move up: back where it was, kept again ----
      const savedUp = list.saveButton ? null : reorderSaved(page, list.saves);
      await tap(page.getByRole('button', { name: `Move ${first} up`, exact: true }));
      await savedUp;
      await expect.poll(() => names(page, list.only), { message: 'Move up swaps with the previous row', timeout: 15_000 }).toEqual(before);
      await save();
      await reload();
      await expect.poll(() => names(page, list.only), { message: 'the second move is kept after a reload', timeout: 15_000 }).toEqual(before);
      await expectNoSidewaysScroll(page, `${list.id} after moves`);

      // ---- drag still works with a mouse ----
      if (!device.touch) {
        const rows = page.locator(list.draggable);
        const n = await rows.count();
        expect(n, 'draggable rows are still there').toBeGreaterThanOrEqual(2);
        // A row is found by its own Move button: a rename field's text is a value, not content.
        const rowOf = (name: string) => rows.filter({ has: page.locator(`button[aria-label="Move ${name} up"]`) });
        const dragged = rowOf(first);
        const target = rowOf(second);
        const savedDrag = list.saveButton ? null : reorderSaved(page, list.saves);
        await dragged.first().dragTo(target.first(), { sourcePosition: list.dragFrom, targetPosition: list.dragFrom });
        await savedDrag;
        // Dropping a row on another puts it where the other one was: first and second swap.
        await expect.poll(() => names(page, list.only), { message: 'dragging one row onto the next still reorders', timeout: 15_000 }).toEqual(swapFirstTwo(before));
      }
    } finally {
      await keepSession(page, session);
    }
}

test('home: widgets reorder by tap in edit mode, the catalog is a sheet below md, and the layout persists', async ({ page, session }, info) => {
  test.skip(!selected.has('home'), 'home not selected');
  test.setTimeout(240_000);
  const device = gateDevice(info.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  const tap = (loc: Locator) => press(device.touch, loc, { timeout: 15_000 });
  const hides = () => page.locator('button[aria-label^="Hide "]');
  const titles = async () => (await hides().evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''))).map((l) => l.replace(/^Hide /, ''));
  /**
   * The visible widget ids, in order, as the SERVER holds them: the layout is saved on the server, so this is the last
   * layout the page sent (a save) or was sent (a read, after a reload).
   */
  let serverLayout: Array<{ id: string; visible: boolean }> | null = null;
  let saves = 0;
  page.on('response', async (res) => {
    if (!res.url().endsWith('/api/dashboard/layout')) return;
    try {
      if (res.request().method() === 'PUT') {
        saves += 1;
        serverLayout = (JSON.parse(res.request().postData() ?? '{}') as { layout: typeof serverLayout }).layout;
      } else {
        serverLayout = ((await res.json()) as { layout: typeof serverLayout }).layout;
      }
    } catch {
      /* a response that is not the layout answer is not a layout */
    }
  });
  const saved = async () => (saves === 0 && serverLayout === null ? null : (serverLayout ?? []).filter((i) => i.visible).map((i) => i.id));
  async function openEdit() {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, notes);
    await tap(page.getByRole('button', { name: /Customize home page/ }));
    await hides().first().waitFor({ state: 'visible', timeout: 30_000 });
    // A widget may veto its own cell once its data arrives; wait for the set to stop changing.
    let n = -1;
    for (let i = 0; i < 20; i++) {
      const now = await hides().count();
      if (now === n) break;
      n = now;
      await page.waitForTimeout(500);
    }
  }

  try {
    await openEdit();
    const phone = isPhone(page);
    const start = await titles();
    expect(start.length, 'several widgets on the page').toBeGreaterThan(2);

    // ---- every widget has the pair on a touch screen; a mouse keeps the drag it always had ----
    if (device.touch) {
      expect(await moveUp(page).count(), 'a Move up per widget').toBe(start.length);
      expect(await moveDown(page).count(), 'a Move down per widget').toBe(start.length);
      await expect(moveUp(page).first()).toBeDisabled();
      await expect(moveDown(page).last()).toBeDisabled();
      await expect(moveDown(page).first()).toBeEnabled();
      await expectTouchTarget(moveDown(page).first(), 'a widget Move down');
      await expectTouchTarget(moveUp(page).nth(1), 'a widget Move up');
      await expectTouchTarget(hides().first(), 'a widget Hide');
      await expectInsideScreen(page, moveDown(page).first(), 'a widget Move down');
      await expectInsideScreen(page, hides().first(), 'a widget Hide');
    } else {
      expect(await moveDown(page).locator('visible=true').count(), 'no Move buttons beside a mouse: the tiles are too narrow, and drag is there').toBe(0);
    }

    // ---- the catalog: a sheet it opens on purpose below md, the rail from md up ----
    const addWidgets = page.getByRole('button', { name: /Add widgets/ });
    if (phone) {
      await expect(page.getByRole('dialog'), 'edit mode does not open the catalog over the widgets').toHaveCount(0);
      await expect(addWidgets).toBeVisible();
    } else {
      await expect(page.getByText(/Add to home page/), 'the catalog is the rail beside the widgets').toBeVisible();
      await expect(page.getByRole('dialog')).toHaveCount(0);
      await expect(addWidgets).toHaveCount(0);
    }

    let moved: string[] | null = null;
    if (device.touch) {
      // ---- tap Move down: the first two widgets swap and the layout is saved ----
      // (Nothing is saved until the first change, so the saved layout is read after it.)
      expect(saves, 'nothing saved before the first change').toBe(0);
      await tap(moveDown(page).first());
      await expect.poll(async () => (await titles()).slice(0, 2), { timeout: 10_000 }).toEqual([start[1], start[0]]);
      await expect.poll(() => saves, { timeout: 10_000 }).toBeGreaterThan(0);
      moved = (await saved())!;

      // ---- it persists across a reload ----
      await openEdit();
      expect(await saved(), 'the saved layout is the moved one').toEqual(moved);
      expect((await titles()).slice(0, 2), 'the page shows the moved order').toEqual([start[1], start[0]]);

      // ---- Move up puts it back ----
      await tap(moveUp(page).nth(1));
      await expect.poll(async () => (await titles()).slice(0, 2), { timeout: 10_000 }).toEqual([start[0], start[1]]);
      await expect.poll(async () => (await saved())?.slice(0, 2), { timeout: 10_000 }).toEqual([moved[1], moved[0]]);
    }

    // ---- hide a widget, add it back from the catalog ----
    const gone = (await titles())[0]!;
    const countWith = (await titles()).length;
    await tap(hides().first());
    expect((await titles()).length).toBe(countWith - 1);
    if (phone) await tap(addWidgets);
    const sheet = phone ? page.getByRole('dialog') : page.locator('aside', { hasText: 'Add to home page' });
    await expect(sheet).toBeVisible({ timeout: 15_000 });
    if (phone) {
      // The sheet is inside the screen and its list scrolls rather than running off the bottom.
      await sheet.evaluate((el) => Promise.all(el.getAnimations().map((a) => a.finished.catch(() => undefined))));
      const sb = (await sheet.boundingBox())!;
      const vp = page.viewportSize()!;
      expect(sb.y + sb.height, 'the catalog sheet ends inside the screen').toBeLessThanOrEqual(vp.height + 1);
      expect(sb.x, 'the catalog sheet starts inside the screen').toBeGreaterThanOrEqual(-1);
      expect(sb.x + sb.width, 'the catalog sheet ends inside the screen (width)').toBeLessThanOrEqual(vp.width + 1);
    }
    const add = sheet.getByRole('button', { name: `Add ${gone}` }).first();
    if (device.touch) await expectTouchTarget(add, `Add ${gone}`);
    await tap(add);
    if (phone) await tap(sheet.getByRole('button', { name: 'Close' }));
    await expect.poll(async () => (await titles()).length, { timeout: 15_000 }).toBe(countWith);
    // The layout is saved a moment after the page shows the widget (a debounced write), and on a wide screen there is
    // no sheet to close in between, so the saved copy is read until it holds the widget, not once.
    await expect.poll(async () => (await saved())?.length ?? 0, { timeout: 10_000, message: 'the re-added widget is in the saved layout' }).toBeGreaterThanOrEqual(countWith);
    void moved;

    // ---- drag still works with a mouse ----
    if (!device.touch) {
      const frames = page.locator('div[draggable="true"]');
      const idsBefore = (await saved())!;
      await frames.nth(0).dragTo(frames.nth(1));
      await expect.poll(async () => (await saved())?.slice(0, 2), { timeout: 10_000 }).toEqual([idsBefore[1], idsBefore[0]]);
    }
  } finally {
    await keepSession(page, session);
  }
});
