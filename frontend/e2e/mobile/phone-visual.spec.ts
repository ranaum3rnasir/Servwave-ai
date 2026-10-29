/**
 * Phone visual baselines (mobile slice 74, PRD module 12, story 148, rubric TEST-06).
 *
 * A pixel gate for the layouts the big mobile slices built, on three phones: the narrowest (iPhone
 * SE, 320), a common one (iPhone 15, 393) and one landscape size (838x390). It is the phone twin of
 * `specs/visual-regression.spec.ts`: same rendering pins, same macOS-only local-gate rules, and the
 * committed PNGs are the reviewed artifact (`e2e/visual-baselines/phone/`).
 *
 *   npm run test:mobile:visual            # compare against the baselines
 *   npm run test:mobile:visual:update     # re-record them (review the PNG diff before committing)
 *
 * Config: `e2e/playwright.mobile-visual.config.ts`. Its own throwaway org, seeded with fixed
 * literals (`visual-setup.ts`), because a baseline taken in the gate's org would carry its random
 * names and moving record numbers.
 *
 * - What is photographed: `visual-states.ts` (screens from slices 28, 55, 65 and 69, plus two lists).
 *   A portrait phone gets the WHOLE page in one tall image: the viewport keeps the phone's width (so
 *   every breakpoint decides as on the phone) and grows to the page's height, because the app's
 *   layout is `100dvh` with an inner scroller and `fullPage` alone captures one screen. The spec
 *   fails, naming the height needed, if a page outgrows the cap, so coverage cannot shrink quietly.
 *   An overlay (sheet, dialog, drawer) is photographed at the phone's real size, because it is placed
 *   against the viewport; so is a bounded page (text messages: its panes scroll, the page does not). The landscape phone gets its real-size first screen and, when the page
 *   scrolls, the screen at the end of the scroll (the chrome, docks and last rows that landscape
 *   squeezes); the middle is the portrait photographs' job.
 * - Determinism, removed at source and never masked: the clock is pinned (`page.clock.setFixedTime`),
 *   locale and timezone are pinned by the config, every date-shaped value in an `/api/**` response is
 *   rewritten to a fixed instant by field name, the run-id org name, admin email and contact email are pinned, the
 *   third-party error endpoint is blocked, animations are disabled and the caret hidden, and the pointer is parked off the screen with
 *   no control hovered or focused at capture (`restPointerAndFocus`). The text
 *   threads the throwaway org cannot have are answered by a test double with made-up, fixed content;
 *   nothing is sent.
 * - Proof it can fail: `selftest: a deliberate layout change fails the comparison` first requires a
 *   covered page to match its committed baseline, then shifts the page 6 px (a change that keeps its
 *   size) and requires the same comparison to fail with a pixel difference (not a missing file).
 *
 * Select a subset while developing with MOBILE_VISUAL_STATES=<ids, a trailing * as a prefix>.
 */
import { expect, type Page, type Route } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { fitViewportToPage } from './fit-page';
import { settle } from './measure';
import { openOverlay, type OpenResult } from './openers';
import { VISUAL_FIXTURES_FILE } from './paths';
import { keepSession, signIn, test } from './session';
import { press } from './touch';
import {
  VISUAL_DEVICES,
  VISUAL_STATES,
  VISUAL_THREAD_ID,
  baselineFile,
  baselineName,
  isWholePage,
  type VisualFixtures,
  type VisualState,
} from './visual-states';

const BASELINE_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'visual-baselines', 'phone');

// ─── Fixed instants ─────────────────────────────────────────────────────────────────────
// Between the record dates and the due date, so "N days ago" / "due in N days" never move.
const FROZEN_NOW = new Date('2026-01-20T12:00:00.000Z');
const CREATED_AT = '2026-01-05T09:00:00.000Z';
const SENT_AT = '2026-01-06T15:30:00.000Z';
const PAID_AT = '2026-01-08T11:15:00.000Z';
const DUE_DATE = '2026-02-05T00:00:00.000Z';

