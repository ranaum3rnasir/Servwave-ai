/**
 * An admin sends a password reset from Users & Teams, end to end (password reset spec §7 and §8,
 * slice 07).
 *
 * Runs against THROWAWAY orgs minted for this file through the E2E test door
 * (backend/src/lib/e2e-org.ts). Every password is random, generated at run time: the org admin's by
 * the backend, the staff member's here. The shared suite admin and the staging test account are
 * never touched. Both orgs are torn down after.
 *
 * The reset link is read back from the email provider's API (helpers/resend-assert.ts). Opt-in like
 * the other email specs: needs E2E_ASSERT_EMAILS=1 and RESEND_API_KEY in the shell, the backend with
 * E2E_TEST_DOORS=true and a working mailer, and FRONTEND_URL pointing at this frontend. The link and
 * its token are never printed.
 *
 * Covers: the admin confirms "Send password reset" on a staff member with a login and sees "Reset
 * link sent to {email}."; the staff member gets the reset email, sets their own password, and the
 * one the admin created no longer works; a role without Edit users gets 403; a user in another org
 * gets 404; a fourth link within 15 minutes is refused and sends nothing.
 */
import { test, expect, request, type APIRequestContext, type Page } from '@playwright/test';
import { randomBytes } from 'crypto';

import { emailsEnabled, findRecentEmail, getEmailHtml } from '../../helpers/resend-assert';

const BACKEND = process.env.E2E_BACKEND_URL || 'http://localhost:3000';
const SUBJECT = 'Reset your ServWave password';
const EMAIL_DOMAIN = 'e2e-qa.invalid';

// The browser signs in as this file's own org admin, never with the suite's stored session.
test.use({ storageState: { cookies: [], origins: [] } });
test.describe.configure({ mode: 'serial' });
test.skip(!emailsEnabled(), 'Opt-in: set E2E_ASSERT_EMAILS=1 and RESEND_API_KEY (see helpers/resend-assert.ts).');

interface ProvisionedOrg {
  organizationId: string;
  adminEmail: string;
  adminPassword: string;
  adminUserId: string;
  runId: string;
}

let anon: APIRequestContext;
let org: ProvisionedOrg;
let otherOrg: ProvisionedOrg;
let staff: { id: string; email: string; firstName: string; lastName: string; password: string };
const sentIds: string[] = [];

const newSecret = () => randomBytes(18).toString('base64url');

async function bearerFor(email: string, password: string): Promise<APIRequestContext> {
  const res = await anon.post('/api/auth/login', { data: { email, password } });
  const body = await res.json();
  expect(res.status(), 'sign in for the API').toBe(200);
  return request.newContext({ baseURL: BACKEND, extraHTTPHeaders: { Authorization: `Bearer ${body.session.access_token}` } });
}

async function signInStatus(email: string, password: string): Promise<number> {
  return (await anon.post('/api/auth/login', { data: { email, password } })).status();
}

async function provision(): Promise<ProvisionedOrg> {
  const res = await anon.post('/api/test/provision-org');
  expect(res.status(), 'provision-org').toBe(200);
  return res.json();
}

/** The reset link inside the email, re-pointed at the frontend under test. Never logged. */
function resetPathFrom(html: string): string {
  const match = html.match(/href="([^"]*\/reset-password\?token=[^"]+)"/);
  expect(match, 'the email carries a reset-password link').not.toBeNull();
  const url = new URL(match![1].replace(/&amp;/g, '&'));
  return url.pathname + url.search;
}

async function signInInBrowser(page: Page, email: string, password: string) {
  await page.goto('/login');
  await expect(page.getByRole('heading', { name: 'Sign In' })).toBeVisible();
  await page.locator('#email').fill(email);
  await page.locator('#password').fill(password);
  await page.getByRole('button', { name: 'Sign In', exact: true }).click();
  await page.waitForURL((url) => !url.pathname.includes('/login'), { timeout: 20_000 });
}

test.beforeAll(async () => {
  anon = await request.newContext({ baseURL: BACKEND });
  org = await provision();
  otherOrg = await provision();

  // A staff member with a login, made by the org admin. Technician: no Edit users.
  staff = {
    id: '',
    email: `staff-${org.runId}@${EMAIL_DOMAIN}`,
    firstName: 'Reset',
    lastName: `Target ${org.runId}`,
    password: newSecret(),
  };
  const admin = await bearerFor(org.adminEmail, org.adminPassword);
  const created = await admin.post('/api/users', {
    data: { email: staff.email, password: staff.password, first_name: staff.firstName, last_name: staff.lastName, role: 'TECHNICIAN' },
  });
  expect(created.status(), 'create the staff member').toBe(201);
  staff.id = (await created.json()).user.id;
  await admin.dispose();
});

test.afterAll(async () => {
  for (const o of [org, otherOrg]) {
    if (o?.organizationId) await anon.post('/api/test/teardown-org', { data: { organizationId: o.organizationId, auth_sweep: 'org' } });
  }
  await anon?.dispose();
});

