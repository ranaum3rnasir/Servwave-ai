/**
 * Mobile slice 23 (KB-03, the search half of KB-05): the right keyboard and autofill.
 *
 * - `lead-new`, `job-new`, `invoice-new`: the customer block's Email field is an email input at
 *   runtime (email type and keyboard, nothing capitalised or spell-checked, and no offer of the
 *   staff member's own address, because it records a customer's). First name capitalises words.
 * - `leads`: the list's search field is a search field with the Search action key.
 * - `job-detail`: the Notes composer's "Cmd + Enter" hint is hidden on touch projects and shown on
 *   the desktop control; with or without it, the Add Note button keeps the row's right edge. The
 *   same holds for the overview's Job Notes composer ("⌘↵ to add"; staging fix 1 round 1).
 * - `lead-new`, `job-new`: an invalid email on submit shows the app's own "Invalid email", not the
 *   browser's popup (the form is noValidate; staging fix 1).
 * - `customer-new`, `login`: the same for the customer form and the sign-in form, whose Email was
 *   already an email field (slice F23a). The field never reports `invalid`, the event the browser
 *   fires exactly when it shows its popup, and the app's own message renders.
 *
 * Runs with the gate (same projects, same session slots); MOBILE_GATE_ROUTES selects it by the
 * route it opens. It writes nothing: the only submits carry an invalid email, which the form
 * refuses before any request (the test asserts no POST), and no note is posted.
 */
import { expect, type Locator } from '@playwright/test';
import fs from 'fs';
import { gateDevice } from './devices';
import { settle } from './measure';
import { FIXTURES_FILE } from './paths';
import { selectStates, type GateFixtures } from './routes';
import { keepSession, signIn, test } from './session';

const selected = new Set(selectStates().map((s) => s.id));
const fixtures = (): GateFixtures => JSON.parse(fs.readFileSync(FIXTURES_FILE, 'utf8'));

const attrs = (l: Locator) =>
  l.evaluate((el) => {
    const pick = (n: string) => el.getAttribute(n);
    return {
      type: pick('type'),
      inputmode: pick('inputmode'),
      autocomplete: pick('autocomplete'),
      autocapitalize: pick('autocapitalize'),
      spellcheck: pick('spellcheck'),
      enterkeyhint: pick('enterkeyhint'),
    };
  });

const CUSTOMER_FORMS: Array<[string, string]> = [
  ['lead-new', '/leads/new'],
  ['job-new', '/jobs/new'],
  ['invoice-new', '/invoices/new'],
];

