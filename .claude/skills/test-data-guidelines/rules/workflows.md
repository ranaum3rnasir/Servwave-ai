# Workflow Test Data Reference

Complete end-to-end data chains with ALL required fields and timestamps at each step. Use these as templates when building workflow/E2E tests.

## 1. Standard Flow (Lead → Payment)

16-step reference. All timestamps anchored to `baseDate` (e.g., `2026-02-10T09:00:00Z`).

### Step 1: Create Customer (by SALES or ADMIN)
```
Persona: Residential Homeowner
{ first_name: "Sarah", last_name: "Chen", email: "sarah.chen@gmail.com",
  phone: "5129876543", company_name: null, allow_billing: false,
  tax_exempt: false, payment_type: null }
+ ServiceLocation { address_line1: "4521 Cedar Ridge Dr", city: "Austin",
  state: "TX", zip: "78749", is_primary: true }
```

### Step 2: Create Lead (by SALES, T+0)
```
Actor: Jennifer Park (SALES)
{ customer_id, service_request: "AC unit not cooling — thermostat reads 78°F but house is 86°F",
  assigned_to: sales_user_id, walkthrough_needed: true }
Status: NEW
Timestamp: baseDate
```

### Step 3: Contact Lead (by SALES, T+4h)
```
Actor: Jennifer Park (SALES)
contacted_at: baseDate + 4 hours
contacted_note: "Spoke with homeowner, confirmed AC issue started 3 days ago. Unit runs but blows warm air. Available for walkthrough Thursday afternoon."
Status: NEW → CONTACTED
```

### Step 4: Schedule Walkthrough (by SALES, T+1d)
```
Actor: Jennifer Park (SALES) schedules for Carlos Mendez (TECHNICIAN)
walkthrough_scheduled_at: baseDate + 3 days + 14 hours (Thursday 2pm)
walkthrough_assigned_to: technician_id (Carlos Mendez)
walkthrough_duration_minutes: 60
Status: CONTACTED → WALKTHROUGH_SCHEDULED
```

### Step 5: Complete Walkthrough (by TECHNICIAN, T+3d)
```
Actor: Carlos Mendez (TECHNICIAN)
walkthrough_completed_at: baseDate + 3 days + 15 hours (Thursday 3pm)
walkthrough_notes: "Unit is 15 years old, Trane XR15 3-ton. Compressor cycling every 3 minutes. Refrigerant likely low — possible slow leak at service valve. Ductwork in good condition. Recommend coil replacement + recharge."
Status: WALKTHROUGH_SCHEDULED → WALKTHROUGH_COMPLETED
```

### Step 6: Create Estimate (by SALES, T+4d)
```
Actor: Jennifer Park (SALES)
created_by: sales_user_id
line_items: [
  { seq: 1, description: "Replace evaporator coil — Trane XR15 compatible", qty: 1, unit_price: 1200.00, is_taxable: true },
  { seq: 2, description: "R-410A refrigerant recharge (3 lbs)", qty: 3, unit_price: 85.00, is_taxable: true },
  { seq: 3, description: "Labor — coil replacement and system test", qty: 4, unit_price: 125.00, is_taxable: true }
]
tax_rate: 0.0825
subtotal: 1955.00 (1200 + 255 + 500)
tax_amount: 161.29 (1955 × 0.0825)
total_amount: 2116.29
Status: DRAFT
Timestamp: baseDate + 4 days + 10 hours
```

### Step 7: Send Estimate (by SALES, T+4d+2h)
```
Actor: Jennifer Park (SALES)
sent_at: baseDate + 4 days + 12 hours
public_token: auto-generated
valid_until: sent_at + 30 days
EstimateSendConfig: { deposit_required: true, deposit_percentage: 50.00,
  deposit_amount: 1058.15, payment_methods: ["CARD", "CHECK"] }
Deposit created: { status: REQUESTED, amount: 1058.15, deposit_percentage: 50.00 }
Status: DRAFT → SENT
Lead status: → ESTIMATED (auto-transition)
```

### Step 8: Customer Approves (PUBLIC, T+6d)
```
Actor: Customer (public, no auth)
approved_at: baseDate + 6 days + 11 hours
signature_data: "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
signature_ip: "73.162.45.201"
signature_at: same as approved_at
Status: SENT → APPROVED
Lead status: → WON (auto-transition)
```

### Step 9: Deposit Paid (T+6d, same session for CARD)
```
Option A — Stripe (CARD):
  paid_at: baseDate + 6 days + 11 hours + 5 min
  payment_method: "CARD"
  stripe_checkout_session_id: "cs_test_" + unique
  stripe_payment_intent_id: "pi_test_" + unique
  Deposit status: REQUESTED → PAID

Option B — Non-Stripe (CHECK):
  Actor: Amanda Foster (DISPATCHER) or Marcus Rivera (ADMIN)
  paid_at: baseDate + 8 days
  payment_method: "CHECK"
  marked_received_by: dispatcher_user_id
  marked_received_at: baseDate + 8 days
  reference_number: "1247"
  Deposit status: REQUESTED → PAID
```

