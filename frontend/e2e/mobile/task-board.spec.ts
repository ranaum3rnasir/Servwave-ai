/**
 * Mobile slice 32 (TOUCH-07, TOUCH-08, TOUCH-09, TOUCH-10 for the task board; VP for the task
 * drawer): the task board and the task drawer work by touch.
 *
 * - Touch projects: a swipe that starts on a card scrolls its lane and moves nothing; a
 *   long-press drags the card to another lane, and the move is saved. Driven with the slice 19
 *   touch helpers (touch.ts), never the mouse.
 * - Every project: "Move to column" moves a card by tap (a click on the desktop control), and the
 *   change is saved: it survives a reload.
 * - Every project: the task drawer has no overflow and fits the screen (it was a bare 440 px, so
 *   it started 120, 80 and 47 px off the left edge at 320, 360 and 393).
 * - Desktop control: a mouse drag moves a card as before, and a click on a card still opens it.
 *   (The tap path of the task CALENDAR view is unchanged: its chips open the drawer on tap and its
 *   drag stays mouse-only, native HTML5 drag-and-drop, by the slice's design.)
 *
 * Seen red against the old board (app files reverted to origin/staging, this spec kept): the
 * swipe scrolled no lane on any touch project, there was no "Move to column" control, and the
 * drawer was off screen on the three phones. The desktop drag test passed there too: it is the
 * control that the mouse behaves as it did.
 *
 * Each test seeds its own tasks in the gate's throwaway org, assigned to the gate admin (the
 * Board shows the tasks the viewer is on), with the project in the title so the six projects
 * never touch each other's cards, and deletes them afterwards. MOBILE_GATE_ROUTES selects it by
 * `tasks`.
 */