test('an admin sends a reset link from Users & Teams, and the person sets their own password', async ({ page }) => {
  // A polled email (up to 60 s) plus sign-in and two page round trips.
  test.setTimeout(180_000);
  await signInInBrowser(page, org.adminEmail, org.adminPassword);
  await page.goto('/settings/users');

  const name = `${staff.firstName} ${staff.lastName}`;
  const row = page.getByRole('row').filter({ hasText: name });
  await row.getByRole('button', { name: 'Send password reset' }).click();

  const dialog = page.getByRole('dialog');
  await expect(dialog).toContainText(
    `Send a password reset link to ${name} at ${staff.email}? Their current password keeps working until they set a new one.`,
  );
  const since = Date.now();
  await dialog.getByRole('button', { name: 'Send link' }).click();
  await expect(page.getByText(`Reset link sent to ${staff.email}.`)).toBeVisible();
  await expect(dialog).toBeHidden();

  const sent = await findRecentEmail({ subjectIncludes: SUBJECT, to: staff.email, sinceMs: since, timeoutMs: 60_000 });
  expect(sent, 'one reset email within a minute').not.toBeNull();
  sentIds.push(sent!.id);
  const html = await getEmailHtml(sent!.id);
  expect(html).not.toBeNull();
  expect(html!).not.toMatch(/supabase|gotrue|resend|vercel/i);

  // Until they use the link, the password they had still works.
  expect(await signInStatus(staff.email, staff.password)).toBe(200);

  // The staff member, signed out, opens the link and chooses their own password.
  await page.context().clearCookies();
  await page.evaluate(() => window.localStorage.clear());
  await page.goto(resetPathFrom(html!));
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  expect(page.url()).not.toContain('token=');
  const chosen = newSecret();
  await page.getByLabel('New password', { exact: true }).fill(chosen);
  await page.getByLabel('Confirm new password', { exact: true }).fill(chosen);
  await page.getByRole('button', { name: 'Update password' }).click();
  await page.waitForURL((url) => url.pathname === '/login' && url.searchParams.get('reset') === '1');

  expect(await signInStatus(staff.email, chosen)).toBe(200);
  expect(await signInStatus(staff.email, staff.password)).toBe(401);
  staff.password = chosen;
});

test('a role without Edit users gets 403, and no email goes out', async () => {
  const tech = await bearerFor(staff.email, staff.password);
  const since = Date.now();

  const res = await tech.post(`/api/users/${org.adminUserId}/password-reset`);

  expect(res.status()).toBe(403);
  await tech.dispose();
  expect(
    await findRecentEmail({ subjectIncludes: SUBJECT, to: org.adminEmail, sinceMs: since, timeoutMs: 15_000, skewMs: 0 }),
  ).toBeNull();
});

test('a user in another organization is not found, and no email goes out', async () => {
  const admin = await bearerFor(org.adminEmail, org.adminPassword);
  const since = Date.now();

  const res = await admin.post(`/api/users/${otherOrg.adminUserId}/password-reset`);

  expect(res.status()).toBe(404);
  await admin.dispose();
  expect(
    await findRecentEmail({ subjectIncludes: SUBJECT, to: otherOrg.adminEmail, sinceMs: since, timeoutMs: 15_000, skewMs: 0 }),
  ).toBeNull();
});

test('a fourth link to the same person within 15 minutes is refused and sends nothing', async () => {
  // Two polled sends (up to 60 s each) plus a 20 s absence window.
  test.setTimeout(180_000);
  const admin = await bearerFor(org.adminEmail, org.adminPassword);
  // The first test sent one link. Two more reach the limit of three.
  for (let i = 0; i < 2; i++) {
    const since = Date.now();
    const res = await admin.post(`/api/users/${staff.id}/password-reset`);
    expect(res.status()).toBe(200);
    expect(await res.json()).toEqual({ ok: true, email: staff.email });
    const row = await findRecentEmail({ subjectIncludes: SUBJECT, to: staff.email, sinceMs: since, timeoutMs: 60_000, excludeIds: sentIds });
    expect(row, `link ${i + 2} of 3 is sent`).not.toBeNull();
    sentIds.push(row!.id);
  }

  const since = Date.now();
  const refused = await admin.post(`/api/users/${staff.id}/password-reset`);
  await admin.dispose();

  expect(refused.status()).toBe(429);
  const body = await refused.json();
  expect(body.code).toBe('reset_link_limit');
  expect(JSON.stringify(body)).not.toMatch(/supabase|gotrue|resend|vercel|token/i);
  expect(
    await findRecentEmail({ subjectIncludes: SUBJECT, to: staff.email, sinceMs: since, timeoutMs: 20_000, skewMs: 0, excludeIds: sentIds }),
  ).toBeNull();
});
