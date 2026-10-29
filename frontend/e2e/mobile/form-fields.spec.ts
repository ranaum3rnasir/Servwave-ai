/**
 * Mobile slice 20 (CMP-18, user story 135): forms are one column at phone width.
 *
 * On the job form, the visit dialog, Add Item, and the lead and customer forms, with every
 * optional section opened (address fields, the schedule, the billing address, a one-off visit
 * address, a new line item):
 *
 * - below `sm` (the phone-portrait projects: 320, 360 and 393 px), no two fields share a row, and
 *   every field is at least FIELD_FLOOR px wide;
 * - from `sm` up (landscape phone, iPad, the desktop control), the rows that were multi-column
 *   still are (City/State/ZIP, Address/Unit, the four money fields, date beside time), so the
 *   wider layouts did not change.
 *
 * Read-only: it opens forms and dialogs and never saves. Runs with the gate (same projects, same
 * session slots). MOBILE_GATE_ROUTES selects it by the route it opens: `job-new`, `lead-new`,
 * `customer-new`, `job-detail` (visit dialog and Add Item).
 */
import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'fs';
import { gateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

/** Tailwind's `sm` breakpoint: below it, form grids are one column. */
const SM = 640;
/** The narrowest a field may be below `sm`. Before slice 20 the squeezed fields measured 37-114 px. */
const FIELD_FLOOR = 120;

/**
 * Fields that sit beside their partner by design and are measured with it: a phone number's
 * extension is part of the number and is never split from it (PickOrCreateCustomer, pickCustomer).
 */
const PAIRED_WITH_PREVIOUS = new Set(['Ext']);

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

interface Box { name: string; x: number; y: number; w: number; h: number }

/** Every visible text entry or choice control inside `root`, with a readable name. */
async function fieldBoxes(root: Locator): Promise<Box[]> {
  return root.evaluate((el) => {
    const SELECTOR = [
      'input:not([type=checkbox]):not([type=radio]):not([type=hidden]):not([type=file]):not([type=range]):not([type=submit]):not([type=button])',
      'textarea',
      'select',
      '[role=combobox]',
    ].join(',');
    const out: Box[] = [];
    const seen = new Set<Element>();
    for (const f of el.querySelectorAll(SELECTOR)) {
      // A combobox input inside a combobox wrapper is one field.
      const owner = f.parentElement?.closest('[role=combobox]');
      const node = owner && el.contains(owner) ? owner : f;
      if (seen.has(node)) continue;
      seen.add(node);
      if (node.closest('[aria-hidden="true"]')) continue;
      const r = node.getBoundingClientRect();
      const cs = getComputedStyle(node);
      if (r.width < 2 || r.height < 2 || cs.visibility === 'hidden' || cs.display === 'none') continue;
      const id = node.getAttribute('id');
      const label = id ? document.querySelector(`label[for="${CSS.escape(id)}"]`)?.textContent?.trim() : undefined;
      // A required field's label ends in an asterisk ("City *"); the field is still "City".
      const raw = label || node.getAttribute('aria-label') || node.getAttribute('placeholder') || id || node.tagName.toLowerCase();
      const name = raw.replace(/\s*\*\s*$/, '');
      out.push({ name, x: r.left, y: r.top, w: r.width, h: r.height });
    }
    return out;
  });
}

/** Pairs of fields that sit side by side (overlapping rows, separate columns). */
function sideBySide(boxes: Box[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < boxes.length; i++) {
    for (let j = i + 1; j < boxes.length; j++) {
      const a = boxes[i]!;
      const b = boxes[j]!;
      const rowOverlap = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
      const columnsApart = a.x + a.w <= b.x + 1 || b.x + b.w <= a.x + 1;
      if (rowOverlap > Math.min(a.h, b.h) / 2 && columnsApart) out.push(`"${a.name}" beside "${b.name}"`);
    }
  }
  return out;
}

/**
 * Below sm: one column, every field at least FIELD_FLOOR wide. From sm up: each row in
 * `wideRows` still sits on one line.
 */
async function expectFormLayout(page: Page, root: Locator, label: string, wideRows: string[][]) {
  const width = page.viewportSize()!.width;
  const boxes = (await fieldBoxes(root)).filter((b) => !PAIRED_WITH_PREVIOUS.has(b.name));
  expect(boxes.length, `${label}: found no fields to measure`).toBeGreaterThan(2);
  if (width < SM) {
    expect(sideBySide(boxes), `${label}: fields share a row at ${width} px`).toEqual([]);
    const narrow = boxes.filter((b) => b.w < FIELD_FLOOR).map((b) => `"${b.name}" ${Math.round(b.w)} px`);
    expect(narrow, `${label}: fields narrower than ${FIELD_FLOOR} px at ${width} px`).toEqual([]);
    return;
  }
  for (const row of wideRows) {
    const tops = row.map((name) => {
      const b = boxes.find((x) => x.name === name);
      expect(b, `${label}: field "${name}" not found (have: ${boxes.map((x) => x.name).join(', ')})`).toBeTruthy();
      return Math.round(b!.y);
    });
    expect(new Set(tops).size, `${label}: ${row.join(' / ')} should share one row at ${width} px (tops ${tops.join(', ')})`).toBe(1);
  }
}

function run(stateId: string, title: string, body: (a: { page: Page; touch: boolean }) => Promise<void>) {
  test(title, async ({ page, session }, testInfo) => {
    test.skip(!selected.has(stateId), `MOBILE_GATE_ROUTES does not select ${stateId}`);
    const device = gateDevice(testInfo.project.name);
    await signIn(page, session, []);
    try {
      await body({ page, touch: device.touch });
    } finally {
      await keepSession(page, session).catch(() => {});
    }
  });
}

async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
}

