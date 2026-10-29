/**
 * Mobile slice 42: the scheduler toolbar is one compact row on a phone and on a phone held
 * sideways, the time grid keeps room on a landscape phone, and Month at phone width is a grid of
 * 44 px day cells that show a count and open that day.
 *
 * What the gate's generic checks cannot see, asserted directly on the six device projects:
 *   - phone (below 768 px) or short (at most 500 px tall): the compact toolbar is ONE row (every
 *     control in the same band, nothing past either edge), its row controls are 44 px on touch, and
 *     the rest of the board's controls are in the "More" sheet under their own names, also 44 px;
 *   - short: the Day view's time grid is at least 200 px tall;
 *   - phone width: every Month day cell is at least 44 x 44, announces its date and event count,
 *     and tapping one opens that day;
 *   - tablet and desktop control: the desktop toolbar and the chip Month view are unchanged (no
 *     compact toolbar, no count cells).
 *
 * Read-only: nothing here saves, sends or schedules. MOBILE_GATE_ROUTES selects it with `schedule`.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { tap } from './touch';

const selected = new Set(selectStates().map((s) => s.id));

const MD = 768;
const SHORT = 500;
/** WCAG 2.5.5 / the programme's touch target. */
const TARGET = 44;

async function press(target: Locator, touch: boolean) {
  if (touch) await tap(target);
  else await target.click();
}

async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
}

interface Box { name: string; x: number; y: number; w: number; h: number }

/** The compact toolbar's own controls, measured in the page. */
function readToolbar(): { present: boolean; barHeight: number; boxes: Box[]; vw: number } {
  const bar = document.querySelector<HTMLElement>('[data-slot="schedule-compact-toolbar"]');
  const vw = document.documentElement.clientWidth;
  if (!bar) return { present: false, barHeight: 0, boxes: [], vw };
  const boxes = [...bar.querySelectorAll<HTMLElement>('button, [role="combobox"]')]
    .filter((el) => el.getBoundingClientRect().width > 0)
    .map((el) => {
      const r = el.getBoundingClientRect();
      return { name: el.getAttribute('aria-label') ?? el.innerText.trim(), x: r.left, y: r.top, w: r.width, h: r.height };
    });
  return { present: true, barHeight: bar.getBoundingClientRect().height, boxes, vw };
}

test('the scheduler toolbar is one compact row on a phone and the desktop toolbar elsewhere', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('schedule'), 'MOBILE_GATE_ROUTES does not select schedule');
  const device = gateDevice(testInfo.project.name);
  const vp = page.viewportSize()!;
  const compact = vp.width < MD || vp.height <= SHORT;
  await signIn(page, session, []);
  try {
    await open(page, '/schedule?view=day');
    const t = await page.evaluate(readToolbar);
    expect(t.present, `compact toolbar at ${vp.width}x${vp.height}`).toBe(compact);

    if (!compact) {
      await expect(page.getByRole('button', { name: 'More schedule options' })).toHaveCount(0);
      await expect(page.getByRole('combobox', { name: 'Filter schedule by department' })).toBeVisible();
      return;
    }

    // ONE row: every control sits in the same horizontal band, and none is past either edge.
    const tops = t.boxes.map((b) => Math.round(b.y));
    expect(Math.max(...tops) - Math.min(...tops), `controls share one row: ${JSON.stringify(t.boxes)}`).toBeLessThanOrEqual(8);
    for (const b of t.boxes) {
      expect(b.x, `${b.name} left edge`).toBeGreaterThanOrEqual(0);
      expect(b.x + b.w, `${b.name} right edge (viewport ${t.vw})`).toBeLessThanOrEqual(t.vw + 0.5);
    }
    expect(t.barHeight, 'the row is a single short band').toBeLessThanOrEqual(60);

    // 44 px on a coarse pointer.
    if (device.touch) {
      for (const b of t.boxes) {
        expect(b.w, `${b.name} width`).toBeGreaterThanOrEqual(TARGET - 0.5);
        expect(b.h, `${b.name} height`).toBeGreaterThanOrEqual(TARGET - 0.5);
      }
    }
    for (const name of ['Previous period', 'Next period', 'More schedule options']) {
      await expect(page.getByRole('button', { name })).toBeVisible();
    }
    await expect(page.getByRole('combobox', { name: 'Calendar view' })).toBeVisible();

    // The rest is one tap away, under its own name, at 44 px.
    await press(page.getByRole('button', { name: 'More schedule options' }), device.touch);
    const sheet = page.getByRole('dialog', { name: 'Schedule options' });
    await expect(sheet).toBeVisible();
    for (const n of ['Today', 'Show fewer hours', 'Show more hours', 'Schedule legend']) {
      const el = sheet.getByRole('button', { name: n });
      await expect(el, n).toBeVisible();
      const box = (await el.boundingBox())!;
      if (device.touch) {
        expect(box.width, `${n} width`).toBeGreaterThanOrEqual(TARGET - 0.5);
        expect(box.height, `${n} height`).toBeGreaterThanOrEqual(TARGET - 0.5);
      }
    }
    const dept = sheet.getByRole('combobox', { name: 'Filter schedule by department' });
    await expect(dept).toBeVisible();
    if (device.touch) expect((await dept.boundingBox())!.height).toBeGreaterThanOrEqual(TARGET - 0.5);
  } finally {
    await keepSession(page, session);
  }
});

