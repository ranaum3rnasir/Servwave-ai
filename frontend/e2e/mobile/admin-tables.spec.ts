/**
 * Mobile slice 17 (staging fix 1): a wide admin table keeps its first column in view while it
 * scrolls inside its own box, on EVERY device where the box overflows - not only below `md`.
 *
 * The gate's own first-column check (checks.ts, overflow) can only judge a table that renders and
 * overflows. Settings > Tax rates lists the org's own rates, and the throwaway org has none, so the
 * gate saw an empty state and passed - while on staging, with a full list of states, the box
 * overflowed on the iPad Mini (768) and the landscape phone (838) and the Name column scrolled out
 * of view (the legacy table pinned it below `md` only). The rates cannot be seeded for real: the
 * org purge does not delete org tax rates yet (PURGE_EXEMPT, RESTRICT), so a seeded row would leave
 * the throwaway org behind. This spec swaps the list response for a full list of states instead.
 *
 * On every device project it measures:
 *   - touch devices: after scrolling the box to its far end, the Name cell of every visible row
 *     still starts inside the box (no device is required to overflow since mobile slice 29: see
 *     MUST_OVERFLOW);
 *   - wherever the Name cell is pinned, the rule under it is drawn by the cell itself (separated
 *     borders), so the pinned cell does not paint over its row's rule;
 *   - every device: the page itself never scrolls sideways;
 *   - the desktop control: the table fits its box, as before.
 *
 * Runs with the gate (same projects, same session slots). MOBILE_GATE_ROUTES selects it with
 * `settings-tax-rates`.
 */
import { expect, type Page, type Route } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';

/** A full list of state rates, as an org that seeded every state carries. Neutral, public names. */
const STATES = [
  'Alabama', 'Alaska', 'Arizona', 'Arkansas', 'California', 'Colorado', 'Connecticut', 'Delaware',
  'District of Columbia', 'Florida', 'Georgia', 'Hawaii', 'Idaho', 'Illinois', 'Indiana', 'Iowa',
  'Kansas', 'Kentucky', 'Louisiana', 'Maine', 'Maryland', 'Massachusetts', 'Michigan', 'Minnesota',
  'Mississippi', 'Missouri', 'Montana', 'Nebraska', 'Nevada', 'New Hampshire', 'New Jersey',
  'New Mexico', 'New York', 'North Carolina', 'North Dakota', 'Ohio', 'Oklahoma', 'Oregon',
  'Pennsylvania', 'Rhode Island', 'South Carolina', 'South Dakota', 'Tennessee', 'Texas', 'Utah',
  'Vermont', 'Virginia', 'Washington', 'West Virginia', 'Wisconsin', 'Wyoming',
];

const now = new Date().toISOString();
const RATES = STATES.map((name, i) => ({
  id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
  name,
  rate: (0.04 + (i % 7) * 0.00625).toFixed(5),
  state_code: null,
  is_visible: i % 3 !== 0,
  created_at: now,
  updated_at: now,
}));

/** Answer the settings list with the full list; every other call (and every write) goes through. */
async function withFullList(page: Page) {
  await page.route((url) => url.pathname === '/api/org-tax-rates', async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 200, json: { rates: RATES } });
  });
}

interface BoxReading {
  pageScrollWidth: number;
  viewport: number;
  boxScroll: number;
  boxClient: number;
  firstCellPosition: string;
  borderCollapse: string;
  /** The rule under the first body row's Name cell, drawn by that cell (px). */
  firstBodyCellRule: number;
  /** Rows whose Name cell starts outside the box after scrolling it to its far end. */
  outOfBox: string[];
}

function readBox(): BoxReading {
  const box = document.querySelector('[data-mobile-scroll-x="settings-tax-rates"]') as HTMLElement;
  const table = box.querySelector('table')!;
  const firstCells = [...box.querySelectorAll('tr')].map((tr) => tr.firstElementChild as HTMLElement).filter(Boolean);
  const bodyCell = box.querySelector('tbody tr')!.firstElementChild as HTMLElement;
  const before = box.scrollLeft;
  box.scrollLeft = box.scrollWidth;
  const b = box.getBoundingClientRect();
  const outOfBox = firstCells
    .filter((c) => { const r = c.getBoundingClientRect(); return r.bottom > b.top && r.top < b.bottom; })
    .filter((c) => { const r = c.getBoundingClientRect(); return r.left < b.left - 1 || r.right <= b.left + 1; })
    .map((c) => (c.innerText || '').trim().slice(0, 30));
  box.scrollLeft = before;
  return {
    pageScrollWidth: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
    boxScroll: box.scrollWidth,
    boxClient: box.clientWidth,
    firstCellPosition: getComputedStyle(bodyCell).position,
    borderCollapse: getComputedStyle(table).borderCollapse,
    firstBodyCellRule: parseFloat(getComputedStyle(bodyCell).borderBottomWidth) || 0,
    outOfBox,
  };
}

/**
 * Where the Settings layout leaves the table too little room. Slice 17 measured the box overflowing
 * on the iPad Mini and the landscape phone, where the Settings side nav sat beside the page. Since
 * mobile slice 29 that side nav is a page picker below 1024 px, and the table fits its box on every
 * gate device (a 524 px table in a 524 px box on the landscape phone, 454 in 454 on the iPad Mini),
 * so no device is required to overflow. The Name-column check still runs wherever the box does.
 */
const MUST_OVERFLOW = new Set<string>();

