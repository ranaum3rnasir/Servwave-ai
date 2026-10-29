/**
 * Mobile slice 57 (KB-09 [D]): a job note survives the camera, a rotation and a locked screen.
 *
 * On the job page's Notes tab, on every device project:
 *   - type a note, rotate (a viewport swap) with the keyboard-sized change: the text is still there;
 *   - background the page (the page reports `hidden`, which is what the camera opening or the
 *     screen locking does), then discard it and bring it back (a reload, the browser reclaiming a
 *     backgrounded tab): the note is back in the box with the quiet "Draft restored" and Discard;
 *   - Discard empties the box and the saved draft goes with it;
 *   - Add Note saves it, and the draft is gone from the device (this writes one note into the
 *     throwaway org the gate provisions, never anywhere else);
 *   - a draft saved for ANOTHER user on this device is never offered;
 *   - nothing the note shows carries a vendor name.
 *
 * A real backgrounding, a real camera and a real lock screen are on the real-device checklist; this
 * proves the same page lifecycle the browser drives, with what emulation can reach. MOBILE_GATE_ROUTES
 * selects it by the `job-detail` route id.
 */
import { expect, type Page } from '@playwright/test';
import fs from 'fs';
import { gateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';
import { findVendorTerms } from './vendor-terms';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

const NOTE = 'Gate code 4411, dog in the yard, door still rubs';

async function openNotesTab(page: Page, touch: boolean) {
  await page.goto(`/jobs/${fixtures().jobId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
  await press(touch, page.getByRole('tab', { name: 'Notes' }), { timeout: 20_000 });
  const box = page.getByLabel('Note', { exact: true });
  await expect(box).toBeVisible({ timeout: 15_000 });
  return box;
}

/** What the browser does to a page it is about to background or freeze. */
async function backgroundThePage(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
  });
}

const draftKeys = (page: Page) =>
  page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('servwave:draft:')));

test('a job note survives rotation, backgrounding and a discarded page, and Add Note clears it', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('job-detail'), 'MOBILE_GATE_ROUTES does not select job-detail');
  const device = gateDevice(testInfo.project.name);
  await signIn(page, session, []);
  try {
    const box = await openNotesTab(page, device.touch);
    await expect(page.getByText('Draft restored')).toHaveCount(0);
    await box.fill(NOTE);

    // Rotation (and the keyboard resizing the visual viewport) never touches what was typed.
    const vp = page.viewportSize()!;
    await page.setViewportSize({ width: vp.height, height: vp.width });
    await page.waitForTimeout(300);
    await expect(box).toHaveValue(NOTE);
    await page.setViewportSize(vp);
    await page.waitForTimeout(300);
    await expect(box).toHaveValue(NOTE);

    // Backgrounded: saved at once, without waiting for any quiet period.
    await backgroundThePage(page);
    expect(await draftKeys(page), 'a draft is on the device after the page is hidden').toHaveLength(1);

    // The page was discarded while away and comes back.
    const restoredBox = await openNotesTab(page, device.touch);
    await expect(restoredBox).toHaveValue(NOTE);
    const status = page.getByRole('status').filter({ hasText: 'Draft restored' });
    await expect(status).toBeVisible();
    await expect(status.getByRole('button', { name: 'Discard' })).toBeVisible();

    // No vendor name in anything the note adds to the page.
    const copy = [
      { source: 'restored note', text: (await status.innerText()) },
      { source: 'note box', text: (await restoredBox.getAttribute('placeholder')) ?? '' },
    ];
    expect(findVendorTerms(copy)).toEqual([]);

    // Discard throws the text and the saved draft away.
    await press(device.touch, status.getByRole('button', { name: 'Discard' }), { timeout: 10_000 });
    await expect(restoredBox).toHaveValue('');
    await expect(page.getByText('Draft restored')).toHaveCount(0);
    expect(await draftKeys(page)).toHaveLength(0);

    // Type again, background, come back, then Add Note: saved, and nothing left on the device.
    await restoredBox.fill(NOTE);
    await backgroundThePage(page);
    const again = await openNotesTab(page, device.touch);
    await expect(again).toHaveValue(NOTE);
    await press(device.touch, page.getByRole('button', { name: 'Add Note' }), { timeout: 10_000 });
    await expect(page.getByText(NOTE).first()).toBeVisible({ timeout: 15_000 });
    await expect(again).toHaveValue('');
    await page.waitForTimeout(600); // longer than the save debounce: nothing may write the text back
    expect(await draftKeys(page), 'saving the note cleared its draft').toHaveLength(0);
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});

test("another user's draft on the same device is never offered", async ({ page, session }, testInfo) => {
  test.skip(!selected.has('job-detail'), 'MOBILE_GATE_ROUTES does not select job-detail');
  const device = gateDevice(testInfo.project.name);
  await signIn(page, session, []);
  try {
    // A draft for the same job and field, saved under a different user id and organisation id.
    const key = `servwave:draft:v1:${encodeURIComponent('some-other-org')}:${encodeURIComponent('some-other-user')}:JOB:${encodeURIComponent(fixtures().jobId)}:notes-tab-note`;
    await page.context().addInitScript(({ k, v }) => {
      try { localStorage.setItem(k, v); } catch { /* storage blocked */ }
    }, { k: key, v: JSON.stringify({ v: 'a different user, customer details', t: Date.now() }) });

    const box = await openNotesTab(page, device.touch);
    await expect(box).toHaveValue('');
    await expect(page.getByText('Draft restored')).toHaveCount(0);
    await expect(page.getByText('a different user, customer details')).toHaveCount(0);
  } finally {
    await keepSession(page, session).catch(() => {});
  }
});
