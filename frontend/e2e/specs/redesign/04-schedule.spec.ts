import { test, expect, assertGatesClean, assertNoErrorBoundary } from '../../fixtures/gated-test';
import { screenshotAndAssert } from '../../helpers/screenshot';
import { ApiClient } from '../../helpers/api-client';
import { createCustomerWithLocation, createTech, leadToSentEstimate } from '../../helpers/workflow-builders';

/**
 * Stage DLV-23 — SchedulePage smoke in the ACTIVE provisioned org.
 * Catalog: md_files/specs/testing/lifecycle-regression-catalog.md (row DLV-23).
 * WRITTEN 2026-06-10, NOT YET EXECUTED.
 *
 * The legacy `schedule-*` and `sched-*` suites seed a hardcoded demo-org admin and are org-mismatched
 * against the provisioned throwaway org — this file is the replacement smoke, driven against
 * the provisioned-admin storageState (chromium project) with all data seeded via ApiClient.
 *
 * SCOPE — deliberately a SMOKE, no drag-and-drop. The DLV-23 catalog row also names
 * drag→assign, conflict→Schedule Anyway and drag-reschedule confirm; DnD is fragile in
 * headless runs (the legacy sched-* audit covered it) and is left to a future wave.
 *
 * Locator grounding (frontend/src/pages/SchedulePage.tsx unless noted):
 *  - :315  default view = Views.WEEK (today is always inside the default range)
 *  - :902-916 calendar events query — GET /api/jobs?status=SCHEDULED,IN_PROGRESS,COMPLETED
 *            &scheduled_after&scheduled_before (so a SCHEDULED job TODAY renders this week)
 *  - :932-940 unassigned sidebar query — GET /api/jobs?status=UNASSIGNED&limit=100
 *  - :975-995 job→event mapping (only jobs with scheduled_start become events)
 *  - :282  ScheduleEvent job label = `${job_number} – ${customerName}` (job number is the
 *          stable substring; rendered inside react-big-calendar's `.rbc-event`)
 *  - :1767 sidebar section header text "Unassigned Jobs" (+ :1675 "Walkthroughs")
 *  - :1830-1833 sidebar card job-number span; :1819 card onClick →
 *          setAssignDialog({ open: true, jobId }) — i.e. click opens AssignJobDialog
 *  - :1872-1874 "Today" button; :1955-1969 day/week/month switcher buttons (DOM text is
 *          the lowercase react-big-calendar Views constant, CSS-capitalized — match /^month$/i)
 *  - :1988-2003 time-of-day window buttons "Full day" / "Morning" / "Afternoon"
 *  - :2117 calendar wrapper `.schedule-cal`; week/day grid = `.rbc-time-view`, month grid =
 *          `.rbc-month-view` (classnames confirmed in frontend/src/pages/schedule-dark.css)
 *  - components/jobs/AssignJobDialog.tsx:123 DialogTitle "Assign Technician"; :131 "Crew *"
 *          label; :222 Cancel button; :227 Assign submit disabled until a tech is selected
 *          (NOTE: the dialog does NOT render the job number — preselection is the jobId prop
 *          only, so DLV-23d asserts dialog-open + clean close, then no-mutation via the API)
 *
 * Shared serial org (workers:1): never assert absolute counts; assert PRESENCE of the
 * seeded job numbers. Known timing caveat: seeds anchor to "today" in the spec process —
 * a run that crosses local midnight between seed and test would miss the default range
 * (accepted; same caveat as the API-tier date-window rows).
 */

let api: ApiClient;

// DLV-23b/d — an UNASSIGNED job (appears ONLY in the sidebar, never as a calendar event).
let unassignedJobId: string;
let unassignedJobNumber: string;

// DLV-23c — a SCHEDULED job assigned to a fresh tech, scheduled TODAY (default week view).
let scheduledJobId: string;
let scheduledJobNumber: string;

/** Local "today at HH:00" as ISO — assign validates z.string().datetime({ offset: true }). */
function todayAt(hour: number): string {
  const d = new Date();
  d.setHours(hour, 0, 0, 0);
  return d.toISOString();
}

