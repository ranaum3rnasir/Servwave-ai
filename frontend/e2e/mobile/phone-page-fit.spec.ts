/**
 * Mobile slice 71: the Phone page and the pop-out phone page fit a phone.
 *
 * Every device project, signed in as the throwaway org's admin. NEVER places a call or sends a text:
 * no Call, Call Back, Dismiss or keypad control is pressed, and the only request this spec adds is a
 * read-only dialer search for a string that matches nothing.
 *
 * Phone page (`/communication/phone`, the key route `comm-phone`). The org has no real calls, so the
 * calls list is replaced in the browser with twelve (the real response is fetched and only its
 * `calls` swapped, so the app's own CORS and auth path is exercised). Then:
 *   - below md the call log is cards (one per call, 10 on the first page), no table, nothing wider
 *     than the screen, each card's Call Back at least 44 px tall;
 *   - from md up it is the table, inside its named scroll box, with no cards;
 *   - the log gets at least 200 px, and where the page is short (a phone, a phone held sideways)
 *     the page is the ONE vertical scroller: the log is not a scroller inside it;
 *   - scrolled to its end, the page shows the "Showing 10 of 12 calls" footer on screen.
 *
 * Pop-out phone page (`/phone`, the key route `phone-tab`). The page is exactly the visible screen,
 * its `main` is the one scroller, the document never scrolls, the dialer's job search is on screen
 * at every width and shows results, and scrolled to the end the last keypad key is on screen and tappable.
 *
 * Seen red against origin/staging (app files reverted, this spec kept): the log was a 1,258 px table
 * on every screen, the page header and tabs left the log under 200 px, the document and `main` did
 * not scroll on the pop-out page so its last key sat past the bottom edge on the landscape phones,
 * and "Job search & call history are available on desktop" replaced the search below md.
 */
import { expect, type Page } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { findVendorTerms } from './vendor-terms';

const selected = new Set(selectStates().map((s) => s.id));
const MD = 768;
const SHORT_HEIGHT = 500;
const TARGET = 44;
const CALLS = 12;
const FIRST_PAGE = 10;

/** Twelve calls inside the page's default 30-day window; a mix of missed, answered and outbound. */
function stubCalls() {
  return Array.from({ length: CALLS }, (_, i) => {
    const missed = i % 3 === 0;
    const outbound = !missed && i % 2 === 0;
    return {
      id: `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`,
      direction: outbound ? 'outbound' : 'inbound',
      fromNumber: outbound ? '+12015550100' : `+1555123${String(1000 + i)}`,
      toNumber: outbound ? `+1555999${String(1000 + i)}` : '+12015550100',
      status: missed ? 'missed' : 'completed',
      answeredBy: missed ? { kind: 'none' } : { kind: 'csr', name: 'Gate Agent' },
      startedAt: new Date(Date.now() - (i + 1) * 3_600_000).toISOString(),
      durationSec: missed ? 0 : 60 + i * 7,
      trackingSource: i % 4 === 0 ? 'Website' : undefined,
      tags: i % 5 === 0 ? ['Estimate'] : [],
    };
  });
}

async function withStubbedCalls(page: Page) {
  await page.route(/\/api\/communication\/calls(\?.*)?$/, async (route) => {
    if (route.request().method() !== 'GET') return route.continue();
    const res = await route.fetch();
    const body = await res.json().catch(() => ({}));
    return route.fulfill({ response: res, json: { ...body, calls: stubCalls() } });
  });
}