/** Field name -> fixed instant. Anything date-shaped and unlisted collapses to CREATED_AT. */
const FIXED_BY_FIELD: Record<string, string> = {
  created_at: CREATED_AT,
  updated_at: CREATED_AT,
  sent_at: SENT_AT,
  due_date: DUE_DATE,
  paid_at: PAID_AT,
  approved_at: SENT_AT,
  voided_at: CREATED_AT,
  refunded_at: PAID_AT,
  date: CREATED_AT,
};

// Date-only or full ISO-8601, anchored at both ends so free text that merely contains a date is left alone.
const ISO_LIKE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
// The throwaway org's identity is minted per run from a random 8-hex id, and the org name is in the top bar of every page.
const RUN_ID_ORG = /^e2e-qa-[0-9a-f]{8}$/;
const RUN_ID_ADMIN_EMAIL = /^admin-[0-9a-f]{8}@e2e-qa\.invalid$/;
// The organisation's own contact address (the public pages' footer).
const RUN_ID_ORG_EMAIL = /^org-[0-9a-f]{8}@e2e-qa\.invalid$/;
const FIXED_ORG_NAME = 'e2e-qa-fixture';
const FIXED_ADMIN_EMAIL = 'admin-fixture@e2e-qa.invalid';
const FIXED_ORG_EMAIL = 'org-fixture@e2e-qa.invalid';

function pinValue(node: string, key?: string): string {
  if (ISO_LIKE.test(node)) return (key && FIXED_BY_FIELD[key]) || CREATED_AT;
  if (RUN_ID_ORG.test(node)) return FIXED_ORG_NAME;
  if (RUN_ID_ADMIN_EMAIL.test(node)) return FIXED_ADMIN_EMAIL;
  if (RUN_ID_ORG_EMAIL.test(node)) return FIXED_ORG_EMAIL;
  return node;
}

function freezeVolatileValues(node: unknown, key?: string): unknown {
  if (typeof node === 'string') return pinValue(node, key);
  if (Array.isArray(node)) return node.map((v) => freezeVolatileValues(v, key));
  if (node !== null && typeof node === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(node as Record<string, unknown>)) out[k] = freezeVolatileValues(v, k);
    return out;
  }
  return node;
}

/** Pin the clock and neutralise server-written volatile values. Runs before the first goto. */
async function pinRenderingEnvironment(page: Page, origin: string) {
  await page.clock.setFixedTime(FROZEN_NOW);
  // The error reporter's envelope is a real outbound request that keeps `networkidle` from settling.
  await page.route(/ingest\.[a-z]+\.sentry\.io/, (route) => route.abort());
  // Scoped to the app's OWN origin: a bare '**/api/**' also matches third-party hosts.
  await page.route(`${origin}/api/**`, async (route) => {
    try {
      const response = await route.fetch();
      const contentType = response.headers()['content-type'] ?? '';
      if (!contentType.includes('application/json')) return await route.fulfill({ response });
      const raw = await response.text();
      let parsed: unknown;
      try {
        parsed = JSON.parse(raw);
      } catch {
        return await route.fulfill({ response });
      }
      await route.fulfill({ response, body: JSON.stringify(freezeVolatileValues(parsed)) });
    } catch {
      // The page can be torn down with requests in flight; nothing is rendered after that.
      await route.abort().catch(() => {});
    }
  });
}

// ─── Text messages: a double with made-up, fixed content ─────────────────────────────────

const TEXT_CUSTOMERS = ['Avery Brooks', 'Blake Chen', 'Casey Doyle'].map((name, i) => ({
  id: `baseline-c${i}`,
  name,
  type: 'residential',
  site: `${10 + i} Sample Lane`,
  contacts: [],
  phones: [`+1212555${String(1000 + i)}`],
}));

const TEXT_MESSAGES = Array.from({ length: 14 }, (_, i) => ({
  id: `baseline-m${i}`,
  direction: i % 2 ? 'out' : 'in',
  body: i % 2 ? `Thanks, we will be there at ${9 + (i % 4)} AM tomorrow.` : `Can you move the visit? Message number ${i + 1}.`,
  ts: new Date(Date.UTC(2026, 0, 19, 14, 0, i * 7)).toISOString(),
  status: 'delivered',
}));

