/**
 * Mobile slice 58 (TOUCH-09 [D], TOUCH-06 scheduler parts, CMP-12): the scheduler reschedules by
 * touch. A long-press on a calendar event, or on a dispatch-board card, picks it up and a drag moves
 * it to another time; a swipe that starts on one scrolls the grid and moves nothing; the mouse drag
 * on the desktop control is as before. Driven with the slice 19 touch helpers (touch.ts: real touch
 * input, never the mouse). Resize stays desktop-only by design and is not asserted here.
 *
 * Seen red against the old scheduler (app files reverted to origin/staging, this spec kept): on
 * every touch project the long-press moved nothing (the calendar library refuses to begin a drag
 * from a touch, and the board's native-drag cards cannot be lifted by a finger), while the two
 * swipe tests and the two desktop mouse tests passed: they are the controls.
 *
 * The event is a calendar entry created through the API in the gate's throwaway org: moving one
 * saves directly (a job opens a confirm dialog first), so the saved start is the whole proof. Each
 * test creates its own, titled with the project, and deletes it afterwards.
 *
 * MOBILE_GATE_ROUTES selects it by `schedule`.
 */
import { expect, request, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { gateBackend } from './paths';
import { selectStates } from './routes';
import { keepSession, signIn, test, type Session } from './session';
import { longPressDrag, press, swipe } from './touch';

const selected = new Set(selectStates().map((s) => s.id));

const HOUR_MS = 3_600_000;

async function adminApi(session: { current: Session }): Promise<APIRequestContext> {
  const s = JSON.parse(session.current.value) as { access_token: string };
  return request.newContext({ baseURL: gateBackend(), extraHTTPHeaders: { Authorization: `Bearer ${s.access_token}` } });
}

/** The org's day (the throwaway org is on New York time): an event at 16:00Z is late morning there. */
function entryTimes(dayOffset = 0): { start: string; end: string } {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const start = new Date(`${day}T16:00:00Z`);
  start.setUTCDate(start.getUTCDate() + dayOffset);
  return { start: start.toISOString(), end: new Date(start.getTime() + HOUR_MS).toISOString() };
}

/** The hour (0-23) the event starts at on the org's wall clock. */
function startHourNY(): number {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: 'America/New_York', hour: 'numeric', hourCycle: 'h23' }).format(new Date(entryTimes().start));
  return Number(h);
}

async function createEntry(api: APIRequestContext, title: string, participantUserId?: string, dayOffset = 0) {
  const { start, end } = entryTimes(dayOffset);
  const res = await api.post('/api/calendar-entries', {
    data: { title, start, end, ...(participantUserId ? { participants: [{ kind: 'USER', user_id: participantUserId }] } : {}) },
  });
  const body = await res.json().catch(() => ({}));
  if (!res.ok()) throw new Error(`seed calendar entry failed: ${res.status()} ${JSON.stringify(body).slice(0, 300)}`);
  const id = (body.entry?.id ?? body.calendar_entry?.id ?? body.id) as string | undefined;
  if (!id) throw new Error(`seed calendar entry: no id in ${JSON.stringify(body).slice(0, 300)}`);
  return { id, start, end };
}

async function readEntry(api: APIRequestContext, id: string): Promise<{ start: number; end: number }> {
  const res = await api.get(`/api/calendar-entries/${id}`);
  const body = await res.json();
  const e = body.entry ?? body.calendar_entry ?? body;
  return { start: new Date(e.start).getTime(), end: new Date(e.end).getTime() };
}

