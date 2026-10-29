/**
 * Mobile slice 28 (PRD module 10, stories 113-118): the public estimate and invoice are readable and
 * actionable on a 320 px phone, measured in a real engine on every gate device.
 *
 * The throwaway org's own documents are short (two lines, a few hundred dollars, no email, no
 * photos), and fit anywhere, so each test stretches the public GET response the way a real
 * business's document is stretched: a long business name, a long email and website, long line
 * descriptions, seven-figure amounts and a scope with four photos. It keeps every real field and
 * id. Then, per device:
 *
 *   - estimate: nothing scrolls sideways; below sm each line row is two rows (the amount UNDER
 *     the image and description, so the description gets the width the amount used to take, and
 *     scope photos are at least 64 px); from sm up the amount sits beside the description, as
 *     before. The Total, the header and the PDF link are inside the screen. Approve and Decline are
 *     both 44 px on touch projects. The business's phone and email are a `tel:` and a `mailto:`
 *     link.
 *   - a forced approval failure (the approve POST answered 500 by the test, so nothing is ever
 *     approved) shows an alert in the Approve card and takes focus.
 *   - the decline dialog's reason picker and comment box are 16 px on touch projects (no zoom).
 *   - invoice: nothing scrolls sideways; below sm the line items are stacked rows (no table), from
 *     sm up a table; the Total and Amount Due figures are inside the screen.
 *
 * Read-only: the only writes the page attempts are answered by the test. Each assertion was seen
 * red against staging's pages before the slice's change (see the slice's run notes).
 */
import { expect, type Page, type Route } from '@playwright/test';
import fs from 'fs';
import { gateDevice } from './devices';
import { runCheck } from './checks';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { test } from './session';
import { tap } from './touch';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));
const SM = 640;

const LONG_NAME = 'Neutral Overhead Door and Entry Systems Incorporated of the Greater Metropolitan Area';
const LONG_EMAIL = 'customer.service.and.scheduling.department@neutral-overhead-door-and-entry-systems.example';
const LONG_URL = 'https://www.neutral-overhead-door-and-entry-systems.example/customers/estimates-and-warranty-information';
const LONG_DESC =
  'Supply and install one insulated steel sectional door, 16 ft x 7 ft, with a quiet belt-drive opener, two remotes, a keypad, new weather seal on all sides and haul-away of the old door';
const UNBROKEN = 'Replacement-torsion-spring-assembly-with-lifetime-cycle-rating-and-hardware';
const PHOTO = '/apple-touch-icon.png';

async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
}

/** Answer the public GET with the real response, stretched by `edit`. Every other call passes. */
async function stretch(page: Page, path: string, edit: (body: Record<string, any>) => Record<string, any>) {
  await page.route((url) => url.pathname === path, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const body = await res.json().catch(() => null);
    if (!body || typeof body !== 'object') return route.fulfill({ response: res });
    return route.fulfill({ response: res, json: edit(body) });
  });
}

const BIG_ORG = (org: Record<string, unknown> | null) => ({
  ...(org ?? {}),
  name: LONG_NAME,
  email: LONG_EMAIL,
  website: LONG_URL,
  phone: '5551234567',
  phone_ext: '204',
});

function stretchEstimate(body: Record<string, any>) {
  const e = body.estimate;
  const first = e.line_items[0];
  const line_items = [
    { ...first, description: LONG_DESC, quantity: 1, unit_price: 1234567.89, line_total: 1234567.89, discount_amount: 0 },
    ...e.line_items.slice(1).map((li: Record<string, unknown>) => ({ ...li, description: UNBROKEN })),
  ];
  const scope = { id: 'gate-scope-28', title: 'Scope of work for the front entry', body: LONG_DESC, flat_price: 98765.43, is_taxable: false, is_optional: false, is_selected: true };
  const scope_photos = [1, 2, 3, 4].map((n) => ({ id: `gate-photo-${n}`, scope_id: scope.id, url: PHOTO, caption: `Photo ${n}` }));
  return {
    ...body,
    organization: BIG_ORG(body.organization),
    estimate: { ...e, line_items, scopes: [scope], scope_photos, subtotal: 9876543.21, tax_amount: 617283.95, total_amount: 10493827.16 },
  };
}