test.describe('field kinds (mobile slice 23)', () => {
  for (const [id, path] of CUSTOMER_FORMS) {
    test(`${id}: the customer email is an email field, first name capitalises words`, async ({ page, session }) => {
      test.skip(!selected.has(id), `${id} not selected`);
      const notes: string[] = [];
      await signIn(page, session, notes);
      try {
        await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await settle(page, notes);
        const email = page.locator('main').getByLabel('Email', { exact: true }).first();
        await expect(email).toBeVisible();
        expect(await attrs(email)).toEqual({
          type: 'email',
          inputmode: 'email',
          autocomplete: 'off',
          autocapitalize: 'none',
          spellcheck: 'false',
          // The kind names no action key; the form gives it Next (slice 38: fields in order).
          enterkeyhint: 'next',
        });
        const first = page.locator('main').getByLabel(/^First Name/).first();
        expect(await attrs(first)).toMatchObject({ type: 'text', autocapitalize: 'words', autocomplete: 'off', spellcheck: 'false' });
      } finally {
        await keepSession(page, session);
      }
    });
  }

  for (const [id, path, submit] of [
    ['lead-new', '/leads/new', 'Create Lead'],
    ['job-new', '/jobs/new', 'Create Job'],
  ] as const) {
    test(`${id}: an invalid email shows the app's own message, not the browser's popup`, async ({ page, session }) => {
      test.skip(!selected.has(id), `${id} not selected`);
      const notes: string[] = [];
      await signIn(page, session, notes);
      const posts: string[] = [];
      page.on('request', (r) => {
        if (r.method() === 'POST' && /\/api\/(leads|jobs|customers)\b/.test(r.url())) posts.push(r.url());
      });
      try {
        await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await settle(page, notes);
        const main = page.locator('main');
        const email = main.getByLabel('Email', { exact: true }).first();
        expect(await email.evaluate((el) => (el as HTMLInputElement).form?.noValidate ?? null)).toBe(true);
        await main.getByLabel(/^First Name/).first().fill('Zzqa');
        await email.fill('abc');
        await main.getByRole('button', { name: submit, exact: true }).click();
        await expect(main.getByText('Invalid email', { exact: true })).toBeVisible();
        expect(posts, 'no create request leaves the page').toEqual([]);
      } finally {
        await keepSession(page, session);
      }
    });
  }

  for (const [id, path, submit, message, anon] of [
    ['customer-new', '/customers/new', 'Create Customer', 'Enter a valid email address', false],
    ['login', '/login', 'Sign In', 'Enter a valid email', true],
  ] as const) {
    test(`${id}: an invalid email shows the app's own message, not the browser's popup`, async ({ page, session }) => {
      test.skip(!selected.has(id), `${id} not selected`);
      const notes: string[] = [];
      if (!anon) await signIn(page, session, notes);
      const posts: string[] = [];
      page.on('request', (r) => {
        if (r.method() === 'POST' && /\/api\/(customers|auth)\b/.test(r.url())) posts.push(r.url());
      });
      try {
        await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
        await settle(page, notes);
        const email = page.locator('input[name="email"]').first();
        await expect(email).toBeVisible();
        await email.evaluate((el) => {
          (window as unknown as { __browserPopup: boolean }).__browserPopup = false;
          el.addEventListener('invalid', () => { (window as unknown as { __browserPopup: boolean }).__browserPopup = true; });
        });
        if (anon) await page.locator('input[name="password"]').fill('x');
        else await page.getByPlaceholder('Jane').first().fill('Zzqa');
        await email.fill('abc');
        await page.getByRole('button', { name: submit, exact: true }).first().click();
        await expect(page.getByText(message, { exact: true }).first()).toBeVisible();
        expect(await page.evaluate(() => (window as unknown as { __browserPopup: boolean }).__browserPopup), 'the browser showed its own popup').toBe(false);
        expect(posts, 'no request leaves the page').toEqual([]);
      } finally {
        if (!anon) await keepSession(page, session);
      }
    });
  }

  test('leads: the list search field has the Search action key', async ({ page, session }) => {
    test.skip(!selected.has('leads'), 'leads not selected');
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      await page.goto('/leads', { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      const search = page.locator('main input[placeholder^="Search"]').first();
      await expect(search).toBeAttached();
      expect(await attrs(search)).toMatchObject({ type: 'search', inputmode: 'search', enterkeyhint: 'search', autocapitalize: 'none', spellcheck: 'false' });
    } finally {
      await keepSession(page, session);
    }
  });

  test('job-detail: the Cmd + Enter hint is not shown on touch', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('job-detail'), 'job-detail not selected');
    const device = gateDevice(testInfo.project.name);
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      await page.goto(`/jobs/${fixtures().jobId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      await page.getByRole('tab', { name: 'Notes' }).click();
      const hint = page.getByText('Cmd + Enter to add', { exact: true });
      await expect(hint).toBeAttached();
      if (device.touch) await expect(hint, `the hint on ${device.id}`).toBeHidden();
      else await expect(hint, 'the hint on the desktop control').toBeVisible();
      // Hiding the hint must not drag the button to the left of its row.
      const button = page.getByRole('button', { name: 'Add Note', exact: true });
      const [right, rowRight] = await button.evaluate((el) => [
        el.getBoundingClientRect().right,
        (el.parentElement as HTMLElement).getBoundingClientRect().right,
      ]);
      expect(Math.abs(rowRight - right), `Add Note sits at its row's right edge on ${device.id}`).toBeLessThanOrEqual(1);
    } finally {
      await keepSession(page, session);
    }
  });

  test('job-detail: the overview Job Notes composer keeps Add Note at the right edge', async ({ page, session }, testInfo) => {
    test.skip(!selected.has('job-detail'), 'job-detail not selected');
    const device = gateDevice(testInfo.project.name);
    const notes: string[] = [];
    await signIn(page, session, notes);
    try {
      await page.goto(`/jobs/${fixtures().jobId}`, { waitUntil: 'domcontentloaded', timeout: 45_000 });
      await settle(page, notes);
      // The card's own opener: a "+" on an empty card, a full-width "Add note" under a list.
      await page.getByRole('button', { name: 'Add note', exact: true }).click();
      const textarea = page.getByPlaceholder('Type internal note…');
      await expect(textarea).toBeVisible();
      const composer = textarea.locator('xpath=..');
      const hint = composer.getByText('⌘↵ to add', { exact: true });
      await expect(hint).toBeAttached();
      if (device.touch) await expect(hint, `the hint on ${device.id}`).toBeHidden();
      else await expect(hint, 'the hint on the desktop control').toBeVisible();
      // The bottom row is the parent of the hint; Add Note must end where the row ends.
      const button = composer.getByRole('button', { name: 'Add Note', exact: true });
      const [right, rowRight] = await button.evaluate(
        (el, h) => [el.getBoundingClientRect().right, (h!.parentElement as HTMLElement).getBoundingClientRect().right],
        await hint.elementHandle(),
      );
      expect(Math.abs(rowRight - right), `Add Note sits at its row's right edge on ${device.id}`).toBeLessThanOrEqual(1);
    } finally {
      await keepSession(page, session);
    }
  });
});
