/**
 * Mobile slice 52 (VP-02, PWA-02): the installed app's top bar, drawer and bottom edge clear the
 * status bar, the notch and the home indicator.
 *
 * `viewport-fit=cover` lets the page run under all three, so the shell pads for them with
 * `env(safe-area-inset-*)`. The insets are real only on a notched phone, so the Chromium projects
 * emulate them through the DevTools protocol (`Emulation.setSafeAreaInsetsOverride`): a portrait
 * phone (status bar 47, home indicator 34) and a phone held sideways (notch 47 on both sides,
 * home indicator 21). WebKit has no such override; on the WebKit projects the spec proves the half
 * it can: the meta is there and, with no inset, the frame is exactly what it was (the top bar 50 px,
 * the 9 px gutter). What only hardware shows is the real-device checklist's RD-02.
 *
 * MOBILE_GATE_ROUTES selects it by `home`.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import fs from 'fs';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test } from './session';
import { tap } from './touch';

const selected = new Set(selectStates().map((s) => s.id));

interface Insets { top: number; bottom: number; left: number; right: number }
const PORTRAIT: Insets = { top: 47, bottom: 34, left: 0, right: 0 };
const SIDEWAYS: Insets = { top: 0, bottom: 21, left: 47, right: 47 };

const isChromium = (page: Page) => page.context().browser()?.browserType().name() === 'chromium';

async function emulate(page: Page, insets: Insets) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Emulation.setSafeAreaInsetsOverride', { insets });
  // The page must really see them, or every assertion below would pass for the wrong reason.
  await page.goto('about:blank');
  await page.setContent('<div id="probe" style="padding:env(safe-area-inset-top) env(safe-area-inset-right) env(safe-area-inset-bottom) env(safe-area-inset-left)"></div>');
  const seen = await page.evaluate(() => {
    const s = getComputedStyle(document.getElementById('probe')!);
    return { top: parseFloat(s.paddingTop), bottom: parseFloat(s.paddingBottom), left: parseFloat(s.paddingLeft), right: parseFloat(s.paddingRight) };
  });
  expect(seen, 'the emulated insets reach the page').toEqual(insets);
}

async function open(page: Page) {
  await page.goto('/', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
  await expect(page.locator('[data-slot="topbar"]')).toBeVisible();
}

const trigger = (page: Page) => page.getByRole('button', { name: 'Open navigation' });
const drawerLayout = (vp: { width: number; height: number }) => vp.width < 768 || vp.height <= 500;

/** The box of every control in the top bar, as [left, top, right, bottom]. */
async function topbarControls(page: Page) {
  return page.locator('[data-slot="topbar"]').evaluate((bar) =>
    [...bar.querySelectorAll('button, a[href], input')]
      .map((e) => e.getBoundingClientRect())
      .filter((r) => r.width > 0 && r.height > 0)
      .map((r) => [r.left, r.top, r.right, r.bottom]),
  );
}

async function frame(page: Page) {
  return page.evaluate(() => {
    const bar = document.querySelector('[data-slot="topbar"]')!.getBoundingClientRect();
    const canvas = document.querySelector('[data-slot="app-canvas"]')!.getBoundingClientRect();
    return {
      barHeight: bar.height,
      canvas: { left: canvas.left, right: canvas.right, bottom: canvas.bottom },
      width: innerWidth,
      height: innerHeight,
      scrollsSideways: document.documentElement.scrollWidth > innerWidth,
    };
  });
}

