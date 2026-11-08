import { test, expect, assertNoErrorBoundary } from '../../fixtures/gated-test';
import { screenshotAndAssert } from '../../helpers/screenshot';
import { ApiClient, provisionedAdmin } from '../../helpers/api-client';

/**
 * QA validation — "New Event" quarter-hour rounding fix.
 *
 * Product-owner finding: the plain toolbar "New Event" button on the v2 schedule board
 * (`SchedulePage.tsx`) seeded the dialog from the clock to the minute (e.g. 5:16 AM /
 * 6:16 AM), so every create started with the user fixing two fields.
 *
 * Fix under test: `roundUpToQuarterHour` (exported, pure) in
 * `frontend/src/pages/v2/schedule/components/eventEntryDialog.tsx`, wired into the
 * CREATE-mode "now, one hour" fallback ONLY (no `createSeed`, no `event`) — never into
 * EDIT mode (`event.start` always wins there) or the all-day-popover's `createSeed` path.
 *
 * Three things to prove, in a real browser against the staging DB:
 *  1. The plain "New Event" seeds a Start on a :00/:15/:30/:45 boundary and an End
 *     exactly DEFAULT_EVENT_DURATION_MIN later.
 *  2. Edit mode is untouched — an entry saved with a deliberately off-grid start
 *     (14:16) reopens showing 14:16, not a rounded value.
 *  3. The seeded values round-trip through Create correctly — the card lands on the
 *     board and the persisted row matches what the dialog showed before Save.
 *
 * Field ids come from `ScheduleTimeFields idPrefix="event-entry"` in eventEntryDialog.tsx:
 * event-entry-start-date / -start-time / -end-date / -end-time. Each renders through the
 * v2 `TimeCombobox` — a typeable text input whose displayed value is date-fns 'h:mm a'
 * (`formatTimeForInput`, e.g. "5:30 AM"), not a native <input type="time">.
 *
 * DEFAULT_EVENT_DURATION_MIN is read from the source (mirrored as a literal below with a
 * pointer back) rather than assumed, per the brief.
 *
 * Run-id trap: this file's own titles must not depend on a module-scope `Math.random()` —
 * Playwright re-imports the module on a worker restart after any failing test, which would
 * re-roll a module-scope id and orphan a title created before the restart. `runId` is
 * instead derived lazily inside `beforeAll` from `.auth/e2e-org.json`'s `organizationId`
 * (via `provisionedAdmin()`), which is stable across restarts; `.auth/e2e-org.json` does
 * not exist yet at module-import time (global-setup runs first), so this must not be read
 * at module scope either.
 *
 * Console-error trap: `POST /api/communication/phone-access` 409s on every page load,
 * app-wide, unrelated to this feature (a known pre-existing defect). `assertGatesClean`
 * only tracks NETWORK >=500s (a 409 never lands in `gate.bad5xx`), but Chromium itself logs
 * a `console.error` for ANY failed resource load — "Failed to load resource: the server
 * responded with a status of 409 (Conflict)" — with no URL in `msg.text()` to match on. This
 * is the only 409 this app is known to produce (a known pre-existing defect, unrelated to
 * this feature), so `assertGatesCleanQa` below filters any "…409 (Conflict)" console line
 * rather than matching on the (absent) endpoint name.
 */

let api: ApiClient;
let runId: string;

/** DEFAULT_EVENT_DURATION_MIN — frontend/src/pages/v2/schedule/components/eventEntryDialog.tsx:35. */
const DEFAULT_EVENT_DURATION_MIN = 60;

test.beforeAll(async () => {
  api = await new ApiClient().init();
  runId = provisionedAdmin().organizationId.slice(0, 8);
});

test.afterAll(async () => {
  await api.dispose();
});

/** "5:30 AM" / "2:16 PM" -> minutes since local midnight. */
function parseDisplayTime(text: string): number {
  const m = text.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
  if (!m) throw new Error(`unparseable time display: "${text}"`);
  let h = Number(m[1]);
  const mins = Number(m[2]);
  const ampm = (m[3] as string).toUpperCase();
  if (h === 12) h = 0;
  if (ampm === 'PM') h += 12;
  return h * 60 + mins;
}