function stretchInvoice(body: Record<string, any>) {
  const inv = body.invoice;
  const lines = (items: Array<Record<string, unknown>> | undefined) =>
    (items ?? []).map((li, i) => ({ ...li, description: i === 0 ? LONG_DESC : UNBROKEN, quantity: 12, unit_price: 102880.66, line_total: 1234567.92 }));
  return {
    ...body,
    organization: BIG_ORG(body.organization),
    invoice: {
      ...inv,
      line_items: lines(inv.line_items),
      job: inv.job ? { ...inv.job, estimate: inv.job.estimate ? { ...inv.job.estimate, line_items: lines(inv.job.estimate.line_items) } : null, charges: lines(inv.job.charges) } : null,
      subtotal: 9876543.21,
      total_amount: 10493827.16,
      amount_due: 10493827.16,
    },
  };
}

/** Horizontal extent of an element against the viewport. */
async function inside(page: Page, sel: ReturnType<Page['locator']>) {
  const vw = page.viewportSize()!.width;
  const r = (await sel.boundingBox())!;
  return { left: r.x, right: r.x + r.width, vw, ok: r.x >= -1 && r.x + r.width <= vw + 1 };
}

async function noSidewaysScroll(page: Page) {
  const r = await runCheck(page, 'overflow', { touch: false, onlyInOverlays: false });
  expect(r.offenders, 'nothing scrolls sideways or sits past the screen edge').toEqual([]);
}

test('public estimate at 320: two-row lines, wrapped header, full-size Decline, tappable contact', async ({ page }, testInfo) => {
  test.skip(!selected.has('public-estimate-open'), 'MOBILE_GATE_ROUTES does not select public-estimate-open');
  const device = gateDevice(testInfo.project.name);
  const f = fixtures();
  await stretch(page, `/api/estimates/${f.estimateOpen.id}/public`, stretchEstimate);
  await open(page, `/p/estimates/${f.estimateOpen.id}?token=${encodeURIComponent(f.estimateOpen.token)}`);
  const vw = page.viewportSize()!.width;
  const phone = vw < SM;

  await expect(page.getByText(LONG_DESC).first()).toBeVisible();
  await noSidewaysScroll(page);

  // Header and PDF link wrap rather than clip.
  expect((await inside(page, page.getByText(LONG_NAME).first())).ok, 'the business name is inside the screen').toBe(true);
  expect((await inside(page, page.getByRole('link', { name: 'View PDF' }))).ok, 'the PDF link is inside the screen').toBe(true);

  // Each line row: below sm the amount is UNDER the description; from sm up beside it.
  const rows = page.getByTestId('estimate-document-row');
  const n = await rows.count();
  expect(n, 'the stretched document has a scope row and line rows').toBeGreaterThanOrEqual(2);
  for (let i = 0; i < n; i++) {
    const g = await rows.nth(i).evaluate((row) => {
      const box = (s: string) => row.querySelector(s)?.getBoundingClientRect() ?? null;
      const content = box('[data-testid="estimate-document-row-content"]')!;
      const amount = box('[data-testid="estimate-document-row-amount"]');
      const r = row.getBoundingClientRect();
      const photos = [...row.querySelectorAll('img[alt^="Photo"]')].map((p) => p.getBoundingClientRect().width);
      return { rowW: r.width, contentW: content.width, contentBottom: content.bottom, contentRight: content.right, amountTop: amount && amount.height > 0 ? amount.top : null, amountLeft: amount && amount.height > 0 ? amount.left : null, photos };
    });
    if (g.amountTop == null) continue; // an unpriced row draws no amount
    if (phone) {
      expect(g.amountTop, `row ${i}: the amount is on its own row under the description`).toBeGreaterThanOrEqual(g.contentBottom - 1);
      // The description gets the row: all but the image column (56 px), its gap and the row padding.
      expect(g.contentW, `row ${i}: the description is ${g.contentW}px of a ${g.rowW}px row`).toBeGreaterThanOrEqual(g.rowW - 56 - 12 - 24 - 28 - 2 - 4);
      for (const w of g.photos) expect(w, `row ${i}: a scope photo stays a useful thumbnail`).toBeGreaterThanOrEqual(64);
    } else {
      expect(g.amountLeft!, `row ${i}: from sm up the amount sits beside the description`).toBeGreaterThanOrEqual(g.contentRight - 1);
    }
  }

  // The Total line is fully on screen.
  const total = page.getByTestId('estimate-document-total');
  await total.scrollIntoViewIfNeeded();
  expect((await inside(page, total)).ok, 'the estimate Total is inside the screen').toBe(true);

  // Approve and Decline are both full size.
  const approve = page.getByRole('button', { name: /approve estimate/i });
  const decline = page.getByRole('button', { name: /^decline$/i });
  await decline.scrollIntoViewIfNeeded();
  const [a, d] = [(await approve.boundingBox())!, (await decline.boundingBox())!];
  if (device.touch) {
    expect(d.height, 'Decline is a 44 px touch target').toBeGreaterThanOrEqual(44);
    expect(a.height, 'Approve is a 44 px touch target').toBeGreaterThanOrEqual(44);
  }
  expect(Math.abs(d.height - a.height), 'Decline is the same size as Approve').toBeLessThanOrEqual(1);

  // The business's phone and email are plain call and mail links, inside the screen.
  const call = page.getByRole('link', { name: '(555) 123-4567' });
  await expect(call).toHaveAttribute('href', 'tel:5551234567');
  const mail = page.getByRole('link', { name: LONG_EMAIL });
  await expect(mail).toHaveAttribute('href', `mailto:${LONG_EMAIL}`);
  await mail.scrollIntoViewIfNeeded();
  expect((await inside(page, mail)).ok, 'the long email wraps inside the screen').toBe(true);
  const site = page.getByRole('link', { name: LONG_URL });
  expect((await inside(page, site)).ok, 'the long website wraps inside the screen').toBe(true);
  if (device.touch) expect((await call.boundingBox())!.height, 'the call link is a 44 px touch target').toBeGreaterThanOrEqual(44);
});

