/**
 * Mobile slice 30: reports readable on a phone.
 *
 * The gate's generic checks cannot see the three things this slice fixes, so they are asserted
 * here, on every device project (the desktop control included):
 *
 *   - Report titles wrap. The kit page header truncates its h1 on one line, and the report shell
 *     wrapped the title in a flex row, so a long report name was hard-clipped with no ellipsis at
 *     320 ("Revenue - Completed vs Invoiced vs Collected"). The whole title must now sit inside
 *     the h1's box.
 *   - Chart axis labels never overlap and are never clipped. The category axes forced every label
 *     (`interval={0}`), so they ran into each other at 360; and the horizontal bar charts reserved
 *     a fixed 150 px label column plus a wide value margin, which left the bars a sliver and pushed
 *     long names out of the chart. On touch phones the bars must keep at least a third of the
 *     chart's width.
 *   - The Expenses report's filter panel fits the screen. It was `min-w-[680px]` at every width.
 *
 * Items & Services and Expenses are not yet backed by the database, so a real org sees a "coming
 * soon" page for them and only a demo org sees the report. The throwaway org is a real org, so
 * this spec marks it as a demo org in the browser alone (the `/api/auth/me` answer is edited on
 * its way in; nothing is written). The Revenue report is live and runs on the org's own data.
 *
 * Runs with the gate (same projects, same session slots). MOBILE_GATE_ROUTES selects it with
 * `reports` or any `report-*` state. Read-only.
 */
import { expect, type Page, type Route } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';

const selected = selectStates().map((s) => s.id);
const reportsSelected = selected.some((id) => id === 'reports' || id.startsWith('report-'));

/** Show the demo-only reports: flag the org as a demo org in this browser only. */
async function asDemoOrg(page: Page) {
  await page.route((url) => url.pathname === '/api/auth/me', async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const body = await res.json().catch(() => null);
    if (!body?.user) return route.fulfill({ response: res });
    return route.fulfill({ response: res, json: { ...body, user: { ...body.user, org_is_demo: true } } });
  });
}

async function open(page: Page, path: string, notes: string[]) {
  await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, notes);
  await page.evaluate(() => document.fonts.ready);
}

interface TitleReading { text: string; clipped: boolean; scroll: number; client: number; lines: number }

function readTitle(): TitleReading {
  const h1 = document.querySelector('[data-slot="page-header"] h1') as HTMLElement;
  const box = h1.getBoundingClientRect();
  const range = document.createRange();
  range.selectNodeContents(h1);
  const rects = [...range.getClientRects()].filter((r) => r.width > 0);
  const clipped = rects.some((r) => r.right > box.right + 1 || r.left < box.left - 1);
  const tops = new Set(rects.map((r) => Math.round(r.top)));
  return { text: h1.innerText.trim(), clipped, scroll: h1.scrollWidth, client: h1.clientWidth, lines: tops.size };
}

interface ChartReading {
  title: string;
  width: number;
  /** Pairs of tick labels on the same axis whose boxes overlap. */
  overlaps: string[];
  /** Tick labels that run past the chart's own box (the SVG clips them). */
  clipped: string[];
  /** Horizontal bar charts only: the bars' room (the numeric axis's span) as a share of the chart. */
  plotShare: number | null;
}

