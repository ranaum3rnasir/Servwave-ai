/**
 * Mobile slice 53 (CMP-03, TOUCH-02 close, SCR-01 overlays): the older titled dialog (`ui/modal`)
 * on the adaptive overlay. Every live Modal dialog that a key route can open in the throwaway org
 * is opened the way a user would, on the six device projects.
 *
 *   - Phones (320, 360, 393) and the landscape phone (838x390: wide but short):
 *       form / content  -> the whole screen;  choice -> a bottom sheet on the phones (a card on the
 *       landscape phone, which has room beside it).
 *       The close is 44 px and inside the screen; the footer's action is on screen without scrolling;
 *       and with the body made far taller than the screen and scrolled to its end, the close and the
 *       footer have not moved (they are pinned; only the body scrolls).
 *   - The tablet (768x1024) and the desktop control: the centred card, as today.
 *
 * The dialogs the throwaway org cannot reach are listed below, with the reason: they are
 * the same component and are covered by src/__tests__/legacy-modal-overlay.test.tsx, and by the
 * real-device checklist (RD-49). Nothing is saved from a dialog: each is opened, measured and
 * closed. The only records written are a vendor ("Gate vendor") and a catalog item ("Gate item"),
 * made through the API in the throwaway org, so the vendor and item dialogs have a record to open.
 *
 * MOBILE_GATE_ROUTES selects a case by its page's route id (`invoice-detail`, `inventory`, ...).
 */
import { expect, request, type APIRequestContext, type Locator, type Page } from '@playwright/test';
import fs from 'fs';
import { gateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE, gateBackend } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

type Intent = 'form' | 'choice' | 'content';
type Opened = { ok: true } | { notHere: string };

interface Case {
  /** The page's route id in routes.ts. */
  route: string;
  /** The dialog's title, as its accessible name. */
  title: string | RegExp;
  intent: Intent;
  path: (f: GateFixtures) => string;
  /** Records the dialog needs that the shared seed does not hold, made in the throwaway org. */
  seed?: (api: APIRequestContext) => Promise<void>;
  open: (page: Page, touch: boolean, f: GateFixtures) => Promise<Opened>;
  /** The footer's primary action, when the dialog has one at this stage. */
  action?: string | RegExp;
}

const visible = async (loc: Locator) => {
  try { return await loc.first().isVisible(); } catch { return false; }
};

/** Tap the first of these that is on screen. */
async function tapFirst(page: Page, touch: boolean, candidates: Locator[], what: string): Promise<void> {
  // On a loaded machine the page's data arrives late: wait for any of them before choosing.
  await candidates.map((c) => c.first()).reduce((a, b) => a.or(b)).waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
  for (const c of candidates) {
    if (await visible(c)) {
      await press(touch, c.first(), { timeout: 15_000 });
      return;
    }
  }
  throw new Error(`no visible ${what} to open the dialog with`);
}

/** A page action: its inline button when shown, else its entry in the page's actions menu. */
async function invoke(page: Page, touch: boolean, label: RegExp, menu: RegExp = /^(More actions|Actions)$/): Promise<Opened> {
  const header = page.getByTestId('detail-header').first();
  const inline = header.getByRole('button', { name: label });
  await inline.first().or(header.getByRole('button', { name: menu }).first()).waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
  if (await visible(inline)) {
    await press(touch, inline.first(), { timeout: 15_000 });
    return { ok: true };
  }
  const trigger = header.getByRole('button', { name: menu }).first();
  if (!(await visible(trigger))) throw new Error(`neither a "${label}" button nor an actions menu is on the page`);
  await press(touch, trigger, { timeout: 15_000 });
  const item = page.getByRole('menuitem', { name: label }).first();
  try { await item.waitFor({ state: 'visible', timeout: 5_000 }); } catch { throw new Error(`the actions menu has no "${label}" entry`); }
  await press(touch, item, { timeout: 15_000 });
  return { ok: true };
}

const main = (page: Page) => page.locator('main');
const exact = (name: string) => new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);

/** One catalog item named "Gate item", made once per org, so the inventory grid has a row with actions. */
async function ensureItem(api: APIRequestContext): Promise<void> {
  const list = await api.get('/api/price-book/items?search=Gate%20item');
  const body = await list.json().catch(() => ({}));
  const items: Array<{ name?: string }> = Array.isArray(body) ? body : (body.items ?? body.data ?? []);
  if (items.some((i) => i.name === 'Gate item')) return;
  // A fixed SKU: the org's own uniqueness rule turns a parallel worker's second POST into a 409, ignored below.
  const res = await api.post('/api/price-book/items', { data: { name: 'Gate item', sku: 'GATE-ITEM-1', kind: 'material', unit_price: 10, track_inventory: true } });
  if (!res.ok() && res.status() !== 409) throw new Error(`could not seed the gate item: ${res.status()} ${(await res.text()).slice(0, 200)}`);
}