import { expect, request, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { gateDevice } from './devices';
import { overflowCheck, overlaysCheck } from './checks';
import { ADMIN_SCROLL_TABLES, INTENDED_X_SCROLLERS } from '../../src/ui-kit/lib/intendedScrollers';
import { settle } from './measure';
import { gateBackend } from './paths';
import { selectStates } from './routes';
import { keepSession, signIn, test, type Session } from './session';
import { longPressDrag, swipe, tap } from './touch';

const selected = new Set(selectStates().map((s) => s.id));

async function adminApi(session: { current: Session }): Promise<{ api: APIRequestContext; userId: string }> {
  const s = JSON.parse(session.current.value) as { access_token: string };
  const api = await request.newContext({ baseURL: gateBackend(), extraHTTPHeaders: { Authorization: `Bearer ${s.access_token}` } });
  // The app user's id (not the sign-in provider's): it is what the Board compares assignees to.
  const me = await api.get('/api/auth/me');
  const body = await me.json().catch(() => ({}));
  if (!me.ok() || !body.user?.id) throw new Error(`could not read the gate admin: ${me.status()}`);
  return { api, userId: body.user.id as string };
}

async function createTask(api: APIRequestContext, userId: string, title: string, status = 'TODO'): Promise<string> {
  const res = await api.post('/api/tasks', { data: { title, status, assignee_ids: [userId], priority: 'MEDIUM' } });
  const body = await res.json().catch(() => ({}));
  if (!res.ok()) throw new Error(`seed task failed: ${res.status()} ${JSON.stringify(body).slice(0, 300)}`);
  return (body.task?.id ?? body.id) as string;
}

async function statusOf(api: APIRequestContext, id: string): Promise<string> {
  const res = await api.get(`/api/tasks/${id}`);
  const body = await res.json();
  return (body.task?.status ?? body.status) as string;
}

interface Ctx { page: Page; api: APIRequestContext; userId: string; touch: boolean; tag: string; project: string }

function run(title: string, body: (c: Ctx) => Promise<void>, only?: 'touch' | 'desktop') {
  test(title, async ({ page, session }, testInfo) => {
    test.skip(!selected.has('tasks'), 'MOBILE_GATE_ROUTES does not select tasks');
    const device = gateDevice(testInfo.project.name);
    test.skip(only === 'touch' && !device.touch, 'touch projects only');
    test.skip(only === 'desktop' && device.touch, 'the desktop control only');
    await signIn(page, session, []);
    const { api, userId } = await adminApi(session);
    try {
      await body({ page, api, userId, touch: device.touch, tag: `${testInfo.project.name} ${Date.now() % 100000}`, project: testInfo.project.name });
    } finally {
      await keepSession(page, session).catch(() => {});
      await api.dispose();
    }
  });
}

async function openBoard(page: Page, touch: boolean) {
  await page.goto('/tasks', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
  const tab = page.getByRole('tab', { name: 'Board', exact: true });
  if (touch) await tap(tab); else await tab.click();
  await expect(page.getByRole('tab', { name: 'Board', exact: true, selected: true })).toBeVisible();
}

const lane = (page: Page, name: string) => page.locator('section[data-slot="kanban-column"]').filter({ has: page.getByRole('heading', { name, exact: true }) });
/** The card (drag activator) whose title is `title`. */
const card = (page: Page, title: string) => page.locator('[aria-roledescription="sortable"]').filter({ hasText: title });
/** The lane's own vertical scroller (the drop area under its header). */
const laneScroller = (l: Locator) => l.locator(':scope > div.overflow-y-auto');

const LANE_OF: Record<string, string> = { TODO: 'To Do', IN_PROGRESS: 'In Progress', BLOCKED: 'Blocked', DONE: 'Done' };

/**
 * Bring a card fully on screen, centred, scrolling its lane, the lane track and the page as
 * needed. Test set-up, not a gesture.
 */
async function centre(l: Locator) {
  // The prototype's method: the board's cards answer their own scrollIntoView with a no-op (it
  // keeps dnd-kit's end-of-drop reveal from scrolling the app shell).
  await l.evaluate((e) => Element.prototype.scrollIntoView.call(e, { block: 'center', inline: 'center' }));
  await l.page().waitForTimeout(200);
}

/** A point on the part of `l` that is on screen (its centre clipped to the viewport). */
async function visiblePoint(page: Page, l: Locator) {
  const b = (await l.boundingBox())!;
  const vw = page.viewportSize()!.width;
  const vh = page.viewportSize()!.height;
  const left = Math.max(b.x, 8), right = Math.min(b.x + b.width, vw - 8);
  const top = Math.max(b.y, 8), bottom = Math.min(b.y + b.height, vh - 8);
  expect(right - left, `${String(l)} is on screen horizontally`).toBeGreaterThan(24);
  expect(bottom - top, `${String(l)} is on screen vertically`).toBeGreaterThan(24);
  return { x: (left + right) / 2, y: (top + bottom) / 2 };
}

// ── touch: swipe scrolls, long-press drags ────────────────────────────────────────────────────
run('a swipe on a card scrolls its lane; a long-press drags it to another lane and saves', async ({ page, api, userId, tag }) => {
  const ids: string[] = [];
  try {
    // Enough cards that the To Do lane must scroll on every device.
    for (let i = 1; i <= 9; i++) ids.push(await createTask(api, userId, `Gate board ${tag} #${i}`));
    await openBoard(page, true);
    const todo = lane(page, 'To Do');
    const scroller = laneScroller(todo);
    const first = card(page, `Gate board ${tag} #1`);
    await expect(first).toBeVisible({ timeout: 20_000 });
    await first.scrollIntoViewIfNeeded();
    await expect.poll(() => scroller.evaluate((e) => e.scrollHeight > e.clientHeight + 40), { message: 'the To Do lane overflows (otherwise the swipe proves nothing)' }).toBe(true);

    // Swipe: finger down on a card near the bottom of the lane's visible part (so it has room to
    // travel), straight up, no rest.
    await scroller.evaluate((e) => { e.scrollTop = 0; });
    const lb = (await scroller.boundingBox())!;
    const vh = page.viewportSize()!.height;
    const vw0 = page.viewportSize()!.width;
    const x = (Math.max(lb.x, 8) + Math.min(lb.x + lb.width, vw0 - 8)) / 2;
    const visTop = Math.max(lb.y, 0);
    const visBottom = Math.min(lb.y + lb.height, vh);
    expect(visBottom - visTop, 'enough of the lane is on screen to swipe in').toBeGreaterThan(160);
    const from = { x, y: visBottom - 30 };
    const onCard = await page.evaluate(({ x, y }) => !!document.elementFromPoint(x, y)?.closest('[aria-roledescription="sortable"]'), from);
    expect(onCard, 'the swipe starts on a card').toBe(true);
    const top0 = await scroller.evaluate((e) => e.scrollTop);
    await swipe(page, from, { x, y: visTop + 16 });
    const top1 = await scroller.evaluate((e) => e.scrollTop);
    expect(top1 - top0, 'the swipe scrolled the lane').toBeGreaterThan(40);
    // Nothing was picked up or moved by the swipe.
    for (const id of ids) expect(await statusOf(api, id), 'a swipe moved no card').toBe('TODO');

    // Long-press: pick card #1 up and carry it to the right-hand edge. On a phone only one lane
    // fits, so the finger holds at the edge and the board scrolls the next lane in under it, the
    // way a person does it; which lane it lands in depends on how far the board scrolled, so the
    // assertion is that it left To Do for another lane and the new lane was saved.
    await centre(first);
    const src = await visiblePoint(page, first);
    const vw = page.viewportSize()!.width;
    await longPressDrag(page, src, { x: vw - 6, y: src.y }, { durationMs: 900 });
    await expect.poll(() => statusOf(api, ids[0]!), { message: 'the long-press moved the card out of To Do and saved it', timeout: 10_000 }).not.toBe('TODO');
    const landed = await statusOf(api, ids[0]!);
    expect(Object.keys(LANE_OF), `landed in a board lane (${landed})`).toContain(landed);
    await expect(lane(page, LANE_OF[landed]!).locator('[aria-roledescription="sortable"]').filter({ hasText: `Gate board ${tag} #1` })).toHaveCount(1);
    await expect(todo.locator('[aria-roledescription="sortable"]').filter({ hasText: `Gate board ${tag} #1` })).toHaveCount(0);
  } finally {
    for (const id of ids) await api.delete(`/api/tasks/${id}`).catch(() => {});
  }
}, 'touch');

// ── every project: "Move to column" by tap, saved ────────────────────────────────────────────
run('"Move to column" moves a card by tap and the move is saved', async ({ page, api, userId, touch, tag }) => {
  const title = `Gate move ${tag}`;
  const id = await createTask(api, userId, title);
  try {
    await openBoard(page, touch);
    await expect(card(page, title)).toBeVisible({ timeout: 20_000 });
    const move = page.getByRole('button', { name: `Move "${title}" to another column` });
    await move.scrollIntoViewIfNeeded();
    if (touch) await tap(move); else await move.click();
    const menu = page.getByRole('menu');
    await expect(menu).toBeVisible();
    const done = menu.getByRole('menuitem', { name: 'Done', exact: true });
    if (touch) await tap(done); else await done.click();
    await expect.poll(() => statusOf(api, id), { message: 'the move was saved', timeout: 10_000 }).toBe('DONE');

    // It survives a reload: the card is in the Done lane.
    await openBoard(page, touch);
    await expect(lane(page, 'Done').locator('[aria-roledescription="sortable"]').filter({ hasText: title })).toHaveCount(1, { timeout: 20_000 });
    // Opening the menu opened no drawer.
    await expect(page.getByRole('dialog')).toHaveCount(0);
  } finally {
    await api.delete(`/api/tasks/${id}`).catch(() => {});
  }
});

// ── every project: the drawer fits ───────────────────────────────────────────────────────────
run('the task drawer has no overflow and fits the screen', async ({ page, api, userId, tag }) => {
  const id = await createTask(api, userId, `Gate drawer ${tag} with a title long enough to wrap on a phone`);
  try {
    await page.goto(`/tasks?task=${id}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible({ timeout: 20_000 });
    await page.waitForTimeout(500); // the slide-in
    const vw = page.viewportSize()!.width;
    const box = (await dialog.boundingBox())!;
    expect(box.x, 'drawer starts on screen').toBeGreaterThanOrEqual(-0.5);
    expect(box.x + box.width, 'drawer ends on screen').toBeLessThanOrEqual(vw + 0.5);
    const overflow = await page.evaluate(overflowCheck, { onlyInOverlays: true, intended: [...INTENDED_X_SCROLLERS], adminTables: [...ADMIN_SCROLL_TABLES] });
    expect(overflow.offenders, 'overflow inside the task drawer').toEqual([]);
    const overlays = await page.evaluate(overlaysCheck);
    expect(overlays.offenders, 'the task drawer is reachable').toEqual([]);
  } finally {
    await api.delete(`/api/tasks/${id}`).catch(() => {});
  }
});

// ── desktop control: mouse drag and click as before ──────────────────────────────────────────
run('a mouse drag moves a card and a click opens it, as before', async ({ page, api, userId, tag }) => {
  const dragged = `Gate mouse ${tag}`;
  const clicked = `Gate click ${tag}`;
  // The dragged card starts in In Progress and goes LEFT, to To Do. Carrying a card toward the
  // right-hand side of the visible board runs into the board's edge auto-scroll (it scrolls the
  // next lane in under the card, before and after this slice alike), which would make this a test
  // of scroll timing rather than of the drop.
  const ids = [await createTask(api, userId, dragged, 'IN_PROGRESS'), await createTask(api, userId, clicked)];
  try {
    await openBoard(page, false);
    const c = card(page, dragged);
    await expect(c).toBeVisible({ timeout: 20_000 });
    const todo = lane(page, 'To Do');
    // The other five projects seed and delete their own cards in the same org while this runs,
    // and the board refreshes live, so a lane can re-lay itself out under the pointer mid-drag
    // (seen once in a full six-project run, never with the desktop project alone). Each attempt
    // re-measures and drags again with the real mouse; a board whose mouse drag is broken fails
    // every attempt.
    await expect(async () => {
      if ((await statusOf(api, ids[0]!)) === 'TODO') return;
      await todo.evaluate((e) => { e.parentElement!.scrollLeft = 0; });
      // The card in the middle of its lane, clear of the lane's own top and bottom scroll zones.
      await c.evaluate((e) => {
        const sc = e.closest('.overflow-y-auto') as HTMLElement;
        const r = e.getBoundingClientRect();
        const box = sc.getBoundingClientRect();
        sc.scrollTop += r.top - box.top - (box.height - r.height) / 2;
      });
      await page.waitForTimeout(200);
      const src = await visiblePoint(page, c);
      const cb = (await c.boundingBox())!;
      const tb = (await todo.boundingBox())!;
      const dst = { x: src.x + (tb.x + tb.width / 2) - (cb.x + cb.width / 2), y: src.y };
      expect(dst.x, 'To Do is on screen beside In Progress').toBeGreaterThan(0);
      await page.mouse.move(src.x, src.y);
      await page.mouse.down();
      await page.mouse.move(src.x - 12, src.y, { steps: 3 }); // past the 8 px activation distance
      await page.mouse.move(dst.x, dst.y, { steps: 12 });
      await page.waitForTimeout(150);
      await page.mouse.up();
      await expect.poll(() => statusOf(api, ids[0]!), { message: 'the mouse drop was saved', timeout: 8_000 }).toBe('TODO');
    }).toPass({ timeout: 40_000, intervals: [500] });
    await expect(todo.locator('[aria-roledescription="sortable"]').filter({ hasText: dragged })).toHaveCount(1);

    await card(page, clicked).click();
    await expect(page.getByRole('dialog')).toBeVisible();
    expect(await statusOf(api, ids[1]!), 'a click moved nothing').toBe('TODO');
  } finally {
    for (const id of ids) await api.delete(`/api/tasks/${id}`).catch(() => {});
  }
}, 'desktop');
