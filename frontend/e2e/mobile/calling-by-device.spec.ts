/**
 * Mobile slice 63: calling by device.
 *
 * The transport is chosen by the DEVICE, never the role. Asserted on the six device projects:
 *   - on a phone (a finger and a small screen: the iPhone SE, Galaxy S24, iPhone 15 and the
 *     landscape phone), choosing Call on a customer's number opens the dialer in the SAME tab as a
 *     full-screen sheet: no window is opened, no second tab exists, the URL does not change, the
 *     sheet says the user's phone rings first, sits inside the viewport and its controls are 44 px;
 *   - on a computer (the desktop control, and the iPad Mini project, whose Playwright screen is the
 *     768 px line) Call still goes to the dedicated phone tab: `window.open('/phone?dial=...',
 *     'servwave-phone')`, and the same-tab sheet stays shut.
 *
 * NEVER places a call. `window.open` is replaced before the page loads, so the desktop path records
 * the request instead of opening the phone tab (which would start the in-browser phone), and the
 * dialer's own Call button is never pressed. Choosing Call in the number's Call or Text choice only
 * opens the dialer, pre-filled. The call bar across navigation needs a call in progress, which only
 * a real call makes; it is covered by the Vitest suites and the real-device checklist (RD-13).
 *
 * MOBILE_GATE_ROUTES selects it with `customer-detail`.
 */
import { expect } from '@playwright/test';
import fs from 'fs';
import { a11yCheck } from './a11y';
import { gateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';
import { findVendorTerms } from './vendor-terms';

const selected = new Set(selectStates().map((s) => s.id));
const TARGET = 44;
const MD = 768;
/** Phones: a finger and a screen under 768 px on its short side. The rest are computers to the app. */
const PHONES = new Set(['iphone-se', 'galaxy-s24', 'iphone-15', 'landscape-phone', 'iphone-17-pro-max', 'pixel-7', 'iphone-se-landscape', 'pixel-7-landscape', 'fold-cover']);

const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));
const NUMBER = /^\(\d{3}\) \d{3}-\d{4}/;

test('Call opens the same-tab dialer on a phone and the phone tab on a computer', async ({ page, session }, testInfo) => {
  test.skip(!selected.has('customer-detail'), 'MOBILE_GATE_ROUTES does not select customer-detail');
  test.setTimeout(120_000);
  const device = gateDevice(testInfo.project.name);
  const vp = page.viewportSize()!;
  const { customerId } = fixtures();
  await signIn(page, session, []);
  try {
    // Record window.open and open nothing: the computer path must never reach the phone tab.
    await page.addInitScript(() => {
      const w = window as unknown as { __opened: string[][] };
      w.__opened = [];
      window.open = ((...args: unknown[]) => {
        w.__opened.push(args.map(String));
        return null;
      }) as typeof window.open;
    });
    await page.goto(`/customers/${customerId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
    await settle(page, []);
    const startUrl = page.url();

    const isPhone = PHONES.has(device.id);
    const detected = await page.evaluate(
      () => matchMedia('(pointer: coarse)').matches && Math.min(window.screen.width, window.screen.height) < 768,
    );
    expect(detected, `${device.id}: the app's phone check reads this device as a ${isPhone ? 'phone' : 'computer'}`).toBe(isPhone);

    const number = page.locator('main').getByRole('button', { name: NUMBER }).first();
    await expect(number, 'the customer number is a control (the org has the phone service)').toBeVisible();
    await press(device.touch, number);
    const row = vp.width < MD
      ? page.getByRole('dialog').getByRole('button', { name: 'Call' })
      : page.getByRole('menuitem', { name: 'Call' });
    await expect(row).toBeVisible();
    // Choosing Call opens the dialer pre-filled. It does not place a call: the dialer's own Call
    // button is never pressed here.
    await press(device.touch, row);

    const opened = () => page.evaluate(() => (window as unknown as { __opened: string[][] }).__opened);
    const sheet = page.getByRole('dialog', { name: 'Dialer' });

    if (isPhone) {
      await expect(sheet, 'a same-tab dialer sheet opened').toBeVisible({ timeout: 15_000 });
      expect(await opened(), 'no window or tab was opened').toEqual([]);
      expect(page.context().pages(), 'no second tab exists').toHaveLength(1);
      expect(page.url(), 'the page did not navigate').toBe(startUrl);
      await expect(sheet.getByText('Your phone will ring first, answer to connect.')).toBeVisible();
      await expect(sheet.getByLabel('Number to call'), 'the number is pre-filled').not.toHaveValue('');

      // Inside the viewport, full width, with 44 px controls.
      const box = (await sheet.boundingBox())!;
      expect(box.x, 'sheet left edge').toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width, 'sheet right edge').toBeLessThanOrEqual(vp.width + 0.5);
      expect(box.y + box.height, 'sheet bottom edge').toBeLessThanOrEqual(vp.height + 0.5);
      for (const name of ['Close dialer', '5', 'Call']) {
        const control = sheet.getByRole('button', { name, exact: true });
        await expect(control, name).toBeVisible();
        const b = (await control.boundingBox())!;
        expect(b.height, `${name} height`).toBeGreaterThanOrEqual(TARGET - 0.5);
      }
      // The dialer's number field is a text field, so it must not make iOS zoom on focus.
      const fontSize = await sheet.getByLabel('Number to call').evaluate((el) => parseFloat(getComputedStyle(el).fontSize));
      expect(fontSize, 'number field text size').toBeGreaterThanOrEqual(16);

      // No vendor name anywhere the sheet shows.
      const text = await sheet.evaluate((el) => el.innerText + '\n' + [...el.querySelectorAll('[aria-label],[placeholder],[title]')]
        .map((e) => `${e.getAttribute('aria-label') ?? ''} ${e.getAttribute('placeholder') ?? ''} ${e.getAttribute('title') ?? ''}`).join('\n'));
      expect(findVendorTerms([{ source: 'dialer sheet', text }])).toEqual([]);

      // Axe (WCAG 2.2 A and AA) on the open sheet: no violations.
      expect((await a11yCheck(page, { touch: device.touch, onlyInOverlays: true })).offenders, 'axe on the dialer sheet').toEqual([]);

      // Nothing is in progress, so Close puts it away and the page is as it was.
      await press(device.touch, sheet.getByRole('button', { name: 'Close dialer' }));
      await expect(sheet).toBeHidden();
      expect(page.url()).toBe(startUrl);
    } else {
      await expect.poll(opened, { timeout: 15_000, message: 'Call went to the dedicated phone tab' }).toHaveLength(1);
      const [url, name] = (await opened())[0]!;
      expect(name, 'the phone tab is the singleton named window').toBe('servwave-phone');
      expect(new URL(url!, 'http://localhost').pathname).toBe('/phone');
      expect(new URL(url!, 'http://localhost').searchParams.get('dial'), 'pre-filled with the number').toBeTruthy();
      await expect(sheet, 'the same-tab sheet stays shut on a computer').toHaveCount(0);
    }
  } finally {
    await keepSession(page, session);
  }
});
