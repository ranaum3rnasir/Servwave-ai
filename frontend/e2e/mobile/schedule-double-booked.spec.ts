/**
 * Mobile slice 75 follow-up: the Schedule is enforced on every device, with the double-booked cards
 * as one narrow, documented exception (Ran, 2026-10-08, Option A; schedule-double-booked.ts).
 *
 * The gate's own `schedule` test opens the Schedule on its default date, and the throwaway org's jobs
 * and walkthroughs are booked a day or two AHEAD, so on most days none of them is on screen and the
 * exception is never exercised. This test moves the calendar forward until the seeded double-booked
 * cards are on screen (several walkthroughs at one time, several jobs at one time, each a narrow slice
 * of its day column), then runs the same measure() and decide() the gate runs and holds three things:
 *   1. the page is green with the exception on: the narrow cards are excused and NOTHING ELSE fails;
 *   2. the exception really is what holds it green: the same page measured with the exception off
 *      fails on those cards (so a gate that stopped looking would be seen);
 *   3. the cards it excused are time-grid event cards that overlap another card in their day column
 *      (checked here from the page, not from the classifier).
 *
 * Both measurements look at the SAME settled state (mobile slice 85). The Schedule scrolls its time grid
 * to the first hour of its window a moment after it paints, and the gate's scrollReach check then scrolls
 * the grid itself to bring the last control into its box; a measurement taken before that and one taken
 * after it are of different pages. So the grid is first waited out until it stops moving, the cards are
 * held to sit inside the box it shows (a card scrolled out of the grid is still "on screen" in the page's
 * coordinates, under whatever the toolbar has there), and the grid is put back to that resting scroll
 * before each of the two measurements. The seeded cards sit mid-morning on the org's clock whatever hour
 * the gate runs at (schedule-booking.ts), so the result does not depend on the time of day either.
 *
 * What a device proves depends on its column width: where the exception excused something, the same page
 * measured without it must fail on exactly that check; where it excused nothing (the cards are wide
 * enough, or no neighbour crowds them), the page must be green without it, and the run says so.
 * Read-only: nothing is written. MOBILE_GATE_ROUTES selects it with `schedule`.
 */
import { expect, type Page } from '@playwright/test';
import { CHECKS } from './checks';
import { decide, loadAllowlist } from './allowlist';
import { gateDevice } from './devices';
import { measure, settle } from './measure';
import { selectStates } from './routes';
import { FOUR_AT_ONCE, MAX_CARDS_ON_SCREEN } from './schedule-booking';
import { exemptLine, SCHEDULE_CARD_SELECTOR, SCHEDULE_COLUMN_SELECTOR } from './schedule-double-booked';
import { keepSession, signIn, test } from './session';

const selected = new Set(selectStates().map((s) => s.id));
const allowlist = loadAllowlist();

/** The time grid's scroller: the page scrolls it to its window's first hour a moment after it paints. */
const GRID_SELECTOR = '.rbc-time-content';

/**
 * Wait until the grid has stopped scrolling itself (unchanged for 600 ms, at most 8 s), then say where it
 * rests and which box of the page it shows. The box is what a card has to sit inside to be on screen.
 */
const waitForRestingGrid = (page: Page) => page.evaluate(async (sel) => {
  const grid = document.querySelector(sel);
  if (!grid) return null;
  let last = -1, same = 0;
  for (let i = 0; i < 80 && same < 6; i++) {
    same = grid.scrollTop === last ? same + 1 : 0;
    last = grid.scrollTop;
    await new Promise((ok) => setTimeout(ok, 100));
  }
  const b = grid.getBoundingClientRect();
  return { top: grid.scrollTop, box: { top: b.top, bottom: b.bottom, left: b.left, right: b.right } };
}, GRID_SELECTOR);

/** Put the grid back where it rested, and let two frames pass: every measurement starts from the same page. */
const putGridBack = (page: Page, top: number) => page.evaluate(async ({ sel, y }) => {
  const grid = document.querySelector(sel);
  if (grid) grid.scrollTop = y;
  await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
}, { sel: GRID_SELECTOR, y: top });

/** The cards that overlap another card in their day column, with their boxes (the same rule as the classifier's). */
const overlappingCards = (page: Page) => page.evaluate(({ card, column }) => {
  const out: Array<{ name: string; top: number; bottom: number; left: number; right: number; width: number }> = [];
  for (const c of document.querySelectorAll(column)) {
    const els = [...c.querySelectorAll(card)];
    const rects = els.map((e) => e.getBoundingClientRect());
    els.forEach((e, i) => {
      const r = rects[i]!;
      if (r.width <= 0 || r.height <= 0) return;
      const overlaps = rects.some((o, j) => j !== i && o.width > 0 && o.height > 0 && Math.min(o.bottom, r.bottom) - Math.max(o.top, r.top) > 1);
      if (overlaps) out.push({ name: (e.getAttribute('aria-label') || (e as HTMLElement).innerText || 'card').trim().replace(/\s+/g, ' ').slice(0, 30), top: r.top, bottom: r.bottom, left: r.left, right: r.right, width: r.width });
    });
  }
  return out;
}, { card: SCHEDULE_CARD_SELECTOR, column: SCHEDULE_COLUMN_SELECTOR });

