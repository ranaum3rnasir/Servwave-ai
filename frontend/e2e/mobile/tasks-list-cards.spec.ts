/**
 * Mobile slice 72: the Tasks list as cards, paged on the server.
 *
 * UI (every project). A fresh set of 40 tasks (more than one page of 25) is seeded in the gate's
 * throwaway org, tagged per project so the six projects never see each other's rows, and the List
 * tab is searched for the tag. Below lg (1024) the list is cards: no table, no sideways overflow,
 * every card's open control at least 44 px on touch. From lg up it is the table it was. Either way
 * the first draw is ONE bounded page (25 rows), and scrolling to the end of the list (no tap)
 * loads the rest. The Board still shows a seeded task, and the hub still loads the complete list
 * for the views that need every task (the request without a limit).
 *
 * Parity (the desktop control only, API level, on the seeded org). The same 40 tasks are read two
 * ways: the whole list (the way every view read it before) and the server's pages (7 at a time),
 * with each filter and sort. Every paged answer must equal the whole list narrowed the way the
 * browser used to narrow it, concatenated across pages with no row missed or repeated: status
 * drill-downs, member, category (with "none"), overdue, due-date range, the At risk flag, the
 * search, and the sort by due date (no date last). Another organisation's tasks are never in a
 * page: the throwaway org is the only one these tokens can read.
 *
 * Seen red against origin/staging's list (app files reverted, this spec kept): the API ignored
 * `limit`, so a page held every task and the first draw was not bounded; the list had no cards
 * below lg. MOBILE_GATE_ROUTES selects it by `tasks`.
 */
import { expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { gateDevice } from './devices';
import { measure, settle } from './measure';
import { overflowCheck } from './checks';
import { ADMIN_SCROLL_TABLES, INTENDED_X_SCROLLERS } from '../../src/ui-kit/lib/intendedScrollers';
import fs from 'fs';
import { FIXTURES_FILE, gateBackend } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test, type Session } from './session';
import { tap } from './touch';

const selected = new Set(selectStates().map((s) => s.id));
const LG = 1024;
const PAGE_SIZE = 25;
const COUNT = 40;