function readCharts(): ChartReading[] {
  const out: ChartReading[] = [];
  for (const wrapper of document.querySelectorAll<HTMLElement>('.recharts-wrapper')) {
    const svg = wrapper.querySelector('svg.recharts-surface');
    if (!svg) continue;
    const box = svg.getBoundingClientRect();
    if (box.width === 0) continue;
    const card = wrapper.closest('[data-slot="card"], .rounded-lg, section') as HTMLElement | null;
    const title = (card?.querySelector('h3, [data-slot="card-title"]') as HTMLElement | null)?.innerText.trim() ?? '';
    const overlaps: string[] = [];
    const clipped: string[] = [];
    for (const axis of wrapper.querySelectorAll('.recharts-cartesian-axis')) {
      const ticks = [...axis.querySelectorAll('.recharts-cartesian-axis-tick text')]
        .map((t) => ({ text: (t.textContent ?? '').trim(), r: t.getBoundingClientRect() }))
        .filter((t) => t.text && t.r.width > 0);
      for (const t of ticks) {
        if (t.r.left < box.left - 1 || t.r.right > box.right + 1) clipped.push(t.text);
      }
      for (let i = 0; i < ticks.length; i++) {
        for (let j = i + 1; j < ticks.length; j++) {
          const a = ticks[i]!.r;
          const b = ticks[j]!.r;
          const w = Math.min(a.right, b.right) - Math.max(a.left, b.left);
          const h = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
          if (w > 0.5 && h > 0.5) overlaps.push(`${ticks[i]!.text} / ${ticks[j]!.text}`);
        }
      }
    }
    let plotShare: number | null = null;
    const vertical = wrapper.querySelector('.recharts-yAxis .recharts-cartesian-axis-tick text') &&
      wrapper.querySelector('.recharts-bar-rectangle') &&
      [...wrapper.querySelectorAll('.recharts-yAxis .recharts-cartesian-axis-tick text')].some((t) => /[a-z]{3}/i.test(t.textContent ?? ''));
    if (vertical) {
      const line = wrapper.querySelector('.recharts-xAxis') as SVGGElement | null;
      const ticks = [...(line?.querySelectorAll('.recharts-cartesian-axis-tick') ?? [])].map((t) => t.getBoundingClientRect());
      if (ticks.length >= 2) {
        const centres = ticks.map((r) => r.left + r.width / 2);
        plotShare = (Math.max(...centres) - Math.min(...centres)) / box.width;
      }
    }
    out.push({ title, width: Math.round(box.width), overlaps, clipped, plotShare });
  }
  return out;
}

/** Read the charts once they are drawn; a dev-server reload mid-read is retried once. */
async function chartsWhenDrawn(page: Page): Promise<ChartReading[]> {
  for (let attempt = 0; ; attempt++) {
    try {
      await expect(page.locator('.recharts-wrapper').first()).toBeVisible({ timeout: 30_000 });
      await expect(page.locator('.recharts-cartesian-axis-tick text').first()).toBeVisible();
      return await page.evaluate(readCharts);
    } catch (e) {
      if (attempt > 0 || !/context was destroyed/i.test(String(e))) throw e;
      await page.waitForLoadState('domcontentloaded');
    }
  }
}

function pageScroll() {
  return { scroll: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth };
}

test('reports: a long report title wraps inside its header', async ({ page, session }, testInfo) => {
  test.skip(!reportsSelected, 'MOBILE_GATE_ROUTES selects no report state');
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  try {
    await open(page, '/reports/revenue', notes);
    await expect(page.locator('[data-slot="page-header"] h1')).toContainText('Completed vs Invoiced vs Collected');
    const t = await page.evaluate(readTitle);
    await testInfo.attach('report-title.json', { body: JSON.stringify({ device: device.id, ...t, notes }, null, 1), contentType: 'application/json' });
    expect(t.clipped, `the title "${t.text}" is clipped by its header`).toBe(false);
    expect(t.scroll, 'the title does not overflow its h1').toBeLessThanOrEqual(t.client + 1);
    if (device.id === 'iphone-se') expect(t.lines, 'at 320 the long title takes more than one line').toBeGreaterThan(1);
    expect((await page.evaluate(pageScroll)).scroll).toBeLessThanOrEqual((await page.evaluate(pageScroll)).viewport);
  } finally {
    await keepSession(page, session);
  }
});

test('reports: revenue chart axes are readable', async ({ page, session }, testInfo) => {
  test.skip(!reportsSelected, 'MOBILE_GATE_ROUTES selects no report state');
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  try {
    await open(page, '/reports/revenue', notes);
    const charts = await chartsWhenDrawn(page);
    await testInfo.attach('revenue-charts.json', { body: JSON.stringify({ device: device.id, charts, notes }, null, 1), contentType: 'application/json' });
    expect(charts.length, 'the revenue report draws its two charts').toBeGreaterThanOrEqual(2);
    for (const c of charts) {
      expect(c.overlaps, `overlapping axis labels in "${c.title}" (${c.width}px)`).toEqual([]);
      expect(c.clipped, `axis labels cut off in "${c.title}" (${c.width}px)`).toEqual([]);
    }
  } finally {
    await keepSession(page, session);
  }
});

