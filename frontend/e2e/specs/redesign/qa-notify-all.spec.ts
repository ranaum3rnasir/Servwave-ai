import { test, expect, assertNoErrorBoundary } from '../../fixtures/gated-test';
import { ApiClient, provisionedAdmin } from '../../helpers/api-client';
import { createTech, uniquePhone } from '../../helpers/workflow-builders';

/**
 * QA validation — product-owner change of 2026-08-25 to the Event dialog's notify section.
 *
 * His five asks, verbatim in intent:
 *   1. Drop the sub-line under the "Notify customer participants" heading ("Emails everyone
 *      below with an address on file.").
 *   2. Drop the helper sentence under the Message field ("Sent as-is to anyone hearing about
 *      this for the first time… that email is fixed wording.").
 *   3. Drop the Title field's example hint ("Dave is off Thursday"). "No hints as well."
 *   4. Drop the whole "Will be emailed:" recipient manifest — it restated the participant chips
 *      a few pixels above it.
 *   5. "Only a customer will be notified about this event. I actually wanted all participants
 *      to be notified."
 *
 * (5) is the behavioural one and the only one a unit test cannot fully prove: it needs the real
 * backend to actually address a teammate at their own `User.email`. The four copy removals are
 * proven here in a real browser as well, because a unit test asserting `queryByText(...)` is
 * absent passes just as happily when the whole block failed to render.
 *
 * SCREENSHOTS: written to e2e/screenshots/notify-all/ — these are the artefact the product owner
 * asked to see before the PR ("before you create the PR, I first want to see it on the browser").
 *
 * Run-id trap (see the repo memory note): no module-scope `Math.random()`. `runId` is derived
 * lazily in `beforeAll` from the provisioned org id, which is stable across a Playwright worker
 * restart — a failing test discards the worker and re-imports every spec module.
 *
 * TWO TRAPS THIS FILE ALREADY PAID FOR, both from that same worker-restart behaviour:
 *  - `ApiClient.suffix` is a GETTER that mints a NEW value on every read
 *    (`Date.now() + Math.random()`, api-client.ts). `createTech(api)` reads it internally, so
 *    reading `api.suffix` again afterwards yields a DIFFERENT string and the roster search hunts
 *    a teammate nobody created. The tech's real display name is read back from the API instead.
 *  - `beforeAll` re-runs in the fresh worker, so a fixture keyed only on the (stable) org id
 *    collides with the one the dead worker already created — `createCustomer` 409s and every
 *    later test fails for a reason that has nothing to do with the code. The customer is keyed
 *    on a per-invocation stamp as well.
 *
 * Console-error trap: the pre-existing `POST /api/communication/phone-access` 409 logs as a bare
 * "Failed to load resource: … 409 (Conflict)" with no URL, so it is filtered by that pattern
 * rather than by path — same as qa-notify.spec.ts.
 */

import path from 'path';
import { fileURLToPath } from 'url';
const __dirname_ = path.dirname(fileURLToPath(import.meta.url));
const SHOTS = path.resolve(__dirname_, '..', '..', 'screenshots', 'notify-all');

let api: ApiClient;
let runId: string;
let techUserId: string;
/** The teammate's name AS THE ROSTER RENDERS IT — read back, never reconstructed. */
let techLabel: string;
let customerId: string;
let customerSearch: string;

test.beforeAll(async () => {
  api = await new ApiClient().init();
  runId = provisionedAdmin().organizationId.slice(0, 8);

  techUserId = await createTech(api);
  const roster = await api.raw('get', '/api/users?assignable=true');
  expect(roster.res.ok(), `GET /api/users failed: ${roster.res.status()}`).toBeTruthy();
  const tech = (roster.body.users ?? []).find((u: { id: string }) => u.id === techUserId);
  expect(tech, 'the new technician is not in the assignable roster').toBeTruthy();
  techLabel = `${tech.first_name} ${tech.last_name}`.trim();

  const stamp = Date.now().toString(36);
  customerSearch = `QANotifyAll-${runId}-${stamp}`;
  const customer = await api.createCustomer({
    first_name: customerSearch,
    last_name: 'Customer',
    email: `qa-notify-all-${runId}-${stamp}@e2e-qa.invalid`,
    phone: uniquePhone(),
  });
  customerId = customer.id;

  // A throwaway org provisions with email sending OFF, which would make every send resolve
  // 'skipped' — enough to prove the recipient was ADDRESSED, not enough to prove it 'sent'.
  // Flipped through the same authenticated route the Settings UI uses, on this org only.
  const orgPatch = await api.raw('patch', '/api/organization', { email_sending_enabled: true });
  expect(orgPatch.res.ok(), `failed to enable email sending: ${orgPatch.res.status()}`).toBeTruthy();
});

test.afterAll(async () => { await api.dispose(); });

