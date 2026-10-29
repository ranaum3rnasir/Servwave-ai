/**
 * Mobile slice 37 (KB-04): money and quantity fields have the decimal keypad, no spinner and no
 * scroll-to-change.
 *
 * - `job-detail~addItem`: Add Item's new-item form (Quantity, Selling price, Markup %, Unit cost).
 * - `invoice-detail`: the Record Payment dialog's Amount.
 *
 * On every device: the open dialog holds no number input; each field is a text input with the
 * decimal keypad; typing "1,250.5" shows "1250.5" (thousands commas dropped, the point kept).
 * On the desktop control, the case a number input got wrong: with the field focused and the
 * pointer over it, the mouse wheel and the arrow keys leave the amount alone.
 *
 * Runs with the gate (same projects, same session slots); MOBILE_GATE_ROUTES selects it by the
 * state it opens. It writes nothing: each dialog is closed with Escape, nothing is submitted.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import fs from 'fs';
import { gateDevice } from './devices';
import { settle } from './measure';
import { openOverlay } from './openers';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test } from './session';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

const attrs = (l: Locator) =>
  l.evaluate((el) => ({ type: el.getAttribute('type'), inputmode: el.getAttribute('inputmode'), step: el.getAttribute('step') }));

const DECIMAL = { type: 'text', inputmode: 'decimal', step: null };

/**
 * Replaces the field's value as a user would (select it all, type over it), and reads what it
 * shows. Not "clear, then type": Record Payment puts a cleared amount back as 0, as it did on the
 * number input.
 */
async function typeInto(field: Locator, text: string): Promise<string> {
  await field.selectText();
  await field.pressSequentially(text, { delay: 5 });
  return field.inputValue();
}

/** Desktop only: wheel and arrow keys over a focused field change nothing. */
async function wheelAndArrowsLeaveItAlone(page: Page, field: Locator) {
  await field.focus();
  const box = await field.boundingBox();
  if (!box) throw new Error('field has no box');
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const before = await field.inputValue();
  for (const dy of [-120, -120, 120, 120, 120]) {
    await page.mouse.wheel(0, dy);
    await page.waitForTimeout(60);
  }
  await field.press('ArrowUp');
  await field.press('ArrowDown');
  await field.press('ArrowDown');
  expect(await field.inputValue(), 'the wheel and the arrow keys never change an amount').toBe(before);
}

test.describe('money and quantity fields (mobile slice 37)', () => {
  test('job-detail~addItem: Add Item\'s money and quantity fields', async ({ page, session }, info) => {
    test.skip(!selected.has('job-detail~addItem'), 'job-detail~addItem not selected');
    const device = gateDevice(info.project.name);
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      await page.goto(`/jobs/${fixtures().jobId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      const opened = await openOverlay(page, 'addItem', device.touch);
      expect(opened, JSON.stringify(opened)).toMatchObject({ opened: true });
      const dialog = page.getByRole('dialog', { name: 'Add line item' });
      await expect(dialog.locator('#new-price')).toBeVisible();
      expect(await dialog.locator('input[type="number"]').count(), 'no number input in the dialog').toBe(0);
      for (const id of ['new-qty', 'new-price', 'new-markup', 'new-cost']) {
        expect(await attrs(dialog.locator(`#${id}`)), id).toEqual(DECIMAL);
      }
      const price = dialog.locator('#new-price');
      expect(await typeInto(price, '1,250.5')).toBe('1250.5');
      expect(await typeInto(dialog.locator('#new-qty'), '1.5')).toBe('1.5');
      if (!device.touch) await wheelAndArrowsLeaveItAlone(page, price);
      await page.keyboard.press('Escape');
    } finally {
      await keepSession(page, session);
    }
  });

  test('invoice-detail: Record Payment\'s amount', async ({ page, session }, info) => {
    test.skip(!selected.has('invoice-detail'), 'invoice-detail not selected');
    const device = gateDevice(info.project.name);
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      await page.goto(`/invoices/${fixtures().invoiceOpen.id}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      const open = page.getByRole('button', { name: /^Record Payment$/i }).filter({ visible: true }).first();
      await open.scrollIntoViewIfNeeded();
      await (device.touch ? open.tap() : open.click());
      const dialog = page.getByRole('dialog').filter({ hasText: 'Record Payment' }).first();
      const amount = dialog.getByLabel(/^Amount/).first();
      await expect(amount).toBeVisible({ timeout: 10_000 });
      expect(await dialog.locator('input[type="number"]').count(), 'no number input in the dialog').toBe(0);
      expect(await attrs(amount)).toEqual(DECIMAL);
      expect(await typeInto(amount, '1,250.5')).toBe('1250.5');
      if (!device.touch) await wheelAndArrowsLeaveItAlone(page, amount);
      await page.keyboard.press('Escape');
    } finally {
      await keepSession(page, session);
    }
  });
});
