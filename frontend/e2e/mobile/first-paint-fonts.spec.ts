/**
 * Mobile slice 61 (PRD module 7, PERF-02): no font stylesheet blocks the first render, on the six
 * device projects.
 *
 * Before, three font families came from a third-party stylesheet host: two CSS @imports (a chain:
 * our stylesheet, then theirs, then the files) and a third stylesheet link, all render-blocking. On
 * a phone on a slow or filtered network that held the whole first paint. Now the files are ours:
 * declared with `font-display: swap`, same origin, the faces that paint the first screen preloaded.
 *
 * Asserted on the two public pages (a customer's link) and on the technician landing page (the
 * scheduler):
 *   - nothing is requested from a font host, and no stylesheet in the document is cross-origin;
 *   - the head preloads a font, as `crossorigin` (otherwise the file is fetched twice);
 *   - every font face the page declares is `swap`, and the page's own face is loaded from /fonts/.
 *
 * Read-only: the pages' own GETs. MOBILE_GATE_ROUTES selects it with `public-estimate-open`,
 * `public-invoice-open` and `schedule`. The timing half (LCP, CLS, INP) is first-paint-metrics.spec.ts.
 */
import { expect, type Page } from '@playwright/test';
import fs from 'fs';
import { gateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test } from './session';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

const FONT_HOST = /(^|\.)(fonts\.googleapis\.com|fonts\.gstatic\.com)$/i;

interface FontReport {
  crossOriginSheets: string[];
  preloads: { href: string; crossorigin: boolean }[];
  faces: { family: string; display: string | undefined; status: string }[];
}

async function readFonts(page: Page): Promise<FontReport> {
  return page.evaluate(async () => {
    await document.fonts.ready;
    const sheets = [...document.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]')]
      .map((l) => l.href)
      .filter((h) => new URL(h, location.href).origin !== location.origin);
    const preloads = [...document.querySelectorAll<HTMLLinkElement>('link[rel="preload"][as="font"]')].map((l) => ({
      href: l.getAttribute('href') ?? '',
      crossorigin: l.hasAttribute('crossorigin'),
    }));
    const faces = [...document.fonts].map((f) => ({
      family: f.family.replace(/["']/g, ''),
      display: (f as FontFace & { display?: string }).display,
      status: f.status,
    }));
    return { crossOriginSheets: sheets, preloads, faces };
  });
}

function watchRequests(page: Page) {
  const urls: string[] = [];
  page.on('request', (req) => urls.push(req.url()));
  return urls;
}

function assertOurFonts(urls: string[], fonts: FontReport, face: string) {
  const fontHostRequests = urls.filter((u) => {
    try { return FONT_HOST.test(new URL(u).hostname); } catch { return false; }
  });
  expect(fontHostRequests, 'nothing is requested from a font host').toEqual([]);
  expect(fonts.crossOriginSheets, 'no stylesheet in the document is cross-origin').toEqual([]);

  expect(fonts.preloads.length, 'the head preloads at least one font').toBeGreaterThan(0);
  for (const p of fonts.preloads) {
    expect(p.href, 'a preloaded font is a file of ours').toMatch(/^\/fonts\//);
    expect(p.crossorigin, `${p.href} is preloaded crossorigin`).toBe(true);
  }

  expect(fonts.faces.length, 'the page declares font faces').toBeGreaterThan(0);
  for (const f of fonts.faces) {
    // A "<name> Fallback" face is the local system font scaled to the real face's metrics (no file,
    // so it has nothing to wait for and reports `auto`); every face that downloads is swap.
    if (/ Fallback$/.test(f.family)) continue;
    // `display` is undefined in an engine that does not expose FontFace.display; where it does, it is swap.
    if (f.display !== undefined) expect(f.display, `${f.family} is font-display: swap`).toBe('swap');
  }
  const mine = fonts.faces.filter((f) => f.family === face);
  expect(mine.some((f) => f.status === 'loaded'), `${face} loaded (faces: ${JSON.stringify(fonts.faces)})`).toBe(true);
  expect(urls.some((u) => new URL(u).pathname.startsWith('/fonts/')), 'a font file was fetched from /fonts/').toBe(true);
}

for (const [id, kind] of [
  ['public-estimate-open', 'estimate'],
  ['public-invoice-open', 'invoice'],
] as const) {
  test(`fonts, public ${kind}: ours, swap-displayed, preloaded, none from a font host`, async ({ page }, testInfo) => {
    test.skip(!selected.has(id), `MOBILE_GATE_ROUTES does not select ${id}`);
    gateDevice(testInfo.project.name);
    const f = fixtures();
    const fx = kind === 'estimate' ? f.estimateOpen : f.invoiceOpen;
    const urls = watchRequests(page);
    await page.goto(`/p/${kind === 'estimate' ? 'estimates' : 'invoices'}/${fx.id}?token=${encodeURIComponent(fx.token)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 45_000,
    });
    await settle(page, []);
    // The public pages use the body face (Manrope) only: the app face and the signature script stay home.
    assertOurFonts(urls, await readFonts(page), 'Manrope');
    expect(urls.some((u) => /figtree|caveat/i.test(new URL(u).pathname)), 'the app face and the signature script are not fetched').toBe(false);
  });
}

test('fonts, technician landing page (scheduler): the app face is ours, swap-displayed, preloaded', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('schedule'), 'MOBILE_GATE_ROUTES does not select schedule');
  gateDevice(testInfo.project.name);
  await signIn(page, session, []);
  try {
    const urls = watchRequests(page);
    await page.goto('/schedule', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    assertOurFonts(urls, await readFonts(page), 'Figtree');
  } finally {
    await keepSession(page, session);
  }
});
