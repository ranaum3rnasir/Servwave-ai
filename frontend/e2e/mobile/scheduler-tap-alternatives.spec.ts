/**
 * Mobile slice 60 (TOUCH-06, TOUCH-10 scheduler parts): the two scheduler gestures a finger cannot
 * make have a tap. A Plan Mode draft opens its Confirm / Remove menu by tap (it was right-click
 * only), and a day of the week view widens by a button in its header (it was double-click only).
 * Driven with the slice 19 touch helpers: real touch input on the touch projects, the mouse on the
 * desktop control, where the double-click shortcut must still work and the button stays out of sight
 * until a keyboard reaches it.
 *
 * The draft is seeded the way the page itself stores one (session tab id + the plan-mode storage
 * key), so nothing is written to the database: Confirm is only opened, never pressed. Read-only
 * otherwise. MOBILE_GATE_ROUTES selects it with `schedule`.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));
const TARGET = 44;
const TAB_ID = 'gate-s60-tap';

/** Today at 16:00Z: late morning on the throwaway org's New York clock, inside the default grid. */
function draftTimes(): { start: string; end: string } {
  const day = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const start = new Date(`${day}T16:00:00Z`);
  return { start: start.toISOString(), end: new Date(start.getTime() + 2 * 3_600_000).toISOString() };
}

async function seedDraft(page: Page) {
  const { start, end } = draftTimes();
  await page.context().addInitScript(({ tab, ghost }) => {
    try {
      sessionStorage.setItem('plan-mode-tab-id', tab);
      localStorage.setItem(`plan-mode-${tab}`, JSON.stringify({ isActive: true, ghosts: [ghost], updatedAt: Date.now() }));
    } catch { /* storage blocked */ }
  }, {
    tab: TAB_ID,
    ghost: {
      id: 'g-gate-1', sourceId: 'job-gate-1', sourceType: 'job', isFromSidebar: false, isMovedConfirmed: false,
      start, end, crew: [], title: 'Gate draft', customerName: 'Gate Customer', address: '',
      raw: { job_number: 'J-GATE', customer: { first_name: 'Gate', last_name: 'Customer' } },
    },
  });
}

async function openWeek(page: Page) {
  await page.goto('/schedule?view=week', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
  await expect(page.locator('.schedule-cal .rbc-time-header-content .rbc-header').first()).toBeVisible({ timeout: 20_000 });
}

const headerWidths = (page: Page) => page.evaluate(() =>
  [...document.querySelectorAll('.schedule-cal .rbc-time-header-content .rbc-header')].map((h) => h.getBoundingClientRect().width));
const focusDay = (page: Page) => page.evaluate(() => document.querySelector('.schedule-cal')?.getAttribute('data-focus-day') ?? null);
const widenButtons = (page: Page) => page.locator('.schedule-cal [data-slot="schedule-day-widen"]');

test('a day of the week view widens by one tap on its header button (double-click still works on desktop)', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('schedule'), 'MOBILE_GATE_ROUTES does not select schedule');
  const device = gateDevice(testInfo.project.name);
  await signIn(page, session, []);
  try {
    await openWeek(page);
    const buttons = widenButtons(page);
    await expect(buttons, 'one widen button per day header').toHaveCount(7);
    await expect(page.locator('.schedule-cal .rbc-header button button'), 'no button sits inside another button').toHaveCount(0);
    await expect(page.getByRole('button', { name: /^Open \w+, \w+ \d+$/ }), 'every day header still opens its day').toHaveCount(7);

    if (!device.touch) {
      // The mouse screen is unchanged to the eye: the button is in the page but visually hidden.
      // Its wrapper is the visually hidden box (1 px); the button inside only has the wrapper's clip.
      const box = (await buttons.nth(3).locator('xpath=..').boundingBox())!;
      expect(box.width, 'hidden on a mouse screen').toBeLessThanOrEqual(2);
      // The shortcut still works, and so does the keyboard: focusing the button shows it.
      const header = page.locator('.schedule-cal .rbc-time-header-content .rbc-header').nth(3);
      await header.dblclick({ position: { x: 4, y: 4 } });
      expect(await focusDay(page), 'double-click on the header still widens that day').toBe('3');
      await header.dblclick({ position: { x: 4, y: 4 } });
      expect(await focusDay(page)).toBeNull();
      await buttons.nth(5).focus();
      expect((await buttons.nth(5).locator('xpath=..').boundingBox())!.width, 'a focused button shows itself').toBeGreaterThanOrEqual(20);
      await page.keyboard.press('Enter');
      expect(await focusDay(page), 'the keyboard widens a day').toBe('5');
      await page.keyboard.press('Enter');
      expect(await focusDay(page)).toBeNull();
      return;
    }

    // Touch: a visible, named control under every date. Tall enough to hit, as wide as its column.
    const widths = await headerWidths(page);
    const short = page.viewportSize()!.height <= 500;
    for (let i = 0; i < 7; i += 1) {
      const box = (await buttons.nth(i).boundingBox())!;
      expect(box.height, `day ${i} button height`).toBeGreaterThanOrEqual(TARGET - 0.5);
      expect(box.width, `day ${i} button width (its column is ${widths[i]} px)`).toBeGreaterThanOrEqual(24);
      if (short) {
        // A phone held sideways: the button sits beside the date (one header row, so the time grid
        // keeps its 200 px) and is a 44 px square.
        expect(box.width, `day ${i} button width, short window`).toBeGreaterThanOrEqual(TARGET - 0.5);
      } else {
        // The header cell pads 4 px a side and has a 1 px rule, so the button is the cell less 10 px.
        expect(box.width, `day ${i} button fills its column`).toBeGreaterThanOrEqual(widths[i]! - 10);
      }
    }
    await expect(buttons.nth(3)).toHaveAttribute('aria-pressed', 'false');
    const before = await headerWidths(page);

    await press(true, buttons.nth(3));
    await expect.poll(() => focusDay(page), { message: 'the tap widens that day' }).toBe('3');
    await expect(buttons.nth(3)).toHaveAttribute('aria-pressed', 'true');
    // Let the 180 ms width transition finish, then measure: the day is far wider than a neighbour.
    await page.waitForTimeout(400);
    const after = await headerWidths(page);
    expect(after[3]!, `widened column (${before[3]} -> ${after[3]} px)`).toBeGreaterThan(before[3]! * 1.8);
    expect(after[2]!, 'a neighbour gives way').toBeLessThan(before[2]!);
    // The tap widened only: it did not drill into Day view.
    await expect(buttons, 'still the week view').toHaveCount(7);

    await press(true, buttons.nth(3));
    await expect.poll(() => focusDay(page), { message: 'a second tap narrows it again' }).toBeNull();
  } finally {
    await keepSession(page, session);
  }
});

