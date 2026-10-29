/**
 * Mobile slice 65 (CMP-03, SCR-02 dialogs, VP-04): every remaining dialog on the adaptive overlay,
 * and no list scrolling inside a dialog's body. Each dialog a key route can open in the throwaway
 * org is opened the way a user would, on the six device projects.
 *
 *   - Phones (320, 360, 393) and the landscape phone (838x390: wide but short):
 *       form / content -> the whole screen;  choice -> a bottom sheet on the phones (a card on the
 *       landscape phone, which has room beside it).
 *       The close is 44 px and inside the screen; the footer's action is on screen without scrolling;
 *       with the body made far taller than the screen and scrolled to its end, the close and the
 *       footer have not moved (only the body scrolls); and no list scrolls inside the body.
 *   - The tablet (768x1024) and the desktop control: the centred card, as today, inside the screen.
 *
 * Nothing is saved from a dialog: each is opened, measured and closed. The throwaway org reaches no
 * field-less confirmation (a 'choice', a bottom sheet) through a key route in a state that offers it, and
 * the dialogs behind a live phone line or a record the org does not hold are out of reach too. The Vitest
 * suite (src/__tests__/remaining-dialogs-overlay.test.tsx) renders every presentation of the primitive they
 * all share, guards that each one states an intent and that none sets a `vh` height cap, and the
 * real-device checklist (RD-59) has the rest.
 *
 * MOBILE_GATE_ROUTES selects a case by its page's route id (`lead-detail`, `estimate-detail`, ...).
 */
import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'fs';
import { dialogScrollersCheck } from './checks';
import { gateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
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
  open: (page: Page, touch: boolean, f: GateFixtures) => Promise<Opened>;
  /** The footer's primary action, when the dialog has one at this stage. */
  action?: string | RegExp;
  /** False for a reader that has no footer (its Close is the only way out). Default: it has one. */
  footer?: boolean;
}

const visible = async (loc: Locator) => {
  try { return await loc.first().isVisible(); } catch { return false; }
};

