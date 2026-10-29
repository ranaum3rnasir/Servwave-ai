/**
 * Mobile slice 47 (PRD module 7, PUB-03): a customer's link loads the light public page, not the
 * staff app, in a real engine on every gate device.
 *
 * The gate runs against the dev server, where every module is its own request, so the page's
 * module graph can be read straight off the network: if the public estimate or invoice asks for
 * the staff layout, the route table, the auth store, the signed-in API client, the identity SDK or
 * the data-fetching library, it has dragged the staff app in. (Byte budgets are enforced on the
 * production build by `scripts/check-public-bundle-budget.mjs`; a dev server cannot measure them.)
 *
 *   - the page is served from `public.html` (its entry module is `public-main`), not `index.html`;
 *   - no request for any staff-only module, and none for a service-worker script;
 *   - no service worker is registered or controls the page;
 *   - the decline dialog still opens, from its lazily loaded chunk, with its reason picker;
 *   - a path under /p/ that is not a public page is handed to the staff app (full load to /login
 *     or the app root), not left blank.
 *
 * Read-only: the page's own GETs, nothing else.
 */
import { expect, type Page } from '@playwright/test';
import fs from 'fs';
import { gateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { test } from './session';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

/** Request URLs (path only) that mean the staff app is being loaded. */
const STAFF_ONLY = [
  /\/src\/pages\/v2\/V2AppLayout/,
  /\/src\/pages\/v2\/V2Routes/,
  /\/src\/pages\/v2\/routes\//,
  /\/src\/App\.tsx/,
  /\/src\/stores\//,
  /\/src\/lib\/axios/,
  /\/src\/lib\/supabase/,
  /\/src\/lib\/queryClient/,
  /\/src\/main\.tsx/,
  /@supabase/,
  /@tanstack_react-query|@tanstack\/react-query/,
  /\/node_modules\/\.vite\/deps\/axios/,
  /\/src\/instrument\.ts/,
];

const SERVICE_WORKER_SCRIPT = /\/(sw|registerSW|workbox[^/]*)\.m?js(\?|$)/;

async function openAndWatch(page: Page, url: string) {
  const requested: string[] = [];
  page.on('request', (req) => {
    try {
      const u = new URL(req.url());
      requested.push(u.pathname + u.search);
    } catch {
      /* data: and blob: URLs */
    }
  });
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
  return requested;
}

async function workerState(page: Page) {
  return page.evaluate(async () => {
    if (!('serviceWorker' in navigator)) return { supported: false, registrations: 0, controlled: false };
    const regs = await navigator.serviceWorker.getRegistrations();
    return { supported: true, registrations: regs.length, controlled: !!navigator.serviceWorker.controller };
  });
}

for (const [id, kind] of [
  ['public-estimate-open', 'estimate'],
  ['public-invoice-open', 'invoice'],
] as const) {
  test(`public ${kind}: served by the light page, no staff modules, no service worker`, async ({ page }, testInfo) => {
    test.skip(!selected.has(id), `MOBILE_GATE_ROUTES does not select ${id}`);
    gateDevice(testInfo.project.name);
    const f = fixtures();
    const fx = kind === 'estimate' ? f.estimateOpen : f.invoiceOpen;
    const url = `/p/${kind === 'estimate' ? 'estimates' : 'invoices'}/${fx.id}?token=${encodeURIComponent(fx.token)}`;

    const requested = await openAndWatch(page, url);

    // The light entry, not the staff one.
    expect(requested.some((r) => /\/src\/public-main\.tsx/.test(r)), 'public-main is loaded').toBe(true);
    const staff = requested.filter((r) => STAFF_ONLY.some((p) => p.test(r)));
    expect(staff, 'the public page asks for no staff-only module').toEqual([]);

    // No service worker script is fetched, registered or in control.
    expect(requested.filter((r) => SERVICE_WORKER_SCRIPT.test(r)), 'no service worker script is requested').toEqual([]);
    const sw = await workerState(page);
    expect(sw.registrations, 'no service worker is registered').toBe(0);
    expect(sw.controlled, 'no service worker controls the page').toBe(false);

    // The document itself rendered.
    await expect(page.locator('main, [data-slot="public-page"], body').first()).toBeVisible();
  });
}

test('public estimate: the decline dialog opens from its lazy chunk with the reason picker', async ({ page }, testInfo) => {
  test.skip(!selected.has('public-estimate-open'), 'MOBILE_GATE_ROUTES does not select public-estimate-open');
  gateDevice(testInfo.project.name);
  const f = fixtures();
  const requested = await openAndWatch(page, `/p/estimates/${f.estimateOpen.id}?token=${encodeURIComponent(f.estimateOpen.token)}`);

  const decline = page.getByRole('button', { name: /^Decline$/ });
  await expect(decline).toBeVisible();
  await decline.click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('combobox')).toBeVisible();
  await expect(dialog.getByRole('textbox')).toBeVisible();
  expect(requested.some((r) => /declineDialog/.test(r)), 'the dialog came from its own chunk').toBe(true);

  // Nothing was sent: close without declining.
  await dialog.getByRole('button', { name: 'Go Back' }).click();
  await expect(dialog).toBeHidden();
});

test('a /p/ path that is not a public page is handed to the staff app', async ({ page }, testInfo) => {
  test.skip(!selected.has('public-estimate-open'), 'MOBILE_GATE_ROUTES does not select public-estimate-open');
  gateDevice(testInfo.project.name);
  await page.goto('/p/not-a-page', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  // The light page replaces the location with `/`; the staff app then loads (signed out: its sign-in).
  await page.waitForURL((u) => !u.pathname.startsWith('/p/'), { timeout: 30_000 });
  await expect(page.locator('#root')).not.toBeEmpty({ timeout: 30_000 });
});
