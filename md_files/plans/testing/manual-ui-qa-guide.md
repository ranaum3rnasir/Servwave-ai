# ALPHA CRM — Manual UI QA Guide

## About This Document

This guide is for a QA tester who has never used ALPHA CRM before. It walks through every workflow path in the application with exact steps, expected results, and visual checkpoints. The backend has been fully tested (304 automated API tests passing) — this guide focuses on verifying the **user interface** works correctly.

---

## Environment Setup

### Prerequisites
- **Browser:** Chrome (latest)
- **URLs:**
  - Frontend: `http://localhost:5173`
  - Backend: `http://localhost:3000`
- Both servers must be running:
  ```bash
  npm run dev:backend    # Terminal 1
  npm run dev:frontend   # Terminal 2
  ```

### Login Credentials
| Role | Email | Password |
|------|-------|----------|
| Admin | `admin@alphacrm.com` | `Admin123!@#` |

### First Steps After Login
1. Open `http://localhost:5173/login`
2. Enter the Admin credentials above
3. Click **"Sign In"**
4. You should be redirected to the Dashboard page
5. The left sidebar should show: Dashboard, Customers, Leads, Estimates, Price Book, Jobs, Schedule, Invoices, Reports, Users

---

## How to Use This Guide

- **Work through the scenarios in order** — later scenarios assume data created by earlier ones
- For each step, verify both the **action** (does it work?) and the **display** (does it look right?)
- **Record any issues** in the Issues Log at the bottom
- Checkboxes: mark each step as you complete it
- **Expected Result** = what you should see after performing the action
- **Visual Check** = specific UI elements to verify (badges, colors, layout)

**Estimated time:** 3-4 hours for all scenarios

---

## PRE-TEST: Test Users (Already Created)

The following test users have been pre-created for QA. You will see them in assignment dropdowns throughout the app.

| Role | Name | Email | Password |
|------|------|-------|----------|
| Admin | Admin User | admin@alphacrm.com | Admin123!@# |
| Sales | Sarah Sales | sarah.sales@alphacrm.com | Test123!@# |
| Technician | Mike Tech | mike.tech@alphacrm.com | Test123!@# |

- **Sarah Sales** appears in lead assignment dropdowns (Assign Lead dialog, walkthrough performer)
- **Mike Tech** appears in job assignment dropdowns (Assign Job dialog, Schedule page)

> **Note:** There is no user management UI yet. If you need additional test users, ask the developer to create them via the API.

---

## SCENARIO 1: Complete Standard Flow (No Deposit)

**Purpose:** Test the golden path — Lead through to Job Scheduled — with no deposit requirement.

**Pages covered:** Leads list, Lead form, Lead detail, Estimate form, Estimate detail, Public estimate, Job detail, Schedule

---

### 1.1 Create a New Lead

- [ ] **Navigate:** Click **"Leads"** in the left sidebar
- [ ] **Visual Check:** Leads page loads with:
  - Page title "Leads" with a count badge
  - KPI strip showing 5 metrics (Total Leads, New This Week, Unassigned, Won, Lost)
  - Data table below (may be empty or have existing data)

- [ ] **Action:** Click the **"New Lead"** button (top right, blue)
- [ ] **Expected:** Navigates to `/leads/new` — the lead creation form

- [ ] **Fill the form:**
  - Under "New Customer" section:
    - First Name: `John`
    - Last Name: `Anderson`
    - Email: `john.anderson@test.com`
    - Phone: `5551234567`
  - Service Request: `HVAC system not cooling — needs inspection and repair`
  - Job Type: select `HVAC Service` from dropdown
  - Job Source: select `Google` from dropdown
  - Service Address: `123 Main Street`
  - City: `Austin`
  - State: `TX`
  - ZIP: `78701`

- [ ] **Action:** Click **"Save"** (or **"Create Lead"**)
- [ ] **Expected:** Redirects to the Lead Detail page (`/leads/:id`)

- [ ] **Visual Check on Lead Detail:**
  - Status badge shows **"NEW"** (should be a neutral/gray color)
  - Lead number displayed in format `L00XXX`
  - Customer name "John Anderson" appears
  - Service request text appears
  - Address shows "123 Main Street, Austin, TX 78701"
  - Breadcrumb at top shows: Leads > L00XXX

