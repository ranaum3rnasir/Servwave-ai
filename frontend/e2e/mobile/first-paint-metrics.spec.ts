/**
 * Mobile slice 61 (PRD module 7, PERF-02 / PERF-03): LCP, CLS and INP on a low-end phone profile.
 *
 * This is the half of the first-paint slice that needs a PRODUCTION build: the gate normally runs
 * against the dev server, where every module is its own request and no number would mean anything.
 * It is skipped unless MOBILE_GATE_PROD_BUILD=1, which says that the base URL is `vite preview` of a
 * built `dist/` (see the README, "Timing on a production build"). Chromium only: layout-shift,
 * largest-contentful-paint and event timing are Chromium's, and so is the throttling.
 *
 * The profile is Lighthouse's mobile one, applied through the browser: CPU slowed 4x, and a
 * 1.6 Mbit/s, 150 ms round-trip network (cold cache, no service worker).
 *
 *   - CLS at most 0.1 on the public estimate, the public invoice and the technician landing page
 *     (the scheduler), and LCP held to a bound: 3 s on the public pages (the 2.5 s target is
 *     Lighthouse's to judge, see PUBLIC_LCP_REGRESSION_MS) and a ceiling that only goes down on the
 *     scheduler (see SCHEDULE_LCP_CEILING_MS). CLS is the largest 5 s session window, as the
 *     metric defines it; LCP is the last candidate, taken once the page has gone quiet.
 *   - INP for four interactions on the signed-in app, CPU slowed 4x: open a job, change a job's
 *     status, type in search, switch the scheduler day. Each interaction's duration is its worst
 *     event (input delay + handlers + the next paint). They are RECORDED (attached to the report and
 *     written to e2e/test-results-mobile/first-paint-metrics.json); the assertion is the 500 ms "poor"
 *     line of the metric, so a regression is caught without turning a lab number into a promise.
 *
 * Writes only in the throwaway org (the status change). MOBILE_GATE_ROUTES selects it with
 * `public-estimate-open`, `public-invoice-open`, `schedule`, `jobs` and `job-detail`.
 */
import { expect, type CDPSession, type Locator, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { gateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test } from './session';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));
const PROD = process.env.MOBILE_GATE_PROD_BUILD === '1';

const LCP_BUDGET_MS = 2500;
/**
 * The 2.5 s target is judged with Lighthouse (its own simulated slow-4G over an HTTP/2 production
 * build; the slice's result and md_files/specs/qa/mobile-first-paint-measurements.md have the runs).
 * This spec applies the throttle in the browser against a local HTTP/1.1 preview with a live API
 * behind it, which is harsher and noisier (the same page landed between 2.3 and 3.3 s before the page was built on its own, and 1.7 s after, slice 61 round 3), so here the
 * public pages are held to a regression bound, not the target: a font stylesheet or a script put
 * back on the critical path adds seconds, and this catches that.
 */
const PUBLIC_LCP_REGRESSION_MS = 3000;
const CLS_BUDGET = 0.1;
/**
 * The technician landing page (the scheduler) does not meet the 2.5 s target yet: it is the staff
 * app (an initial download of about 349 KB gzipped without the copilot), then a sign-in check, a
 * lazy page chunk of its own and a chain of data requests, all on a 1.6 Mbit/s line. Measured
 * 6.0 s here after the round-1 fix (the scheduler's chunk starts beside the sign-in check, one
 * sign-in request instead of two, six dialogs out of its first download; it was 6.9 to 7.9 s), and
 * 7.6 s in the Lighthouse budget (8.5 s before). The slice's measurements note has the breakdown and
 * what is left. This ceiling stops it getting worse while the target stays the goal; it only goes
 * down, and is deleted when the target is met.
 */
const SCHEDULE_LCP_CEILING_MS = 7000;
const INP_POOR_MS = 500;
const HERE = path.dirname(fileURLToPath(import.meta.url));
const RESULTS = path.resolve(HERE, '..', 'test-results-mobile', 'first-paint-metrics.json');

