# Create-Job-from-Lead + Schedule-Job Notification Re-Point
# Playwright Live-Test Execution Plan

**Branch:** `feat/in-app-notifications`  
**Date authored:** 2026-06-18  
**Scope (two halves — both fully covered):**
1. **Create Job from Lead** — sage "Create Job" button on the lead page (Admin/Dispatcher only), `CreateJobFromLeadDialog` modal, `POST /api/jobs { estimate_id }` conversion.
2. **Schedule-job notification re-point** — Dispatcher's pinned "Schedule job" notification deep-links to `/leads/:id?createJob=:estimateId` (picker pre-selected, stays pinned until job created, then clears).

**Explicitly OUT of scope:**
- Core notification routing (approvals, job events, OT, inventory, invoices) — covered in `md_files/plans/notifications/qa-checklist.md`.
- Estimate creation, approval, and public-approve flows — pre-existing coverage.
- Stripe deposit checkout — E2E Stripe flows are separate.
- Technician `/tech/*` mobile views.
- Automated test suites (`npm test`) — already green; this plan covers only browser-driven end-to-end paths.

---

## 1. Prerequisites & Environment Setup

### 1.1 Start the application

Run from the worktree root (`/Users/ranroffe/ALPHA_CRM/alpha_crm-worktrees/notifications`):

```bash
# Terminal 1
npm run dev:backend      # listens on http://localhost:3000

# Terminal 2
npm run dev:frontend     # listens on http://localhost:5173
```

Both `.env` files are present. `DATABASE_URL` in `backend/.env` points at the **staging** Supabase project (`knriiqdqxgfoecsfarlx`).

App base URL for all `browser_navigate` calls: **`http://localhost:5173`**

### 1.2 Notification-migration prereq (REQUIRED for Group F only)

> **Status:** Staging does NOT yet have the `notifications` / `notification_recipients` tables. All Group F (notification lifecycle) test cases depend on these tables being present.

Before executing any Group F test case, the human operator must apply the following via Supabase MCP (`mcp__supabase__apply_migration` or `mcp__supabase__execute_sql` against project `knriiqdqxgfoecsfarlx`):

1. Migration `20260618000000_add_notifications_tables`
2. `backend/scripts/security/2026-06-15-keystone-rls-revoke.sql` — re-run to extend FORCE RLS to the new tables.
3. Migration `20260618000100_backfill_notification_grants`
4. `backend/scripts/security/2026-06-18-notifications-realtime-rls.sql` — then enable **Realtime Authorization (private channels)** on the Supabase project dashboard.

Groups A–E and G–H do NOT require these migrations and can run against staging immediately.

### 1.3 Realtime / refetch note

Supabase Realtime push requires the private-channel authorization to be enabled (prereq step 4). Without it the notification feed still refreshes on:
- Manual bell re-open / panel scroll
- Window-focus refetch (TanStack Query staleTime ≤ 15 s)
- Hard page reload

In test steps that check notification state after a server-side change, **always trigger a refetch** (open/close the bell or reload the page) rather than waiting for instant push. This makes the test deterministic regardless of whether Realtime is fully wired.

### 1.4 Browser viewport

- **Default (desktop):** 1280 × 800. Use `browser_resize` to set this before the first test.
- **Mobile pass (Group H mobile test):** 375 × 812 (iPhone SE). Apply `browser_resize` before TC-H-01.
- Restore to 1280 × 800 after the mobile pass.

### 1.5 Required login accounts (provide credentials before execution)

| Label | Role | Notes |
|---|---|---|
| **ADMIN** | ADMIN | Full access; sees "Create Job" button |
| **DISPATCHER** | DISPATCHER | Full access; sees "Create Job"; receives pinned SCHEDULE_JOB notification |
| **SALES** | SALES | One sales account (the SALES role). Exercised against TWO leads to test the OWN_LEAD boundary: a lead it OWNS (TC-A-03, `LEAD_SALES_OWNED_ID`) and a lead it does NOT own (TC-A-04, e.g. Lead-ONE-APP). NOT two separate accounts. |
| **TECH** | TECHNICIAN | Added as a walkthrough performer on Lead-ONE-APP |

There are **four roles → four accounts** (Admin, Dispatcher, Sales, Technician). "Sales-owner" vs "sales-non-owner" are the SAME sales account viewed against a lead it owns vs one it doesn't — not separate logins. Open **a separate browser profile or incognito window** per account; for Group F keep the Admin + Dispatcher sessions alive together (and the Sales session for TC-H-05). Record each account's email/password securely; do not embed credentials in this plan.

### 1.6 API-level invocation method

Several test cases require issuing a raw `POST /api/jobs` without going through the UI. Use this method instead of DevTools or any `browser_network_request` tool (which does not exist).

**Auth mechanism:** The app uses Supabase Auth. The bearer token lives in `localStorage` under a key matching `sb-<project-ref>-auth-token`. Extract it at runtime.

**Procedure (use `browser_evaluate`):**

```js
// Run this in browser_evaluate while logged in as the target role
const key = Object.keys(localStorage).find(k => k.startsWith('sb-') && k.endsWith('-auth-token'));
const token = JSON.parse(localStorage.getItem(key)).access_token;
const res = await fetch('http://localhost:3000/api/jobs', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
  body: JSON.stringify({ estimate_id: '<ESTIMATE_UUID>' }),
});
return { status: res.status, body: await res.json() };
```

- Substitute `<ESTIMATE_UUID>` with the actual UUID for each test case.
- **Read the status from the `fetch` return value** (primary assertion). `browser_network_requests` may be used as a secondary cross-check (filter: method=POST, url contains `/api/jobs`, take the most recent entry).
- Ensure you are logged in as the correct role BEFORE running the evaluate, so the `localStorage` token belongs to that role's session.

---

## 2. Test Data Requirements

All fixtures must belong to the **same organization** as the test accounts. Use the ADMIN account to create missing fixtures. The staging DB already has 1087 leads, 949 estimates, and 761 jobs — search existing data first.

### Fixture definitions

| Fixture name | Required state | How to locate or create on staging |
|---|---|---|
| **Lead-EMPTY** | A lead with zero estimates | Create via `/leads` → New Lead; do not add estimates. Record its UUID from the URL after creation. |
| **Lead-NONAPP** | A lead with ≥ 1 estimate, none APPROVED (e.g. one SENT, one DRAFT) | Find any lead with estimates in SENT/DRAFT status. Or create a lead and add a SENT estimate without approving. |
| **Lead-ONE-APP** | A lead with exactly 1 APPROVED unconverted estimate; no deposit invoice | Find via `/estimates` filtered to APPROVED; pick one whose `job` is null and whose lead has no other APPROVED estimates. Record: `LEAD_ONE_APP_ID`, `EST_ONE_APP_ID`. |
| **Lead-DEPOSIT-UNPAID** | A lead with 1 APPROVED estimate that has a `kind=DEPOSIT` invoice in SENT status (deposit configured, not paid) | Find or create: approve an estimate, then create a deposit invoice for it (mark as SENT but do not pay). Record: `LEAD_DEPOSIT_ID`, `EST_DEPOSIT_ID`. |
| **Lead-MULTI-APP** | A lead with ≥ 2 APPROVED unconverted estimates | Find or create: a lead with multiple estimates, approve 2+, no jobs. Record: `LEAD_MULTI_ID`, `EST_MULTI_ID_A`, `EST_MULTI_ID_B`. |
| **Lead-CONVERTED** | A lead with ≥ 1 APPROVED estimate that is already converted (has a linked job) | Find via `/jobs` — any job with an `estimate_id`; note the job number (e.g. J00007). Record: `LEAD_CONVERTED_ID`, `EST_CONVERTED_ID`, `JOB_CONVERTED_ID`. |
| **Lead-MIXED** | A lead with: 1 SENT estimate + 1 APPROVED unconverted + 1 APPROVED converted | Create or find. Record: `LEAD_MIXED_ID`, `EST_MIXED_UNCONVERTED_ID`, `EST_MIXED_CONVERTED_ID`. |
| **Lead-DEPOSIT-PAID** | A lead with 1 APPROVED estimate that has a `kind=DEPOSIT` invoice in PAID or VOIDED status | Find or create: approve an estimate, create a deposit invoice, mark as PAID (or record-payment to mark PAID; or void it to waive). Record: `LEAD_DEPOSIT_PAID_ID`, `EST_DEPOSIT_PAID_ID`. |

> **Test isolation note:** Run all read-only/visibility test cases (Groups A, B, C, G, H) before mutation test cases (Groups D, E). After conversion (TC-D-01), Lead-ONE-APP's estimate will be converted — do not reuse it as "unconverted" in later cases unless a fresh fixture is created. Use Lead-MULTI-APP for post-conversion tests that still need an unconverted estimate.

### TECH account walkthrough assignment

TECH must be added as a walkthrough performer on Lead-ONE-APP before TC-A-05. Do this as ADMIN via the lead's "Walkthroughs" tab or via `PATCH /api/leads/:id` to set the performer.

### Cross-tenant estimate UUID (optional, TC-E-04)

If a second organization's test account is available, record a valid estimate UUID from that org as `CROSS_TENANT_ESTIMATE_ID`. If unavailable, mark TC-E-04 as N/A.

---

## 3. Test Cases

Cases are ordered: read-only visibility first, then mutating conversions, then notification lifecycle, then deep-link edge cases, then cross-cutting.

### Assertion methodology — `browser_snapshot` limitations

`browser_snapshot` returns the accessibility tree (roles, names, states). It does **NOT** expose Tailwind class names, colors, `opacity`, or CSS variants. Consequences for this plan:

- **Selection state / "is this estimate selected":** Assert via the **"Create job" button's enabled/disabled state** (`disabled={!selectedId || isConverting}` — the `disabled` attribute IS reflected in the a11y snapshot) plus the estimate's text (number/badge). Where the SPECIFIC selected row identity matters (TC-B-04, TC-G-01), use `browser_evaluate` to read the row element's `className` and check it contains `bg-primary-subtle`. Do NOT assert "filled radio dot" or `border-primary` from the snapshot alone.
- **Greyed/unselectable rows (`opacity-70`):** Assert BEHAVIOR, not styling. Click the row and confirm the "Create job" button state is unchanged (see TC-E-01 pattern). Apply to TC-B-02, TC-B-05, TC-B-06, TC-E-01.
- **`variant="business"` (sage button) (TC-A-01, TC-A-02):** Assert by accessible name "Create Job" + button role. To additionally confirm variant, use `browser_evaluate` to read the button's `className` (optional).
- **Toast color (destructive/red) (TC-A-05, TC-E-02):** Assert the toast TEXT via `browser_wait_for`/snapshot. Confirming "red/destructive" requires `browser_evaluate` on the toast element's class or `browser_take_screenshot` (optional).

---

### GROUP A — Button Visibility Per Role

**Setup for all A cases:** `browser_resize 1280 800`. Navigate to Lead-ONE-APP as the specified role.

---

#### TC-A-01: Admin sees sage "Create Job" button

