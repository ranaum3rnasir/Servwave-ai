/**
 * Mobile slice 39 (TOUCH-01 list checkboxes, A11Y-08 card semantics): on a phone the list card is
 * one named button that opens the record, and its checkbox has a 44 px hit area and only selects.
 *
 * - Phone projects (below md: the three phones): each Jobs card has an open button named for the
 *   job and a checkbox named "Select ..."; the checkbox is at least 44x44; tapping it selects the
 *   card, shows the bulk bar, and does not leave /jobs; tapping the card opens the job.
 * - Every other project (iPad Mini, phone held sideways, desktop control): the table is shown, so
 *   there are no cards.
 *
 * Seen red against origin/staging's DataTable (this spec kept): the phone card had no checkbox and
 * no open button, so the first assertion failed on all three phones.
 * MOBILE_GATE_ROUTES selects it by `jobs`.
 */
import { expect } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { tap } from './touch';

const selected = new Set(selectStates().map((s) => s.id));

test('jobs: a phone card is one named button and its checkbox only selects', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('jobs'), 'MOBILE_GATE_ROUTES does not select jobs');
  const device = gateDevice(testInfo.project.name);
  await signIn(page, session, []);
  try {
    await page.goto('/jobs', { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    const phone = (page.viewportSize()?.width ?? 1000) < 768;
    const cards = page.locator('[data-slot="table-card"]');

    if (!phone) {
      await expect(cards).toHaveCount(0);
      return;
    }
    expect(device.touch).toBe(true);
    await expect(cards.first()).toBeVisible({ timeout: 30_000 });

    // One named open button per card.
    const open = cards.first().locator('[data-slot="table-card-open"]');
    await expect(open).toHaveCount(1);
    const openName = await open.evaluate((el) => {
      const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
      return ids.map((id) => document.getElementById(id)?.textContent ?? '').join(' ').trim() || el.getAttribute('aria-label') || '';
    });
    expect(openName.length).toBeGreaterThan(0);

    // The checkbox: named, 44 px, selects only.
    const box = cards.first().getByRole('checkbox', { name: /^Select/ });
    await expect(box).toHaveCount(1);
    const b = (await box.boundingBox())!;
    expect(b.width).toBeGreaterThanOrEqual(43.5);
    expect(b.height).toBeGreaterThanOrEqual(43.5);
    const before = page.url();
    await tap(box);
    await expect(box).toHaveAttribute('aria-checked', 'true');
    await expect(page.getByText(/^1 job selected$/)).toBeVisible();
    expect(page.url()).toBe(before);

    // A second card (if the org has one) also selects; the bulk bar counts both.
    if ((await cards.count()) > 1) {
      await tap(cards.nth(1).getByRole('checkbox', { name: /^Select/ }));
      await expect(page.getByText(/^2 jobs selected$/)).toBeVisible();
    }
    await expect(page.getByRole('button', { name: 'Change status' })).toBeVisible();
    expect(page.url()).toBe(before);

    // Tapping the card elsewhere opens the record.
    const ob = (await open.boundingBox())!;
    await open.tap({ position: { x: 8, y: ob.height - 6 } });
    await expect(page).toHaveURL(/\/jobs\/[^/?#]+/);
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});
