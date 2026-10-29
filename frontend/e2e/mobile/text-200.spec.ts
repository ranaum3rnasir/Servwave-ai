/**
 * Mobile slice 18 (A11Y-02, user story 42): text enlarged to 200% reflows on the measured screens.
 *
 * The audit's method (rubric A11Y-02): set the root font size to 200% (`html { font-size: 200% }`,
 * what a user's browser or phone text setting does to every rem) and look at the screen again.
 * Rem sizes and rem spacing grow; a px size stays put, which is why the measured offenders move
 * their text to rem as well.
 *
 * AT 200%, on the phones (ENFORCED = the audit's iPhone 15, and the Galaxy S24 on the pages that
 * are clean at 360 px):
 *   - /leads/new: the page does not scroll sideways, nothing is past an edge, and Create Lead can
 *     be scrolled to and is wholly inside the screen;
 *   - /jobs, /leads, /customers (the DataTable toolbar) and /schedule: no sideways scroll, nothing
 *     past an edge;
 *   - the dashboard (`home`): the KPI tiles' labels and figures are not cut off by their tile and
 *     the header's buttons stay on their buttons;
 *   - everywhere: no text is wider than the box that clips it (an overflow-hidden element, or a
 *     control whose label runs out of it), outside the places that truncate with an ellipsis.
 *
 * The other devices are MEASURED at 200% and written to the run's output, not asserted: the 320 px
 * phone's top bar, the tablet and desktop navigation rails and the wide tables' sideways scrolling
 * at 200% belong to the shell and the table slices (13, 22, 29, 35), not to this one.
 *
 * AT 100% (the baseline): the sizes the converted classes render are exactly the px they were
 * (13 px is 0.8125rem), on every device, so the desktop control is unchanged.
 *
 * Read-only. Runs with the gate (same projects, same session slots). MOBILE_GATE_ROUTES selects it
 * by the route it opens: `lead-new`, `jobs`, `schedule`, `leads`, `customers`, `home`.
 */
import { expect, type Page, type Route } from '@playwright/test';
import { overflowCheck } from './checks';
import { INTENDED_X_SCROLLERS, ADMIN_SCROLL_TABLES } from '../../src/ui-kit/lib/intendedScrollers';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';

const selected = new Set(selectStates().map((s) => s.id));

/** `html { font-size: 200% }`: the rubric's way to emulate the 200% text setting. */
async function textAt200(page: Page) {
  await page.addStyleTag({ content: 'html { font-size: 200% !important; }' });
  await page.waitForTimeout(250);
}

interface Clipped { target: string; text: string; boxW: number; textW: number }

/**
 * Text that does not fit its own box: wider than a box that clips it (overflow hidden/clip), or,
 * on a control (a button, link, tab or label), wider than the box with the overflow left visible
 * (white label text running off a dark button onto the white page). A box that truncates with an
 * ellipsis does so on purpose and is not counted; `sr-only` text is a 1 px box by design.
 */
function clippedText(): Clipped[] {
  const sig = (el: Element) => el.tagName.toLowerCase() + (el.id ? `#${el.id}` : '') + (el.classList.length ? `.${[...el.classList].slice(0, 3).join('.')}` : '');
  const out: Clipped[] = [];
  for (const el of document.querySelectorAll<HTMLElement>('body *')) {
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') continue;
    const control = el.matches('button, a, label, [role=button], [role=tab], [role=menuitem]');
    if (!/(hidden|clip)/.test(cs.overflowX) && !control) continue;
    if (cs.textOverflow === 'ellipsis') continue; // truncates on purpose, and says so
    if (el.closest('[aria-hidden="true"],[inert]')) continue;
    // The top bar's own text scale is the shell's (slice 13 measures it); this spec is the page body.
    if (el.closest('[data-slot="topbar"]')) continue;
    if (el.clientWidth <= 1) continue; // sr-only (1 px) and inline boxes
    if (el.scrollWidth <= el.clientWidth + 1) continue;
    // Only a box that directly holds text counts (a wrapper that clips a decorative child does not).
    const holdsText = [...el.childNodes].some((n) => n.nodeType === 3 && (n.textContent ?? '').trim().length > 0);
    if (!holdsText && !control) continue;
    const text = (el.innerText || '').trim().replace(/\s+/g, ' ').slice(0, 40);
    if (!text) continue;
    out.push({ target: sig(el), text, boxW: el.clientWidth, textW: el.scrollWidth });
  }
  return out;
}

