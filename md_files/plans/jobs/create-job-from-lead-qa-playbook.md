# QA Playbook — "Create Job from Lead" + "Schedule Job" Notification Re-Point

**Branch:** `feat/in-app-notifications`
**Date:** 2026-06-18
**Scope:** `CreateJobFromLeadDialog`, `LeadDetailPage` create-job wiring, `POST /api/jobs { estimate_id }` (estimate-conversion path), `resolveScheduleJobNotifications`, and the `SCHEDULE_JOB` inline-action re-point in `inlineActions.ts`.

> **This playbook does NOT duplicate** the core notification QA checklist at `md_files/plans/notifications/qa-checklist.md`. Run that checklist first (core routing, engagement states, realtime, mobile, isolation). This document focuses exclusively on the Create-Job-from-Lead surface and the Schedule-Job notification re-point.

---

## 1. Pre-requisites & Setup

### 1.1 Infrastructure (applies before any QA session — Ran applies)

Before running this playbook, all four out-of-band artifacts from the notifications checklist pre-reqs must be applied:

- [ ] Migration `20260618000000_add_notifications_tables` applied to the target env (staging or demo).
- [ ] `backend/scripts/security/2026-06-15-keystone-rls-revoke.sql` re-run so the new tables get FORCE RLS + zero anon/authenticated grants.
- [ ] Migration `20260618000100_backfill_notification_grants` applied.
- [ ] `backend/scripts/security/2026-06-18-notifications-realtime-rls.sql` applied + Supabase Realtime Authorization (private channels) enabled.

> **No additional migration** is required for this feature. The Create-Job-from-Lead + Schedule-Job re-point rides on the notifications tables above (no schema change).

### 1.2 Deployed instance

Use the ServWave demo at `https://servwave-demo.vercel.app` (backed by the `feat/in-app-notifications` branch on Render) after the migrations above are applied. Alternatively, run locally (`npm run dev:backend` port 3000, `npm run dev:frontend` port 5173) — note that the local `.env` DATABASE_URL points at staging Supabase.

### 1.3 Required test data

Prepare the following lead fixtures **within the same organization** (use the Admin account to create them). Each fixture is referenced by name in the scenarios below:

| Fixture name | What it contains |
|---|---|
| **Lead-EMPTY** | A lead with no estimates at all |
| **Lead-NONAPP** | A lead with one or more estimates, none of which are APPROVED (e.g. one SENT, one DRAFT) |
| **Lead-ONE-APP** | A lead with exactly one APPROVED, un-converted estimate (no job linked yet); no deposit invoice |
| **Lead-DEPOSIT-UNPAID** | A lead with one APPROVED estimate that has a `kind=DEPOSIT` invoice in SENT status (i.e. unpaid) |
| **Lead-MULTI-APP** | A lead with 2+ APPROVED, un-converted estimates |
| **Lead-CONVERTED** | A lead with one estimate that is APPROVED and has already been converted (a job exists, linked via `estimate_id`) — the estimate `job` field is non-null |
| **Lead-MIXED** | A lead with at least: one SENT estimate, one APPROVED-unconverted estimate, and one APPROVED-converted estimate |

> All leads must belong to the same org as the logged-in user. Cross-org leads are tested in S-RBAC-05 via the API directly.

### 1.4 Browser setup — role accounts

Open a **separate browser or incognito window** for each role. Simultaneously logged-in roles are used in notification lifecycle scenarios (S-NOTIF-*).

| Short label | Role | Notes |
|---|---|---|
| **AS ADMIN** | ADMIN role | Full access; sees "Create Job" button |
| **AS DISPATCHER** | DISPATCHER role | Full access; sees "Create Job" button; receives pinned SCHEDULE_JOB notification |
| **AS SALES-OWNER** | SALES role; is the `commission_owner` of the test leads | Does NOT see "Create Job" button |
| **AS SALES-OTHER** | SALES role; is NOT the owner of the test leads | Does NOT see "Create Job" button; can't even load another owner's lead |
| **AS TECH** | TECHNICIAN role; assigned as walkthrough performer on Lead-ONE-APP | Sees "Create Job" button (M1 — expected; API 403s) |

---

## 2. Known / Expected Minor Behaviors

Do **not** file these as new bugs. Reference these sections when a tester observes the behavior.

### M1 — Technician sees "Create Job" but action 403s

**Root cause:** `canConvertToJob` in `LeadDetailPage.tsx:685-686` evaluates `ability.can('create', 'Job')`, which is `true` for TECHNICIAN (they have the generic `create Job` grant for the urgent-job flow). A technician who is a walkthrough performer on a lead can read that lead and will see the sage "Create Job" button. Clicking it opens the modal; selecting an estimate and clicking "Create job" sends `POST /api/jobs { estimate_id }`, which the controller rejects at `job.controller.ts:606-609` (role===TECHNICIAN → 403). The `onError` handler surfaces a destructive toast: **"Could not convert to job"**.

**Expected behavior:** Button visible, modal opens, convert clicks → toast "Could not convert to job". The modal stays open (not closed on error). No data is changed.

**Recommended fix (not yet applied):** Gate the button on `role===ADMIN || role===DISPATCHER` instead of the generic `can('create','Job')`. One-line FE change; no backend change.

