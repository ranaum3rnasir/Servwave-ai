import { test, expect, assertNoErrorBoundary } from '../../fixtures/gated-test';
import { screenshotAndAssert } from '../../helpers/screenshot';
import { ApiClient, provisionedAdmin } from '../../helpers/api-client';
import { uniquePhone } from '../../helpers/workflow-builders';

/**
 * QA validation — "remove the button to create a new customer" fix.
 *
 * Product-owner instruction, verbatim: "When we 'select a customer', remove the button to
 * create a new customer from there." — scoped to the Event dialog's Participants area only.
 *
 * Fix under test:
 *  - `CustomerPickerWithCreate` (frontend/src/components/crm/CustomerPickerWithCreate.tsx)
 *    grew an `allowCreate?: boolean` prop, defaulting to `true` so every existing caller keeps
 *    byte-identical behaviour.
 *  - `ParticipantsField` (frontend/src/pages/v2/schedule/components/participantsField.tsx)
 *    is the ONE caller that passes `allowCreate={false}`.
 *
 * Five things to prove in a real browser against the staging DB:
 *  1. New Event dialog's "Select customer" control offers no create affordance, including
 *     on a search term that matches nothing (the empty state used to carry the create button).
 *  2. Picking an existing customer still works there — chip appears, and the pick round-trips
 *     as a CUSTOMER-kind participant via GET /api/calendar-entries.
 *  3. Same for Edit Event mode.
 *  4. ServicePlansPage's "New service plan" dialog (the only *reachable* one of the two other
 *     callers — see file note below) still offers create, because it passes no `allowCreate`.
 *  5. Nothing else regressed opening either dialog (error-boundary / console / 5xx gates).
 *
 * REACHABILITY NOTE on the two "other callers" the brief names:
 *  - `frontend/src/pages/v2/_shared/planBuilderDialog.tsx` IS reachable — it is the dialog
 *    `pages/v2/service-plans/ServicePlansPage.tsx` opens via its "New Plan" button, mounted at
 *    `/service-plans` (pages/v2/routes/service-plans.routes.tsx, gated by the `service_plans`
 *    entitlement — minPlan PRO; a freshly provisioned e2e org is seeded on plan SCALE, so the
 *    route is open). This is the surface point 4 below actually exercises.
 *  - `frontend/src/pages/service-plans/ServicePlansPage.tsx` (the v1 page the brief also names)
 *    is NOT reachable in this app. `frontend/src/App.tsx` states outright: "Nothing legacy is
 *    routed here any more" — the entire route table is built from `pages/v2/routes/`, and this
 *    v1 file is not imported by any of them (confirmed via grep: its only non-test importer is
 *    the equally unrouted v1 `src/pages/CustomerDetailPage.tsx`, which nothing in App.tsx or
 *    `pages/v2/routes/` references either). Its `CustomerPickerWithCreate` call passes no
 *    `allowCreate` in the source, so it is unaffected by this change on paper — but that claim
 *    cannot be verified in a browser because the page cannot be navigated to. Reported as
 *    "unreachable", not "passed".
 *
 * Run-id trap: no module-scope `Math.random()` — `runId` is derived lazily inside `beforeAll`
 * from `.auth/e2e-org.json`'s `organizationId` (via `provisionedAdmin()`), which does not exist
 * at module-import time (global-setup runs first).
 *
 * Console-error trap: the pre-existing `POST /api/communication/phone-access` 409 logs as a bare
 * "Failed to load resource: ... 409 (Conflict)" console.error with no URL — filtered below by
 * that pattern rather than by path, same as the sibling qa-*.spec.ts files.
 */

let api: ApiClient;
let runId: string;
let customerId: string;
let customerLabel: string;