/** An item row's "More actions" menu entry, on the inventory grid. */
async function itemAction(page: Page, touch: boolean, entry: RegExp): Promise<Opened> {
  // A table row on a wide screen and a card on a phone: either way the item's own kebab is the first one in main.
  await page.locator('main').getByText('Gate item', { exact: true }).first().waitFor({ state: 'visible', timeout: 15_000 });
  await press(touch, page.locator('main').getByRole('button', { name: 'More actions' }).first(), { timeout: 15_000 });
  const item = page.getByRole('menuitem', { name: entry }).first();
  try { await item.waitFor({ state: 'visible', timeout: 5_000 }); } catch { throw new Error(`the item's actions menu has no "${entry}" entry`); }
  await press(touch, item, { timeout: 15_000 });
  return { ok: true };
}

/** One vendor named "Gate vendor", made once per org (a repeat or a parallel worker's POST is ignored). */
async function ensureVendor(api: APIRequestContext): Promise<void> {
  const list = await api.get('/api/inventory/vendors');
  const body = await list.json().catch(() => ({}));
  const vendors: Array<{ name?: string }> = Array.isArray(body) ? body : (body.vendors ?? body.data ?? []);
  if (vendors.some((v) => v.name === 'Gate vendor')) return;
  const res = await api.post('/api/inventory/vendors', { data: { name: 'Gate vendor', category: 'Hardware' } });
  if (!res.ok() && res.status() !== 409) throw new Error(`could not seed the gate vendor: ${res.status()} ${(await res.text()).slice(0, 200)}`);
}

