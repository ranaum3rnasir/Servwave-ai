/**
 * Mobile slice 31: inventory, service plans and automations fit a phone.
 *
 * The throwaway org has no automations, no staged jobs, a handful of service plans at most and an
 * empty stock ledger, so the gate's generic checks see empty states on these routes and cannot
 * judge the layouts this slice changes. Each test below answers the list GET with a realistic,
 * full list instead (neutral, invented names) and measures the page with that list in it. Every
 * write still goes to the API untouched, and no test writes anything.
 *
 *   - automations: a long automation name keeps at least 150 px (it was squeezed to about 30 px at
 *     320 by the status chip, the switch and two 44 px icon buttons on the same row);
 *   - inventory activity: the From/To date range is not cut off by the table card, and each date
 *     field keeps at least 120 px;
 *   - inventory and inventory activity render fewer than 1,500 DOM nodes with a full catalog and
 *     a long ledger in hand;
 *   - inventory staging: stage cards are paged (at most 20 on screen until "Show more") and the
 *     received-progress column no longer takes the row from the job's site line;
 *   - service plans: the list is paged (at most 25 plans on screen) and the page never scrolls
 *     sideways;
 *   - the New service plan dialog: below `sm` a line's Description has its own row and at least
 *     200 px; from `sm` up it shares a row with Qty and Price, as before.
 *
 * Runs with the gate (same projects, same session slots). MOBILE_GATE_ROUTES selects each test by
 * its route: `automations`, `inventory`, `inventory-activity`, `inventory-staging`, `service-plans`.
 */
import { expect, type Page, type Route } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { tap } from './touch';

const selected = new Set(selectStates().map((s) => s.id));
const now = new Date().toISOString();
const uuid = (prefix: number, i: number) =>
  `00000000-0000-4000-${String(prefix).padStart(4, '0')}-${String(i + 1).padStart(12, '0')}`;

/** Answer one exact API path's GET with `body(url)`; everything else goes through. */
async function stubGet(page: Page, path: string, body: (url: URL) => unknown) {
  await page.route((url) => url.pathname === path, async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 200, json: body(new URL(route.request().url())) });
  });
}

async function open(page: Page, path: string, notes: string[]) {
  await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, notes);
  await page.evaluate(() => document.fonts.ready);
}

const domNodes = (page: Page) => page.evaluate(() => document.querySelectorAll('*').length);

/**
 * Ancestors that cut the element off: any ancestor that clips (overflow other than visible) and
 * whose box does not contain the element horizontally, plus the viewport itself.
 */
function clippedBy(el: Element): string[] {
  const r = el.getBoundingClientRect();
  const out: string[] = [];
  if (r.left < -1 || r.right > document.documentElement.clientWidth + 1) out.push('viewport');
  for (let a = el.parentElement; a && a !== document.body; a = a.parentElement) {
    const ox = getComputedStyle(a).overflowX;
    if (ox === 'visible') continue;
    const b = a.getBoundingClientRect();
    if (r.left < b.left - 1 || r.right > b.right + 1) {
      out.push(`${a.tagName.toLowerCase()}.${(a.className || '').toString().split(' ').slice(0, 3).join('.')} (${ox})`);
    }
  }
  return out;
}

// --- automations -------------------------------------------------------------------------------

const WORKFLOW_NAMES = [
  'Remind the customer the day before every scheduled visit',
  'Thank the customer and ask for a review after the job is done',
  'Tell the office when an estimate has been approved',
];

const WORKFLOWS = WORKFLOW_NAMES.map((name, i) => ({
  id: uuid(31, i),
  name,
  status: i === 2 ? 'DRAFT' : 'PUBLISHED',
  is_enabled: i === 0,
  trigger_type: 'JOB_COMPLETED',
  trigger_config: null,
  send_window: 'ANYTIME',
  template_key: null,
  legacy_rule_id: null,
  published_at: i === 2 ? null : now,
  last_triggered_at: i === 0 ? now : null,
  trigger_count: i === 0 ? 1234 : 0,
  created_at: now,
  updated_at: now,
  steps: [{ id: uuid(32, i), position: 0, step_type: 'NOTIFY_TEAM', config: {} }],
  issues: [],
  has_unpublished_changes: false,
  published_version: i === 2 ? null : { version: 1, published_at: now },
}));