const TEXT_THREADS = [
  { id: VISUAL_THREAD_ID, customerId: TEXT_CUSTOMERS[0]!.id, channel: 'sms', campaignType: 'customer_care', unread: 0, messages: TEXT_MESSAGES },
  { id: 'baseline-thread-2', customerId: TEXT_CUSTOMERS[1]!.id, channel: 'sms', campaignType: 'customer_care', unread: 2, messages: TEXT_MESSAGES.slice(0, 3) },
  { id: 'baseline-thread-3', customerId: TEXT_CUSTOMERS[2]!.id, channel: 'sms', campaignType: 'customer_care', unread: 0, messages: TEXT_MESSAGES.slice(0, 1) },
];

/** Answer the text-message reads with the doubles above; no write reaches the server and nothing is sent. */
async function doubleTexts(page: Page) {
  await page.route((url) => url.pathname.startsWith('/api/communication/'), async (route: Route) => {
    const req = route.request();
    const { pathname } = new URL(req.url());
    if (req.method() !== 'GET') return route.fulfill({ status: 200, json: {} });
    if (pathname === '/api/communication/threads') return route.fulfill({ json: { threads: TEXT_THREADS } });
    if (pathname === '/api/communication/contacts') return route.fulfill({ json: { contacts: TEXT_CUSTOMERS } });
    return route.fallback();
  });
  // The open thread's side panel reads its customer's jobs; the made-up customers do not exist.
  await page.route((url) => /^\/api\/customers\/baseline-c\d+/.test(url.pathname), (route: Route) =>
    route.request().method() === 'GET' ? route.fulfill({ json: { customer: { id: 'baseline', jobs: [] } } }) : route.fulfill({ status: 200, json: {} }),
  );
}

// ─── Overlays only the baselines open ────────────────────────────────────────────────────

/** The lead's Mark Lost dialog (inline in the header when it fits, else in the header's menu). Nothing is saved. */
async function openMarkLost(page: Page, touch: boolean): Promise<OpenResult> {
  const header = page.getByTestId('detail-header').first();
  const label = /^\s*Mark Lost\s*$/;
  const inline = header.getByRole('button', { name: label }).first();
  await inline.or(header.getByRole('button', { name: /^(More actions|Actions|More|Lead actions)$/ }).first()).waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
  if (await inline.isVisible().catch(() => false)) {
    await press(touch, inline, { timeout: 15_000 });
  } else {
    const menus = header.getByRole('button', { name: /^(More actions|Actions|More|Lead actions)$/ });
    let done = false;
    for (let i = 0; i < (await menus.count()) && !done; i++) {
      const trigger = menus.nth(i);
      if (!(await trigger.isVisible().catch(() => false))) continue;
      await press(touch, trigger, { timeout: 15_000 });
      const item = page.getByRole('menuitem', { name: label }).first();
      if (await item.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) {
        await press(touch, item, { timeout: 15_000 });
        done = true;
      } else {
        await page.keyboard.press('Escape');
        await page.waitForTimeout(250);
      }
    }
    if (!done) return { opened: false, error: 'no Mark Lost button or menu entry on the lead' };
  }
  const dialog = page.getByRole('dialog').first();
  if (!(await dialog.waitFor({ state: 'visible', timeout: 5_000 }).then(() => true, () => false))) return { opened: false, error: 'Mark Lost opened nothing' };
  await page.evaluate(() => Promise.race([
    Promise.allSettled(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished)),
    new Promise((ok) => setTimeout(ok, 2_000)),
  ])).catch(() => {});
  await page.waitForTimeout(400);
  return { opened: true, label: 'Mark Lost dialog' };
}

/** Controls whose look changes while the pointer is over them (a field's border, a button's fill, a row). */
const INTERACTIVE = 'a, button, input, textarea, select, summary, label, [role="button"], [role="menuitem"], [role="tab"], [role="row"], [tabindex]';
const FIELDLIKE = /^(INPUT|TEXTAREA|SELECT|BUTTON|A)$/;

