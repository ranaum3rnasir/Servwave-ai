import type { Page } from '@playwright/test';
import type { OverlayKind } from './routes';
import { press } from './touch';

export type OpenResult =
  | { opened: true; label: string }
  /** The overlay legitimately does not exist at this width (e.g. no drawer on desktop). */
  | { opened: false; notHere: string }
  /** Something that should be there was not: the run fails rather than pass silently. */
  | { opened: false; error: string };

const visible = async (loc: ReturnType<Page['locator']>) => {
  try { return await loc.isVisible(); } catch { return false; }
};
/**
 * Visible within a few seconds. The gate shares a loaded machine and a lazy page chunk can still
 * show "Loading page" when the opener starts; an instant check read that as "the control is not
 * here" and failed the run (slice 75 staging fix). Only used where a missing control is an error:
 * a "not applicable at this width" decision stays instant.
 */
const visibleSoon = async (loc: ReturnType<Page['locator']>, timeout = 15_000) => {
  try { await loc.waitFor({ state: 'visible', timeout }); return true; } catch { return false; }
};
const OVERLAY_SEL = '[role=dialog],[role=alertdialog],[role=menu],[role=listbox],[data-radix-popper-content-wrapper],[cmdk-root],aside[data-drawer="open"]';
async function waitForOverlay(page: Page) {
  try {
    await page.locator(OVERLAY_SEL).first().waitFor({ state: 'visible', timeout: 5_000 });
    await page.waitForTimeout(400); // let the open animation finish before measuring geometry
    // A fixed wait is not enough for a 500 ms slide: the legacy sheet was measured in the last pixel
    // of its travel (slice 52). Wait for every finite animation to end, bounded, then measure.
    await page.evaluate(() => Promise.race([
      Promise.allSettled(document.getAnimations()
        .filter((a) => a.effect?.getComputedTiming().iterations !== Infinity)
        .map((a) => a.finished)),
      new Promise((ok) => setTimeout(ok, 2_000)),
    ])).catch(() => {});
    return true;
  } catch {
    return false;
  }
}

