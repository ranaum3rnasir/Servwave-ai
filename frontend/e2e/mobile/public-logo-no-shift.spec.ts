/**
 * Mobile slice 61 (round 2, PERF-03): the public estimate's branded header does not move when the
 * business's logo arrives.
 *
 * The staging check measured a layout shift of 0.283 on the public estimate at 320 px: the logo
 * (`h-auto max-h-10 w-auto`, no reserved size) loaded after the data, the header grew 48 px (the
 * View PDF link wrapped under a wide logo) and the whole document dropped. The gate's throwaway org
 * has no logo, so nothing saw it. This spec gives the document a WIDE logo (a business wordmark is
 * wider than it is tall) and holds the logo's own request until the test has measured the header
 * without it, then releases it and measures again. The header's box and the PDF link must not move,
 * on every device (the measure is plain geometry, so it runs in WebKit and Chromium alike).
 *
 * Read-only: only the public GET is answered by the test.
 */
import { expect, type Page, type Route } from '@playwright/test';
import fs from 'fs';
import { gateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { test } from './session';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

const LOGO_PATH = '/gate-wide-logo.svg';
/** A 6:1 wordmark: 240 px wide at the header's 40 px height, wide enough to wrap the PDF link at 320. */
const WIDE_LOGO = `<svg xmlns="http://www.w3.org/2000/svg" width="1800" height="300" viewBox="0 0 1800 300"><rect width="1800" height="300" fill="#1d4ed8"/><text x="900" y="190" font-size="140" text-anchor="middle" fill="#fff">LOGO</text></svg>`;

async function headerBoxes(page: Page) {
  return page.evaluate(() => {
    const link = Array.from(document.querySelectorAll('a')).find((a) => a.textContent?.trim() === 'View PDF');
    const header = link?.parentElement;
    if (!link || !header) return null;
    const h = header.getBoundingClientRect();
    const l = link.getBoundingClientRect();
    const doc = document.querySelector('[data-testid="estimate-document-row"]')?.getBoundingClientRect();
    return { headerHeight: h.height, linkTop: l.top - h.top, linkLeft: l.left, docTop: doc ? doc.top : null };
  });
}

test('public estimate: the header does not move when a wide logo loads', async ({ page }, testInfo) => {
  test.skip(!selected.has('public-estimate-open'), 'MOBILE_GATE_ROUTES does not select public-estimate-open');
  gateDevice(testInfo.project.name);
  const f = fixtures();

  await page.route((url) => url.pathname === `/api/estimates/${f.estimateOpen.id}/public`, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') return route.fulfill({ response: res });
    return route.fulfill({ response: res, json: { ...body, organization: { ...(body.organization ?? {}), name: 'Neutral Overhead Doors', logo_url: LOGO_PATH } } });
  });

  // Hold the logo until the test has measured the header without it.
  let release!: () => void;
  const held = new Promise<void>((resolve) => { release = resolve; });
  let logoRequested = false;
  await page.route((url) => url.pathname === LOGO_PATH, async (route) => {
    logoRequested = true;
    await held;
    await route.fulfill({ status: 200, contentType: 'image/svg+xml', body: WIDE_LOGO });
  });

  await page.goto(`/p/estimates/${f.estimateOpen.id}?token=${encodeURIComponent(f.estimateOpen.token)}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await expect(page.getByRole('link', { name: 'View PDF' })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => logoRequested, { message: 'the page asked for the logo', timeout: 15_000 }).toBe(true);
  await settle(page, []);

  const before = await headerBoxes(page);
  expect(before, 'the branded header is on the page').not.toBeNull();

  release();
  await expect
    .poll(() => page.evaluate(() => {
      const img = document.querySelector('img[alt="Neutral Overhead Doors"]') as HTMLImageElement | null;
      return !!img && img.complete && img.naturalWidth > 0;
    }), { message: 'the logo arrived', timeout: 15_000 })
    .toBe(true);
  await settle(page, []);

  const after = await headerBoxes(page);
  expect(after, 'the branded header is still on the page').not.toBeNull();
  expect(Math.abs(after!.headerHeight - before!.headerHeight), `header height ${before!.headerHeight} -> ${after!.headerHeight}`).toBeLessThanOrEqual(1);
  expect(Math.abs(after!.linkTop - before!.linkTop), `PDF link offset ${before!.linkTop} -> ${after!.linkTop}`).toBeLessThanOrEqual(1);
  if (before!.docTop !== null && after!.docTop !== null) {
    expect(Math.abs(after!.docTop - before!.docTop), `the document's first row ${before!.docTop} -> ${after!.docTop}`).toBeLessThanOrEqual(1);
  }

  // The logo is fully on screen beside the link.
  const vw = page.viewportSize()!.width;
  const logo = (await page.locator('img[alt="Neutral Overhead Doors"]').boundingBox())!;
  expect(logo.x, 'the logo starts inside the screen').toBeGreaterThanOrEqual(-1);
  expect(logo.x + logo.width, 'the logo ends inside the screen').toBeLessThanOrEqual(vw + 1);
});
