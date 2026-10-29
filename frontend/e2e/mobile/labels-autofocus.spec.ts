/**
 * Mobile slice 24 (KB-08, KB-10): labelled fields, and no keyboard popping up on touch.
 *
 * - `settings-company`, `settings-profile`, `settings-locations` (branch editor open): every label
 *   the page draws is bound to a control (`HTMLLabelElement.control`), on every project.
 * - `lead-new`, `job-new`, `invoice-new`: the customer block has no "Search..." placeholder; the
 *   First name, Phone, Email and Company boxes are named by their labels, carry their own
 *   placeholder, and are described as finding an existing customer.
 * - `tasks` (New task dialog, then its Category search popover) and `job-detail` (Add item
 *   dialog): on the touch projects opening the dialog or the search popover leaves no text field
 *   focused, and focus is inside the surface; on the desktop control the first field is focused,
 *   as before.
 *
 * Every touch project is first checked to report a coarse primary pointer (and the desktop control
 * a fine one), so a device that did not emulate the pointer cannot pass the touch half by accident.
 * Runs with the gate (same projects, same session slots); MOBILE_GATE_ROUTES selects it by the
 * route it opens. It writes nothing: no dialog is submitted.
 */
import { expect, type Page } from '@playwright/test';
import fs from 'fs';
import { gateDevice, type GateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

async function open(page: Page, path: string, notes: string[]) {
  await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, notes);
}

async function expectPointer(page: Page, device: GateDevice) {
  const coarse = await page.evaluate(() => window.matchMedia('(pointer: coarse)').matches);
  expect(coarse, `${device.id} reports a ${device.touch ? 'coarse' : 'fine'} primary pointer`).toBe(device.touch);
}

/**
 * What has focus: its tag, its id, its name (aria-label, else placeholder, else id), whether it
 * opens a keyboard, and whether `scope` contains it. `id` is kept apart from `label` so a test can
 * pin the exact field: a placeholder can change wording, and two fields can share one.
 */
function focusState(page: Page, scopeSelector: string) {
  return page.evaluate((sel) => {
    const el = document.activeElement as HTMLElement | null;
    const nonText = ['button', 'checkbox', 'radio', 'range', 'color', 'file', 'submit', 'reset', 'image'];
    const textEntry =
      !!el &&
      (el.tagName === 'TEXTAREA' || el.isContentEditable || (el.tagName === 'INPUT' && !nonText.includes((el as HTMLInputElement).type)));
    const scopes = [...document.querySelectorAll(sel)];
    return {
      tag: el?.tagName ?? null,
      id: el?.id ?? '',
      label: el?.getAttribute('aria-label') ?? el?.getAttribute('placeholder') ?? el?.id ?? '',
      textEntry,
      inside: !!el && scopes.some((s) => s.contains(el)),
    };
  }, scopeSelector);
}

const tapOrClick = (device: GateDevice) => (loc: ReturnType<Page['locator']>) => press(device.touch, loc, { timeout: 15_000 });

test.describe('labelled fields (mobile slice 24)', () => {
  const SETTINGS: Array<[string, string]> = [
    ['settings-company', '/settings/company'],
    ['settings-profile', '/settings/profile'],
    ['settings-locations', '/settings/locations'],
  ];
  for (const [id, path] of SETTINGS) {
    test(`${id}: every label is bound to its control`, async ({ page, session }, testInfo) => {
      test.skip(!selected.has(id), `${id} not selected`);
      const device = gateDevice(testInfo.project.name);
      const notes: string[] = [];
      await signIn(page, session, notes);
      try {
        await open(page, path, notes);
        if (id === 'settings-locations') {
          await tapOrClick(device)(page.locator('main').getByRole('button', { name: /new location/i }));
          await expect(page.locator('main').getByText('New Branch')).toBeVisible();
        }
        const labels = await page.locator('main label').evaluateAll((els) =>
          els
            .filter((l) => (l as HTMLElement).getClientRects().length > 0)
            .map((l) => ({ text: (l.textContent ?? '').trim(), bound: (l as HTMLLabelElement).control !== null })),
        );
        expect(labels.length, `${id} draws labels`).toBeGreaterThan(id === 'settings-company' ? 20 : 4);
        expect(labels.filter((l) => !l.bound).map((l) => l.text), `unbound labels on ${id}`).toEqual([]);
      } finally {
        await keepSession(page, session);
      }
    });
  }

  const CUSTOMER_FORMS: Array<[string, string]> = [
    ['lead-new', '/leads/new'],
    ['job-new', '/jobs/new'],
    ['invoice-new', '/invoices/new'],
  ];
  for (const [id, path] of CUSTOMER_FORMS) {
    test(`${id}: the customer block's boxes are named for what they hold`, async ({ page, session }) => {
      test.skip(!selected.has(id), `${id} not selected`);
      const notes: string[] = [];
      await signIn(page, session, notes);
      try {
        await open(page, path, notes);
        const main = page.locator('main');
        await expect(main.getByLabel(/^First Name/).first()).toBeVisible();
        expect(await main.locator('input[placeholder="Search..."]').count(), 'no "Search..." boxes').toBe(0);
        const boxes: Array<[RegExp, string]> = [
          [/^First Name/, 'First name'],
          [/^Last Name/, 'Last name'],
          [/^Phone$/, 'Phone number'],
          [/^Email$/, 'Email address'],
          [/^Company Name$/, 'Company name'],
        ];
        for (const [name, placeholder] of boxes) {
          const box = main.getByRole('textbox', { name }).first();
          await expect(box, `${name}`).toHaveAttribute('placeholder', placeholder);
          await expect(box, `${name} is described`).toHaveAccessibleDescription(/existing customer/i);
        }
      } finally {
        await keepSession(page, session);
      }
    });
  }
});

