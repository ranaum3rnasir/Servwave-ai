import { fromZonedTime } from 'date-fns-tz';
import { test, expect, assertNoErrorBoundary } from '../../fixtures/gated-test';
import { screenshotAndAssert } from '../../helpers/screenshot';
import { ApiClient, provisionedAdmin } from '../../helpers/api-client';
import { createTech, uniquePhone } from '../../helpers/workflow-builders';

/**
 * QA validation — calendar-entry drag/resize "notify participants" toast honesty fix.
 *
 * Product-owner finding: an Event with ZERO participants, dragged on the v2 schedule board
 * (`SchedulePage.tsx`), still produced a toast "Event moved" / "Notify participants of the new
 * time?" with a "Notify" action, and clicking it claimed "Participants notified" even though
 * nobody could possibly have been told anything.
 *
 * Fix under test (frontend/src/pages/v2/schedule/SchedulePage.tsx):
 *  - `calendarEntryMoveMutation`'s onSuccess only offers the "Notify" action when the moved
 *    event has a CUSTOMER participant (`hasCustomerParticipant`, derived in
 *    components/schedule/eventAdapters.ts's `calendarEntryHasCustomerParticipantOf` — CUSTOMER
 *    kind only, a USER participant does not count). A user-only or participant-less entry gets
 *    the bare "Event moved" toast with no action.
 *  - `describeCalendarEntryNotifyOutcome` (same file) turns the real per-customer statuses
 *    `POST /api/calendar-entries/:id/notify-moved` returns into the follow-up message, instead
 *    of a flat "Participants notified" claim. An EMPTY `notify.customers` array means the
 *    route's own idempotency guard (calendar-entry.controller.ts `notifyMoved`) dropped every
 *    customer because each was already told about this exact move (their `notified_at` is
 *    already >= the entry's `updated_at`) — not a failure, nothing new to send.
 *
 * Four things to prove in a real browser against the staging DB:
 *  1. Zero participants → drag → "Event moved" toast, no Notify action at all.
 *  2. USER participant only → drag → still no Notify action (their in-app notice already fired
 *     on the save itself — notify-moved can only ever reach CUSTOMER participants).
 *  3. CUSTOMER participant with an email on file → drag → Notify IS offered; clicking it hits
 *     POST .../notify-moved for real and reports an honest count.
 *  4. A second notify call against the SAME unchanged move → the idempotency guard means nobody
 *     is re-emailed, and the message says so instead of claiming a fresh send.
 * In every case the move itself must persist (proven via a page reload + the API, not just the
 * toast), and the toast must never gate or roll back the move.
 *
 * DRAG METHOD — a real synthetic mouse drag, not an API substitute for the move itself. The
 * repo's own react-big-calendar DnD audit suite (sched-dnd-core.spec.ts) establishes the
 * working pattern for this exact board: mouse.move → mouse.down → mouse.move(steps) →
 * mouse.up. react-big-calendar's own drag addon (node_modules/react-big-calendar/lib/
 * Selection.js) listens for plain `mousedown`/`mousemove`/`mouseup` on `document` — not the
 * native HTML5 drag-and-drop API — so Playwright's CDP-backed mouse actions land on the same
 * listeners a real user's OS-level drag would.
 *
 * POINT 4 DISCLOSURE (read before judging this file "wrong"): a literal second click on the
 * SAME toast's "Notify" button is not reproducible. sonner's action-button handler (node_modules/
 * sonner/dist/index.mjs, the JSX for `data-action`) calls `deleteToast()` unconditionally right
 * after firing `onClick` (unless the handler calls `event.preventDefault()`, which this app's
 * handler never does) — so the toast is gone the instant "Notify" is clicked once. There is no
 * persistent "Notify" control anywhere else in the UI; the action only ever appears fresh, once,
 * immediately after a move succeeds. To exercise the idempotency guard for the SAME move (i.e.
 * the SAME `updated_at`, not a second move producing a new one), point 4 issues the identical
 * `POST /api/calendar-entries/:id/notify-moved` request the UI button would have issued, a
 * second time, directly — immediately after point 3's real UI-driven first click. This is a
 * disclosed substitution for the interaction only, in the same spirit the brief pre-authorizes
 * for the drag itself: the request, the endpoint, and the response are all real; only the
 * "click a button a second time" gesture (which the toast's own lifecycle makes physically
 * impossible to repeat) is done via the identical HTTP call the button makes.
 *
 * Run-id trap: no module-scope `Math.random()` — `runId` is derived lazily inside `beforeAll`
 * from `.auth/e2e-org.json`'s `organizationId` (via `provisionedAdmin()`), which does not exist
 * at module-import time.
 *
 * Console-error trap: the pre-existing `POST /api/communication/phone-access` 409 logs as a bare
 * "Failed to load resource: ... 409 (Conflict)" console.error with no URL — filtered below by
 * that pattern rather than by path, same as qa-round.spec.ts.
 */