test('automations: a long automation name keeps its room on every device', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('automations'), 'MOBILE_GATE_ROUTES does not select automations');
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  await stubGet(page, '/api/workflows', () => WORKFLOWS);
  try {
    await open(page, '/automations', notes);
    const widths: Record<string, number> = {};
    for (const name of WORKFLOW_NAMES) {
      const el = page.getByText(name, { exact: true }).first();
      await expect(el).toBeVisible({ timeout: 20_000 });
      widths[name] = (await el.boundingBox())!.width;
      expect(await el.evaluate(clippedBy), `${name}: cut off by`).toEqual([]);
    }
    await testInfo.attach('automation-names.json', { body: JSON.stringify({ device: device.id, widths, notes }, null, 1), contentType: 'application/json' });
    for (const [name, w] of Object.entries(widths)) {
      expect(w, `"${name}" is readable, not squeezed`).toBeGreaterThanOrEqual(150);
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth)).toBe(true);
  } finally {
    await keepSession(page, session);
  }
});

// --- inventory: DOM size and the activity date range ---------------------------------------------

const ITEMS = Array.from({ length: 300 }, (_, i) => ({
  id: uuid(33, i),
  sku: `SKU-${String(i + 1).padStart(4, '0')}`,
  name: `Stock item number ${i + 1}, standard grade`,
  category: 'Hardware',
  trade: 'door',
  kind: 'material',
  uom: 'EA',
  unitCost: 10 + (i % 17),
  sellPrice: 25 + (i % 23),
  serialized: false,
  hazmat: false,
  status: 'active',
  vendor: 'Sample Supply Co',
  stock: [],
  updatedAt: now,
}));

const MOVEMENT_TOTAL = 600;
/**
 * The movements GET, in the real row shape (backend `mapMovement`) with every server-joined field
 * filled: a job link, an invoice link, a Logistic Order link and a cost on every row. That is the
 * heaviest card a phone can render, so the DOM budget below holds for any real ledger, not only
 * for light rows (staging fix 1: lightweight stub rows passed here while the demo org's real
 * ledger put the page at about 1,620 nodes on phones). Answers as many rows as the page asks for,
 * like the server, so the page's own page size is what gets measured.
 */
function movements(url: URL) {
  const limit = Number(url.searchParams.get('limit') || 25);
  const pageNo = Number(url.searchParams.get('page') || 1);
  const data = Array.from({ length: limit }, (_, i) => {
    const n = (pageNo - 1) * limit + i;
    return {
      id: uuid(34, n),
      occurredAt: now,
      itemSku: `SKU-${String(i + 1).padStart(4, '0')}`,
      itemName: `Stock item number ${i + 1}, standard grade`,
      type: (['receive', 'consume', 'transfer', 'return', 'adjust'] as const)[i % 5],
      qty: 1 + (i % 9),
      fromLocationId: uuid(35, 0),
      toLocationId: uuid(35, 1),
      reference: `Job J-${1000 + n} · weekly restock for the service van`,
      actor: 'Office Admin',
      itemId: ITEMS[i % ITEMS.length].id,
      jobId: uuid(36, n),
      jobNumber: `J-${1000 + n}`,
      invoiceId: uuid(37, n),
      invoiceNumber: `INV-${2000 + n}`,
      logisticOrderId: uuid(38, n),
      logisticOrderNumber: `LO-${3000 + n}`,
      logisticOrderLineId: uuid(39, n),
      fromLocationName: 'Main warehouse',
      toLocationName: 'Van 2',
      actorUserId: uuid(40, 0),
      unitCost: 12.5 + (i % 7),
    };
  });
  return { data, meta: { page: pageNo, limit, total: MOVEMENT_TOTAL, totalPages: Math.ceil(MOVEMENT_TOTAL / limit) } };
}

const DOM_BUDGET = 1500;

test('inventory: the items page renders fewer than 1,500 DOM nodes with a full catalog', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('inventory'), 'MOBILE_GATE_ROUTES does not select inventory');
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  await stubGet(page, '/api/inventory/items', () => ({ data: ITEMS, meta: { page: 1, limit: 100, total: ITEMS.length, totalPages: 1 } }));
  await stubGet(page, '/api/inventory/movements', movements);
  try {
    await open(page, '/inventory', notes);
    await expect(page.getByText(ITEMS[0].name).first()).toBeVisible({ timeout: 20_000 });
    const nodes = await domNodes(page);
    await testInfo.attach('inventory-dom.json', { body: JSON.stringify({ device: device.id, nodes, notes }, null, 1), contentType: 'application/json' });
    expect(nodes, 'DOM nodes on /inventory with 300 items').toBeLessThan(DOM_BUDGET);
  } finally {
    await keepSession(page, session);
  }
});