async function openDay(page: Page) {
  await page.goto('/schedule?view=day', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
}

/** The event's card in the time grid. */
const eventCard = (page: Page, title: string) => page.locator('.schedule-cal .rbc-time-content .rbc-event').filter({ hasText: title }).first();

/** One hour of the grid, in px. */
const hourPx = (page: Page) => page.evaluate(() => document.querySelector('.schedule-cal .rbc-time-content .rbc-timeslot-group')!.getBoundingClientRect().height);

/** Put the event mid-viewport inside the grid's own scroller, so a 2 h move and a swipe both have room. */
async function centreInGrid(page: Page, card: Locator) {
  await card.evaluate((el) => {
    const scroller = el.closest('.rbc-time-content') as HTMLElement;
    const sr = scroller.getBoundingClientRect();
    const er = el.getBoundingClientRect();
    scroller.scrollTop += er.top - sr.top - sr.height / 3;
  });
  await page.waitForTimeout(250);
}

interface Ctx { page: Page; api: APIRequestContext; title: string; id: string; start: number; end: number }

function run(title: string, body: (c: Ctx) => Promise<void>, only: 'touch' | 'desktop') {
  test(title, async ({ page, session }, testInfo) => {
    test.skip(!selected.has('schedule'), 'MOBILE_GATE_ROUTES does not select schedule');
    const device = gateDevice(testInfo.project.name);
    test.skip(only === 'touch' && !device.touch, 'touch projects only');
    test.skip(only === 'desktop' && device.touch, 'the desktop control only');
    await signIn(page, session, []);
    const api = await adminApi(session);
    const name = `Gate drag ${testInfo.project.name} ${Date.now() % 100000}`;
    const entry = await createEntry(api, name);
    try {
      await openDay(page);
      const card = eventCard(page, name);
      await expect(card, 'the seeded event is on the Day grid').toBeVisible({ timeout: 20_000 });
      await body({ page, api, title: name, id: entry.id, start: new Date(entry.start).getTime(), end: new Date(entry.end).getTime() });
    } finally {
      await api.delete(`/api/calendar-entries/${entry.id}`).catch(() => {});
      await keepSession(page, session).catch(() => {});
      await api.dispose();
    }
  });
}

run('a long-press on an event picks it up and a drag moves it to another time; the move is saved', async ({ page, api, title, id, start, end }) => {
  const card = eventCard(page, title);
  await centreInGrid(page, card);
  const hour = await hourPx(page);
  const box = (await card.boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 14) };
  await longPressDrag(page, from, { x: from.x, y: from.y + 2 * hour }, { holdMs: 450, durationMs: 700 });

  await expect.poll(async () => (await readEntry(api, id)).start, { message: 'the move was saved', timeout: 10_000 }).not.toBe(start);
  const moved = await readEntry(api, id);
  const shiftedMin = (moved.start - start) / 60_000;
  expect(shiftedMin, `moved about two hours later (was ${shiftedMin} min)`).toBeGreaterThanOrEqual(90);
  expect(shiftedMin, `moved about two hours later (was ${shiftedMin} min)`).toBeLessThanOrEqual(150);
  expect(moved.end - moved.start, 'a move keeps the length').toBe(end - start);
}, 'touch');

run('a swipe that starts on an event scrolls the grid and does not move the event', async ({ page, api, title, id, start, end }) => {
  const card = eventCard(page, title);
  await centreInGrid(page, card);
  const scroller = page.locator('.schedule-cal .rbc-time-content').first();
  const room = await scroller.evaluate((e) => ({ top: e.scrollTop, max: e.scrollHeight - e.clientHeight }));
  expect(room.max, 'the grid scrolls (otherwise the swipe proves nothing)').toBeGreaterThan(160);
  const box = (await card.boundingBox())!;
  const from = { x: box.x + box.width / 2, y: box.y + Math.min(box.height / 2, 14) };
  // Finger up scrolls the grid down; the other way when it is already near the end.
  const dy = room.top + 150 < room.max ? -120 : 120;
  const before = room.top;
  await swipe(page, from, { x: from.x, y: from.y + dy });
  const after = await scroller.evaluate((e) => e.scrollTop);
  expect(Math.abs(after - before), 'the swipe scrolled the grid').toBeGreaterThan(40);

  // Nothing was picked up or saved: give a late save time to show, then read the record.
  await page.waitForTimeout(800);
  const saved = await readEntry(api, id);
  expect(saved.start, 'a swipe moved no event').toBe(start);
  expect(saved.end).toBe(end);
}, 'touch');

run('desktop control: a mouse drag moves an event as before', async ({ page, api, title, id, start, end }) => {
  const card = eventCard(page, title);
  await centreInGrid(page, card);
  const hour = await hourPx(page);
  const box = (await card.boundingBox())!;
  const x = box.x + box.width / 2;
  const y = box.y + Math.min(box.height / 2, 14);
  await page.mouse.move(x, y);
  await page.mouse.down();
  await page.mouse.move(x, y + hour, { steps: 8 });
  await page.mouse.move(x, y + 2 * hour, { steps: 8 });
  await page.mouse.up();

  await expect.poll(async () => (await readEntry(api, id)).start, { message: 'the move was saved', timeout: 10_000 }).not.toBe(start);
  const moved = await readEntry(api, id);
  const shiftedMin = (moved.start - start) / 60_000;
  expect(shiftedMin).toBeGreaterThanOrEqual(90);
  expect(shiftedMin).toBeLessThanOrEqual(150);
  expect(moved.end - moved.start).toBe(end - start);
}, 'desktop');

