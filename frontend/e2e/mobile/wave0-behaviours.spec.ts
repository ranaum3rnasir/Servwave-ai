/**
 * Mobile slice GC1 (gate catch-up): the wave-0 behaviours that merged before the gate existed,
 * asserted on the six device projects so a later change cannot quietly undo them.
 *
 * Slices 02, 03, 04 and 06 proved their device behaviour with one-off Playwright runs and Vitest,
 * because slice 01's gate was not on staging yet. The gate's generic checks (overflow, targets...)
 * cannot see these behaviours, so each one gets a direct assertion here:
 *
 *   - 02 `schedule`: the board opens on Day below md (768 px) and on Week from md up; a view the
 *     user picks is kept for the tab's session; `?view=` wins at every width; a phone's empty
 *     state never points at "the panel on the left".
 *   - 03 `job-detail`: the job page's tabs sit on ONE row that scrolls inside itself, and the
 *     selected tab is scrolled fully into that row on load and on every change.
 *   - 03 `jobs`, `leads`, `customers`, `estimates`, `invoices`: KPI tiles are two per row below
 *     sm (640 px), never one, and more than two on the desktop control (four at xl).
 *   - 04 `public-estimate-open`: the organisation's FULL terms are on the page (a long text
 *     starts clamped behind a "Show full terms" disclosure that opens all of it), the agree
 *     checkbox comes after the text; and on `public-estimate-open` / `public-invoice-open` the PDF
 *     link opens in the same tab and returns the PDF itself, inline, not the app shell.
 *   - 06 `home`: the served head carries the apple-touch-icon (a real PNG), a theme colour and a
 *     light colour scheme.
 *
 * Runs with the gate (same projects, same session slots). MOBILE_GATE_ROUTES selects each test by
 * the route it opens. Read-only: nothing here saves, signs or sends.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'fs';
import { gateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test } from './session';
import { tap } from './touch';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

/** Tailwind's md and sm, the breakpoints slices 02 and 03 key on. */
const MD = 768;
const SM = 640;

/** Tap on a touch project, click on the desktop control (touch.ts refuses touch without touch). */
async function press(target: Locator, touch: boolean) {
  if (touch) await tap(target);
  else await target.click();
}

async function open(page: Page, url: string) {
  const notes: string[] = [];
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, notes);
  return notes;
}

// ---------------------------------------------------------------------------------------------
// Slice 02: the scheduler's opening view.
// ---------------------------------------------------------------------------------------------

test('schedule opens on Day below md and Week from md, keeps a picked view, and a URL view wins', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('schedule'), 'MOBILE_GATE_ROUTES does not select schedule');
  const device = gateDevice(testInfo.project.name);
  const width = page.viewportSize()!.width;
  const phone = width < MD;
  await signIn(page, session, []);
  try {
    const viewTrigger = page.getByRole('combobox', { name: 'Calendar view' });

    // A fresh context: no session choice, no URL view -> the width default.
    await open(page, '/schedule');
    await expect(viewTrigger).toBeVisible();
    await expect(viewTrigger, `default view at ${width}px`).toHaveText(phone ? /^\s*day\s*$/i : /^\s*week\s*$/i);
    if (phone) {
      expect(await page.evaluate(() => document.body.innerText), 'a phone empty state never points at a side panel').not.toMatch(/panel on the left/i);
    }

    // Pick the other view; it is kept for the session across a navigation away and back.
    const picked = phone ? 'week' : 'day';
    await press(viewTrigger, device.touch);
    await press(page.getByRole('option', { name: new RegExp(`^${picked}$`, 'i') }), device.touch);
    await expect(viewTrigger).toHaveText(new RegExp(`^\\s*${picked}\\s*$`, 'i'));
    // A new visit in the same tab: the board mounts again from scratch, sessionStorage survives.
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    await expect(viewTrigger, 'the picked view is kept for the session').toHaveText(new RegExp(`^\\s*${picked}\\s*$`, 'i'));

    // An explicit view in the URL wins over both the session choice and the width default.
    await open(page, '/schedule?view=month');
    await expect(viewTrigger, '?view=month wins').toHaveText(/^\s*month\s*$/i);
  } finally {
    await keepSession(page, session);
  }
});