test.beforeAll(async () => {
  api = await new ApiClient().init();

  // ── DLV-23b/d seed: standalone (no-estimate) job → status UNASSIGNED on create
  //    (backend/src/controllers/job.controller.ts create(): customer+location path).
  const { customerId, locationId } = await createCustomerWithLocation(api);
  const { body: unassignedBody } = await api.createJob({
    customer_id: customerId,
    service_location_id: locationId,
    scope_notes: `DLV-23 unassigned smoke ${api.suffix}`,
  });
  expect(unassignedBody?.job?.id, 'UNASSIGNED job seed failed').toBeTruthy();
  expect(unassignedBody.job.status).toBe('UNASSIGNED');
  unassignedJobId = unassignedBody.job.id;
  unassignedJobNumber = unassignedBody.job.job_number;

  // ── DLV-23c seed: full chain via builders — lead → walkthrough → estimate SENT →
  //    public approve → job → assign to a FRESH tech TODAY 09:00–11:00 (fresh tech ⇒ no
  //    409 conflict; assign has no past-date guard, so a late-day run still seeds clean).
  const ctx = await leadToSentEstimate(api);
  const { res: approveRes } = await api.approveEstimatePublic(ctx.estimateId, ctx.publicToken, {
    signature_data: api.testSignature,
  });
  expect(approveRes.ok(), 'estimate approve seed failed').toBe(true);

  const { body: jobBody } = await api.createJob({ estimate_id: ctx.estimateId });
  expect(jobBody?.job?.id, 'SCHEDULED job seed failed').toBeTruthy();
  scheduledJobId = jobBody.job.id;
  scheduledJobNumber = jobBody.job.job_number;

  const techId = await createTech(api);
  const { res: assignRes, body: assignBody } = await api.assignJob(scheduledJobId, {
    assignee_ids: [techId],
    scheduled_start: todayAt(9),
    scheduled_end: todayAt(11),
  });
  expect(assignRes.ok(), 'assign seed failed').toBe(true);
  expect(assignBody.job.status).toBe('SCHEDULED');
});

test.afterAll(async () => {
  await api.dispose();
});