/** Minutes between two (date-display, time-display) pairs, assuming a forward same-or-next-day span
 *  (true for every value this dialog ever seeds — "now" or "now + duration", never backwards). */
function diffMinutesDisplayed(startDate: string, startTime: string, endDate: string, endTime: string): number {
  let diff = parseDisplayTime(endTime) - parseDisplayTime(startTime);
  if (endDate !== startDate) diff += 24 * 60;
  return diff;
}

async function readTimeFields(dialog: import('@playwright/test').Locator) {
  return {
    startDate: await dialog.locator('#event-entry-start-date').inputValue(),
    startTime: await dialog.locator('#event-entry-start-time').inputValue(),
    endDate: await dialog.locator('#event-entry-end-date').inputValue(),
    endTime: await dialog.locator('#event-entry-end-time').inputValue(),
  };
}

/** assertGatesClean, but strips the known-unrelated phone-access 409 out of the console/pageerror
 *  list first (see file doc comment) rather than failing every test in this file on it. */
function assertGatesCleanQa(gate: { pageErrors: string[]; bad5xx: string[] }, ctx = '') {
  const pageErrors = gate.pageErrors.filter((e) => !/409 \(Conflict\)/i.test(e));
  expect(pageErrors, `pageerror/console errors ${ctx}`).toEqual([]);
  expect(gate.bad5xx, `unexpected /api 5xx ${ctx}`).toEqual([]);
}