// ---------------------------------------------------------------------------------------------
// Slice 03: one-row tab strip on the job page.
// ---------------------------------------------------------------------------------------------

interface StripReading { tabs: number; rows: number; selectedInside: boolean; selectedLabel: string; scrolls: boolean }

/** The tab strip row: its tabs' rows, and whether the selected tab sits fully inside the row's visible box. */
function readStrip(): StripReading | null {
  const row = document.querySelector<HTMLElement>('[data-mobile-scroll-x="tab-strip"]');
  if (!row) return null;
  const tabs = [...row.querySelectorAll<HTMLElement>('[role="tab"]')];
  const tops = new Set(tabs.map((t) => Math.round(t.getBoundingClientRect().top)));
  const sel = row.querySelector<HTMLElement>('[role="tab"][aria-selected="true"]');
  const r = row.getBoundingClientRect();
  const s = sel?.getBoundingClientRect();
  return {
    tabs: tabs.length,
    rows: tops.size,
    selectedInside: !!s && s.left >= r.left - 1 && s.right <= r.right + 1,
    selectedLabel: sel?.innerText.trim() ?? '',
    scrolls: row.scrollWidth > row.clientWidth,
  };
}

test('job page tabs stay on one row and keep the selected tab in view', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('job-detail'), 'MOBILE_GATE_ROUTES does not select job-detail');
  const width = page.viewportSize()!.width;
  await signIn(page, session, []);
  try {
    await open(page, `/jobs/${fixtures().jobId}`);
    await expect(page.locator('[data-mobile-scroll-x="tab-strip"] [role="tab"]').first()).toBeVisible();

    const onLoad = await page.evaluate(readStrip);
    await testInfo.attach('tab-strip.json', { body: JSON.stringify({ width, onLoad }, null, 1), contentType: 'application/json' });
    expect(onLoad, 'the job page renders the shared tab strip').not.toBeNull();
    expect(onLoad!.tabs, 'the job page has its tabs').toBeGreaterThan(3);
    expect(onLoad!.rows, `the job page tabs sit on ONE row at ${width}px`).toBe(1);
    expect(onLoad!.selectedInside, 'the selected tab is in view on load').toBe(true);
    if (width <= 393) expect(onLoad!.scrolls, `at ${width}px the row scrolls inside itself rather than wrapping`).toBe(true);

    // On change: move to the LAST tab with End (focus only), put the row back at its start, then
    // select it. The strip itself must scroll the newly selected tab fully into the row.
    const row = page.locator('[data-mobile-scroll-x="tab-strip"]');
    await row.locator('[role="tab"][aria-selected="true"]').focus();
    await page.keyboard.press('End');
    await row.evaluate((el) => { el.scrollLeft = 0; });
    await page.keyboard.press('Enter');
    await expect(row.locator('[role="tab"]').last()).toHaveAttribute('aria-selected', 'true');
    await page.waitForTimeout(150);
    const onChange = await page.evaluate(readStrip);
    expect(onChange!.rows, 'still one row after a change').toBe(1);
    expect(onChange!.selectedInside, `the newly selected tab "${onChange!.selectedLabel}" is scrolled into view`).toBe(true);
  } finally {
    await keepSession(page, session);
  }
});

// ---------------------------------------------------------------------------------------------
// Slice 03: KPI tiles two per row on phones.
// ---------------------------------------------------------------------------------------------

const KPI_PAGES = ['jobs', 'leads', 'customers', 'estimates', 'invoices'] as const;

