/**
 * Mobile slice 43 (CMP-06, KB-07 partial): nothing discards half-filled work without asking, and a
 * viewport resize never dismisses an overlay.
 *
 * Drives the New Task form (it adopts the shared dirty guard) on every device project:
 *   - type a title, then close it (Close button, Escape): a "Discard your changes?" question comes
 *     up, with Keep editing and Discard, and the form is still there with the title in it;
 *   - Keep editing returns to the form untouched;
 *   - resize the window (the on-screen keyboard's effect, a rotation) with the form dirty: the form
 *     stays open, no question is asked, the title is intact;
 *   - Discard closes it; a clean form closes straight away.
 * Nothing is saved. MOBILE_GATE_ROUTES selects it by the `tasks` route id.
 *
 * Browser dialogs stay banned: the question is a page dialog (a native one would fire a `dialog`
 * event, which fails this test).
 */
import { expect, type Page } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));
const TITLE = 'Half-typed task for the guard';

async function openNewTask(page: Page, touch: boolean) {
  await page.goto('/tasks', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
  const btn = page.locator('main').getByRole('button', { name: /^\s*New Task\s*$/ }).first();
  await expect(btn).toBeVisible({ timeout: 20_000 });
  await press(touch, btn, { timeout: 15_000 });
  const dialog = page.getByRole('dialog', { name: 'New Task' });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await page.waitForTimeout(500); // the open animation
  return dialog;
}

test('a dirty New Task asks before discarding, and a resize never closes it', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('tasks'), 'MOBILE_GATE_ROUTES does not select tasks');
  const device = gateDevice(testInfo.project.name);
  const nativeDialogs: string[] = [];
  page.on('dialog', (d) => { nativeDialogs.push(d.message()); void d.dismiss(); });
  await signIn(page, session, []);
  try {
    const dialog = await openNewTask(page, device.touch);
    const title = dialog.getByPlaceholder('Task title');
    await title.fill(TITLE);

    // A resize (the keyboard opening, a rotation) is never a dismissal.
    const vp = page.viewportSize()!;
    await page.setViewportSize({ width: vp.width, height: Math.max(240, vp.height - 120) });
    await page.waitForTimeout(400);
    await expect(dialog).toBeVisible();
    await expect(page.getByText('Discard your changes?')).toHaveCount(0);
    await expect(title).toHaveValue(TITLE);
    await page.setViewportSize(vp);
    await page.waitForTimeout(300);
    await expect(dialog).toBeVisible();

    // Escape asks; Keep editing returns to the untouched form.
    await page.keyboard.press('Escape');
    const question = page.getByRole('dialog', { name: 'Discard your changes?' });
    await expect(question).toBeVisible();
    await press(device.touch, question.getByRole('button', { name: 'Keep editing' }), { timeout: 10_000 });
    await expect(question).toHaveCount(0);
    await expect(title).toHaveValue(TITLE);

    // The close button asks too (and is a touch-sized target on a phone, slice 25/26).
    await press(device.touch, dialog.getByRole('button', { name: 'Close', exact: true }).first(), { timeout: 10_000 });
    await expect(question).toBeVisible();
    await press(device.touch, question.getByRole('button', { name: 'Discard' }), { timeout: 10_000 });
    await expect(dialog).toHaveCount(0);

    // A clean form closes straight away.
    const again = await openNewTask(page, device.touch);
    await press(device.touch, again.getByRole('button', { name: 'Close', exact: true }).first(), { timeout: 10_000 });
    await expect(again).toHaveCount(0);
    await expect(page.getByText('Discard your changes?')).toHaveCount(0);

    expect(nativeDialogs, 'no browser dialog was raised').toEqual([]);
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});