// ── the dispatch board (Member mode): a card is lifted by a long-press, carried to a slot ─────────
async function adminId(api: APIRequestContext): Promise<string> {
  const me = await api.get('/api/auth/me');
  const body = await me.json().catch(() => ({}));
  if (!me.ok() || !body.user?.id) throw new Error(`could not read the gate admin: ${me.status()}`);
  return body.user.id as string;
}

async function openMemberBoard(page: Page, touch: boolean, dayOffset: number) {
  await openDay(page);
  const member = page.getByRole('button', { name: 'Member', exact: true });
  // On a phone (and a phone held sideways) the board mode is in the "More" sheet.
  if (!(await member.isVisible().catch(() => false))) {
    await press(touch, page.getByRole('button', { name: 'More schedule options' }));
    await expect(page.getByRole('dialog', { name: 'Schedule options' })).toBeVisible();
  }
  await press(touch, member);
  const sheet = page.getByRole('dialog', { name: 'Schedule options' });
  if (await sheet.isVisible().catch(() => false)) await page.keyboard.press('Escape');
  await expect(page.locator('[data-testid^="grid-slot-"]').first(), 'the member board is showing').toBeAttached({ timeout: 20_000 });
  for (let i = 0; i < dayOffset; i++) await press(touch, page.getByRole('button', { name: 'Next period' }));
  await settle(page, []);
}

/**
 * Every board test gets a day of its own. Cards of one member at the same hour sit on top of each
 * other in his lane, and the six device projects run at once against one org and one admin, so two
 * tests on the same day would grab each other's card. The page opens on today; the test steps
 * forward to its day.
 */
const BOARD_DAY: Record<string, number> = { 'iphone-se': 1, 'galaxy-s24': 3, 'iphone-15': 5, 'landscape-phone': 7, 'ipad-mini': 9, desktop: 11 };
let boardTests = 0;

interface BoardCtx { page: Page; api: APIRequestContext; userId: string; id: string; start: number; end: number; hour: number; card: Locator }

function runBoard(title: string, body: (c: BoardCtx) => Promise<void>, only: 'touch' | 'desktop') {
  const testNo = boardTests++ % 2; // the two touch tests of a project take adjacent days
  test(title, async ({ page, session }, testInfo) => {
    test.skip(!selected.has('schedule'), 'MOBILE_GATE_ROUTES does not select schedule');
    const device = gateDevice(testInfo.project.name);
    test.skip(only === 'touch' && !device.touch, 'touch projects only');
    test.skip(only === 'desktop' && device.touch, 'the desktop control only');
    await signIn(page, session, []);
    const api = await adminApi(session);
    const userId = await adminId(api);
    const name = `Gate board ${testInfo.project.name} ${Date.now() % 100000}`;
    const dayOffset = (BOARD_DAY[testInfo.project.name] ?? 1) + (device.touch ? testNo : 0);
    const entry = await createEntry(api, name, userId, dayOffset);
    try {
      await openMemberBoard(page, device.touch, dayOffset);
      const card = page.locator(`[data-board-id="ce-${entry.id}"]`);
      await expect(card, 'the seeded event is a card on the member board').toBeVisible({ timeout: 20_000 });
      await body({ page, api, userId, id: entry.id, start: new Date(entry.start).getTime(), end: new Date(entry.end).getTime(), hour: startHourNY(), card });
    } finally {
      await api.delete(`/api/calendar-entries/${entry.id}`).catch(() => {});
      await keepSession(page, session).catch(() => {});
      await api.dispose();
    }
  });
}

/** Bring the card to the middle of the board's own scroller (both axes). */
async function centreBoardCard(page: Page, card: Locator) {
  await card.evaluate((el) => Element.prototype.scrollIntoView.call(el, { block: 'center', inline: 'center' }));
  await page.waitForTimeout(300);
}

/**
 * A point that really is on the card: its middle is under the member header on a short screen
 * (the header sticks over the grid), so look down the card for the first point the card answers.
 */