/**
 * The one open Dialog, by its heading. EVERY locator below is scoped through this.
 *
 * Two reasons, both learned the hard way in this file's first run: the app chrome carries its
 * own "Search…" and "Message" affordances (four `getByPlaceholder(/search/i)` matches on the
 * schedule page alone), and Radix keeps a closing dialog mounted while its exit animation runs —
 * so the Edit dialog and the delete confirm are BOTH in the DOM for a moment, each with its own
 * "Notify participants" checkbox. An unscoped `getByRole('dialog')` is no better: Radix Popover
 * content keeps `role="dialog"` even while closed, and portals as a sibling.
 */
function dialogNamed(page: import('@playwright/test').Page, name: RegExp | string) {
  return page.locator('[data-slot="dialog-content"]')
    .filter({ has: page.getByRole('heading', { name }) });
}

/**
 * Screenshot of the DIALOG, not the viewport. The dialog body scrolls, so a viewport shot of a
 * long form can cut off the very block under review; and a popover that has just closed is
 * still fading over the top of it. Scrolls `anchor` into view, lets the exit animation finish,
 * then clips to the dialog.
 */
async function shotDialog(
  dlg: import('@playwright/test').Locator,
  anchor: import('@playwright/test').Locator,
  file: string,
) {
  await anchor.scrollIntoViewIfNeeded();
  await dlg.page().waitForTimeout(400); // Radix exit animation on any popover just dismissed
  await dlg.screenshot({ path: path.join(SHOTS, file) });
}

/** assertGatesClean, minus the known-unrelated phone-access 409 (see file doc comment). */
function assertGatesCleanQa(gate: { pageErrors: string[]; bad5xx: string[] }, ctx = '') {
  const pageErrors = gate.pageErrors.filter((e) => !/409 \(Conflict\)/i.test(e));
  expect(pageErrors, `pageerror/console errors ${ctx}`).toEqual([]);
  expect(gate.bad5xx, `unexpected /api 5xx ${ctx}`).toEqual([]);
}

/** Opens the board and the "New Event" dialog. */
async function openNewEventDialog(page: import('@playwright/test').Page) {
  await page.goto('/schedule');
  await expect(page.locator('.schedule-cal')).toBeVisible({ timeout: 20_000 });
  await page.getByRole('button', { name: /new event/i }).click();
  await expect(page.getByRole('heading', { name: 'New Event' })).toBeVisible({ timeout: 10_000 });
}