const CASES: Case[] = [
  // ---- Invoice (the open one, then the paid one) ----
  { route: 'invoice-detail', title: 'Record Payment', intent: 'form', path: (f) => `/invoices/${f.invoiceOpen.id}`, action: 'Record Payment',
    open: (p, t) => invoke(p, t, exact('Record Payment')) },
  { route: 'invoice-detail', title: 'Void Invoice', intent: 'form', path: (f) => `/invoices/${f.invoiceOpen.id}`, action: 'Void Invoice',
    open: (p, t) => invoke(p, t, exact('Void Invoice')) },
  { route: 'invoice-detail', title: 'Issue Credit', intent: 'form', path: (f) => `/invoices/${f.invoiceOpen.id}`,
    open: (p, t) => invoke(p, t, exact('Credit')) },
  { route: 'invoice-detail', title: 'Refund Invoice', intent: 'form', path: (f) => `/invoices/${f.invoicePaid.id}`,
    open: (p, t) => invoke(p, t, exact('Refund')) },

  { route: 'invoice-detail', title: 'Void Payment', intent: 'form', path: (f) => `/invoices/${f.invoicePaid.id}`,
    open: async (p, t) => {
      await tapFirst(p, t, [p.getByRole('tab', { name: /^\s*Payments\b/ })], 'Payments tab');
      await tapFirst(p, t, [main(p).getByRole('button', { name: exact('Void') })], "the payment's Void button");
      return { ok: true };
    } },

  // ---- Job ----
  { route: 'job-detail', title: 'Create Invoice for', intent: 'form', path: (f) => `/jobs/${f.jobId}`,
    open: (p, t) => invoke(p, t, exact('Create Invoice'), /^(More actions|Actions|Job actions)$/) },

  // ---- Inventory ----
  { route: 'inventory', title: 'Restock Inventory', intent: 'form', path: () => '/inventory',
    open: async (p, t) => { await tapFirst(p, t, [main(p).getByRole('button', { name: exact('Restock') })], 'Restock button'); return { ok: true }; } },
  { route: 'inventory', title: 'Transfer Stock Between Locations', intent: 'form', path: () => '/inventory',
    open: async (p, t) => { await tapFirst(p, t, [main(p).getByRole('button', { name: exact('Transfer') })], 'Transfer button'); return { ok: true }; } },
  { route: 'inventory', title: 'Import Items from CSV', intent: 'form', path: () => '/inventory',
    open: async (p, t) => { await tapFirst(p, t, [main(p).getByRole('button', { name: exact('Import CSV') })], 'Import CSV button'); return { ok: true }; } },
  { route: 'inventory-vendors', title: 'Add New Vendor', intent: 'form', path: () => '/inventory/vendors', action: 'Save Vendor',
    open: async (p, t) => { await tapFirst(p, t, [main(p).getByRole('button', { name: exact('Add Vendor') })], 'Add Vendor button'); return { ok: true }; } },
  { route: 'inventory', title: 'Set Quantity (Count)', intent: 'form', path: () => '/inventory', seed: ensureItem,
    open: (p, t) => itemAction(p, t, /^\s*Set quantity\s*$/i) },
  { route: 'inventory', title: 'Reserve Levels', intent: 'form', path: () => '/inventory', seed: ensureItem,
    open: (p, t) => itemAction(p, t, /^\s*Reserve levels\s*$/i) },
  { route: 'inventory', title: /^(Delete|Archive) item\?/, intent: 'choice', path: () => '/inventory', seed: ensureItem,
    open: (p, t) => itemAction(p, t, /^\s*(Delete|Archive)\b/i) },
  { route: 'inventory', title: 'Add Location', intent: 'form', path: () => '/inventory',
    open: async (p, t) => {
      const selector = main(p).getByRole('button', { name: /locations?\b/i }).first();
      // Bring the selector to the top first: its list opens below it, and on a 568 px phone it would
      // open under the fold and keep moving as the page scrolls to meet it.
      await selector.evaluate((el) => el.scrollIntoView({ block: 'start' }));
      await p.waitForTimeout(300);
      await tapFirst(p, t, [selector], 'location selector');
      await p.waitForTimeout(500);
      await tapFirst(p, t, [p.getByRole('button', { name: /Add Location \/ Van/ })], 'Add Location / Van button');
      return { ok: true };
    } },
  // A vendor of the gate's own: the detail reader (content), then its Delete, a confirmation (choice).
  { route: 'inventory-vendors', title: /^Vendor · Gate vendor/, intent: 'content', path: () => '/inventory/vendors', seed: ensureVendor,
    open: async (p, t) => { await tapFirst(p, t, [main(p).getByText('Gate vendor', { exact: true })], 'the seeded vendor'); return { ok: true }; } },
  { route: 'inventory-vendors', title: /^Archive vendor · Gate vendor/, intent: 'choice', path: () => '/inventory/vendors', seed: ensureVendor,
    open: async (p, t) => {
      await tapFirst(p, t, [main(p).getByText('Gate vendor', { exact: true })], 'the seeded vendor');
      await tapFirst(p, t, [p.getByRole('dialog', { name: /^Vendor · Gate vendor/ }).getByRole('button', { name: exact('Delete') })], "the vendor dialog's Delete button");
      return { ok: true };
    } },
  { route: 'inventory-purchase-orders', title: 'Create Purchase Order', intent: 'form', path: () => '/inventory/purchase-orders',
    open: async (p, t) => { await tapFirst(p, t, [main(p).getByRole('button', { name: /^\s*(\+\s*)?(New PO|New Purchase Order|Create PO|Create Purchase Order)\s*$/ })], 'New purchase order button'); return { ok: true }; } },
  { route: 'inventory-staging', title: 'New Job Pickup', intent: 'form', path: () => '/inventory/staging',
    open: async (p, t) => { await tapFirst(p, t, [main(p).getByRole('button', { name: /^\s*(\+\s*)?(New Pickup|Create New Pickup)\s*$/ })], 'New Pickup button'); return { ok: true }; } },
  { route: 'inventory-assets', title: 'New Asset', intent: 'form', path: () => '/inventory/assets',
    open: async (p, t) => { await tapFirst(p, t, [main(p).getByRole('button', { name: /^\s*(\+\s*)?New Asset\s*$/ })], 'New Asset button'); return { ok: true }; } },
  { route: 'inventory-price-book', title: 'Create Bundle', intent: 'form', path: () => '/inventory/price-book',
    open: async (p, t) => {
      await tapFirst(p, t, [p.getByRole('tab', { name: /^\s*Groups\b/ })], 'Groups tab');
      await tapFirst(p, t, [main(p).getByRole('button', { name: /^\s*(\+\s*)?New Bundle\s*$/ })], 'New Bundle button');
      return { ok: true };
    } },

  // ---- Communication ----
  { route: 'comm-text', title: 'New message', intent: 'form', path: () => '/communication/text',
    open: async (p, t) => { await tapFirst(p, t, [p.getByRole('button', { name: /^\s*(\+\s*)?New( (message|text))?\s*$/i })], 'New message button'); return { ok: true }; } },
  { route: 'comm-inbox', title: /Team & groups/, intent: 'content', path: () => '/communication/inbox',
    open: async (p, t) => {
      const dir = p.getByRole('button', { name: exact('Directory') });
      if (!(await visible(dir))) return { notHere: 'the inbox rail (with Directory) is not shown at this width' };
      await press(t, dir.first(), { timeout: 15_000 });
      return { ok: true };
    } },
];