/** Open one of the overlays the audit opened, the way a user would. */
export async function openOverlay(page: Page, kind: OverlayKind, touch: boolean): Promise<OpenResult> {
  const tap = (loc: ReturnType<Page['locator']>) => press(touch, loc, { timeout: 15_000 });
  switch (kind) {
    case 'drawer': {
      const trig = page.getByRole('button', { name: 'Open navigation' });
      // A tablet or unfolded foldable (md up to lg) has no top-bar trigger: its sidebar is the icon
      // rail, and the rail's own toggle opens the same dialog over the page (slice 35).
      const rail = page.locator('[data-slot="app-body"] > aside[data-slot="sidebar"]').getByRole('button', { name: 'Expand sidebar' });
      const viaRail = !(await visible(trig)) && (await visible(rail));
      if (!viaRail && !(await visible(trig))) return { opened: false, notHere: 'no navigation drawer at this width (the sidebar is shown)' };
      await tap(viaRail ? rail : trig);
      await page.waitForTimeout(600);
      // The drawer is the sidebar aside; measure it as an overlay by its open state.
      const open = await page.locator('aside[data-slot="sidebar"][data-drawer="open"], [role=dialog]').first().isVisible().catch(() => false);
      return open
        ? { opened: true, label: viaRail ? 'navigation overlay over the tablet rail' : 'navigation drawer' }
        : { opened: false, error: viaRail ? 'tapped Expand sidebar, but no overlay opened' : 'tapped Open navigation, but no drawer opened' };
    }
    case 'create': {
      const trig = page.getByRole('button', { name: 'Open navigation' });
      if (await visible(trig)) { await tap(trig); await page.waitForTimeout(600); }
      const btn = page.locator('button.sb-create').first();
      if (!(await visibleSoon(btn))) return { opened: false, error: 'Create New is not visible' };
      await tap(btn);
      return (await waitForOverlay(page)) ? { opened: true, label: 'Create New menu' } : { opened: false, error: 'Create New opened nothing' };
    }
    case 'search': {
      const inp = page.locator('input[placeholder^="Search everything"]').first();
      // Below md the field is behind the top bar's Search button (slice 13).
      const btn = page.locator('[data-slot="topbar"]').getByRole('button', { name: 'Search', exact: true });
      if (!(await visible(inp)) && (await visible(btn))) {
        await tap(btn);
        await inp.waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
      }
      if (!(await visible(inp))) return { opened: false, notHere: 'global search is not shown at this width' };
      await tap(inp);
      await inp.fill('te'); // results need two characters
      await page.waitForTimeout(1_500);
      return (await waitForOverlay(page)) ? { opened: true, label: 'global search results' } : { opened: false, error: 'typing in global search opened no results panel' };
    }
    case 'filter': {
      const btn = page.locator('main').getByRole('button', { name: /^Filters?\b/ }).first();
      if (!(await visibleSoon(btn))) return { opened: false, error: 'no Filter button in main' };
      await tap(btn);
      return (await waitForOverlay(page)) ? { opened: true, label: 'Filter popover' } : { opened: false, error: 'Filter opened nothing' };
    }
    case 'new': {
      const marked = await page.evaluate(() => {
        const el = [...document.querySelectorAll('main button, main a')].find(
          (e) => !e.closest('nav[aria-label="Breadcrumb"]') && e.getBoundingClientRect().width > 0 && /^\s*\+?\s*(New|Add|Create)\b/i.test((e as HTMLElement).innerText || e.getAttribute('aria-label') || ''),
        );
        if (el) el.setAttribute('data-mobile-gate-opener', '1');
        return !!el;
      });
      if (!marked) return { opened: false, error: 'no New/Add/Create control in main' };
      const btn = page.locator('[data-mobile-gate-opener="1"]').first();
      const label = ((await btn.innerText().catch(() => '')) || 'New').trim().slice(0, 30);
      const before = new URL(page.url()).pathname;
      await tap(btn);
      await page.waitForTimeout(800);
      if (new URL(page.url()).pathname !== before) {
        return { opened: false, notHere: `"${label}" opens a page (${new URL(page.url()).pathname}), measured as its own route` };
      }
      return (await waitForOverlay(page)) ? { opened: true, label } : { opened: false, error: `"${label}" opened nothing` };
    }
    case 'visitDialog': {
      // Visits tab -> Add visit, with the location set to a one-off address so its fields show.
      const tab = page.getByRole('tab', { name: 'Visits' });
      if (!(await visibleSoon(tab))) return { opened: false, error: 'no Visits tab on the job' };
      await tap(tab);
      const add = page.getByRole('button', { name: 'Add visit' });
      try { await add.waitFor({ state: 'visible', timeout: 15_000 }); } catch { return { opened: false, error: 'no Add visit button on the Visits tab' }; }
      await tap(add);
      const dialog = page.getByRole('dialog', { name: 'Add Visit' });
      try { await dialog.waitFor({ state: 'visible', timeout: 5_000 }); } catch { return { opened: false, error: 'Add visit opened nothing' }; }
      await tap(dialog.getByRole('combobox', { name: 'Location' }));
      await tap(page.getByRole('option', { name: 'Other…' }));
      await page.waitForTimeout(400);
      return { opened: true, label: 'Add Visit dialog (one-off address)' };
    }
    case 'addItem': {
      // Items tab -> Add item -> type a name -> "Add new item": the form with the money fields.
      const tab = page.getByRole('tab', { name: 'Items' });
      if (!(await visibleSoon(tab))) return { opened: false, error: 'no Items tab on the job' };
      await tap(tab);
      const add = page.getByRole('button', { name: 'Add item' }).first();
      try { await add.waitFor({ state: 'visible', timeout: 15_000 }); } catch { return { opened: false, error: 'no Add item button on the Items tab' }; }
      await tap(add);
      const dialog = page.getByRole('dialog', { name: 'Add line item' });
      try { await dialog.waitFor({ state: 'visible', timeout: 5_000 }); } catch { return { opened: false, error: 'Add item opened nothing' }; }
      // Not "Gate item": legacy-modal.spec.ts makes a catalog item of that name in the shared org, and an
      // exact match hides the "Add new item" row (a project that ran after it failed on that, slice 75).
      await dialog.getByPlaceholder('Search the price book, or type a new item…').fill('Gate overlay item');
      await tap(dialog.getByRole('button', { name: /Add new item:/ }));
      await page.waitForTimeout(400);
      return { opened: true, label: 'Add line item (new item form)' };
    }
    case 'declineDialog': {
      // The public estimate's Decline -> the confirm dialog with its two optional questions. It
      // only opens the dialog; nothing is declined.
      const decline = page.getByRole('button', { name: /^Decline$/ });
      if (!(await visibleSoon(decline))) return { opened: false, error: 'no Decline button on the public estimate' };
      await decline.scrollIntoViewIfNeeded();
      await tap(decline);
      const dialog = page.getByRole('dialog', { name: 'Decline Estimate' });
      try { await dialog.waitFor({ state: 'visible', timeout: 5_000 }); } catch { return { opened: false, error: 'Decline opened nothing' }; }
      await page.waitForTimeout(400);
      return { opened: true, label: 'Decline Estimate dialog' };
    }
    case 'notifications': {
      const btn = page.locator('[data-slot="topbar"]').getByRole('button', { name: 'Notifications', exact: true });
      if (!(await visibleSoon(btn))) return { opened: false, error: 'no Notifications button in the top bar' };
      await tap(btn);
      return (await waitForOverlay(page)) ? { opened: true, label: 'notifications panel' } : { opened: false, error: 'Notifications opened nothing' };
    }
    case 'more': {
      const btn = page.locator('[data-slot="topbar"] [data-slot="topbar-more"]');
      if (!(await visible(btn))) return { opened: false, notHere: 'no top-bar overflow menu at this width (the actions are inline)' };
      await tap(btn);
      return (await waitForOverlay(page)) ? { opened: true, label: 'top-bar overflow menu' } : { opened: false, error: 'the overflow button opened nothing' };
    }
    case 'statusChoice': {
      // The lead header's status control: a bottom sheet below md, a menu from md up. Nothing is changed.
      const btn = page.getByRole('button', { name: /^Lead status:/ }).first();
      if (!(await visibleSoon(btn))) return { opened: false, error: 'no Lead status control on the lead' };
      await tap(btn);
      return (await waitForOverlay(page)) ? { opened: true, label: 'Lead status choices' } : { opened: false, error: 'the Lead status control opened nothing' };
    }
    case 'phoneChoice': {
      // The customer's primary number: tapping it offers Call or Text. Nothing is dialled or sent.
      const number = page.locator('main').getByRole('button', { name: /^\(\d{3}\) \d{3}-\d{4}/ }).first();
      if (!(await visibleSoon(number))) return { opened: false, error: 'no tappable phone number on the customer' };
      await tap(number);
      return (await waitForOverlay(page)) ? { opened: true, label: 'Call or Text choice' } : { opened: false, error: 'the phone number opened nothing' };
    }
    case 'entityPicker': {
      // New Task -> the linked-record picker. Nothing is saved.
      const newTask = page.locator('main').getByRole('button', { name: /^\s*New Task\s*$/ }).first();
      if (!(await visibleSoon(newTask))) return { opened: false, error: 'no New Task button on the tasks page' };
      await tap(newTask);
      const dialog = page.getByRole('dialog', { name: 'New Task' });
      try { await dialog.waitFor({ state: 'visible', timeout: 5_000 }); } catch { return { opened: false, error: 'New Task opened nothing' }; }
      await page.waitForTimeout(400);
      const trigger = dialog.getByTestId('linked-entity-select-trigger');
      if (!(await visibleSoon(trigger))) return { opened: false, error: 'no linked-record picker in New Task' };
      await tap(trigger);
      await page.getByTestId('type-toggle-CUSTOMER').waitFor({ state: 'visible', timeout: 5_000 }).catch(() => undefined);
      await tap(page.getByTestId('type-toggle-CUSTOMER'));
      await page.waitForTimeout(600);
      return { opened: true, label: 'New Task linked-record picker (customers)' };
    }
    case 'datePicker': {
      // New Task -> the Due Date field's calendar button. Nothing is saved.
      const newTask = page.locator('main').getByRole('button', { name: /^\s*New Task\s*$/ }).first();
      if (!(await visibleSoon(newTask))) return { opened: false, error: 'no New Task button on the tasks page' };
      await tap(newTask);
      const dialog = page.getByRole('dialog', { name: 'New Task' });
      try { await dialog.waitFor({ state: 'visible', timeout: 5_000 }); } catch { return { opened: false, error: 'New Task opened nothing' }; }
      await page.waitForTimeout(400);
      const open = dialog.getByRole('button', { name: 'Open calendar' }).first();
      if (!(await visibleSoon(open))) return { opened: false, error: 'no Open calendar button in New Task' };
      await tap(open);
      try { await page.getByRole('grid').first().waitFor({ state: 'visible', timeout: 5_000 }); } catch { return { opened: false, error: 'Open calendar showed no calendar' }; }
      await page.waitForTimeout(500);
      return { opened: true, label: 'New Task due-date calendar' };
    }
    case 'calendarView': {
      const trig = page.locator('[aria-label="Calendar view"]').first();
      if (!(await visibleSoon(trig))) return { opened: false, error: 'no Calendar view switcher' };
      await tap(trig);
      return (await waitForOverlay(page)) ? { opened: true, label: 'Calendar view menu' } : { opened: false, error: 'Calendar view opened nothing' };
    }
  }
}