/** Tap the first of these that is on screen. */
async function tapFirst(touch: boolean, candidates: Locator[], what: string): Promise<void> {
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

const exact = (name: string) => new RegExp(`^\\s*${name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*$`);
const ACTIONS_MENU = /^(More actions|Actions|More|Job actions|Estimate actions|Lead actions|Customer actions)$/;

/** A page action: its inline button when shown, else its entry in the page's actions menu. */
async function invoke(page: Page, touch: boolean, label: RegExp, menu: RegExp = ACTIONS_MENU): Promise<Opened> {
  const header = page.getByTestId('detail-header').first();
  const inline = header.getByRole('button', { name: label });
  await inline.first().or(header.getByRole('button', { name: menu }).first()).waitFor({ state: 'visible', timeout: 20_000 }).catch(() => undefined);
  if (await visible(inline)) {
    await press(touch, inline.first(), { timeout: 15_000 });
    return { ok: true };
  }
  // The actions can sit behind more than one menu (the header's More, then the page's own): try each.
  const triggers = header.getByRole('button', { name: menu });
  const n = await triggers.count();
  for (let i = 0; i < n; i++) {
    const trigger = triggers.nth(i);
    if (!(await trigger.isVisible().catch(() => false))) continue;
    await press(touch, trigger, { timeout: 15_000 });
    const item = page.getByRole('menuitem', { name: label }).first();
    if (await item.waitFor({ state: 'visible', timeout: 3_000 }).then(() => true, () => false)) {
      await press(touch, item, { timeout: 15_000 });
      return { ok: true };
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(250);
  }
  return { notHere: `neither a "${label}" button nor a menu entry for it is on the page (the record is not in a state that offers it)` };
}

const main = (page: Page) => page.locator('main');

const CASES: Case[] = [
  // ---- Lead ----
  { route: 'lead-detail', title: 'Mark Lead as Lost', intent: 'form', path: (f) => `/leads/${f.leadId}`, action: /Mark (as )?Lost/,
    open: (p, t) => invoke(p, t, exact('Mark Lost')) },
  { route: 'lead-detail', title: 'Cancel Lead', intent: 'form', path: (f) => `/leads/${f.leadId}`,
    open: (p, t) => invoke(p, t, exact('Cancel Lead')) },

  // ---- Customer ----
  { route: 'customer-detail', title: 'Delete Customer', intent: 'form', path: (f) => `/customers/${f.customerId}`,
    open: (p, t) => invoke(p, t, exact('Delete client')) },
  { route: 'customer-detail', title: 'Add Location', intent: 'form', path: (f) => `/customers/${f.customerId}`,
    open: async (p, t) => {
      const section = main(p).locator('div').filter({ has: p.getByRole('heading', { name: 'Service Locations' }) }).last();
      await tapFirst(t, [section.getByRole('button', { name: exact('Add') })], 'Add button beside Service Locations');
      return { ok: true };
    } },

  // ---- Estimate ----
  { route: 'estimate-detail', title: 'Send Estimate', intent: 'form', path: (f) => `/estimates/${f.estimateOpen.id}`,
    open: (p, t) => invoke(p, t, /^\s*(Send|Resend|Send a copy)\s*$/) },
  { route: 'estimate-detail', title: 'Duplicate Estimate', intent: 'form', path: (f) => `/estimates/${f.estimateOpen.id}`,
    open: (p, t) => invoke(p, t, exact('Duplicate')) },
  { route: 'estimate-detail', title: 'Archive Estimate', intent: 'form', path: (f) => `/estimates/${f.estimateOpen.id}`,
    open: (p, t) => invoke(p, t, exact('Archive')) },

  // ---- Job ----
  { route: 'job-detail', title: 'Cancel Job', intent: 'form', path: (f) => `/jobs/${f.jobId}`,
    open: (p, t) => invoke(p, t, exact('Cancel')) },
  { route: 'job-detail', title: /^(Assign|Reassign|Schedule|Reschedule) (Technician|Job)$/, intent: 'form', path: (f) => `/jobs/${f.jobId}`,
    open: (p, t) => invoke(p, t, exact('Assign')) },
  // The job's Items tab: Price Book opens the catalog picker (it lays out its own header, one scrolling
  // grid and a footer), and its footer is pinned like any other.
  { route: 'job-detail', title: 'Price book', intent: 'form', path: (f) => `/jobs/${f.jobId}`,
    open: async (p, t) => {
      await tapFirst(t, [p.getByRole('tab', { name: /^\s*Items\b/ })], 'Items tab');
      await tapFirst(t, [p.getByRole('button', { name: /Price Book/ })], 'Price Book button');
      return { ok: true };
    } },

  // ---- Tasks, invoices, schedule, settings ----
  { route: 'tasks', title: 'Task categories', intent: 'form', path: () => '/tasks',
    open: async (p, t) => { await tapFirst(t, [main(p).getByRole('button', { name: exact('Categories') })], 'Categories button'); return { ok: true }; } },
  { route: 'invoices', title: 'To Be Invoiced', intent: 'content', footer: false, path: () => '/invoices',
    open: async (p, t) => { await tapFirst(t, [main(p).getByRole('button', { name: /To Be Invoiced/ })], 'To Be Invoiced tile'); return { ok: true }; } },
  { route: 'settings-users', title: 'Edit details', intent: 'form', path: () => '/settings/users',
    open: async (p, t) => { await tapFirst(t, [main(p).getByRole('button', { name: exact('Edit') })], 'Edit button on a user'); return { ok: true }; } },
  { route: 'settings-users', title: /^Permissions - /, intent: 'form', path: () => '/settings/users',
    open: async (p, t) => { await tapFirst(t, [main(p).getByRole('button', { name: exact('Permissions') })], 'Permissions button on a user'); return { ok: true }; } },
  { route: 'inventory-vendors', title: 'Vendor categories', intent: 'form', path: () => '/inventory/vendors',
    open: async (p, t) => { await tapFirst(t, [main(p).getByRole('button', { name: exact('Add category') })], 'Add category button'); return { ok: true }; } },
];

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
  test(`remaining dialog: ${typeof c.title === 'string' ? c.title : c.title.source} (${c.intent})`, async ({ page, session }, testInfo) => {
    test.skip(!selected.has(c.route), `MOBILE_GATE_ROUTES does not select ${c.route}`);
    const device = gateDevice(testInfo.project.name);
    const f = fixtures();
    await signIn(page, session, []);
    try {
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
        return;
      }

      // Phones: the close is 44 px, the header is above the footer, and nothing scrolls in a nested list.
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

      const scrollers = await page.evaluate(dialogScrollersCheck);
      expect(scrollers.offenders, 'no list scrolls inside the dialog body').toEqual([]);

      const footer = dialog.locator('[data-slot="dialog-footer"]');
      const wantsFooter = c.footer !== false;
      expect(await footer.count() > 0, wantsFooter ? 'the dialog has a pinned footer slot' : 'a reader without a footer has no empty footer slot').toBe(wantsFooter);
      const footerBefore = wantsFooter ? await rect(footer.first()) : null;
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
      // The body slot, or - for a picker that lays out its own header, scrolling grid and footer - its one scroller.
      await dialog.evaluate((d) => {
        const own = d.querySelector('[data-slot="dialog-body"]')
          ?? [...d.querySelectorAll('*')].find((e) => !/^(textarea|input|select)$/i.test(e.tagName) && /(auto|scroll)/.test(getComputedStyle(e).overflowY) && e.getBoundingClientRect().height > 1);
        own?.setAttribute('data-gate-body', '1');
      });
      const body = dialog.locator('[data-gate-body="1"]');
      await expect(body, 'the dialog has one scroller for its body').toHaveCount(1);
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
      const closeAfter = await rect(close);
      const dialogAfter = await rect(dialog);
      expect(Math.abs((closeAfter.y - dialogAfter.y) - (closeBox.y - box.y)), 'the close did not scroll away').toBeLessThanOrEqual(1);
      expect(dialogAfter.y, 'the dialog stays inside the top edge').toBeGreaterThanOrEqual(-0.5);
      if (want === 'bottom-sheet') expect(dialogAfter.height, 'the sheet is capped, not as tall as its content').toBeLessThanOrEqual(vp.height * 0.85 + 1);
      if (footerBefore) {
        const footerAfter = await rect(footer.first());
        expect(Math.abs(footerAfter.y - footerBefore.y), 'the footer did not scroll away').toBeLessThanOrEqual(1);
        expect(footerAfter.y + footerAfter.height, 'footer still inside the bottom edge').toBeLessThanOrEqual(vp.height + 0.5);
      }
      // ...and the panel itself does not scroll (its overflow is hidden: a wheel or a swipe on it moves nothing).
      const panelOverflow = await dialog.evaluate((el) => getComputedStyle(el).overflowY);
      expect(panelOverflow, 'the dialog panel does not scroll as a whole').not.toMatch(/auto|scroll/);
    } finally {
      await keepSession(page, session).catch(() => {});
    }
  });
}