test('schedule double-booked cards: enforced everywhere, only the overlapping cards excused', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('schedule'), 'MOBILE_GATE_ROUTES does not select schedule');
  test.skip(!allowlist.acceptedExceptions?.scheduleDoubleBooked, 'allowlist.json does not record acceptedExceptions.scheduleDoubleBooked');
  const device = gateDevice(testInfo.project.name);
  await signIn(page, session, []);
  try {
    await page.goto('/schedule', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);

    // The seeded bookings are one to two days ahead: step forward until the four-at-once case is on screen.
    for (let step = 0; step < 4 && (await overlappingCards(page)).length < FOUR_AT_ONCE; step++) {
      await page.getByRole('button', { name: 'Next period' }).first().click();
      await settle(page, []);
    }
    // Let the grid finish its own scroll before anything is read: this is the page a user is looking at.
    const rest = await waitForRestingGrid(page);
    expect(rest, `schedule on ${device.id}: the time grid (${GRID_SELECTOR}) is not on the page`).not.toBeNull();
    const cards = await overlappingCards(page);
    const doubleBooked = cards.length;
    // The fixed set (schedule-booking.ts): the four walkthroughs `seedGateFixtures` books at one time, and nothing
    // more than the few short-lived cards other specs put on today while they run. Both ends are held: a missing
    // set must not pass as "nothing to check", and a crowd means a spec is booking onto the shared board again
    // (the 26+ cards that once pushed the last 20 px wide card past a 360 px screen).
    expect(doubleBooked, `schedule on ${device.id}: the seeded four-at-once case (4 walkthroughs at one time) is not on the calendar`).toBeGreaterThanOrEqual(FOUR_AT_ONCE);
    expect(
      doubleBooked,
      `schedule on ${device.id}: ${doubleBooked} overlapping cards on screen, the fixed set is at most ${MAX_CARDS_ON_SCREEN}: a spec is booking visits onto the shared board (book them 'apart', see schedule-booking.ts)`,
    ).toBeLessThanOrEqual(MAX_CARDS_ON_SCREEN);
    // Every card is inside the box the grid shows. One scrolled out of it (booked before the window opens or
    // after it closes) is no longer something a user can see, yet still sits under the toolbar in the page's
    // coordinates: the very thing that made this check depend on the hour of the run.
    const box = rest!.box;
    const outside = cards.filter((c) => c.top < box.top - 1 || c.bottom > box.bottom + 1 || c.left < box.left - 1 || c.right > box.right + 1);
    expect(
      outside.map((c) => `${c.name} at ${Math.round(c.top)}..${Math.round(c.bottom)}`),
      `schedule on ${device.id}: double-booked cards outside the visible time grid (${Math.round(box.top)}..${Math.round(box.bottom)}, scrolled to ${rest!.top}): the fixed set must be booked inside the hours the Schedule opens on (schedule-booking.ts)`,
    ).toEqual([]);

    const opts = { touch: device.touch, onlyInOverlays: false, consoleLines: [] as string[] };
    await putGridBack(page, rest!.top);
    const withException = await measure(page, { ...opts, scheduleDoubleBooked: true });
    const verdicts = Object.fromEntries(CHECKS.map((c) => [c, decide(allowlist, 'schedule', c, device.id, withException[c].offenders)]));
    const lines = CHECKS.flatMap((c) => (withException[c].exempt?.length ? [exemptLine(c, withException[c].exempt!)] : []));
    const narrowest = Math.round(Math.min(...cards.map((c) => c.width)) * 10) / 10;
    console.log(`[mobile-gate] ${device.id} schedule (${doubleBooked} double-booked card(s) on screen, narrowest ${narrowest} px, grid at rest scrolled to ${rest!.top})\n${lines.join('\n') || '  nothing excused here: the cards are wide enough, or no other control crowds them'}`);

    // 1. Green with the exception on.
    expect(
      CHECKS.filter((c) => verdicts[c]!.status === 'fail').map((c) => ({ check: c, offenders: withException[c].offenders.slice(0, 8) })),
      `schedule on ${device.id}: nothing but the double-booked cards may be excused`,
    ).toEqual([]);

    // 2. The same page, put back as it was, measured with the exception off.
    //    Where the exception excused something, that is the only thing holding it green: those checks fail.
    //    Where it excused nothing on this device, there is nothing for it to hold: the page is green without it.
    await putGridBack(page, rest!.top);
    const without = await measure(page, { ...opts, scheduleDoubleBooked: false });
    const failing = CHECKS.filter((c) => decide(allowlist, 'schedule', c, device.id, without[c].offenders).status === 'fail');
    const excused = CHECKS.filter((c) => withException[c].exempt?.length);
    if (excused.length > 0) {
      for (const c of excused) expect(failing, `${c} fails without the exception on ${device.id}`).toContain(c);
    } else {
      expect(failing, `nothing was excused on ${device.id}, so the page must be green without the exception too`).toEqual([]);
    }
  } finally {
    await keepSession(page, session);
  }
});