- **Half:** Create-Job-from-Lead
- **Role:** ADMIN
- **Preconditions:** Logged in as ADMIN. Lead-ONE-APP exists and is not terminal (status ≠ WON/LOST/CANCELLED).
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_ONE_APP_ID`
  2. `browser_snapshot` — inspect the header action area (top-right of the lead card).
  3. Verify the element text "Create Job" is visible. Confirm a button with accessible name "Create Job" exists. To additionally verify the `variant="business"` (sage) styling, use `browser_evaluate` to read the button's `className` (optional — snapshot confirms name+role, not color).
- **Expected observable result:** A button with accessible name "Create Job" (with a briefcase icon) is present in the header actions row alongside "Edit", "+ New Estimate", and "Assign" buttons. No error state, no loading spinner. The sage background color is a `variant="business"` implementation detail not directly assertable from the a11y snapshot.
- **Assertion:** `browser_snapshot` output contains a button element with accessible name "Create Job".
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-A-02: Dispatcher sees sage "Create Job" button

- **Half:** Create-Job-from-Lead
- **Role:** DISPATCHER
- **Preconditions:** Logged in as DISPATCHER. Same Lead-ONE-APP.
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_ONE_APP_ID`
  2. `browser_snapshot` — inspect header action area.
- **Expected observable result:** "Create Job" button is present (name + button role). Identical to TC-A-01.
- **Assertion:** Snapshot contains a button element with accessible name "Create Job".
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-A-03: Sales viewing a lead it OWNS does NOT see "Create Job" button