test.beforeAll(async () => {
  api = await new ApiClient().init();
  runId = provisionedAdmin().organizationId.slice(0, 8);

  // Email includes Date.now(), not just runId: a failing test in this file discards the
  // Playwright worker and re-imports the module, which re-runs beforeAll from scratch
  // (see the file's run-id trap note). A fixed email would 409 as a duplicate on that
  // second beforeAll call — this makes every invocation of beforeAll itself idempotent.
  const first = `QAPicker-${runId}`;
  const customer = await api.createCustomer({
    first_name: first,
    last_name: 'Customer',
    email: `qa-picker-${runId}-${Date.now()}@e2e-qa.invalid`,
    phone: uniquePhone(),
  });
  customerId = customer.id;
  customerLabel = `${first} Customer`;
});

test.afterAll(async () => {
  await api.dispose();
});

async function fetchEntryByTitle(title: string) {
  const { body } = await api.raw('get', '/api/calendar-entries');
  const entry = (body.calendar_entries ?? []).find((e: { title: string }) => e.title === title);
  expect(entry, `entry "${title}" not found via GET /api/calendar-entries`).toBeTruthy();
  return entry as {
    id: string;
    title: string;
    participants: { kind: string; user_id: string | null; customer_id: string | null }[];
  };
}

/** assertGatesClean, but strips the known-unrelated phone-access 409 (see file doc comment). */
function assertGatesCleanQa(gate: { pageErrors: string[]; bad5xx: string[] }, ctx = '') {
  const pageErrors = gate.pageErrors.filter((e) => !/409 \(Conflict\)/i.test(e));
  expect(pageErrors, `pageerror/console errors ${ctx}`).toEqual([]);
  expect(gate.bad5xx, `unexpected /api 5xx ${ctx}`).toEqual([]);
}

/** Radix's Popover.Content renders `role="dialog"` (confirmed via a live accessibility-tree
 *  dump: it comes out as `dialog [ref=e57]` — a SIBLING of the Event dialog's own
 *  `dialog [ref=e2]`, not a descendant). react-dom portals it straight to `document.body`
 *  rather than into the trigger's own subtree, so `dialog.getByRole('dialog')` (scoped under
 *  the outer Event dialog locator) never finds it at all — the earlier version of this file
 *  did exactly that and got a false "element(s) not found" failure. Both role=dialog elements
 *  have to be told apart from the page root instead, using the search input's own
 *  `aria-label="Search customers"` (only present inside CustomerPickerWithCreate's search-mode
 *  content) as the distinguishing marker. This also sidesteps the OTHER false-failure this
 *  file hit first: the Event dialog's own submit button ("Create Event" / "Save", and
 *  planBuilderDialog's "Create draft") matches a bare `/^Create /` just as well as the
 *  customer picker's real "Create ..." row would — scoping to this panel keeps that button
 *  out of consideration entirely. */
function customerPickerPanel(page: import('@playwright/test').Page) {
  return page.getByRole('dialog').filter({ has: page.getByLabel('Search customers') });
}

/** Opens the participants "Select customer" popover inside an already-open Event dialog and
 *  asserts no create affordance exists — neither in the default (empty-query) list state nor
 *  in the "no matches" empty state a search term that matches nothing produces. That empty
 *  state is exactly where the "Create ..." row used to render (CustomerPickerWithCreate's
 *  `canCreate &&` block sits directly beneath the results list, visible regardless of whether
 *  the list itself is populated, loading, errored, or empty). Closes the popover before
 *  returning (Escape), leaving the dialog's own state untouched for the caller to continue.
 */
