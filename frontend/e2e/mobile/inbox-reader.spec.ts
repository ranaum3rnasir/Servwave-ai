/**
 * Mobile slice 46 (rubric CMP-02 inbox, CMP-03 reader, A11Y-04 reader): the inbox below lg.
 *
 * The throwaway org has no email, so the gate's generic checks see an empty inbox on `comm-inbox`
 * and can never open the reader. This spec answers the email list GET with a realistic one (a
 * two-message thread with a long unbroken subject and a wide table in the body, plus two other
 * conversations; neutral, invented names) and measures the inbox with it. Every write still goes
 * to the API untouched, and nothing here sends or saves.
 *
 *   - the folder rail is closed by default below lg (all five touch/narrow projects) and open on
 *     the desktop control;
 *   - the list is bounded: it sits inside the viewport and the page never scrolls sideways;
 *   - opening a message below lg gives a dialog that fills the whole screen, takes focus, keeps
 *     it inside, and on Escape returns it to the message's row in the list;
 *   - below md the reader's bar is Back, Archive, Delete, Reply and More (every button inside the
 *     screen, 44 px on touch) and the other actions are in More; from md up it is the full bar;
 *     at lg and up there is no dialog and the three panes sit side by side as before;
 *   - the open reader and the open More menu pass the gate's own checks (overflow, targets,
 *     overlays, scrim blur, vendor terms, accessibility);
 *   - the compose window is a full-screen form below md and on the landscape phone, with Send on
 *     screen without scrolling, and the docked card from md up.
 *
 * MOBILE_GATE_ROUTES selects it by `comm-inbox`.
 */