function record(entry: Record<string, unknown>) {
  fs.mkdirSync(path.dirname(RESULTS), { recursive: true });
  let all: Record<string, unknown>[] = [];
  try { all = JSON.parse(fs.readFileSync(RESULTS, 'utf8')); } catch { /* first write */ }
  all.push({ at: new Date().toISOString(), ...entry });
  fs.writeFileSync(RESULTS, JSON.stringify(all, null, 1));
}

/** Observers installed before the page's own scripts run. */
const OBSERVERS = () => {
  const w = window as unknown as { __perf: { shifts: { t: number; v: number }[]; lcp: number; events: Record<number, number> } };
  w.__perf = { shifts: [], lcp: 0, events: {} };
  try {
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { startTime: number; value: number; hadRecentInput: boolean }[]) {
        if (!e.hadRecentInput) w.__perf.shifts.push({ t: e.startTime, v: e.value });
      }
    }).observe({ type: 'layout-shift', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries()) w.__perf.lcp = e.startTime;
    }).observe({ type: 'largest-contentful-paint', buffered: true });
    new PerformanceObserver((list) => {
      for (const e of list.getEntries() as unknown as { interactionId: number; duration: number }[]) {
        if (e.interactionId) w.__perf.events[e.interactionId] = Math.max(w.__perf.events[e.interactionId] ?? 0, e.duration);
      }
    }).observe({ type: 'event', durationThreshold: 16, buffered: true } as PerformanceObserverInit);
  } catch { /* an engine without these entry types reports zeros, and the test says so */ }
};

async function throttle(page: Page, { cpu, network }: { cpu: number; network: boolean }): Promise<CDPSession> {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setCPUThrottlingRate', { rate: cpu });
  if (network) {
    await cdp.send('Network.enable');
    await cdp.send('Network.emulateNetworkConditions', {
      offline: false,
      latency: 150,
      downloadThroughput: (1.6 * 1024 * 1024) / 8,
      uploadThroughput: (750 * 1024) / 8,
    });
  }
  return cdp;
}

/** CLS as the metric defines it: the largest burst of shifts, a burst being shifts less than 1 s apart and at most 5 s long. */
function cumulativeShift(shifts: { t: number; v: number }[]): number {
  let best = 0;
  let sum = 0;
  let start = 0;
  let last = 0;
  for (const s of [...shifts].sort((a, b) => a.t - b.t)) {
    if (sum === 0 || s.t - last > 1000 || s.t - start > 5000) { sum = 0; start = s.t; }
    sum += s.v;
    last = s.t;
    best = Math.max(best, sum);
  }
  return best;
}

async function read(page: Page) {
  return page.evaluate(() => {
    const p = (window as unknown as { __perf: { shifts: { t: number; v: number }[]; lcp: number; events: Record<number, number> } }).__perf;
    return { shifts: p.shifts, lcp: p.lcp, events: Object.values(p.events) };
  });
}

async function resetEvents(page: Page) {
  await page.evaluate(() => { (window as unknown as { __perf: { events: object } }).__perf.events = {}; });
}

/** The slowest interaction since the last reset, after letting the app finish painting. */
async function slowestInteraction(page: Page): Promise<number> {
  await page.waitForTimeout(800);
  const { events } = await read(page);
  return events.length ? Math.max(...events) : 0;
}

async function quiet(page: Page) {
  await settle(page, []);
  await page.waitForTimeout(2000); // let the last LCP candidate and late shifts arrive
}