async function assertCustomerPickerHasNoCreateAffordance(page: import('@playwright/test').Page, dialog: import('@playwright/test').Locator) {
  const trigger = dialog.getByRole('button', { name: 'Select customer' });
  await trigger.click();
  const panel = customerPickerPanel(page);
  await expect(panel).toBeVisible();

  // Default (empty-query) state — the trigger for the create form.
  await expect(panel.getByRole('button', { name: /^Create / })).toHaveCount(0);
  await expect(panel.getByText('New customer', { exact: true })).toHaveCount(0);

  // Empty state on a query that matches nothing — this is the state the create button used
  // to live in ("Create "<query>""), so it gets its own explicit check.
  const search = panel.getByPlaceholder('Search name, company, phone, email…');
  await search.fill('zzz-no-such-customer-zzz-qapicker');
  await expect(panel.getByText('No matches', { exact: true })).toBeVisible({ timeout: 10_000 });
  await expect(panel.getByRole('button', { name: /^Create / })).toHaveCount(0);
  await expect(panel.getByText('New customer', { exact: true })).toHaveCount(0);

  await search.fill('');
  await page.keyboard.press('Escape').catch(() => {});
  // Escape on a nested popover can occasionally bubble to the parent Dialog in this stack —
  // guard with a direct click-away fallback instead of assuming Escape alone closed it.
  if (await trigger.getAttribute('aria-expanded') === 'true') {
    await dialog.locator('h1, h2, [class*="DialogTitle"]').first().click({ force: true }).catch(() => {});
  }
}

/** Picks the seeded existing customer from an open participants picker and asserts the chip
 *  appears. Leaves the picker closed (the row's own onClick closes it). */
async function pickExistingCustomer(page: import('@playwright/test').Page, dialog: import('@playwright/test').Locator) {
  const trigger = dialog.getByRole('button', { name: 'Select customer' });
  await trigger.click();
  const panel = customerPickerPanel(page);
  await expect(panel).toBeVisible();
  const search = panel.getByPlaceholder('Search name, company, phone, email…');
  await search.fill(`QAPicker-${runId}`);
  const row = panel.getByRole('button', { name: new RegExp(customerLabel.split(' ')[0]!) }).first();
  await expect(row).toBeVisible({ timeout: 10_000 });
  await row.click();

  // Exact match: picking a customer with no email on file also unlocks the "Notify customer
  // participants" block below, whose "Will be emailed:" manifest repeats the same label text
  // with a " — no email on file" suffix — a loose (non-exact) match is ambiguous between the
  // chip and that manifest row.
  const chip = dialog.getByText(customerLabel, { exact: true });
  await expect(chip).toBeVisible({ timeout: 5_000 });
}

