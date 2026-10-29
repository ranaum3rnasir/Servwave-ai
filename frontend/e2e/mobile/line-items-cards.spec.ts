/**
 * Mobile slice 59 (PRD story 127, rubric CMP-01 / TOUCH-10 / VP-10): the line-items editor on a
 * phone, and the statement page.
 *
 * Per device it works on a FRESH sent estimate in the throwaway org (never the shared key-route
 * one: it reorders and edits it), through the real editor and the real API:
 *
 *  - below md (iPhone SE 320, Galaxy S24 360, iPhone 15 393): every line is a card, there is no
 *    table, the page and each card stay inside the screen (no sideways scroll), each control is a
 *    44 px target, a line can be edited and added, and Move down / Move up change the order and
 *    keep it across a reload (the same order a drag saves);
 *  - from md up (landscape phone 838, iPad Mini 768, desktop 1280): the table is as it was, with
 *    its drag handles and no cards and no Move buttons.
 *
 * It also checks the statement page: a stacked list below md, the table from md up, nothing
 * wider than the screen. Statement figures come from the shared key-route customer (read-only).
 *
 * Runs on the six device projects with the gate; MOBILE_GATE_ROUTES selects it by the state it
 * opens (`estimate-detail`, `customer-statement`). How to run: ./README.md.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'fs';
import { ApiClient } from '../helpers/api-client';
import { gateDevice, type GateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { sentEstimate } from './seed';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

/** md is 768: a width below it gets cards. */
const isPhone = (page: Page) => (page.viewportSize()?.width ?? 0) < 768;

const cards = (page: Page) => page.getByTestId('line-item-card');
const rows = (page: Page) => page.getByTestId('line-item-row');

/** The lines' names, top to bottom, read from each card's (or row's) drag handle. */
async function lineNames(page: Page): Promise<string[]> {
  // CSS, not roles: while a dialog is closing the page behind it is still aria-hidden.
  const handles = page.locator('button[aria-label^="Drag to reorder "]');
  const labels = await handles.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? ''));
  return labels.map((l) => l.replace(/^Drag to reorder /, ''));
}