for (const [id, kind] of [
  ['public-estimate-open', 'estimate'],
  ['public-invoice-open', 'invoice'],
] as const) {
  test(`metrics, public ${kind}: LCP and CLS on a 4x CPU, slow-4G profile`, async ({ page, browserName }, testInfo) => {
    test.skip(!PROD, 'needs a production build: set MOBILE_GATE_PROD_BUILD=1 and serve dist with vite preview');
    test.skip(browserName !== 'chromium', 'layout-shift and LCP entries are Chromium only');
    test.skip(!selected.has(id), `MOBILE_GATE_ROUTES does not select ${id}`);
    gateDevice(testInfo.project.name);
    const f = fixtures();
    const fx = kind === 'estimate' ? f.estimateOpen : f.invoiceOpen;
    await page.addInitScript(OBSERVERS);
    await throttle(page, { cpu: 4, network: true });
    await page.goto(`/p/${kind === 'estimate' ? 'estimates' : 'invoices'}/${fx.id}?token=${encodeURIComponent(fx.token)}`, {
      waitUntil: 'domcontentloaded',
      timeout: 90_000,
    });
    await quiet(page);
    const m = await read(page);
    const cls = cumulativeShift(m.shifts);
    record({ test: `public ${kind}`, project: testInfo.project.name, lcpMs: Math.round(m.lcp), cls: Number(cls.toFixed(4)) });
    await testInfo.attach('metrics.json', { body: JSON.stringify({ lcpMs: m.lcp, cls }), contentType: 'application/json' });
    expect(m.lcp, 'an LCP candidate was observed').toBeGreaterThan(0);
    expect(m.lcp, `LCP ${Math.round(m.lcp)} ms (target ${LCP_BUDGET_MS} ms by Lighthouse; regression bound ${PUBLIC_LCP_REGRESSION_MS} ms here)`).toBeLessThanOrEqual(PUBLIC_LCP_REGRESSION_MS);
    expect(cls, `CLS ${cls.toFixed(4)}`).toBeLessThanOrEqual(CLS_BUDGET);
  });
}

