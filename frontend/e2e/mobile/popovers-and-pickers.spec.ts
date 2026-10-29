/**
 * Mobile slice 44 (CMP-04 partial, CMP-05, CMP-07 pickers; stories 51, 53, 54): popovers stay inside
 * the screen, short status choices open as bottom sheets, and searchable pickers go full-screen on
 * phones with results that scroll by touch.
 *
 *  1. Popover family. One of each floating primitive (legacy and kit Popover, DropdownMenu and
 *     Select), anchored in the bottom-right corner with a list far taller than the screen and a
 *     panel far wider than a phone, must end up inside the viewport with the collision gutter
 *     on every side. Mounted through the dev server's own modules, as overlay-motion.spec.ts does.
 *  2. Searchable picker. In the New Task dialog the linked-record picker (type Customer) holds 30
 *     customers. Below md and on a landscape phone it is a full-screen dialog with the search field
 *     at the top and the results under it; at md and up it is still a popover that fits the screen.
 *     On every touch project a swipe over the results scrolls them to the last customer, which is
 *     then chosen by tap; on the desktop control the wheel does. (The list sits behind the New Task
 *     dialog's scroll lock, which used to swallow every touch move.)
 *  3. Choice sheet. A job's sub-status control (a status change) opens a bottom sheet below md,
 *     anchored to the bottom edge, with 44 px options; from md up it is the menu it was, on screen.
 *  4. Choice menu that has to scroll. A lead's status menu opens as a menu on the landscape phone,
 *     where the screen is only 390 px tall and the menu is capped to the room under its trigger. Whenever a
 *     menu has to scroll it must be reachable from the keyboard (axe `scrollable-region-focusable`): the
 *     menu itself, or something inside it, is in the tab order, and the menu never scrolls sideways.
 *
 * Nothing is saved: the customer and sub-status lists are answered by the test and the one write
 * (the sub-status POST) is answered by the test too. MOBILE_GATE_ROUTES selects it with `tasks`
 * (the picker) and `job-detail` (the choice sheet) and `home` (the popover family).
 */
import AxeBuilder from '@axe-core/playwright';
import { expect, type Page } from '@playwright/test';
import fs from 'fs';
import { overlaysCheck } from './checks';
import { gateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test } from './session';
import { press, swipe } from './touch';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

/** Below md (the three phones) and the short landscape window: the full-screen / sheet layouts. */
const PHONE_LAYOUT = new Set(['iphone-se', 'galaxy-s24', 'iphone-15', 'landscape-phone']);
/** Below md only: a landscape phone is wide, so a choice stays a menu there (the overlay presentation rule). */
const BELOW_MD = new Set(['iphone-se', 'galaxy-s24', 'iphone-15']);

// ── 1. the popover family stays inside the screen ──────────────────────────────────────────────
interface Reading { probe: string; left: number; top: number; right: number; bottom: number; vw: number; vh: number; maxWidth: string }