/**
 * Put the page at rest before it is photographed: no field focused and no control hovered.
 *
 * Why this is needed, measured (not assumed): a tap leaves the emulated pointer where the finger
 * lifted. The Mark Lost dialog opens UNDER that spot on the narrow phone, so WebKit later gives
 * its Reason field the `:hover` border (dark grey instead of the resting light grey). Whether that
 * lands before the capture depends on when WebKit's lazy hover update runs, which is ordering and
 * timing luck: one baseline was recorded with the dark border, another without, and a full run
 * failed one in two on the 320 px phone while a run of that state alone never did. It looked like a
 * focus ring but was not: the dialog's own container holds focus on a touch device (`:focus` was
 * false on the field in every run), so no amount of blurring touched it.
 *
 * So the cause is removed, not waited out: the pointer is moved off the screen, then the capture
 * requires, by polling, that no control is hovered or focused. A page that cannot reach rest fails
 * the test with the offender named instead of being photographed in a random state.
 */
async function restPointerAndFocus(page: Page) {
  await page.evaluate((fieldlike) => {
    const active = document.activeElement as HTMLElement | null;
    // Only a field is blurred; an overlay's own container keeps focus so it stays trapped and announced.
    if (active && new RegExp(fieldlike).test(active.tagName)) active.blur();
  }, FIELDLIKE.source);
  await page.mouse.move(-5, -5);
  await expect
    .poll(
      () =>
        page.evaluate(
          ({ selector, fieldlike }) => {
            const named = (e: Element) => `${e.tagName.toLowerCase()}${e.id ? `#${e.id}` : ''}`;
            const hovered = Array.from(document.querySelectorAll(selector)).filter((e) => e.matches(':hover')).map(named);
            const a = document.activeElement;
            const focused = a && a !== document.body && new RegExp(fieldlike).test(a.tagName) ? [named(a)] : [];
            return JSON.stringify({ hovered, focused });
          },
          { selector: INTERACTIVE, fieldlike: FIELDLIKE.source },
        ),
      { message: 'a control is still hovered or focused at capture time, so the photograph would depend on timing', timeout: 5_000 },
    )
    .toBe('{"hovered":[],"focused":[]}');
  await page.waitForTimeout(150);
}

// ─── Capture ─────────────────────────────────────────────────────────────────────────────

/** The tallest page a portrait photograph covers. A page past it fails the run and names the height. */
const MAX_PAGE_HEIGHT = 6_000;
/** Differing pixels tolerated (see visual-regression.config.ts: a 4 px move on one small control is ~320). */
const SCREENSHOT = { maxDiffPixels: 100, animations: 'disabled', caret: 'hide', scale: 'css' } as const;

declare global {
  interface Window { __primaryScroller?: () => { el: Element | null; extent: number } }
}

/**
 * The page's primary vertical scroller: the one that scrolls furthest among the document and every
 * scroll box at least half the viewport wide (the app shell's `main`, the public pages' own box).
 * Narrow inner boxes (a table, a carousel, a list inside a card) are not the page. Installed in the
 * page once per call, so the three helpers below agree on which box it is.
 */
const installPrimaryScroller = (page: Page) =>
  page.evaluate(() => {
    window.__primaryScroller = () => {
      const half = window.innerWidth / 2;
      let best: { el: Element | null; extent: number } = { el: null, extent: document.documentElement.scrollHeight - window.innerHeight };
      for (const el of document.querySelectorAll('body *')) {
        if (!/(auto|scroll)/.test(getComputedStyle(el).overflowY) || el.clientWidth < half) continue;
        const extent = el.scrollHeight - el.clientHeight;
        if (extent > best.extent) best = { el, extent };
      }
      return best;
    };
  });

async function scrollToTop(page: Page) {
  await installPrimaryScroller(page);
  await page.evaluate(() => {
    window.scrollTo(0, 0);
    const { el } = window.__primaryScroller!();
    if (el) el.scrollTop = 0;
  });
  await page.waitForTimeout(150);
}

/** How far the page scrolls (see installPrimaryScroller). */
const scrollExtent = async (page: Page) => {
  await installPrimaryScroller(page);
  return page.evaluate(() => Math.max(0, Math.round(window.__primaryScroller!().extent)));
};