let api: ApiClient;
let runId: string;
let adminUserId: string;
let techUserId: string;
let customerId: string;
let customerEmail: string;

/** Org timezone for a freshly provisioned throwaway org (Organization.timezone default —
 *  confirmed by the prior QA validation pass, qa-round.spec.ts's own doc comment). */
const TZ = 'America/New_York';

/** "Today" (per the spec process's own local date — same accepted caveat 04-schedule.spec.ts
 *  documents for its `todayAt` helper: a run that crosses local midnight between this call and
 *  the browser's own "today" would miss the default calendar window) at HH:00 in the org's
 *  timezone, as an ISO instant with an explicit offset (satisfies the backend's
 *  `z.string().datetime({ offset: true })`). Late morning, safely inside the calendar's default
 *  06:00 scroll position and its 00:00–23:59 min/max window. */
function orgTodayAtIso(hour: number): string {
  const now = new Date();
  const y = now.getFullYear();
  const m = String(now.getMonth() + 1).padStart(2, '0');
  const d = String(now.getDate()).padStart(2, '0');
  const hh = String(hour).padStart(2, '0');
  return fromZonedTime(`${y}-${m}-${d} ${hh}:00:00`, TZ).toISOString();
}

test.beforeAll(async () => {
  api = await new ApiClient().init();
  runId = provisionedAdmin().organizationId.slice(0, 8);

  const me = await api.raw('get', '/api/auth/me');
  expect(me.res.ok(), `GET /api/auth/me failed: ${me.res.status()}`).toBeTruthy();
  adminUserId = me.body.user.id;

  techUserId = await createTech(api);

  const customer = await api.createCustomer({
    first_name: `QANotify-${runId}`,
    last_name: 'Customer',
    email: `qa-notify-${runId}@e2e-qa.invalid`,
    phone: uniquePhone(),
  });
  customerId = customer.id;
  customerEmail = customer.email;

  // Throwaway orgs provision with `email_sending_enabled: false` (Organization.timezone's
  // sibling default — "email is off by default" per lib/email.ts's own dispatchEmail doc
  // comment). Point 3 needs a real 'sent' outcome (not just 'skipped') to prove the toast
  // reports an honest COUNT, and point 4's idempotency guard only ever stamps `notified_at`
  // on a 'sent' result (calendar-entries/notify.ts: `if (result.status === 'sent')
  // notifiedParticipantIds.push(...)`) — a permanently 'skipped' send would leave
  // `notified_at` null forever and never become eligible for the idempotency guard to skip.
  // Flipping this via the same authenticated PATCH /api/organization route the Settings UI
  // itself uses, on this throwaway org only.
  const orgPatch = await api.raw('patch', '/api/organization', { email_sending_enabled: true });
  expect(orgPatch.res.ok(), `failed to enable email sending: ${orgPatch.res.status()}`).toBeTruthy();
});

test.afterAll(async () => {
  await api.dispose();
});

/** Create a calendar entry via the raw API escape hatch (no dedicated ApiClient wrapper exists
 *  for calendar-entries yet). Returns the created entry (id, start, end, participants, ...). */
async function createCalendarEntry(
  title: string,
  participants: { kind: 'USER' | 'CUSTOMER'; user_id?: string; customer_id?: string }[],
) {
  const start = orgTodayAtIso(10);
  const end = orgTodayAtIso(11);
  const { res, body } = await api.raw('post', '/api/calendar-entries', {
    title,
    start,
    end,
    is_all_day: false,
    participants,
  });
  expect(res.ok(), `createCalendarEntry failed: ${res.status()} ${JSON.stringify(body)}`).toBeTruthy();
  return body.calendar_entry as { id: string; start: string; end: string; title: string };
}