/**
 * Live Modal dialogs no key route reaches in the throwaway org, and why. All of them are the same
 * component with the same slots; the Vitest suite renders each presentation, and the checklist
 * has the rest.
 *   - Need records the org does not have and this spec does not make: a location (Edit, Delete),
 *     a purchase order (PO detail, PO preview, Pick an item), a pickup ticket (Stage
 *     detail/preview/email), an asset (its actions), an uploaded file (Rename file), a low-stock
 *     item (Low stock action), a draft invoice (Delete Invoice: the seeded ones are sent).
 *   - Nested inside Add Item: Add Brand, Add Category, Add Finish, Add Branch, Manage list.
 *   - Phone administration, shown only to the pilot organisations: Create group, Block a number,
 *     the call-flow chooser, text templates and automations, the training call.
 *   - Need the live phone line: Get a number, the in-call dialogs.
 * Dead importers (no route renders them): the stock-out approvals, the estimate comparison, the
 * barcode scan dialog and the three old report pages. They state an intent so the type holds.
 */
/** Phones and the landscape phone get the pinned layout; the tablet and desktop get the card. */
const PHONES = new Set(['iphone-se', 'galaxy-s24', 'iphone-15']);
const LANDSCAPE = 'landscape-phone';

function expectedPresentation(deviceId: string, intent: Intent): 'fullscreen' | 'bottom-sheet' | 'card' {
  if (PHONES.has(deviceId)) return intent === 'choice' ? 'bottom-sheet' : 'fullscreen';
  if (deviceId === LANDSCAPE) return intent === 'choice' ? 'card' : 'fullscreen';
  return 'card';
}

async function rect(loc: Locator) {
  const b = await loc.boundingBox();
  if (!b) throw new Error('expected an element with a box');
  return b;
}

