/**
 * Mobile slice 66 (KB-09 [D], CMP-06): walkthrough notes and log-a-call notes are kept, and the
 * lead, customer and job create forms ask before they are left.
 *
 * On every device project:
 *   - the lead's Walkthrough notes survive a switch to another tab and back, and a discarded page,
 *     coming back with the quiet "Draft restored" and Discard;
 *   - the log-a-call drawer's notes come back after the page is backgrounded and discarded, and
 *     Discard on the question throws them away on purpose;
 *   - on each of the three create forms, typing something and tapping Back, Cancel or the browser
 *     Back asks "Discard your changes?"; Keep editing stays; Discard leaves; an untouched form
 *     leaves straight away.
 * Nothing is saved: no note is written to the lead and no record is created. MOBILE_GATE_ROUTES
 * selects the specs by the `lead-detail`, `lead-new`, `customer-new` and `job-new` route ids.
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

const WALKTHROUGH_NOTE = 'South stairwell, gate code 4411, unit on the roof';
const CALL_NOTE = 'He rang about the quote and wants it by Friday';

const draftKeys = (page: Page) =>
  page.evaluate(() => Object.keys(localStorage).filter((k) => k.startsWith('servwave:draft:')));

/** What the browser does to a page it is about to background or freeze. */
async function backgroundThePage(page: Page) {
  await page.evaluate(() => {
    Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' });
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
    window.dispatchEvent(new Event('pagehide'));
  });
}

