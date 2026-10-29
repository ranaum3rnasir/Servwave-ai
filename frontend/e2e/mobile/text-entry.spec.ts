/**
 * Mobile slice 14 (KB-01, A11Y-06): text fields that don't zoom on phones, desktop density kept,
 * and a visible focus indicator wherever a field removed the browser's outline.
 *
 * - `comm-inbox`: the email compose window's To, Cc and Bcc (the ghost input), Subject and body.
 *   On touch projects each is at least 16 px; on the desktop control each keeps its 14 px. On
 *   every project each draws a focus indicator (an outline or a box shadow that is not there
 *   before it is focused).
 * - `lead-new`: select triggers and combobox triggers (buttons, which the gate's `inputFont`
 *   check does not measure) are at least 16 px on touch projects, so the field row reads at one
 *   size; the desktop control's sizes are compared against staging by the gate's recorded
 *   `inputFont.info.sizes` (see README.md).
 *
 * Runs with the gate (same projects, same session slots); MOBILE_GATE_ROUTES selects it by the
 * route it opens. It writes nothing: the compose window is closed without sending.
 */
import { expect, type Locator } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';

const selected = new Set(selectStates().map((s) => s.id));

const fontPx = (l: Locator) => l.evaluate((el) => parseFloat(getComputedStyle(el).fontSize));

/** What the element draws as a focus indicator: a visible outline or any box shadow. */
const indicator = (l: Locator) =>
  l.evaluate((el) => {
    const cs = getComputedStyle(el);
    const alpha = (c: string) => {
      const m = /rgba?\(([^)]+)\)/.exec(c);
      if (!m) return c === 'transparent' ? 0 : 1;
      const parts = m[1]!.split(/[\s,/]+/).filter(Boolean);
      return parts.length > 3 ? parseFloat(parts[3]!) : 1;
    };
    const outline = cs.outlineStyle !== 'none' && parseFloat(cs.outlineWidth) > 0 && alpha(cs.outlineColor) > 0 ? `outline ${cs.outlineWidth} ${cs.outlineColor}` : '';
    const shadow = cs.boxShadow && cs.boxShadow !== 'none' ? `shadow ${cs.boxShadow}` : '';
    return [outline, shadow].filter(Boolean).join(' + ');
  });

test.describe('text entry (mobile slice 14)', () => {
  test('compose fields: 16 px on touch, 14 px on desktop, visible focus', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('comm-inbox'), 'comm-inbox not selected');
    const device = gateDevice(testInfo.project.name);
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      await page.goto('/communication/inbox', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      await page.getByRole('button', { name: /^Compose$/ }).click();
      const to = page.getByPlaceholder('Recipients');
      await expect(to).toBeVisible();
      await page.getByRole('button', { name: 'Cc/Bcc' }).click();
      const fields: Array<[string, Locator]> = [
        ['To', to],
        ['Cc (ghost input)', page.getByPlaceholder('Cc', { exact: true })],
        ['Bcc (ghost input)', page.getByPlaceholder('Bcc', { exact: true })],
        ['Subject', page.getByPlaceholder('Subject')],
        ['Body', page.getByPlaceholder('Write your message…')],
      ];
      const report: string[] = [];
      for (const [name, field] of fields) {
        await expect(field, name).toBeVisible();
        const px = await fontPx(field);
        if (device.touch) expect(px, `${name} text on ${device.id}`).toBeGreaterThanOrEqual(16);
        else expect(px, `${name} text on the desktop control (staging: 14 px)`).toBe(14);
        await field.evaluate((el) => (el as HTMLElement).blur());
        const before = await indicator(field);
        await field.focus();
        const after = await indicator(field);
        report.push(`${name}: ${px}px; focus ${after || 'NONE'} (at rest ${before || 'none'})`);
        expect(after, `${name} shows a focus indicator`).not.toBe('');
        expect(after, `${name}'s focus indicator only appears on focus`).not.toBe(before);
      }
      console.log(`[text-entry] ${device.id}\n  ${report.join('\n  ')}`);
    } finally {
      await keepSession(page, session);
    }
  });

  test('select and combobox triggers on the New lead page are 16 px on touch', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('lead-new'), 'lead-new not selected');
    const device = gateDevice(testInfo.project.name);
    test.skip(!device.touch, 'desktop sizes are compared against staging through the gate records');
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      await page.goto('/leads/new', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      const triggers = page.locator('main [role="combobox"]:visible, main [data-slot="select-trigger"]:visible');
      const n = await triggers.count();
      expect(n, 'the New lead page has select or combobox triggers').toBeGreaterThan(0);
      const small: string[] = [];
      for (let i = 0; i < n; i++) {
        const t = triggers.nth(i);
        const px = await fontPx(t);
        if (px < 16) small.push(`${(await t.getAttribute('aria-label')) ?? (await t.textContent())?.trim().slice(0, 30)}: ${px}px`);
      }
      expect(small, `triggers under 16 px on ${device.id}`).toEqual([]);
    } finally {
      await keepSession(page, session);
    }
  });
});
