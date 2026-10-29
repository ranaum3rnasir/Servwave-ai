/**
 * Mobile slice F03a: a KPI figure never breaks inside the number, at any width from 320 px up.
 *
 * Slice 03 put two tiles in a 320 px row and let the value break anywhere, so "$94,760.21" read
 * "$94,760." on one line and "21" on the next. The throwaway org's own figures are a few hundred
 * dollars and fit at any size, so this spec swaps the list responses' `stats` for the sizes a
 * busy org carries (five to eight figures) and keeps the real rows. It then measures, on every
 * device project, that each tile's value and its second figure:
 *   - sit on ONE line (the text's line boxes all share one top),
 *   - are not cut off by the tile (the text ends inside the tile's padding box),
 *   - are still readable (12 px for the value, 11 px for the second figure: the floors the tile fits to),
 *   - and are the mocked figures, so a page that never showed them cannot pass.
 *
 * Runs with the gate (same projects, same session slots). MOBILE_GATE_ROUTES selects it the way it
 * selects the gate's states: `invoices` and `estimates`.
 */
import { expect, type Page, type Route } from '@playwright/test';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';

const BIG = {
  invoices: {
    due: { total: '94760.21', count: 37 },
    overdue: { total: '1234567.89', count: 12 },
    need_invoices: 1234,
    deposits_held: '84911.57',
  },
  estimates: {
    draft: { count: 1204, value: '84911.57' },
    sent: { count: 318, value: '1234567.89' },
    pending: { count: 96, value: '22087.34' },
    won: { count: 2210, value: '9876543.21' },
    declined: { count: 41, value: '25946.36' },
    archived: { count: 7, value: '94760.21' },
    pending_deposits: { total: '12345678.90', count: 3 },
  },
} as const;

/** The figures each page must show, formatted as the app formats them. */
const EXPECTED: Record<keyof typeof BIG, string[]> = {
  invoices: ['$94,760.21', '$1,234,567.89', '1234', '$84,911.57'],
  estimates: ['$84,911.57', '$1,234,567.89', '$22,087.34', '$9,876,543.21', '$25,946.36', '$94,760.21', '$12,345,678.90'],
};

/** The smallest each figure may be fitted to (VALUE_FLOOR_PX / DETAIL_FLOOR_PX in statCard.tsx). */
const FLOOR_PX: Record<string, number> = { 'stat-card-value': 12, 'stat-card-detail': 11 };

/** Replace the list response's `stats` with BIG figures; everything else is the real response. */
async function withBigStats(page: Page, kind: keyof typeof BIG) {
  await page.route((url) => url.pathname === `/api/${kind}`, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') return route.fulfill({ response: res });
    return route.fulfill({ response: res, json: { ...body, stats: { ...(body.stats ?? {}), ...BIG[kind] } } });
  });
}

interface FigureReading { slot: string; text: string; lines: number; cutBy: number; fontPx: number }

/** Every KPI figure on the page, measured in the browser. */
function readFigures(): FigureReading[] {
  return [...document.querySelectorAll('[data-slot="stat-card-value"], [data-slot="stat-card-detail"]')].map((el) => {
    const tile = el.closest('[data-slot="stat-card"]') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    const tops = new Set(rects.map((r) => Math.round(r.top)));
    const text = range.getBoundingClientRect();
    const box = tile.getBoundingClientRect();
    const cs = getComputedStyle(tile);
    const innerLeft = box.left + parseFloat(cs.borderLeftWidth);
    const innerRight = box.right - parseFloat(cs.borderRightWidth);
    return {
      slot: el.getAttribute('data-slot')!,
      text: (el as HTMLElement).innerText.trim(),
      lines: tops.size,
      // How far the text runs past the tile's inner edge (> 0 = clipped by overflow-hidden).
      cutBy: Math.max(0, Math.round(text.right - innerRight), Math.round(innerLeft - text.left)),
      fontPx: parseFloat(getComputedStyle(el).fontSize),
    };
  });
}

const selected = new Set(selectStates().map((s) => s.id));

for (const kind of ['invoices', 'estimates'] as const) {
  test(`kpi figures on /${kind} never break inside the number`, async ({ page, session }, testInfo) => {
    test.skip(!selected.has(kind), `MOBILE_GATE_ROUTES does not select ${kind}`);
    const notes: string[] = [];
    await signIn(page, session, notes);
    await withBigStats(page, kind);
    try {
      await page.goto(`/${kind}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      await expect(page.locator('[data-slot="stat-card-value"]').first()).toBeVisible();
      // Fonts change every width measured below; measure only once they are in.
      await page.evaluate(() => document.fonts.ready);
      await page.waitForTimeout(200);

      const figures = await page.evaluate(readFigures);
      await testInfo.attach('kpi-figures.json', { body: JSON.stringify(figures, null, 1), contentType: 'application/json' });

      const shown = figures.map((f) => f.text);
      for (const want of EXPECTED[kind]) expect(shown, `/${kind} shows the mocked figure ${want}`).toContain(want);

      const broken = figures.filter((f) => f.lines !== 1 || f.cutBy > 0 || f.fontPx < FLOOR_PX[f.slot]!);
      expect(broken, `/${kind}: KPI figures that wrap, are cut off, or shrank below their floor`).toEqual([]);
    } finally {
      await keepSession(page, session);
    }
  });
}