for (const kpiPage of KPI_PAGES) {
  test(`kpi tiles on /${kpiPage} are two per row below sm`, async ({ page, session }, testInfo) => {
    test.skip(!selected.has(kpiPage), `MOBILE_GATE_ROUTES does not select ${kpiPage}`);
    const width = page.viewportSize()!.width;
    await signIn(page, session, []);
    try {
      await open(page, `/${kpiPage}`);
      const group = page.locator('[data-slot="stat-card-group"]').first();
      await expect(group, `/${kpiPage} shows its KPI tiles`).toBeVisible();
      const reading = await group.evaluate((el) => {
        const tiles = [...el.children].filter((c) => (c as HTMLElement).getBoundingClientRect().height > 0) as HTMLElement[];
        const firstTop = Math.round(tiles[0]!.getBoundingClientRect().top);
        return { tiles: tiles.length, firstRow: tiles.filter((t) => Math.round(t.getBoundingClientRect().top) === firstTop).length };
      });
      await testInfo.attach('kpi-row.json', { body: JSON.stringify({ width, ...reading }, null, 1), contentType: 'application/json' });
      expect(reading.tiles, `/${kpiPage} has more than one tile`).toBeGreaterThan(1);
      if (width < SM) expect(reading.firstRow, `at ${width}px the first KPI row holds two tiles`).toBe(2);
      else if (width >= 1280) expect(reading.firstRow, `at ${width}px (xl) the first KPI row holds more than two tiles`).toBeGreaterThan(Math.min(2, reading.tiles - 1));
      else expect(reading.firstRow, `at ${width}px the first KPI row holds at least two tiles`).toBeGreaterThanOrEqual(2);
    } finally {
      await keepSession(page, session);
    }
  });
}

// ---------------------------------------------------------------------------------------------
// Slice 04: full terms on the public estimate, and a PDF link that opens.
// ---------------------------------------------------------------------------------------------

/** Long enough (over the page's 600-character clamp) to start behind "Show full terms". */
const TERMS_END = 'GC1 terms end: the last sentence of the terms.';
const LONG_TERMS = `${'Work is guaranteed for twelve months from completion against defects in workmanship. '.repeat(14)}${TERMS_END}`;

/** Give the public estimate's organisation long terms (the throwaway org has none). */
async function withLongTerms(page: Page, estimateId: string) {
  await page.route((url) => url.pathname === `/api/estimates/${estimateId}/public`, async (route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') return route.fulfill({ response: res });
    // The page reads `organization` from the top level of the response.
    return route.fulfill({ response: res, json: { ...body, organization: { ...(body.organization ?? {}), estimate_terms: LONG_TERMS } } });
  });
}

test('public estimate shows the full terms before the agree checkbox', async ({ page }, testInfo) => {
  test.skip(!selected.has('public-estimate-open'), 'MOBILE_GATE_ROUTES does not select public-estimate-open');
  const device = gateDevice(testInfo.project.name);
  const f = fixtures();
  await withLongTerms(page, f.estimateOpen.id);
  await open(page, `/p/estimates/${f.estimateOpen.id}?token=${encodeURIComponent(f.estimateOpen.token)}`);

  const terms = page.getByTestId('public-terms-text');
  await expect(terms, 'the terms are on the page').toBeVisible();
  expect(await terms.textContent(), 'the FULL terms are in the page, not an excerpt').toContain(TERMS_END);
  expect(await page.evaluate(() => document.body.innerText), 'no "see the PDF for the terms" excerpt').not.toMatch(/see (the )?attached pdf/i);

  const disclosure = page.getByRole('button', { name: /show full terms/i });
  await expect(disclosure, 'long terms start behind a disclosure').toBeVisible();
  if (device.touch) expect((await disclosure.boundingBox())!.height, 'the disclosure is a 44 px touch target').toBeGreaterThanOrEqual(44);
  await press(disclosure, device.touch);
  await expect(page.getByRole('button', { name: /hide full terms/i })).toBeVisible();
  const clipped = await terms.evaluate((el) => el.scrollHeight - el.clientHeight);
  expect(clipped, 'opened, the whole text shows (nothing clipped)').toBeLessThanOrEqual(1);
  // Scrolled to its end, the text's last line is on screen (not cut off by the page or the card).
  await terms.evaluate((el) => el.scrollIntoView({ block: 'end' }));
  const bottom = await terms.evaluate((el) => {
    const r = el.getBoundingClientRect();
    return { bottom: r.bottom, vh: window.innerHeight, height: r.height };
  });
  expect(bottom.bottom, 'the end of the terms can be scrolled onto the screen').toBeLessThanOrEqual(bottom.vh + 1);
  expect(bottom.height, 'opened, the terms are taller than the 192 px clamp').toBeGreaterThan(192);

  const agree = page.locator('#terms-agreed');
  await expect(agree).toBeVisible();
  const after = await terms.evaluate((t, a) => !!(t.compareDocumentPosition(a as Node) & Node.DOCUMENT_POSITION_FOLLOWING), await agree.elementHandle());
  expect(after, 'the agree checkbox sits after the full text').toBe(true);
});