/** The draft's card in the standard calendar: the event holding the "draft" badge. */
const draftCard = (page: Page): Locator => page.locator('.schedule-cal .rbc-event', { has: page.locator('[data-draft-badge]') }).first();

test('a Plan Mode draft opens Confirm and Remove by tap, and Remove discards it', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('schedule'), 'MOBILE_GATE_ROUTES does not select schedule');
  const device = gateDevice(testInfo.project.name);
  await signIn(page, session, []);
  await seedDraft(page);
  try {
    await openWeek(page);
    const card = draftCard(page);
    await expect(card, 'the seeded draft is on the week grid').toBeVisible({ timeout: 20_000 });
    const menu = page.locator('[data-schedule-overlay]');
    await expect(menu).toHaveCount(0);

    await press(device.touch, card);
    await expect(menu, 'a tap on the draft opens its menu').toBeVisible();
    const confirm = menu.getByRole('button', { name: 'Confirm' });
    const remove = menu.getByRole('button', { name: 'Remove' });
    await expect(confirm).toBeVisible();
    await expect(remove).toBeVisible();
    const vp = page.viewportSize()!;
    const mbox = (await menu.boundingBox())!;
    expect(mbox.x, 'menu left edge').toBeGreaterThanOrEqual(0);
    expect(mbox.y, 'menu top edge').toBeGreaterThanOrEqual(0);
    expect(mbox.x + mbox.width, 'menu right edge').toBeLessThanOrEqual(vp.width + 0.5);
    expect(mbox.y + mbox.height, 'menu bottom edge').toBeLessThanOrEqual(vp.height + 0.5);
    if (device.touch) {
      for (const [name, el] of [['Confirm', confirm], ['Remove', remove]] as const) {
        expect((await el.boundingBox())!.height, `${name} height`).toBeGreaterThanOrEqual(TARGET - 0.5);
      }
    }

    // Confirm opens the schedule confirmation for the draft; nothing is written until its own button.
    await press(device.touch, confirm);
    const dialog = page.getByRole('dialog');
    await expect(dialog.getByText(/Schedule Job\?/)).toBeVisible();
    await press(device.touch, dialog.getByRole('button', { name: /^Cancel$/ }));
    await expect(dialog).toHaveCount(0);
    await expect(draftCard(page), 'cancelling leaves the draft').toBeVisible();

    // Remove discards it.
    await press(device.touch, draftCard(page));
    await expect(menu).toBeVisible();
    await press(device.touch, menu.getByRole('button', { name: 'Remove' }));
    await expect(draftCard(page), 'Remove discards the draft').toHaveCount(0);
  } finally {
    await keepSession(page, session);
  }
});