async function pointOnCard(card: Locator): Promise<{ x: number; y: number }> {
  const p = await card.evaluate((el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + r.width / 2;
    for (let y = Math.max(r.top + 4, 4); y < Math.min(r.bottom - 2, window.innerHeight - 4); y += 4) {
      if (document.elementFromPoint(x, y)?.closest('[data-board-id]') === el) return { x, y };
    }
    return null;
  });
  if (!p) throw new Error('no part of the card is reachable on screen');
  return p;
}

runBoard('board: a long-press on a card picks it up and a drag to a later hour slot moves it; the move is saved', async ({ page, api, userId, id, start, end, hour, card }) => {
  await centreBoardCard(page, card);
  const slot = page.getByTestId(`grid-slot-${userId}-${hour + 1}`);
  const sb = (await slot.boundingBox())!;
  const vp = page.viewportSize()!;
  const from = await pointOnCard(card);
  // The top of the slot, not its middle: on a short screen the middle is inside the band at the
  // board's lower edge where a held card scrolls the board, which would move the slot mid-drag.
  const to = { x: sb.x + sb.width / 2, y: sb.y + 16 };
  expect(to.y, 'the target slot is on screen').toBeLessThan(vp.height - 4);
  await longPressDrag(page, from, to, { holdMs: 450, durationMs: 700 });

  await expect.poll(async () => (await readEntry(api, id)).start, { message: 'the move was saved', timeout: 10_000 }).not.toBe(start);
  const moved = await readEntry(api, id);
  // The page keeps the seconds of its own clock on a slot drop, so "an hour later" is 60 min and a bit.
  const shifted = (moved.start - start) / 60_000;
  expect(shifted, `moved to the next hour slot (${shifted} min)`).toBeGreaterThanOrEqual(60);
  expect(shifted, `moved to the next hour slot (${shifted} min)`).toBeLessThan(62);
  expect(moved.end - moved.start, 'a move keeps the length').toBe(end - start);
  // The floating copy is gone.
  await expect(page.locator('[data-touch-drag-preview]')).toHaveCount(0);
}, 'touch');

runBoard('board: a swipe that starts on a card scrolls the board and does not move the card', async ({ page, api, id, start, end, card }) => {
  await centreBoardCard(page, card);
  // The nearest ancestor that scrolls up and down is the board's own scroller.
  const scroll = (e: Element) => {
    for (let p = e.parentElement; p; p = p.parentElement) {
      if (/(auto|scroll)/.test(getComputedStyle(p).overflowY) && p.scrollHeight > p.clientHeight + 1) return { top: p.scrollTop, max: p.scrollHeight - p.clientHeight };
    }
    return { top: 0, max: 0 };
  };
  const room = await card.evaluate(scroll);
  expect(room.max, 'the board scrolls (otherwise the swipe proves nothing)').toBeGreaterThan(120);
  const from = await pointOnCard(card);
  const dy = room.top + 120 < room.max ? -90 : 90;
  await swipe(page, from, { x: from.x, y: from.y + dy });
  const after = await card.evaluate(scroll);
  expect(Math.abs(after.top - room.top), 'the swipe scrolled the board').toBeGreaterThan(30);
  await expect(page.locator('[data-touch-drag-preview]'), 'no card was picked up').toHaveCount(0);

  await page.waitForTimeout(800);
  const saved = await readEntry(api, id);
  expect(saved.start, 'a swipe moved no card').toBe(start);
  expect(saved.end).toBe(end);
}, 'touch');

runBoard('desktop control, board: a mouse drag to a later hour slot moves a card as before', async ({ page, api, userId, id, start, end, hour, card }) => {
  await centreBoardCard(page, card);
  await card.dragTo(page.getByTestId(`grid-slot-${userId}-${hour + 1}`));
  await expect.poll(async () => (await readEntry(api, id)).start, { message: 'the move was saved', timeout: 10_000 }).not.toBe(start);
  const moved = await readEntry(api, id);
  const shifted = (moved.start - start) / 60_000;
  expect(shifted, `moved to the next hour slot (${shifted} min)`).toBeGreaterThanOrEqual(60);
  expect(shifted, `moved to the next hour slot (${shifted} min)`).toBeLessThan(62);
  expect(moved.end - moved.start).toBe(end - start);
}, 'desktop');
