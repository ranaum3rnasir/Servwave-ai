/**
 * Mobile slice 68: the customer and lead detail tabs on a phone, and a failed load with Retry.
 *
 * Tabs. Every tab of the customer page and of the lead page is opened on each device project and
 * measured with the gate's own overflow check (nothing past either edge, no page-level sideways
 * scroll, no undocumented sideways scroller). Below lg (1024) the tab tables are cards: no table is
 * mounted and each card's open control is at least 44 px tall. (The slice asked for md; the customer
 * Leads table is 699 px wide on an iPad Mini's 634 px, see useRecordCards.) From lg up the tables
 * are what they were, so the desktop control only checks that: a table's own scroll box is its
 * designed fallback there. Read-only: nothing is pressed except tabs.
 *
 * Errors. The lead page, the leads list, the customer page and the customers list each get a forced
 * 500 from their own request. The page must say it could not load (fixed copy, no vendor name and
 * none of the server's words), offer Retry, and recover when the request works again. A genuine
 * 404 keeps the "not found" words.
 *
 * Runs with the gate (same projects, same session slots). MOBILE_GATE_ROUTES selects it with the
 * ids `customer-detail`, `lead-detail`, `customers` and `leads`.
 */
import { expect, type Page } from '@playwright/test';
import fs from 'fs';
import { overflowCheck } from './checks';
import { ADMIN_SCROLL_TABLES, INTENDED_X_SCROLLERS } from '../../src/ui-kit/lib/intendedScrollers';
import { gateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test } from './session';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));
const MD = 768;
const LG = 1024;
const VENDOR = /ctm|calltracking|supabase|render|vercel|twilio|resend|stripe/i;

async function openPage(page: Page, session: Parameters<typeof signIn>[1], url: string) {
  await signIn(page, session, []);
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
}

async function overflowOffenders(page: Page): Promise<string[]> {
  const res = await page.evaluate(overflowCheck, { intended: [...INTENDED_X_SCROLLERS], adminTables: [...ADMIN_SCROLL_TABLES] });
  return res.offenders;
}

const TAB_CASES = [
  { id: 'customer-detail', path: (f: GateFixtures) => `/customers/${f.customerId}` },
  { id: 'lead-detail', path: (f: GateFixtures) => `/leads/${f.leadId}` },
] as const;

for (const c of TAB_CASES) {
  test(`detail tabs: ${c.id} fits on every tab, cards below lg`, async ({ page, session }, testInfo) => {
    test.skip(!selected.has(c.id), `MOBILE_GATE_ROUTES does not select ${c.id}`);
    test.setTimeout(180_000);
    const vp = page.viewportSize()!;
    const cards = vp.width < LG;
    await openPage(page, session, c.path(fixtures()));
    try {
      const names = (await page.getByRole('tab').allInnerTexts()).map((t) => t.trim()).filter(Boolean);
      expect(names.length, 'the page has tabs').toBeGreaterThan(2);
      const seen: Record<string, { tables: number; cards: number; offenders: string[] }> = {};

      for (const name of names) {
        // Match the tab by its own label (counts such as "Estimates (1)" are part of the name).
        await page.getByRole('tab', { name, exact: true }).click();
        await settle(page, []);

        const offenders = await overflowOffenders(page);
        const tables = await page.locator('[role=tabpanel]:visible table').count();
        const cardCount = await page.locator('[role=tabpanel]:visible [data-slot=record-card]').count();
        seen[name] = { tables, cards: cardCount, offenders };

        if (cards) expect(offenders, `${c.id} > ${name} has no overflow at ${vp.width}px`).toEqual([]);
        if (cards) {
          expect(tables, `${c.id} > ${name}: no table below lg`).toBe(0);
          const opens = page.locator('[role=tabpanel]:visible [data-slot=record-card-open]');
          const n = await opens.count();
          for (let i = 0; i < n; i += 1) {
            const box = await opens.nth(i).boundingBox();
            expect(box?.height ?? 0, `${c.id} > ${name}: a card's open control is at least 44 px tall`).toBeGreaterThanOrEqual(43.5);
          }
        } else {
          expect(cardCount, `${c.id} > ${name}: no cards from lg up`).toBe(0);
        }
      }
      await testInfo.attach(`${c.id}-tabs.json`, { body: JSON.stringify({ width: vp.width, seen }, null, 1), contentType: 'application/json' });

      // The seeded customer has leads, estimates, jobs, invoices and payments, and the seeded lead
      // has an estimate: below lg those tabs really rendered cards, so the checks above are not
      // vacuous.
      if (cards) {
        const expected = c.id === 'customer-detail' ? ['Leads', 'Estimates', 'Jobs', 'Invoices', 'Payments'] : [/^Estimates/];
        for (const want of expected) {
          const key = names.find((n) => (typeof want === 'string' ? n === want : want.test(n)));
          expect(key, `${c.id} has a ${String(want)} tab`).toBeTruthy();
          expect(seen[key!].cards, `${c.id} > ${key} rendered cards below lg`).toBeGreaterThan(0);
        }
      }
    } finally {
      await keepSession(page, session);
    }
  });
}