test.describe('Stage DLV-23 — Schedule page smoke (active org)', () => {
  test('DLV-23a: /schedule renders for admin — calendar grid + sidebar visible, gates clean', async ({ gatedPage: page, gate }) => {
    await page.goto('/schedule');

    // Sidebar (hidden below lg — chromium default 1280px viewport keeps it visible):
    // both section headers render regardless of content.
    await expect(page.getByRole('button', { name: /unassigned jobs/i })).toBeVisible();
    await expect(page.getByRole('button', { name: /walkthroughs/i })).toBeVisible();

    // Calendar grid: default WEEK view → `.schedule-cal` wrapper + rbc time grid.
    await expect(page.locator('.schedule-cal')).toBeVisible();
    await expect(page.locator('.rbc-time-view')).toBeVisible();

    // Toolbar anchors.
    await expect(page.getByRole('button', { name: 'Today' })).toBeVisible();
    await expect(page.getByRole('button', { name: /^week$/i })).toBeVisible();

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'DLV-23a');
    await screenshotAndAssert(page, 'DLV-23a-schedule.png', { expectVisible: ['Unassigned Jobs'] });
  });

  test('DLV-23b: seeded UNASSIGNED job appears in the unassigned sidebar', async ({ gatedPage: page, gate }) => {
    await page.goto('/schedule');

    // The sidebar card renders the job number in a span (SchedulePage.tsx:1830-1833).
    await expect(page.getByText(unassignedJobNumber, { exact: true }).first()).toBeVisible();

    // Delta: UNASSIGNED is excluded from the events query (:907 status filter), so the
    // number must NOT render as a calendar event — proving the sighting above is the sidebar.
    await expect(page.locator('.rbc-event').filter({ hasText: unassignedJobNumber })).toHaveCount(0);

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'DLV-23b');
    await screenshotAndAssert(page, 'DLV-23b-unassigned-sidebar.png', { expectVisible: [unassignedJobNumber] });
  });

  test('DLV-23c: seeded SCHEDULED job (today) appears as a calendar event', async ({ gatedPage: page, gate }) => {
    await page.goto('/schedule');

    // Default week view includes today; the event label starts with the job number
    // (ScheduleEvent :282 `${job_number} – ${customerName}`). The event lives inside the
    // scrollable time grid — Playwright visibility does not require it to be in-viewport.
    const event = page.locator('.rbc-event').filter({ hasText: scheduledJobNumber }).first();
    await expect(event).toBeVisible();

    // The same event element also carries the customer-name half of the label —
    // customerDisplayName renders "Customer, Test-…" (builder seeds last_name 'Customer').
    await expect(event).toContainText('Customer');

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'DLV-23c');
    await screenshotAndAssert(page, 'DLV-23c-scheduled-event.png');
  });

  test('DLV-23d: clicking the unassigned job card opens AssignJobDialog; close without mutating', async ({ gatedPage: page, gate }) => {
    await page.goto('/schedule');

    // Click the sidebar card (the job-number span bubbles to the card div's onClick →
    // setAssignDialog({ open: true, jobId }) — SchedulePage.tsx:1819).
    await page.getByText(unassignedJobNumber, { exact: true }).first().click();

    // AssignJobDialog opens (Radix role=dialog). The job is preselected via the jobId prop;
    // the dialog intentionally renders no job number (AssignJobDialog.tsx) — assert the
    // dialog shape instead, and prove no-mutation after closing via the API below.
    const dialog = page.getByRole('dialog');
    await expect(dialog).toBeVisible();
    await expect(dialog.getByText('Assign Technician')).toBeVisible();
    await expect(dialog.getByText(/crew/i).first()).toBeVisible();

    // Submit is disabled until a technician is selected (:227) — double safety against
    // accidental mutation in this smoke.
    await expect(dialog.getByRole('button', { name: /^assign$/i })).toBeDisabled();

    // CLOSE without submitting.
    await dialog.getByRole('button', { name: 'Cancel' }).click();
    await expect(dialog).toBeHidden();

    // No mutation: the job is still UNASSIGNED and still in the sidebar.
    const after = await api.getJob(unassignedJobId);
    expect(after.status).toBe('UNASSIGNED');
    await expect(page.getByText(unassignedJobNumber, { exact: true }).first()).toBeVisible();

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'DLV-23d');
    await screenshotAndAssert(page, 'DLV-23d-assign-dialog-closed.png');
  });

  test('DLV-23e: navigation controls — Month view and back without console errors', async ({ gatedPage: page, gate }) => {
    await page.goto('/schedule');
    await expect(page.locator('.rbc-time-view')).toBeVisible();

    // → Month (button DOM text is the lowercase Views constant, CSS-capitalized — :1955-1969).
    await page.getByRole('button', { name: /^month$/i }).click();
    await expect(page.locator('.rbc-month-view')).toBeVisible();
    await expect(page.locator('.rbc-time-view')).toHaveCount(0);

    // ← back to Week.
    await page.getByRole('button', { name: /^week$/i }).click();
    await expect(page.locator('.rbc-time-view')).toBeVisible();
    await expect(page.locator('.rbc-month-view')).toHaveCount(0);

    // "Today" re-anchors the date range (idempotent here — already on today's week).
    await page.getByRole('button', { name: 'Today' }).click();
    await expect(page.locator('.rbc-time-view')).toBeVisible();

    // The seeded scheduled event is still present after the round-trip (queries refetched
    // per view's dateRange without erroring).
    await expect(page.locator('.rbc-event').filter({ hasText: scheduledJobNumber }).first()).toBeVisible();

    await assertNoErrorBoundary(page);
    await assertGatesClean(gate, 'DLV-23e');
    await screenshotAndAssert(page, 'DLV-23e-view-roundtrip.png');
  });
});