async function openLead(page: Page) {
  await page.goto(`/leads/${fixtures().leadId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
}

async function openWalkthroughNotes(page: Page, touch: boolean) {
  await press(touch, page.getByRole('tab', { name: /Walkthrough/ }), { timeout: 20_000 });
  const box = page.getByPlaceholder('Walkthrough notes...');
  await expect(box).toBeVisible({ timeout: 15_000 });
  return box;
}

test('walkthrough notes survive a tab switch and a discarded page', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('lead-detail'), 'MOBILE_GATE_ROUTES does not select lead-detail');
  const device = gateDevice(testInfo.project.name);
  await signIn(page, session, []);
  try {
    await openLead(page);
    const box = await openWalkthroughNotes(page, device.touch);
    await expect(page.getByText('Draft restored')).toHaveCount(0);
    await box.fill(WALKTHROUGH_NOTE);

    // A tab switch unmounts the panel; the notes used to go with it.
    await press(device.touch, page.getByRole('tab', { name: 'Overview' }), { timeout: 15_000 });
    await expect(page.getByPlaceholder('Walkthrough notes...')).toHaveCount(0);
    const back = await openWalkthroughNotes(page, device.touch);
    await expect(back).toHaveValue(WALKTHROUGH_NOTE);
    const status = page.getByRole('status').filter({ hasText: 'Draft restored' });
    await expect(status).toBeVisible();

    // The page is backgrounded and discarded, then comes back.
    await backgroundThePage(page);
    expect(await draftKeys(page), 'a draft is on the device after the page is hidden').toHaveLength(1);
    await openLead(page);
    const again = await openWalkthroughNotes(page, device.touch);
    await expect(again).toHaveValue(WALKTHROUGH_NOTE);

    expect(findVendorTerms([{ source: 'restored note', text: await status.innerText() }])).toEqual([]);

    // Discard on the note empties the box and removes the draft.
    await press(device.touch, page.getByRole('status').filter({ hasText: 'Draft restored' }).getByRole('button', { name: 'Discard' }), { timeout: 10_000 });
    await expect(again).toHaveValue('');
    await expect(page.getByText('Draft restored')).toHaveCount(0);
    expect(await draftKeys(page)).toHaveLength(0);
  } finally {
    await page.evaluate(() => {
      try { Object.keys(localStorage).filter((k) => k.startsWith('servwave:draft:')).forEach((k) => localStorage.removeItem(k)); } catch { /* blocked */ }
    }).catch(() => {});
    await keepSession(page, session).catch(() => {});
  }
});

test('log-a-call notes come back after the page is discarded; Discard on the question throws them away', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('lead-detail'), 'MOBILE_GATE_ROUTES does not select lead-detail');
  const device = gateDevice(testInfo.project.name);
  await signIn(page, session, []);
  try {
    await openLead(page);
    const commTab = page.getByRole('tab', { name: 'Communication' });
    const hasComms = await commTab.count();
    test.skip(hasComms === 0, 'the throwaway org has no communication tab on its lead');
    await press(device.touch, commTab, { timeout: 20_000 });
    const open = page.getByRole('button', { name: 'Log communication' }).first();
    test.skip((await open.count()) === 0, 'the throwaway org cannot log communication');
    await press(device.touch, open, { timeout: 15_000 });
    const notes = page.getByPlaceholder('What was discussed?');
    await expect(notes).toBeVisible({ timeout: 15_000 });
    await notes.fill(CALL_NOTE);

    // Backgrounded and discarded without any chance to answer a question.
    await backgroundThePage(page);
    expect(await draftKeys(page)).toHaveLength(1);
    await openLead(page);
    await press(device.touch, page.getByRole('tab', { name: 'Communication' }), { timeout: 20_000 });
    await press(device.touch, page.getByRole('button', { name: 'Log communication' }).first(), { timeout: 15_000 });
    const restored = page.getByPlaceholder('What was discussed?');
    await expect(restored).toHaveValue(CALL_NOTE);
    await expect(page.getByRole('status').filter({ hasText: 'Draft restored' })).toBeVisible();

    // Closing it now asks; Discard is the user throwing the notes away on purpose.
    await press(device.touch, page.getByRole('button', { name: 'Cancel' }), { timeout: 10_000 });
    const question = page.getByRole('dialog', { name: 'Discard your changes?' });
    await expect(question).toBeVisible();
    await press(device.touch, question.getByRole('button', { name: 'Discard' }), { timeout: 10_000 });
    await expect(restored).toHaveCount(0);
    expect(await draftKeys(page)).toHaveLength(0);
  } finally {
    await page.evaluate(() => {
      try { Object.keys(localStorage).filter((k) => k.startsWith('servwave:draft:')).forEach((k) => localStorage.removeItem(k)); } catch { /* blocked */ }
    }).catch(() => {});
    await keepSession(page, session).catch(() => {});
  }
});

interface CreateForm {
  id: string;
  path: string;
  /** Type one thing into the form. */
  touch: (page: Page) => Promise<void>;
}

const CREATE_FORMS: CreateForm[] = [
  { id: 'lead-new', path: '/leads/new', touch: (page) => page.getByLabel(/first name/i).first().fill('Half-typed') },
  { id: 'job-new', path: '/jobs/new', touch: (page) => page.getByLabel(/first name/i).first().fill('Half-typed') },
  { id: 'customer-new', path: '/customers/new', touch: (page) => page.getByPlaceholder('Jane', { exact: true }).fill('Half-typed') },
];

for (const form of CREATE_FORMS) {
  test(`a half-filled ${form.id} form asks before it is left`, async ({ page, session }, testInfo) => {
    test.skip(!selected.has(form.id), `MOBILE_GATE_ROUTES does not select ${form.id}`);
    const device = gateDevice(testInfo.project.name);
    const nativeDialogs: string[] = [];
    page.on('dialog', (d) => { nativeDialogs.push(d.message()); void d.dismiss(); });
    await signIn(page, session, []);
    try {
      // Arrive with an app page behind the form, so "back" has somewhere to go.
      await page.goto('/leads', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, []);
      const open = async () => {
        await page.goto(form.path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await settle(page, []);
        await expect(page.getByRole('button', { name: 'Cancel' })).toBeVisible({ timeout: 20_000 });
      };
      const question = page.getByRole('dialog', { name: 'Discard your changes?' });

      // Untouched: Cancel leaves straight away.
      await open();
      await press(device.touch, page.getByRole('button', { name: 'Cancel' }), { timeout: 20_000 });
      await expect(page).not.toHaveURL(new RegExp(`${form.path.replace('/', '\\/')}$`), { timeout: 15_000 });
      await expect(question).toHaveCount(0);

      // Half-filled: Cancel asks, Keep editing stays with the text.
      await open();
      await form.touch(page);
      await press(device.touch, page.getByRole('button', { name: 'Cancel' }), { timeout: 20_000 });
      await expect(question).toBeVisible();
      await press(device.touch, question.getByRole('button', { name: 'Keep editing' }), { timeout: 20_000 });
      await expect(question).toHaveCount(0);
      expect(new URL(page.url()).pathname).toBe(form.path);

      // The back link asks too.
      await press(device.touch, page.getByRole('button', { name: /^back$/i }).first(), { timeout: 20_000 });
      await expect(question).toBeVisible();
      await press(device.touch, question.getByRole('button', { name: 'Keep editing' }), { timeout: 20_000 });

      // The browser's own Back (the phone's back swipe or button) asks instead of leaving.
      await page.goBack({ waitUntil: 'commit' }).catch(() => null);
      await expect(question).toBeVisible({ timeout: 20_000 });
      expect(new URL(page.url()).pathname).toBe(form.path);
      await press(device.touch, question.getByRole('button', { name: 'Keep editing' }), { timeout: 20_000 });

      // Discard leaves.
      await press(device.touch, page.getByRole('button', { name: 'Cancel' }), { timeout: 20_000 });
      await press(device.touch, question.getByRole('button', { name: 'Discard' }), { timeout: 20_000 });
      await expect(page).not.toHaveURL(new RegExp(`${form.path.replace('/', '\\/')}$`), { timeout: 15_000 });

      expect(nativeDialogs, 'no browser dialog was raised').toEqual([]);
    } finally {
      await keepSession(page, session).catch(() => {});
    }
  });
}