interface ErrorCase {
  id: string;
  path: (f: GateFixtures) => string;
  /** The request to fail: its pathname is matched exactly. */
  api: (f: GateFixtures) => string;
  title: string;
  /** What shows once the request works again. */
  recovered: (page: Page) => ReturnType<Page['locator']>;
  /** The words a failure must NOT use. */
  not: string;
  /** A list page (its table keeps a scroll box from md up). */
  list?: boolean;
}

const ERROR_CASES: ErrorCase[] = [
  {
    id: 'lead-detail', path: (f) => `/leads/${f.leadId}`, api: (f) => `/api/leads/${f.leadId}`,
    title: "Couldn't load this lead.", recovered: (p) => p.getByRole('heading', { level: 1 }).first(), not: 'Lead not found.',
  },
  {
    id: 'leads', path: () => '/leads', api: () => '/api/leads',
    title: "Couldn't load leads.", recovered: (p) => p.locator('[data-slot=table-card], tbody tr').first(), not: 'No results found.', list: true,
  },
  {
    id: 'customer-detail', path: (f) => `/customers/${f.customerId}`, api: (f) => `/api/customers/${f.customerId}`,
    title: "Couldn't load this customer.", recovered: (p) => p.getByRole('heading', { level: 1 }).first(), not: 'Customer not found.',
  },
  {
    id: 'customers', path: () => '/customers', api: () => '/api/customers',
    title: "Couldn't load customers.", recovered: (p) => p.locator('[data-slot=table-card], tbody tr').first(), not: 'No results found.', list: true,
  },
];

for (const c of ERROR_CASES) {
  test(`failed load: ${c.id} shows an error with Retry, and Retry recovers`, async ({ page, session }, testInfo) => {
    test.skip(!selected.has(c.id), `MOBILE_GATE_ROUTES does not select ${c.id}`);
    test.setTimeout(120_000);
    const f = fixtures();
    const vp = page.viewportSize()!;
    let failing = true;
    const target = c.api(f);
    await page.route((url) => url.pathname === target, async (route) => {
      if (failing && route.request().method() === 'GET') {
        return route.fulfill({ status: 500, contentType: 'application/json', json: { error: 'Internal failure in the storage vendor' } });
      }
      return route.fallback();
    });
    await openPage(page, session, c.path(f));
    try {
      const error = page.getByRole('alert').filter({ hasText: c.title });
      await expect(error, 'the failure is named').toBeVisible({ timeout: 30_000 });
      await expect(page.getByText(c.not, { exact: true }), 'a failure is not worded as "empty" or "not found"').toHaveCount(0);

      // Fixed, vendor-free copy: neither a vendor name nor the server's own words.
      const copy = (await error.innerText()).trim();
      expect(copy).not.toMatch(VENDOR);
      expect(copy).not.toMatch(/internal failure/i);

      const retry = error.getByRole('button', { name: 'Retry' });
      await expect(retry).toBeVisible();
      const box = await retry.boundingBox();
      if (gateDevice(testInfo.project.name).touch) expect(box?.height ?? 0, 'Retry is at least 44 px tall').toBeGreaterThanOrEqual(43.5);

      // The error fits the screen. Not measured on the list pages from md up: their table keeps its
      // own scroll box there (a known offender of the leads and customers routes, not of this state),
      // and the app's own "something went wrong" toast rides in on a 5xx with a fixed, wider list
      // box (slice 27's), so that box is left out of the measurement.
      const measured = (await overflowOffenders(page)).filter((o) => !/ol\.toaster/.test(o));
      if (!c.list || vp.width < MD) expect(measured, `the error state has no overflow at ${vp.width}px`).toEqual([]);

      failing = false;
      await retry.click();
      await expect(error, 'the error is gone after Retry').toHaveCount(0, { timeout: 30_000 });
      await expect(c.recovered(page), 'the page loads after Retry').toBeVisible();
    } finally {
      await keepSession(page, session);
    }
  });
}