### M2 — Brief empty-flash when deep-link opens modal before estimates load

**Root cause:** The `?createJob=` effect in `LeadDetailPage.tsx:577-585` sets `createJobOpen=true` immediately on mount, but `estimates` arrives from the async `useQuery` for the lead. On the first render the dialog may briefly show "No estimates yet." before the lead query resolves and the `useEffect` in `CreateJobFromLeadDialog.tsx:49-56` re-runs to apply the preselect.

**Expected behavior:** On a cold load or slow connection, the modal may flash "No estimates yet." for a moment before the correct estimate appears pre-selected. No incorrect conversion can result — the preselect gate (`convertible.some(e => e.id === preselectEstimateId)`) only fires once estimates are populated.

**Reproduce:** Deep-link to `/leads/:id?createJob=<valid-uuid>` with DevTools network throttled to "Slow 3G".

### M3 — Stale notification pin if the resolve helper throws on the FIRST conversion

**Root cause:** `resolveScheduleJobNotifications` wraps its body in try/catch and swallows any DB error (`resolveNotifications.ts:42-44`). If this helper throws internally on the first successful conversion, the Dispatcher's "Schedule job" pin remains `needs_action:true`. Subsequent idempotent re-POSTs of the same `estimate_id` return the existing job (200 early-return at `job.controller.ts:697-700`) and intentionally skip the resolve call. This is an accepted design trade-off (the resolve failure cannot roll back or block the job).

**Expected behavior (low probability):** In the rare event of a DB error during resolve, the dispatcher's pin may remain visible under "Needs action" after the job is created. The job itself is correctly created. The fix is optional (call resolve on the idempotent 200 branch too — it would be a no-op when already resolved).

---

## 3. Automated Coverage Already in Place

Testers do not need to manually verify the following — they are covered by unit/integration tests in the test suite (run `npm test --workspace=backend` and `npm test --workspace=frontend`):

| Area | Test file | What's covered |
|---|---|---|
| `resolveScheduleJobNotifications` | `backend/src/services/notifications/__tests__/resolveNotifications.test.ts` (5 cases) | Happy path stamps acted_at+read_at on SCHEDULE_JOB needs_action rows; no-op when no matching notifications; never throws on DB error (findMany or updateMany rejection); uses injected client |
| SCHEDULE_JOB inline action re-point | `frontend/src/components/notifications/__tests__/inlineActions.test.ts` | Lead deep-link with createJob param (lead_id present); fallback to estimate page (legacy payload, no lead_id); fallback to `/jobs?action=new-job` (no ids at all); `skipActed: true` returned in both new + legacy paths |
| CreateJobFromLeadDialog component | `frontend/src/components/leads/__tests__/CreateJobFromLeadDialog.test.tsx` (7 cases) | Empty estimates → disabled; sole approved → auto-selected + onConvert called; SENT-only → disabled; converted → J##### link + navigate; preselectEstimateId; New estimate navigates + closes; canCreateEstimate:false hides button |
| resolve called on successful conversion | `backend/src/__tests__/jobs.test.ts` | `resolveScheduleJobNotifications` called once with (estimateId, orgId) on 201; NOT called on standalone job create |
| `lead_id` in approval payloads | `backend/src/__tests__/estimate-notifications.test.ts` | All 5 emit sites (approvePublic, recordEstimatePayment 2 paths, webhook 2 paths) include `data.lead_id` |
| Estimate status gate (API) | `backend/src/__tests__/jobs.test.ts` | 400 for non-APPROVED; 404 for not-found or cross-tenant; 400 for orphan estimate (no customer) |
| Deposit gate (API) | `backend/src/__tests__/jobs.test.ts` | PAID/no-deposit → 201; SENT deposit → 400 |
| Idempotency (API) | `backend/src/__tests__/jobs.test.ts` | Second POST for already-converted estimate → 200 with existing job (not 409, not dup) |
| Cross-tenant isolation | `backend/src/__tests__/tenant-attack.test.ts` (58 cases) | Foreign org estimate_id → 404 |
| Input validation | `backend/src/__tests__/jobs.test.ts` | Neither estimate_id nor customer+location → 400; non-UUID → 400 |

**What requires manual QA:** end-to-end flows across the UI (button visibility per role, modal state rendering, deep-link parameter lifecycle, notification pin/unpin, mobile viewport, redirect-and-return while logged out).

---

## 4. Scenario Catalog

### Group A — Button Visibility Per Role

**Setup for all A scenarios:** Open Lead-ONE-APP in each role's browser.

---

#### S-A-01: Admin sees "Create Job" button
- **Preconditions:** Logged in AS ADMIN. Viewing Lead-ONE-APP (not a terminal lead: status is not WON/LOST/CANCELLED).
- **Steps:**
  1. Navigate to `/leads/<Lead-ONE-APP id>`.
  2. Inspect the header action area (top-right of the lead card, where "Edit", "+ New Estimate", and "Assign" buttons appear).
- **Expected result:** A sage (green) "Create Job" button with a Briefcase icon is visible.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-A-02: Dispatcher sees "Create Job" button
- **Preconditions:** Logged in AS DISPATCHER. Viewing Lead-ONE-APP.
- **Steps:**
  1. Navigate to `/leads/<Lead-ONE-APP id>`.
  2. Inspect the header action area.