test.describe('QA notify-all — the Event dialog notify section, post product-owner review', () => {
  test('1: Title has no example hint, and the notify block only appears once someone is on the entry', async ({ gatedPage: page, gate }) => {
    await openNewEventDialog(page);

    const dlg = dialogNamed(page, 'New Event');
    const title = dlg.getByLabel(/^title/i);
    // (3) "No hints as well." The field used to carry placeholder="Dave is off Thursday".
    expect(await title.getAttribute('placeholder')).toBeNull();

    // The ORIGINAL PO defect: an entry with nobody on it must not offer to notify anyone.
    // Widening the gate from "has a customer" to "has anyone" must not reopen it.
    await expect(dlg.getByLabel('Notify participants')).toHaveCount(0);

    await title.fill(`QA NotifyAll empty ${runId}`);
    await shotDialog(dlg, title, '01-new-event-no-hint-no-notify.png');

    await assertNoErrorBoundary(page);
    assertGatesCleanQa(gate, 'after opening New Event');
  });

  test('2: a TEAM-ONLY entry offers the notify block — the section a customer used to be required for', async ({ gatedPage: page, gate }) => {
    await openNewEventDialog(page);
    const dlg = dialogNamed(page, 'New Event');
    await dlg.getByLabel(/^title/i).fill(`QA NotifyAll team ${runId}`);

    await dlg.getByRole('combobox', { name: /add team member/i }).click();
    await page.getByRole('option', { name: techLabel }).click();

    // (5) The block used to render only when a CUSTOMER participant was present.
    const box = dlg.getByLabel('Notify participants');
    await expect(box).toBeVisible();
    await expect(box).toBeChecked();

    // (1)(2)(4) — every removed sentence, by its most distinctive fragment.
    await expect(dlg.getByText(/emails everyone below/i)).toHaveCount(0);
    await expect(dlg.getByText(/will be emailed/i)).toHaveCount(0);
    await expect(dlg.getByText(/sent as-is/i)).toHaveCount(0);
    await expect(dlg.getByText(/fixed wording/i)).toHaveCount(0);
    // What must SURVIVE: the control itself and the message field.
    await expect(dlg.getByLabel('Message')).toBeVisible();

    await shotDialog(dlg, dlg.getByLabel('Message'), '02-team-only-notify-block.png');

    await assertNoErrorBoundary(page);
    assertGatesCleanQa(gate, 'team-only notify block');
  });

  test('3: saving that entry actually emails the teammate at their own User.email', async ({ gatedPage: page, gate }) => {
    const title = `QA NotifyAll send ${runId} ${Date.now()}`;
    await openNewEventDialog(page);
    const dlg = dialogNamed(page, 'New Event');
    await dlg.getByLabel(/^title/i).fill(title);

    await dlg.getByRole('combobox', { name: /add team member/i }).click();
    await page.getByRole('option', { name: techLabel }).click();
    await expect(dlg.getByLabel('Notify participants')).toBeChecked();

    const postWait = page.waitForResponse(
      (r) => r.url().includes('/api/calendar-entries') && r.request().method() === 'POST',
      { timeout: 20_000 },
    );
    await dlg.getByRole('button', { name: /create event/i }).click();
    const res = await postWait;
    expect(res.ok(), `create failed: ${res.status()}`).toBeTruthy();

    // THE BEHAVIOURAL PROOF. Before this change the response carried `notify.customers` only,
    // and a team-only entry sent no email at all.
    const body = await res.json();
    expect(body.notify, 'no notify block on the create response').toBeTruthy();
    expect(body.notify.users, 'notify.users missing — the teammate was never addressed').toHaveLength(1);
    expect(body.notify.users[0]).toMatchObject({ user_id: techUserId, outcome: 'scheduled', status: 'sent' });

    await page.screenshot({ path: path.join(SHOTS, '03-team-only-saved-board.png') });

    await assertNoErrorBoundary(page);
    assertGatesCleanQa(gate, 'after team-only create');
  });

  test('4: a customer participant is still emailed, alongside the teammate — both, not either', async ({ gatedPage: page, gate }) => {
    const title = `QA NotifyAll both ${runId} ${Date.now()}`;
    await openNewEventDialog(page);
    const dlg = dialogNamed(page, 'New Event');
    await dlg.getByLabel(/^title/i).fill(title);

    await dlg.getByRole('combobox', { name: /add team member/i }).click();
    await page.getByRole('option', { name: techLabel }).click();

    await dlg.getByRole('button', { name: /select customer/i }).click();
    // The customer picker portals OUT of the dialog, so this one is scoped to the popover, not
    // to `dlg` — page-wide it would also match the app-chrome search box.
    const picker = page.locator('[data-radix-popper-content-wrapper]').last();
    await picker.getByPlaceholder(/search/i).fill(customerSearch);
    await picker.getByText(new RegExp(customerSearch)).first().click();

    // (4)'s other half, checked with a REAL customer on the entry: the manifest that used to
    // list "name — email" per recipient is gone even here, where it had the most to say.
    await expect(dlg.getByText(/will be emailed/i)).toHaveCount(0);
    await shotDialog(dlg, dlg.getByLabel('Message'), '04-both-kinds-notify-block.png');

    const postWait = page.waitForResponse(
      (r) => r.url().includes('/api/calendar-entries') && r.request().method() === 'POST',
      { timeout: 20_000 },
    );
    await dlg.getByRole('button', { name: /create event/i }).click();
    const res = await postWait;
    expect(res.ok(), `create failed: ${res.status()}`).toBeTruthy();

    const body = await res.json();
    expect(body.notify.users, 'teammate not emailed').toHaveLength(1);
    expect(body.notify.customers, 'customer not emailed').toHaveLength(1);
    expect(body.notify.users[0].status).toBe('sent');
    expect(body.notify.customers[0]).toMatchObject({ customer_id: customerId, status: 'sent' });

    await assertNoErrorBoundary(page);
    assertGatesCleanQa(gate, 'after mixed create');
  });

  test('5: the delete prompt says "Notify participants" and appears for a team-only entry', async ({ gatedPage: page, gate }) => {
    const title = `QA NotifyAll delete ${runId} ${Date.now()}`;
    const created = await api.raw('post', '/api/calendar-entries', {
      title,
      start: new Date(Date.now() + 3 * 3600_000).toISOString(),
      end: new Date(Date.now() + 4 * 3600_000).toISOString(),
      is_all_day: false,
      participants: [{ kind: 'USER', user_id: techUserId }],
    });
    expect(created.res.ok(), `seed create failed: ${created.res.status()}`).toBeTruthy();

    await page.goto('/schedule');
    await expect(page.locator('.schedule-cal')).toBeVisible({ timeout: 20_000 });
    const card = page.locator('.rbc-event').filter({ hasText: title }).first();
    await expect(card).toBeVisible({ timeout: 20_000 });
    await card.click();

    const edit = dialogNamed(page, 'Edit Event');
    await expect(edit).toBeVisible({ timeout: 10_000 });
    await edit.getByRole('button', { name: /^delete$/i }).click();

    // Scoped to the CONFIRM dialog: the Edit dialog behind it is still mounted while its exit
    // animation runs, and it has a "Notify participants" checkbox of its own.
    const confirm = dialogNamed(page, 'Delete this event?');
    // Before this change the prompt hid its checkbox entirely for a team-only entry — there was
    // no email to ask permission for.
    await expect(confirm.getByLabel('Notify participants')).toBeVisible({ timeout: 10_000 });
    await shotDialog(confirm, confirm.getByLabel('Notify participants'), '05-delete-prompt.png');

    await assertNoErrorBoundary(page);
    assertGatesCleanQa(gate, 'delete prompt');
  });
});