async function readFamily(page: Page): Promise<Reading[]> {
  return page.evaluate(async () => {
    const abs = (p: string) => new URL(p, location.origin).href;
    const entry = await (await fetch(abs('/src/main.tsx'))).text();
    const dep = (name: string) => {
      const m = entry.match(new RegExp(`"(/node_modules/\\.vite/deps/${name}\\.js\\?v=[^"]+)"`));
      if (!m) throw new Error(`no ${name} import in the dev server's main.tsx`);
      return abs(m[1]!);
    };
    const cjs = (m: any) => (m && m.default ? m.default : m);
    const React = cjs(await import(dep('react')));
    const ReactDOM = cjs(await import(dep('react-dom_client')));
    const h = React.createElement;
    const appPopover = await import(abs('/src/components/ui/popover.tsx'));
    const kitPopover = await import(abs('/src/ui-kit/components/ui/popover.tsx'));
    const appMenu = await import(abs('/src/components/ui/dropdown-menu.tsx'));
    const kitMenu = await import(abs('/src/ui-kit/components/ui/dropdownMenu.tsx'));
    const appSelect = await import(abs('/src/components/ui/select.tsx'));
    const kitSelect = await import(abs('/src/ui-kit/components/ui/select.tsx'));

    const rows = Array.from({ length: 40 }, (_, i) => i);
    const corner = { position: 'fixed', right: 0, bottom: 0, width: 56, height: 40, zIndex: 1 } as const;
    // A fixed panel far wider than a phone. No min-width here: a min-width beats any max-width, so it would
    // measure the probe, not the primitive.
    const wide = 'w-[640px]';
    const cases: Array<[string, () => any]> = [
      ['legacy popover', () => h(appPopover.Popover, { open: true },
        h(appPopover.PopoverTrigger, { style: corner }, 'Anchor'),
        h(appPopover.PopoverContent, { 'data-probe': 'legacy popover', className: wide },
          rows.map((i) => h('div', { key: i, style: { height: 32 } }, `Row ${i}`))))],
      ['kit popover', () => h(kitPopover.Popover, { open: true },
        h(kitPopover.PopoverTrigger, { style: corner }, 'Anchor'),
        h(kitPopover.PopoverContent, { 'data-probe': 'kit popover', className: wide },
          rows.map((i) => h('div', { key: i, style: { height: 32 } }, `Row ${i}`))))],
      ['legacy dropdown menu', () => h(appMenu.DropdownMenu, { open: true, modal: false },
        h(appMenu.DropdownMenuTrigger, { style: corner }, 'Anchor'),
        h(appMenu.DropdownMenuContent, { 'data-probe': 'legacy dropdown menu', className: wide },
          rows.map((i) => h(appMenu.DropdownMenuItem, { key: i }, `Row ${i}`))))],
      ['kit dropdown menu', () => h(kitMenu.DropdownMenu, { open: true, modal: false },
        h(kitMenu.DropdownMenuTrigger, { style: corner }, 'Anchor'),
        h(kitMenu.DropdownMenuContent, { 'data-probe': 'kit dropdown menu', className: wide },
          rows.map((i) => h(kitMenu.DropdownMenuItem, { key: i }, `Row ${i}`))))],
      ['legacy select', () => h(appSelect.Select, { open: true, value: 'r0' },
        h(appSelect.SelectTrigger, { style: corner }, h(appSelect.SelectValue, null)),
        h(appSelect.SelectContent, { 'data-probe': 'legacy select' },
          rows.map((i) => h(appSelect.SelectItem, { key: i, value: `r${i}` }, `Row ${i} with a long label that is wider than any phone screen can show on one line`))))],
      ['kit select', () => h(kitSelect.Select, { open: true, value: 'r0' },
        h(kitSelect.SelectTrigger, { style: corner }, h(kitSelect.SelectValue, null)),
        h(kitSelect.SelectContent, { 'data-probe': 'kit select' },
          rows.map((i) => h(kitSelect.SelectItem, { key: i, value: `r${i}` }, `Row ${i} with a long label that is wider than any phone screen can show on one line`))))],
    ];

    const out: any[] = [];
    for (const [probe, make] of cases) {
      const host = document.createElement('div');
      document.body.appendChild(host);
      const root = ReactDOM.createRoot(host);
      root.render(make());
      await new Promise((ok) => setTimeout(ok, 700));
      const el = document.querySelector(`[data-probe="${probe}"]`);
      if (!el) { out.push({ probe: `${probe} (not rendered)`, left: 0, top: 0, right: 0, bottom: 0, vw: innerWidth, vh: innerHeight, maxWidth: '' }); }
      else {
        // The positioned wrapper is the panel's real box (the content can be taller than its cap).
        const box = (el.closest('[data-radix-popper-content-wrapper]') ?? el).getBoundingClientRect();
        const content = el.getBoundingClientRect();
        out.push({ probe, left: Math.min(box.left, content.left), top: Math.min(box.top, content.top), right: Math.max(box.right, content.right), bottom: Math.max(box.bottom, content.bottom), vw: innerWidth, vh: innerHeight, maxWidth: getComputedStyle(el).maxWidth });
      }
      root.unmount();
      host.remove();
      await new Promise((ok) => setTimeout(ok, 250));
    }
    return out;
  });
}

