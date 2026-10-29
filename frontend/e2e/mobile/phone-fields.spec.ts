/**
 * Mobile slice 36 (KB-02): every phone field uses the phone input, without losing any stored number.
 *
 * - `lead-new`, `job-new`, `invoice-new`, `customer-new`: the customer's Phone is a telephone field
 *   (tel type, telephone keypad) with personal autofill off (it records a customer's number, so the
 *   browser must not offer the staff member's own).
 * - `settings-profile` (Phone), `settings-company` (Primary Phone): telephone fields WITH phone
 *   autofill - the staff member's own number, the company's number.
 * - On each of those, typing behaves as the input promises at runtime: "5125550147" shows
 *   "(512) 555-0147" exactly as before, "+1 512 555 0147" shows the same ten digits (the old mask
 *   kept "(151) 255-5014"), and "+44 7700 900123" stays exactly as typed with no +1 added.
 *
 * The dialogs (users invite and edit, locations, vendors, branches, block list, call flows, numbers,
 * texting, dialer) are covered by the source guard (src/__tests__/input-guards/phone-field.guard.test.ts)
 * and the component test, not opened here.
 *
 * Runs with the gate (same projects, same session slots); MOBILE_GATE_ROUTES selects it by the
 * route it opens. It writes nothing: no form is submitted, and every typed value is cleared.
 */
import { expect, type Locator, type Page } from '@playwright/test';
import { settle } from './measure';
import { selectStates } from './routes';
import { keepSession, signIn, test } from './session';

const selected = new Set(selectStates().map((s) => s.id));

const attrs = (l: Locator) =>
  l.evaluate((el) => ({
    type: el.getAttribute('type'),
    inputmode: el.getAttribute('inputmode'),
    autocomplete: el.getAttribute('autocomplete'),
  }));

/** Replaces the field's value as a user would (select all, type), and reads what it shows. */
async function typeInto(field: Locator, text: string): Promise<string> {
  await field.fill('');
  await field.pressSequentially(text, { delay: 5 });
  return field.inputValue();
}

const FORMS: Array<{ id: string; path: string; label: string | RegExp; autocomplete: string }> = [
  { id: 'lead-new', path: '/leads/new', label: 'Phone', autocomplete: 'off' },
  { id: 'job-new', path: '/jobs/new', label: 'Phone', autocomplete: 'off' },
  { id: 'invoice-new', path: '/invoices/new', label: 'Phone', autocomplete: 'off' },
  { id: 'customer-new', path: '/customers/new', label: 'Phone', autocomplete: 'off' },
  { id: 'settings-profile', path: '/settings/profile', label: 'Phone', autocomplete: 'tel' },
  { id: 'settings-company', path: '/settings/company', label: 'Primary Phone', autocomplete: 'tel' },
];

async function open(page: Page, path: string, notes: string[]) {
  await page.goto(path, { waitUntil: 'domcontentloaded', timeout: 45_000 });
  await settle(page, notes);
}

test.describe('phone fields (mobile slice 36)', () => {
  for (const form of FORMS) {
    test(`${form.id}: the ${String(form.label)} field is the phone input and keeps every digit`, async ({ page, session }) => {
      test.skip(!selected.has(form.id), `${form.id} not selected`);
      const notes: string[] = [];
      await signIn(page, session, notes);
      try {
        await open(page, form.path, notes);
        const phone = page.locator('main').getByLabel(form.label, { exact: true }).first();
        await expect(phone).toBeVisible({ timeout: 20_000 });
        expect(await attrs(phone)).toEqual({ type: 'tel', inputmode: 'tel', autocomplete: form.autocomplete });

        expect(await typeInto(phone, '5125550147')).toBe('(512) 555-0147');
        expect(await typeInto(phone, '+1 512 555 0147')).toBe('(512) 555-0147');
        expect(await typeInto(phone, '+44 7700 900123')).toBe('+44 7700 900123');
        await phone.fill('');
      } finally {
        await keepSession(page, session);
      }
    });
  }
});