- **Expected result:** Sage "Create Job" button with Briefcase icon is visible.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-A-03: Sales-owner does NOT see "Create Job" button
- **Preconditions:** Logged in AS SALES-OWNER (this user IS the `commission_owner` of Lead-ONE-APP).
- **Steps:**
  1. Navigate to `/leads/<Lead-ONE-APP id>`.
  2. Inspect the header action area.
- **Expected result:** No "Create Job" button. The "+ New Estimate" button is present (SALES can create estimates). No Briefcase button anywhere in the header.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-A-04: Sales-non-owner cannot access another owner's lead at all
- **Preconditions:** Logged in AS SALES-OTHER (a different SALES user; NOT the owner of Lead-ONE-APP).
- **Steps:**
  1. Navigate directly to `/leads/<Lead-ONE-APP id>` via the URL bar.
- **Expected result:** Lead detail page shows "Lead not found." (the API returns 404 because the OWN_LEAD scope only exposes leads where this user is the owner). No "Create Job" button is reachable.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-A-05: Technician on a walkthrough lead sees button but action 403s (M1 — expected)
- **Preconditions:** Logged in AS TECH (a technician added as a walkthrough performer on Lead-ONE-APP). Lead-ONE-APP has one APPROVED, un-converted estimate.
- **Steps:**
  1. Navigate to `/leads/<Lead-ONE-APP id>`.
  2. Observe the header action area — confirm the sage "Create Job" button IS visible (this is the M1 known behavior).
  3. Click "Create Job".
  4. In the modal, the approved estimate should appear pre-selected (only one convertible). Click "Create job".
- **Expected result:** The convert request fires `POST /api/jobs { estimate_id }`. The API returns 403. A destructive toast appears: "Could not convert to job" (with the message "Insufficient permissions" or similar). The modal remains open (does not close on error). No job is created.
- **Note:** This is **M1 — expected minor behavior**. Do not file as a bug.
- **Pass/fail:** [ ] Pass [ ] Fail

---

### Group B — Modal States

**Setup for all B scenarios:** Logged in AS ADMIN or AS DISPATCHER. Each scenario specifies which lead fixture to use.

---

#### S-B-01: Empty lead — no estimates at all
- **Preconditions:** Lead-EMPTY (zero estimates).
- **Steps:**
  1. Navigate to Lead-EMPTY.
  2. Click "Create Job".
- **Expected result:**
  - Modal opens with title "Create job from estimate".
  - Body shows a FileText icon and the text "No estimates yet."
  - "Create job" button is disabled (greyed out, not clickable).
  - If AS ADMIN: "New estimate" button is present and clickable (see S-C-01).
  - "Cancel" button dismisses the modal.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-B-02: Lead has estimates but none are APPROVED
- **Preconditions:** Lead-NONAPP (e.g. one SENT, one DRAFT estimate; none APPROVED).
- **Steps:**
  1. Navigate to Lead-NONAPP.
  2. Click "Create Job".
- **Expected result:**
  - Modal lists all estimates with their status badges (SENT, DRAFT, etc.) and amounts.
  - None are selectable (no radio dot, no `cursor-pointer`; rows appear at reduced opacity).
  - A hint below the list reads: "No approved estimate to convert yet. Approve an estimate first, or create a new one below." (with "or create…" only when Admin/Sales can create estimates).
  - "Create job" button is disabled.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-B-03: Lead has exactly one APPROVED un-converted estimate — auto-selected
- **Preconditions:** Lead-ONE-APP (one APPROVED estimate, no job linked, no deposit invoice).
- **Steps:**
  1. Navigate to Lead-ONE-APP.
  2. Click "Create Job".
- **Expected result:**
  - Modal opens with the single APPROVED estimate already selected (filled radio dot, `border-primary bg-primary-subtle` highlight).
  - Estimate number (e.g. "E00001"), APPROVED status badge, and amount are shown.
  - "Create job" button is enabled (sage/green color, not greyed).
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-B-04: Lead has multiple APPROVED un-converted estimates — none auto-selected
- **Preconditions:** Lead-MULTI-APP (2+ APPROVED, un-converted estimates).
- **Steps:**
  1. Navigate to Lead-MULTI-APP.
  2. Click "Create Job".
- **Expected result:**
  - Modal lists all APPROVED estimates; none are pre-selected (no filled radio dot on any row).
  - "Create job" button is disabled until the tester clicks a row to select it.
  - After clicking one row, that row highlights and "Create job" becomes enabled.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-B-05: Already-converted estimate shows J##### link, not selectable
- **Preconditions:** Lead-CONVERTED (one estimate with a linked job, e.g. J00007).
- **Steps:**
  1. Navigate to Lead-CONVERTED.
  2. Click "Create Job".
- **Expected result:**
  - The converted estimate row shows the estimate number + APPROVED badge + a small underlined link "J00007 →" on the right (instead of the amount).
  - The row is NOT selectable (no radio dot, reduced opacity, no `cursor-pointer`).
  - "Create job" button is disabled (no convertible estimates).
  - Clicking "J00007 →" closes the modal and navigates to `/jobs/<job id>`.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-B-06: Mixed lead — SENT + APPROVED-unconverted + APPROVED-converted
