/**
 * Mobile slice 38 (KB-05, A11Y-07): the four create forms move with Next/Done and land on the
 * first error. `lead-new`, `customer-new`, `job-new`, `invoice-new`, on every device project.
 *
 * - First Name carries the Next action key.
 * - The A11Y-07 empty-form submit: with the submit button scrolled into view, pressing it focuses
 *   First Name (the first invalid field), which is then inside the viewport and not covered by a
 *   sticky bar (the element at its centre is the field), is aria-invalid, and names its message
 *   ("Enter a first name or a company name") through aria-describedby. No create request leaves.
 * - A failed submit while First Name is already fully in view does not move the page: the document
 *   scroll position and the top bar stay where they were (in landscape the page has a few pixels
 *   of slack, and centring the field used to scroll it by 20px and clip the top bar).
 * - On touch projects, Return on First Name moves focus to Last Name and sends nothing. The
 *   desktop control keeps Return-to-submit (it is only checked that nothing is sent).
 *
 * It writes nothing: every submit is refused by the form before any request.
 */
import { expect, type Page } from '@playwright/test';
import { gateDevice } from './devices';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';

const selected = new Set(selectStates().map((s) => s.id));

const FORMS = [
  { id: 'lead-new', path: '/leads/new', submit: 'Create Lead' },
  { id: 'customer-new', path: '/customers/new', submit: 'Create Customer' },
  { id: 'job-new', path: '/jobs/new', submit: 'Create Job' },
  { id: 'invoice-new', path: '/invoices/new', submit: 'Continue' },
] as const;

const MESSAGE = 'Enter a first name or a company name';
const CREATE_POST = /\/api\/(leads|jobs|customers|invoices)\b/;

/** What a screen reader gets from the focused element, and where it sits. */
const focused = (page: Page) =>
  page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    const vh = window.visualViewport?.height ?? window.innerHeight;
    const vw = window.visualViewport?.width ?? window.innerWidth;
    const hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    const description = (el.getAttribute('aria-describedby') ?? '')
      .split(/\s+/)
      .filter(Boolean)
      .map((id) => document.getElementById(id)?.textContent?.trim() ?? '')
      .join(' ');
    return {
      label: el.id ? document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent?.trim() ?? '' : '',
      placeholder: el.getAttribute('placeholder'),
      invalid: el.getAttribute('aria-invalid'),
      description,
      inView: r.top >= 0 && r.bottom <= vh && r.left >= 0 && r.right <= vw,
      uncovered: !!hit && (hit === el || el.contains(hit)),
    };
  });

/** Where the document is scrolled and where the app top bar sits. */
const pageOffset = (page: Page) =>
  page.evaluate(() => ({
    scrollY: Math.round(window.scrollY),
    headerTop: Math.round(document.querySelector('header')?.getBoundingClientRect().top ?? 0),
  }));

test.describe('form flow (mobile slice 38)', () => {
  for (const form of FORMS) {
    test(`${form.id}: Next on the fields, and an empty submit lands on First Name`, async ({ page, session }, testInfo) => {
      test.skip(!selected.has(form.id), `${form.id} not selected`);
      const device = gateDevice(testInfo.project.name);
      const notes: string[] = [];
      await signIn(page, session, notes);
      const posts: string[] = [];
      page.on('request', (r) => {
        if (r.method() === 'POST' && CREATE_POST.test(r.url())) posts.push(r.url());
      });
      try {
        await page.goto(form.path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await settle(page, notes);
        const main = page.locator('main');
        const first = main.getByLabel(/^First Name/).first();
        await expect(first).toBeVisible();
        await expect(first).toHaveAttribute('enterkeyhint', 'next');

        // First Name is in view on arrival: a failed submit must leave the page exactly where it is.
        const inViewOnArrival = await first.evaluate((el) => {
          const r = el.getBoundingClientRect();
          return r.top >= 0 && r.bottom <= window.innerHeight;
        });
        const arrival = await pageOffset(page);
        await first.evaluate((el) => (el as HTMLInputElement).form?.requestSubmit());
        await expect(first).toBeFocused();
        await expect(first).toHaveAttribute('aria-invalid', 'true');
        if (inViewOnArrival) {
          expect(await pageOffset(page), 'a failed submit does not move a page whose field is in view').toEqual(arrival);
        }

        if (device.touch) {
          await first.tap();
          await page.keyboard.press('Enter');
          await expect(main.getByLabel(/^Last Name/).first()).toBeFocused();
        }

        const submit = page.getByRole('button', { name: form.submit, exact: true });
        await submit.scrollIntoViewIfNeeded();
        await submit.click();
        await expect(first).toBeFocused();
        await expect
          .poll(() => focused(page).then((f) => f && { inView: f.inView, uncovered: f.uncovered }), { timeout: 5_000 })
          .toEqual({ inView: true, uncovered: true });
        const f = await focused(page);
        expect(f?.invalid).toBe('true');
        expect(f?.description).toContain(MESSAGE);
        expect(posts, 'no create request leaves the page').toEqual([]);
      } finally {
        await keepSession(page, session);
      }
    });
  }
});