test('public estimate: a forced approval failure is announced beside Approve and focused', async ({ page }) => {
  test.skip(!selected.has('public-estimate-open'), 'MOBILE_GATE_ROUTES does not select public-estimate-open');
  test.setTimeout(120_000);
  const f = fixtures();
  // Nothing is approved: the test answers the approve POST itself.
  await page.route((url) => url.pathname === `/api/estimates/${f.estimateOpen.id}/approve`, (route) =>
    route.fulfill({ status: 500, json: { error: 'forced by the mobile gate' } }),
  );
  await open(page, `/p/estimates/${f.estimateOpen.id}?token=${encodeURIComponent(f.estimateOpen.token)}`);

  const terms = page.getByRole('checkbox', { name: /agree to the terms/i });
  if (await terms.count()) await terms.check();
  // Sign: a short stroke across the pad (the signature spec's drawing, through pointer events).
  const canvas = page.locator('canvas');
  await canvas.scrollIntoViewIfNeeded();
  const r = (await canvas.boundingBox())!;
  await page.mouse.move(r.x + r.width * 0.2, r.y + r.height * 0.5);
  await page.mouse.down();
  for (let i = 1; i <= 12; i++) {
    await page.mouse.move(r.x + r.width * (0.2 + 0.05 * i), r.y + r.height * (0.5 + (i % 2 ? 0.15 : -0.15)));
    await page.waitForTimeout(20);
  }
  await page.mouse.up();

  const approve = page.getByRole('button', { name: /approve estimate/i });
  await expect(approve).toBeEnabled();
  await approve.click();

  const alert = page.getByRole('alert');
  await expect(alert).toBeVisible();
  await expect(alert).toContainText(/something went wrong/i);
  await expect(alert, 'the raw backend string never reaches the customer').not.toContainText('forced by the mobile gate');
  await expect(alert, 'the failure takes focus').toBeFocused();
  // Beside the button: in Approve's own card, and on screen.
  const sameCard = await alert.evaluate((el) => {
    const card = el.closest('[data-slot="card"]');
    return !!card && [...card.querySelectorAll('button')].some((b) => /approve estimate/i.test(b.textContent ?? ''));
  });
  expect(sameCard, 'the alert is in the card that holds Approve').toBe(true);
  const box = (await alert.boundingBox())!;
  const vh = page.viewportSize()!.height;
  expect(box.y + box.height, 'the alert is on screen').toBeLessThanOrEqual(vh + 1);
  expect(box.y, 'the alert is on screen').toBeGreaterThanOrEqual(-1);
});

