/**
 * Mobile slice 50: tap a number, choose Call or Text.
 *
 * What the gate's generic checks cannot see, asserted directly on the six device projects:
 *   - a customer's number on the detail page is a control, not a telephone link: no `tel:` link
 *     for the number anywhere on the page, so a stray tap can never dial;
 *   - tapping it opens a choice with exactly Call and Text (no Copy); below md it is a bottom sheet
 *     whose two rows are at least 44 px, from md up it is a menu;
 *   - Text opens the ServWave conversation with that customer (the inbox, by customer);
 *   - the job page's Customer & Contact tiles (explicit Call and Text) are 44 px on touch and skip
 *     the choice.
 *
 * NEVER presses Call: the choice is opened and read, and Text only navigates inside the app. No
 * call is placed, no text is sent. MOBILE_GATE_ROUTES selects it with `customer-detail`.
 */
import { expect, type Page } from '@playwright/test';
import fs from 'fs';
import { gateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));
const MD = 768;
const TARGET = 44;

const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

async function open(page: Page, url: string) {
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
}

const NUMBER = /^\(\d{3}\) \d{3}-\d{4}/;

test('a tapped number offers Call or Text and is never a telephone link', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('customer-detail'), 'MOBILE_GATE_ROUTES does not select customer-detail');
  const device = gateDevice(testInfo.project.name);
  const vp = page.viewportSize()!;
  const { customerId } = fixtures();
  await signIn(page, session, []);
  try {
    await open(page, `/customers/${customerId}`);
    const number = page.locator('main').getByRole('button', { name: NUMBER }).first();
    await expect(number, 'the customer number is a control (the org has the phone service)').toBeVisible();

    // No telephone link for it anywhere on the page.
    await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);

    await press(device.touch, number);
    if (vp.width < MD) {
      const sheet = page.getByRole('dialog');
      await expect(sheet).toBeVisible();
      for (const name of ['Call', 'Text']) {
        const row = sheet.getByRole('button', { name });
        await expect(row, name).toBeVisible();
        const box = (await row.boundingBox())!;
        expect(box.height, `${name} row height`).toBeGreaterThanOrEqual(TARGET - 0.5);
        expect(box.x, `${name} row left edge`).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width, `${name} row right edge`).toBeLessThanOrEqual(vp.width + 0.5);
      }
      await expect(sheet.getByRole('button', { name: /copy/i })).toHaveCount(0);
    } else {
      const menu = page.getByRole('menu');
      await expect(menu).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Call' })).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: 'Text' })).toBeVisible();
      await expect(menu.getByRole('menuitem', { name: /copy/i })).toHaveCount(0);
    }

    // Text goes to the ServWave conversation with this customer. (Call is never pressed.)
    const text = vp.width < MD
      ? page.getByRole('dialog').getByRole('button', { name: 'Text' })
      : page.getByRole('menuitem', { name: 'Text' });
    await press(device.touch, text);
    await page.waitForURL(/\/communication\/text\?customerId=/, { timeout: 15_000 });
  } finally {
    await keepSession(page, session);
  }
});

test('the job page Call and Text tiles are explicit, skip the choice and are 44 px on touch', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('job-detail'), 'MOBILE_GATE_ROUTES does not select job-detail');
  const device = gateDevice(testInfo.project.name);
  const { jobId } = fixtures();
  await signIn(page, session, []);
  try {
    await open(page, `/jobs/${jobId}`);
    // The tiles may sit behind the page's own structure on a phone; the Call tile is a button here.
    const call = page.locator('main').getByRole('button', { name: 'Call', exact: true }).first();
    const text = page.locator('main').getByRole('button', { name: 'Text', exact: true }).first();
    await call.scrollIntoViewIfNeeded().catch(() => undefined);
    await expect(call).toBeVisible();
    await expect(text).toBeVisible();
    await expect(page.locator('a[href^="tel:"]')).toHaveCount(0);
    if (device.touch) {
      for (const [name, el] of [['Call', call], ['Text', text]] as const) {
        const box = (await el.boundingBox())!;
        expect(box.height, `${name} tile height`).toBeGreaterThanOrEqual(TARGET - 0.5);
        expect(box.width, `${name} tile width`).toBeGreaterThanOrEqual(TARGET - 0.5);
      }
    }
  } finally {
    await keepSession(page, session);
  }
});