test('every popover primitive stays inside the screen, with a gutter, however tall or wide its content', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
  await signIn(page, session, []);
  try {
    await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    const readings = await readFamily(page);
    await testInfo.attach('popover-family.json', { body: JSON.stringify(readings, null, 1), contentType: 'application/json' });
    // Collision padding is 10 px; one pixel of rounding. The two Selects nudge their panel 4 px toward
    // the trigger (translate-y-1), so they keep 6 of the 10.
    const gutterOf = (probe: string) => (/select/.test(probe) ? 5 : 9);
    expect(readings.length).toBe(6);
    for (const r of readings) {
      const GUTTER = gutterOf(r.probe);
      expect(r.probe, `${r.probe} rendered`).not.toMatch(/not rendered/);
      expect(r.left, `${r.probe}: left edge keeps the gutter`).toBeGreaterThanOrEqual(GUTTER);
      expect(r.top, `${r.probe}: top edge keeps the gutter`).toBeGreaterThanOrEqual(GUTTER);
      expect(r.right, `${r.probe}: right edge keeps the gutter at ${r.vw}px wide`).toBeLessThanOrEqual(r.vw - GUTTER);
      expect(r.bottom, `${r.probe}: bottom edge keeps the gutter at ${r.vh}px tall`).toBeLessThanOrEqual(r.vh - GUTTER);
    }
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});

// ── 2. the searchable picker in the New Task dialog ────────────────────────────────────────────
const CUSTOMERS = Array.from({ length: 30 }, (_, i) => {
  const n = String(i + 1).padStart(2, '0');
  return { id: `00000000-0000-4000-8000-0000000000${n}`, customer_number: `PK${n}`, first_name: 'Picker', last_name: `Customer ${n}`, company_name: null };
});
const LAST = CUSTOMERS[CUSTOMERS.length - 1]!;

