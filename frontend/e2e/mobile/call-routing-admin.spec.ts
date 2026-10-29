/**
 * Mobile slice 49: call groups and call flows editable on a tablet.
 *
 * Measured on staging before the slice: the Phone page's call-group and call-flow tables sat in an
 * `overflow-hidden` card with a 640 / 760 px minimum width, so on an iPad Mini (about 480 px of
 * page beside the app sidebar) the Action column - Edit and Delete - was clipped and could not be
 * scrolled to; and the call-flow editor kept its 320 px inspector rail beside the canvas at every
 * width, leaving a phone about 40 px of canvas.
 *
 * The throwaway org has no call groups or call flows, so this spec answers the two list reads with
 * a short, neutral list (GET only), exactly as admin-tables.spec.ts does for tax rates. Every other
 * call to those two endpoints (a save, a delete) is aborted: nothing here can reach the phone
 * service, and no test clicks Save or Delete anyway.
 *
 * On every device project it measures:
 *   - the page never scrolls sideways, on both tabs;
 *   - the table sits in its own named scroll box and, scrolled to its far end, the Action column
 *     header and every row's Delete button are inside the box and the viewport and are not covered;
 *     the Group / Flow column is still inside the box (pinned);
 *   - the last row is reachable by scrolling the page (the Phone page clips the flows panel);
 *   - the editor: below md there is no rail, a tapped step opens a sheet inside the viewport whose
 *     last control (Remove this step) can be scrolled to and is not covered, Flow settings opens
 *     the name, hours, numbers and recording, and Save flow is on screen; from md the rail is shown
 *     as before, with the same last control reachable;
 *   - no vendor name is rendered on either tab or in the editor.
 *
 * Runs with the gate (same projects, same session slots). MOBILE_GATE_ROUTES selects it with
 * `comm-phone`. The two tabs are shown to demo orgs and the pilot org only, so the spec flags the
 * throwaway org as a demo org in the browser (the /me answer), never on the server.
 */
import { expect, type Page, type Route } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { findVendorTerms } from './vendor-terms';

const selected = new Set(selectStates().map((s) => s.id));
// The Call groups and Call flows tabs are not key states of their own: only a demo org or the pilot
// org sees them, and the gate's throwaway org is neither. This spec flags the org as a demo org in
// this browser only, so it is selected with the Phone page's state, `comm-phone`.
const STATE = 'comm-phone';

/** Show the demo-only tabs: flag the org as a demo org in this browser only (as reports-readable does). */
async function asDemoOrg(page: Page) {
  await page.route((url) => url.pathname === '/api/auth/me', async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    const res = await route.fetch();
    const body = await res.json().catch(() => null);
    if (!body?.user) return route.fulfill({ response: res });
    return route.fulfill({ response: res, json: { ...body, user: { ...body.user, org_is_demo: true } } });
  });
}
const NOW = new Date().toISOString();

const GROUPS = Array.from({ length: 12 }, (_, i) => ({
  id: `grp_${i + 1}`,
  name: `Routing group ${i + 1}`,
  ring: i % 2 ? 'round_robin' : 'all',
  members: [
    { personId: `p${i}a`, name: 'Alex Rivera', device: 'cell' },
    { personId: `p${i}b`, name: 'Sam Okafor', device: 'softphone' },
  ],
  updatedAt: NOW,
}));