const selected = new Set(selectStates().map((s) => s.id));

test('settings tax rates: the Name column stays in its box on every device', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('settings-tax-rates'), 'MOBILE_GATE_ROUTES does not select settings-tax-rates');
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  await withFullList(page);
  try {
    await page.goto('/settings/tax-rates', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, notes);
    await expect(page.locator('[data-mobile-scroll-x="settings-tax-rates"] tbody tr')).toHaveCount(RATES.length);
    await page.evaluate(() => document.fonts.ready);

    const r = await page.evaluate(readBox);
    await testInfo.attach('tax-rates-box.json', { body: JSON.stringify({ device: device.id, ...r, notes }, null, 1), contentType: 'application/json' });

    expect(r.pageScrollWidth, 'the page itself never scrolls sideways').toBeLessThanOrEqual(r.viewport);
    if (device.touch) {
      // The two devices staging failed on: the box must overflow there, so the check is real.
      // (On the iPhone 15 the single-pane table happens to fit, which is fine.)
      if (MUST_OVERFLOW.has(device.id)) {
        expect(r.boxScroll, `the table overflows its box on ${device.id}, so the check below is real`).toBeGreaterThan(r.boxClient + 1);
      }
      expect(r.outOfBox, 'Name cells that scrolled out of the box at its far end').toEqual([]);
    } else {
      expect(r.boxScroll, 'desktop: the table fits its box, as before').toBeLessThanOrEqual(r.boxClient + 1);
    }
    if (r.firstCellPosition === 'sticky') {
      // A pinned cell is a positioned box painted above the table's collapsed grid, so under
      // `collapse` it covers its row's rule. The rule must be the cell's own (separated borders).
      expect(r.borderCollapse, 'a pinned Name cell needs separated borders').toBe('separate');
      expect(r.firstBodyCellRule, 'the pinned Name cell draws its own row rule').toBeGreaterThanOrEqual(1);
    }
  } finally {
    await keepSession(page, session);
  }
});

/**
 * Mobile slice 17 (staging fix 2): an EMPTY admin table keeps its message in view.
 *
 * The empty state is one cell spanning every column. In a scroll box that table is wider than the
 * box (Assets: a 910 px table in a 513 px box on the iPad Mini), so a message centred across the
 * cell sat half outside the box. The gate's own first-column check reads the header row only and
 * cannot see it. The throwaway org has no assets, so this is the state the gate renders anyway.
 *
 * Also: the box is a named region in the tab order (axe scrollable-region-focusable), so a keyboard
 * user can reach and scroll it although an empty table holds nothing else focusable.
 */
interface EmptyReading {
  boxScroll: number;
  boxClient: number;
  tabIndex: number;
  role: string | null;
  label: string | null;
  /** The title's distance from the box's left and right edges, at rest and at the far end. */
  atRest: [number, number];
  atEnd: [number, number];
}

function readEmptyBox(): EmptyReading | null {
  const box = document.querySelector('[data-mobile-scroll-x="inventory-assets"]') as HTMLElement | null;
  if (!box || box.getBoundingClientRect().width === 0) return null;
  const title = [...box.querySelectorAll('tbody h3')].find((el) =>
    (el as HTMLElement).innerText.trim().startsWith('No assets'),
  ) as HTMLElement | undefined;
  if (!title) return null;
  const edges = (): [number, number] => {
    const b = box.getBoundingClientRect();
    const m = title.getBoundingClientRect();
    return [Math.round(m.left - b.left), Math.round(b.right - m.right)];
  };
  const before = box.scrollLeft;
  box.scrollLeft = 0;
  const atRest = edges();
  box.scrollLeft = box.scrollWidth;
  const atEnd = edges();
  box.scrollLeft = before;
  return {
    boxScroll: box.scrollWidth,
    boxClient: box.clientWidth,
    tabIndex: box.tabIndex,
    role: box.getAttribute('role'),
    label: box.getAttribute('aria-label'),
    atRest,
    atEnd,
  };
}

test('inventory assets: an empty table keeps its message inside its box', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('inventory-assets'), 'MOBILE_GATE_ROUTES does not select inventory-assets');
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  try {
    await page.goto('/inventory/assets', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, notes);
    await expect(page.getByText(/^No assets/).first()).toBeVisible({ timeout: 20_000 });
    const r = await page.evaluate(readEmptyBox);
    await testInfo.attach('assets-empty-box.json', { body: JSON.stringify({ device: device.id, r, notes }, null, 1), contentType: 'application/json' });
    // Below md the list renders cards, not the table: nothing to measure there.
    test.skip(r === null, `${device.id}: the assets list renders cards, not the table`);
    expect(r!.tabIndex, 'the scroll box is in the tab order').toBe(0);
    expect(r!.role).toBe('region');
    expect(r!.label).toBe('Assets table');
    if (device.id === 'ipad-mini') {
      expect(r!.boxScroll, `the empty table overflows its box on ${device.id}, so the check is real`).toBeGreaterThan(r!.boxClient + 1);
    }
    for (const [when, [left, right]] of [['at rest', r!.atRest], ['scrolled to the far end', r!.atEnd]] as const) {
      expect(left, `the message starts inside the box (${when})`).toBeGreaterThanOrEqual(-1);
      expect(right, `the message ends inside the box (${when})`).toBeGreaterThanOrEqual(-1);
    }
  } finally {
    await keepSession(page, session);
  }
});