test('metrics, technician landing page (scheduler): LCP and CLS on a 4x CPU, slow-4G profile', async ({ page, session, browserName }, testInfo) => {
  test.skip(!PROD, 'needs a production build: set MOBILE_GATE_PROD_BUILD=1 and serve dist with vite preview');
  test.skip(browserName !== 'chromium', 'layout-shift and LCP entries are Chromium only');
  test.skip(!selected.has('schedule'), 'MOBILE_GATE_ROUTES does not select schedule');
  gateDevice(testInfo.project.name);
  await signIn(page, session, []);
  try {
    await page.addInitScript(OBSERVERS);
    await throttle(page, { cpu: 4, network: true });
    await page.goto('/schedule', { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await quiet(page);
    const m = await read(page);
    const cls = cumulativeShift(m.shifts);
    record({ test: 'technician landing (schedule)', project: testInfo.project.name, lcpMs: Math.round(m.lcp), cls: Number(cls.toFixed(4)) });
    await testInfo.attach('metrics.json', { body: JSON.stringify({ lcpMs: m.lcp, cls }), contentType: 'application/json' });
    expect(m.lcp, 'an LCP candidate was observed').toBeGreaterThan(0);
    expect(m.lcp, `LCP ${Math.round(m.lcp)} ms (target ${LCP_BUDGET_MS} ms, ceiling ${SCHEDULE_LCP_CEILING_MS} ms)`).toBeLessThanOrEqual(SCHEDULE_LCP_CEILING_MS);
    expect(cls, `CLS ${cls.toFixed(4)}`).toBeLessThanOrEqual(CLS_BUDGET);
  } finally {
    await keepSession(page, session);
  }
});

async function press(target: Locator) {
  await target.scrollIntoViewIfNeeded();
  await target.click();
}

test('metrics, INP: open a job, change a status, type in search, switch the scheduler day (4x CPU)', async ({ page, session, browserName }, testInfo) => {
  test.skip(!PROD, 'needs a production build: set MOBILE_GATE_PROD_BUILD=1 and serve dist with vite preview');
  test.skip(browserName !== 'chromium', 'event timing and CPU throttling are Chromium only');
  test.skip(!['jobs', 'job-detail', 'schedule'].every((s) => selected.has(s)), 'MOBILE_GATE_ROUTES must select jobs, job-detail and schedule');
  test.setTimeout(240_000);
  gateDevice(testInfo.project.name);
  const jobId = fixtures().jobId;
  const inp: Record<string, number | string> = {};
  await signIn(page, session, []);
  try {
    await page.addInitScript(OBSERVERS);
    await throttle(page, { cpu: 4, network: false });

    // 1. Open a job: from the jobs list to its page.
    await page.goto('/jobs', { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await settle(page, []);
    // A card on a phone has a stretched button over it; a table row opens on its job number.
    const card = page.locator('[data-slot="table-card-open"]').first();
    const link = (await card.count()) > 0 ? card : page.getByText(/^J\d{5}$/).first();
    await expect(link, 'a job is in the list').toBeVisible({ timeout: 30_000 }).catch(async () => {
      await expect(page.getByText(/^J\d{5}$/).first(), 'a job is in the list').toBeVisible({ timeout: 30_000 });
    });
    await resetEvents(page);
    await press((await card.count()) > 0 ? card : page.getByText(/^J\d{5}$/).first());
    await expect(page.getByTestId('detail-header')).toBeVisible({ timeout: 30_000 });
    inp['open a job'] = await slowestInteraction(page);

    // 2. Change a status: start the seeded, scheduled job from the lifecycle bar (a write, in the
    // throwaway org).
    await page.goto(`/jobs/${jobId}`, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await expect(page.getByTestId('detail-header')).toBeVisible({ timeout: 30_000 });
    await settle(page, []);
    // The seeded job has a visit, whose own control is the next step in its lifecycle; a job with no
    // visit has a job-level Start.
    const visitStep = page.getByRole('group', { name: /^Visit \d+$/ }).getByRole('button').last();
    const jobStart = page.getByRole('button', { name: /^Start$/ }).first();
    const step = (await visitStep.isVisible().catch(() => false)) ? visitStep : jobStart;
    if (await step.isVisible().catch(() => false)) {
      await resetEvents(page);
      await press(step);
      inp['change a status'] = await slowestInteraction(page);
    } else {
      inp['change a status'] = 'not measured: the job has no visit or Start control in this state';
    }

    // 3. Type in search. On a phone the search is behind its own button.
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await settle(page, []);
    let box = page.getByPlaceholder(/search/i).first();
    if (!(await box.isVisible().catch(() => false))) {
      await press(page.getByRole('button', { name: /search/i }).first());
      box = page.getByPlaceholder(/search/i).first();
    }
    await expect(box).toBeVisible({ timeout: 15_000 });
    await box.click();
    await resetEvents(page);
    await box.pressSequentially('gate', { delay: 80 });
    inp['type in search'] = await slowestInteraction(page);

    // 4. Switch the scheduler day.
    await page.goto('/schedule', { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await settle(page, []);
    await resetEvents(page);
    await press(page.getByRole('button', { name: 'Next period' }).first());
    inp['switch the scheduler day'] = await slowestInteraction(page);

    record({ test: 'INP, 4x CPU', project: testInfo.project.name, inpMs: inp });
    await testInfo.attach('inp.json', { body: JSON.stringify(inp, null, 1), contentType: 'application/json' });
    // The observer only reports an interaction that took at least 16 ms, so a recorded 0 means "faster
    // than the observer can see", which is a good answer. That the observer works at all is proved
    // by the others: at least three of the four must have registered.
    const values = Object.entries(inp);
    for (const [name, v] of values) {
      expect(typeof v, `${name}: ${v}`).toBe('number');
      expect(v as number, `${name}: ${v} ms`).toBeLessThanOrEqual(INP_POOR_MS);
    }
    expect(values.filter(([, v]) => (v as number) > 0).length, 'event timing is working: most interactions registered').toBeGreaterThanOrEqual(3);
  } finally {
    await keepSession(page, session);
  }
});