test('public estimate: the decline reason fields do not zoom on a phone', async ({ page }, testInfo) => {
  test.skip(!selected.has('public-estimate-open'), 'MOBILE_GATE_ROUTES does not select public-estimate-open');
  const device = gateDevice(testInfo.project.name);
  test.skip(!device.touch, 'the 16 px rule is for touch projects; the desktop control keeps its density');
  const f = fixtures();
  await open(page, `/p/estimates/${f.estimateOpen.id}?token=${encodeURIComponent(f.estimateOpen.token)}`);
  const decline = page.getByRole('button', { name: /^decline$/i });
  await decline.scrollIntoViewIfNeeded();
  await tap(decline);
  const dialog = page.getByRole('dialog', { name: 'Decline Estimate' });
  await expect(dialog).toBeVisible();
  for (const field of [dialog.locator('#decline-note'), dialog.locator('#decline-reason')]) {
    const px = await field.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
    expect(px, `${await field.getAttribute('id')} is at least 16 px`).toBeGreaterThanOrEqual(16);
  }
});

test('public invoice at 320: stacked lines below sm, Total and Amount Due on screen', async ({ page }) => {
  test.skip(!selected.has('public-invoice-open'), 'MOBILE_GATE_ROUTES does not select public-invoice-open');
  const f = fixtures();
  await stretch(page, `/api/invoices/${f.invoiceOpen.id}/public`, stretchInvoice);
  await open(page, `/p/invoices/${f.invoiceOpen.id}?token=${encodeURIComponent(f.invoiceOpen.token)}`);
  const phone = page.viewportSize()!.width < SM;

  await expect(page.getByText(LONG_DESC).first()).toBeVisible();
  await noSidewaysScroll(page);

  if (phone) {
    await expect(page.getByRole('table'), 'no line-item table below sm').toHaveCount(0);
    const list = page.getByRole('list', { name: 'Line items' });
    await expect(list).toBeVisible();
    const first = list.getByRole('listitem').first();
    for (const label of ['Qty', 'Unit Price', 'Amount']) await expect(first.getByText(label, { exact: true })).toBeVisible();
    // The description takes the row's full width.
    const [row, desc] = await Promise.all([first.boundingBox(), first.getByText(LONG_DESC).boundingBox()]);
    expect(desc!.width, 'the description gets the row').toBeGreaterThanOrEqual(row!.width * 0.6);
  } else {
    await expect(page.getByRole('table'), 'a line-item table from sm up').toHaveCount(1);
  }

  const totals = page.getByTestId('public-invoice-totals');
  await totals.scrollIntoViewIfNeeded();
  for (const label of ['Total', 'Amount Due']) {
    const line = totals.getByText(label, { exact: true }).locator('..');
    const r = await inside(page, line);
    expect(r.ok, `the ${label} line (${Math.round(r.left)}..${Math.round(r.right)} of ${r.vw}) is inside the screen`).toBe(true);
    await expect(line).toContainText('$10,493,827.16');
  }
  const call = page.getByRole('link', { name: '(555) 123-4567' });
  await expect(call).toHaveAttribute('href', 'tel:5551234567');
  const mail = page.getByRole('link', { name: LONG_EMAIL });
  await expect(mail).toHaveAttribute('href', `mailto:${LONG_EMAIL}`);
  await mail.scrollIntoViewIfNeeded();
  expect((await inside(page, mail)).ok, 'the long email wraps inside the screen').toBe(true);
});