// The seeded cards only reach the scrollReach finding on some dates and widths, so the wiring of the page
// functions (which card a finding is, which card covers the last control) is also held on a page built from
// the calendar's own markup (`.rbc-day-slot` > `.rbc-event`), through the same measure() the gate runs.
// Nothing here talks to a server.
const calendarPage = (body: string) => `<!doctype html><html lang="en"><head><meta name="viewport" content="width=device-width, initial-scale=1"><title>Calendar fixture</title></head>`
  + `<body style="margin:0"><main style="height:360px;overflow-y:auto"><div style="height:700px;position:relative">${body}</div></main></body></html>`;
const card = (style: string, text: string) => `<div class="rbc-event" role="button" tabindex="0" style="position:absolute;background:#ddd;font:10px sans-serif;${style}">${text}</div>`;
const column = (left: number, inner: string) => `<div class="rbc-day-slot" style="position:absolute;top:0;left:${left}px;width:120px;height:700px">${inner}</div>`;

test('schedule double-booked wiring: overlapping cards are excused in a real browser', async ({ page }, testInfo) => {
  test.skip(!selected.has('schedule'), 'MOBILE_GATE_ROUTES does not select schedule');
  const device = gateDevice(testInfo.project.name);
  // Two 20 px cards at the same time in one column, side by side but crowded: A sits over the middle of B.
  await page.setContent(calendarPage(column(10, card('top:560px;left:0;width:22px;height:60px;z-index:2', 'A') + card('top:560px;left:8px;width:20px;height:60px', 'B'))));
  const on = await measure(page, { touch: device.touch, onlyInOverlays: false, consoleLines: [], scheduleDoubleBooked: true });
  expect(on.targets.offenders, 'both overlapping cards are excused').toEqual([]);
  expect(on.targets.exempt, 'and counted').toHaveLength(2);
  expect(on.scrollReach.offenders, 'the card covered by an overlapping card is excused').toEqual([]);
  expect(on.scrollReach.exempt, 'and counted').toHaveLength(1);
  if (device.touch) {
    expect(on.a11y.offenders.filter((o) => o.startsWith('target-size')), 'axe target-size on the overlapping cards is excused').toEqual([]);
    expect(on.a11y.exempt?.length ?? 0, 'and counted').toBeGreaterThan(0);
  }
  // The same page with the exception off fails on all of it.
  const off = await measure(page, { touch: device.touch, onlyInOverlays: false, consoleLines: [], scheduleDoubleBooked: false });
  expect(off.targets.offenders).toHaveLength(2);
  expect(off.scrollReach.offenders).toHaveLength(1);
  expect(off.targets.exempt ?? []).toEqual([]);
});

test('schedule double-booked wiring: everything else on the page still fails', async ({ page }, testInfo) => {
  test.skip(!selected.has('schedule'), 'MOBILE_GATE_ROUTES does not select schedule');
  const device = gateDevice(testInfo.project.name);
  const toolbar = '<div style="position:absolute;top:20px;left:150px"><button style="width:16px;height:16px;padding:0">x</button><button style="width:16px;height:16px;padding:0">y</button></div>';
  // Two 20 px cards that follow each other (touching, never at the same time): small and crowded, but not double-booked.
  const touching = column(10, card('top:100px;left:0;width:20px;height:20px', 'C') + card('top:120px;left:0;width:20px;height:20px', 'D'));
  // A lone card at the bottom with a plain layer (not a card) over it: the last control is covered.
  const covered = column(150, card('top:560px;left:0;width:60px;height:60px', 'Lone'))
    + '<div style="position:absolute;top:560px;left:150px;width:60px;height:60px;z-index:5"></div>';
  await page.setContent(calendarPage(toolbar + touching + covered));
  const on = await measure(page, { touch: device.touch, onlyInOverlays: false, consoleLines: [], scheduleDoubleBooked: true });
  expect(on.targets.exempt ?? [], 'nothing here is a double-booked card').toEqual([]);
  expect(on.targets.offenders.filter((o) => o.includes('"x"') || o.includes('"y"')), 'small toolbar buttons fail').toHaveLength(2);
  expect(on.targets.offenders.filter((o) => o.includes('"C"') || o.includes('"D"')), 'two small cards that only follow each other fail').toHaveLength(2);
  expect(on.scrollReach.exempt ?? [], 'a covering layer that is not a card is not excused').toEqual([]);
  expect(on.scrollReach.offenders, 'the covered last control fails').toHaveLength(1);
  if (device.touch) expect(on.a11y.exempt ?? [], 'axe: no node is a double-booked card').toEqual([]);
});