- **Preconditions:** Lead-MIXED (at least: one SENT, one APPROVED-unconverted, one APPROVED-converted).
- **Steps:**
  1. Navigate to Lead-MIXED.
  2. Click "Create Job".
- **Expected result:**
  - SENT estimate: shown with SENT badge, no radio dot, reduced opacity.
  - APPROVED-unconverted estimate: shown with APPROVED badge, radio dot (selectable), amount shown.
  - APPROVED-converted estimate: shown with APPROVED badge, J##### link, no radio dot, reduced opacity.
  - "Create job" is enabled only after selecting the APPROVED-unconverted estimate.
  - No hint about "no approved estimate" because at least one convertible exists.
- **Pass/fail:** [ ] Pass [ ] Fail

---

### Group C — "New Estimate" Path

---

#### S-C-01: "New estimate" button navigates to /estimates/new?lead_id=… (Admin)
- **Preconditions:** Logged in AS ADMIN. Lead-EMPTY or Lead-NONAPP. Modal is open.
- **Steps:**
  1. Click "New estimate" in the modal footer (left side).
- **Expected result:**
  - Modal closes.
  - Browser navigates to `/estimates/new?lead_id=<lead id>`.
  - No conversion is triggered (no `POST /api/jobs` call fires — verify via browser DevTools network tab if desired).
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-C-02: "New estimate" button navigates to /estimates/new?lead_id=… (Sales-owner, if they open modal via direct URL — not via button which they can't see)
- **Preconditions:** Logged in AS SALES-OWNER. Open the modal via the `?createJob=<id>` deep-link (they will land on the modal via a notification deep-link even though the button itself is not visible to them — note: SALES receives no SCHEDULE_JOB notification, so this is a hypothetical edge case). Alternatively, skip this scenario if SALES cannot reach the modal at all (they can't see the button and typically won't receive the deep-link).
- **Note:** In practice SALES does not receive the SCHEDULE_JOB notification, so this path is unlikely in production. The `canCreateEstimate` flag is `true` for SALES, meaning the "New estimate" button would show if they ever open the modal. This scenario is informational; skip if access is blocked before the modal.
- **Pass/fail:** [ ] Pass [ ] Fail [ ] N/A (SALES can't reach modal)

---

#### S-C-03: "New estimate" button hidden when canCreateEstimate is false (Dispatcher)
- **Preconditions:** Logged in AS DISPATCHER. Lead-ONE-APP. Modal open.
- **Steps:**
  1. Observe the modal footer.
- **Expected result:** No "New estimate" button in the modal footer. The left side of the footer is empty (`<span />`). Only "Cancel" and "Create job" buttons are shown.
- **Note:** `canCreateEstimate = (role===ADMIN || role===SALES) && !isTerminal`. Dispatcher is neither ADMIN nor SALES, so this evaluates to false.
- **Pass/fail:** [ ] Pass [ ] Fail

---

### Group D — Convert Happy Path

---

#### S-D-01: Successful conversion — lands on /jobs/:id
- **Preconditions:** Logged in AS ADMIN or AS DISPATCHER. Lead-ONE-APP (one APPROVED estimate, no deposit invoice, no linked job).
- **Steps:**
  1. Navigate to Lead-ONE-APP.
  2. Click "Create Job". Confirm the estimate is auto-selected.
  3. Click "Create job" (sage button).
  4. Observe the button changes to "Creating…" (spinner) while the request is in flight.
- **Expected result:**
  - `POST /api/jobs { estimate_id: "<id>" }` returns 201.
  - Browser navigates to `/jobs/<new job id>`.
  - The new job detail page loads with status UNASSIGNED (or SCHEDULED if a start_time was assigned) and the estimate number referenced.
  - The lead's estimate now shows as converted (if you go back to the lead, the estimate row in the modal will show a J##### link).
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-D-02: Estimate is marked converted in the lead after job creation
- **Preconditions:** Continue from S-D-01 (a job was just created from Lead-ONE-APP's estimate).
- **Steps:**
  1. Navigate back to `/leads/<Lead-ONE-APP id>`.
  2. Click "Create Job" again.
- **Expected result:**
  - Modal opens. The previously-approved estimate now shows as converted: the J##### link is displayed instead of the amount, and the row is not selectable.
  - "Create job" button is disabled (no convertible estimates remain).
- **Pass/fail:** [ ] Pass [ ] Fail

---

### Group E — Convert Guard Scenarios

---

#### S-E-01: Non-approved estimate is not selectable in the modal (UI guard)
- **Preconditions:** Lead-NONAPP (SENT estimate only). Modal open.
- **Steps:**
  1. Attempt to click the SENT estimate row.
- **Expected result:** The row has no click handler (it renders without `onClick`), so nothing happens. No selection state changes. "Create job" remains disabled.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-E-02: Deposit required but unpaid — API returns 400, toast shown, modal stays open
- **Preconditions:** Logged in AS DISPATCHER. Lead-DEPOSIT-UNPAID (APPROVED estimate with a `kind=DEPOSIT` invoice in SENT status — i.e. the deposit has been configured but not yet paid).
- **Steps:**
  1. Navigate to Lead-DEPOSIT-UNPAID.
  2. Click "Create Job". The approved estimate is auto-selected.
  3. Click "Create job".
- **Expected result:**
  - `POST /api/jobs { estimate_id }` returns 400 with error: "Deposit must be paid or waived before creating a job. Mark the deposit as received or waive it first."
  - A destructive toast appears with the error message.
  - The modal remains open (not closed on error). The button returns from "Creating…" to "Create job".
  - No job is created.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-E-03: Double-click / re-convert is idempotent — no duplicate job created
- **Preconditions:** Logged in AS DISPATCHER. Lead-ONE-APP.
- **Steps:**
  1. Click "Create Job", select the estimate, and click "Create job" once. Note the job ID returned (from the URL after navigation).
  2. Simulate a retry: navigate back to the lead and click "Create Job" again (or issue `POST /api/jobs { estimate_id: "<same id>" }` directly via curl/Postman).
- **Expected result on re-POST:** HTTP 200 (not 201, not 409). The response body contains the same job that was created in step 1 (same `id`, same `job_number`). No second job is created. The estimate still maps to the same job.
- **Note:** The modal path after re-navigation will show the estimate as already-converted (S-D-02), so the button will be disabled — this scenario mainly verifies the API boundary.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-E-04: Cross-tenant estimate ID rejected — 404 at API
- **Preconditions:** Access to a second organization's estimate UUID (e.g. from a test admin account in org B).
- **Steps:**
  1. While logged in AS DISPATCHER (org A), issue `POST /api/jobs { estimate_id: "<org B estimate UUID>" }` directly (curl, Postman, or DevTools).
- **Expected result:** 404 — "Estimate not found". No job is created. No data from org B is exposed.
- **Note:** Covered by automated tests; verify manually for confidence.
- **Pass/fail:** [ ] Pass [ ] Fail [ ] N/A (no second org available)

---

#### S-E-05: SALES role is denied at the API (403)
- **Preconditions:** Logged in AS SALES-OWNER.
- **Steps:**
  1. Issue `POST /api/jobs { estimate_id: "<valid APPROVED estimate id>" }` directly via DevTools or curl with the SALES user's auth cookie.
- **Expected result:** 403 — "Insufficient permissions" (or "Forbidden"). The SALES role has no `create Job` grant on the estimate-conversion path.
- **Note:** SALES cannot reach the modal button from the UI (S-A-03), so this is an API-layer-only verification.
- **Pass/fail:** [ ] Pass [ ] Fail

---

### Group F — Notification Re-Point Lifecycle

**Setup:** Two browsers open simultaneously — one AS DISPATCHER, one AS ADMIN or AS SALES-OWNER (to approve the estimate). Both are connected to the same demo environment with realtime enabled.

---

#### S-F-01: Approve estimate → Dispatcher receives pinned "Schedule job" notification deep-linked to the LEAD
- **Preconditions:** A lead with one APPROVED estimate that has NOT yet been converted. The Dispatcher has NOT previously received a SCHEDULE_JOB notification for this estimate (use a fresh estimate or mark any existing ones as read/acted).
- **Steps:**
  1. AS SALES-OWNER (or Admin): approve the estimate via the estimate detail page's public-approve flow or the "Record payment" / "Approve" action.
  2. AS DISPATCHER: wait 1–2 seconds. Observe the notification bell.
- **Expected result:**
  - The bell badge increments (red count badge).
  - Under "Needs action" (the pinned section), a new notification appears: **"Schedule job"** (or similar wording) for this estimate.
  - The notification has a **"Schedule job"** action button.
  - It is pinned (appears in the Needs Action section, not just the general feed).
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-F-02: Clicking "Schedule job" notification deep-links to the LEAD (not the estimate page)
- **Preconditions:** Continue from S-F-01. The "Schedule job" notification is visible in the Dispatcher's bell.
- **Steps:**
  1. AS DISPATCHER: click the "Schedule job" action button on the notification.
- **Expected result:**
  - Browser navigates to `/leads/<lead id>?createJob=<estimate id>` — the LEAD detail page, NOT the estimate detail page.
  - The `CreateJobFromLeadDialog` modal opens automatically, with the approved estimate pre-selected.
  - The URL's `?createJob=` parameter is stripped immediately (replaced via `history.replace`), so the address bar shows `/leads/<lead id>` after a brief moment.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-F-03: Notification remains PINNED after clicking "Schedule job" (not auto-acted)
- **Preconditions:** Continue from S-F-02. The modal opened automatically; close the modal WITHOUT converting (click Cancel or press Escape).
- **Steps:**
  1. Close the modal without converting.
  2. Open the notification bell again.
- **Expected result:**
  - The "Schedule job" notification is still present under "Needs action" (still pinned).
  - It does NOT move to the "Earlier" feed section or show a "✓ done" state.
  - The `skipActed: true` return value from `handleScheduleJob` means `markActed` was never called on click.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-F-04: Notification leaves "Needs action" AFTER job is actually created
- **Preconditions:** Continue from S-F-03. The "Schedule job" notification is still pinned.
- **Steps:**
  1. AS DISPATCHER: Click "Create Job" on the lead page (or use the still-open modal from S-F-02). Select the approved estimate and click "Create job" to convert it.
  2. Wait for navigation to `/jobs/:id`.
  3. Navigate to the bell or refresh it.
- **Expected result:**
  - The "Schedule job" notification for this estimate NO LONGER appears under "Needs action".
  - It either moves to the general "Earlier" feed as a done item, or disappears entirely from the feed.
  - The job was successfully created (the job detail page loaded).
- **Note:** Resolution happens via `resolveScheduleJobNotifications` called post-commit in `job.controller.ts:761-763`. Realtime update may take 1–2s; a manual refresh of the bell should reflect the resolved state.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-F-05: Sales/Admin informational notification copies are NOT affected by resolution
- **Preconditions:** Same flow as S-F-01 to S-F-04. If Admin or Sales-owner received an informational (non-pinned) notification for the same estimate-approval event, it should not change.
- **Steps:**
  1. AS ADMIN: observe the bell during the S-F-04 job creation.
  2. Check that the Admin's informational copy of the estimate-approved/deposit-paid notification is still present and in its original state (not acted, not removed).
- **Expected result:** Admin's informational notification is unchanged. The resolve helper's `updateMany` filter (`needs_action: true, acted_at: null`) ensures only the Dispatcher's pinned SCHEDULE_JOB row is touched; informational copies have `needs_action: false` and are therefore skipped.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-F-06: Legacy notification without lead_id falls back to estimate page (still pinned)
- **Preconditions:** This requires a notification row that was emitted BEFORE the B1 payload change (i.e. without `data.lead_id`). Either: (a) use a notification seeded directly in the DB with `data: { object_label: "E00001" }` and no `lead_id` field; or (b) test via the inlineActions unit test (automated, already covered). For manual verification, simulate by temporarily removing `lead_id` from a notification row in Supabase Studio.
- **Steps:**
  1. AS DISPATCHER: click the "Schedule job" action on a legacy notification (no `lead_id` in `data`).
- **Expected result:**
  - Browser navigates to `/estimates/<estimate id>` (the estimate detail page, not the lead page).
  - The notification remains pinned (not acted — `skipActed: true` still returned).
- **Note:** Covered by automated test `SCHEDULE_JOB falls back to the estimate page for legacy payloads without lead_id` in `inlineActions.test.ts`. Manual verification is optional.
- **Pass/fail:** [ ] Pass [ ] Fail [ ] N/A (skipped — covered by unit test)

---

#### S-F-07: Deposit-paid event also re-points to lead (same lifecycle)
- **Preconditions:** A lead with an APPROVED estimate that has a `kind=DEPOSIT` invoice. Pay the deposit (via Stripe test checkout or direct "Record payment").
- **Steps:**
  1. AS DISPATCHER: observe the new "Schedule job" notification (fired on `estimate.deposit_paid` event).
  2. Click the notification.
- **Expected result:** Same as S-F-02: navigates to the lead with `?createJob=<estimate id>`. The `estimate.deposit_paid` emit was updated by B1 to include `lead_id`.
- **Pass/fail:** [ ] Pass [ ] Fail

---

### Group G — Deep-Link Parameter Edge Cases

---

#### S-G-01: `?createJob=` with a valid, convertible estimate ID — preselects correctly
- **Preconditions:** Logged in AS DISPATCHER. Know the UUID of a convertible (APPROVED, unconverted) estimate that belongs to Lead-MULTI-APP.
- **Steps:**
  1. Navigate directly to `/leads/<Lead-MULTI-APP id>?createJob=<convertible estimate UUID>`.
- **Expected result:**
  - Modal opens automatically.
  - The correct estimate is pre-selected (highlighted row with radio dot).
  - "Create job" is enabled.
  - URL is stripped to `/leads/<Lead-MULTI-APP id>` immediately (no `?createJob=` visible in address bar after a moment).
  - The `preselectEstimateId` is cleared on close so a subsequent manual open starts fresh.
- **Note:** If estimates load slowly, a brief M2 flash of "No estimates yet." may appear first — expected.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-G-02: `?createJob=` with a garbage/non-UUID value — modal opens without preselect (no crash)
- **Preconditions:** Logged in AS DISPATCHER.
- **Steps:**
  1. Navigate to `/leads/<Lead-ONE-APP id>?createJob=not-a-uuid`.
- **Expected result:**
  - Modal opens automatically.
  - No estimate is pre-selected (the garbage id doesn't match any convertible estimate).
  - If Lead-ONE-APP has exactly one APPROVED estimate, it auto-selects via the `convertible.length === 1` fallback (`CreateJobFromLeadDialog.tsx:53`).
  - No crash, no error toast, no wrong conversion.
  - URL is stripped to `/leads/<Lead-ONE-APP id>`.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-G-03: `?createJob=` with a foreign (different org) estimate UUID — modal degrades safely
- **Preconditions:** Know a valid UUID from another org's estimate. Logged in AS DISPATCHER (org A).
- **Steps:**
  1. Navigate to `/leads/<org A lead id>?createJob=<org B estimate UUID>`.
- **Expected result:**
  - Modal opens. The foreign estimate UUID is not in the lead's own `convertible` list (estimates come from the tenant-scoped lead API response). No preselect happens.
  - If Lead-ONE-APP has a convertible estimate, the single-estimate auto-select fallback may activate instead.
  - No crash. The "Create job" button, if clicked with the wrong id, will hit `POST /api/jobs { estimate_id }` with the auto-selected lead estimate — not the foreign one (the modal only submits `selectedId` which was drawn from the lead's rendered list).
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-G-04: `?createJob=` with an already-converted estimate UUID — modal opens without preselect
- **Preconditions:** Logged in AS DISPATCHER. Know the UUID of a converted estimate (one that already has a job linked) from Lead-MIXED.
- **Steps:**
  1. Navigate to `/leads/<Lead-MIXED id>?createJob=<converted estimate UUID>`.
- **Expected result:**
  - Modal opens. The converted estimate UUID does NOT satisfy `convertible.some(e => e.id === preselectEstimateId)` (it is excluded from `convertible` because it has `est.job !== null`).
  - No preselect on the converted estimate.
  - If one other APPROVED unconverted estimate exists, that one may auto-select (single-convertible fallback).
  - No crash.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-G-05: Closing modal strips the `?createJob=` param — hard refresh does NOT reopen modal
- **Preconditions:** Logged in AS DISPATCHER. Open the lead via deep-link: `/leads/<Lead-ONE-APP id>?createJob=<estimate UUID>`.
- **Steps:**
  1. Modal opens automatically (S-G-01). Confirm the URL is already stripped (no `?createJob=`).
  2. Click "Cancel" to close the modal.
  3. Hard-refresh the page (Cmd+Shift+R / Ctrl+Shift+R).
- **Expected result:**
  - After step 1, address bar shows `/leads/<id>` (param removed via `setSearchParams(..., { replace: true })`).
  - After step 2, modal is closed. The `preselectEstimateId` state is cleared to null (the `onOpenChange` handler at `LeadDetailPage.tsx:1274-1279` calls `setPreselectEstimateId(null)` on close).
  - After step 3, the page loads normally — the modal does NOT reopen (no `?createJob=` in the URL).
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-G-06: Manual "Create Job" button after a deep-link visit opens fresh modal (no stale preselect)
- **Preconditions:** Continue after S-G-05 (page is on `/leads/<Lead-ONE-APP id>`, modal was closed, preselectEstimateId cleared).
- **Steps:**
  1. Click the "Create Job" button manually.
- **Expected result:**
  - Modal opens. Because `preselectEstimateId` is null and there is exactly one convertible estimate, the single-estimate auto-select fires — the estimate is selected. This is correct behavior (not a stale deep-link preselect; it's the legitimate single-option default).
  - If Lead-MULTI-APP is used instead: no pre-selection (multi-option, no preselect), "Create job" disabled until user selects.
- **Pass/fail:** [ ] Pass [ ] Fail

---

### Group H — Cross-Cutting Concerns

---

#### S-H-01: Mobile viewport — modal is usable on a narrow screen
- **Preconditions:** Logged in AS DISPATCHER. Use browser DevTools device emulation (375px wide, e.g. iPhone SE).
- **Steps:**
  1. Navigate to Lead-MIXED.
  2. Click "Create Job".
  3. Scroll the estimate list if it overflows.
  4. Select an APPROVED estimate and click "Create job".
- **Expected result:**
  - Modal renders within the viewport (`max-w-md` constrains width; on small screens it uses full width).
  - The estimate list scrolls vertically (`max-h-72 overflow-y-auto`).
  - "Create job" and "New estimate" buttons are accessible without horizontal scrolling.
  - Conversion succeeds.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-H-02: Deep-link while logged out — redirect to login then back to lead
- **Preconditions:** Logged out (or use a private window with no session). Know a valid lead URL with `?createJob=<estimate UUID>`.
- **Steps:**
  1. Navigate directly to `/leads/<lead id>?createJob=<estimate UUID>`.
- **Expected result:**
  - The app redirects to the login page (auth guard).
  - After logging in (AS DISPATCHER), the app redirects back to the original URL (`/leads/<id>?createJob=<uuid>`).
  - The `useEffect` fires, the modal opens pre-selected, and the param is stripped.
  - Conversion can proceed normally.
- **Note:** Redirect-back behavior depends on whether the router preserves the `from` location. Verify the post-login destination includes the `?createJob=` param or, at minimum, lands on the correct lead.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-H-03: RBAC at the API — Technician POST /api/jobs with estimate_id returns 403
- **Preconditions:** Logged in AS TECH. Have the auth token (from DevTools Application → Cookies).
- **Steps:**
  1. Issue `POST /api/jobs { estimate_id: "<valid APPROVED estimate UUID>" }` with the technician's auth credentials (via curl or DevTools Fetch).
- **Expected result:** 403 — "Insufficient permissions". The controller gate at `job.controller.ts:606-609` fires before any DB lookup. No job created.
- **Note:** This is the server-side complement to M1.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-H-04: Convert-to-Job button on the estimate detail page still works (regression check)
- **Preconditions:** Logged in AS DISPATCHER. Navigate to an APPROVED, unconverted estimate's detail page (not via the lead page).
- **Steps:**
  1. On the estimate detail page, click the existing "Create Job" button (the one that was there before this feature).
- **Expected result:** The existing convert flow still works: navigates to `/jobs/:id` after a successful `POST /api/jobs { estimate_id }`. This feature added a second entry point on the lead; it did not remove or alter the estimate-page one.
- **Pass/fail:** [ ] Pass [ ] Fail

---

#### S-H-05: Notification bell isolation — Dispatcher's pinned item doesn't show in Sales or Admin's bell as actionable
- **Preconditions:** After S-F-01: the Dispatcher has a pinned "Schedule job" notification. AS ADMIN and AS SALES-OWNER are also logged in.
- **Steps:**
  1. AS ADMIN: open the bell. Look at "Needs action".
  2. AS SALES-OWNER: open the bell. Look at "Needs action".
- **Expected result:**
  - Neither Admin nor Sales sees a "Schedule job" item under "Needs action" for this event. Admin may see a plain informational item (non-pinned). Sales-owner may see their own INTERRUPT copy. Neither has an actionable pin.
  - The pinned SCHEDULE_JOB recipient row (`needs_action: true`) was created only for the Dispatcher recipient.
- **Pass/fail:** [ ] Pass [ ] Fail

---

## 5. Pass / Fail Summary Sheet

| Scenario | Description | Result |
|---|---|---|
| S-A-01 | Admin sees Create Job button | [ ] P [ ] F |
| S-A-02 | Dispatcher sees Create Job button | [ ] P [ ] F |
| S-A-03 | Sales-owner does NOT see Create Job button | [ ] P [ ] F |
| S-A-04 | Sales-non-owner cannot access lead | [ ] P [ ] F |
| S-A-05 | Technician sees button but action 403s (M1 expected) | [ ] P [ ] F |
| S-B-01 | Empty lead — "No estimates yet", Create job disabled | [ ] P [ ] F |
| S-B-02 | Non-approved estimates only — all greyed, Create job disabled | [ ] P [ ] F |
| S-B-03 | Single APPROVED estimate — auto-selected | [ ] P [ ] F |
| S-B-04 | Multiple APPROVED estimates — none auto-selected | [ ] P [ ] F |
| S-B-05 | Already-converted — J##### link, not selectable | [ ] P [ ] F |
| S-B-06 | Mixed lead — correct selectability per status | [ ] P [ ] F |
| S-C-01 | "New estimate" navigates to /estimates/new?lead_id=… (Admin) | [ ] P [ ] F |
| S-C-02 | "New estimate" button visible to Sales if modal reachable | [ ] P [ ] F [ ] N/A |
| S-C-03 | "New estimate" button hidden for Dispatcher | [ ] P [ ] F |
| S-D-01 | Happy path → navigates to /jobs/:id | [ ] P [ ] F |
| S-D-02 | Estimate marked converted after job creation | [ ] P [ ] F |
| S-E-01 | Non-approved row not selectable (UI guard) | [ ] P [ ] F |
| S-E-02 | Deposit unpaid → 400 toast, modal stays open | [ ] P [ ] F |
| S-E-03 | Double-convert is idempotent — no duplicate job | [ ] P [ ] F |
| S-E-04 | Cross-tenant estimate_id → 404 | [ ] P [ ] F [ ] N/A |
| S-E-05 | SALES at API → 403 | [ ] P [ ] F |
| S-F-01 | Approve estimate → Dispatcher gets pinned "Schedule job" | [ ] P [ ] F |
| S-F-02 | Clicking notification deep-links to LEAD with picker pre-selected | [ ] P [ ] F |
| S-F-03 | Notification stays PINNED after clicking (not auto-acted) | [ ] P [ ] F |
| S-F-04 | Notification leaves "Needs action" AFTER job created | [ ] P [ ] F |
| S-F-05 | Admin/Sales informational copies unaffected by resolution | [ ] P [ ] F |
| S-F-06 | Legacy payload (no lead_id) falls back to estimate page, still pinned | [ ] P [ ] F [ ] N/A |
| S-F-07 | Deposit-paid event also deep-links to lead | [ ] P [ ] F |
| S-G-01 | Valid convertible estimate UUID in deep-link → preselected | [ ] P [ ] F |
| S-G-02 | Garbage value in deep-link → modal opens, no crash | [ ] P [ ] F |
| S-G-03 | Foreign-org estimate UUID in deep-link → modal degrades safely | [ ] P [ ] F |
| S-G-04 | Already-converted estimate UUID in deep-link → no preselect | [ ] P [ ] F |
| S-G-05 | Close modal strips param; hard refresh does not reopen | [ ] P [ ] F |
| S-G-06 | Manual button after deep-link opens clean modal | [ ] P [ ] F |
| S-H-01 | Mobile viewport — modal scrolls, conversion works | [ ] P [ ] F |
| S-H-02 | Deep-link while logged out → login redirect then back | [ ] P [ ] F |
| S-H-03 | Technician POST /api/jobs with estimate_id → 403 | [ ] P [ ] F |
| S-H-04 | Estimate-page "Create Job" button still works (regression) | [ ] P [ ] F |
| S-H-05 | SCHEDULE_JOB pin isolated to Dispatcher only | [ ] P [ ] F |

**Total scenarios: 40 (38 executable + 2 that may be N/A depending on test data availability)**
