# Manual UI QA Checklist

**Goal:** Verify every workflow path works correctly through the browser UI. The backend is proven via 304 API tests — this checklist focuses on rendering, forms, navigation, dialogs, and visual state updates.

**Approach:** Walk through 8 end-to-end scenarios that cover the most UI surface area. Each scenario hits multiple pages, forms, dialogs, and status transitions. After the scenarios, there's a targeted checklist for features that aren't covered by the flows.

**Time estimate:** ~2-3 hours for all scenarios + targeted checks.

---

## How to Use This Checklist

- Work through scenarios in order (each builds familiarity)
- Check the box when verified
- Note any issues in the "Issues Found" section at the bottom
- For each step, verify both the **action** (does it work?) and the **display** (does it look right?)

---

## Scenario 1: Standard Flow — No Deposit (Happy Path)

This covers: LeadsPage, LeadFormPage, LeadDetailPage, EstimateFormPage, EstimateDetailPage, PublicEstimatePage, JobDetailPage, SchedulePage

### Create Lead
- [ ] Navigate to Leads page — KPI strip loads with numbers
- [ ] Click "New Lead" — form page loads
- [ ] Fill customer section (new customer): first name, last name, email, phone
- [ ] Fill service request, job type, address fields
- [ ] Submit — redirects to lead detail page
- [ ] Verify: status badge shows "NEW", lead number displayed (L00XXX format)
- [ ] Verify: customer name, service request, address all display correctly

### Contact Lead
- [ ] Click "Contact" action button — dialog opens
- [ ] Fill contacted date and note
- [ ] Submit — status badge changes to "CONTACTED"
- [ ] Verify: contacted_at and note appear in the detail view

### Schedule Walkthrough
- [ ] Walkthrough section visible with scheduling fields
- [ ] Select a performer (Sales/Technician user from dropdown)
- [ ] Set date/time and duration
- [ ] Submit — status changes to "WALKTHROUGH_SCHEDULED"
- [ ] Verify: walkthrough date, performer, duration all display

### Complete Walkthrough
- [ ] Click "Complete Walkthrough" — dialog or action
- [ ] Submit — status changes to "WALKTHROUGH_COMPLETED"
- [ ] Verify: completion date shows

### Create Estimate
- [ ] Navigate to Estimates page or click "New Estimate" from lead detail
- [ ] NewEstimateDialog opens (if from Estimates page) — search and select customer/lead
- [ ] EstimateFormPage loads — verify lead info pre-populated
- [ ] Add 2-3 line items (description, qty, unit price)
- [ ] Verify: line totals calculate live, subtotal/tax/total update
- [ ] Set tax rate — verify tax amount recalculates
- [ ] Click "Preview" — EstimateDocumentView dialog shows formatted estimate
- [ ] Close preview, click "Save" — redirects to EstimateDetailPage
- [ ] Verify: status "DRAFT", line items displayed, totals match

### Send Estimate
- [ ] Click "Send" — SendEstimateDialog opens
- [ ] Toggle deposit OFF (no deposit required)
- [ ] Submit — status changes to "SENT"
- [ ] Verify: sent_at date appears, public link section visible

### Customer Approves (Public Page)
- [ ] Copy the public estimate URL (or open from estimate detail)
- [ ] Open in incognito/new tab — PublicEstimatePage loads
- [ ] Verify: estimate details, line items, totals all render correctly
- [ ] Draw signature on the signature pad
- [ ] Click "Approve" — success message shows
- [ ] Verify: page shows "Approved" state with signature displayed

### Verify Approval
- [ ] Back in admin view, refresh estimate detail
- [ ] Status shows "APPROVED", signature_at displayed
- [ ] Navigate to lead — status should be "WON"

### Create Job
- [ ] On estimate detail, click "Create Job"
- [ ] Job created — redirected to JobDetailPage
- [ ] Verify: status "UNASSIGNED", estimate link shown, customer/location displayed

### Assign Job (Schedule)
- [ ] Click "Assign" — AssignJobDialog opens
- [ ] Select technician from dropdown
- [ ] Set scheduled start/end dates
- [ ] Submit — status changes to "SCHEDULED"
- [ ] Navigate to Schedule page — verify job appears on the calendar at correct time/date

---

## Scenario 2: Deposit Flow — CHECK Payment

### Setup (reuse or create new)
- [ ] Create lead → Contact → Walkthrough → Complete (same as Scenario 1)
- [ ] Create estimate with line items