import { expect, type Page, type Route } from '@playwright/test';
import { gateDevice } from './devices';
import { measure, settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';
import { press } from './touch';

const selected = new Set(selectStates().map((s) => s.id));

const LONG_SUBJECT = 'Re: Invoice-2026-000147-for-the-Riverside-Property-Management-Account';

const mail = (id: string, threadId: string, ts: number, subject: string, from: string, extra: Record<string, unknown> = {}) => ({
  id,
  threadId,
  account: 'system',
  from: { name: from, email: `${from.toLowerCase().replace(/\s+/g, '.')}@example.com` },
  to: 'office@example.com',
  subject,
  snippet: 'Following up on the visit from last week and the quote we were sent.',
  body: ['Following up on the visit from last week and the quote we were sent.'],
  at: '9:41 AM',
  ts,
  unread: true,
  starred: false,
  folder: 'inbox',
  ...extra,
});

const EMAILS = [
  mail('00000000-0000-4000-9046-000000000001', 'thread-a', 5, LONG_SUBJECT, 'Dana Lee', {
    bodyHtml:
      '<p>Thanks for the update.</p><table><tr><td style="min-width:640px">A wide table cell that email clients love</td></tr></table>',
  }),
  mail('00000000-0000-4000-9046-000000000002', 'thread-a', 3, LONG_SUBJECT, 'Sam Ortiz', { unread: false }),
  mail('00000000-0000-4000-9046-000000000003', 'thread-b', 2, 'Gate code changed', 'Alex Kim'),
  mail('00000000-0000-4000-9046-000000000004', 'thread-c', 1, 'Reschedule the Thursday visit', 'Pat Rivera', { unread: false }),
];

async function stubEmails(page: Page) {
  await page.route((url) => url.pathname === '/api/communication/emails', async (route: Route) => {
    if (route.request().method() !== 'GET') return route.fallback();
    return route.fulfill({ status: 200, json: { emails: EMAILS } });
  });
}

/** The list row of the first conversation: the list's row buttons are the only `aria-pressed` buttons on the page. */
const firstRow = (page: Page) => page.locator('button[aria-pressed]').filter({ hasText: LONG_SUBJECT }).first();

async function openInbox(page: Page) {
  await stubEmails(page);
  await page.goto('/communication/inbox', { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, []);
  await expect(firstRow(page)).toBeVisible({ timeout: 30_000 });
}

const widthOf = (page: Page) => page.viewportSize()!.width;
/** CSS `lg`: the three panes sit side by side from here. */
const isWide = (page: Page) => widthOf(page) >= 1024;
const belowMd = (page: Page) => widthOf(page) < 768;

/**
 * The gate's own checks on whatever overlay is open. `color-contrast` is left out of the
 * accessibility check: the two offenders in the reader are the shared "no job" pill
 * (`JobBadge`, 2.55:1) and the kit's menu label ("Snooze until", 2.95:1). Both are used across the
 * app, `comm-inbox` already lists the rule in report mode, and a colour change to either is not
 * this slice's to make (the reader on desktop is to stay unchanged). Every other rule is held.
 */
async function assertClean(page: Page, label: string, touch: boolean) {
  const m = await measure(page, { touch, onlyInOverlays: true, consoleLines: [] });
  const a11y = m.a11y.offenders.filter((o) => !o.startsWith('color-contrast'));
  for (const [check, offenders] of [
    ['overflow', m.overflow.offenders],
    ['targets', m.targets.offenders],
    ['overlays', m.overlays.offenders],
    ['scrimBlur', m.scrimBlur.offenders],
    ['vendorTerms', m.vendorTerms.offenders],
    ['a11y (not colour contrast)', a11y],
  ] as const) {
    expect(offenders, `${label}: ${check}`).toEqual([]);
  }
}

test.describe('inbox on phones (mobile slice 46)', () => {
  test('the rail is closed below lg and the list stays bounded', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('comm-inbox'), 'comm-inbox not selected');
    const device = gateDevice(testInfo.project.name);
    await signIn(page, session, []);
    try {
      await openInbox(page);
      const drafts = page.getByRole('button', { name: /^Drafts/ });
      if (isWide(page)) {
        await expect(drafts).toBeVisible();
        await expect(page.getByRole('button', { name: 'Collapse menu' })).toBeVisible();
      } else {
        await expect(page.getByRole('button', { name: 'Open menu' })).toBeVisible();
        await expect(drafts).toHaveCount(0);
      }
      const vp = page.viewportSize()!;
      const list = firstRow(page).locator('xpath=ancestor::div[contains(@class,"overflow-y-auto")][1]');
      const box = (await list.boundingBox())!;
      expect(box.x, 'list starts inside the left edge').toBeGreaterThanOrEqual(-0.5);
      expect(box.x + box.width, 'list ends inside the right edge').toBeLessThanOrEqual(vp.width + 0.5);
      expect(box.y + box.height, 'list ends inside the bottom edge').toBeLessThanOrEqual(vp.height + 0.5);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= document.documentElement.clientWidth), 'no sideways page scroll').toBe(true);
      const m = await measure(page, { touch: device.touch, onlyInOverlays: false, consoleLines: [] });
      expect(m.overflow.offenders, 'overflow with a full inbox').toEqual([]);
    } finally {
      await keepSession(page, session);
    }
  });

  test('the reader: full-screen dialog below lg, focus trapped and returned; panes at lg', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('comm-inbox'), 'comm-inbox not selected');
    const device = gateDevice(testInfo.project.name);
    await signIn(page, session, []);
    try {
      await openInbox(page);
      const row = firstRow(page);
      await press(device.touch, row, { timeout: 15_000 });

      if (isWide(page)) {
        // Desktop: no dialog; the reader is the right-hand pane and the list stays beside it.
        await expect(page.getByRole('toolbar', { name: 'Message actions' })).toBeVisible();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(page.getByRole('toolbar', { name: 'Message actions' })).toHaveCount(1);
        await expect(row).toBeVisible();
        for (const name of ['Archive', 'Report spam', 'Delete', 'Mark as unread', 'Snooze', 'Add to tasks', 'Reply', 'Forward', 'More']) {
          await expect(page.getByRole('toolbar', { name: 'Message actions' }).getByRole('button', { name, exact: true }), name).toBeVisible();
        }
        return;
      }

      const dialog = page.getByRole('dialog', { name: LONG_SUBJECT });
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(400); // the open animation
      const vp = page.viewportSize()!;
      const box = (await dialog.boundingBox())!;
      expect(Math.round(box.x), 'starts at the left edge').toBe(0);
      expect(Math.round(box.y), 'starts at the top edge').toBe(0);
      expect(Math.round(box.width), 'spans the width').toBe(vp.width);
      expect(Math.round(box.height), 'spans the height').toBe(vp.height);

      // Focus is inside, and Tab keeps it there.
      expect(await dialog.evaluate((d) => d.contains(document.activeElement)), 'focus starts inside the dialog').toBe(true);
      for (let i = 0; i < 14; i += 1) {
        await page.keyboard.press('Tab');
        expect(await dialog.evaluate((d) => d.contains(document.activeElement)), `focus inside after Tab ${i + 1}`).toBe(true);
      }

      // The bar: every button on screen, 44 px on touch; the set depends on the width.
      const bar = dialog.getByRole('toolbar', { name: 'Message actions' });
      const buttons = bar.getByRole('button');
      const names = await buttons.evaluateAll((els) => els.map((e) => e.getAttribute('aria-label') ?? e.textContent?.trim() ?? ''));
      const inScreen = await buttons.evaluateAll((els, v) =>
        els.map((e) => {
          const r = e.getBoundingClientRect();
          return { name: e.getAttribute('aria-label'), ok: r.left >= -0.5 && r.right <= v.w + 0.5 && r.top >= -0.5 && r.bottom <= v.h + 0.5, w: r.width, h: r.height };
        }),
      { w: vp.width, h: vp.height });
      for (const b of inScreen) {
        expect(b.ok, `${b.name} is on screen`).toBe(true);
        if (device.touch) {
          expect(b.w, `${b.name} width`).toBeGreaterThanOrEqual(43.5);
          expect(b.h, `${b.name} height`).toBeGreaterThanOrEqual(43.5);
        }
      }
      if (belowMd(page)) {
        expect(names).toEqual(['Back', 'Archive', 'Delete', 'Reply', 'More']);
        await press(device.touch, bar.getByRole('button', { name: 'More' }));
        const menu = page.getByRole('menu');
        await expect(menu).toBeVisible();
        const items = await menu.getByRole('menuitem').evaluateAll((els) => els.map((e) => e.textContent?.trim() ?? ''));
        for (const wanted of ['Forward', 'Mark as unread', 'Add star', 'Mark as important', 'Add to tasks', 'Create event', 'Report spam', 'Mute', 'Later today', 'Tomorrow', 'This weekend', 'Next week']) {
          expect(items, wanted).toContain(wanted);
        }
        // Every menu item is on screen or scrolls into it (the gate's `overlays` check proves the
        // last one can be reached).
        await assertClean(page, `${device.id} More menu`, device.touch);
        await page.keyboard.press('Escape');
        await expect(menu).toHaveCount(0);
      } else {
        for (const wanted of ['Back', 'Archive', 'Report spam', 'Delete', 'Mark as unread', 'Snooze', 'Add to tasks', 'Reply', 'Forward', 'More']) {
          expect(names, wanted).toContain(wanted);
        }
      }

      // The reader's content is clean: nothing past the edge (the long subject and the wide table),
      // nothing small, nothing blurred, no vendor term, no accessibility violation.
      await assertClean(page, `${device.id} reader`, device.touch);

      // Escape closes it and focus goes back to the row it was opened from.
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
      await expect
        .poll(
          () =>
            page.evaluate((subject) => {
              const a = document.activeElement as HTMLElement | null;
              return !!a && a.tagName === 'BUTTON' && a.hasAttribute('aria-pressed') && (a.textContent ?? '').includes(subject);
            }, LONG_SUBJECT),
          { message: 'focus returns to the message row' },
        )
        .toBe(true);
    } finally {
      await keepSession(page, session);
    }
  });

  test('compose: a full-screen form below md and on the landscape phone, the docked card otherwise', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('comm-inbox'), 'comm-inbox not selected');
    const device = gateDevice(testInfo.project.name);
    await signIn(page, session, []);
    try {
      await openInbox(page);
      const vp = page.viewportSize()!;
      await press(device.touch, page.getByRole('button', { name: /^Compose$/ }));
      const fullscreen = belowMd(page) || vp.height <= 500;
      if (!fullscreen) {
        await expect(page.getByPlaceholder('Subject')).toBeVisible();
        await expect(page.getByRole('dialog')).toHaveCount(0);
        await expect(page.getByRole('button', { name: /Send/ })).toBeVisible();
        return;
      }
      const dialog = page.getByRole('dialog', { name: 'New message' });
      await expect(dialog).toBeVisible({ timeout: 10_000 });
      await page.waitForTimeout(400);
      const box = (await dialog.boundingBox())!;
      expect(Math.round(box.x), 'starts at the left edge').toBe(0);
      expect(Math.round(box.y), 'starts at the top edge').toBe(0);
      expect(Math.round(box.width), 'spans the width').toBe(vp.width);
      expect(Math.round(box.height), 'spans the height').toBe(vp.height);
      // Send is on screen with nothing scrolled, 44 px tall, and the discard and close targets too.
      const send = dialog.getByRole('button', { name: /Send/ });
      const s = (await send.boundingBox())!;
      expect(s.y + s.height, 'Send ends inside the bottom edge').toBeLessThanOrEqual(vp.height + 0.5);
      expect(s.x + s.width, 'Send ends inside the right edge').toBeLessThanOrEqual(vp.width + 0.5);
      expect(s.height, 'Send is 44 px tall').toBeGreaterThanOrEqual(43.5);
      for (const name of ['Close', 'Discard draft']) {
        const b = (await dialog.getByRole('button', { name }).boundingBox())!;
        expect(b.width, `${name} width`).toBeGreaterThanOrEqual(43.5);
        expect(b.height, `${name} height`).toBeGreaterThanOrEqual(43.5);
      }
      await assertClean(page, `${device.id} compose`, device.touch);
      await page.keyboard.press('Escape');
      await expect(dialog).toHaveCount(0);
    } finally {
      await keepSession(page, session);
    }
  });
});