/** The seeded technician: the tasks below are theirs, so the admin's Board and My Day (which show the viewer's own tasks) are left alone for the other specs sharing this org. */
const technicianId = (): string => (JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8')) as GateFixtures).techId;

async function adminApi(session: { current: Session }): Promise<{ api: APIRequestContext; userId: string }> {
  const s = JSON.parse(session.current.value) as { access_token: string };
  const api = await request.newContext({ baseURL: gateBackend(), extraHTTPHeaders: { Authorization: `Bearer ${s.access_token}` } });
  const me = await api.get('/api/auth/me');
  const body = await me.json().catch(() => ({}));
  if (!me.ok() || !body.user?.id) throw new Error(`could not read the gate admin: ${me.status()}`);
  return { api, userId: body.user.id as string };
}

interface WireTask {
  id: string; title: string; status: string; priority: string; due_at: string | null;
  created_at: string; category?: { id: string } | null; assignee_ids: string[];
}

interface Seeded { ids: string[]; categoryId: string }

const DAY = 24 * 3_600_000;

/**
 * 40 tasks with a spread the filters can tell apart: four statuses, three priorities, a due date
 * on some (past, far future, none), a category on every third. Created in small parallel batches.
 */
async function seed(api: APIRequestContext, assigneeId: string, tag: string): Promise<Seeded> {
  const cats = await (await api.get('/api/task-categories')).json();
  const categoryId = (cats.categories?.[0]?.id ?? '') as string;
  const statuses = ['TODO', 'IN_PROGRESS', 'BLOCKED', 'DONE'];
  const priorities = ['LOW', 'MEDIUM', 'HIGH'];
  const ids: string[] = [];
  const make = async (n: number) => {
    const data: Record<string, unknown> = {
      title: `Gate list ${tag} #${String(n).padStart(2, '0')}`,
      status: statuses[n % 4],
      priority: priorities[n % 3],
      assignee_ids: [assigneeId],
    };
    if (n % 5 === 0) data.due_at = new Date(Date.UTC(2020, 0, 1 + n)).toISOString();           // long overdue
    else if (n % 7 === 0) data.due_at = new Date(Date.UTC(2031, 4, 10)).toISOString();         // one far day
    else if (n % 6 === 0) data.due_at = new Date(Date.now() + (n % 11) * DAY + 3_600_000).toISOString();
    if (n % 3 === 0 && categoryId) data.category_id = categoryId;
    const res = await api.post('/api/tasks', { data });
    const body = await res.json().catch(() => ({}));
    if (!res.ok()) throw new Error(`seed task failed: ${res.status()} ${JSON.stringify(body).slice(0, 300)}`);
    ids.push((body.task?.id ?? body.id) as string);
  };
  for (let n = 1; n <= COUNT; n += 8) {
    await Promise.all(Array.from({ length: Math.min(8, COUNT - n + 1) }, (_, i) => make(n + i)));
  }
  return { ids, categoryId };
}

async function cleanup(api: APIRequestContext, ids: string[]) {
  for (let i = 0; i < ids.length; i += 8) {
    await Promise.all(ids.slice(i, i + 8).map((id) => api.delete(`/api/tasks/${id}`).catch(() => {})));
  }
}

async function overflowOffenders(page: Page): Promise<string[]> {
  const res = await page.evaluate(overflowCheck, { intended: [...INTENDED_X_SCROLLERS], adminTables: [...ADMIN_SCROLL_TABLES] });
  return res.offenders;
}

// ── UI: cards below lg, one bounded page, more on scroll ─────────────────────────────────────
test('tasks list: cards below lg, one bounded page, the rest on scroll', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('tasks'), 'MOBILE_GATE_ROUTES does not select tasks');
  test.setTimeout(240_000);
  const device = gateDevice(testInfo.project.name);
  await signIn(page, session, []);
  const { api } = await adminApi(session);
  const tag = `${testInfo.project.name.replace(/[^a-z0-9]/gi, '')}${Date.now() % 100000}`;
  let seeded: Seeded = { ids: [], categoryId: '' };
  try {
    seeded = await seed(api, technicianId(), tag);

    const requests: string[] = [];
    page.on('request', (r) => { if (/\/api\/tasks\?/.test(r.url()) || /\/api\/tasks$/.test(r.url())) requests.push(r.url()); });

    await page.goto('/tasks', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);

    // The hub still loads the whole list for My Day, the Board, the Calendar, History and the
    // Dashboard: a request with no limit.
    await expect.poll(() => requests.some((u) => !/[?&]limit=/.test(u)), { message: 'the hub still loads the complete list for the other views', timeout: 20_000 }).toBe(true);

    const listTab = page.getByRole('tab', { name: 'List', exact: true });
    if (device.touch) await tap(listTab); else await listTab.click();
    await expect(page.getByRole('tab', { name: 'List', exact: true, selected: true })).toBeVisible();

    // Isolate this project's rows, through the server's search.
    await page.getByRole('searchbox').fill(tag);
    await expect(page.getByText(`${COUNT} tasks`, { exact: true })).toBeVisible({ timeout: 30_000 });

    const vp = page.viewportSize()!;
    const asCards = vp.width < LG;
    const cards = page.locator('ul[aria-label="Tasks"] > li[data-slot="record-card"]');
    const rows = page.locator('table tbody tr');

    if (asCards) {
      await expect(cards).toHaveCount(PAGE_SIZE, { timeout: 20_000 });
      await expect(page.locator('table')).toHaveCount(0);
      expect(await overflowOffenders(page), `no sideways overflow on the card list at ${vp.width}px`).toEqual([]);
      if (device.touch) {
        const opens = page.locator('ul[aria-label="Tasks"] [data-slot="record-card-open"]');
        for (let i = 0; i < 3; i += 1) {
          const box = await opens.nth(i).boundingBox();
          expect(box!.height, `card ${i} open control is at least 44px tall`).toBeGreaterThanOrEqual(43.5);
        }
      }
    } else {
      await expect(rows).toHaveCount(PAGE_SIZE, { timeout: 20_000 });
      await expect(page.locator('ul[aria-label="Tasks"]')).toHaveCount(0);
    }

    // ONE bounded page so far: only the first request of this search was made.
    const listRequests = requests.filter((u) => /[?&]limit=/.test(u) && u.includes(encodeURIComponent(tag)));
    expect(listRequests.every((u) => /[?&]offset=0\b/.test(u)), 'only the first page was requested').toBe(true);

    // Scroll to the end of the list WITHOUT tapping Load more: the next page arrives by itself.
    // (A plain scroll of the list's foot into view, not a locator action: the foot changes as the
    // next page arrives, and a locator waits for it to hold still. Repeated while it polls, like a
    // reader who keeps scrolling: the late layout of the first cards can move the foot once.)
    await expect.poll(async () => {
      await page.evaluate(() => document.querySelector('[data-slot="load-more"]')?.scrollIntoView({ block: 'end' }));
      return (asCards ? cards : rows).count();
    }, { message: 'scrolling to the end of the list loads the rest, with no tap', timeout: 30_000, intervals: [250, 500, 1000] }).toBe(COUNT);
    expect(requests.some((u) => /[?&]offset=25\b/.test(u)), 'the second page was requested').toBe(true);
    await expect(page.getByRole('button', { name: 'Load more' })).toHaveCount(0);

    // The page's own checks still hold with 40 rows drawn: nothing vendor-named, nothing off screen.
    const m = await measure(page, { touch: device.touch, onlyInOverlays: false, consoleLines: [] });
    expect(m.vendorTerms.offenders).toEqual([]);
    expect(m.overflow.offenders, 'overflow').toEqual([]);

    // A card (or row) opens the task's drawer.
    const first = asCards ? cards.first().locator('[data-slot="record-card-open"]') : rows.first();
    if (device.touch) await tap(first); else await first.click();
    await expect(page.getByRole('dialog')).toBeVisible();
    await page.keyboard.press('Escape');

    // The Board is still there, fed by the complete list: its lanes draw (it shows the viewer's own
    // tasks, and these are the technician's, so none of them is on it).
    const board = page.getByRole('tab', { name: 'Board', exact: true });
    if (device.touch) await tap(board); else await board.click();
    await expect(page.locator('section[data-slot="kanban-column"]').first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator('[aria-roledescription="sortable"]').filter({ hasText: `Gate list ${tag}` })).toHaveCount(0);
  } finally {
    await cleanup(api, seeded.ids);
    await keepSession(page, session).catch(() => {});
    await api.dispose();
  }
});