const FLOWS = Array.from({ length: 12 }, (_, i) => ({
  id: `cf_${i + 1}`,
  name: `Routing flow ${i + 1}`,
  structure: i === 0 ? 'voice_menu' : 'basic',
  record: i % 2 === 0,
  status: i % 3 === 0 ? 'active' : 'draft',
  updatedAt: NOW,
  hoursMode: 'always',
  openNodes:
    i === 0
      ? [
          { id: 'n1', type: 'greeting', message: 'Thanks for calling.' },
          {
            id: 'n2',
            type: 'menu',
            prompt: 'Press 1 for service, 2 for billing, 3 for the office.',
            options: [
              { id: 'o1', digit: '1', label: 'Service', target: { kind: 'voicemail' } },
              { id: 'o2', digit: '2', label: 'Billing', target: { kind: 'voicemail' } },
              { id: 'o3', digit: '3', label: 'Office', target: { kind: 'voicemail' } },
            ],
          },
        ]
      : [{ id: `g${i}`, type: 'greeting', message: 'Thanks for calling.' }],
  closedNodes: [{ id: `v${i}`, type: 'voicemail', message: 'We are closed.' }],
}));

/** Answer the two list reads with fixture data; refuse everything else on those endpoints. */
async function withRoutingLists(page: Page, writes: string[]) {
  const handler = (key: 'callFlows' | 'callGroups', rows: unknown[]) => async (route: Route) => {
    if (route.request().method() === 'GET') return route.fulfill({ status: 200, json: { [key]: rows } });
    writes.push(`${route.request().method()} ${new URL(route.request().url()).pathname}`);
    return route.abort('blockedbyclient');
  };
  await page.route((u) => u.pathname === '/api/communication/call-flows', handler('callFlows', FLOWS));
  await page.route((u) => u.pathname === '/api/communication/call-groups', handler('callGroups', GROUPS));
}

interface BoxReading {
  pageScrollWidth: number;
  viewport: number;
  boxClient: number;
  boxScroll: number;
  /** Action header and Delete buttons, after the box is scrolled to its far end. */
  actionHeaderInBox: boolean;
  deleteOutOfBox: string[];
  /** First-column cells that started outside the box at its far end. */
  firstColumnOut: string[];
}

function readBox(name: string): BoxReading {
  const box = document.querySelector(`[data-mobile-scroll-x="${name}"]`) as HTMLElement;
  const before = box.scrollLeft;
  box.scrollLeft = box.scrollWidth;
  const b = box.getBoundingClientRect();
  const inBox = (r: DOMRect) => r.left >= b.left - 1 && r.right <= b.right + 1;
  const header = [...box.querySelectorAll('th')].find((th) => th.textContent?.trim() === 'Action') as HTMLElement;
  const deletes = [...box.querySelectorAll('button[aria-label^="Delete "]')] as HTMLElement[];
  const firstCells = [...box.querySelectorAll('tr')].map((tr) => tr.firstElementChild as HTMLElement).filter(Boolean);
  const out = {
    pageScrollWidth: document.documentElement.scrollWidth,
    viewport: document.documentElement.clientWidth,
    boxClient: box.clientWidth,
    boxScroll: box.scrollWidth,
    actionHeaderInBox: !!header && inBox(header.getBoundingClientRect()),
    deleteOutOfBox: deletes.filter((d) => !inBox(d.getBoundingClientRect())).map((d) => d.getAttribute('aria-label') ?? ''),
    firstColumnOut: firstCells
      .filter((c) => { const r = c.getBoundingClientRect(); return r.left < b.left - 1 || r.right <= b.left + 1; })
      .map((c) => (c.innerText || '').trim().slice(0, 30)),
  };
  box.scrollLeft = before;
  return out;
}

/** True when the element's centre is on screen and the topmost thing there is the element itself. */
async function reachable(page: Page, selector: string, nth: 'first' | 'last' = 'first', text?: string) {
  return page.evaluate(({ sel, which, txt }) => {
    const all = ([...document.querySelectorAll(sel)] as HTMLElement[]).filter((e) => !txt || (e.textContent ?? '').includes(txt));
    const el = which === 'last' ? all[all.length - 1] : all[0];
    if (!el) return { found: false } as const;
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const cx = r.left + r.width / 2;
    const cy = r.top + r.height / 2;
    const top = document.elementFromPoint(cx, cy);
    return {
      found: true,
      onScreen: r.left >= -1 && r.right <= window.innerWidth + 1 && r.top >= -1 && r.bottom <= window.innerHeight + 1,
      uncovered: !!top && (top === el || el.contains(top)),
    } as const;
  }, { sel: selector, which: nth, txt: text });
}