test('New Task: the customer picker is full-screen on phones and scrolls by touch to a customer below the visible rows', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('tasks'), 'MOBILE_GATE_ROUTES does not select tasks');
  const device = gateDevice(testInfo.project.name);
  const phone = PHONE_LAYOUT.has(device.id);
  await signIn(page, session, []);
  try {
    await page.route(/\/api\/customers(\?|$)/, (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: { customers: CUSTOMERS, total: CUSTOMERS.length } }) : route.continue());
    await page.goto('/tasks', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    const btn = page.locator('main').getByRole('button', { name: /^\s*New Task\s*$/ }).first();
    await expect(btn).toBeVisible({ timeout: 20_000 });
    await press(device.touch, btn, { timeout: 15_000 });
    const dialog = page.getByRole('dialog', { name: 'New Task' });
    await expect(dialog).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);

    await press(device.touch, dialog.getByTestId('linked-entity-select-trigger'));
    await press(device.touch, page.getByTestId('type-toggle-CUSTOMER'));
    const last = page.getByTestId(`entity-option-${LAST.id}`);
    await expect(last, 'all 30 customers are in the list').toBeAttached({ timeout: 10_000 });
    await page.waitForTimeout(400);

    const vp = page.viewportSize()!;
    const results = page.getByTestId('linked-entity-results');
    const picker = page.getByRole('dialog', { name: 'Link to a record' });

    if (phone) {
      await expect(picker, 'the picker is its own full-screen dialog').toBeVisible();
      const box = (await picker.boundingBox())!;
      expect(Math.round(box.x), 'starts at the left edge').toBe(0);
      expect(Math.round(box.y), 'starts at the top edge').toBe(0);
      expect(Math.round(box.width), 'spans the width').toBe(vp.width);
      expect(Math.round(box.height), 'spans the height').toBe(vp.height);
      const input = picker.getByTestId('linked-entity-search-input');
      const inBox = (await input.boundingBox())!;
      const resBox = (await results.boundingBox())!;
      expect(inBox.y, 'the search field is in the top part of the screen').toBeLessThan(Math.min(220, vp.height * 0.5));
      expect(inBox.y + inBox.height, 'the results start below the search field').toBeLessThanOrEqual(resBox.y + 1);
      expect(resBox.y + resBox.height, 'the results end inside the screen').toBeLessThanOrEqual(vp.height + 1);
      expect(resBox.height, 'the results have room').toBeGreaterThan(Math.min(120, vp.height * 0.3));
    } else {
      await expect(picker, 'a popover, not a screen, from md up').toHaveCount(0);
      const r = (await results.boundingBox())!;
      expect(r.x, 'the popover is inside the screen (left)').toBeGreaterThanOrEqual(0);
      expect(r.x + r.width, 'the popover is inside the screen (right)').toBeLessThanOrEqual(vp.width);
      expect(r.y + r.height, 'the popover is inside the screen (bottom)').toBeLessThanOrEqual(vp.height);
    }

    // Swipe (or wheel) the results until the last customer is on screen: it starts below the visible rows.
    const onScreen = async () => {
      const lb = await last.boundingBox();
      const rb = await results.boundingBox();
      if (!lb || !rb) return false;
      return lb.y >= rb.y - 1 && lb.y + lb.height <= rb.y + rb.height + 1 && lb.y + lb.height <= vp.height + 1;
    };
    expect(await onScreen(), 'the last customer starts below the visible rows').toBe(false);
    for (let i = 0; i < 25 && !(await onScreen()); i++) {
      const rb = (await results.boundingBox())!;
      const top = Math.max(rb.y, 0), bottom = Math.min(rb.y + rb.height, vp.height);
      const x = rb.x + rb.width / 2;
      if (device.touch) await swipe(page, { x, y: bottom - 24 }, { x, y: top + 24 });
      else { await page.mouse.move(x, (top + bottom) / 2); await page.mouse.wheel(0, 360); }
      await page.waitForTimeout(150);
    }
    expect(await onScreen(), 'scrolling the results reached the last customer').toBe(true);

    await press(device.touch, last);
    await expect(dialog.getByTestId('linked-entity-select-trigger'), 'the chosen customer is on the trigger').toContainText(`Picker Customer ${LAST.customer_number.slice(2)}`);
    await expect(picker, 'choosing closes the picker').toHaveCount(0);
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});

// ── 3. a status change opens a bottom sheet on a phone ─────────────────────────────────────────
const SUB_STATUSES = ['UNSCHEDULED', 'SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS', 'COMPLETED', 'CANCELLED'].flatMap((parent) =>
  ['Waiting on parts', 'Waiting on customer', 'Ready to dispatch', 'Needs a second visit', 'On hold'].map((label, i) => ({ id: `sub-${parent}-${i}`.toLowerCase(), parent, label, sort_order: i })));