// ── API parity on the seeded org (the desktop control only) ───────────────────────────────────
test('tasks list: every filter and sort pages to the same rows as the whole list', async ({ session }, testInfo) => {
  test.skip(!selected.has('tasks'), 'MOBILE_GATE_ROUTES does not select tasks');
  test.skip(gateDevice(testInfo.project.name).touch, 'API parity runs once, on the desktop control');
  test.setTimeout(240_000);
  // The session fixture signs in lazily; borrow it for the token.
  const { api } = await adminApi(session);
  const memberId = technicianId();
  const tag = `parity${Date.now() % 100000}`;
  let seeded: Seeded = { ids: [], categoryId: '' };
  try {
    seeded = await seed(api, memberId, tag);
    const now = Date.now();

    const whole = async (): Promise<WireTask[]> => {
      const res = await api.get('/api/tasks');
      expect(res.ok()).toBe(true);
      const all = (await res.json()).tasks as WireTask[];
      return all.filter((t) => t.title.includes(`Gate list ${tag}`));
    };
    const paged = async (params: Record<string, string>, size = 7): Promise<{ rows: WireTask[]; total: number; counts: Record<string, number> | undefined }> => {
      const out: WireTask[] = [];
      let total = 0;
      let counts: Record<string, number> | undefined;
      for (let offset = 0; ; offset += size) {
        const qs = new URLSearchParams({ q: `Gate list ${tag}`, ...params, limit: String(size), offset: String(offset) });
        const res = await api.get(`/api/tasks?${qs}`);
        expect(res.status(), qs.toString()).toBe(200);
        const body = await res.json();
        expect(body.tasks.length, 'a page is bounded').toBeLessThanOrEqual(size);
        out.push(...body.tasks);
        total = body.page.total;
        if (offset === 0) counts = body.category_counts;
        else expect(body.category_counts, 'later pages carry no counts').toBeUndefined();
        if (!body.page.has_more) break;
      }
      return { rows: out, total, counts };
    };
    const ids = (rows: WireTask[]) => rows.map((t) => t.id);
    const sameSet = (a: WireTask[], b: WireTask[]) => expect([...ids(a)].sort()).toEqual([...ids(b)].sort());
    const isOpen = (t: WireTask) => t.status !== 'DONE' && t.status !== 'CANCELLED';

    const all = await whole();
    expect(all).toHaveLength(COUNT);

    // No filter: every task once, in the order the list always had (newest first).
    const everything = await paged({});
    expect(everything.total).toBe(COUNT);
    expect(ids(everything.rows)).toHaveLength(new Set(ids(everything.rows)).size);
    sameSet(everything.rows, all);
    const created = everything.rows.map((t) => Date.parse(t.created_at));
    expect([...created].sort((a, b) => b - a), 'newest first across pages').toEqual(created);

    // Status drill-downs.
    sameSet((await paged({ drill: 'blocked' })).rows, all.filter((t) => t.status === 'BLOCKED'));
    sameSet((await paged({ drill: 'open' })).rows, all.filter(isOpen));

    // Member: any assignee (all of these are the technician's; the admin is on none of them).
    sameSet((await paged({ member_id: memberId })).rows, all.filter((t) => t.assignee_ids.includes(memberId)));
    expect((await paged({ member_id: '00000000-0000-4000-8000-000000000000' })).rows).toEqual([]);

    // Overdue and the At risk flag (every seeded task is the technician's, so their load adds a
    // flat 20 to each open one: only the long-overdue open tasks reach 50).
    const overdue = all.filter((t) => isOpen(t) && t.due_at && Date.parse(t.due_at) < now);
    expect(overdue.length, 'the seed has overdue tasks').toBeGreaterThan(0);
    sameSet((await paged({ overdue: 'true' })).rows, overdue);
    sameSet((await paged({ at_risk: 'true' })).rows, overdue);

    // Due-date range, whole UTC days, ends included.
    const onTheDay = all.filter((t) => t.due_at?.slice(0, 10) === '2031-05-10');
    expect(onTheDay.length).toBeGreaterThan(0);
    sameSet((await paged({ due_from: '2031-05-10', due_to: '2031-05-10' })).rows, onTheDay);
    sameSet((await paged({ due_from: '2031-05-11' })).rows, all.filter((t) => t.due_at && t.due_at.slice(0, 10) >= '2031-05-11'));

    // Category, with the "none" sentinel; and the counts the Filter window shows.
    if (seeded.categoryId) {
      const inCat = all.filter((t) => t.category?.id === seeded.categoryId);
      const none = all.filter((t) => !t.category);
      sameSet((await paged({ category_ids: seeded.categoryId })).rows, inCat);
      sameSet((await paged({ category_ids: 'none' })).rows, none);
      sameSet((await paged({ category_ids: `${seeded.categoryId},none` })).rows, all);
      // Counted with the category selection left OUT, whichever is ticked.
      const counted = (await paged({ category_ids: seeded.categoryId })).counts!;
      expect(counted[seeded.categoryId]).toBe(inCat.length);
      expect(counted.none).toBe(none.length);
    }

    // Search: title text, case-insensitive; a text nothing matches pages to nothing.
    sameSet((await paged({ q: `GATE LIST ${tag} #07` })).rows, all.filter((t) => t.title.endsWith('#07')));
    const nothing = await paged({ q: `no such task ${tag}` });
    expect(nothing.rows).toEqual([]);
    expect(nothing.total).toBe(0);

    // Sort by due date: the soonest first, no date last, ties by id - and the same across pages.
    const byDue = (await paged({ sort: 'due_at', dir: 'asc' })).rows;
    const expected = [...all].sort((a, b) => {
      if (!a.due_at && !b.due_at) return a.id < b.id ? -1 : 1;
      if (!a.due_at) return 1;
      if (!b.due_at) return -1;
      return Date.parse(a.due_at) - Date.parse(b.due_at) || (a.id < b.id ? -1 : 1);
    });
    expect(ids(byDue)).toEqual(ids(expected));

    // A bad query is refused, not guessed at.
    expect((await api.get('/api/tasks?limit=5000')).status()).toBe(400);
    expect((await api.get('/api/tasks?limit=5&sort=organization_id')).status()).toBe(400);
  } finally {
    await cleanup(api, seeded.ids);
    await api.dispose();
  }
});