test.describe('QA picker — Event dialog customer picker has no inline create', () => {
  test('1+2: New Event — no create affordance, picking an existing customer round-trips as a CUSTOMER participant', async ({ gatedPage: page, gate }) => {
    await page.goto('/schedule');
    await expect(page.locator('.schedule-cal')).toBeVisible();

    const newEventBtn = page.getByRole('button', { name: 'New Event' });
    await expect(newEventBtn).toBeVisible({ timeout: 15_000 });
    await newEventBtn.click();

    // Scoped by accessible name — TimeCombobox's own Radix Popover also renders
    // role="dialog" (data-state="closed" once committed), so an unscoped
    // `getByRole('dialog')` is a strict-mode violation the moment a time field is touched.
    const dialog = page.getByRole('dialog', { name: 'New Event' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#event-entry-start-time')).not.toHaveValue('');

    // ── Point 1 ──────────────────────────────────────────────────────────
    await assertCustomerPickerHasNoCreateAffordance(page, dialog);

    // ── Point 2 ──────────────────────────────────────────────────────────
    await pickExistingCustomer(page, dialog);

    const title = `QA Picker create ${runId} ${Date.now()}`;
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByRole('button', { name: 'Create Event' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    const card = page.locator('.rbc-event').filter({ hasText: title }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });

    const entry = await fetchEntryByTitle(title);
    const participant = entry.participants.find((p) => p.kind === 'CUSTOMER' && p.customer_id === customerId);
    expect(participant, `persisted entry has no CUSTOMER participant for ${customerId}; got ${JSON.stringify(entry.participants)}`).toBeTruthy();

    await assertNoErrorBoundary(page);
    assertGatesCleanQa(gate, 'qa-picker-1+2-create');
    await screenshotAndAssert(page, 'qa-picker-01-new-event-no-create.png');
  });

  test('3: Edit Event — no create affordance, picking an existing customer round-trips on save', async ({ gatedPage: page, gate }) => {
    const title = `QA Picker edit ${runId} ${Date.now()}`;
    const now = new Date();
    const start = new Date(now.getTime() + 60 * 60_000).toISOString();
    const end = new Date(now.getTime() + 2 * 60 * 60_000).toISOString();
    const { res, body } = await api.raw('post', '/api/calendar-entries', {
      title, start, end, is_all_day: false, participants: [],
    });
    expect(res.ok(), `seed calendar-entry failed: ${res.status()} ${JSON.stringify(body)}`).toBeTruthy();

    await page.goto('/schedule');
    await expect(page.locator('.schedule-cal')).toBeVisible();

    const card = page.locator('.rbc-event').filter({ hasText: title }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();

    const dialog = page.getByRole('dialog', { name: 'Edit Event' });
    await expect(dialog).toBeVisible();

    // ── Point 3 (no-create half) ─────────────────────────────────────────
    await assertCustomerPickerHasNoCreateAffordance(page, dialog);

    // ── Point 3 (pick-still-works half) ──────────────────────────────────
    await pickExistingCustomer(page, dialog);

    await dialog.getByRole('button', { name: 'Save' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    const entry = await fetchEntryByTitle(title);
    const participant = entry.participants.find((p) => p.kind === 'CUSTOMER' && p.customer_id === customerId);
    expect(participant, `persisted entry has no CUSTOMER participant for ${customerId}; got ${JSON.stringify(entry.participants)}`).toBeTruthy();

    await assertNoErrorBoundary(page);
    assertGatesCleanQa(gate, 'qa-picker-3-edit');
    await screenshotAndAssert(page, 'qa-picker-02-edit-event-no-create.png');
  });

  test('4: ServicePlansPage "New service plan" dialog still offers create (allowCreate default true, unaffected caller)', async ({ gatedPage: page, gate }) => {
    await page.goto('/service-plans');

    // If the org somehow lacks the `service_plans` entitlement, RequireFeature redirects to
    // /upgrade rather than erroring — surface that plainly instead of a confusing locator timeout.
    const newPlanBtn = page.getByRole('button', { name: 'New Plan' });
    const upgradeState = page.getByText(/requires/i).first();
    await expect(newPlanBtn.or(upgradeState)).toBeVisible({ timeout: 15_000 });
    if (await upgradeState.isVisible().catch(() => false)) {
      test.fail(true, '/service-plans redirected to the upgrade page — service_plans entitlement not granted on this provisioned org, could not reach planBuilderDialog.tsx');
      return;
    }

    await newPlanBtn.click();
    const dialog = page.getByRole('dialog', { name: 'New service plan' });
    await expect(dialog).toBeVisible();

    const trigger = dialog.getByRole('button', { name: 'Select customer' });
    await trigger.click();
    // Scoped to the popover panel, not the whole dialog — this dialog's own submit button
    // is "Create draft", which also matches `/^Create /` and would false-positive a bare
    // `dialog.getByRole('button', { name: /^Create / })` (see customerPickerPanel's doc
    // comment for why the picker's popover is a second, nested role=dialog).
    const panel = customerPickerPanel(page);
    await expect(panel).toBeVisible();

    // The one behaviour this change must NOT touch: this caller passes no `allowCreate`, so
    // the prop's default (`true`) keeps the create row exactly as it was before this change.
    const createRow = panel.getByRole('button', { name: /^Create / });
    await expect(createRow).toBeVisible({ timeout: 10_000 });
    await expect(createRow).toContainText('new customer');

    await assertNoErrorBoundary(page);
    assertGatesCleanQa(gate, 'qa-picker-4-service-plans-still-has-create');
    await screenshotAndAssert(page, 'qa-picker-03-service-plans-still-has-create.png');
  });
});