- [ ] **Record the lead number:** L_______ (you'll need this later)

---

### 1.2 Contact the Lead

- [ ] **Action:** On the Lead Detail page, click **"Contact Lead"** button
- [ ] **Expected:** A dialog opens titled "Contact Lead" (or similar)

- [ ] **Fill the dialog:**
  - Date/Time: leave as default (current time) or set to today
  - Note: `Spoke with customer, confirmed HVAC issue. Scheduling walkthrough.`

- [ ] **Action:** Click **"Submit"** (or **"Save"**)
- [ ] **Expected:** Dialog closes, page refreshes

- [ ] **Visual Check:**
  - Status badge changes to **"CONTACTED"** (should be a blue/info color)
  - Contacted date appears in the detail view
  - Contact note appears

---

### 1.3 Schedule a Walkthrough

- [ ] **Action:** Navigate to the **Walkthrough** tab (if tabbed) or scroll to the Walkthrough section
- [ ] **Visual Check:** Walkthrough scheduling fields are visible

- [ ] **Fill the walkthrough form:**
  - Performer: Select **"Sarah Sales"** (or available Sales/Technician user) from dropdown
  - Date & Time: Select tomorrow at 10:00 AM
  - Duration: Select **"1 hour"** from dropdown

- [ ] **Action:** Click **"Schedule Walkthrough"**
- [ ] **Expected:** Success message or page update

- [ ] **Visual Check:**
  - Status badge changes to **"WALKTHROUGH_SCHEDULED"** (or "WT Scheduled")
  - Walkthrough date/time, performer, and duration all display correctly
  - A "Cancel Walkthrough" button appears

---

### 1.4 Complete the Walkthrough

- [ ] **Action:** Click **"Complete Walkthrough"** button
- [ ] **Expected:** Dialog opens (or inline action)

- [ ] **Action:** Confirm completion
- [ ] **Expected:** Success

- [ ] **Visual Check:**
  - Status badge changes to **"WALKTHROUGH_COMPLETED"** (or "WT Completed")
  - Completion date appears
  - Walkthrough section shows completed state

---

### 1.5 Create an Estimate

- [ ] **Action:** Click **"New Estimate"** button on the Lead Detail page
- [ ] **Expected:** Navigates to EstimateFormPage (`/estimates/new`) with lead info pre-selected

- [ ] **Visual Check:** The lead/customer info should be pre-populated at the top of the form

- [ ] **Fill the estimate form:**
  - Scope Notes: `Full HVAC inspection, filter replacement, coolant recharge`
  - Tax Rate: Select **"Texas"** (or appropriate state) from the "Tax Rate (by State)" dropdown

  - **Line Item 1:**
    - Item name: `HVAC Inspection`
    - Qty: `1`
    - Price: `250.00`

  - [ ] **Action:** Click **"+ Add Line Item"**

  - **Line Item 2:**
    - Item name: `Filter Replacement`
    - Qty: `2`
    - Price: `45.00`

  - [ ] **Action:** Click **"+ Add Line Item"**

  - **Line Item 3:**
    - Item name: `Coolant Recharge`
    - Qty: `1`
    - Price: `180.00`

- [ ] **Visual Check — Live Totals (bottom of form):**
  - Subtotal should show: `$520.00` (250 + 90 + 180)
  - Tax amount should be calculated based on the selected state rate
  - Total should be Subtotal + Tax

- [ ] **Action:** Click **"Preview"** button (if available)
- [ ] **Expected:** A preview dialog shows the formatted estimate document
- [ ] **Action:** Close preview

- [ ] **Action:** Click **"Save"**
- [ ] **Expected:** Redirects to Estimate Detail page (`/estimates/:id`)

- [ ] **Visual Check on Estimate Detail:**
  - Status badge shows **"DRAFT"**
  - Estimate number in format `E00XXX`
  - Line Items tab shows all 3 items with correct quantities, prices, and line totals
  - Total matches what you entered
  - Breadcrumb: Estimates > E00XXX

- [ ] **Record the estimate number:** E_______

---

### 1.6 Send the Estimate

- [ ] **Action:** Click **"Send"** button (blue, primary)
- [ ] **Expected:** The **"Send Estimate"** dialog opens

- [ ] **Visual Check in dialog:**
  - "To" field shows customer email (john.anderson@test.com)
  - "Message" textarea for custom message
  - "Require deposit" toggle (should be a switch)

- [ ] **Action:** Make sure **"Require deposit"** toggle is **OFF**
- [ ] **Action:** Click **"Send E00XXX"** button

- [ ] **Expected:** Dialog closes, page refreshes

- [ ] **Visual Check:**
  - Status badge changes to **"SENT"**
  - Sent date appears
  - A public link or token section is visible

---

### 1.7 Customer Approves (Public Page)

- [ ] **Action:** Get the public estimate URL. It should be available on the estimate detail page. The URL format is: `http://localhost:5173/p/estimates/:id?token=...`

- [ ] **Action:** Open this URL in a **new incognito/private window** (to simulate the customer with no auth)

- [ ] **Visual Check — Public Estimate Page:**
  - Company header/logo displayed
  - Estimate number and date shown
  - Customer name displayed
  - All 3 line items listed with quantities, prices, line totals
  - Subtotal, tax, and total displayed correctly
  - Signature pad area visible
  - "Approve Estimate" and "Decline" buttons visible

- [ ] **Action:** Draw a signature on the signature pad (click and drag to draw)

- [ ] **Visual Check:** Signature appears in the pad, "Approve Estimate" button becomes enabled

- [ ] **Action:** Check the **"I agree to the terms and conditions"** checkbox (if present)
- [ ] **Action:** Click **"Approve Estimate"**

- [ ] **Expected:** Success state displays

- [ ] **Visual Check:**
  - Page shows **"Estimate Approved"** banner (green)
  - Approval date displayed
  - Signature is shown as captured

---

### 1.8 Verify Approval (Admin View)

- [ ] **Action:** Switch back to the admin browser window
- [ ] **Action:** Refresh the Estimate Detail page

- [ ] **Visual Check:**
  - Status badge shows **"APPROVED"** (green)
  - Signature timestamp displayed
  - **"Create Job"** button is now visible and enabled

- [ ] **Action:** Navigate to the Lead (via breadcrumb or Leads page)
- [ ] **Visual Check:** Lead status shows **"WON"** (green)

---

### 1.9 Create a Job

- [ ] **Action:** Navigate back to the Estimate Detail page
- [ ] **Action:** Click **"Create Job"** button

- [ ] **Expected:** Job is created, redirected to Job Detail page (`/jobs/:id`)

- [ ] **Visual Check on Job Detail:**
  - Status badge shows **"UNASSIGNED"**
  - Job number in format `J00XXX`
  - Customer name "John Anderson" displayed
  - Estimate link shown (clicking it goes to the estimate)
  - Service location address displayed
  - "Assign" button visible

- [ ] **Record the job number:** J_______

---

### 1.10 Assign the Job

- [ ] **Action:** Click **"Assign Job"** (or **"Assign Technician"**) button
- [ ] **Expected:** **"Assign Technician"** dialog opens

- [ ] **Fill the dialog:**
  - Technician: Select **"Mike Tech"** from dropdown
  - Leave "All Day" unchecked
  - Scheduled Start: Set to a date/time in the near future (e.g., tomorrow 9:00 AM)
  - Scheduled End: Set to 2 hours after start (e.g., tomorrow 11:00 AM)

- [ ] **Action:** Click **"Assign"**
- [ ] **Expected:** Dialog closes, page refreshes

- [ ] **Visual Check:**
  - Status badge changes to **"SCHEDULED"** (blue)
  - Assigned technician "Mike Tech" displayed
  - Scheduled date/time displayed

---

### 1.11 Verify on Schedule

- [ ] **Action:** Click **"Schedule"** in the left sidebar
- [ ] **Expected:** Schedule/Calendar page loads

- [ ] **Visual Check:**
  - The job you just scheduled appears on the calendar at the correct date/time
  - The job shows the customer name and/or job number
  - The correct technician is associated with the event

- [ ] **Action:** Click on the job event in the calendar
- [ ] **Expected:** A popup or detail view shows job information

**Scenario 1 Complete!** You have successfully tested the full standard flow from Lead to Scheduled Job.

---

## SCENARIO 2: Deposit Flow (CHECK Payment)

**Purpose:** Test the deposit workflow — sending with deposit required, customer selecting payment method, admin marking deposit received.

---

### 2.1 Create Lead Through Walkthrough

- [ ] Repeat steps 1.1 through 1.4 with a new customer:
  - Customer: `Maria Garcia`, `maria.garcia@test.com`, `5559876543`
  - Service Request: `Water heater replacement — 50 gallon tank`
  - Complete through walkthrough
- [ ] **Record lead number:** L_______

### 2.2 Create and Send Estimate WITH Deposit

- [ ] Create estimate with:
  - Line Item 1: `Water Heater (50 gal)`, Qty: 1, Price: `1,200.00`
  - Line Item 2: `Installation Labor`, Qty: 4, Price: `125.00` (4 hours)
  - Line Item 3: `Plumbing Materials`, Qty: 1, Price: `85.00`
- [ ] Save the estimate

- [ ] **Action:** Click **"Send"**
- [ ] In the Send dialog:
  - [ ] Toggle **"Require deposit"** to **ON**
  - [ ] **Visual Check:** Deposit amount appears (should show percentage and dollar amount, e.g., "50% = $XXX.XX")
  - [ ] **Visual Check:** Payment method checkboxes appear below
  - [ ] Check **"Check"** and **"Cash"** (leave Credit Card unchecked)
- [ ] Click **"Send"**

- [ ] **Visual Check after send:**
  - Status: **"SENT"**
  - **Deposit** tab appears on the estimate detail
  - [ ] Click Deposit tab — shows deposit status **"REQUESTED"**, amount, and allowed payment methods

### 2.3 Customer Selects CHECK on Public Page

- [ ] Open the public estimate URL in incognito
- [ ] **Visual Check:**
  - Estimate details displayed
  - Deposit amount and percentage shown
  - Payment method buttons visible: **"Pay by Check"** and **"Pay by Cash"**
  - NO credit card option (since you didn't enable it)
- [ ] Draw signature
- [ ] Check terms checkbox
- [ ] **Action:** Click **"Pay by Check"**

- [ ] **Expected:** Page transitions to **PENDING** state
- [ ] **Visual Check:**
  - Banner shows **"Deposit Pending"** (blue)
  - Shows "Check" as selected payment method
  - Shows deposit amount
  - Payment instructions displayed
  - **"Change Payment Method"** and **"Decline Estimate"** buttons visible

### 2.4 Admin Marks Deposit Received

- [ ] Back in admin view, refresh estimate detail
- [ ] **Visual Check:** Status shows **"PENDING"**, Deposit tab shows payment method "CHECK"
- [ ] **Action:** Click **"Mark Deposit Paid"** (or **"Mark Received"**)
- [ ] **Expected:** **MarkDepositReceivedDialog** opens

- [ ] **Fill the dialog:**
  - Received Date: today
  - Reference Number: `CHK-1234`
  - Notes: `Check received in office`
- [ ] Click **"Confirm"** (or **"Mark Received"**)

- [ ] **Visual Check:**
  - Estimate status changes to **"APPROVED"**
  - Deposit tab shows status **"PAID"**
  - Reference number and notes display
  - **"Create Job"** button is now visible

- [ ] Navigate to the lead — status should be **"WON"**

### 2.5 Complete the Flow

- [ ] Create job from estimate
- [ ] Assign to technician
- [ ] Verify on schedule

---

## SCENARIO 3: Declined Estimate → Duplicate → Re-approve

**Purpose:** Test the decline flow and the duplicate/re-send workflow.

---

### 3.1 Setup

- [ ] Create a new lead (customer: `Bob Wilson`, `bob.wilson@test.com`)
- [ ] Progress through walkthrough
- [ ] Create estimate (2-3 line items)
- [ ] Send estimate (no deposit)

### 3.2 Customer Declines

- [ ] Open public estimate URL in incognito
- [ ] **Action:** Click **"Decline"** button
- [ ] **Expected:** Confirmation dialog appears: "Are you sure you want to decline this estimate?"
- [ ] Click **"Yes, Decline"**

- [ ] **Visual Check:** Page shows **"Estimate Declined"** state (gray banner)

### 3.3 Verify Decline in Admin

- [ ] Back in admin, refresh estimate detail
- [ ] **Visual Check:** Status badge shows **"DECLINED"** (gray/red)
- [ ] Declined date appears

### 3.4 Duplicate the Estimate

- [ ] **Action:** Click **"Duplicate"** button (on the declined estimate)
- [ ] **Expected:** Redirected to a new estimate in **"DRAFT"** status

- [ ] **Visual Check:**
  - New estimate number (different from original)
  - Same line items as the original
  - Same totals

### 3.5 Edit, Send, and Approve the Duplicate

- [ ] **Action:** Click **"Edit"** — navigate to EstimateFormPage
- [ ] Change a price (e.g., add a 10% discount or adjust a line item price)
- [ ] **Visual Check:** Totals recalculate live
- [ ] Save

- [ ] Send the duplicate (no deposit)
- [ ] Approve via public page
- [ ] Create job → assign → verify on schedule

---

## SCENARIO 4: Cancellation Paths

**Purpose:** Test cancelling at every stage — estimate, lead, and job.

---

### 4.1 Cancel an Estimate

- [ ] Create a new lead → walkthrough → estimate → send (with deposit, CHECK+CASH)
- [ ] **Action:** On estimate detail, click **"Cancel"** (or use the dropdown menu)
- [ ] **Expected:** **CancelEstimateDialog** opens
- [ ] Enter reason: `Customer found a cheaper quote`
- [ ] Click **"Cancel Estimate"**

- [ ] **Visual Check:**
  - Status changes to **"CANCELLED"** (gray)
  - Cancelled reason displays
  - Deposit tab shows deposit status **"VOIDED"**

### 4.2 Mark a Lead as Lost

- [ ] Create a new lead → contact → schedule walkthrough
- [ ] **Action:** Click **"Mark Lost"**
- [ ] **Expected:** **MarkLostDialog** opens with title "Mark Lead as Lost"

- [ ] Enter reason: `Customer went with competitor`
- [ ] Click **"Mark Lost"** (red/destructive button)

- [ ] **Visual Check:**
  - Status changes to **"LOST"** (red/gray)
  - Lost reason displays
  - Walkthrough should show as auto-cancelled
  - Lost date appears

### 4.3 Cancel a Scheduled Job

- [ ] Use Scenario 1 flow to create a SCHEDULED job (or reuse existing)
- [ ] On Job Detail, click **"Cancel"** (may be in a dropdown/more menu)
- [ ] **Expected:** **CancelJobDialog** opens
- [ ] Enter reason: `Customer postponed indefinitely`
- [ ] Click **"Cancel Job"**

- [ ] **Visual Check:**
  - Status changes to **"CANCELLED"**
  - Cancellation reason displayed
  - Job no longer appears as active on the Schedule page

### 4.4 Unassign and Reassign a Job

- [ ] Create another SCHEDULED job (or use an existing one)
- [ ] Click **"Unassign"** (or similar action)
- [ ] **Visual Check:** Status returns to **"UNASSIGNED"**, scheduled dates cleared
- [ ] Click **"Assign"** again → assign to a different technician with new dates
- [ ] **Visual Check:** Status back to **"SCHEDULED"** with new tech and dates

---

## SCENARIO 5: Deposit Management (Waive & Refund)

**Purpose:** Test admin deposit management actions.

---

### 5.1 Waive a Deposit

- [ ] Create lead → estimate → send WITH deposit (CHECK, CASH)
- [ ] On Estimate Detail, navigate to the **Deposit** tab
- [ ] **Action:** Click **"Waive Deposit"**
- [ ] **Expected:** **WaiveDepositDialog** opens
- [ ] Select action: **"Waive and Approve"** (approves the estimate immediately)
- [ ] Click confirm

- [ ] **Visual Check:**
  - Estimate status: **"APPROVED"**
  - Deposit status: **"VOIDED"**
  - Lead status: **"WON"**
  - "Create Job" button is now available

### 5.2 Refund a Deposit

- [ ] Create another lead → estimate → send WITH deposit (CHECK)
- [ ] Approve via public page (select CHECK)
- [ ] Mark deposit received (admin)
- [ ] **DO NOT create a job**

- [ ] **Action:** Click **"Refund Deposit"** on Deposit tab
- [ ] **Expected:** **RefundDepositDialog** opens
- [ ] Select reason category from dropdown (e.g., "Customer Cancellation")
- [ ] Enter reason: `Customer changed their mind`
- [ ] Click confirm

- [ ] **Visual Check:**
  - Deposit status: **"REFUNDED"**
  - Estimate status: **"CANCELLED"**
  - Refund reason and category displayed

---

## SCENARIO 6: Urgent Job Flow

**Purpose:** Test the urgent/emergency job creation workflow (bypasses lead/estimate).

---

### 6.1 Create an Urgent Job

- [ ] Navigate to **Jobs** page
- [ ] Click **"New Urgent Job"** button
- [ ] **Expected:** Multi-step dialog opens

- [ ] **Step 1 — Customer Search:**
  - [ ] Type a customer name in the search field
  - [ ] **Visual Check:** Customer results appear as you type
  - [ ] Click on a customer to select them
  - [ ] **Visual Check:** Service locations appear for that customer

- [ ] **Step 2 — Select Location:**
  - [ ] Click on the desired service location
  - [ ] **Visual Check:** Location address displayed, "Primary" badge if applicable

- [ ] **Step 3 — Urgency Details:**
  - [ ] **Visual Check:** Selected customer/location shown at top with "Change selection" link
  - [ ] Fill "Urgency Reason": `Emergency water leak — kitchen flooding`
  - [ ] Fill "Scope Notes" (optional): `Customer reports water coming from under the sink. Priority call.`

- [ ] **Action:** Click **"Create Urgent Job"**
- [ ] **Expected:** Dialog closes, redirected to Job Detail page

- [ ] **Visual Check:**
  - **"Urgent"** badge visible (amber/red)
  - Status: **"UNASSIGNED"**
  - Customer and location displayed
  - Urgency reason displayed

### 6.2 Add Charges

- [ ] Navigate to **Work Items** tab
- [ ] **Action:** Click **"Add Charge"** (or **"+"** button)

- [ ] **Fill charge form:**
  - Description: `Emergency Plumbing — Pipe Repair`
  - Qty: `1`
  - Unit Price: `350.00`

- [ ] **Visual Check:** Line total shows `$350.00`

- [ ] Add another charge:
  - Description: `Replacement Parts (P-trap, fittings)`
  - Qty: `3`
  - Unit Price: `25.00`

- [ ] **Visual Check:** Line total shows `$75.00`, overall total updates

- [ ] **Action:** Edit the first charge — change qty to `2`
- [ ] **Visual Check:** Line total recalculates to `$700.00`

- [ ] **Action:** Delete the second charge
- [ ] **Visual Check:** Charge removed, total updates

### 6.3 Assign, Start, and Complete

- [ ] Assign to technician with scheduled dates → **"SCHEDULED"**
- [ ] Click **"Start Job"** → **"IN_PROGRESS"**
  - [ ] **Visual Check:** Started date/time appears
- [ ] Click **"Complete Job"** (or **"Mark Complete"**)
  - [ ] **Expected:** **CompleteJobDialog** opens
  - [ ] Enter notes: `Repaired broken P-trap under kitchen sink. Replaced corroded fittings. Tested — no leaks.`
  - [ ] Click confirm
  - [ ] **Visual Check:** Status changes to **"COMPLETED"**, completion notes and date displayed

---

## SCENARIO 7: Schedule Page Deep Test

**Purpose:** Test all schedule/calendar interactions.

---

### 7.1 View Switching

- [ ] Navigate to **Schedule** page
- [ ] **Visual Check:** Calendar loads with events (jobs/walkthroughs from previous scenarios)
- [ ] Click **"Day"** view → calendar shows single day
- [ ] Click **"Week"** view → calendar shows 7-day week
- [ ] Click **"Month"** view → calendar shows monthly grid
- [ ] Click **"By Technician"** (or grouped view toggle) → jobs grouped by technician columns

### 7.2 Navigation

- [ ] Click **"Today"** button → calendar jumps to current date
- [ ] Click forward arrow → moves to next period
- [ ] Click back arrow → moves to previous period
- [ ] **Visual Check:** Date header updates correctly

### 7.3 Event Interaction

- [ ] Click on a job event → popup/detail shows job info
- [ ] **Visual Check:** Popup shows job number, customer, status, technician, time

### 7.4 Drag & Drop (Week/Day View)

- [ ] Find a scheduled job on the calendar
- [ ] **Action:** Drag it to a different time slot
- [ ] **Expected:** **RescheduleConfirmDialog** appears showing old and new times
- [ ] Click confirm → job moves to new time
- [ ] **Visual Check:** Job appears at the new time

### 7.5 Search in Schedule

- [ ] Use the search feature on the schedule page
- [ ] Search for a job number or customer name
- [ ] **Visual Check:** Results filter to matching jobs/walkthroughs

---

## SCENARIO 8: Public Estimate Page — All Visual States

**Purpose:** Verify every state of the public estimate page renders correctly.

For each state, open the public URL and verify the display:

### 8.1 SENT (No Deposit)
- [ ] Send an estimate without deposit
- [ ] Open public URL
- [ ] **Visual Check:** Signature pad visible, "Approve Estimate" + "Decline" buttons, line items and totals shown

### 8.2 SENT (With Deposit)
- [ ] Send an estimate with deposit (CHECK + CASH + CARD options)
- [ ] Open public URL
- [ ] **Visual Check:** Signature pad, after signing → payment method buttons appear ("Pay by Check", "Pay by Cash", "Pay with Credit Card")

### 8.3 PENDING (Awaiting Deposit)
- [ ] Approve with CHECK on public page
- [ ] Refresh the page
- [ ] **Visual Check:** "Deposit Pending" banner (blue), deposit amount, payment method, instructions, "Change Payment Method" + "Decline Estimate" buttons

### 8.4 APPROVED
- [ ] Use an approved estimate's public URL
- [ ] **Visual Check:** "Estimate Approved" banner (green), signature displayed, approval date

### 8.5 DECLINED
- [ ] Use a declined estimate's public URL
- [ ] **Visual Check:** "Estimate Declined" banner (gray), declined date

### 8.6 CANCELLED
- [ ] Use a cancelled estimate's public URL
- [ ] **Visual Check:** "Estimate Cancelled" banner (gray), message about contacting the company

---

## TARGETED CHECKS

These are specific features to test outside the main scenarios.

### List Page Features

#### Customers Page
- [ ] Navigate to Customers → verify KPI strip loads
- [ ] Search for a customer name → table filters
- [ ] Apply a filter (e.g., Source = "Google") → verify table updates
- [ ] Clear filter → table shows all
- [ ] Click column header to sort → verify sort order changes
- [ ] Click **"Export"** → CSV file downloads
- [ ] Change page size (e.g., 25 → 50) → table shows more rows

#### Leads Page
- [ ] Apply Status filter (e.g., "Contacted") → only contacted leads shown
- [ ] Apply Assigned To filter → verify filtering
- [ ] Active filter chips appear above the table
- [ ] Click "X" on a filter chip → that filter removed
- [ ] Click "Clear all" → all filters removed

#### Estimates Page
- [ ] Apply Status filter
- [ ] Apply Created By filter
- [ ] Change Date Range (e.g., "Last 30 days") → table filters by date
- [ ] **Visual Check:** KPI strip values change when filters are applied

#### Jobs Page
- [ ] Filter by Status
- [ ] Filter by Type (Standard vs Urgent)
- [ ] Filter by Assigned To
- [ ] **Visual Check:** "Urgent" badge appears on urgent job rows

### Navigation & Cross-Linking

- [ ] On Lead Detail: click customer name → navigates to Customer Detail page
- [ ] On Estimate Detail: click lead reference → navigates to Lead Detail page
- [ ] On Job Detail: click estimate link → navigates to Estimate Detail page
- [ ] On Customer Detail: click a lead in the Leads tab → navigates to Lead Detail page
- [ ] Breadcrumbs: click a parent link → navigates back correctly
- [ ] Browser back button works correctly after navigation

### Global Search (Ctrl+K or Cmd+K)

- [ ] Press **Ctrl+K** → search dropdown opens
- [ ] Type a customer name → results appear under "Customers" section
- [ ] Type a lead number (e.g., `L00001`) → result appears under "Leads"
- [ ] Type an estimate number → result appears under "Estimates"
- [ ] Type a job number → result appears under "Jobs"
- [ ] Click a result → navigates to the correct detail page
- [ ] Press Escape → search closes

### Form Validation

- [ ] **Lead form:** Submit with empty Service Request → error message shown
- [ ] **Estimate form:** Submit with no line items → error message shown
- [ ] **Cancel Job dialog:** Submit with empty reason → error or button disabled
- [ ] **Complete Job dialog:** Submit with empty notes → error or button disabled
- [ ] **Mark Lost dialog:** Submit with empty reason → error or button disabled

### Error States

- [ ] Navigate to a non-existent URL (e.g., `/leads/00000000-0000-0000-0000-000000000000`) → "Not Found" or 404 display
- [ ] Log out → try to access `/leads` → redirected to `/login`

### Detail Page Tabs

#### Customer Detail
- [ ] **Overview** tab: financial summary data displayed
- [ ] **Leads** tab: list of customer's leads
- [ ] **Jobs** tab: list of customer's jobs
- [ ] **Locations** tab: service locations listed, "Add Location" button works
- [ ] **Notes** tab: add a note, verify it appears

#### Lead Detail
- [ ] All sections load without errors
- [ ] Estimates section shows linked estimates
- [ ] Notes: add a note → appears in list

#### Estimate Detail
- [ ] **Line Items** tab: all items displayed with correct totals
- [ ] **Details** tab: customer/lead info displayed
- [ ] **Deposit** tab (when applicable): deposit status, method, amount
- [ ] **Notes** tab: add a note → appears in list

#### Job Detail
- [ ] **Work Items** tab: line items (standard) or charges (urgent)
- [ ] **Details** tab: job info, customer, location
- [ ] **Notes** tab: add a note → appears in list
- [ ] **Timeline** tab: events listed (Created, Assigned, etc.)

---

## ISSUES LOG

Record any issues found during testing:

| # | Scenario | Step | Page/Component | Issue Description | Severity | Screenshot |
|---|----------|------|----------------|-------------------|----------|------------|
| 1 | | | | | | |
| 2 | | | | | | |
| 3 | | | | | | |
| 4 | | | | | | |
| 5 | | | | | | |
| 6 | | | | | | |
| 7 | | | | | | |
| 8 | | | | | | |
| 9 | | | | | | |
| 10 | | | | | | |

**Severity Levels:**
- **Critical:** Feature doesn't work at all, blocks workflow
- **High:** Feature partially works but has significant issues
- **Medium:** Cosmetic or minor functional issues
- **Low:** Minor visual or text issues

---

## COMPLETION SIGN-OFF

| Section | Tester | Date | Pass/Fail | Notes |
|---------|--------|------|-----------|-------|
| Scenario 1: Standard Flow | | | | |
| Scenario 2: Deposit Flow | | | | |
| Scenario 3: Decline + Duplicate | | | | |
| Scenario 4: Cancellation Paths | | | | |
| Scenario 5: Deposit Management | | | | |
| Scenario 6: Urgent Job Flow | | | | |
| Scenario 7: Schedule Page | | | | |
| Scenario 8: Public Page States | | | | |
| Targeted: List Pages | | | | |
| Targeted: Navigation | | | | |
| Targeted: Global Search | | | | |
| Targeted: Form Validation | | | | |
| Targeted: Error States | | | | |
| Targeted: Detail Tabs | | | | |