test('job status choice: a bottom sheet within thumb reach below md, the menu from md up', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('job-detail'), 'MOBILE_GATE_ROUTES does not select job-detail');
  const device = gateDevice(testInfo.project.name);
  const sheet = BELOW_MD.has(device.id);
  await signIn(page, session, []);
  const posts: unknown[] = [];
  try {
    await page.route(/\/api\/job-sub-statuses(\?|$)/, (route) =>
      route.request().method() === 'GET' ? route.fulfill({ json: { job_sub_statuses: SUB_STATUSES } }) : route.continue());
    await page.route(/\/api\/jobs\/[^/]+\/sub-status$/, (route) => { posts.push(route.request().postDataJSON()); return route.fulfill({ json: {} }); });
    await page.goto(`/jobs/${fixtures().jobId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    const trigger = page.getByTestId('detail-header').getByRole('button', { name: 'Set sub-status' });
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    await press(device.touch, trigger);
    await page.waitForTimeout(500);
    const vp = page.viewportSize()!;

    if (sheet) {
      const dialog = page.getByRole('dialog', { name: 'Sub-status' });
      await expect(dialog, 'the choices are a sheet').toBeVisible();
      await expect(dialog).toHaveAttribute('data-presentation', 'bottom-sheet');
      const box = (await dialog.boundingBox())!;
      expect(Math.round(box.x), 'edge to edge (left)').toBe(0);
      expect(Math.round(box.width), 'edge to edge (width)').toBe(vp.width);
      expect(Math.round(box.y + box.height), 'anchored to the bottom edge').toBe(vp.height);
      expect(box.height, 'the sheet leaves the page visible above it').toBeLessThanOrEqual(vp.height * 0.86);
      const options = dialog.getByRole('button').filter({ hasText: /Waiting on parts|Waiting on customer|Ready to dispatch|Needs a second visit|On hold|None/ });
      expect(await options.count(), 'every choice plus None is offered').toBe(6);
      for (let i = 0; i < 6; i++) {
        const b = (await options.nth(i).boundingBox())!;
        expect(b.height, `option ${i} is 44 px tall`).toBeGreaterThanOrEqual(43.5);
        expect(b.width, `option ${i} spans the sheet`).toBeGreaterThanOrEqual(vp.width * 0.8);
      }
      // The lowest option is reachable without scrolling, and tapping one picks it.
      const lastB = (await options.last().boundingBox())!;
      expect(lastB.y + lastB.height, 'the last option is on screen').toBeLessThanOrEqual(vp.height + 1);
      await press(device.touch, options.filter({ hasText: 'Waiting on customer' }));
      await expect.poll(() => posts.length, { message: 'the choice is sent' }).toBe(1);
      expect(posts[0]).toEqual({ sub_status_id: expect.stringMatching(/^sub-.*-1$/) });
      await expect(dialog, 'choosing closes the sheet').toHaveCount(0);
    } else {
      await expect(page.getByRole('menu'), 'a menu from md up').toBeVisible();
      await expect(page.getByRole('dialog', { name: 'Sub-status' }), 'no sheet from md up').toHaveCount(0);
      const over = await page.evaluate(overlaysCheck);
      expect(over.offenders, 'the menu is on screen and its last item reachable').toEqual([]);
      await page.keyboard.press('Escape');
    }
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});

// ── 4. a status menu that has to scroll stays keyboard-reachable ────────────────────────────────
test('lead status menu: when it has to scroll, a keyboard can reach it', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('lead-detail'), 'MOBILE_GATE_ROUTES does not select lead-detail');
  const device = gateDevice(testInfo.project.name);
  await signIn(page, session, []);
  try {
    await page.goto(`/leads/${fixtures().leadId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    const trigger = page.getByRole('button', { name: /^Lead status:/ }).first();
    await expect(trigger).toBeVisible({ timeout: 20_000 });
    await press(device.touch, trigger);
    await page.waitForTimeout(500);
    // Below md the control is a bottom sheet (a dialog); the menu is what this test is about.
    const menu = page.getByRole('menu');
    if (!(await menu.count())) {
      await expect(page.getByRole('dialog', { name: 'Lead status' }), 'a sheet below md').toBeVisible();
      return;
    }
    await expect(menu).toBeVisible();
    const reading = await menu.evaluate((el) => ({
      scrolls: el.scrollHeight > el.clientHeight + 1,
      scrollsSideways: el.scrollWidth > el.clientWidth + 1,
      tabIndex: el.getAttribute('tabindex'),
      rows: el.querySelectorAll('[role=menuitem]').length,
    }));
    await testInfo.attach('lead-status-menu.json', { body: JSON.stringify(reading, null, 1), contentType: 'application/json' });
    expect(reading.rows, 'the lead statuses are offered').toBeGreaterThanOrEqual(5);
    expect(reading.scrollsSideways, 'the menu never scrolls sideways').toBe(false);
    const results = await new AxeBuilder({ page }).withRules(['scrollable-region-focusable']).include('[role=menu]').analyze();
    expect(results.violations.map((v) => `${v.id}: ${v.nodes.length}`), `a scrolling menu is reachable by keyboard ${JSON.stringify(reading)}`).toEqual([]);
    await page.keyboard.press('Escape');
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});