- **Half:** Create-Job-from-Lead
- **Role:** SALES
- **Preconditions:** Logged in as SALES. Use a lead **owned by this sales account** (`commission_owner` = this user) so it is readable — `LEAD_SALES_OWNED_ID`. Create it during setup: while logged in as SALES, create a simple lead with one estimate (or, as Admin, set an existing lead's owner to this sales account).
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_SALES_OWNED_ID`
  2. `browser_snapshot` — inspect the full header area.
- **Expected observable result:** No "Create Job" button anywhere in the header. The "+ New Estimate" button IS present (SALES can create estimates). The header contains only Edit/New Estimate/Assign-type actions.
- **Assertion:** Snapshot does NOT contain text "Create Job". Snapshot DOES contain text "New Estimate" or similar.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-A-04: Sales viewing a lead it does NOT own → 403 (cannot access)

- **Half:** Create-Job-from-Lead
- **Role:** SALES (the SAME sales account as TC-A-03)
- **Preconditions:** Logged in as SALES. View a lead this account does NOT own (e.g. Lead-ONE-APP, owned by Admin/another user).
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_ONE_APP_ID`
  2. `browser_snapshot` — inspect page content.
- **Expected observable result:** Lead detail page shows "Lead not found." text. No "Create Job" button is present anywhere. The API returns **403** (`lead.controller.ts` `findUnique({where:{id, ...tenantWhere}})` succeeds for a same-org non-owner SALES user, then `canAccessRow` fails → `res.status(403)` "Insufficient permissions"). The FE renders "Lead not found." for any falsy lead response regardless of HTTP status code, so the DOM shows that text even though the actual status is 403.
- **Assertion:** Snapshot contains text "Lead not found." No "Create Job" text. *(API-level note: the network response status is 403, not 404.)*
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-A-05: Technician sees "Create Job" button but action 403s (M1 — expected minor behavior)

- **Half:** Create-Job-from-Lead
- **Role:** TECH
- **Preconditions:** TECH is added as walkthrough performer on Lead-ONE-APP. Lead-ONE-APP has 1 APPROVED unconverted estimate.
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_ONE_APP_ID`
  2. `browser_snapshot` — **Pre-check:** confirm the TECH can actually load the lead (sees lead content — customer name, lead number, status — NOT "Lead not found."). TECH read access depends on the walkthrough-performer grant; if this pre-check fails the test is invalid and the walkthrough assignment must be corrected before proceeding.
  3. `browser_snapshot` — confirm the "Create Job" button IS visible (M1 known behavior: `canConvertToJob` evaluates true because TECHNICIAN has `create Job` grant for the urgent flow).
  4. `browser_click` the "Create Job" button.
  5. `browser_snapshot` — confirm the modal opened with the estimate auto-selected.
  6. `browser_click` the "Create job" button inside the modal (sage, bottom-right).
  7. `browser_wait_for` a toast or error indicator to appear (timeout: 5 s).
  8. `browser_snapshot` — inspect the toast and modal state. Toast text should confirm failure; see Assertion methodology note for color caveat.
  9. `browser_network_requests` — filter to method=POST, url contains `/api/jobs`, take the most recent entry; confirm status 403.
- **Expected observable result:** Button is visible (step 3). Modal opens (step 5). POST fires and returns 403 (step 9). A destructive toast appears with title "Could not convert to job" and description containing "Insufficient permissions" (step 8). The modal remains OPEN — it does not close on error. No job is created.
- **Note:** This is **M1 — expected minor behavior**, not a bug.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

### GROUP B — Modal States

**Setup for all B cases:** Logged in as ADMIN or DISPATCHER (either; specify in each case). Navigate to the named fixture lead.

---

#### TC-B-01: Empty lead shows "No estimates yet" with disabled Create button

- **Half:** Create-Job-from-Lead
- **Role:** ADMIN
- **Preconditions:** Lead-EMPTY (zero estimates).
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_EMPTY_ID`
  2. `browser_snapshot` — confirm "Create Job" button is visible in header.
  3. `browser_click` the "Create Job" button.
  4. `browser_snapshot` — inspect modal content.
- **Expected observable result:** Modal opens with title "Create job from estimate". A FileText icon and the text "No estimates yet." appear in the modal body. The "Create job" button (bottom-right) is disabled (greyed, not clickable). The "New estimate" button (bottom-left, outline) is present (Admin can create estimates). "Cancel" button is present.
- **Assertion:** Snapshot contains "No estimates yet." and a disabled "Create job" button and an enabled "New estimate" button.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-B-02: Lead with only non-APPROVED estimates — all rows greyed, Create disabled

- **Half:** Create-Job-from-Lead
- **Role:** ADMIN
- **Preconditions:** Lead-NONAPP (one SENT estimate, no APPROVED estimates).
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_NONAPP_ID`
  2. `browser_click` the "Create Job" button.
  3. `browser_snapshot` — inspect modal estimate list.
  4. Attempt to `browser_click` the SENT estimate row.
  5. `browser_snapshot` — confirm no selection occurred.
- **Expected observable result:** Modal shows the SENT estimate row with a SENT status badge and its amount. A hint text appears below the list: "No approved estimate to convert yet. Approve an estimate first, or create a new one below." The "Create job" button is disabled. Clicking the estimate row (step 4) changes nothing — "Create job" remains disabled (the row is `opacity-70` / unselectable, but assert behavior not CSS class). Note: `opacity-70` is not assertable from the a11y snapshot; assert by clicking the row and confirming the "Create job" button state is unchanged.
- **Assertion:** Snapshot contains SENT badge text; "Create job" button disabled; hint text present. After step 4 (click attempt): "Create job" still disabled (no change).
- **Note:** This test spot-checks the UI guard for SENT status. The full 6-status matrix (DRAFT/SENT/PENDING/DECLINED/EXPIRED/CANCELLED → 400) is covered by automated `jobs.test.ts`.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-B-03: Single APPROVED estimate — auto-selected on modal open

- **Half:** Create-Job-from-Lead
- **Role:** DISPATCHER
- **Preconditions:** Lead-ONE-APP (exactly 1 APPROVED unconverted estimate). Use a fresh Lead-ONE-APP or one whose estimate has not yet been converted.
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_ONE_APP_ID`
  2. `browser_click` the "Create Job" button.
  3. `browser_snapshot` — inspect modal.
- **Expected observable result:** Modal shows the single APPROVED estimate row with an APPROVED status badge, the estimate number (e.g. "E00034"), and the total amount. The row is auto-selected. The "Create job" button is **enabled**. (`border-primary bg-primary-subtle` highlight and filled radio dot are visible but not directly assertable from the a11y snapshot — assert via button state and, if specific row identity matters, via `browser_evaluate` reading the row's `className`.)
- **Assertion:** "Create job" button is enabled in the snapshot. Snapshot shows the estimate number text.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-B-04: Multiple APPROVED estimates — none auto-selected; selects on click

- **Half:** Create-Job-from-Lead
- **Role:** ADMIN
- **Preconditions:** Lead-MULTI-APP (≥ 2 APPROVED unconverted estimates).
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_MULTI_ID`
  2. `browser_click` the "Create Job" button.
  3. `browser_snapshot` — confirm no row is pre-selected.
  4. `browser_click` the first APPROVED estimate row (identified by its estimate number, e.g. "EST_MULTI_ID_A").
  5. `browser_snapshot` — confirm selection.
- **Expected observable result (step 3):** Both APPROVED rows are visible. "Create job" button is disabled (no selection). (step 5) After clicking one row, "Create job" becomes enabled. The `border-primary bg-primary-subtle` highlight and filled radio dot are applied (not assertable from snapshot). To confirm the SPECIFIC row identity, use `browser_evaluate` to read the clicked row element's `className` and verify it contains `bg-primary-subtle`.
- **Assertion step 3:** "Create job" disabled. **Assertion step 5:** "Create job" enabled. Row className contains `bg-primary-subtle` (via `browser_evaluate`).
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-B-05: Already-converted estimate shows J##### link, row not selectable

- **Half:** Create-Job-from-Lead
- **Role:** ADMIN
- **Preconditions:** Lead-CONVERTED (one APPROVED estimate with a linked job, e.g. J00007). `JOB_CONVERTED_ID` recorded.
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_CONVERTED_ID`
  2. `browser_click` the "Create Job" button.
  3. `browser_snapshot` — inspect estimate row.
  4. Attempt to `browser_click` the converted estimate row (not the J##### link, the row itself).
  5. `browser_snapshot` — confirm no selection.
  6. `browser_click` the "J00007 →" underlined link inside the row.
  7. `browser_wait_for` navigation to complete.
  8. `browser_snapshot` — confirm current URL is the job detail page.
- **Expected observable result (step 3):** The converted estimate row shows: estimate number with APPROVED badge on the left; a small underlined text "J00007 →" on the right (in place of the amount). No radio dot. (`opacity-70` is applied but not directly assertable from the a11y snapshot.) (step 5) Clicking the row does nothing — "Create job" button state is unchanged (still disabled). (step 8) Navigated to `/jobs/JOB_CONVERTED_ID`.
- **Assertion:** Row shows J-number link; row is not selectable; clicking the link navigates to the correct job URL.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-B-06: Mixed lead — correct selectability by estimate status

- **Half:** Create-Job-from-Lead
- **Role:** ADMIN
- **Preconditions:** Lead-MIXED (1 SENT estimate, 1 APPROVED unconverted, 1 APPROVED converted).
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_MIXED_ID`
  2. `browser_click` the "Create Job" button.
  3. `browser_snapshot` — inspect all three rows.
- **Expected observable result:** Three rows visible:
  - **SENT estimate:** SENT badge, no radio dot, shows amount (not a J-link). (`opacity-70` applied but not assertable from snapshot; assert by clicking and confirming "Create job" stays disabled.)
  - **APPROVED unconverted:** APPROVED badge, selectable (radio dot in a11y tree if exposed), shows amount.
  - **APPROVED converted:** APPROVED badge, no radio dot, shows "J##### →" link. (`opacity-70` applied; assert behavior: click row → "Create job" unchanged.)
  - "Create job" is disabled (no selection yet). No "No approved estimate" hint (because one convertible exists).
- **Assertion:** Snapshot shows all three rows with correct badge text and J-link for the converted row. "Create job" disabled. Clicking the SENT or converted row leaves "Create job" unchanged (behavioral check).
- **Note:** This test spot-checks the UI guard. The full 6-status matrix (DRAFT/SENT/PENDING/DECLINED/EXPIRED/CANCELLED → 400) is covered by automated `jobs.test.ts`.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

### GROUP C — "New Estimate" Navigation

---

#### TC-C-01: "New estimate" button navigates to /estimates/new?lead_id=… without converting (Admin)

- **Half:** Create-Job-from-Lead
- **Role:** ADMIN
- **Preconditions:** Lead-EMPTY or Lead-NONAPP. Modal open.
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_EMPTY_ID`
  2. `browser_click` the "Create Job" button.
  3. `browser_snapshot` — confirm modal is open with "New estimate" button in the footer (bottom-left).
  4. `browser_network_requests` — note current network state (baseline; no POST to `/api/jobs` yet).
  5. `browser_click` the "New estimate" button.
  6. `browser_wait_for` navigation.
  7. `browser_snapshot` — confirm new URL.
  8. `browser_network_requests` — confirm no POST to `/api/jobs` was made.
- **Expected observable result:** Modal closes (step 5). Browser navigates to `/estimates/new?lead_id=LEAD_EMPTY_ID` (step 7). No `POST /api/jobs` request appears in the network log (step 8).
- **Assertion:** Current URL contains `/estimates/new?lead_id=`. No POST to `/api/jobs` in network requests.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-C-02: "New estimate" button hidden for Dispatcher

- **Half:** Create-Job-from-Lead
- **Role:** DISPATCHER
- **Preconditions:** Lead-ONE-APP. Modal open.
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_ONE_APP_ID`
  2. `browser_click` the "Create Job" button.
  3. `browser_snapshot` — inspect the modal footer (bottom row).
- **Expected observable result:** The modal footer shows only "Cancel" (outline) and "Create job" (sage) on the right. The left side of the footer is empty (`<span />`). No "New estimate" button is visible. (`canCreateEstimate = (role===ADMIN || role===SALES) && !isTerminal` — Dispatcher is neither.)
- **Assertion:** Snapshot does NOT contain "New estimate" text. Only "Cancel" and "Create job" are in the footer.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-C-03: "New estimate" → create → approve → convert (end-to-end affordance)

- **Half:** Create-Job-from-Lead
- **Role:** ADMIN
- **Preconditions:** Lead-EMPTY (no estimates). This test covers the full hand-off: create via modal → estimate appears as convertible option. **This is a mutating case** — a new estimate will be created and then converted.
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_EMPTY_ID`
  2. `browser_click` "Create Job" → modal opens with "No estimates yet." and "New estimate" button.
  3. `browser_click` "New estimate" → navigation to `/estimates/new?lead_id=LEAD_EMPTY_ID`.
  4. Fill in the minimum required fields and save the estimate (submit the form). Record the new estimate number (e.g. "E00999") and UUID as `EST_NEW_ID`.
  5. Approve the estimate: on the estimate detail page, use the "Approve" action. Record that it is now APPROVED.
  6. `browser_navigate http://localhost:5173/leads/LEAD_EMPTY_ID` — return to the lead.
  7. `browser_click` "Create Job" → modal opens.
  8. `browser_snapshot` — confirm the new APPROVED estimate (`EST_NEW_ID`) is now listed and auto-selected (single convertible option).
  9. `browser_click` "Create job".
  10. `browser_wait_for` navigation to `/jobs/<id>` (timeout: 10 s).
  11. `browser_network_requests` — filter to method=POST, url contains `/api/jobs`, take the most recent entry; confirm 201.
- **Expected observable result:** After returning to the lead (step 6), the newly created and approved estimate is visible in the modal as a convertible option (step 8). Auto-selected because it is the only convertible estimate. Conversion succeeds → 201 → `/jobs/<id>`. This validates the full "New estimate" affordance hand-off — the estimate surfaces back in the modal after approval.
- **Note:** The convert leg (steps 9–11) overlaps TC-D-01; this case is focused on the create→return→appears-as-convertible hand-off rather than the conversion itself.
- **Assertion:** Step 8: estimate is listed and "Create job" is enabled. Step 11: network 201. Navigation to `/jobs/<id>`.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

### GROUP D — Convert Happy Path

---

#### TC-D-01: Successful conversion → navigates to /jobs/:id

- **Half:** Create-Job-from-Lead
- **Role:** DISPATCHER
- **Preconditions:** Lead-ONE-APP with 1 APPROVED unconverted estimate. **This is a mutating case — use a fresh or dedicated fixture to avoid affecting other tests.**
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_ONE_APP_ID`
  2. `browser_click` the "Create Job" button.
  3. `browser_snapshot` — confirm estimate is auto-selected and "Create job" is enabled.
  4. `browser_click` the "Create job" sage button.
  5. `browser_snapshot` immediately after click — confirm button shows "Creating…" spinner (pending state).
  6. `browser_wait_for` navigation to a `/jobs/` URL (timeout: 10 s).
  7. `browser_snapshot` — inspect the job detail page.
  8. `browser_network_requests` — confirm `POST /api/jobs` returned 201; record the job ID from the response body.
- **Expected observable result:** "Creating…" spinner shown (step 5). Navigation to `/jobs/<new-uuid>` (step 6). Job detail page loads with a job number (e.g. "J00762"), status UNASSIGNED, and a reference to the estimate number from which it was created (step 7). Network log shows 201 (step 8).
- **Assertion:** Current URL matches `/jobs/<uuid>`. Network 201. Job number and status visible in snapshot.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-D-02: Estimate shows as converted on return visit to lead

- **Half:** Create-Job-from-Lead
- **Role:** DISPATCHER
- **Preconditions:** Immediately after TC-D-01. The estimate is now converted (a job exists).
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_ONE_APP_ID`
  2. `browser_click` the "Create Job" button.
  3. `browser_snapshot` — inspect the modal.
- **Expected observable result:** The previously-approved estimate now shows as converted: the J##### link is in the right column, the row is `opacity-70`, no radio dot. "Create job" button is disabled (no convertible estimates remain). No "New estimate" hint for Dispatcher.
- **Assertion:** Snapshot shows J-number link on the row; "Create job" disabled.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

### GROUP E — Convert Guards

---

#### TC-E-01: Non-approved estimate row has no click handler (UI guard)

- **Half:** Create-Job-from-Lead
- **Role:** ADMIN
- **Preconditions:** Lead-NONAPP (SENT estimate only). Modal open.
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_NONAPP_ID`
  2. `browser_click` the "Create Job" button.
  3. `browser_snapshot` — baseline (no selection).
  4. `browser_click` the SENT estimate row (by its estimate number text).
  5. `browser_snapshot` — inspect selection state.
- **Expected observable result:** After step 4, nothing changes. The SENT row has no radio dot. "Create job" button stays disabled. No error or toast. (`opacity-70` is applied to non-APPROVED rows but is not directly assertable from the a11y snapshot; assert behavior — "Create job" still disabled — not CSS class.)
- **Assertion:** Step 3 and step 5 snapshots show identical state for the estimate row; "Create job" still disabled.
- **Note:** This test spot-checks the browser-layer UI guard for SENT status. The full 6-status matrix (DRAFT/SENT/PENDING/DECLINED/EXPIRED/CANCELLED → 400 at the API) is covered by automated `jobs.test.ts`.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-E-02: Deposit required but unpaid → 400 toast, modal stays open

- **Half:** Create-Job-from-Lead
- **Role:** DISPATCHER
- **Preconditions:** Lead-DEPOSIT-UNPAID (APPROVED estimate with a `kind=DEPOSIT` invoice in SENT status — unpaid).
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_DEPOSIT_ID`
  2. `browser_click` the "Create Job" button.
  3. `browser_snapshot` — confirm the APPROVED estimate is auto-selected and "Create job" is enabled.
  4. `browser_click` the "Create job" button.
  5. `browser_wait_for` a toast to appear (timeout: 5 s).
  6. `browser_snapshot` — inspect toast and modal state.
  7. `browser_network_requests` — filter to method=POST, url contains `/api/jobs`, take the most recent entry; confirm status 400.
- **Expected observable result:** A toast appears with title "Could not convert to job" and description containing "Deposit must be paid or waived before creating a job. Mark the deposit as received or waive it first." (or a truncated version). The modal remains OPEN — it does not close on error. The "Create job" button returns from "Creating…" to its normal enabled state. No job is created. (Toast "destructive/red" styling is not assertable from the a11y snapshot; confirm via toast TEXT. Optional: use `browser_evaluate` on the toast element's className or `browser_take_screenshot` to verify the red color.)
- **Assertion:** Toast text with deposit error message visible in snapshot. Modal still open. Network (filtered POST `/api/jobs`) shows 400.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-E-03: Double-submit is idempotent — no duplicate job created

- **Half:** Create-Job-from-Lead
- **Role:** DISPATCHER
- **Preconditions:** A separate, fresh APPROVED unconverted estimate (different from TC-D-01's fixture). Record: `EST_IDEMPOTENT_ID`. Use the ADMIN account to find one on staging from a different lead.
- **Playwright steps:**
  1. Navigate to the lead owning `EST_IDEMPOTENT_ID` as DISPATCHER.
  2. `browser_click` "Create Job" → modal auto-selects the estimate → `browser_click` "Create job".
  3. `browser_wait_for` navigation to `/jobs/<id>`. Record job ID as `JOB_IDEM_ID` and `job_number` from the page.
  4. `browser_navigate http://localhost:5173/leads/<same-lead-id>`
  5. `browser_snapshot` — the estimate should now show as converted (J##### link). The "Create job" button is disabled.
  6. Run the §1.6 API-level invocation method as DISPATCHER (ensure logged in as DISPATCHER so the `localStorage` token is theirs), with `estimate_id=EST_IDEMPOTENT_ID`. This simulates a retry after the first conversion.
  7. Assert the returned status from the `fetch` response (primary). `browser_network_requests` — filter to method=POST, url contains `/api/jobs`, take the most recent entry (secondary cross-check).
- **Expected observable result (step 7):** The re-POST returns HTTP **200** (not 201, not 409). The response body contains the same job object with `JOB_IDEM_ID` and the same `job_number`. No second job is created.
- **Assertion:** Re-POST status = 200; response `job.id` matches `JOB_IDEM_ID`; single job exists for this estimate.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-E-04: Cross-tenant estimate_id → 404 at API (API-level verification)

- **Half:** Create-Job-from-Lead
- **Role:** DISPATCHER (org A)
- **Preconditions:** `CROSS_TENANT_ESTIMATE_ID` from org B is known. If unavailable, mark N/A.
- **Playwright steps:**
  1. Ensure logged in as DISPATCHER (org A). Run the §1.6 API-level invocation method with `estimate_id=CROSS_TENANT_ESTIMATE_ID`.
  2. Assert the returned status from the `fetch` response (primary). `browser_network_requests` — filter to method=POST, url contains `/api/jobs`, take the most recent entry (secondary cross-check).
- **Expected observable result:** HTTP 404 with error "Estimate not found". No job is created. No data from org B is returned.
- **Note:** This is primarily an API-layer verification; the UI path cannot drive this scenario because the FE only submits IDs drawn from the tenant-scoped lead response.
- **Assertion:** Network response status = 404.
- **Pass/Fail:** [ ] Pass [ ] Fail [ ] N/A (no second org available)

---

#### TC-E-05: SALES role denied at API (403)

- **Half:** Create-Job-from-Lead
- **Role:** SALES (at the API layer)
- **Preconditions:** A valid APPROVED estimate UUID in the SALES user's org (`EST_ONE_APP_ID`).
- **Playwright steps:**
  1. Ensure logged in as SALES. Run the §1.6 API-level invocation method with `estimate_id=EST_ONE_APP_ID`.
  2. Assert the returned status from the `fetch` response (primary). `browser_network_requests` — filter to method=POST, url contains `/api/jobs`, take the most recent entry (secondary cross-check).
- **Expected observable result:** HTTP 403 — "Insufficient permissions" (or "Forbidden"). No job is created. (SALES has no `create Job` grant on the estimate-conversion path per `defaultGrants.ts`.)
- **Note:** SALES cannot reach the modal via the UI button (TC-A-03), so this is API-layer only.
- **Assertion:** Network response status = 403.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-E-06: Deposit waived (VOIDED) or PAID → conversion ALLOWED (happy path)

- **Half:** Create-Job-from-Lead
- **Role:** DISPATCHER
- **Preconditions:** A lead with 1 APPROVED estimate that has a `kind=DEPOSIT` invoice in VOIDED status (deposit waived) OR PAID status. Record: `LEAD_DEPOSIT_PAID_ID`, `EST_DEPOSIT_PAID_ID`. This is the counterpart to TC-E-02 (unpaid → blocked). **This is a mutating case** — the estimate will be converted.
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_DEPOSIT_PAID_ID`
  2. `browser_click` the "Create Job" button.
  3. `browser_snapshot` — confirm the APPROVED estimate is auto-selected and "Create job" is enabled.
  4. `browser_click` the "Create job" button.
  5. `browser_wait_for` navigation to `/jobs/<id>` (timeout: 10 s).
  6. `browser_network_requests` — filter to method=POST, url contains `/api/jobs`, take the most recent entry; confirm status **201**.
  7. `browser_snapshot` — job detail page renders.
- **Expected observable result:** "Create job" proceeds without a deposit error toast. Backend deposit gate (`job.controller.ts`) allows PAID/VOIDED/REFUNDED/PARTIALLY_REFUNDED. Job is created (201). Browser navigates to the new job's detail page.
- **Assertion:** Network POST 201. Navigation to `/jobs/<uuid>`. No error toast. Job page renders.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

### GROUP F — Notification Lifecycle
> **REQUIRES notification migration prereq (Section 1.2). Apply all 4 migration steps before running this group.**
> After each notification check, trigger a refetch by re-opening the bell panel or reloading the page.

**Setup:** Two browser windows open simultaneously — one as DISPATCHER, one as ADMIN (or SALES who owns the estimate's lead). Both pointing at the same local app.

---

#### TC-F-01: Approve estimate → Dispatcher receives pinned "Schedule job" notification

- **Half:** Notification re-point
- **Role:** ADMIN (triggers approval); DISPATCHER (receives notification)
- **Preconditions:** A lead with 1 APPROVED unconverted estimate in DISPATCHER's org. Use a fresh estimate that has no prior SCHEDULE_JOB notification. Record: `LEAD_F_ID`, `EST_F_ID`.
  - If the estimate is not yet approved, approve it now: navigate to the estimate detail page as ADMIN and use the "Approve" action. Alternatively use the public-approve link.
  - Once approved, a `estimate.approved` event is emitted by the backend.
- **Playwright steps (DISPATCHER window):**
  1. `browser_navigate http://localhost:5173/notifications` (or any page with the notification bell visible in the header).
  2. `browser_snapshot` — note the current bell badge count (baseline).
  3. (AS ADMIN, in the other window) Approve the estimate if not already approved; or record the timestamp of approval.
  4. Wait 2–3 seconds. `browser_click` the notification bell icon in the DISPATCHER window.
  5. `browser_wait_for` the notification panel to open (timeout: 3 s).
  6. `browser_snapshot` — inspect the "Needs action" section of the notification panel.
- **Expected observable result:** The bell badge increments (red `bg-notify` badge with count). In the "Needs action" / pinned section, a new notification item appears for "Schedule job" related to the estimate (shows estimate number or lead name). The item has a "Schedule job" action button. It is in the pinned/needs-action section, NOT in the general "Earlier" feed.
- **Assertion:** Snapshot shows a pinned "Schedule job" notification item in the needs-action section with a "Schedule job" action button.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-F-02: Clicking "Schedule job" action → navigates to LEAD with picker pre-selected

- **Half:** Notification re-point
- **Role:** DISPATCHER
- **Preconditions:** TC-F-01 completed; the "Schedule job" notification is visible in the DISPATCHER's bell panel.
- **Playwright steps:**
  1. Notification panel is open (from TC-F-01 step 6), or re-open it.
  2. `browser_snapshot` — confirm the notification item with a "Schedule job" action button is visible.
  3. `browser_click` the "Schedule job" action button on the notification item.
  4. `browser_wait_for` navigation to complete (timeout: 5 s).
  5. `browser_snapshot` — inspect current URL and modal state.
  6. `browser_wait_for` the URL to no longer contain `?createJob=` (param stripped via `setSearchParams({ replace: true })`).
  7. `browser_snapshot` — inspect final URL and modal.
- **Expected observable result:** Browser navigates to `/leads/LEAD_F_ID?createJob=EST_F_ID` (the lead page with the deep-link param). The `CreateJobFromLeadDialog` modal opens automatically. The estimate `EST_F_ID` is pre-selected in the modal (highlighted row with radio dot). The address bar transitions from `/leads/LEAD_F_ID?createJob=EST_F_ID` to `/leads/LEAD_F_ID` (param stripped). The modal remains open after param removal.
- **Note:** M2 (brief empty-flash before estimates load) is expected on cold load — not a failure.
- **Assertion:** Final URL = `/leads/LEAD_F_ID` (no query param). Modal open. Estimate row highlighted/selected.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-F-03: Notification STAYS PINNED after clicking "Schedule job" (not auto-acted)

- **Half:** Notification re-point
- **Role:** DISPATCHER
- **Preconditions:** TC-F-02 completed; the modal opened. Close the modal WITHOUT converting (click Cancel or press Escape).
- **Playwright steps:**
  1. In the open modal (from TC-F-02), `browser_click` the "Cancel" button (or `browser_press_key Escape`).
  2. `browser_snapshot` — confirm modal is closed.
  3. `browser_click` the notification bell icon.
  4. `browser_wait_for` notification panel to open.
  5. `browser_snapshot` — inspect "Needs action" section.
- **Expected observable result:** The "Schedule job" notification is STILL present in the "Needs action" section. It has NOT moved to the "Earlier" feed section. It has NOT flipped to a "✓ done" / acted state. (`handleScheduleJob` returns `{ skipActed: true }`, so `markActed` is never called on click.)
- **Assertion:** Snapshot shows the "Schedule job" notification still in the pinned/needs-action section, not in a done state.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-F-04: Notification LEAVES "Needs action" AFTER job is actually created

- **Half:** Notification re-point
- **Role:** DISPATCHER
- **Preconditions:** TC-F-03 completed; the notification is still pinned. The estimate `EST_F_ID` is still unconverted.
- **Playwright steps:**
  1. `browser_click` the "Create Job" button on the current lead page (modal is closed, page is `/leads/LEAD_F_ID`).
  2. `browser_snapshot` — confirm estimate is auto-selected (single convertible), "Create job" enabled.
  3. `browser_click` "Create job".
  4. `browser_wait_for` navigation to `/jobs/<id>` (timeout: 10 s).
  5. `browser_network_requests` — filter to method=POST, url contains `/api/jobs`, take the most recent entry; confirm 201. Record the new job ID.
  6. `browser_click` the notification bell.
  7. `browser_wait_for` the notification panel to open (timeout: 3 s). If realtime doesn't push the update instantly, `browser_navigate` to any other page and back, then re-open the bell to trigger a refetch.
  8. `browser_snapshot` — inspect "Needs action" section.
- **Expected observable result:** The job is created (step 4 navigation, step 5 = 201). In the notification panel (step 8), the "Schedule job" notification for `EST_F_ID` is NO LONGER in the "Needs action" section. It either moves to the "Earlier" general feed as an acted item, or it is no longer visible in the feed. (`resolveScheduleJobNotifications` was called post-commit in `job.controller.ts:761-763`.)
- **Note:** M3 applies here: if `resolveScheduleJobNotifications` threw internally (rare DB error), the pin may persist — that would be a known minor behavior, not a test failure.
- **Assertion:** Snapshot's "Needs action" section does NOT contain the "Schedule job" notification for this estimate.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-F-05: Admin/Sales informational copies unaffected by resolution

- **Half:** Notification re-point
- **Role:** ADMIN (separate browser window)
- **Preconditions:** TC-F-04 completed (job created). The ADMIN account may have received an informational (non-pinned) estimate-approved notification.
- **Playwright steps (ADMIN window):**
  1. `browser_click` the notification bell.
  2. `browser_wait_for` notification panel open.
  3. `browser_snapshot` — inspect ALL sections (Needs action + Earlier feed) in the ADMIN bell.
- **Expected observable result:** If an informational notification for the same estimate-approval event was delivered to Admin, it is still present in its original state (not acted, not removed, not flipped to done). Admin does NOT have a "Schedule job" actionable pin (that was Dispatcher-only). The `resolveScheduleJobNotifications` `updateMany` filter targets only rows where `needs_action: true` and `acted_at: null` — Admin's informational copy has `needs_action: false` and is therefore untouched.
- **Assertion:** Admin's bell shows no "Schedule job" pinned item; any informational copy of the estimate-approval notification is in the "Earlier" feed unchanged.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-F-06: Legacy notification (no lead_id) falls back to estimate page, stays pinned

- **Half:** Notification re-point
- **Role:** DISPATCHER
- **Preconditions:** A `notification_recipients` row for action_type `SCHEDULE_JOB` exists in the DB whose parent notification has `data` WITHOUT a `lead_id` field (legacy payload). Create by inserting directly into Supabase Studio, or by temporarily modifying a notification row: set `data = { "object_label": "E00001" }` (no `lead_id`). **Important seeding note:** keep `object_type='ESTIMATE'` and `object_id=<estimate UUID>` set on the parent notification — only `lead_id` is removed from `data`. The fallback navigates to `/estimates/<object_id>`; if `object_id` is also cleared, the handler falls through to `/jobs?action=new-job` instead, which would not test the intended fallback. Record: `LEGACY_NOTIF_RECIPIENT_ID`.
- **Playwright steps:**
  1. Open the DISPATCHER bell.
  2. Locate the legacy "Schedule job" notification (no lead_id in payload).
  3. `browser_click` the "Schedule job" action button on that notification.
  4. `browser_wait_for` navigation.
  5. `browser_snapshot` — inspect current URL.
  6. Re-open bell; `browser_snapshot` — inspect "Needs action".
- **Expected observable result (step 5):** Browser navigates to `/estimates/<estimate-id>` (the estimate detail page, NOT a lead page). No crash. (step 6) The notification is still in "Needs action" — not acted. (`handleScheduleJob` returns `{ skipActed: true }` in the fallback branch too.)
- **Note:** Covered by `inlineActions.test.ts` automated test; manual verification is optional. Mark N/A if a legacy row cannot be easily seeded.
- **Pass/Fail:** [ ] Pass [ ] Fail [ ] N/A

---

#### TC-F-07: Deposit-paid event also deep-links to lead (same re-point logic)

- **Half:** Notification re-point
- **Role:** DISPATCHER
- **Preconditions:** A lead with an APPROVED estimate that has a `kind=DEPOSIT` invoice. Pay the deposit (use "Record payment" as ADMIN to mark it PAID, or use Stripe test checkout). Record: `LEAD_DEP_F_ID`, `EST_DEP_F_ID`. The payment triggers `estimate.deposit_paid` event which also emits a SCHEDULE_JOB notification (the B1 change added `lead_id` to this payload).
- **Playwright steps:**
  1. (AS ADMIN) Record or complete payment on the deposit invoice.
  2. (AS DISPATCHER) Open the bell; trigger a refetch.
  3. `browser_snapshot` — inspect "Needs action" for a new "Schedule job" pin.
  4. `browser_click` the "Schedule job" action button.
  5. `browser_wait_for` navigation.
  6. `browser_snapshot` — inspect URL and modal state.
- **Expected observable result:** A new pinned "Schedule job" notification appears for `EST_DEP_F_ID`. Clicking it navigates to `/leads/LEAD_DEP_F_ID?createJob=EST_DEP_F_ID` → modal opens pre-selected → param stripped to `/leads/LEAD_DEP_F_ID`. Identical behavior to TC-F-02 but triggered by the deposit-paid event.
- **Assertion:** URL is `/leads/LEAD_DEP_F_ID`. Modal open with estimate pre-selected.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-F-08: Notification badge: unseen-count clears on panel open (seen ≠ acted)

- **Half:** Notification re-point
- **Role:** DISPATCHER
- **Preconditions:** TC-F-01 completed; Dispatcher has at least one unread notification (the pinned "Schedule job"). The bell badge (`bg-notify`, unseen-count) is visible.
- **Notification prereq:** Yes
- **Playwright steps:**
  1. `browser_snapshot` — confirm the bell badge shows an unseen count (> 0).
  2. `browser_click` the bell icon to open the notification panel.
  3. `browser_wait_for` the panel to open (timeout: 3 s).
  4. `browser_snapshot` — confirm the pinned "Schedule job" item is STILL in "Needs action" (it is only acted/resolved when a job is created, not on read).
  5. Close the notification panel (`browser_click` elsewhere or press Escape) and/or `browser_navigate` to another page and back to trigger a refetch.
  6. `browser_snapshot` — confirm the bell badge has cleared to 0 (no unseen-count badge).
  7. Re-open the bell; `browser_snapshot` — confirm the "Schedule job" item REMAINS in "Needs action" (seen ≠ acted).
- **Expected observable result:** Opening the panel marks notifications as seen (`NotificationBell` marks unseen → seen on open). The bell badge clears. However, the pinned "Schedule job" item is NOT removed from "Needs action" — seeing a notification is not the same as acting on it (only creating the job removes it from "Needs action"). This guards against conflating the two states.
- **Assertion:** Step 6: bell badge = 0 (no unseen badge). Step 7: "Schedule job" item still in "Needs action" section.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-F-09: Multi-pin isolation — converting estimate A clears only A's pin

- **Half:** Notification re-point
- **Role:** DISPATCHER
- **Preconditions:** Lead-MULTI-APP with 2 APPROVED unconverted estimates (`EST_MULTI_ID_A`, `EST_MULTI_ID_B`), both approved in a way that each emitted a SCHEDULE_JOB pin to the Dispatcher. Both "Schedule job" pins are visible in DISPATCHER's "Needs action" section. Record both `notification_recipients` IDs as `PIN_A_ID`, `PIN_B_ID`.
- **Notification prereq:** Yes
- **Playwright steps:**
  1. Open the DISPATCHER bell; `browser_snapshot` — confirm both "Schedule job" pins are in "Needs action" (one for EST_MULTI_ID_A, one for EST_MULTI_ID_B, identified by estimate label or notification data).
  2. Close the bell. Navigate to Lead-MULTI-APP: `browser_navigate http://localhost:5173/leads/LEAD_MULTI_ID`
  3. `browser_click` "Create Job" → modal opens. Click the row for `EST_MULTI_ID_A` → select it → `browser_click` "Create job".
  4. `browser_wait_for` navigation to `/jobs/<id>` (timeout: 10 s).
  5. `browser_network_requests` — filter POST `/api/jobs`, confirm 201.
  6. `browser_click` the bell; trigger refetch (re-open or page reload if realtime not active).
  7. `browser_snapshot` — inspect "Needs action" section.
- **Expected observable result:** After converting `EST_MULTI_ID_A`: the "Schedule job" pin for `EST_MULTI_ID_A` is **gone** from "Needs action" (resolved by `resolveScheduleJobNotifications` which filters by `object_id=EST_MULTI_ID_A`). The "Schedule job" pin for `EST_MULTI_ID_B` **remains** in "Needs action" (its `object_id=EST_MULTI_ID_B` did not match the resolve filter). This tests that `resolveNotifications.ts` resolves by specific `object_id` and does not mass-clear all SCHEDULE_JOB pins.
- **Assertion:** Step 7 "Needs action" section: no pin for EST_MULTI_ID_A; pin for EST_MULTI_ID_B still present.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

### GROUP G — Deep-Link Parameter Edge Cases

---

#### TC-G-01: Valid convertible estimate UUID in deep-link → preselects correctly

- **Half:** Create-Job-from-Lead
- **Role:** DISPATCHER
- **Preconditions:** Lead-MULTI-APP (≥ 2 APPROVED unconverted estimates). Know `EST_MULTI_ID_A` (UUID of one convertible estimate).
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_MULTI_ID?createJob=EST_MULTI_ID_A`
  2. `browser_wait_for` modal to open (timeout: 5 s).
  3. `browser_snapshot` — inspect URL and modal state.
  4. `browser_wait_for` URL to no longer contain `?createJob=` (param stripped).
  5. `browser_snapshot` — confirm URL and selected estimate.
- **Expected observable result:** Modal opens automatically. `EST_MULTI_ID_A`'s row is pre-selected. "Create job" is enabled. URL transitions from `?createJob=EST_MULTI_ID_A` to clean `/leads/LEAD_MULTI_ID`. M2 brief empty-flash is expected on cold load — not a failure. (`border-primary bg-primary-subtle` highlight and filled radio dot are applied but not directly assertable from snapshot; to confirm the specific row identity, use `browser_evaluate` to read the row element's `className` and verify it contains `bg-primary-subtle`.)
- **Assertion:** Final URL = `/leads/LEAD_MULTI_ID`. "Create job" enabled. Row className contains `bg-primary-subtle` for the `EST_MULTI_ID_A` row (via `browser_evaluate`).
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-G-02: Garbage value in deep-link → modal opens, no crash, no wrong selection

- **Half:** Create-Job-from-Lead
- **Role:** DISPATCHER
- **Preconditions:** Lead-MULTI-APP (≥ 2 APPROVED unconverted estimates). Run on this lead specifically so that a broken or absent preselect is observable: with multiple convertible estimates, the `convertible.length===1` fallback does NOT fire, so "Create job" remains disabled if preselect fails. (Single-convertible auto-select is covered by TC-B-03.)
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_MULTI_ID?createJob=not-a-uuid`
  2. `browser_wait_for` modal to open (timeout: 5 s).
  3. `browser_snapshot` — inspect modal state.
- **Expected observable result:** Modal opens (garbage id triggers `setCreateJobOpen(true)`). The garbage id does not match any `convertible` estimate → preselect gate is false. Because Lead-MULTI-APP has multiple convertible estimates, the `convertible.length===1` fallback does NOT fire → no row is auto-selected → "Create job" is **disabled**. No crash, no error toast. URL stripped to `/leads/LEAD_MULTI_ID`.
- **Assertion:** No error. Modal open. URL clean. "Create job" button is **disabled** (no selection). This confirms a garbage preselect ID does not cause a wrong conversion.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-G-03: Foreign-org estimate UUID in deep-link → modal degrades safely

- **Half:** Create-Job-from-Lead
- **Role:** DISPATCHER (org A)
- **Preconditions:** `CROSS_TENANT_ESTIMATE_ID` (org B UUID) is known. Use Lead-MULTI-APP (which has its own convertible estimates).
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_MULTI_ID?createJob=CROSS_TENANT_ESTIMATE_ID`
  2. `browser_wait_for` modal to open (timeout: 5 s).
  3. `browser_snapshot` — inspect modal and selection state.
- **Expected observable result:** Modal opens. The foreign UUID is not in the lead's `convertible` list (estimates come from the tenant-scoped lead API response — org B's estimate is never returned). No preselect. Since Lead-MULTI-APP has multiple convertible estimates, the single-option fallback does NOT fire — "Create job" remains disabled. No crash, no error toast. The modal only submits `selectedId` drawn from the lead's own rendered list — it cannot submit the foreign UUID.
- **Assertion:** No preselect. "Create job" disabled. No error. URL stripped to clean lead URL.
- **Pass/Fail:** [ ] Pass [ ] Fail [ ] N/A (if no cross-org UUID available)

---

#### TC-G-04: Already-converted estimate UUID in deep-link → modal opens without preselect

- **Half:** Create-Job-from-Lead
- **Role:** DISPATCHER
- **Preconditions:** Lead-MULTI-APP with `EST_MULTI_ID_A` already converted (from TC-D-01) and `EST_MULTI_ID_B` still unconverted. Run on this multi-convertible lead so that a wrong/absent preselect is observable. (If TC-D-01 has not yet run, ensure Lead-MULTI-APP has at least one converted + one still-convertible estimate.)
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_MULTI_ID?createJob=EST_MULTI_ID_A` (the converted estimate's UUID)
  2. `browser_wait_for` modal to open.
  3. `browser_snapshot` — inspect modal.
- **Expected observable result:** Modal opens. `EST_MULTI_ID_A` is NOT in the `convertible` list (it has a job). Preselect gate false → no auto-selection of that row. Because Lead-MULTI-APP now has exactly one remaining convertible estimate (`EST_MULTI_ID_B`), the `convertible.length===1` fallback fires and selects it. "Create job" is enabled (for `EST_MULTI_ID_B`, not for the converted one). The converted estimate row shows its J##### link, no radio dot. No crash. (`opacity-70` applied but not snapshot-assertable; assert behavior.) **Key assertion:** the converted estimate is NOT the selected one.
- **Assertion:** Converted estimate row (`EST_MULTI_ID_A`) shows J-link; "Create job" enabled for remaining convertible (`EST_MULTI_ID_B`). No crash. To confirm the CORRECT row is selected (not the converted one), use `browser_evaluate` to read the selected row's `className` and verify it is NOT the converted row.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-G-05: Closing modal strips param; hard refresh does NOT reopen modal

- **Half:** Create-Job-from-Lead
- **Role:** DISPATCHER
- **Preconditions:** Lead-ONE-APP. Use the deep-link from TC-G-01 or any fresh `?createJob=<uuid>` URL.
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_ONE_APP_ID?createJob=EST_ONE_APP_ID`
  2. `browser_wait_for` modal to open.
  3. `browser_snapshot` — confirm URL is already clean (`/leads/LEAD_ONE_APP_ID`, no `?createJob=`) after the param-strip effect runs.
  4. `browser_click` the "Cancel" button in the modal.
  5. `browser_snapshot` — confirm modal is closed. `preselectEstimateId` is cleared (the `onOpenChange` close handler calls `setPreselectEstimateId(null)`).
  6. `browser_navigate http://localhost:5173/leads/LEAD_ONE_APP_ID` (hard navigation, simulating a refresh).
  7. `browser_snapshot` — confirm modal is NOT open.
- **Expected observable result (step 3):** Address bar shows `/leads/LEAD_ONE_APP_ID` (param was stripped via `setSearchParams({ replace: true })`). (step 5) Modal closed. (step 7) After hard navigation to the same URL without any `?createJob=`, the page loads normally and the modal does NOT auto-open.
- **Assertion:** Step 3 URL has no `?createJob=`. Step 7 modal not open.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-G-06: Manual "Create Job" button after deep-link opens clean/correct modal

- **Half:** Create-Job-from-Lead
- **Role:** DISPATCHER
- **Preconditions:** Continue after TC-G-05 (page on `/leads/LEAD_ONE_APP_ID`, modal closed, preselectEstimateId cleared). If Lead-ONE-APP's estimate was converted in TC-D-01, use Lead-MULTI-APP for this case.
- **Playwright steps:**
  1. `browser_click` the "Create Job" button in the lead header.
  2. `browser_snapshot` — inspect modal.
- **Expected observable result:** Modal opens. Because `preselectEstimateId` is null and Lead-ONE-APP has exactly 1 convertible estimate, the single-option auto-select fires and selects it. This is the legitimate default — not a stale deep-link preselect. "Create job" is enabled. (If Lead-MULTI-APP is used: no preselect, "Create job" disabled until user clicks a row.)
- **Assertion:** Modal opens cleanly. No stale preselect from the prior deep-link session.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

### GROUP H — Cross-Cutting Concerns

---

#### TC-H-01: Mobile viewport — button visible, modal scrollable, conversion succeeds

- **Half:** Both (Create-Job-from-Lead; modal is the surface under test)
- **Role:** DISPATCHER
- **Preconditions:** A fresh APPROVED unconverted estimate (use Lead-MULTI-APP's second estimate `EST_MULTI_ID_B` if TC-D-01 consumed the first). Set mobile viewport.
- **Playwright steps:**
  1. `browser_resize 375 812` (iPhone SE / 375px wide).
  2. `browser_navigate http://localhost:5173/leads/LEAD_MULTI_ID`
  3. `browser_snapshot` — confirm lead page renders on narrow viewport. **First, inspect the header snapshot empirically** to determine whether "Create Job" is directly visible as a button or wrapped differently at 375px. The lead-page action buttons are in a plain flex row with no `md:hidden` wrapper, so do NOT assume an overflow `⋮` menu — determine from the actual snapshot what is rendered and proceed based on what you see.
  4. `browser_click` the "Create Job" button.
  5. `browser_snapshot` — inspect the modal at 375px width.
  6. The estimate list is rendered with `max-h-72 overflow-y-auto` — all children are in the DOM regardless of visible scroll position (no virtualization). `browser_snapshot` can see all rows. `browser_take_screenshot` if a visual scroll proof is desired. (`browser_scroll` does not exist — do not use it.)
  7. `browser_click` an APPROVED unconverted estimate row to select it.
  8. `browser_snapshot` — confirm row selected and "Create job" enabled.
  9. `browser_click` the "Create job" button.
  10. `browser_wait_for` navigation to `/jobs/<id>` (timeout: 10 s).
  11. `browser_snapshot` — confirm job detail page renders at 375px.
  12. `browser_resize 1280 800` — restore desktop viewport.
- **Expected observable result:** At 375px the modal renders within viewport (no horizontal overflow; `max-w-md` constrains width). The estimate list scrolls vertically. "New estimate" and "Cancel"/"Create job" buttons are accessible without horizontal scroll. Conversion succeeds (201, navigation to job page).
- **Assertion:** No horizontal scroll in the modal. Estimate selectable. Navigation to `/jobs/<id>`. Job page renders at mobile width.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-H-02: Deep-link while logged out → login redirect then back to lead

- **Half:** Create-Job-from-Lead
- **Role:** DISPATCHER (fresh incognito / logged-out session)
- **Preconditions:** A logged-out browser session (clear cookies or use incognito). Know the deep-link URL with a valid `?createJob=` param.
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/leads/LEAD_ONE_APP_ID?createJob=EST_ONE_APP_ID` (while logged out).
  2. `browser_snapshot` — confirm redirect to login page.
  3. `browser_fill_form` or `browser_type` — enter the DISPATCHER email and password on the login form.
  4. `browser_click` the login submit button.
  5. `browser_wait_for` redirect after login (timeout: 10 s).
  6. `browser_snapshot` — inspect current URL and modal state.
- **Expected observable result (step 2):** App redirects to `/login` (or similar auth guard page). (step 6) After login, app redirects back. At minimum, the app lands on the correct lead (`/leads/LEAD_ONE_APP_ID`). If the router preserves the `from` location with the `?createJob=` param, the modal opens pre-selected. If only the lead URL is preserved (without the param), the page loads normally without the modal. Either behavior is acceptable — a complete round-trip with modal preselect is ideal but not guaranteed by the current router config.
- **Assertion:** After login, the user is not left on the login page; they are redirected to the lead or the app root (not a 404).
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-H-03: Technician POST /api/jobs with estimate_id → 403 (API-layer complement to M1)

- **Half:** Create-Job-from-Lead
- **Role:** TECH
- **Preconditions:** Logged in as TECH. Have a valid APPROVED unconverted estimate UUID (`EST_ONE_APP_ID` or similar in the same org).
- **Playwright steps:**
  1. Ensure logged in as TECH. Run the §1.6 API-level invocation method with `estimate_id=EST_ONE_APP_ID`.
  2. Assert the returned status from the `fetch` response (primary). `browser_network_requests` — filter to method=POST, url contains `/api/jobs`, take the most recent entry (secondary cross-check).
- **Expected observable result:** HTTP 403 — "Insufficient permissions". The controller gate at `job.controller.ts:606-609` (`role === 'TECHNICIAN' → 403`) fires before any DB lookup. No job is created.
- **Assertion:** Network response status = 403.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-H-04: Estimate-page "Create Job" button still works (regression)

- **Half:** Create-Job-from-Lead
- **Role:** DISPATCHER
- **Preconditions:** Navigate directly to an APPROVED, unconverted estimate's detail page (find one that has NOT been consumed by earlier test cases). Record: `EST_REGRESSION_ID`, `LEAD_REGRESSION_ID`.
- **Playwright steps:**
  1. `browser_navigate http://localhost:5173/estimates/EST_REGRESSION_ID`
  2. `browser_snapshot` — locate the "Create Job" button on the estimate detail page (the pre-existing button, not the one added in this feature).
  3. `browser_click` the "Create Job" button on the estimate page.
  4. `browser_wait_for` navigation to `/jobs/<id>` or a confirmation dialog (depending on estimate-page implementation).
  5. `browser_network_requests` — confirm POST `/api/jobs { estimate_id }` returned 201.
  6. `browser_snapshot` — job detail page loads.
- **Expected observable result:** The existing estimate-page conversion flow still works. Job is created (201), navigation to `/jobs/<id>`. This feature added a second entry point on the lead page — it did not remove or alter the estimate-page one.
- **Assertion:** Network 201. Navigation to `/jobs/<id>`. Job detail page renders with the job number.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

#### TC-H-05: SCHEDULE_JOB pin isolated to Dispatcher only (not in Admin or Sales bell)

- **Half:** Notification re-point
- **Role:** ADMIN, SALES (observe); DISPATCHER (trigger/verify in TC-F-01)
- **Preconditions:** TC-F-01 completed; DISPATCHER has a pinned "Schedule job" in "Needs action". ADMIN and SALES are simultaneously logged in.
- **Playwright steps (ADMIN window):**
  1. `browser_click` the bell icon.
  2. `browser_wait_for` panel open.
  3. `browser_snapshot` — inspect "Needs action" section.
- **Playwright steps (SALES window):**
  4. `browser_click` the bell icon.
  5. `browser_wait_for` panel open.
  6. `browser_snapshot` — inspect "Needs action" section.
- **Expected observable result (ADMIN):** No "Schedule job" item in "Needs action". Admin may have an informational (non-pinned) notification for the estimate approval in the "Earlier" feed. (SALES): No "Schedule job" item in "Needs action". Sales may have a SALES-targeted notification (e.g. "Your estimate was approved") in the feed, but no actionable "Schedule job" pin. The `updateMany` in `resolveScheduleJobNotifications` targets only `needs_action: true` rows — informational copies have `needs_action: false` and are unaffected.
- **Assertion:** Admin's "Needs action" has no SCHEDULE_JOB pin. Sales's "Needs action" has no SCHEDULE_JOB pin.
- **Pass/Fail:** [ ] Pass [ ] Fail

---

## 4. Coverage Matrix

This matrix maps every feature behavior from the implementation (as grounded in the code) and every stress-test guard from `stress-create-job-findings.md` to the test case(s) that exercise it. "API-only" means the behavior is only verifiable via network inspection (`browser_network_requests`), not DOM observation. "Automated" means it is covered by unit/integration tests and manual verification is supplementary.

### Feature Behaviors — Create-Job-from-Lead

| Behavior | Source (file:line) | Test Case(s) |
|---|---|---|
| "Create Job" button visible to ADMIN | `LeadDetailPage.tsx:823-828` | TC-A-01 |
| "Create Job" button visible to DISPATCHER | `LeadDetailPage.tsx:685-686, 823` | TC-A-02 |
| "Create Job" button hidden for SALES | `LeadDetailPage.tsx:685-686` | TC-A-03 |
| SALES-non-owner gets 403 on another rep's lead (FE renders "Lead not found." regardless) | `lead.controller.ts` OWN_LEAD scope + `canAccessRow` → 403 | TC-A-04 |
| TECHNICIAN sees button (M1 — canConvertToJob true via generic grant) | `LeadDetailPage.tsx:686, defaultGrants.ts:122` | TC-A-05 |
| TECHNICIAN POST → 403 at controller | `job.controller.ts:606-609` | TC-A-05, TC-H-03 |
| Modal opens on button click (`setCreateJobOpen(true)`) | `LeadDetailPage.tsx:824` | TC-A-01 through TC-A-05 |
| Empty estimates → "No estimates yet." with FileText icon | `CreateJobFromLeadDialog.tsx:73-77` | TC-B-01 |
| Non-APPROVED estimates → greyed rows, no radio dot, Create disabled | `CreateJobFromLeadDialog.tsx:82-89` | TC-B-02, TC-E-01 |
| Non-APPROVED row has no `onClick` (unselectable) | `CreateJobFromLeadDialog.tsx:93` | TC-E-01 |
| Hint text "No approved estimate to convert yet…" when convertible=0 | `CreateJobFromLeadDialog.tsx:128-133` | TC-B-01, TC-B-02 |
| Single APPROVED estimate auto-selected (`convertible.length===1`) | `CreateJobFromLeadDialog.tsx:53` | TC-B-03, TC-G-02 |
| Multiple APPROVED estimates — none auto-selected initially | `CreateJobFromLeadDialog.tsx:54` | TC-B-04 |
| Row click selects the estimate (`setSelectedId`) | `CreateJobFromLeadDialog.tsx:93` | TC-B-04 |
| Selected row gets `border-primary bg-primary-subtle` highlight | `CreateJobFromLeadDialog.tsx:90-91` | TC-B-03, TC-B-04, TC-G-01 |
| Already-converted estimate shows J##### link on the row | `CreateJobFromLeadDialog.tsx:108-119` | TC-B-05, TC-B-06 |
| J##### link closes modal and navigates to job | `CreateJobFromLeadDialog.tsx:113-116` | TC-B-05 |
| Converted estimate is NOT selectable (excluded from `convertible`) | `CreateJobFromLeadDialog.tsx:46, 82` | TC-B-05, TC-G-04 |
| Mixed lead: correct row state per status | All of the above | TC-B-06 |
| "Create job" button disabled without selection (`!selectedId`) | `CreateJobFromLeadDialog.tsx:152` | TC-B-01, TC-B-02, TC-B-04 |
| "Create job" button shows "Creating…" while pending | `CreateJobFromLeadDialog.tsx:157` | TC-D-01 (step 5) |
| `onConvert(selectedId)` fires `POST /api/jobs { estimate_id }` | `LeadDetailPage.tsx:1285, createJobMutation` | TC-D-01 |
| 201 → `navigate('/jobs/:id')` | `LeadDetailPage.tsx:626-628` | TC-D-01 |
| Error toast on failure ("Could not convert to job") | `LeadDetailPage.tsx:629-637` | TC-A-05, TC-E-02 |
| Modal stays open on error | `LeadDetailPage.tsx:629-637` (no close on error) | TC-A-05, TC-E-02 |
| Estimate shows as converted on return visit (J##### link) | API state reflected in next load | TC-D-02 |
| "New estimate" button visible only for ADMIN/SALES (`canCreateEstimate`) | `CreateJobFromLeadDialog.tsx:138-143, LeadDetailPage.tsx:669` | TC-B-01, TC-C-01 |
| "New estimate" hidden for DISPATCHER (`canCreateEstimate` false) | `LeadDetailPage.tsx:669` | TC-C-02 |
| "New estimate" navigates to `/estimates/new?lead_id=…`, no POST | `CreateJobFromLeadDialog.tsx:58-61` | TC-C-01 |
| Deposit PAID or VOIDED → conversion allowed (gate passes) | `job.controller.ts` deposit gate (PAID/VOIDED/REFUNDED allowed) | TC-E-06 |
| "New estimate" → create → approve → surfaces as convertible option on return | `CreateJobFromLeadDialog.tsx` estimate list reload | TC-C-03 |
| `?createJob=` param triggers `setPreselectEstimateId` + `setCreateJobOpen(true)` | `LeadDetailPage.tsx:577-585` | TC-F-02, TC-G-01 |
| Param is stripped via `setSearchParams({ replace: true })` | `LeadDetailPage.tsx:582-584` | TC-G-05, TC-F-02 |
| Preselect gates on membership in `convertible` (`convertible.some(e => e.id === preselectEstimateId)`) | `CreateJobFromLeadDialog.tsx:51` | TC-G-01, TC-G-02, TC-G-03, TC-G-04 |
| Preselect cleared on modal close (`setPreselectEstimateId(null)`) | `LeadDetailPage.tsx:1274-1279` | TC-G-05 |
| Hard refresh after close does NOT reopen modal | Consequence of param-strip | TC-G-05 |
| Manual button after deep-link opens clean selection | `setPreselectEstimateId(null)` on close | TC-G-06 |
| Mobile: modal `max-w-md`, list `max-h-72 overflow-y-auto` | `CreateJobFromLeadDialog.tsx:65, 80` | TC-H-01 |
| Login redirect preserves lead URL | Auth guard / router `from` state | TC-H-02 |
| Estimate-page "Create Job" button unaffected (regression) | `EstimateDetailPage` (unchanged) | TC-H-04 |

### Feature Behaviors — Schedule-Job Notification Re-Point

| Behavior | Source (file:line) | Test Case(s) |
|---|---|---|
| `handleScheduleJob` navigates to `/leads/:id?createJob=:estimateId` when `lead_id` present | `inlineActions.ts:47-48` | TC-F-02 |
| `handleScheduleJob` falls back to `/estimates/:estimateId` for legacy payloads (no `lead_id`) | `inlineActions.ts:49-51` | TC-F-06 |
| `handleScheduleJob` falls back to `/jobs?action=new-job` when no ids at all | `inlineActions.ts:52` | Automated (`inlineActions.test.ts`) |
| `handleScheduleJob` returns `{ skipActed: true }` — notification NOT marked done on click | `inlineActions.ts:54` | TC-F-03 |
| Notification stays PINNED in "Needs action" after clicking action | `skipActed: true` | TC-F-03 |
| `resolveScheduleJobNotifications` stamps `acted_at` + `read_at` on `needs_action:true` rows for the estimate | `resolveNotifications.ts:33-41` | TC-F-04 |
| Resolve called post-commit with default `prisma` client (not inside transaction) | `job.controller.ts:761-762` | TC-F-04 (API-level: TC-E-03 verifies job commits first) |
| Resolve never throws (swallows DB errors) — job still 201 | `resolveNotifications.ts:42-44` | Automated (`resolveNotifications.test.ts`) |
| Resolve targets only `needs_action:true, acted_at:null` rows — informational copies untouched | `resolveNotifications.ts:37-39` | TC-F-05, TC-H-05 |
| Resolve is org-scoped (`organization_id` filter) | `resolveNotifications.ts:23` | TC-H-05 (API-only: cross-org rows not updated) |
| `object_id` in resolve = estimate UUID (no J-number mismatch) | `resolveNotifications.ts:27; notificationService.ts:101` | TC-F-04 (pass = correct row cleared) |
| Dispatcher's pinned item NOT in Admin or Sales bell under "Needs action" | `needs_action` flag only on Dispatcher recipient | TC-H-05 |
| Deposit-paid event also includes `lead_id` in SCHEDULE_JOB payload | `estimate.controller.ts:1649,1661,2153` (B1 change) | TC-F-07 |
| Notification updates visible on refetch (window-focus/bell open) without Realtime push | TanStack Query invalidation | TC-F-04 step 7 (refetch instruction) |
| Resolve skipped on idempotent 200 early-return (accepted M3) | `job.controller.ts:697-700` — no resolve call | TC-E-03 documents this; M3 note |
| Resolve skipped on P2002 race 200 early-return | `job.controller.ts:770-776` — no resolve call | Automated (`jobs.test.ts`) |
| Opening notification panel marks unseen→seen; badge clears (seen ≠ acted) | `NotificationBell` mark-seen-on-open logic | TC-F-08 |
| `resolveScheduleJobNotifications` filters by specific `object_id` — does not mass-clear sibling pins | `resolveNotifications.ts:27` | TC-F-09 |

### Stress-Test Guards (from `stress-create-job-findings.md`)

| Stress scenario | Severity | Test Case(s) | API-only / Browser |
|---|---|---|---|
| SALES POST `/api/jobs` → denied (no `create Job` grant) | — (already handled) | TC-E-05 | API-only |
| Non-owner SALES reads another rep's lead → 403 (FE renders "Lead not found.") | — | TC-A-04 | Browser |
| TECHNICIAN converts estimate → 403 in controller | — | TC-A-05, TC-H-03 | Both |
| Cross-tenant `estimate_id` → 404 (`tenantWhere` scoped) | Critical | TC-E-04 | API-only |
| Non-APPROVED estimate statuses (DRAFT/SENT/PENDING/DECLINED/EXPIRED/CANCELLED) → 400 | Critical | TC-E-01 (UI), TC-E-02 notes (SENT deposit state) | Both; full 6-status coverage = Automated |
| Already-converted estimate → 200 idempotent return (not 409, not dup) | Critical | TC-E-03 | API-only (UI shows converted state) |
| Concurrent P2002 race → re-query → 200 with existing job | Critical | Automated (`jobs.test.ts:766-779`) | Automated |
| Deposit-required-but-unpaid (DRAFT/SENT/PARTIAL/DISPUTED) → 400 | Important | TC-E-02 | Browser |
| Deposit PAID/VOIDED/REFUNDED/PARTIALLY_REFUNDED → allowed | — | TC-E-06, Automated (`jobs.test.ts:446,505,528`) | Both |
| Body `service_location_id` from different customer/org → 404 | Important | Automated (`jobs.test.ts:731`) | Automated |
| Standalone: customer/location not in requester org → 404 | Important | Automated (`jobs.test.ts:984,993`) | Automated |
| Estimate with no associated customer (orphan) → 400 | — | Automated (`jobs.test.ts`) | Automated |
| Resolve helper throws internally → job still 201 (best-effort) | Critical (accepted) | Automated (`resolveNotifications.test.ts`) | Automated (M3 documents stale-pin risk) |
| Resolve touches only correct rows (org + object_id + action_type + needs_action:true + acted_at:null) | Critical | TC-F-05, TC-H-05 | Browser (informational copies unchanged) |
| Resolve is post-commit → cannot roll back job | Important | TC-F-04 (job arrives → then bell cleared) | Browser (sequence observable) |
| Resolve called on idempotent early-return? No — by design (M3) | Minor | TC-E-03 (documents), M3 note | API |
| `object_id` = estimate UUID on both emit and resolve sides (no J-number mismatch) | Critical | TC-F-04 (correct notification cleared) | Browser |
| Deep-link `?createJob=<garbage/foreign/converted>` → degrades safely, no wrong conversion | Important | TC-G-02, TC-G-03, TC-G-04 | Browser |
| Convert button only sends ids from the lead's own estimate list | — | TC-G-03 (foreign UUID not submittable via modal) | Browser |
| Zero estimates / all-converted / many estimates → correct empty/disabled/no-auto-select state | Minor (M2 flash) | TC-B-01, TC-B-05, TC-B-04 | Browser |
| Schema fuzz: non-UUID, partial, missing body → 400 (Zod `superRefine`) | — | Automated (`jobs.test.ts:886,892,899`) | Automated |
| TECHNICIAN sees button but action 403s (M1 — cosmetic) | Minor | TC-A-05, TC-H-03 | Browser + API |

---

## 5. Known / Expected Minor Behaviors

Do NOT file the following as bugs. Reference this section when a tester observes the behavior.

### M1 — Technician sees "Create Job" but action 403s
`canConvertToJob = role===ADMIN || role===DISPATCHER || ability.can('create','Job')`. TECHNICIAN holds a generic `create Job` grant (`defaultGrants.ts:122`) for the on-site/urgent standalone flow. A technician who is a walkthrough performer on a lead can read that lead and will see the sage "Create Job" button. Clicking it → modal opens → clicking "Create job" → `POST /api/jobs { estimate_id }` → controller gate at `job.controller.ts:606-609` → 403 → destructive toast "Could not convert to job". Modal stays open. No data changed. **Expected.** See TC-A-05, TC-H-03.

### M2 — Brief empty-flash when deep-link opens modal before estimates load
The `?createJob=` effect (`LeadDetailPage.tsx:577-585`) sets `createJobOpen=true` immediately on mount. The `estimates` array comes from the async lead query. On a cold load, the modal may briefly render "No estimates yet." before the lead query resolves and the preselect `useEffect` re-fires (`CreateJobFromLeadDialog.tsx:56`). No incorrect conversion can result — preselect only fires once estimates are populated. **Expected on slow connections.** See TC-F-02 note, TC-G-01 note.

### M3 — Stale notification pin if resolve throws on the FIRST conversion
`resolveScheduleJobNotifications` wraps in try/catch and swallows errors (`resolveNotifications.ts:42-44`). If the helper throws on the first successful conversion (rare DB error), the Dispatcher's pin remains `needs_action:true`. Subsequent idempotent re-POSTs skip the resolve call (by design, `job.controller.ts:758-760`). Impact: low-probability stale pin; job is correctly created. **Accepted design trade-off.** See TC-F-04 note, TC-E-03.

---

## 6. Execution Order & Teardown

### Recommended execution order

1. **Setup:** Create all fixtures (Section 2). Ensure TECH walkthrough assignment. Start app servers. Confirm migrations applied for Group F.
2. **Read-only/visibility (no mutations):** Groups A, B — do these first on unmodified fixture data. TC-C-01 and TC-C-02 are also non-mutating. TC-C-03 is mutating (creates and converts an estimate on Lead-EMPTY) — run it after Groups A and B but before Group D.
3. **Deep-link edge cases (non-converting):** Group G (TC-G-01 through TC-G-05, TC-G-06 last as it requires modal-close state from G-05). These do not convert estimates.
4. **Cross-cutting (non-converting):** TC-H-01 (mobile viewport — converts one estimate from Lead-MULTI-APP `EST_MULTI_ID_B`), TC-H-02 (logged-out redirect — does not convert), TC-H-03 (API-only 403), TC-H-04 (estimate-page regression — converts `EST_REGRESSION_ID`).
5. **Converting guards:** Groups E (TC-E-01 through TC-E-06). TC-E-02 attempts but fails (deposit blocks — no mutation). TC-E-03 and TC-E-04 consume `EST_IDEMPOTENT_ID` and `CROSS_TENANT_ESTIMATE_ID` respectively. TC-E-06 consumes `EST_DEPOSIT_PAID_ID`.
6. **Convert happy path:** Group D (TC-D-01 consumes Lead-ONE-APP's estimate; TC-D-02 verifies).
7. **Notification lifecycle:** Group F (TC-F-01 through TC-F-09). These require the notification migrations to be applied and two browser windows open simultaneously. TC-F-08 runs after TC-F-01 (requires an unread pin). TC-F-09 requires two separate SCHEDULE_JOB pins for Lead-MULTI-APP.
8. **Role isolation:** TC-H-05 (run concurrently with Group F, after TC-F-01).

### Estimate fixture lifecycle

| Fixture estimate | Consumed by | Do not reuse after |
|---|---|---|
| `EST_ONE_APP_ID` | TC-D-01 (converts it) | TC-D-01 |
| `EST_MULTI_ID_A` | TC-G-01 (deep-link; does NOT convert unless TC-G-01 accidentally triggers convert — it should not) | — |
| `EST_MULTI_ID_B` | TC-H-01 (converts it for the mobile test) | TC-H-01 |
| `EST_IDEMPOTENT_ID` | TC-E-03 (converts it) | TC-E-03 |
| `EST_REGRESSION_ID` | TC-H-04 (converts it via estimate page) | TC-H-04 |
| `EST_F_ID` | TC-F-04 (converts it — notification lifecycle) | TC-F-04 |
| `EST_DEP_F_ID` | TC-F-07 (deposit-paid notification; does not convert the estimate via the test itself) | — |
| `EST_DEPOSIT_PAID_ID` | TC-E-06 (converts it — deposit-paid happy path) | TC-E-06 |
| `EST_NEW_ID` | TC-C-03 (creates and converts it — end-to-end affordance) | TC-C-03 |

### Between-run reset

If you need to re-run converting test cases (D, E-03, H-01, H-04, F-04), create **fresh APPROVED unconverted estimates** on fresh leads. Do not try to "un-convert" an existing job — the `@unique estimate_id` constraint means a converted estimate cannot be re-used. The staging DB has sufficient headroom (949 estimates, 761 jobs as of baseline).

### Teardown

No automated teardown is required. Converted estimates/jobs created during testing remain on staging. If the staging org is to be kept clean, manually delete test jobs via the admin UI or via Supabase Studio after the session. Do not delete jobs that are referenced by other tests in the same session.

---

## 7. Pass / Fail Summary Sheet

| TC ID | Group | Description | Notification prereq? | Result |
|---|---|---|---|---|
| TC-A-01 | A | Admin sees "Create Job" button | No | [ ] P [ ] F |
| TC-A-02 | A | Dispatcher sees "Create Job" button | No | [ ] P [ ] F |
| TC-A-03 | A | Sales (own lead) does NOT see button | No | [ ] P [ ] F |
| TC-A-04 | A | Sales (not-owned lead) → 403 / "Lead not found." | No | [ ] P [ ] F |
| TC-A-05 | A | Technician sees button; action 403s (M1) | No | [ ] P [ ] F |
| TC-B-01 | B | Empty lead → "No estimates yet.", Create disabled | No | [ ] P [ ] F |
| TC-B-02 | B | Non-APPROVED only → all greyed, hint shown | No | [ ] P [ ] F |
| TC-B-03 | B | Single APPROVED → auto-selected | No | [ ] P [ ] F |
| TC-B-04 | B | Multiple APPROVED → none auto-selected; selects on click | No | [ ] P [ ] F |
| TC-B-05 | B | Already-converted → J##### link, not selectable; link navigates | No | [ ] P [ ] F |
| TC-B-06 | B | Mixed lead → correct state per estimate status | No | [ ] P [ ] F |
| TC-C-01 | C | "New estimate" navigates, no POST fired (Admin) | No | [ ] P [ ] F |
| TC-C-02 | C | "New estimate" hidden for Dispatcher | No | [ ] P [ ] F |
| TC-C-03 | C | "New estimate" → create → approve → convert (end-to-end affordance) | No | [ ] P [ ] F |
| TC-D-01 | D | Happy path → 201 → navigates to /jobs/:id | No | [ ] P [ ] F |
| TC-D-02 | D | Return to lead shows converted estimate | No | [ ] P [ ] F |
| TC-E-01 | E | Non-APPROVED row has no click handler | No | [ ] P [ ] F |
| TC-E-02 | E | Deposit unpaid → 400 toast, modal stays open | No | [ ] P [ ] F |
| TC-E-03 | E | Double-submit → 200 idempotent, no dup job | No | [ ] P [ ] F |
| TC-E-04 | E | Cross-tenant estimate_id → 404 | No | [ ] P [ ] F [ ] N/A |
| TC-E-05 | E | SALES POST → 403 | No | [ ] P [ ] F |
| TC-E-06 | E | Deposit waived/PAID → conversion allowed (happy path) | No | [ ] P [ ] F |
| TC-F-01 | F | Approve estimate → Dispatcher pinned "Schedule job" | **Yes** | [ ] P [ ] F |
| TC-F-02 | F | Click action → lead with picker pre-selected | **Yes** | [ ] P [ ] F |
| TC-F-03 | F | Notification stays pinned after click (no auto-act) | **Yes** | [ ] P [ ] F |
| TC-F-04 | F | Notification leaves "Needs action" after job created | **Yes** | [ ] P [ ] F |
| TC-F-05 | F | Admin/Sales informational copies unaffected | **Yes** | [ ] P [ ] F |
| TC-F-06 | F | Legacy (no lead_id) falls back to estimate page, stays pinned | **Yes** | [ ] P [ ] F [ ] N/A |
| TC-F-07 | F | Deposit-paid event also re-points to lead | **Yes** | [ ] P [ ] F |
| TC-F-08 | F | Bell badge: unseen-count clears on open; seen ≠ acted | **Yes** | [ ] P [ ] F |
| TC-F-09 | F | Multi-pin isolation: converting A clears only A's pin | **Yes** | [ ] P [ ] F |
| TC-G-01 | G | Valid UUID in deep-link → preselected | No | [ ] P [ ] F |
| TC-G-02 | G | Garbage value in deep-link → no crash, no wrong selection | No | [ ] P [ ] F |
| TC-G-03 | G | Foreign-org UUID in deep-link → degrades safely | No | [ ] P [ ] F [ ] N/A |
| TC-G-04 | G | Already-converted UUID in deep-link → no preselect | No | [ ] P [ ] F |
| TC-G-05 | G | Close strips param; hard refresh does NOT reopen | No | [ ] P [ ] F |
| TC-G-06 | G | Manual button after deep-link → clean modal | No | [ ] P [ ] F |
| TC-H-01 | H | Mobile viewport (375px) — button + modal + conversion | No | [ ] P [ ] F |
| TC-H-02 | H | Deep-link while logged out → login redirect | No | [ ] P [ ] F |
| TC-H-03 | H | Technician POST → 403 (API complement to M1) | No | [ ] P [ ] F |
| TC-H-04 | H | Estimate-page "Create Job" button regression | No | [ ] P [ ] F |
| TC-H-05 | H | SCHEDULE_JOB pin isolated to Dispatcher only | **Yes** | [ ] P [ ] F |

**Total: 44 test cases (41 always-executable + 3 that may be N/A: TC-E-04, TC-F-06, TC-G-03)**