test.describe('safe areas (viewport-fit=cover)', () => {
  test('the viewport meta covers the notch, and with no inset the frame is what it was', async ({ page, session }) => {
    test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
    await signIn(page, session, []);
    await open(page);
    expect(await page.locator('meta[name="viewport"]').getAttribute('content')).toContain('viewport-fit=cover');
    const f = await frame(page);
    expect(Math.round(f.barHeight), 'the top bar is its 50 px row').toBe(50);
    const phone = f.width < 768;
    expect(Math.round(f.height - f.canvas.bottom), phone ? 'the phone page runs to the bottom edge' : 'the 9 px gutter under the page').toBe(phone ? 0 : 9);
    expect(f.scrollsSideways, 'the page does not scroll sideways').toBe(false);
    await keepSession(page, session).catch(() => {});
  });

  test('portrait: the top bar clears the status bar and the page ends above the home indicator', async ({ page, session }) => {
    test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
    test.skip(!isChromium(page), 'safe-area insets can only be emulated on Chromium; RD-02 covers real WebKit devices');
    await signIn(page, session, []);
    await emulate(page, PORTRAIT);
    await open(page);
    const f = await frame(page);
    expect(Math.round(f.barHeight), 'the bar is its 50 px row plus the status bar').toBe(50 + PORTRAIT.top);
    for (const [, top, , bottom] of await topbarControls(page)) {
      expect(top, 'a top-bar control starts below the status bar').toBeGreaterThanOrEqual(PORTRAIT.top - 0.5);
      expect(bottom, 'and ends inside the bar').toBeLessThanOrEqual(PORTRAIT.top + 50 + 0.5);
    }
    expect(f.height - f.canvas.bottom, 'the page ends above the home indicator').toBeGreaterThanOrEqual(PORTRAIT.bottom - 0.5);
    await keepSession(page, session).catch(() => {});
  });

  test('portrait: the open drawer clears the status bar and the home indicator', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
    test.skip(!isChromium(page), 'safe-area insets can only be emulated on Chromium; RD-02 covers real WebKit devices');
    const device = gateDevice(testInfo.project.name);
    test.skip(!drawerLayout(page.viewportSize()!), 'the drawer layout only');
    await signIn(page, session, []);
    await emulate(page, PORTRAIT);
    await open(page);
    if (device.touch) await tap(trigger(page)); else await trigger(page).click();
    const dlg = page.getByRole('dialog', { name: 'Navigation' });
    await expect(dlg).toBeVisible();
    await page.waitForTimeout(500);
    const vp = page.viewportSize()!;
    const edges = await dlg.locator('aside[data-slot="sidebar"]').evaluate((aside) => {
      const first = aside.firstElementChild!.getBoundingClientRect();
      aside.scrollTop = aside.scrollHeight;
      const last = aside.lastElementChild!.getBoundingClientRect();
      return { firstTop: first.top, lastBottom: last.bottom };
    });
    expect(edges.firstTop, 'the first thing in the drawer starts below the status bar').toBeGreaterThanOrEqual(PORTRAIT.top - 0.5);
    expect(edges.lastBottom, 'scrolled to the end, the last thing sits above the home indicator').toBeLessThanOrEqual(vp.height - PORTRAIT.bottom + 0.5);
    await page.keyboard.press('Escape');
    await keepSession(page, session).catch(() => {});
  });

  test('sideways: the top bar, the page and the drawer keep clear of the notch', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
    test.skip(!isChromium(page), 'safe-area insets can only be emulated on Chromium; RD-02 covers real WebKit devices');
    const device = gateDevice(testInfo.project.name);
    test.skip(!device.touch, 'a phone held sideways: touch projects only');
    await page.setViewportSize({ width: 780, height: 360 });
    await signIn(page, session, []);
    await emulate(page, SIDEWAYS);
    await open(page);
    const f = await frame(page);
    for (const [left, , right] of await topbarControls(page)) {
      expect(left, 'a top-bar control starts beside the notch, not under it').toBeGreaterThanOrEqual(SIDEWAYS.left - 0.5);
      expect(right, 'and ends before the notch on the other side').toBeLessThanOrEqual(f.width - SIDEWAYS.right + 0.5);
    }
    expect(f.canvas.left, 'the page starts beside the notch').toBeGreaterThanOrEqual(SIDEWAYS.left - 0.5);
    expect(f.canvas.right, 'and ends before the notch on the other side').toBeLessThanOrEqual(f.width - SIDEWAYS.right + 0.5);
    expect(f.height - f.canvas.bottom, 'the page ends above the home indicator').toBeGreaterThanOrEqual(SIDEWAYS.bottom - 0.5);

    if (device.touch) await tap(trigger(page)); else await trigger(page).click();
    const dlg = page.getByRole('dialog', { name: 'Navigation' });
    await expect(dlg).toBeVisible();
    await page.waitForTimeout(500);
    const row = await dlg.locator('aside[data-slot="sidebar"]').evaluate((aside) => {
      const first = aside.firstElementChild!.getBoundingClientRect();
      return { left: first.left, width: first.width };
    });
    expect(row.left, 'the drawer content starts beside the notch').toBeGreaterThanOrEqual(SIDEWAYS.left - 0.5);
    await page.keyboard.press('Escape');
    await keepSession(page, session).catch(() => {});
  });

  test('portrait: the full-screen search sheet clears the status bar', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('home'), 'MOBILE_GATE_ROUTES does not select home');
    test.skip(!isChromium(page), 'safe-area insets can only be emulated on Chromium; RD-02 covers real WebKit devices');
    const device = gateDevice(testInfo.project.name);
    test.skip(!device.touch || page.viewportSize()!.width >= 768, 'the phone search sheet only');
    await signIn(page, session, []);
    await emulate(page, PORTRAIT);
    await open(page);
    const search: Locator = page.locator('[data-slot="topbar"]').getByRole('button', { name: 'Search', exact: true });
    await tap(search);
    const sheet = page.locator('[data-slot="sheet-content"]');
    await expect(sheet).toBeVisible();
    await page.waitForTimeout(400);
    const title = await sheet.getByRole('heading').first().evaluate((h) => h.getBoundingClientRect().top);
    expect(title, 'the sheet title starts below the status bar').toBeGreaterThanOrEqual(PORTRAIT.top - 0.5);
    // The Close button is absolutely placed, so padding alone leaves it under the clock.
    const closeBox = await sheet.getByRole('button', { name: 'Close' }).evaluate((b) => {
      const r = b.getBoundingClientRect();
      return { top: r.top, right: r.right };
    });
    expect(closeBox.top, 'the Close button starts below the status bar').toBeGreaterThanOrEqual(PORTRAIT.top - 0.5);
    await page.keyboard.press('Escape');
    await keepSession(page, session).catch(() => {});
  });

  // The job, lead and invoice detail pages mount a fixed right rail (Activity, Attachments) from md up;
  // below md its panel is a sheet opened from the header menu (slice 56). The rail starts at the real
  // top bar's bottom edge, which a notch grows; sideways it must keep clear of the notch.
  const DETAILS: { id: string; path: (f: GateFixtures) => string }[] = [
    { id: 'job-detail', path: (f) => `/jobs/${f.jobId}` },
    { id: 'lead-detail', path: (f) => `/leads/${f.leadId}` },
    { id: 'invoice-detail', path: (f) => `/invoices/${f.invoiceOpen.id}` },
  ];
  const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));
  const rail = (page: Page) => page.getByTestId('icon-rail');
  const railPanel = (page: Page) => page.getByTestId('icon-rail-panel');

  for (const detail of DETAILS) {
    test(`portrait: the right rail on ${detail.id} stays below the top bar and leaves its buttons tappable`, async ({ page, session }) => {
      test.skip(!selected.has(detail.id), `MOBILE_GATE_ROUTES does not select ${detail.id}`);
      test.skip(!isChromium(page), 'safe-area insets can only be emulated on Chromium; RD-02 covers real WebKit devices');
      await signIn(page, session, []);
      await emulate(page, PORTRAIT);
      await page.goto(detail.path(fixtures()), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, []);
      // No rail column on a phone: nothing to measure there, the hit-test below is the check.
      if (await rail(page).count()) {
        const barBottom = await page.locator('[data-slot="topbar"]').evaluate((b) => b.getBoundingClientRect().bottom);
        const railTop = await rail(page).evaluate((r) => r.getBoundingClientRect().top);
        expect(railTop, 'the rail starts below the (taller) top bar').toBeGreaterThanOrEqual(barBottom - 0.5);
      }
      const covered = await page.locator('[data-slot="topbar"]').evaluate((bar) =>
        [...bar.querySelectorAll('button, a[href]')]
          .map((e) => ({ e, r: e.getBoundingClientRect() }))
          .filter(({ r }) => r.width > 0 && r.height > 0)
          .filter(({ e, r }) => {
            const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
            return !hit || !(e === hit || e.contains(hit));
          })
          .map(({ e }) => e.getAttribute('aria-label') ?? e.textContent?.trim() ?? e.tagName),
      );
      expect(covered, 'no top-bar control is covered by the rail').toEqual([]);
      await keepSession(page, session).catch(() => {});
    });

    test(`sideways: the right rail on ${detail.id} keeps clear of the notch`, async ({ page, session }, testInfo) => {
      test.skip(!selected.has(detail.id), `MOBILE_GATE_ROUTES does not select ${detail.id}`);
      test.skip(!isChromium(page), 'safe-area insets can only be emulated on Chromium; RD-02 covers real WebKit devices');
      test.skip(!gateDevice(testInfo.project.name).touch, 'a phone held sideways: touch projects only');
      await page.setViewportSize({ width: 780, height: 360 });
      await signIn(page, session, []);
      await emulate(page, SIDEWAYS);
      await page.goto(detail.path(fixtures()), { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, []);
      await expect(rail(page)).toBeVisible();
      const box = await rail(page).evaluate((r) => { const b = r.getBoundingClientRect(); return { left: b.left, right: b.right }; });
      expect(box.right, 'the rail ends before the notch').toBeLessThanOrEqual(780 - SIDEWAYS.right + 0.5);
      const panelLeft = await railPanel(page).evaluate((p) => p.getBoundingClientRect().left);
      expect(panelLeft, 'the closed panel is fully off screen, no sliver in the notch zone').toBeGreaterThanOrEqual(780 - 0.5);
      await keepSession(page, session).catch(() => {});
    });
  }
});