async function fetchEntryByTitle(title: string) {
  const { body } = await api.raw('get', '/api/calendar-entries');
  const entry = (body.calendar_entries ?? []).find((e: { title: string }) => e.title === title);
  expect(entry, `entry "${title}" not found via GET /api/calendar-entries`).toBeTruthy();
  return entry as { id: string; start: string; end: string; title: string };
}

/** A real synthetic drag on the event card — see the file doc comment's DRAG METHOD note for
 *  why this lands on react-big-calendar's own document-level mouse listeners. Drags straight
 *  down within the same day column (time-axis move only, no day change) by `dyPx`. */
async function dragEventDown(page: import('@playwright/test').Page, card: import('@playwright/test').Locator, dyPx: number) {
  const box = await card.boundingBox();
  if (!box) throw new Error('event card has no bounding box — not visible for drag');
  const cx = box.x + box.width / 2;
  const cy = box.y + box.height / 2;
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  await page.mouse.move(cx, cy + 12, { steps: 3 }); // past the addon's 5px click-tolerance dead zone
  await page.mouse.move(cx, cy + dyPx, { steps: 12 });
  await page.waitForTimeout(50);
  await page.mouse.up();
}

/** assertGatesClean, but strips the known-unrelated phone-access 409 (see file doc comment). */
function assertGatesCleanQa(gate: { pageErrors: string[]; bad5xx: string[] }, ctx = '') {
  const pageErrors = gate.pageErrors.filter((e) => !/409 \(Conflict\)/i.test(e));
  expect(pageErrors, `pageerror/console errors ${ctx}`).toEqual([]);
  expect(gate.bad5xx, `unexpected /api 5xx ${ctx}`).toEqual([]);
}