async function openEstimate(page: Page, notes: string[], estimateId: string) {
  await page.goto(`/estimates/${estimateId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, notes);
  // The line items sit below the receipt; wait for the editor's own marker.
  await page.getByRole('button', { name: /^Drag to reorder / }).first().waitFor({ state: 'visible', timeout: 30_000 });
}

/** Nothing in the document, and nothing in the phone cards, reaches past the screen's edges. */
async function expectNoSidewaysScroll(page: Page, label: string) {
  const r = await page.evaluate(() => {
    const w = window.innerWidth;
    // Only the phone cards have to fit the screen: from md up the table scrolls inside its own box.
    const editor = document.querySelector('[data-testid="line-item-cards"]');
    const past: string[] = [];
    if (editor) {
      for (const el of editor.querySelectorAll('*')) {
        const b = el.getBoundingClientRect();
        if (b.width > 0 && (b.right > w + 0.5 || b.left < -0.5)) {
          past.push(`${el.tagName.toLowerCase()}${el.getAttribute('aria-label') ? `[${el.getAttribute('aria-label')}]` : ''} ${Math.round(b.left)}..${Math.round(b.right)}`);
        }
        if (past.length >= 5) break;
      }
    }
    return { docWidth: document.documentElement.scrollWidth, w, past };
  });
  expect(r.docWidth, `${label}: the document is no wider than the screen`).toBeLessThanOrEqual(r.w);
  expect(r.past, `${label}: nothing in the line items runs past an edge`).toEqual([]);
}

async function expectTouchTarget(loc: Locator, label: string) {
  const b = (await loc.boundingBox())!;
  expect(b, `${label} is on screen`).not.toBeNull();
  expect(b.height, `${label} height`).toBeGreaterThanOrEqual(44 - 0.5);
  expect(b.width, `${label} width`).toBeGreaterThanOrEqual(44 - 0.5);
}

const reorderResponse = (page: Page) =>
  page.waitForResponse((r) => /\/line-items\/reorder/.test(r.url()) && r.request().method() !== 'GET' && r.ok(), { timeout: 20_000 });
const lineWrite = (page: Page) =>
  page.waitForResponse((r) => /\/line-items/.test(r.url()) && r.request().method() !== 'GET' && r.ok(), { timeout: 20_000 });

test.describe('line items on a phone (mobile slice 59)', () => {
  test('estimate-detail: cards below md, the table from md up; edit, add, Move up/down', async ({ page, session }, info) => {
    test.skip(!selected.has('estimate-detail'), 'estimate-detail not selected');
    test.setTimeout(240_000);
    const device: GateDevice = gateDevice(info.project.name);
    const notes: string[] = [];
    const api = await new ApiClient().init();
    let estimateId: string;
    try {
      estimateId = (await sentEstimate(api, fixtures().techId)).estimateId;
    } finally {
      await api.dispose();
    }
    await signIn(page, session, notes);
    try {
      await openEstimate(page, notes, estimateId);
      const tap = (loc: Locator) => press(device.touch, loc, { timeout: 15_000 });

      if (!isPhone(page)) {
        // md and up: the table as it was.
        await expect(page.locator('table').filter({ has: rows(page).first() })).toBeVisible();
        expect(await cards(page).count(), 'no cards from md up').toBe(0);
        expect(await rows(page).count(), 'a row per line').toBe(2);
        expect(await page.getByRole('button', { name: /^Move .* (up|down)$/ }).count(), 'no Move buttons on the table').toBe(0);
        expect(await page.getByRole('button', { name: /^Drag to reorder / }).count(), 'the drag handles stay').toBe(2);
        return;
      }

      // ---- phone: cards ----
      await expect(cards(page)).toHaveCount(2);
      expect(await page.locator('table').filter({ has: page.getByText('Selling price') }).count(), 'no line-items table').toBe(0);
      expect(await lineNames(page)).toEqual(['Service call', 'Replacement part']);
      await expectNoSidewaysScroll(page, 'cards');

      const first = cards(page).nth(0);
      // The toolbar: the drag handle, Move up and Move down side by side, each a 44 px target.
      const handle = first.getByRole('button', { name: 'Drag to reorder Service call' });
      const down = first.getByRole('button', { name: 'Move Service call down' });
      const up = first.getByRole('button', { name: 'Move Service call up' });
      await handle.scrollIntoViewIfNeeded();
      for (const [name, loc] of [['drag handle', handle], ['Move down', down], ['Move up', up]] as const) await expectTouchTarget(loc, name);
      const [hb, ub, db] = [await handle.boundingBox(), await up.boundingBox(), await down.boundingBox()];
      expect(Math.abs(hb!.y - ub!.y), 'Move up is beside the handle').toBeLessThan(4);
      expect(Math.abs(hb!.y - db!.y), 'Move down is beside the handle').toBeLessThan(4);
      await expect(up, 'the first line cannot go up').toBeDisabled();

      // Every field is a 44 px control.
      for (const name of ['Quantity for Service call', 'Selling price for Service call']) {
        await expectTouchTarget(first.getByRole('textbox', { name }), name);
      }

      // ---- edit: the selling price, saved on blur, kept across a reload ----
      const price = first.getByRole('textbox', { name: 'Selling price for Service call' });
      const saved = lineWrite(page);
      await price.fill('199.5');
      await price.blur();
      await saved;
      await page.reload({ waitUntil: 'domcontentloaded' });
      await settle(page, notes);
      await cards(page).first().waitFor({ state: 'visible', timeout: 30_000 });
      await expect(cards(page).first().getByRole('textbox', { name: 'Selling price for Service call' })).toHaveValue('199.5');

      // ---- add: a new line through the shared dialog ----
      await tap(page.getByRole('button', { name: 'Add item' }).first());
      const dialog = page.getByRole('dialog', { name: 'Add line item' });
      await dialog.waitFor({ state: 'visible', timeout: 15_000 });
      await dialog.getByPlaceholder('Search the price book, or type a new item…').fill('Gate added line');
      await tap(dialog.getByRole('button', { name: /Add new item:/ }));
      await dialog.locator('#new-price').fill('25');
      const added = lineWrite(page);
      await tap(dialog.getByRole('button', { name: 'Add item' }).last());
      await added;
      await expect(cards(page)).toHaveCount(3, { timeout: 20_000 });
      expect(await lineNames(page)).toEqual(['Service call', 'Replacement part', 'Gate added line']);
      await expectNoSidewaysScroll(page, 'cards after an add');

      // ---- Move down / Move up: the order changes and survives a reload ----
      const moved = reorderResponse(page);
      await tap(cards(page).nth(0).getByRole('button', { name: 'Move Service call down' }));
      await moved;
      expect(await lineNames(page), 'Move down swaps with the next line').toEqual(['Replacement part', 'Service call', 'Gate added line']);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await settle(page, notes);
      await cards(page).first().waitFor({ state: 'visible', timeout: 30_000 });
      expect(await lineNames(page), 'the order is kept after a reload').toEqual(['Replacement part', 'Service call', 'Gate added line']);

      const movedUp = reorderResponse(page);
      await tap(cards(page).nth(2).getByRole('button', { name: 'Move Gate added line up' }));
      await movedUp;
      expect(await lineNames(page), 'Move up swaps with the previous line').toEqual(['Replacement part', 'Gate added line', 'Service call']);
      await page.reload({ waitUntil: 'domcontentloaded' });
      await settle(page, notes);
      await cards(page).first().waitFor({ state: 'visible', timeout: 30_000 });
      expect(await lineNames(page), 'the second move is kept after a reload').toEqual(['Replacement part', 'Gate added line', 'Service call']);
      await expect(cards(page).first().getByRole('button', { name: /^Move .* up$/ }), 'the first line cannot go up').toBeDisabled();
      await expect(cards(page).last().getByRole('button', { name: /^Move .* down$/ }), 'the last line cannot go down').toBeDisabled();
      await expectNoSidewaysScroll(page, 'cards after moves');
    } finally {
      await keepSession(page, session);
    }
  });

  test('job-detail: the Items tab shows cards below md and the table from md up, inside the screen', async ({ page, session }, info) => {
    test.skip(!selected.has('job-detail'), 'job-detail not selected');
    const device: GateDevice = gateDevice(info.project.name);
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      await page.goto(`/jobs/${fixtures().jobId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      await press(device.touch, page.getByRole('tab', { name: 'Items' }), { timeout: 15_000 });
      if (isPhone(page)) {
        await expect(page.getByTestId('line-item-cards')).toBeVisible({ timeout: 20_000 });
        expect(await cards(page).count(), 'a card per job line').toBeGreaterThan(0);
        expect(await rows(page).count(), 'no table rows on a phone').toBe(0);
      } else {
        await expect(rows(page).first()).toBeVisible({ timeout: 20_000 });
        expect(await cards(page).count(), 'no cards from md up').toBe(0);
      }
      await expectNoSidewaysScroll(page, 'job items');
    } finally {
      await keepSession(page, session);
    }
  });

  test('customer-statement: a stacked list below md, the table from md up, nothing wider than the screen', async ({ page, session }) => {
    test.skip(!selected.has('customer-statement'), 'customer-statement not selected');
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      await page.goto(`/customers/${fixtures().customerId}/statement`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      await expect(page.getByTestId('statement-page')).toBeVisible();
      const w = await page.evaluate(() => ({ doc: document.documentElement.scrollWidth, win: window.innerWidth }));
      expect(w.doc, 'the statement is no wider than the screen').toBeLessThanOrEqual(w.win);
      if (isPhone(page)) {
        const list = page.getByRole('list', { name: 'Statement activity' });
        await expect(list).toBeVisible();
        expect(await list.getByRole('listitem').count(), 'the ledger has entries').toBeGreaterThan(0);
        expect(await page.getByTestId('statement-page').locator('table').count(), 'no table on a phone').toBe(0);
        const past = await list.evaluate((el) => {
          const w = window.innerWidth;
          return [...el.querySelectorAll('*')].filter((e) => { const b = e.getBoundingClientRect(); return b.width > 0 && (b.right > w + 0.5 || b.left < -0.5); }).length;
        });
        expect(past, 'no ledger entry runs past the screen').toBe(0);
      } else {
        await expect(page.getByTestId('statement-page').locator('table')).toBeVisible();
        expect(await page.getByRole('list', { name: 'Statement activity' }).count(), 'no stacked list from md up').toBe(0);
      }
    } finally {
      await keepSession(page, session);
    }
  });
});