test('the time grid keeps at least 200 px on a phone held sideways', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('schedule'), 'MOBILE_GATE_ROUTES does not select schedule');
  const vp = page.viewportSize()!;
  test.skip(vp.height > SHORT, 'only a short viewport is held to the 200 px floor');
  gateDevice(testInfo.project.name);
  await signIn(page, session, []);
  try {
    for (const view of ['day', 'week']) {
      await open(page, `/schedule?view=${view}`);
      const { h, strip } = await page.evaluate(() => ({
        h: document.querySelector('.schedule-cal .rbc-time-content')?.getBoundingClientRect().height ?? 0,
        strip: document.querySelector('.schedule-cal .rbc-allday-cell')?.getBoundingClientRect().height ?? 0,
      }));
      // The 200 px floor is the slice's (the Day view, and a Week with no all-day items). When the
      // week has all-day items, its strip (capped at one pill and the "+N more" chip on a short
      // screen, about 53 px) is chrome the grid gives room to, so the floor is 160 there.
      const floor = view === 'week' && strip > 0 ? 160 : 200;
      expect(h, `${view} time grid height at ${vp.width}x${vp.height} (all-day strip ${Math.round(strip)} px)`).toBeGreaterThanOrEqual(floor);
    }
  } finally {
    await keepSession(page, session);
  }
});

test('Month at phone width: 44 px day cells with a count that open the day; unchanged elsewhere', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('schedule'), 'MOBILE_GATE_ROUTES does not select schedule');
  const device = gateDevice(testInfo.project.name);
  const vp = page.viewportSize()!;
  const phone = vp.width < MD;
  await signIn(page, session, []);
  try {
    await open(page, '/schedule?view=month');
    const cells = page.locator('[data-month-day-cell]');

    if (!phone) {
      await expect(cells, 'wide screens keep the chip Month view').toHaveCount(0);
      return;
    }

    expect(await cells.count(), 'a month grid of day cells').toBeGreaterThanOrEqual(28);
    const boxes = await page.evaluate(() =>
      [...document.querySelectorAll<HTMLElement>('[data-month-day-cell]')].map((el) => {
        const r = el.getBoundingClientRect();
        return { label: el.getAttribute('aria-label') ?? '', w: r.width, h: r.height };
      }),
    );
    const small = boxes.filter((b) => b.w < TARGET - 0.5 || b.h < TARGET - 0.5);
    expect(small, `every cell is at least ${TARGET} px at ${vp.width}px: ${JSON.stringify(small.slice(0, 3))}`).toEqual([]);
    expect(boxes.every((b) => /^\w+, \w+ \d+, (no events|\d+ events?)$/.test(b.label)), 'each cell is named with its date and count').toBe(true);

    // The page itself never scrolls sideways because of the month.
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
    expect(overflow, 'no sideways scroll').toBeLessThanOrEqual(0);

    // The seeded data puts a scheduled job and a walkthrough in the next days; find a busy cell,
    // stepping to the next month if the days fall across the boundary.
    const busy = page.locator('[data-month-day-cell]', { hasText: /\d/ }).filter({ has: page.locator('.month-day-count') });
    if ((await busy.count()) === 0) {
      await press(page.getByRole('button', { name: 'Next period' }), device.touch);
      await expect(page.locator('[data-month-day-cell]').first()).toBeVisible();
    }
    const target = busy.first();
    await expect(target, 'a day with events shows a count').toBeVisible();
    expect(await target.getAttribute('aria-label')).toMatch(/, \d+ events?$/);

    await press(target, device.touch);
    await expect(page.getByRole('combobox', { name: 'Calendar view' }), 'tapping a cell opens that day').toHaveText(/^\s*day\s*$/i);
  } finally {
    await keepSession(page, session);
  }
});