test.describe('QA notify — calendar-entry move toast honesty fix', () => {
  test('1: zero participants — "Event moved" with NO Notify action, move persists', async ({ gatedPage: page, gate }) => {
    const title = `QA Notify zero ${runId} ${Date.now()}`;
    const entry = await createCalendarEntry(title, []);

    await page.goto('/schedule');
    await expect(page.locator('.schedule-cal')).toBeVisible();

    const card = page.locator('.rbc-event').filter({ hasText: title }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });

    const patchWait = page.waitForResponse(
      (r) => r.url().includes(`/api/calendar-entries/${entry.id}`) && r.request().method() === 'PATCH',
      { timeout: 15_000 },
    );
    await dragEventDown(page, card, 90);
    const patchRes = await patchWait;
    expect(patchRes.ok(), `move PATCH failed: ${patchRes.status()}`).toBeTruthy();

    const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Event moved' }).last();
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toHaveText('Event moved'); // no description, no action label text at all
    await expect(toast.getByRole('button', { name: 'Notify' })).toHaveCount(0);

    // Move persists — reload and re-check via the API, not just the toast's own claim.
    await page.reload();
    await expect(page.locator('.schedule-cal')).toBeVisible();
    const persisted = await fetchEntryByTitle(title);
    expect(persisted.start, 'entry start did not change — the drag did not persist').not.toBe(entry.start);

    await assertNoErrorBoundary(page);
    assertGatesCleanQa(gate, 'qa-notify-1-zero-participants');
    await screenshotAndAssert(page, 'qa-notify-01-zero-participants.png');
  });

  test('2: USER participant only — still NO Notify action, move persists', async ({ gatedPage: page, gate }) => {
    const title = `QA Notify user-only ${runId} ${Date.now()}`;
    const entry = await createCalendarEntry(title, [{ kind: 'USER', user_id: techUserId }]);

    await page.goto('/schedule');
    await expect(page.locator('.schedule-cal')).toBeVisible();

    const card = page.locator('.rbc-event').filter({ hasText: title }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });

    const patchWait = page.waitForResponse(
      (r) => r.url().includes(`/api/calendar-entries/${entry.id}`) && r.request().method() === 'PATCH',
      { timeout: 15_000 },
    );
    await dragEventDown(page, card, 90);
    const patchRes = await patchWait;
    expect(patchRes.ok(), `move PATCH failed: ${patchRes.status()}`).toBeTruthy();

    const toast = page.locator('[data-sonner-toast]').filter({ hasText: 'Event moved' }).last();
    await expect(toast).toBeVisible({ timeout: 10_000 });
    await expect(toast).toHaveText('Event moved');
    await expect(toast.getByRole('button', { name: 'Notify' })).toHaveCount(0);

    await page.reload();
    await expect(page.locator('.schedule-cal')).toBeVisible();
    const persisted = await fetchEntryByTitle(title);
    expect(persisted.start, 'entry start did not change — the drag did not persist').not.toBe(entry.start);

    await assertNoErrorBoundary(page);
    assertGatesCleanQa(gate, 'qa-notify-2-user-only');
    await screenshotAndAssert(page, 'qa-notify-02-user-only.png');
  });

  test('3+4: CUSTOMER participant — Notify offered, honest send, then idempotent replay', async ({ gatedPage: page, gate }) => {
    const title = `QA Notify customer ${runId} ${Date.now()}`;
    const entry = await createCalendarEntry(title, [{ kind: 'CUSTOMER', customer_id: customerId }]);

    await page.goto('/schedule');
    await expect(page.locator('.schedule-cal')).toBeVisible();

    const card = page.locator('.rbc-event').filter({ hasText: title }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });

    const patchWait = page.waitForResponse(
      (r) => r.url().includes(`/api/calendar-entries/${entry.id}`) && r.request().method() === 'PATCH',
      { timeout: 15_000 },
    );
    await dragEventDown(page, card, 90);
    const patchRes = await patchWait;
    expect(patchRes.ok(), `move PATCH failed: ${patchRes.status()}`).toBeTruthy();

    // ── Point 3 ──────────────────────────────────────────────────────────
    const moveToast = page.locator('[data-sonner-toast]').filter({ hasText: 'Event moved' }).last();
    await expect(moveToast).toBeVisible({ timeout: 10_000 });
    await expect(moveToast.getByText('Event moved')).toBeVisible();
    await expect(moveToast.getByText('Notify participants of the new time?')).toBeVisible();
    const notifyBtn = moveToast.getByRole('button', { name: 'Notify' });
    await expect(notifyBtn).toBeVisible();

    const notifyWait = page.waitForResponse(
      (r) => r.url().includes(`/api/calendar-entries/${entry.id}/notify-moved`) && r.request().method() === 'POST',
      { timeout: 15_000 },
    );
    await notifyBtn.click();
    const notifyRes = await notifyWait;
    expect(notifyRes.ok(), `POST notify-moved failed: ${notifyRes.status()}`).toBeTruthy();
    const notifyBody = await notifyRes.json();
    const firstCustomers: { status: string }[] = notifyBody.notify?.customers ?? [];
    expect(firstCustomers.length, 'expected exactly one CUSTOMER participant in the outcome').toBe(1);
    expect(firstCustomers[0]!.status, `expected the throwaway customer's email (${customerEmail}) to send`).toBe('sent');

    const outcomeToast = page.locator('[data-sonner-toast]').filter({ hasText: 'participant' }).last();
    await expect(outcomeToast).toBeVisible({ timeout: 10_000 });
    const outcomeText = (await outcomeToast.textContent())?.trim();
    expect(outcomeText, 'toast did not honestly report a real send').toBe('1 participant notified');

    // Move persists.
    await page.reload();
    await expect(page.locator('.schedule-cal')).toBeVisible();
    const persisted = await fetchEntryByTitle(title);
    expect(persisted.start, 'entry start did not change — the drag did not persist').not.toBe(entry.start);

    await assertNoErrorBoundary(page);
    assertGatesCleanQa(gate, 'qa-notify-3-customer-first-send');
    await screenshotAndAssert(page, 'qa-notify-03-customer-notified.png');

    // ── Point 4 — idempotent replay against the SAME unchanged move ────────
    // See the file doc comment's "POINT 4 DISCLOSURE": a literal second click on the same
    // toast is not reproducible (sonner deletes the toast right after the first click fires),
    // so this issues the identical request the button would issue, a second time, directly.
    const { res: secondRes, body: secondBody } = await api.raw('post', `/api/calendar-entries/${entry.id}/notify-moved`);
    expect(secondRes.ok(), `second notify-moved call failed: ${secondRes.status()}`).toBeTruthy();
    const secondCustomers: { status: string }[] = secondBody.notify?.customers ?? [];
    expect(secondCustomers, 'idempotency guard did not drop the already-notified participant — a second email would go out').toEqual([]);
  });
});