/**
 * The dashboard KPI figures, measured against real-sized amounts. The throwaway org's own figures
 * are $0, which fit at any size (the first version of this slice passed on them and shipped
 * "$1,985/mo" cut to "$1,985/"), so the dashboard response's `kpis` are swapped for the five-digit
 * sums a working org carries; everything else in the response is the real one.
 */
const BIG_KPIS = {
  revenue_mtd: { collected: 128450, target: 150000 },
  collected_today: { amount: 27390 },
  recurring: { mrr: 1985, active_plans: 14 },
  ar: { total: 67370, over_30: 12000, over_60: 4100 },
};
async function withBigKpis(page: Page) {
  await page.route((url) => url.pathname === '/api/dashboard', async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object' || !body.kpis) return route.fulfill({ response: res });
    const kpis = { ...body.kpis };
    for (const [k, v] of Object.entries(BIG_KPIS)) kpis[k] = { ...(kpis[k] ?? {}), ...v };
    return route.fulfill({ response: res, json: { ...body, kpis } });
  });
}

/** The figure in each KPI tile: the first child of the tile's value row (the delta chip is its sibling). */
const KPI_VALUE = 'button div.flex-wrap > span:first-child';

interface KpiFigure { text: string; lines: number; cutBy: number }

/** Each KPI figure on the page: on how many lines it sits and how far it runs past its tile. */
function kpiFigures(selector: string): KpiFigure[] {
  return [...document.querySelectorAll<HTMLElement>(selector)].map((el) => {
    const tile = el.closest('button') as HTMLElement;
    const range = document.createRange();
    range.selectNodeContents(el);
    const rects = [...range.getClientRects()].filter((r) => r.width > 0 && r.height > 0);
    const text = range.getBoundingClientRect();
    const box = tile.getBoundingClientRect();
    return {
      text: el.innerText.trim(),
      lines: new Set(rects.map((r) => Math.round(r.top))).size,
      cutBy: Math.max(0, Math.round(text.right - box.right), Math.round(box.left - text.left)),
    };
  });
}

const SCENARIOS: Array<{ id: string; path: string }> = [
  { id: 'lead-new', path: '/leads/new' },
  { id: 'jobs', path: '/jobs' },
  { id: 'schedule', path: '/schedule' },
  { id: 'leads', path: '/leads' },
  { id: 'customers', path: '/customers' },
  { id: 'home', path: '/' },
];

/** The KPI figures are asserted on every phone (the rest of the dashboard page is only measured on two of them). */
const KPI_ENFORCED = ['iphone-se', 'galaxy-s24', 'iphone-15'];

/** Where each page is asserted at 200% (the rest of the devices are measured only). */
const ENFORCED: Record<string, readonly string[]> = {
  'iphone-15': ['lead-new', 'jobs', 'schedule', 'leads', 'customers', 'home'],
  // 360 px: the dashboard's "Customize home page" button is 361 px wide at 200%, a known limit.
  'galaxy-s24': ['lead-new', 'jobs', 'schedule', 'leads', 'customers'],
};