// ── The Phone page ───────────────────────────────────────────────────────────────────────────
test('phone page: the call log is cards on a phone, a named table box from md, and gets 200 px', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('comm-phone'), 'MOBILE_GATE_ROUTES does not select comm-phone');
  test.setTimeout(120_000);
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  try {
    await withStubbedCalls(page);
    await page.goto('/communication/phone', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, notes);

    const vp = page.viewportSize()!;
    const asCards = vp.width < MD;
    const compact = asCards || vp.height <= SHORT_HEIGHT;
    const cards = page.locator('ul[aria-label="Calls"] > li[data-slot="record-card"]');
    const box = page.locator('[data-mobile-scroll-x="phone-call-log"]');

    if (asCards) {
      await expect(cards, 'one card per call on the first page').toHaveCount(FIRST_PAGE, { timeout: 20_000 });
      await expect(box, 'no wide table below md').toHaveCount(0);
      const wide = await page.evaluate(() => [...document.querySelectorAll('table')]
        .filter((t) => { const r = t.getBoundingClientRect(); return r.width > 0 && r.height > 0; })
        .filter((t) => t.getBoundingClientRect().width > innerWidth + 1).length);
      expect(wide, 'no table wider than the screen').toBe(0);
      // Every card is inside the screen, and wide enough to read.
      const n = await cards.count();
      for (let i = 0; i < n; i++) {
        const b = (await cards.nth(i).boundingBox())!;
        expect(b.x, `card ${i} left`).toBeGreaterThanOrEqual(-0.5);
        expect(b.x + b.width, `card ${i} right`).toBeLessThanOrEqual(vp.width + 0.5);
        expect(b.width, `card ${i} width`).toBeGreaterThan(vp.width * 0.7);
      }
      // The card's own button is a 44 px target on touch.
      if (device.touch) {
        const callBack = cards.first().getByRole('button', { name: /Call Back/ });
        await callBack.scrollIntoViewIfNeeded();
        const b = (await callBack.boundingBox())!;
        expect(b.height, 'Call Back height').toBeGreaterThanOrEqual(TARGET - 0.5);
      }
      // Words, not just icons: direction and outcome are in the text.
      await expect(cards.first()).toContainText(/Inbound|Outbound/);
    } else {
      await expect(cards, 'no cards from md up').toHaveCount(0);
      await expect(box, 'the table sits in its one named scroll box').toHaveCount(1, { timeout: 20_000 });
      await expect(box).toHaveAttribute('aria-label', 'Call log table');
      await expect(box.getByRole('row')).toHaveCount(FIRST_PAGE + 1);
    }

    // The Calls sub-tab strip keeps the whole row: the date range wraps under it on a phone rather
    // than squeezing the tabs to a sliver nobody can reach.
    const subTabs = page.getByRole('tablist').filter({ has: page.getByRole('tab', { name: /Performance & QA/ }) });
    await expect(subTabs).toHaveCount(1);
    const stb = (await subTabs.boundingBox())!;
    expect(stb.width, 'the sub-tab strip is not squeezed').toBeGreaterThanOrEqual(Math.min(vp.width * 0.8, 240));

    // The log wrapper: at least 200 px; a scroller of its own only where the page is tall enough.
    const log = page.locator('[data-slot="call-log"]');
    await log.scrollIntoViewIfNeeded();
    const m = await log.evaluate((el) => {
      const cs = getComputedStyle(el);
      return { height: el.getBoundingClientRect().height, scrolls: /(auto|scroll)/.test(cs.overflowY) && el.scrollHeight > el.clientHeight + 1, isScroller: /(auto|scroll)/.test(cs.overflowY) };
    });
    expect(m.height, 'the call log is at least 200 px tall').toBeGreaterThanOrEqual(200 - 0.5);
    if (compact) expect(m.isScroller, 'where the page is short the log is not a scroller inside it').toBe(false);

    // One vertical scroller around the log: none inside another.
    const nested = await page.evaluate(() => {
      const isY = (el: Element) => { const s = getComputedStyle(el); return /(auto|scroll)/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 1; };
      const ys = [...document.querySelectorAll('body *')].filter(isY);
      return ys.filter((el) => ys.some((o) => o !== el && o.contains(el))).map((e) => e.tagName.toLowerCase() + '.' + [...e.classList].slice(0, 3).join('.'));
    });
    expect(nested, 'no vertical scroller inside another').toEqual([]);

    // Scrolled to the end, the footer line is on screen.
    const footer = page.getByText(`Showing ${FIRST_PAGE} of ${CALLS} calls`);
    await footer.scrollIntoViewIfNeeded();
    const f = (await footer.boundingBox())!;
    expect(f.y + f.height, 'the footer is above the bottom edge').toBeLessThanOrEqual(vp.height + 0.5);
    expect(f.y, 'the footer is below the top edge').toBeGreaterThanOrEqual(-0.5);

    // No vendor name in the page's copy.
    const text = await page.locator('main').evaluate((el) => el.innerText);
    expect(findVendorTerms([{ source: 'phone page', text }])).toEqual([]);
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});