test.describe('QA round — New Event quarter-hour rounding fix', () => {
  test('1+3: New Event seeds a quarter-hour Start / Start+60min End, and the seed saves correctly', async ({ gatedPage: page, gate }) => {
    await page.goto('/schedule');
    await expect(page.locator('.schedule-cal')).toBeVisible();

    const newEventBtn = page.getByRole('button', { name: 'New Event' });
    await expect(newEventBtn).toBeVisible({ timeout: 15_000 });
    await newEventBtn.click();

    // Scoped by accessible name, not a bare role=dialog: the TimeCombobox's own Radix
    // Popover also renders role="dialog" (just data-state="closed" once committed), so an
    // unscoped `getByRole('dialog')` is a strict-mode violation the moment a time field has
    // ever been focused.
    const dialog = page.getByRole('dialog', { name: 'New Event' });
    await expect(dialog).toBeVisible();

    // Wait for the seeded draft to actually be in the DOM before reading it.
    await expect(dialog.locator('#event-entry-start-time')).not.toHaveValue('');

    const seed = await readTimeFields(dialog);
    const seedDiff = diffMinutesDisplayed(seed.startDate, seed.startTime, seed.endDate, seed.endTime);

    // ── Point 1 ──────────────────────────────────────────────────────────
    const startMinuteOfHour = parseDisplayTime(seed.startTime) % 60;
    expect(startMinuteOfHour % 15, `seeded Start "${seed.startTime}" is not on a :00/:15/:30/:45 boundary`).toBe(0);
    expect(seedDiff, `seeded End "${seed.endTime}" on ${seed.endDate} is ${seedDiff}min after Start "${seed.startTime}" on ${seed.startDate}, expected DEFAULT_EVENT_DURATION_MIN=${DEFAULT_EVENT_DURATION_MIN}`).toBe(DEFAULT_EVENT_DURATION_MIN);

    // ── Point 3 — create from the seed, prove the round-trip ───────────────
    const title = `QA Round seed ${runId} ${Date.now()}`;
    await dialog.getByLabel('Title').fill(title);
    await dialog.getByRole('button', { name: 'Create Event' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    const card = page.locator('.rbc-event').filter({ hasText: title }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });

    // Persisted correctly — fetch the entry and convert its stored `start`/`end` (UTC
    // instants) back into the org's own wall clock (America/New_York — both
    // scheduleTimeFields.tsx's DEFAULT_SCHEDULE_TIMEZONE fallback and the fresh
    // provisioned org's Organization.timezone column default to it), and confirm it is
    // identical to what the dialog showed before Create was clicked.
    const { body: list } = await api.raw('get', '/api/calendar-entries');
    const entry = (list.calendar_entries ?? []).find((e: { title: string }) => e.title === title);
    expect(entry, `created entry "${title}" not found via GET /api/calendar-entries`).toBeTruthy();

    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
    });
    const storedStartDisplay = fmt.format(new Date(entry.start)).replace(/\u202f/g, ' ').toUpperCase();
    expect(storedStartDisplay, 'persisted start does not match what the dialog seeded/showed').toBe(seed.startTime.toUpperCase());

    const storedDurationMin = (new Date(entry.end).getTime() - new Date(entry.start).getTime()) / 60_000;
    expect(storedDurationMin, 'persisted end is not DEFAULT_EVENT_DURATION_MIN after persisted start').toBe(DEFAULT_EVENT_DURATION_MIN);

    await assertNoErrorBoundary(page);
    assertGatesCleanQa(gate, 'qa-round-1+3');
    await screenshotAndAssert(page, 'qa-round-01-seeded-create.png');
  });

  test('2: Edit mode is untouched — an off-grid Start (2:16 PM) is not rounded on reopen', async ({ gatedPage: page, gate }) => {
    await page.goto('/schedule');
    await expect(page.locator('.schedule-cal')).toBeVisible();

    const newEventBtn = page.getByRole('button', { name: 'New Event' });
    await expect(newEventBtn).toBeVisible({ timeout: 15_000 });
    await newEventBtn.click();

    // Scoped by accessible name — see the identical note in test 1.
    const dialog = page.getByRole('dialog', { name: 'New Event' });
    await expect(dialog).toBeVisible();
    await expect(dialog.locator('#event-entry-start-time')).not.toHaveValue('');

    const title = `QA Round offgrid ${runId} ${Date.now()}`;
    await dialog.getByLabel('Title').fill(title);

    // Deliberately off-grid — TimeCombobox commits typed text via parseTimeInputText on
    // blur (timeCombobox.tsx's `onBlur={() => commit(text)}`); withStartTime preserves the
    // dialog's original 60min duration, so End shifts with it (no inverted-range risk).
    const startTimeInput = dialog.locator('#event-entry-start-time');
    await startTimeInput.click();
    await startTimeInput.fill('2:16 PM');
    await startTimeInput.press('Tab');
    await expect(startTimeInput).toHaveValue('2:16 PM');

    await dialog.getByRole('button', { name: 'Create Event' }).click();
    await expect(dialog).toBeHidden({ timeout: 15_000 });

    const card = page.locator('.rbc-event').filter({ hasText: title }).first();
    await expect(card).toBeVisible({ timeout: 15_000 });
    await card.click();

    const editDialog = page.getByRole('dialog', { name: 'Edit Event' });
    await expect(editDialog).toBeVisible();

    // THE regression that matters: EDIT mode must read the entry's own stored start
    // (`seedStart = event.start` in eventEntryDialog.tsx) and must never route it through
    // `roundUpToQuarterHour`, which is wired ONLY into the create-mode "no seed at all"
    // fallback branch.
    const editedStartTime = await editDialog.locator('#event-entry-start-time').inputValue();
    expect(editedStartTime, 'edit mode rounded an off-grid start time it should have left untouched').toBe('2:16 PM');

    // Cross-check against the persisted row too, not just the dialog's own re-derivation.
    const { body: list } = await api.raw('get', '/api/calendar-entries');
    const entry = (list.calendar_entries ?? []).find((e: { title: string }) => e.title === title);
    expect(entry, `created entry "${title}" not found via GET /api/calendar-entries`).toBeTruthy();
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: 'America/New_York', hour: 'numeric', minute: '2-digit', hour12: true,
    });
    const storedStartDisplay = fmt.format(new Date(entry.start)).replace(/\u202f/g, ' ').toUpperCase();
    expect(storedStartDisplay, 'persisted start is not the off-grid time that was typed').toBe('2:16 PM');

    await editDialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(editDialog).toBeHidden();

    await assertNoErrorBoundary(page);
    assertGatesCleanQa(gate, 'qa-round-2');
    await screenshotAndAssert(page, 'qa-round-02-offgrid-edit-reopen.png');
  });
});