/** Pick an option of a kit SelectField (a Radix select) by its visible text. */
async function choose(page: Page, touch: boolean, trigger: Locator, option: string) {
  await press(touch, trigger);
  await press(touch, page.getByRole('option', { name: option }));
}

run('job-new', 'job form: one column below sm (address, City/State/ZIP, type/source, schedule)', async ({ page, touch }) => {
  await open(page, '/jobs/new');
  const form = page.locator('form').first();
  await expect(form.locator('#service_city')).toBeVisible({ timeout: 20_000 });
  const schedule = page.getByRole('switch', { name: 'Schedule this job now' });
  if ((await schedule.getAttribute('aria-checked')) !== 'true') await press(touch, schedule);
  await expect(form.locator('#job-start-date')).toBeVisible();
  await expectFormLayout(page, form, 'job form', [
    ['Address', 'Unit'],
    ['City', 'State', 'ZIP'],
    ['Job Type', 'Source'],
    ['Start date', 'Start time'],
    ['End date', 'End time'],
  ]);
});

run('lead-new', 'lead form: one column below sm (address, City/State/ZIP, walkthrough schedule)', async ({ page, touch }) => {
  await open(page, '/leads/new');
  const form = page.locator('form').first();
  await expect(form.getByLabel(/^City/)).toBeVisible({ timeout: 20_000 });
  const schedule = page.getByRole('switch', { name: 'Schedule walkthrough' });
  if ((await schedule.getAttribute('aria-checked')) !== 'true') await press(touch, schedule);
  await expect(form.locator('#v2-start-date')).toBeVisible();
  await expectFormLayout(page, form, 'lead form', [
    ['Address', 'Unit'],
    ['Start Date', 'Start Time'],
    ['End Date', 'End Time'],
  ]);
});

run('customer-new', 'customer form: one column below sm (service and billing City/State/ZIP)', async ({ page, touch }) => {
  await open(page, '/customers/new');
  const form = page.getByTestId('customer-form');
  await expect(form.getByPlaceholder('City').first()).toBeVisible({ timeout: 20_000 });
  await press(touch, form.getByRole('button', { name: 'Use a different billing address' }));
  await expect(form.getByPlaceholder('City')).toHaveCount(2);
  await expectFormLayout(page, form, 'customer form', [['City', 'State', 'ZIP']]);
});

run('job-detail', 'visit dialog: date and time, and a one-off address, one column below sm', async ({ page, touch }) => {
  await open(page, `/jobs/${fixtures().jobId}`);
  await press(touch, page.getByRole('tab', { name: 'Visits' }));
  await press(touch, page.getByRole('button', { name: 'Add visit' }));
  const dialog = page.getByRole('dialog', { name: 'Add Visit' });
  await expect(dialog).toBeVisible();
  await choose(page, touch, dialog.getByRole('combobox', { name: 'Location' }), 'Other…');
  await expect(dialog.getByLabel('Address')).toBeVisible();
  await expectFormLayout(page, dialog, 'visit dialog', [
    ['Start date', 'Start time'],
    ['End date', 'End time'],
    ['Address', 'Unit'],
  ]);
  await page.keyboard.press('Escape');
});

run('job-detail', 'Add Item: the four money fields and the type row, one column below sm', async ({ page, touch }) => {
  await open(page, `/jobs/${fixtures().jobId}`);
  await press(touch, page.getByRole('tab', { name: 'Items' }));
  await press(touch, page.getByRole('button', { name: 'Add item' }).first());
  const dialog = page.getByRole('dialog', { name: 'Add line item' });
  await expect(dialog).toBeVisible();
  await dialog.getByPlaceholder('Search the price book, or type a new item…').fill('Gate form-width item');
  await press(touch, dialog.getByRole('button', { name: /Add new item:/ }));
  await expect(dialog.locator('#new-price')).toBeVisible();
  await expectFormLayout(page, dialog, 'Add Item', [['Quantity', 'Price ($)', 'Markup %', 'Unit cost ($)']]);
  await page.keyboard.press('Escape');
});