### Step 10: Create Job (by DISPATCHER, T+7d)
```
Actor: Amanda Foster (DISPATCHER)
{ customer_id, service_location_id, estimate_id, is_urgent: false }
Status: UNASSIGNED
Timestamp: baseDate + 7 days + 9 hours
```

### Step 11: Assign Job (by DISPATCHER, T+7d)
```
Actor: Amanda Foster (DISPATCHER)
assigned_to: technician_id (Carlos Mendez)
scheduled_start: baseDate + 10 days + 9 hours (Monday 9am)
scheduled_end: baseDate + 10 days + 13 hours (Monday 1pm)
Status: UNASSIGNED → SCHEDULED
```

### Step 12: Start Job (by TECHNICIAN, T+10d)
```
Actor: Carlos Mendez (TECHNICIAN)
started_at: baseDate + 10 days + 9 hours + 15 min
Status: SCHEDULED → IN_PROGRESS
```

### Step 13: Complete Job (by TECHNICIAN, T+10d)
```
Actor: Carlos Mendez (TECHNICIAN)
completed_at: baseDate + 10 days + 14 hours + 30 min
completion_notes: "Replaced evaporator coil with Trane-compatible unit. Recharged system with 3 lbs R-410A. Tested cooling output — supply/return delta now 18°F. Thermostat reading accurately. System running normally. Recommended annual maintenance."
Status: IN_PROGRESS → COMPLETED
```

### Step 14: Create Invoice (by ADMIN, T+11d)
```
Actor: Marcus Rivera (ADMIN)
subtotal: 1955.00 (from estimate line items)
discount_amount: 0
tax_rate: 0.0825
tax_amount: 161.29
total_amount: 2116.29
deposit_credit: 1058.15 (from paid deposit)
amount_due: 1058.14 (total - deposit_credit)
Status: DRAFT
Timestamp: baseDate + 11 days + 10 hours
```

### Step 15: Send Invoice (by ADMIN, T+11d+1h)
```
Actor: Marcus Rivera (ADMIN)
sent_at: baseDate + 11 days + 11 hours
public_token: auto-generated
due_date: sent_at (COD — residential, no payment_type)
Status: DRAFT → SENT
```

### Step 16: Record Payment (T+11d or later)
```
Option A — On-site (by TECHNICIAN):
  Actor: Carlos Mendez (TECHNICIAN)
  Payment: { amount: 1058.14, method: "CARD", paid_at: baseDate + 11 days + 15 hours,
    collected_by: technician_id, stripe_payment_intent_id: "pi_test_" + unique }
  Status: SENT → PAID, paid_at set

Option B — Office (by ADMIN):
  Actor: Marcus Rivera (ADMIN)
  Payment: { amount: 1058.14, method: "CHECK", paid_at: baseDate + 15 days,
    collected_by: admin_id, reference_number: "4892" }
  Status: SENT → PAID, paid_at set
```

---

## 2. Urgent Flow (No Estimate)

Shorter chain. Typical scenario: emergency call, tech dispatched same day.

### Steps
```
1. Create Customer — Persona D: Landlord
   Actor: Marcus Rivera (ADMIN)

2. Create Lead (T+0)
   Actor: Marcus Rivera (ADMIN)
   service_request: "Tenant says pipe burst in basement — water actively leaking"
   walkthrough_needed: false
   Status: NEW

3. Contact Lead (T+30min)
   Actor: Amanda Foster (DISPATCHER)
   contacted_note: "Confirmed with tenant — water coming from ceiling in basement. Shutoff valve inaccessible."
   Status: CONTACTED

4. Create Urgent Job (T+1h)
   Actor: Amanda Foster (DISPATCHER)
   { customer_id, service_location_id, is_urgent: true,
     urgency_reason: "Active water leak in occupied rental — tenant cannot access shutoff" }
   Status: UNASSIGNED

5. Assign + Schedule (T+1h)
   Actor: Amanda Foster (DISPATCHER)
   assigned_to: Tyler Brooks (TECHNICIAN)
   scheduled_start: T+2h, scheduled_end: T+5h
   Status: SCHEDULED

6. Start Job (T+2h15min)
   Actor: Tyler Brooks (TECHNICIAN)
   Status: IN_PROGRESS

7. Add Charges (during job)
   Actor: Tyler Brooks (TECHNICIAN)
   charges: [
     { seq: 1, description: "Emergency service call", qty: 1, unit_price: 150.00, is_taxable: true },
     { seq: 2, description: "Replace burst copper pipe section (3 ft)", qty: 1, unit_price: 285.00, is_taxable: true },
     { seq: 3, description: "Water cleanup and damage assessment", qty: 1, unit_price: 175.00, is_taxable: true }
   ]

8. Complete Job (T+5h)
   Actor: Tyler Brooks (TECHNICIAN)
   completion_notes: "Located burst pipe at basement ceiling junction. Cut out damaged 3ft section, replaced with copper. Tested — no leaks under pressure. Cleaned standing water. Advised tenant to run dehumidifier for 48 hours. Recommended plumber inspect for additional corrosion."
   Status: COMPLETED

9. Create Invoice (T+5h30min)
   Actor: Marcus Rivera (ADMIN)
   subtotal: 610.00, tax_rate: 0.0825, tax_amount: 50.33
   total_amount: 660.33, deposit_credit: 0, amount_due: 660.33
   Status: DRAFT

10. Send Invoice (T+6h)
    Actor: Marcus Rivera (ADMIN)
    Status: SENT, due_date: same day (COD)

11. Record Payment (T+1d)
    Actor: Marcus Rivera (ADMIN)
    Payment: { amount: 660.33, method: "BANK_TRANSFER", paid_at: T+1 day,
      reference_number: "ACH-9921847" }
    Status: PAID
```