// ── The pop-out phone page ───────────────────────────────────────────────────────────────────
test('pop-out phone page: one bounded scroller, the job search on screen, the last key reachable', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('phone-tab'), 'MOBILE_GATE_ROUTES does not select phone-tab');
  test.setTimeout(120_000);
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  try {
    await page.goto('/phone', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, notes);
    const vp = page.viewportSize()!;

    // The document never scrolls: the page is exactly the visible screen.
    const doc = await page.evaluate(() => ({ scrollH: document.documentElement.scrollHeight, innerH: innerHeight, scrollW: document.documentElement.scrollWidth, innerW: innerWidth }));
    expect(doc.scrollH, 'the document is no taller than the screen').toBeLessThanOrEqual(doc.innerH + 1);
    expect(doc.scrollW, 'the document is no wider than the screen').toBeLessThanOrEqual(doc.innerW + 1);

    const main = page.locator('main');
    const scroller = await main.evaluate((el) => ({ overflowY: getComputedStyle(el).overflowY, bottom: el.getBoundingClientRect().bottom }));
    expect(scroller.overflowY, 'main is the scroller').toMatch(/auto|scroll/);
    expect(scroller.bottom, 'main ends inside the screen').toBeLessThanOrEqual(vp.height + 1);

    // The job search is on screen at every width, and nothing says it is desktop-only.
    const search = page.getByPlaceholder('Search a job #, customer, or phone…');
    await expect(search).toBeVisible();
    const sb = (await search.boundingBox())!;
    expect(sb.x, 'search left').toBeGreaterThanOrEqual(-0.5);
    expect(sb.x + sb.width, 'search right').toBeLessThanOrEqual(vp.width + 0.5);
    await expect(page.getByText(/available on desktop/i)).toHaveCount(0);
    if (device.touch) {
      const fontSize = await search.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(fontSize, 'search text size (no zoom on focus)').toBeGreaterThanOrEqual(16);
    }
    // It works: typing shows results (or says nothing matched) inside the screen. A read-only
    // search; nothing is dialled and no result is picked.
    await search.fill('test');
    const results = page.getByText(/^Customers$|^Jobs$|No customer or job matches/).first();
    await expect(results).toBeVisible({ timeout: 20_000 });
    const rb = (await results.boundingBox())!;
    expect(rb.x, 'results left').toBeGreaterThanOrEqual(-0.5);
    expect(rb.x + rb.width, 'results right').toBeLessThanOrEqual(vp.width + 0.5);
    await search.fill('');
    // Clearing the query closes the results only after the search's 250 ms debounce. Wait for that,
    // or the measure below picks a result row at the bottom of the still-open list as the "last control".
    await expect(page.getByText(/^Customers$|^Jobs$|No customer or job matches/), 'the results list closes once the query is cleared').toHaveCount(0, { timeout: 10_000 });

    // Scrolled to its end, the last control is on screen and nothing covers it.
    const last = await main.evaluate(async (el) => {
      const sel = 'button,a[href],input:not([type=hidden]),select,textarea,[role=button],[role=tab]';
      const cands = [...el.querySelectorAll(sel)].filter((e) => {
        const r = e.getBoundingClientRect();
        return r.width > 1 && r.height > 1 && !(e as HTMLButtonElement).disabled;
      });
      let lastEl: Element | undefined;
      let lowest = -Infinity;
      for (const c of cands) { const b = c.getBoundingClientRect().bottom + el.scrollTop; if (b >= lowest) { lowest = b; lastEl = c; } }
      el.scrollTop = el.scrollHeight;
      await new Promise((ok) => requestAnimationFrame(() => requestAnimationFrame(ok)));
      if (!lastEl) return { found: false } as const;
      const r = lastEl.getBoundingClientRect();
      const hit = document.elementFromPoint(Math.min(innerWidth - 1, Math.max(0, r.left + r.width / 2)), Math.min(innerHeight - 1, Math.max(0, r.top + r.height / 2)));
      return { found: true, bottom: r.bottom, top: r.top, innerH: innerHeight, reachable: !!hit && (hit === lastEl || lastEl.contains(hit)), name: (lastEl.getAttribute('aria-label') || (lastEl as HTMLElement).innerText || lastEl.tagName).trim().slice(0, 30) } as const;
    });
    expect(last.found, 'the page has controls').toBe(true);
    if (last.found) {
      expect(last.bottom, `last control "${last.name}" bottom`).toBeLessThanOrEqual(last.innerH + 1);
      expect(last.top, `last control "${last.name}" top`).toBeGreaterThanOrEqual(-1);
      expect(last.reachable, `last control "${last.name}" is not covered`).toBe(true);
    }

    // No vendor name in what the page shows.
    const text = await page.evaluate(() => document.body.innerText + '\n' + [...document.querySelectorAll('[aria-label],[placeholder],[title]')]
      .map((e) => `${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('placeholder') ?? ''} ${e.getAttribute('title') ?? ''}`).join('\n'));
    expect(findVendorTerms([{ source: 'pop-out phone page', text }])).toEqual([]);
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});