### Send With Deposit
- [ ] Click "Send" — SendEstimateDialog opens
- [ ] Toggle deposit ON
- [ ] Select payment methods: CHECK, CASH (multi-select)
- [ ] Submit — status changes to "SENT"
- [ ] Verify: Deposit tab appears on estimate detail showing "REQUESTED" status and amount

### Customer Approves with CHECK
- [ ] Open public estimate page
- [ ] Verify: deposit amount and payment method options displayed
- [ ] Draw signature
- [ ] Select "CHECK" as payment method
- [ ] Click "Approve" — page shows "PENDING" with CHECK payment instructions
- [ ] Verify: instructions mention check details

### Admin Marks Deposit Received
- [ ] Back in admin view, refresh estimate detail
- [ ] Status shows "PENDING", Deposit tab shows "REQUESTED"
- [ ] Click "Mark Received" — MarkDepositReceivedDialog opens
- [ ] Fill received date, reference number (check #), notes
- [ ] Submit — estimate status changes to "APPROVED", deposit status to "PAID"
- [ ] Verify: lead status is "WON"

### Create & Schedule Job
- [ ] Create job from estimate → assign to tech with dates
- [ ] Verify on Schedule page

---

## Scenario 3: Estimate Declined → New Estimate → Approve

- [ ] Create lead through walkthrough completed
- [ ] Create and send estimate #1 (no deposit)
- [ ] Open public page → Decline estimate
- [ ] Verify: public page shows "Declined" state
- [ ] Back in admin: estimate status "DECLINED"
- [ ] Click "Duplicate" on the declined estimate
- [ ] Verify: new DRAFT estimate created with same line items
- [ ] Edit the duplicate (change price/qty) — verify totals recalculate
- [ ] Send the duplicate (no deposit)
- [ ] Approve via public page
- [ ] Create job → assign → verify on schedule

---

## Scenario 4: Cancellation Paths

### Cancel Estimate
- [ ] Create lead → estimate → send (with deposit)
- [ ] Click "Cancel Estimate" — CancelEstimateDialog opens
- [ ] Enter reason → submit
- [ ] Verify: status "CANCELLED", deposit shows "VOIDED"

### Mark Lead as Lost
- [ ] Create a new lead → contact → schedule walkthrough
- [ ] Click "Mark Lost" — MarkLostDialog opens
- [ ] Enter reason → submit
- [ ] Verify: status "LOST", walkthrough section shows cancelled
- [ ] Verify: any active estimates are now CANCELLED

### Cancel Job
- [ ] Use a flow to get to a SCHEDULED job
- [ ] Click "Cancel" — CancelJobDialog opens
- [ ] Enter reason → submit
- [ ] Verify: status "CANCELLED", reason displayed

### Unassign Job
- [ ] Create another SCHEDULED job
- [ ] Click "Unassign"
- [ ] Verify: status back to "UNASSIGNED", dates cleared
- [ ] Reassign to different tech — verify "SCHEDULED" again

---

## Scenario 5: Deposit Management (Waive + Refund)

### Waive Deposit
- [ ] Create lead → estimate → send with deposit
- [ ] On estimate detail, Deposit tab, click "Waive Deposit"
- [ ] WaiveDepositDialog opens — select "Waive and Approve"
- [ ] Submit — estimate APPROVED, deposit VOIDED, lead WON
- [ ] Create job from this estimate (should work — deposit gate passed)

### Refund Deposit
- [ ] Create another lead → estimate → send with deposit (CHECK)
- [ ] Approve with CHECK → mark deposit received → estimate APPROVED
- [ ] DO NOT create a job yet
- [ ] Click "Refund Deposit" — RefundDepositDialog opens
- [ ] Select reason category, enter reason text
- [ ] Submit — deposit REFUNDED, estimate CANCELLED
- [ ] Verify: lead status (should still be WON — terminal)

---

## Scenario 6: Urgent Job Flow

- [ ] Navigate to Jobs page
- [ ] Click "New Urgent Job" — NewUrgentJobDialog opens (multi-step)
- [ ] Step 1: Search and select customer
- [ ] Step 2: Select service location
- [ ] Step 3: Fill urgency reason, scope notes
- [ ] Submit — job created, redirected to detail page
- [ ] Verify: status "UNASSIGNED", "Urgent" badge visible

### Add Charges
- [ ] Navigate to "Work Items" tab
- [ ] Click "Add Charge" — inline form or dialog
- [ ] Fill description, qty, unit price
- [ ] Verify: line_total calculates correctly
- [ ] Add 2nd charge → verify totals update
- [ ] Edit a charge (change qty) → verify recalculation
- [ ] Delete a charge → verify remaining charges display correctly

### Assign & Complete
- [ ] Assign to tech with scheduled dates → "SCHEDULED"
- [ ] Click "Start" → "IN_PROGRESS"
- [ ] Click "Complete" — CompleteJobDialog opens
- [ ] Enter completion notes → submit → "COMPLETED"

---

## Scenario 7: Schedule Page Interactions

- [ ] Navigate to Schedule page
- [ ] Verify: calendar loads, existing jobs appear
- [ ] Switch views: Week → Day → Month → By-Tech grid
- [ ] Click on a job event — verify detail popup shows correct info
- [ ] Drag a job to a different time slot — RescheduleConfirmDialog appears
- [ ] Confirm reschedule — job moves to new time
- [ ] Check unassigned jobs sidebar — jobs without techs listed
- [ ] Use search in schedule view — verify it filters to jobs/walkthroughs

---

## Scenario 8: Public Estimate Page — All States

Open the public estimate page in various states to verify rendering:

- [ ] SENT (no deposit) — shows signature pad + approve/decline buttons
- [ ] SENT (with deposit) — shows signature pad + payment method selection (CHECK/CASH/CARD buttons)
- [ ] PENDING (CHECK selected) — shows deposit info, payment instructions, "Change Method" + "Decline" buttons
- [ ] APPROVED (no deposit) — shows "Approved" with signature and approval date
- [ ] APPROVED (with deposit) — shows "Approved" with signature + deposit receipt
- [ ] DECLINED — shows "Declined" message
- [ ] CANCELLED — shows "Cancelled" message
- [ ] EXPIRED — shows "Expired" message

---

## Targeted Checks (Non-Flow)

### List Pages
- [ ] **CustomersPage**: search works, filters work (source, state, payment type), column sorting, CSV export downloads, pagination changes, column visibility toggle
- [ ] **LeadsPage**: search works, status filter, assigned_to filter, unassigned warning badge in KPI, CSV export
- [ ] **EstimatesPage**: status filter, created_by filter, date range filter, KPI values match data, CSV export
- [ ] **JobsPage**: status filter, is_urgent filter, assigned_to filter, KPI counts match, CSV export

### Detail Page Tabs
- [ ] **Customer detail**: Overview tab (financial summary), Leads tab (lead list), Jobs tab, Locations tab (add/edit/delete locations), Notes tab (add/list notes)
- [ ] **Lead detail**: all sections render, walkthrough section updates, estimates section shows linked estimates, notes work
- [ ] **Estimate detail**: Line Items tab (with thumbnails if price book items), Details tab, Deposit tab, Notes tab
- [ ] **Job detail**: Work Items tab (standard: read-only line items; urgent: editable charges), Details tab, Notes tab, Timeline tab (events listed)

### Forms & Validation
- [ ] Lead form: required field validation (service_request empty → error)
- [ ] Estimate form: add line item with 0 qty → validation error
- [ ] Estimate form: save with no line items → validation error
- [ ] Job cancel: submit without reason → validation error
- [ ] Job complete: submit without notes → validation error

### Navigation
- [ ] Breadcrumbs work on all detail pages (back button, parent links)
- [ ] Clicking customer name on lead detail → navigates to customer detail
- [ ] Clicking estimate number on job detail → navigates to estimate detail
- [ ] Clicking lead on estimate detail → navigates to lead detail
- [ ] Browser back/forward work correctly

### Error States
- [ ] Navigate to non-existent lead ID → 404 or "not found" display
- [ ] Navigate to non-existent estimate ID → 404 or "not found" display
- [ ] Try to access a page without auth → redirected to login

### Global Search (Ctrl+K)
- [ ] Search for a customer name → results appear
- [ ] Search for a lead number (L00XXX) → lead appears
- [ ] Search for an estimate number (E00XXX) → estimate appears
- [ ] Search for a job number (J00XXX) → job appears
- [ ] Click a result → navigates to correct detail page

---

## Issues Found

| # | Scenario | Step | Issue Description | Severity |
|---|----------|------|-------------------|----------|
| | | | | |
| | | | | |
| | | | | |

---

## Notes
- Test on Chrome (primary) — Chromium is the Playwright target
- Keep the backend running (`npm run dev:backend`) and frontend (`npm run dev:frontend`)
- Login as admin: `admin@alphacrm.com` / `Admin123!@#`
- You'll need at least 1 SALES user and 1 TECHNICIAN user in the system for assignment tests