async function scrollToEnd(page: Page) {
  await installPrimaryScroller(page);
  await page.evaluate(() => {
    const { el } = window.__primaryScroller!();
    if (el) el.scrollTop = el.scrollHeight;
    else window.scrollTo(0, document.documentElement.scrollHeight);
  });
  await page.waitForTimeout(400);
}

function wanted(): ((id: string) => boolean) | null {
  const spec = (process.env.MOBILE_VISUAL_STATES ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  if (spec.length === 0) return null;
  return (id) => spec.some((p) => (p.endsWith('*') ? id.startsWith(p.slice(0, -1)) : id === p || id.startsWith(`${p}~`)));
}

function loadFixtures(): VisualFixtures {
  return JSON.parse(fs.readFileSync(VISUAL_FIXTURES_FILE, 'utf8'));
}

/** Open the state, settle it and photograph it (or, for the self-test, require the comparison to FAIL). */
async function photograph(
  { page, session, baseURL }: { page: Page; session: Parameters<typeof signIn>[1]; baseURL: string | undefined },
  state: VisualState,
  deviceId: string,
  perturb: boolean,
) {
  const device = VISUAL_DEVICES.find((d) => d.id === deviceId);
  if (!device) throw new Error(`${deviceId} is not a phone-baseline device`);
  const landscape = device.kind === 'landscape';
  const touch = true;
  const f = loadFixtures();

  await pinRenderingEnvironment(page, baseURL!);
  if (state.doubles === 'texts') await doubleTexts(page);
  if (!state.anon) await signIn(page, session, []);

  const target = state.path(f);
  const resp = await page.goto(target, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
  expect(resp?.status() ?? 200, `document status for ${target}`).toBeLessThan(400);
  if (!state.anon) expect(new URL(page.url()).pathname, `${target} sent the signed-in admin to /login (session lost?)`).not.toBe('/login');
  expect(await page.getByTestId('error-boundary-fallback').count(), `${target} rendered the error screen`).toBe(0);
  if (state.doubles === 'texts') {
    // The double's conversations are on screen before anything is photographed (a skeleton is not a
    // baseline): the list, or on a phone the open thread alone.
    const pane = state.path(f).includes('threadId=') ? '[data-pane="thread"] [data-slot="sms-messages"]' : '[data-pane="list"]';
    await expect(page.locator(pane).first()).toBeVisible({ timeout: 20_000 });
    await expect(page.locator(pane).first()).toContainText(/Avery Brooks|Thanks, we will be there/, { timeout: 20_000 });
    if (state.path(f).includes('threadId=')) {
      // The thread opens on its newest message; wait for that scroll to land before photographing.
      await expect.poll(() => page.locator('[data-slot="sms-messages"]').first().evaluate((el) => el.scrollHeight - el.scrollTop - el.clientHeight < 4), { timeout: 10_000 }).toBe(true);
    }
  }
  await page.evaluate(() => document.fonts.ready);

  if (state.overlay) {
    const opened = state.overlay === 'markLost' ? await openMarkLost(page, touch) : await openOverlay(page, state.overlay, touch);
    if (!opened.opened) {
      if ('notHere' in opened) {
        test.info().annotations.push({ type: 'not applicable', description: opened.notHere });
        test.skip(true, opened.notHere);
        return;
      }
      throw new Error(`${state.id}: could not open the overlay: ${opened.error}`);
    }
  }

  // The screen worth keeping is the page at rest: nothing focused, nothing hovered.
  await restPointerAndFocus(page);

  const shoot = async (name: string, options: { fullPage: boolean }) => {
    if (!perturb) return expect(page).toHaveScreenshot(`${name}.png`, { ...SCREENSHOT, ...options });
    // The self-test. 1) the page as it is matches its committed baseline (so what follows is caused
    // by the change and by nothing else); 2) the page shifted 6 px, a change that keeps its size so
    // it cannot fail on dimensions alone, must FAIL the comparison, with a pixel difference rather
    // than a missing file.
    const file = path.join(BASELINE_DIR, baselineFile(name, device.id));
    expect(fs.existsSync(file), `the baseline ${file} must exist for the self-test to mean anything`).toBe(true);
    await expect(page).toHaveScreenshot(`${name}.png`, { ...SCREENSHOT, ...options });
    const moved = await page.addStyleTag({ content: 'body > div { transform: translateY(6px) !important; }' });
    await page.waitForTimeout(150);
    let failure = '';
    try {
      await expect(page).toHaveScreenshot(`${name}.png`, { ...SCREENSHOT, ...options, timeout: 8_000 });
    } catch (e) {
      failure = String((e as Error).message);
    }
    await moved.evaluate((el) => (el as HTMLElement).remove());
    await page.waitForTimeout(150);
    expect(failure, 'the comparison against the committed baseline passed on a deliberately moved layout').not.toBe('');
    expect(failure, 'the comparison failed for the wrong reason (a missing baseline, not a pixel difference)').not.toMatch(/snapshot doesn't exist/i);
    expect(failure).toMatch(/pixels? .*different|Screenshot comparison failed|Expected an image/i);
  };

  if (!isWholePage(state)) {
    // An overlay is placed against the viewport, and a bounded page scrolls inside its own panes:
    // photographed at the phone's real size, as the person sees it. Nothing is scrolled first: a
    // thread opens on its newest message, and that is the screen worth keeping.
    await shoot(baselineName(state, 'top'), { fullPage: false });
    return;
  }
  await scrollToTop(page);
  if (landscape) {
    await shoot(baselineName(state, 'top'), { fullPage: false });
    if ((await scrollExtent(page)) > 1) {
      await scrollToEnd(page);
      await shoot(baselineName(state, 'end'), { fullPage: false });
    }
    return;
  }

  // Portrait: the whole page, at the phone's width. `fitViewportToPage` grows the viewport by what
  // still scrolls (a taller viewport can reflow the page, so one growth is not always enough) and
  // only believes a reading that repeats, taken after running animations finished: a transient few
  // pixels of overshoot under load must not become a permanent blank band (see fit-page.ts). A page
  // that never settles or outgrows the cap fails the run rather than being photographed wrong.
  await fitViewportToPage(
    {
      size: () => page.viewportSize()!,
      resize: (width, height) => page.setViewportSize({ width, height }),
      extent: async () => {
        // A card easing open is the suspected source of a transient reading: let finite animations end first.
        await page.evaluate(() => Promise.race([
          Promise.allSettled(document.getAnimations().filter((a) => a.effect?.getComputedTiming().iterations !== Infinity).map((a) => a.finished)),
          new Promise((ok) => setTimeout(ok, 1_000)),
        ])).catch(() => {});
        return scrollExtent(page);
      },
      rest: async () => {
        await settle(page, []);
        await page.evaluate(() => document.fonts.ready);
        await scrollToTop(page);
      },
      pause: (ms) => page.waitForTimeout(ms),
    },
    { floor: page.viewportSize()!.height, cap: MAX_PAGE_HEIGHT, label: `${state.id} on ${deviceId}` },
  );
  await shoot(baselineName(state, 'whole'), { fullPage: true });
}

const only = wanted();

for (const state of VISUAL_STATES) {
  if (only && !only(state.id)) continue;
  test(state.id, async ({ page, session, baseURL }, testInfo) => {
    await photograph({ page, session, baseURL }, state, testInfo.project.name, false);
    if (!state.anon) await keepSession(page, session);
  });
}

// The proof that the baselines can go red: the headings of one covered page move 6 px (a layout
// change that keeps the page's size) and the comparison against the committed baseline must fail.
test('selftest: a deliberate layout change fails the comparison', async ({ page, session, baseURL }, testInfo) => {
  // Under --update-snapshots the comparison would REWRITE the baseline with the moved page.
  test.skip(testInfo.config.updateSnapshots === 'all' || testInfo.config.updateSnapshots === 'changed', 'the self-test never runs while baselines are being re-recorded');
  const state = VISUAL_STATES.find((s) => s.id === 'public-invoice-open')!;
  await photograph({ page, session, baseURL }, state, testInfo.project.name, true);
});
