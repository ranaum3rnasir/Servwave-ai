/**
 * Mobile slice 45 (CMP-04 date, TOUCH-01 date; story 44): below md the day picker opens in a bottom
 * sheet with day cells of at least 40 px and the whole calendar on screen; from md up it is the
 * popover it always was (36 px days, anchored to its field).
 *
 * Driven on New Task's Due Date (a date-and-time field in a form dialog, which is the stacking the
 * phone layout has to survive: a sheet over a full-screen dialog). Nothing is saved.
 *
 * MOBILE_GATE_ROUTES selects it with `tasks`.
 */
import { expect, type Page } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { keepSession, signIn, test } from './session';
import { selectStates } from './routes';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));

/** Below md (the three phones) and the short landscape window: the bottom sheet. */
const SHEET_LAYOUT = new Set(['iphone-se', 'galaxy-s24', 'iphone-15', 'landscape-phone']);

async function openDueCalendar(page: Page, touch: boolean) {
  await page.goto('/tasks', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
  const btn = page.locator('main').getByRole('button', { name: /^\s*New Task\s*$/ }).first();
  await expect(btn).toBeVisible({ timeout: 20_000 });
  await press(touch, btn, { timeout: 15_000 });
  const dialog = page.getByRole('dialog', { name: 'New Task' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  await press(touch, dialog.getByRole('button', { name: 'Open calendar' }).first());
  await expect(page.getByRole('grid').first()).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500);
  return dialog;
}

interface Cell { text: string; width: number; height: number; left: number; right: number; top: number; bottom: number }

/** Every day cell (the grid cell and the button inside it), measured. */
async function readDays(page: Page): Promise<{ cells: Cell[]; buttons: Cell[]; grid: Cell }> {
  return page.evaluate(() => {
    const box = (el: Element): Cell => {
      const r = el.getBoundingClientRect();
      return { text: (el.textContent ?? '').trim(), width: r.width, height: r.height, left: r.left, right: r.right, top: r.top, bottom: r.bottom };
    };
    const grid = document.querySelector('[role="grid"]')!;
    const cells = [...grid.querySelectorAll('[role="gridcell"]')];
    return { cells: cells.map(box), buttons: cells.map((c) => c.querySelector('button')).filter(Boolean).map((b) => box(b!)), grid: box(grid) };
  });
}

test('Due Date calendar: a bottom sheet with 40 px days below md, the popover with 36 px days from md up', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('tasks') && !selected.has('tasks~datePicker'), 'MOBILE_GATE_ROUTES does not select tasks');
  const device = gateDevice(testInfo.project.name);
  const sheetLayout = SHEET_LAYOUT.has(device.id);
  await signIn(page, session, []);
  try {
    await openDueCalendar(page, device.touch);
    const vp = page.viewportSize()!;
    const sheet = page.locator('[data-picker="date-sheet"]');
    const days = await readDays(page);
    expect(days.cells.length, 'six week rows of seven').toBe(42);

    if (sheetLayout) {
      await expect(sheet, 'the calendar is a sheet').toBeVisible();
      await expect(sheet).toHaveAttribute('data-presentation', 'bottom-sheet');
      const box = (await sheet.boundingBox())!;
      expect(Math.round(box.x), 'edge to edge (left)').toBe(0);
      expect(Math.round(box.width), 'edge to edge (width)').toBe(vp.width);
      expect(Math.round(box.y + box.height), 'anchored to the bottom edge').toBe(vp.height);
      expect(box.y, 'inside the screen (top)').toBeGreaterThanOrEqual(0);

      // Every day: a 40 px target, the grid cell as well as the button in it.
      for (const c of [...days.cells, ...days.buttons]) {
        expect(c.width, `day ${c.text} is at least 40 px wide`).toBeGreaterThanOrEqual(39.5);
        expect(c.height, `day ${c.text} is at least 40 px tall`).toBeGreaterThanOrEqual(39.5);
      }

      // The whole calendar is inside the viewport sideways at every width, and vertically wherever the
      // screen is tall enough for a calendar at all (a phone held sideways scrolls the sheet's body).
      expect(days.grid.left, 'the grid is inside the screen (left)').toBeGreaterThanOrEqual(0);
      expect(days.grid.right, `the grid is inside the screen (right) at ${vp.width}px`).toBeLessThanOrEqual(vp.width);
      if (vp.height >= 500) {
        expect(days.grid.top, 'the grid is inside the screen (top)').toBeGreaterThanOrEqual(0);
        expect(days.grid.bottom, `the whole grid is inside the screen at ${vp.height}px tall`).toBeLessThanOrEqual(vp.height);
        const lastRow = days.cells[days.cells.length - 1]!;
        expect(lastRow.bottom, 'the sixth week is on screen without scrolling').toBeLessThanOrEqual(vp.height);
      } else {
        const last = page.locator('[role="gridcell"]').last();
        await last.scrollIntoViewIfNeeded();
        const lb = (await last.boundingBox())!;
        expect(lb.y + lb.height, 'the last day can be scrolled to').toBeLessThanOrEqual(vp.height + 1);
      }

      // Header and footer controls are 44 px; the sheet keeps the form dialog behind it.
      const footer = sheet.getByRole('button', { name: 'Now' });
      const fb = (await footer.boundingBox())!;
      expect(fb.height, 'Now is 44 px tall').toBeGreaterThanOrEqual(43.5);
      for (const name of ['Go to the previous month', 'Go to the next month']) {
        const nb = (await sheet.getByRole('button', { name }).boundingBox())!;
        expect(nb.width, `${name} is 44 px wide`).toBeGreaterThanOrEqual(43.5);
        expect(nb.height, `${name} is 44 px tall`).toBeGreaterThanOrEqual(43.5);
      }
      // (hidden from the accessibility tree while the modal sheet is over it, hence includeHidden)
      await expect(page.getByRole('dialog', { name: 'New Task', includeHidden: true }), 'the form is still open under the sheet').toBeAttached();

      // Tapping a day sets it and closes the sheet only.
      const target = page.locator('[role="gridcell"]:not([data-outside="true"]) button').filter({ hasText: /^15$/ }).first();
      await press(device.touch, target);
      await expect(sheet, 'picking a day closes the sheet').toHaveCount(0);
      await expect(page.getByRole('dialog', { name: 'New Task' }), 'but not the form').toBeVisible();
      await expect(page.locator('#task-due'), 'the day is in the field').toHaveValue(/\/15\/\d{4}$/);
    } else {
      await expect(sheet, 'no sheet from md up').toHaveCount(0);
      await expect(page.locator('[data-slot="popover-content"]'), 'the popover it always was').toBeVisible();
      for (const c of days.buttons) {
        expect(c.width, `day ${c.text} keeps its 36 px size`).toBeGreaterThanOrEqual(35.5);
        expect(c.width, `day ${c.text} keeps its 36 px size`).toBeLessThanOrEqual(36.5);
      }
      expect(days.grid.right, 'inside the screen').toBeLessThanOrEqual(vp.width);
      expect(days.grid.bottom, 'inside the screen').toBeLessThanOrEqual(vp.height);
      await page.keyboard.press('Escape');
    }
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});

/**
 * A date field inside a popover (the list filters). The sheet has to be the TOP layer there: it was
 * opened from a popover that sits on the floating layer, and a sheet on the page layer painted
 * underneath it, so the day grid was hidden (staging finding on slice 45). Visibility alone cannot
 * show that (a covered element is still "visible"), so the check asks what is on top at the grid's
 * centre. Nothing is saved.
 *
 * MOBILE_GATE_ROUTES selects it with `jobs`.
 */
test('Date field inside the Filters popover: the calendar sheet is above the popover', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('jobs') && !selected.has('jobs~filter'), 'MOBILE_GATE_ROUTES does not select jobs');
  const device = gateDevice(testInfo.project.name);
  const sheetLayout = SHEET_LAYOUT.has(device.id);
  // On a phone held sideways (390 px tall) the Created range control inside the Filters popover sits
  // outside the viewport and cannot be tapped (Playwright: "element is outside of the viewport", even
  // after scrolling into view). That is the Filters popover's own fit on a short window, a separate
  // defect from this stacking one; the sheet layout it would take is the same code path the three
  // phones exercise here, and the unit test covers the short-height presentation.
  test.skip(device.id === 'landscape-phone', 'the Filters popover cannot be driven on a 390 px tall window (separate, older defect)');
  await signIn(page, session, []);
  try {
    await page.goto('/jobs', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    const filter = page.locator('main').getByRole('button', { name: /^Filters?\b/ }).first();
    await expect(filter).toBeVisible({ timeout: 20_000 });
    await press(device.touch, filter, { timeout: 15_000 });
    // Below md the Filters panel is a bottom sheet that drills into one facet (its title becomes the
    // facet's name); from md up it is the popover with a tab per facet.
    const filterSheet = device.id === 'iphone-se' || device.id === 'galaxy-s24' || device.id === 'iphone-15';
    const popover = filterSheet ? page.locator('[data-filter-sheet]') : page.getByRole('dialog').filter({ hasText: 'Filters' }).first();
    await expect(popover).toBeVisible({ timeout: 10_000 });
    await press(device.touch, filterSheet ? popover.getByRole('button', { name: /^Created/ }) : popover.getByRole('tab', { name: /^Created/ }));
    await press(device.touch, popover.getByRole('combobox', { name: 'Created range' }));
    await press(device.touch, page.getByRole('option', { name: 'Custom' }));
    // The "to" field's button: at 320 the "from" field's button sits under its neighbour's input (a
    // separate, older overlap in the Filters popover that the overflow work owns).
    await press(device.touch, popover.getByRole('button', { name: 'Open calendar' }).last());
    await expect(page.getByRole('grid').first()).toBeVisible({ timeout: 10_000 });
    await page.waitForTimeout(500);

    // Which paints on top. A modal sheet turns pointer events off on everything under it, so
    // elementFromPoint walks straight through a popover that is painted OVER the sheet and cannot show
    // the defect; the stacking can. The layer that wins is the higher z-index, and on a tie the one
    // later in the document (portals append in the order they open).
    const stacking = await page.evaluate(() => {
      const layerOf = (el: Element) => {
        // A popover's z-index is copied onto its positioning wrapper, which is what sits in the body.
        let node: Element | null = el;
        while (node && node.parentElement !== document.body) node = node.parentElement;
        const z = node ? Number.parseInt(getComputedStyle(node).zIndex, 10) : Number.NaN;
        return { node, z: Number.isNaN(z) ? 0 : z };
      };
      const sheetEl = document.querySelector('[data-picker="date-sheet"]');
      const popEl = [...document.querySelectorAll('[role="dialog"]')].find((d) => d !== sheetEl && (d.hasAttribute('data-filter-sheet') || d.textContent?.includes('Filters')));
      if (!sheetEl) return { sheet: false, above: true, detail: 'popover layout' };
      if (!popEl) return { sheet: true, above: false, detail: 'no Filters popover found' };
      const s = layerOf(sheetEl);
      const p = layerOf(popEl);
      const later = !!s.node && !!p.node && !!(p.node.compareDocumentPosition(s.node) & Node.DOCUMENT_POSITION_FOLLOWING);
      return { sheet: true, above: s.z > p.z || (s.z === p.z && later), detail: `sheet z ${s.z}, popover z ${p.z}, sheet later: ${later}` };
    });
    expect(stacking.above, `the calendar sheet paints above the Filters popover (${stacking.detail})`).toBe(true);
    expect(stacking.sheet, 'a phone gets the sheet').toBe(sheetLayout);

    if (sheetLayout) {
      const sheet = page.locator('[data-picker="date-sheet"]');
      await expect(sheet).toBeVisible();
      const days = await readDays(page);
      const vp = page.viewportSize()!;
      expect(days.grid.right, 'the grid is inside the screen (right)').toBeLessThanOrEqual(vp.width);
      // Tapping a day lands on the day (it is not intercepted by the popover) and closes only the sheet.
      const target = page.locator('[role="gridcell"]:not([data-outside="true"]) button').filter({ hasText: /^15$/ }).first();
      await press(device.touch, target);
      await expect(sheet, 'picking a day closes the sheet').toHaveCount(0);
      await expect(popover, 'but not the Filters popover').toBeVisible();
      await expect(popover.getByLabel('Created to'), 'the day is in the field').toHaveValue(/\/15\/\d{4}$/);
    } else {
      await page.keyboard.press('Escape');
    }
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});
