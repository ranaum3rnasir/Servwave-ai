/**
 * Mobile slice 40 (TOUCH-05): why an action is disabled, readable on touch.
 *
 * A new automation has no steps, so Publish is disabled. On every touch project one tap on it
 * opens the reason as helper text (a `title` never shows on a touch screen); a second tap closes
 * it; and the disabled button never fires. On the desktop control the reason is still on hover
 * (the title on the shell around the button) and a click opens the same text.
 *
 * Runs with the gate (same projects, same session slots). MOBILE_GATE_ROUTES selects it by the
 * route it opens: `automation-new`.
 */
import { expect } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));

test('a disabled Publish explains itself with one tap, and still on hover', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('automation-new'), 'MOBILE_GATE_ROUTES does not select automation-new');
  const device = gateDevice(testInfo.project.name);
  const notes: string[] = [];
  await signIn(page, session, notes);
  try {
    await page.goto('/automations/new', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, notes);

    const publish = page.getByRole('button', { name: 'Publish', exact: true });
    await expect(publish).toBeVisible({ timeout: 30_000 });
    await expect(publish).toBeDisabled();

    // The shell around the dead button takes the tap.
    const shell = publish.locator('xpath=..');
    const reason = (await shell.getAttribute('title')) ?? '';
    expect(reason.length, 'the shell carries the reason as its hover title').toBeGreaterThan(0);

    const bubble = page.locator('[data-slot="disabled-reason"]');
    await expect(bubble).toHaveCount(0);

    await press(device.touch, shell);
    await expect(bubble, 'one tap shows the reason').toBeVisible();
    await expect(bubble).toHaveText(reason);
    // Inside the visible screen, not cut off by it.
    const box = (await bubble.boundingBox())!;
    const vp = page.viewportSize()!;
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(vp.width + 1);

    await press(device.touch, shell);
    await expect(bubble, 'a second tap closes it').toHaveCount(0);

    // Nothing was published by tapping a disabled button.
    expect(page.url()).toContain('/automations/new');
    await testInfo.attach('disabled-reason.json', {
      body: JSON.stringify({ device: device.id, reason, notes }, null, 1),
      contentType: 'application/json',
    });
  } finally {
    await keepSession(page, session);
  }
});