for (const kind of ['estimates', 'invoices'] as const) {
  const stateId = kind === 'estimates' ? 'public-estimate-open' : 'public-invoice-open';
  test(`public ${kind.slice(0, -1)} PDF link opens the PDF inline, in the same tab`, async ({ page }) => {
    test.skip(!selected.has(stateId), `MOBILE_GATE_ROUTES does not select ${stateId}`);
    const f = fixtures();
    const rec = kind === 'estimates' ? f.estimateOpen : f.invoiceOpen;
    await open(page, `/p/${kind}/${rec.id}?token=${encodeURIComponent(rec.token)}`);

    const link = page.locator('a[href*="/public/pdf"]').first();
    await expect(link, 'the page has a PDF link').toBeVisible();
    expect(await link.getAttribute('target'), 'the PDF link opens in the same tab').toBeNull();
    const href = await link.evaluate((a) => (a as HTMLAnchorElement).href);
    expect(href, 'the link is the public PDF route').toMatch(new RegExp(`/api/${kind}/${rec.id}/public/pdf\\?token=`));

    const res = await page.request.get(href, { timeout: 90_000 });
    expect(res.status(), 'the PDF link answers').toBe(200);
    expect(res.headers()['content-type'] ?? '', 'the PDF link returns a PDF, not the app shell').toMatch(/application\/pdf/);
    expect(res.headers()['content-disposition'] ?? '', 'the PDF is served for inline viewing').toMatch(/^inline/);
    expect((await res.body()).subarray(0, 5).toString('latin1'), 'the body is a PDF').toBe('%PDF-');
  });
}

// ---------------------------------------------------------------------------------------------
// Slice 06: the installed-app head.
// ---------------------------------------------------------------------------------------------

test('served head has the apple-touch-icon, a theme colour and a light colour scheme', async ({ page, session }) => {
  test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
  await signIn(page, session, []);
  try {
    await open(page, '/');
    const head = await page.evaluate(() => ({
      icon: (document.querySelector('link[rel="apple-touch-icon"]') as HTMLLinkElement | null)?.href ?? null,
      theme: document.querySelector('meta[name="theme-color"]')?.getAttribute('content') ?? null,
      scheme: document.querySelector('meta[name="color-scheme"]')?.getAttribute('content') ?? null,
    }));
    expect(head.theme, 'a theme colour is declared').toMatch(/^#[0-9a-f]{3,8}$/i);
    expect(head.scheme, 'a light colour scheme is declared (forced dark modes do not invert the UI)').toMatch(/\blight\b/);
    expect(head.scheme ?? '', 'no dark scheme is offered').not.toMatch(/\bdark\b/);
    expect(head.icon, 'an apple-touch-icon is linked').toBeTruthy();
    const icon = await page.request.get(head.icon!);
    expect(icon.status(), 'the apple-touch-icon is served').toBe(200);
    expect(icon.headers()['content-type'] ?? '', 'the apple-touch-icon is a PNG').toMatch(/image\/png/);
  } finally {
    await keepSession(page, session);
  }
});