async function vendorNamesOnScreen(page: Page): Promise<string[]> {
  const text = await page.evaluate(() => document.body.innerText + '\n' + [...document.querySelectorAll('[aria-label],[placeholder],[title]')]
    .map((e) => `${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('placeholder') ?? ''} ${e.getAttribute('title') ?? ''}`).join('\n'));
  return findVendorTerms([{ source: 'page', text }]).map((h) => `${h.term}: ${h.excerpt}`);
}

for (const [tab, boxName, rowLabel] of [
  ['groups', 'phone-call-groups', 'Routing group'],
  ['flows', 'phone-call-flows', 'Routing flow'],
] as const) {
  test(`call routing ${tab}: the table scrolls in its own box and the Action column is reachable`, async ({ page, session }, testInfo) => {
    test.skip(!selected.has(STATE), `MOBILE_GATE_ROUTES does not select ${STATE}`);
    const device = gateDevice(testInfo.project.name);
    const notes: string[] = [];
    const writes: string[] = [];
    await signIn(page, session, notes);
    await asDemoOrg(page);
    await asDemoOrg(page);
  await withRoutingLists(page, writes);
    try {
      await page.goto(`/communication/phone/${tab}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      const box = page.locator(`[data-mobile-scroll-x="${boxName}"]`);
      await expect(box).toBeVisible({ timeout: 20_000 });
      await expect(box.locator('tbody tr')).toHaveCount(12);
      await page.evaluate(() => document.fonts.ready);

      const r = await page.evaluate(readBox, boxName);
      await testInfo.attach(`${tab}-box.json`, { body: JSON.stringify({ device: device.id, ...r, notes }, null, 1), contentType: 'application/json' });

      expect(r.pageScrollWidth, 'the page itself never scrolls sideways').toBeLessThanOrEqual(r.viewport);
      expect(r.boxClient, 'the box never grows past the screen').toBeLessThanOrEqual(r.viewport);
      expect(r.actionHeaderInBox, 'the Action column header, scrolled to, is inside the box').toBe(true);
      expect(r.deleteOutOfBox, 'Delete buttons outside the box at its far end').toEqual([]);
      expect(r.firstColumnOut, 'first-column cells that scrolled out of the box').toEqual([]);
      if (!device.touch) expect(r.boxScroll, 'desktop: the table fits its box, as before').toBeLessThanOrEqual(r.boxClient + 1);

      // The last row's Delete button can be brought on screen and tapped (nothing covers it).
      // Not clicked: that would delete a row.
      await box.evaluate((el) => { (el as HTMLElement).scrollLeft = (el as HTMLElement).scrollWidth; });
      const last = await reachable(page, `[data-mobile-scroll-x="${boxName}"] button[aria-label^="Delete ${rowLabel}"]`, 'last');
      expect(last, 'the last row Delete button').toMatchObject({ found: true, onScreen: true, uncovered: true });

      expect(await vendorNamesOnScreen(page), 'vendor names on screen').toEqual([]);
      expect(writes, 'nothing was written to the phone service').toEqual([]);
    } finally {
      await keepSession(page, session);
    }
  });
}

test('call routing editor: the inspector is a sheet below md and a rail from md', async ({ page, session }, testInfo) => {
  test.skip(!selected.has(STATE), `MOBILE_GATE_ROUTES does not select ${STATE}`);
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  const writes: string[] = [];
  await signIn(page, session, notes);
  await asDemoOrg(page);
  await withRoutingLists(page, writes);
  try {
    await page.goto('/communication/phone/flows', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, notes);
    await page.getByRole('button', { name: 'Edit Routing flow 1', exact: true }).click();
    await expect(page.getByText('Incoming Call')).toBeVisible({ timeout: 15_000 });

    const width = page.viewportSize()?.width ?? 0;
    const belowMd = width < 768;
    const aside = page.locator('aside').filter({ hasText: 'Remove this step' });

    // Open the voice menu step: the tallest inspector.
    await page.getByText('3 options').click();

    const readInspector = () => page.evaluate((below) => {
      const root = (below ? document.querySelector('[role="dialog"]') : document.querySelector('aside')) as HTMLElement | null;
      if (!root) return null;
      const r = root.getBoundingClientRect();
      return {
        root: below ? 'sheet' : 'rail',
        top: r.top, bottom: r.bottom, left: r.left, right: r.right,
        vw: window.innerWidth, vh: window.innerHeight,
      };
    }, belowMd);

    // The sheet slides up from the bottom edge: measure it once it has settled.
    await expect
      .poll(async () => { const p = await readInspector(); return p ? Math.round(p.bottom) <= p.vh + 1 : false; }, { timeout: 5_000 })
      .toBe(true);
    const pos = await readInspector();
    expect(pos, belowMd ? 'a sheet opened' : 'the rail is shown').not.toBeNull();
    await testInfo.attach('inspector.json', { body: JSON.stringify({ device: device.id, belowMd, ...pos, notes }, null, 1), contentType: 'application/json' });
    expect(pos!.left, 'inspector starts inside the viewport').toBeGreaterThanOrEqual(-1);
    expect(pos!.right, 'inspector ends inside the viewport').toBeLessThanOrEqual(pos!.vw + 1);
    expect(pos!.top, 'inspector top is on screen').toBeGreaterThanOrEqual(-1);
    expect(pos!.bottom, 'inspector bottom is on screen').toBeLessThanOrEqual(pos!.vh + 1);

    if (belowMd) {
      await expect(aside, 'below md there is no rail').toHaveCount(0);
      // The canvas is behind the sheet, not replaced by it.
      await expect(page.getByText('Incoming Call')).toBeAttached();
    } else {
      await expect(aside).toBeVisible();
      await expect(page.locator('[role="dialog"]'), 'from md there is no sheet').toHaveCount(0);
    }

    // The last control of the tallest inspector can be scrolled to and is not covered.
    const lastField = await reachable(page, 'button', 'first', 'Remove this step');
    expect(lastField, 'Remove this step').toMatchObject({ found: true, onScreen: true, uncovered: true });

    expect(await vendorNamesOnScreen(page), 'vendor names on screen').toEqual([]);

    // Close the inspector and check what is left on screen.
    if (belowMd) {
      await page.getByRole('button', { name: 'Done' }).click();
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);
      // Flow settings: the name, hours, numbers and recording, in the same sheet.
      await page.getByRole('button', { name: 'Flow settings' }).click();
      await expect(page.locator('[role="dialog"]').getByLabel('Flow name')).toBeVisible();
      await expect
        .poll(() => page.evaluate(() => { const d = document.querySelector('[role="dialog"]'); return !!d && Math.round(d.getBoundingClientRect().bottom) <= window.innerHeight + 1; }), { timeout: 5_000 })
        .toBe(true);
      const rec = await reachable(page, '[role="dialog"] button', 'first', 'Record');
      expect(rec, 'the recording switch, the last field of Flow settings').toMatchObject({ found: true, onScreen: true, uncovered: true });
      await page.getByRole('button', { name: 'Done' }).click();
      await expect(page.locator('[role="dialog"]')).toHaveCount(0);
    }
    const save = await reachable(page, 'button', 'first', 'Save flow');
    expect(save, 'Save flow').toMatchObject({ found: true, onScreen: true, uncovered: true });

    const sideways = await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth);
    expect(sideways, 'the page itself never scrolls sideways').toBe(true);
    expect(writes, 'nothing was written to the phone service').toEqual([]);
  } finally {
    await keepSession(page, session);
  }
});