---

## 3. Walkthrough Cancel + Reschedule Flow

```
1. Lead NEW → CONTACTED (T+4h)
2. Schedule walkthrough for Thursday (T+1d)
   walkthrough_assigned_to: Raj Patel (TECHNICIAN)
   Status: WALKTHROUGH_SCHEDULED

3. Cancel walkthrough (T+2d)
   Actor: Amanda Foster (DISPATCHER)
   walkthrough_cancelled_at: T+2d
   walkthrough_cancelled_reason: "Tech called in sick — rescheduling for Monday"
   walkthrough_cancelled_by: dispatcher_id
   Status: WALKTHROUGH_SCHEDULED → CONTACTED (reverts)
   Note: Original walkthrough_scheduled_at and walkthrough_assigned_to remain as history

4. Reschedule walkthrough for Monday (T+2d+1h)
   walkthrough_scheduled_at: T+5d + 10h (Monday 10am)
   walkthrough_assigned_to: Carlos Mendez (TECHNICIAN) — different tech
   Status: CONTACTED → WALKTHROUGH_SCHEDULED

5. Complete walkthrough (T+5d)
   Status: WALKTHROUGH_COMPLETED
```

---

## 4. Deposit Refund Flow

```
1. Standard flow through Step 9 (deposit PAID)
2. Customer requests cancellation after deposit

3. Refund deposit (T+8d)
   Actor: Marcus Rivera (ADMIN)
   refunded_at: T+8d
   refunded_by: admin_id
   refund_reason: "Customer found cheaper contractor and cancelled"
   refund_reason_category: "CUSTOMER_REQUEST"
   total_refunded: full deposit amount
   If Stripe: stripe_refund_id: "re_test_" + unique
   Deposit status: PAID → REFUNDED

4. Estimate remains APPROVED (not auto-cancelled)
5. Job may be cancelled separately if created
```

---

## 5. Multi-Estimate Flow

One lead, multiple estimates. Only one can be APPROVED.

```
1. Lead → CONTACTED → WALKTHROUGH_COMPLETED (standard)

2. Create Estimate A (by SALES, T+4d)
   line_items: [{ "Full system replacement — Trane XL16i", qty: 1, price: 8500 }]
   total: ~9200 (with tax)
   Status: DRAFT → SENT

3. Customer declines Estimate A (T+7d)
   declined_at: T+7d
   Status: DECLINED
   Lead remains ESTIMATED (not reverted)

4. Create Estimate B (by SALES, T+8d)
   line_items: [{ "Repair existing unit — coil + recharge", qty: 1, price: 1800 }]
   total: ~1950 (with tax)
   Status: DRAFT → SENT

5. Customer approves Estimate B (T+10d)
   signature_data, signature_at, signature_ip all set
   Status: APPROVED
   Lead status: → WON
   
6. Continue standard flow from Step 9 (deposit → job → invoice)
```

---

## 6. Partial Payment Flow

Invoice paid across multiple installments.

```
1. Standard flow through Step 15 (invoice SENT)
   amount_due: 1058.14

2. Payment 1 — On-site partial (T+11d)
   Actor: Carlos Mendez (TECHNICIAN)
   Payment: { amount: 500.00, method: "CASH", paid_at: T+11d + 15h, collected_by: tech_id }
   Status: SENT → PARTIAL
   amount_due: 558.14

3. Payment 2 — Mailed check (T+20d)
   Actor: Marcus Rivera (ADMIN)
   Payment: { amount: 558.14, method: "CHECK", paid_at: T+20d, collected_by: admin_id,
     reference_number: "3847" }
   Status: PARTIAL → PAID
   amount_due: 0.00
   paid_at: T+20d
```

---

## 7. Estimate Expiration Flow

```
1. Standard flow through Step 7 (estimate SENT with valid_until)
2. Customer does not respond
3. valid_until date passes
4. Cron job runs (daily at midnight EST)
   - Estimate status: SENT → EXPIRED
   - expired_at set
   - If deposit exists (REQUESTED): deposit → VOIDED
   - Lead status reverts to ESTIMATED (stays, does not revert)
   - Timeline event created
```

---

## Key Rules for All Workflows

1. **Every action has an actor** — document which user/role performed each step
2. **Timestamps are sequential** — follow the gap table in global-rules.md
3. **Status transitions are explicit** — show the before → after
4. **Amounts are consistent** — math must add up at every step
5. **Personas are coherent** — customer fields match their persona type
6. **Rotate roles** — don't always use the same SALES or TECHNICIAN across tests