test('inventory activity: the date range fits and the page stays under 1,500 DOM nodes', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('inventory-activity'), 'MOBILE_GATE_ROUTES does not select inventory-activity');
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  await stubGet(page, '/api/inventory/items', () => ({ data: ITEMS, meta: { page: 1, limit: 100, total: ITEMS.length, totalPages: 1 } }));
  await stubGet(page, '/api/inventory/movements', movements);
  try {
    await open(page, '/inventory/activity', notes);
    // The list's own footer says "Showing 1-25 of 600" (it said "600 total" before the kit table).
    await expect(page.getByText(new RegExp(`Showing\\s+\\S+\\s+of\\s+${MOVEMENT_TOTAL}\\b`)).first()).toBeVisible({ timeout: 20_000 });
    const reading: Record<string, { width: number; clippedBy: string[] }> = {};
    for (const label of ['From date', 'To date']) {
      const field = page.getByLabel(label, { exact: true }).first();
      await expect(field).toBeVisible();
      reading[label] = { width: (await field.boundingBox())!.width, clippedBy: await field.evaluate(clippedBy) };
    }
    const nodes = await domNodes(page);
    await testInfo.attach('activity.json', { body: JSON.stringify({ device: device.id, reading, nodes, notes }, null, 1), contentType: 'application/json' });
    for (const [label, r] of Object.entries(reading)) {
      expect(r.clippedBy, `${label} is cut off by`).toEqual([]);
      expect(r.width, `${label} keeps room for a date`).toBeGreaterThanOrEqual(120);
    }
    expect(nodes, 'DOM nodes on /inventory/activity').toBeLessThan(DOM_BUDGET);
  } finally {
    await keepSession(page, session);
  }
});

// --- inventory staging -----------------------------------------------------------------------

const STAGE_COUNT = 60;
const STAGE_SITE = (i: number) => `${100 + i} Industrial Parkway, Building C`;
const STAGES = Array.from({ length: STAGE_COUNT }, (_, i) => ({
  id: uuid(35, i),
  jobNumber: `J-9${String(i).padStart(3, '0')}`,
  customer: `Northside Property Group ${i + 1}`,
  site: STAGE_SITE(i),
  trade: 'door',
  status: (['awaiting', 'partial', 'complete', 'ready_for_pickup'] as const)[i % 4],
  items: [
    { id: uuid(36, i), itemSku: 'SKU-0001', itemName: 'Stock item number 1', vendor: 'Sample Supply Co', poNumber: `PO-9${String(i).padStart(3, '0')}`, qtyOrdered: 4, qtyReceived: i % 5, uom: 'EA', serialized: false },
  ],
  createdAt: now,
}));

test('inventory staging: stages are paged and the progress column leaves the site line room', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('inventory-staging'), 'MOBILE_GATE_ROUTES does not select inventory-staging');
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  await stubGet(page, '/api/inventory/job-stages', () => ({ jobStages: STAGES }));
  try {
    await open(page, '/inventory/staging', notes);
    const jobNumbers = page.getByText(/^J-9\d{3}$/);
    await expect(jobNumbers.first()).toBeVisible({ timeout: 20_000 });
    const shown = await jobNumbers.count();
    const site = page.getByText(STAGE_SITE(0), { exact: true }).first();
    const siteWidth = (await site.boundingBox())!.width;
    const siteClipped = await site.evaluate(clippedBy);
    const nodes = await domNodes(page);
    await testInfo.attach('staging.json', { body: JSON.stringify({ device: device.id, shown, siteWidth, siteClipped, nodes, notes }, null, 1), contentType: 'application/json' });

    expect(shown, 'stage cards on screen before "Show more"').toBeGreaterThan(0);
    expect(shown, 'stage cards on screen before "Show more"').toBeLessThanOrEqual(20);
    expect(siteClipped, 'the site line is cut off by').toEqual([]);
    expect(siteWidth, "the site line is readable beside the progress column").toBeGreaterThanOrEqual(150);

    const more = page.getByRole('button', { name: /^Show more/ });
    await expect(more).toBeVisible();
    await (device.touch ? tap(more) : more.click());
    await expect.poll(() => jobNumbers.count(), { message: '"Show more" adds the next stages' }).toBeGreaterThan(shown);
  } finally {
    await keepSession(page, session);
  }
});