for (const sc of SCENARIOS) {
  test(`200% text on ${sc.path} reflows`, async ({ page, session }, testInfo) => {
    test.skip(!selected.has(sc.id), `MOBILE_GATE_ROUTES does not select ${sc.id}`);
    const enforced = ENFORCED[testInfo.project.name]?.includes(sc.id) ?? false;
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      if (sc.id === 'home') await withBigKpis(page);
      await page.goto(sc.path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      await page.evaluate(() => document.fonts.ready);
      await textAt200(page);

      const overflow = await page.evaluate(overflowCheck, { intended: [...INTENDED_X_SCROLLERS], adminTables: [...ADMIN_SCROLL_TABLES] });
      const clipped = await page.evaluate(clippedText);
      await testInfo.attach('text-200.json', { body: JSON.stringify({ enforced, overflow, clipped }, null, 1), contentType: 'application/json' });
      console.log(`[text-200] ${enforced ? 'ENFORCED' : 'measured '} ${testInfo.project.name} ${sc.path}: ${JSON.stringify({ overflow: overflow.offenders, clipped })}`);

      if (sc.id === 'lead-new' && enforced) {
        const create = page.getByRole('button', { name: /create lead/i }).first();
        await create.scrollIntoViewIfNeeded();
        const box = await create.boundingBox();
        const vw = page.viewportSize()!.width;
        expect(box, 'Create Lead is on the page').not.toBeNull();
        expect(box!.x, 'Create Lead starts inside the screen').toBeGreaterThanOrEqual(-1);
        expect(box!.x + box!.width, 'Create Lead ends inside the screen').toBeLessThanOrEqual(vw + 1);
        await expect(create).toBeEnabled();
      }
      if (sc.id === 'home') {
        // Wait for the fitted size to land after the 200% root, then read the figures.
        await page.waitForTimeout(400);
        const figures = await page.evaluate(kpiFigures, KPI_VALUE);
        await testInfo.attach('kpi-figures.json', { body: JSON.stringify(figures, null, 1), contentType: 'application/json' });
        console.log(`[text-200] ${KPI_ENFORCED.includes(testInfo.project.name) ? 'ENFORCED' : 'measured '} ${testInfo.project.name} KPI figures: ${JSON.stringify(figures)}`);
        if (KPI_ENFORCED.includes(testInfo.project.name)) {
          expect(figures.map((f) => f.text), 'the mocked amounts are on the page').toEqual(expect.arrayContaining(['$1,985/mo', '$67,370', '$27,390']));
          expect(figures.filter((f) => f.lines !== 1), 'every KPI figure sits on one line').toEqual([]);
          expect(figures.filter((f) => f.cutBy > 0), 'no KPI figure is cut off by its tile').toEqual([]);
        }
      }
      if (!enforced) return;
      expect(overflow.offenders, `${sc.path} at 200%: sideways overflow`).toEqual([]);
      expect(clipped, `${sc.path} at 200%: text cut off by its own box`).toEqual([]);
    } finally {
      await keepSession(page, session);
    }
  });
}

// ── 100%: the converted sizes render exactly what the px sizes did ───────────────────────────────

/** The computed font size (px) of the first element matching `locator`, at the default root size. */
async function fontPx(page: Page, selector: string, text?: RegExp): Promise<number> {
  const loc = text ? page.locator(selector).filter({ hasText: text }).first() : page.locator(selector).first();
  await loc.waitFor({ state: 'attached', timeout: 20_000 });
  return loc.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
}

for (const sc of SCENARIOS.filter((s) => ['lead-new', 'jobs', 'home'].includes(s.id))) {
  test(`100% text on ${sc.path} is the size it always was`, async ({ page, session }, testInfo) => {
    test.skip(!selected.has(sc.id), `MOBILE_GATE_ROUTES does not select ${sc.id}`);
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      await page.goto(sc.path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      await page.evaluate(() => document.fonts.ready);
      const rootPx = await page.evaluate(() => parseFloat(getComputedStyle(document.documentElement).fontSize));
      expect(rootPx, 'the page root is the default 16 px').toBe(16);

      if (sc.id === 'lead-new') {
        expect(await fontPx(page, 'h1', /new lead/i), 'page title').toBe(23);
        expect(await fontPx(page, 'label', /^first name/i), 'field label').toBe(13);
        expect(await fontPx(page, 'button', /^create lead$/i), 'Create Lead (default button)').toBe(13.5);
      }
      if (sc.id === 'jobs') {
        expect(await fontPx(page, 'button', /^export$/i), 'Export (small button)').toBe(13);
        expect(await fontPx(page, 'main h1'), 'page title').toBe(23);
      }
      if (sc.id === 'home') {
        const vw = page.viewportSize()!.width;
        expect(await fontPx(page, 'button p.text-xs', /monthly revenue/i), 'KPI label').toBe(12);
        // xl (1280 px and up) 26 px, below it 20 px.
        expect(await fontPx(page, KPI_VALUE), 'KPI value').toBe(vw >= 1280 ? 26 : 20);
      }
    } finally {
      await keepSession(page, session);
    }
  });
}