test.describe('no keyboard popping up on touch (mobile slice 24)', () => {
  test('tasks: the New task dialog and its Category search popover', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('tasks'), 'tasks not selected');
    const device = gateDevice(testInfo.project.name);
    const tap = tapOrClick(device);
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      await open(page, '/tasks', notes);
      await expectPointer(page, device);
      await tap(page.locator('main').getByRole('button', { name: /^\s*\+?\s*New/ }).first());
      const dialog = page.getByRole('dialog', { name: 'New Task' });
      await expect(dialog).toBeVisible();
      await page.waitForTimeout(500);
      const onOpen = await focusState(page, '[role="dialog"]');
      if (device.touch) {
        expect(onOpen.textEntry, `focus on open on ${device.id}: ${JSON.stringify(onOpen)}`).toBe(false);
        expect(onOpen.inside, 'focus is inside the dialog').toBe(true);
      } else {
        expect(onOpen, 'the desktop control focuses the title').toMatchObject({ tag: 'INPUT', textEntry: true });
        // The Title box, by its id: `label` holds its placeholder ("Task title"), not the id (F24a).
        expect(onOpen.id, `the focused field on open: ${JSON.stringify(onOpen)}`).toBe('task-title');
      }

      await tap(dialog.getByRole('combobox', { name: 'Category' }));
      // Below md (and on the landscape phone) a searchable picker is a full-screen sheet, not a popover
      // (mobile slice 44); the rule is the same for both: no text field takes focus on its own on touch.
      const pickerSel = '[data-slot="popover-content"], [data-picker="fullscreen"]';
      const panel = page.locator(pickerSel).last();
      await expect(panel).toBeVisible();
      await page.waitForTimeout(400);
      const onPopover = await focusState(page, pickerSel);
      if (device.touch) {
        expect(onPopover.textEntry, `focus in the popover on ${device.id}: ${JSON.stringify(onPopover)}`).toBe(false);
      } else {
        expect(onPopover, 'the desktop control focuses the search field').toMatchObject({ textEntry: true, inside: true });
      }
    } finally {
      await keepSession(page, session);
    }
  });

  test('job-detail: the Add item dialog', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('job-detail'), 'job-detail not selected');
    const device = gateDevice(testInfo.project.name);
    const tap = tapOrClick(device);
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      await open(page, `/jobs/${fixtures().jobId}`, notes);
      await expectPointer(page, device);
      await tap(page.getByRole('tab', { name: 'Items' }));
      const add = page.getByRole('button', { name: 'Add item' }).first();
      await add.waitFor({ state: 'visible', timeout: 15_000 });
      await tap(add);
      const dialog = page.getByRole('dialog', { name: 'Add line item' });
      await expect(dialog).toBeVisible();
      await page.waitForTimeout(500);
      const state = await focusState(page, '[role="dialog"]');
      if (device.touch) {
        expect(state.textEntry, `focus on open on ${device.id}: ${JSON.stringify(state)}`).toBe(false);
        expect(state.inside, 'focus is inside the dialog').toBe(true);
      } else {
        expect(state, 'the desktop control focuses the price-book search').toMatchObject({ tag: 'INPUT', label: 'Search the price book' });
      }
    } finally {
      await keepSession(page, session);
    }
  });
});