// --- service plans -----------------------------------------------------------------------------

const PLAN_COUNT = 120;
const PLANS = Array.from({ length: PLAN_COUNT }, (_, i) => ({
  id: uuid(37, i),
  service_plan_number: `SP-9${String(i).padStart(3, '0')}`,
  customer_id: uuid(38, i),
  service_location_id: uuid(39, i),
  name: 'Annual maintenance',
  status: 'ACTIVE',
  visit_cadence: 'QUARTERLY',
  interval_unit: 'MONTH',
  interval_count: 3,
  byweekday: [],
  occurrence_count: null,
  start_date: now,
  end_date: null,
  contract_price: '1200.00',
  sold_by: null,
  renewals_count: 0,
  template_id: null,
  line_items: [],
  visits: [],
  customer: { id: uuid(38, i), company_name: `Lakeview Apartments ${i + 1}`, first_name: null, last_name: null },
  service_location: { id: uuid(39, i), address_line1: `${200 + i} Harbor Road`, city: 'Springfield', state: 'IL' },
  planned_visit_count: null,
  visits_remaining: null,
  next_due: now,
  due_soon: false,
  overdue: false,
  emphasized: false,
  effective_status: 'ACTIVE',
}));

test('service plans: the list is paged and the page never scrolls sideways', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('service-plans'), 'MOBILE_GATE_ROUTES does not select service-plans');
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  await stubGet(page, '/api/service-plans', () => ({ servicePlans: PLANS }));
  try {
    await open(page, '/service-plans', notes);
    const planNumbers = page.getByText(/^SP-9\d{3}$/);
    await expect(planNumbers.first()).toBeVisible({ timeout: 20_000 });
    const shown = await planNumbers.count();
    const scroll = await page.evaluate(() => ({ page: document.documentElement.scrollWidth, viewport: document.documentElement.clientWidth }));
    const nodes = await domNodes(page);
    await testInfo.attach('service-plans.json', { body: JSON.stringify({ device: device.id, shown, scroll, nodes, notes }, null, 1), contentType: 'application/json' });

    expect(shown, 'plans on screen at once').toBeLessThanOrEqual(25);
    expect(scroll.page, 'the page itself never scrolls sideways').toBeLessThanOrEqual(scroll.viewport);
    const next = page.getByRole('button', { name: /next page/i }).first();
    await expect(next).toBeVisible();
    await (device.touch ? tap(next) : next.click());
    await expect(page.getByText('SP-9025', { exact: true }).first()).toBeVisible();
  } finally {
    await keepSession(page, session);
  }
});

test('service plans: a plan line keeps its Description readable below sm', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('service-plans'), 'MOBILE_GATE_ROUTES does not select service-plans');
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  try {
    await open(page, '/service-plans', notes);
    const newPlan = page.getByRole('button', { name: 'New Plan' });
    await (device.touch ? tap(newPlan) : newPlan.click());
    const description = page.getByRole('textbox', { name: 'Line item 1 description' });
    await expect(description).toBeVisible({ timeout: 15_000 });
    // The dialog zooms in as it opens; measure the settled layout, not a frame of the animation.
    await page.waitForFunction(() => document.getAnimations().every((a) => a.playState !== 'running'), null, { timeout: 5_000 }).catch(() => {});
    await page.waitForTimeout(300);
    const qty = page.getByRole('textbox', { name: 'Line item 1 quantity' });
    const d = (await description.boundingBox())!;
    const q = (await qty.boundingBox())!;
    const clipped = await description.evaluate(clippedBy);
    const viewport = page.viewportSize()!.width;
    await testInfo.attach('plan-line.json', { body: JSON.stringify({ device: device.id, viewport, d, q, clipped, notes }, null, 1), contentType: 'application/json' });

    expect(clipped, 'Description is cut off by').toEqual([]);
    if (viewport < 640) {
      expect(d.width, 'below sm the Description has room for words').toBeGreaterThanOrEqual(200);
      expect(q.y, 'below sm Qty sits under the Description').toBeGreaterThanOrEqual(d.y + d.height - 1);
    } else {
      const sameRow = q.y < d.y + d.height && q.y + q.height > d.y && q.x > d.x + d.width - 1;
      expect(sameRow, 'from sm up Qty sits beside the Description, on its row').toBe(true);
    }
  } finally {
    await keepSession(page, session);
  }
});