for (const c of CASES) {
  test(`legacy modal: ${typeof c.title === 'string' ? c.title : c.title.source} (${c.intent})`, async ({ page, session }, testInfo) => {
    test.skip(!selected.has(c.route), `MOBILE_GATE_ROUTES does not select ${c.route}`);
    const device = gateDevice(testInfo.project.name);
    const f = fixtures();
    await signIn(page, session, []);
    try {
      if (c.seed) {
        // The worker's own session, so no extra sign-in: the throwaway org's admin writes into its own org.
        const token = JSON.parse(session.current.value).access_token as string;
        const api = await request.newContext({ baseURL: gateBackend(), extraHTTPHeaders: { Authorization: `Bearer ${token}` } });
        try { await c.seed(api); } finally { await api.dispose(); }
      }
      await page.goto(c.path(f), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, []);
      const opened = await c.open(page, device.touch, f);
      if ('notHere' in opened) {
        // The widest window must open everything; a narrower one may legitimately not show an entry point.
        expect(device.id, `the desktop control must reach "${String(c.title)}": ${opened.notHere}`).not.toBe('desktop');
        testInfo.annotations.push({ type: 'not applicable', description: opened.notHere });
        test.skip(true, opened.notHere);
        return;
      }

      const dialog = page.getByRole('dialog', { name: c.title });
      await expect(dialog, `the "${String(c.title)}" dialog opens`).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(600); // the open animation
      const vp = page.viewportSize()!;
      const want = expectedPresentation(device.id, c.intent);

      await expect(dialog, `presentation of a ${c.intent} dialog on ${device.id}`).toHaveAttribute('data-presentation', want);
      const box = await rect(dialog);
      // The corner X (aria-label "Close"), not a footer button that happens to be named Close.
      const close = dialog.locator('button[aria-label="Close"]').first();
      const closeBox = await rect(close);

      // Always: the dialog and its close are inside the screen.
      expect(box.x, 'dialog inside the left edge').toBeGreaterThanOrEqual(-0.5);
      expect(box.y, 'dialog inside the top edge').toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width, 'dialog inside the right edge').toBeLessThanOrEqual(vp.width + 0.5);
      expect(box.y + box.height, 'dialog inside the bottom edge').toBeLessThanOrEqual(vp.height + 0.5);
      expect(closeBox.x + closeBox.width, 'close inside the right edge').toBeLessThanOrEqual(vp.width + 0.5);
      expect(closeBox.y, 'close inside the top edge').toBeGreaterThanOrEqual(-0.5);

      if (want === 'card') {
        // As today: a centred card, with the page showing round it.
        expect(box.width, 'a card, not edge to edge').toBeLessThan(vp.width);
        expect(box.x, 'a card, centred with room each side').toBeGreaterThan(8);
        await expect(dialog.locator('[data-slot="modal-body"]'), 'the card has no pinned body').toHaveCount(0);
        return;
      }

      // Phones: the close is 44 px (touch), the footer action is on screen, nothing is pinned wrongly.
      expect(closeBox.width, 'close is 44 px wide').toBeGreaterThanOrEqual(43.5);
      expect(closeBox.height, 'close is 44 px tall').toBeGreaterThanOrEqual(43.5);
      if (want === 'fullscreen') {
        expect(Math.round(box.x), 'starts at the left edge').toBe(0);
        expect(Math.round(box.y), 'starts at the top edge').toBe(0);
        expect(Math.round(box.width), 'spans the width').toBe(vp.width);
        expect(Math.round(box.height), 'spans the whole height').toBe(vp.height);
      } else {
        expect(Math.round(box.x), 'sheet starts at the left edge').toBe(0);
        expect(Math.round(box.width), 'sheet spans the width').toBe(vp.width);
        expect(Math.round(box.y + box.height), 'sheet sits on the bottom edge').toBe(vp.height);
      }

      const body = dialog.locator('[data-slot="modal-body"]');
      await expect(body, 'the body is its own scroller').toHaveCount(1);
      const footer = dialog.locator('[data-slot="modal-footer"]');
      const hasFooter = (await footer.count()) > 0;

      const footerBefore = hasFooter ? await rect(footer) : null;
      if (footerBefore) {
        expect(footerBefore.y + footerBefore.height, 'footer inside the bottom edge').toBeLessThanOrEqual(vp.height + 0.5);
        expect(footerBefore.y, 'footer below the header').toBeGreaterThan(closeBox.y + closeBox.height - 1);
      }
      if (c.action) {
        const action = dialog.getByRole('button', { name: c.action, exact: typeof c.action === 'string' });
        await expect(action.first()).toBeVisible();
        const a = await rect(action.first());
        expect(a.y + a.height, 'the action is on screen without scrolling').toBeLessThanOrEqual(vp.height + 0.5);
      }

      // Make the body far taller than the screen and scroll it to its end: the close and the footer
      // must not have moved (only the body scrolls).
      await body.evaluate((el) => {
        const spacer = document.createElement('div');
        spacer.setAttribute('data-gate-spacer', '1');
        spacer.style.cssText = `height:${window.innerHeight * 3}px;flex:none`;
        el.appendChild(spacer);
        el.scrollTop = el.scrollHeight;
      });
      await page.waitForTimeout(250);
      const scrolled = await body.evaluate((el) => ({ top: el.scrollTop, room: el.scrollHeight - el.clientHeight }));
      expect(scrolled.top, 'the body scrolled').toBeGreaterThan(50);
      expect(scrolled.room, 'the body is the scroller').toBeGreaterThan(50);
      // A bottom sheet grows with its content (up to its cap), so its top moves; the close is measured
      // from the dialog's own top, which is where a pinned header stays. A full screen does not move at all.
      const closeAfter = await rect(close);
      const dialogAfter = await rect(dialog);
      expect(Math.abs((closeAfter.y - dialogAfter.y) - (closeBox.y - box.y)), 'the close did not scroll away').toBeLessThanOrEqual(1);
      expect(dialogAfter.y, 'the dialog stays inside the top edge').toBeGreaterThanOrEqual(-0.5);
      if (want === 'bottom-sheet') expect(dialogAfter.height, 'the sheet is capped, not as tall as its content').toBeLessThanOrEqual(vp.height * 0.85 + 1);
      if (footerBefore) {
        const footerAfter = await rect(footer);
        expect(Math.abs(footerAfter.y - footerBefore.y), 'the footer did not scroll away').toBeLessThanOrEqual(1);
        expect(footerAfter.y + footerAfter.height, 'footer still inside the bottom edge').toBeLessThanOrEqual(vp.height + 0.5);
      }
      // The dialog itself is not the scroller.
      const panelScrolls = await dialog.evaluate((el) => el.scrollHeight - el.clientHeight);
      expect(panelScrolls, 'the dialog panel does not scroll as a whole').toBeLessThanOrEqual(1);
    } finally {
      await keepSession(page, session).catch(() => {});
    }
  });
}