test('reports: items and services charts keep room for the bars', async ({ page, session }, testInfo) => {
  test.skip(!reportsSelected, 'MOBILE_GATE_ROUTES selects no report state');
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  await asDemoOrg(page);
  try {
    await open(page, '/reports/items-and-services', notes);
    await expect(page.locator('.recharts-bar-rectangle').first()).toBeVisible({ timeout: 30_000 });
    const charts = await chartsWhenDrawn(page);
    await testInfo.attach('items-services-charts.json', { body: JSON.stringify({ device: device.id, charts, notes }, null, 1), contentType: 'application/json' });
    expect(charts.length, 'the report draws its two charts').toBeGreaterThanOrEqual(2);
    const bars = charts.filter((c) => c.plotShare != null);
    expect(bars.length, 'the weekly movers chart is a horizontal bar chart').toBeGreaterThanOrEqual(1);
    for (const c of charts) {
      expect(c.overlaps, `overlapping axis labels in "${c.title}" (${c.width}px)`).toEqual([]);
      expect(c.clipped, `axis labels cut off in "${c.title}" (${c.width}px)`).toEqual([]);
    }
    if (device.touch && device.id !== 'ipad-mini' && device.id !== 'landscape-phone') {
      for (const c of bars) {
        expect(c.plotShare!, `the bars in "${c.title}" get at least a third of the chart (${c.width}px)`).toBeGreaterThanOrEqual(1 / 3);
      }
    }
    const p = await page.evaluate(pageScroll);
    expect(p.scroll, 'the page never scrolls sideways').toBeLessThanOrEqual(p.viewport);
  } finally {
    await keepSession(page, session);
  }
});

test('reports: the expenses filter panel fits the screen', async ({ page, session }, testInfo) => {
  test.skip(!reportsSelected, 'MOBILE_GATE_ROUTES selects no report state');
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  await asDemoOrg(page);
  try {
    await open(page, '/reports/expenses', notes);
    const field = page.getByPlaceholder('Filter results');
    await expect(field).toBeVisible({ timeout: 30_000 });
    await field.click();
    // The panel is the last child of the filter's own wrapper (selected by structure, so the same
    // spec measures the panel before and after this slice).
    const panel = field.locator('xpath=ancestor::div[contains(concat(" ", @class, " "), " relative ")][1]/div[last()]');
    await expect(panel).toBeVisible();
    const r = await panel.evaluate((el) => {
      const b = el.getBoundingClientRect();
      const groups = [...el.children].map((g) => g.getBoundingClientRect());
      return {
        left: b.left, right: b.right, bottom: b.bottom,
        viewport: document.documentElement.clientWidth,
        height: window.innerHeight,
        groupsOutside: groups.filter((g) => g.right > b.right + 1 || g.left < b.left - 1).length,
        sideways: el.scrollWidth > el.clientWidth + 1,
      };
    });
    await testInfo.attach('expenses-facet-panel.json', { body: JSON.stringify({ device: device.id, ...r, notes }, null, 1), contentType: 'application/json' });
    expect(r.left, 'the panel starts on screen').toBeGreaterThanOrEqual(-1);
    expect(r.right, 'the panel ends on screen').toBeLessThanOrEqual(r.viewport + 1);
    expect(r.groupsOutside, 'every filter group sits inside the panel').toBe(0);
    expect(r.sideways, 'the panel does not scroll sideways').toBe(false);
    const p = await page.evaluate(pageScroll);
    expect(p.scroll, 'the page never scrolls sideways').toBeLessThanOrEqual(p.viewport);
  } finally {
    await keepSession(page, session);
  }
});
