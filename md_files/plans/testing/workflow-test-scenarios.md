# Comprehensive Workflow Test Scenarios

## Goal
Test every possible path from Lead creation through Job Scheduled, including all cancellation, decline, expiration, deposit, and edge-case paths. Using Admin/Dispatcher roles only. Automated via Playwright E2E.

## Scope
- Lead → Estimate → Deposit → Job → Scheduled
- Every branching point, cancellation path, and error condition
- Standard flow + Urgent flow
- Stripe webhook simulation (signature verification bypassed in test env)

---

## SECTION 1: LEAD LIFECYCLE

### 1.1 Lead Creation
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| L-01 | Create lead with existing customer | Lead created, status=NEW, lead_number generated |
| L-02 | Create lead with new inline customer | Customer + primary location created, lead=NEW |
| L-03 | Create lead with service address fields | Lead created with service_address_* populated |
| L-04a | Create lead with BOTH customer_id AND new_customer | 400 validation error — must provide exactly one |
| L-04b | Create lead with NEITHER customer_id nor new_customer | 400 validation error — must provide exactly one |
| L-04c | Create lead with non-existent customer_id | 400 — "Customer not found" |

### 1.2 Lead Update (PATCH)
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| L-04 | Update lead fields (service_request, notes, job_type, job_source) | Fields updated successfully |
| L-05 | Update lead — set walkthrough_needed=false while WALKTHROUGH_SCHEDULED | 400 error — must cancel walkthrough first |

### 1.3 Lead Contact
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| L-06 | Contact a NEW lead | Status: NEW → CONTACTED, contacted_at set, timeline event |
| L-07 | Contact a non-NEW lead (e.g. CONTACTED) | 400 error — only NEW can be contacted |
| L-08 | Contact an ESTIMATED lead | 400 error — only NEW can be contacted |

### 1.4 Walkthrough Scheduling
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| L-09 | Schedule walkthrough on CONTACTED lead | Status: CONTACTED → WALKTHROUGH_SCHEDULED, email sent |
| L-10 | Schedule walkthrough on WALKTHROUGH_COMPLETED lead (reschedule) | Status: → WALKTHROUGH_SCHEDULED, timeline=RESCHEDULED |
| L-11 | Reschedule walkthrough on WALKTHROUGH_SCHEDULED lead | Status stays WALKTHROUGH_SCHEDULED, dates updated, email sent |
| L-12 | Schedule walkthrough with conflict (no force) | 409 with conflict details |
| L-13 | Schedule walkthrough with conflict + force=true | Conflict ignored, walkthrough scheduled |
| L-14 | Schedule walkthrough on NEW lead | 400 error — must be CONTACTED first |
| L-15 | Schedule walkthrough on ESTIMATED lead | 400 error — not in allowed statuses (CONTACTED/WALKTHROUGH_COMPLETED/WALKTHROUGH_SCHEDULED) |
| L-15a | Schedule walkthrough on WON lead | 400 error — not in allowed statuses |
| L-15b | Schedule walkthrough on LOST lead | 400 error — not in allowed statuses |
| L-15c | Schedule walkthrough on CANCELLED lead | 400 error — not in allowed statuses |
| L-15d | Schedule walkthrough with invalid performer (user not found) | 400 error — performer must exist and be active |
| L-15e | Schedule walkthrough with performer wrong role (ADMIN/DISPATCHER) | 400 error — performer must be SALES or TECHNICIAN |

### 1.5 Walkthrough Completion
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| L-16 | Complete walkthrough on WALKTHROUGH_SCHEDULED lead | Status: → WALKTHROUGH_COMPLETED, completed_at set, email sent |
| L-17 | Complete walkthrough on non-WALKTHROUGH_SCHEDULED lead | 400 error |

### 1.6 Walkthrough Cancellation
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| L-18 | Cancel walkthrough on WALKTHROUGH_SCHEDULED lead | Status: → CONTACTED, walkthrough fields cleared, timeline event, email sent |
| L-19 | Cancel walkthrough on non-WALKTHROUGH_SCHEDULED lead | 400 error |

### 1.7 Walkthrough Notes & Duration Update
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| L-20 | Update walkthrough notes on any lead | walkthrough_notes updated |
| L-21 | Update walkthrough duration (valid: 15-480 min) | walkthrough_duration_minutes updated |
| L-22 | Update walkthrough duration out of range (<15 or >480) | 400 validation error |

### 1.8 Lead Assignment
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| L-23 | Assign lead to active SALES user | assigned_to updated |
| L-24 | Assign lead to inactive user | 400 error |
| L-25 | Assign lead to non-SALES role user | 400 error |
| L-26 | Reassign lead where walkthrough_assigned_to matches old owner | walkthrough_assigned_to auto-updates to new assignee |

### 1.9 Lead Termination — Mark Lost
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| L-27 | Mark NEW lead as lost | Status: → LOST, lost_reason set, timeline event |
| L-28 | Mark CONTACTED lead as lost | Status: → LOST |
| L-29 | Mark WALKTHROUGH_SCHEDULED lead as lost | Status: → LOST, walkthrough auto-cancelled, timeline reflects both |
| L-30 | Mark WALKTHROUGH_COMPLETED lead as lost | Status: → LOST |
| L-31 | Mark ESTIMATED lead as lost | Status: → LOST |
| L-32 | Mark WON lead as lost | 400 error — terminal state |
| L-33 | Mark LOST lead as lost | 400 error — already terminal |
| L-34 | Mark CANCELLED lead as lost | 400 error — terminal state |

### 1.10 Lead Termination — Cancel
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| L-35 | Cancel NEW lead | Status: → CANCELLED, reason set |
| L-36 | Cancel CONTACTED lead | Status: → CANCELLED |
| L-37 | Cancel WALKTHROUGH_SCHEDULED lead | Status: → CANCELLED, walkthrough auto-cancelled |
| L-38 | Cancel WALKTHROUGH_COMPLETED lead | Status: → CANCELLED |
| L-39 | Cancel ESTIMATED lead | Status: → CANCELLED |
| L-40 | Cancel WON/LOST/CANCELLED lead | 400 error — terminal state |

### 1.11 Lead Notes
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| L-41 | Add note to lead | Note created with creator info |
| L-42 | List notes for lead | Notes returned newest-first |

---

## SECTION 2: ESTIMATE LIFECYCLE

### 2.1 Estimate Creation
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| E-01 | Create estimate for CONTACTED lead with line items | Estimate created, status=DRAFT, estimate_number generated, lead unchanged |
| E-02 | Create estimate for WALKTHROUGH_COMPLETED lead | Estimate created, DRAFT |
| E-03 | Create estimate for NEW lead (before contact) | Estimate created, DRAFT (not terminal — should work) |
| E-04 | Create estimate for WALKTHROUGH_SCHEDULED lead | Estimate created, DRAFT (not terminal — should work) |
| E-05 | Create estimate for ESTIMATED lead (second estimate) | Estimate created, DRAFT |
| E-06 | Create estimate for WON lead | 400 error — terminal lead status |
| E-07 | Create estimate for LOST lead | 400 error — terminal lead status |
| E-08 | Create estimate for CANCELLED lead | 400 error — terminal lead status |
| E-09 | Create estimate with no line items | 400 validation error |

### 2.2 Estimate Edit
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| E-10 | Update DRAFT estimate (change line items, tax, notes) | Totals recalculated, line items replaced |
| E-11 | Update SENT estimate | 400 error — only DRAFT editable |
| E-12 | Update APPROVED estimate | 400 error |
| E-13 | Update PENDING estimate | 400 error — only DRAFT editable |
| E-14 | Update CANCELLED estimate | 400 error |

### 2.3 Estimate Delete
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| E-15 | Delete DRAFT estimate | Estimate + line items removed |
| E-16 | Delete SENT estimate | 400 error — only DRAFT deletable |
| E-17 | Delete PENDING estimate | 400 error |
| E-18 | Delete APPROVED estimate | 400 error |
| E-19 | Delete CANCELLED estimate | 400 error |

### 2.4 Estimate Duplicate
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| E-20 | Duplicate DRAFT estimate | New DRAFT with same line items, new number |
| E-21 | Duplicate SENT estimate | New DRAFT created |
| E-22 | Duplicate APPROVED estimate | New DRAFT created from approved |
| E-23 | Duplicate DECLINED estimate | New DRAFT created |
| E-24 | Duplicate CANCELLED estimate | New DRAFT created |

### 2.5 Estimate Notes
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| E-25 | Add note to estimate | Note created with entity_type=ESTIMATE |
| E-26 | List notes for estimate | Notes returned newest-first |

---

## SECTION 3: ESTIMATE SEND (DRAFT → SENT)

### 3.1 Send Without Deposit
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| S-01 | Send estimate, deposit_required=false | Status: DRAFT → SENT, public_token generated, valid_until set, no Deposit record, email sent |
| S-02 | Send estimate for CONTACTED lead (no deposit) | Lead auto-transitions: CONTACTED → ESTIMATED |
| S-03 | Send estimate for WALKTHROUGH_COMPLETED lead (no deposit) | Lead auto-transitions: WALKTHROUGH_COMPLETED → ESTIMATED |
| S-04 | Send second estimate for already-ESTIMATED lead | Lead stays ESTIMATED (no double transition) |
| S-04a | Send estimate for NEW lead (created before contact) | Lead stays NEW (only CONTACTED/WALKTHROUGH_COMPLETED auto-transition) |
| S-04b | Send estimate for WALKTHROUGH_SCHEDULED lead | Lead stays WALKTHROUGH_SCHEDULED (not in auto-transition list) |

### 3.2 Send With Deposit
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| S-05 | Send estimate, deposit_required=true, methods=[CARD, CHECK, CASH] | DRAFT → SENT, Deposit created (REQUESTED), deposit_amount calculated, send_config saved, deposit email sent |
| S-06 | Send estimate, deposit_required=true, methods=[BANK_TRANSFER] | Same as above, single payment method |
| S-07 | Send estimate, deposit_required=true, methods=[] | 400 validation error — at least 1 method required |

### 3.3 Send Guards
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| S-08 | Send estimate while lead has WALKTHROUGH_SCHEDULED | 400 error — "Cannot send estimate while a walkthrough is scheduled" |
| S-09 | Resend already-SENT estimate | Status stays SENT, message_body updated, resent email sent |
| S-10 | Resend SENT estimate that already has deposit | Deposit unchanged, message updated, resend email |
| S-11 | Send non-DRAFT estimate (APPROVED) | 400 error |

---

## SECTION 4: PUBLIC APPROVAL (No Deposit)

| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| P-01 | Customer approves SENT estimate (no deposit), valid signature | SENT → APPROVED, lead → WON, signature captured, emails sent |
| P-02 | Customer approves with missing signature | 400 error — validation |
| P-02a | Customer approves with invalid signature format (not data:image/) | 400 error — "Invalid signature format" |
| P-03 | Customer approves expired estimate | 400 error — "Estimate has expired" |
| P-04 | Customer approves with wrong token | 404 error |
| P-05 | Customer approves already-APPROVED estimate | 400 error — "Cannot approve a APPROVED estimate" |

---

## SECTION 5: PUBLIC APPROVAL WITH DEPOSIT (Non-Stripe Methods)

### 5.1 Customer Selects Non-Stripe Method → PENDING
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| D-01 | Customer approves with CHECK method, valid signature | SENT → PENDING, deposit.payment_method=CHECK, deposit.payment_method_selected_at set, email to creator |
| D-02 | Customer approves with CASH method | SENT → PENDING, deposit.payment_method=CASH |
| D-03 | Customer approves with BANK_TRANSFER method | SENT → PENDING, deposit.payment_method=BANK_TRANSFER |
| D-04 | Customer approves with method NOT in send_config.payment_methods | 400 error — "Payment method not available" |
| D-05 | Customer approves deposit estimate without specifying payment method | 400 error — "Payment method is required" |

### 5.2 Change Payment Method (From PENDING)
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| D-06 | Change from CHECK to CASH (both non-Stripe) | Deposit.payment_method updated, stays PENDING |
| D-07 | Change from CHECK to CARD (Stripe) | Checkout session created, estimate → SENT (for webhook), return checkout URL |
| D-08 | Change to method not in send_config | 400 error |
| D-09 | Change payment method on non-PENDING estimate | 400 error |

### 5.3 Mark Deposit Received (Manual Payment)
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| D-10 | Mark deposit received on PENDING estimate | Deposit: REQUESTED → PAID, Estimate: PENDING → APPROVED, Lead → WON, emails sent |
| D-11 | Mark deposit received on SENT estimate (before customer acts) | Deposit: REQUESTED → PAID, Estimate: SENT → APPROVED, Lead → WON |
| D-12 | Mark deposit received with reference_number and notes | Same + reference/notes stored on deposit |
| D-13 | Mark deposit received on already-PAID deposit | 400 error — "Deposit is already paid" |
| D-14 | Mark deposit received on estimate without deposit | 400 error — "Estimate has no deposit" |

---

## SECTION 6: PUBLIC APPROVAL WITH DEPOSIT (Stripe / CARD)

### 6.1 Stripe Checkout Flow
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| STR-01 | Customer selects CARD, signature captured | Checkout session created, deposit gets stripe_checkout_session_id + surcharge, return URL |
| STR-02 | Stripe webhook: checkout.session.completed (success) | Deposit: REQUESTED → PAID (method=CARD), Estimate: SENT → APPROVED, Lead → WON, confirmation + alert emails |
| STR-03 | Stripe webhook with mismatched amount | 400 error — amount verification fails |
| STR-04 | Stripe webhook with duplicate event ID (idempotency) | 200 OK but no duplicate processing |
| STR-05 | Customer abandons Stripe checkout (no webhook fires) | Deposit stays REQUESTED, Estimate stays SENT, no state change |

### 6.2 Stripe After Payment Method Change
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| STR-06 | PENDING estimate → change to CARD → webhook completes | Estimate goes PENDING→SENT (on change)→APPROVED (on webhook), deposit PAID |

---

## SECTION 7: DEPOSIT MANAGEMENT (Admin Actions)

### 7.1 Waive Deposit
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| DM-01 | Waive deposit (action=waive) on SENT estimate | Deposit: REQUESTED → VOIDED, Estimate: SENT → APPROVED, Lead → WON |
| DM-02 | Waive deposit (action=waive) on PENDING estimate | Deposit: REQUESTED → VOIDED, Estimate: PENDING → APPROVED, Lead → WON |
| DM-03 | Waive deposit (action=cancel) on SENT estimate | Deposit: REQUESTED → VOIDED, Estimate: SENT → CANCELLED |
| DM-04 | Waive deposit (action=cancel) on PENDING estimate | Deposit: REQUESTED → VOIDED, Estimate: PENDING → CANCELLED |
| DM-05 | Waive deposit on APPROVED estimate | 400 error |

### 7.2 Refund Deposit
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| DM-06 | Refund PAID deposit (non-Stripe) | Deposit: PAID → REFUNDED, Estimate: APPROVED → CANCELLED, refund email sent |
| DM-07 | Refund PAID deposit (Stripe, simulated success) | Stripe refund + deposit REFUNDED + estimate CANCELLED |
| DM-08 | Refund non-PAID deposit | 400 error — "Deposit must be PAID to refund" |

### 7.3 Refund Guards
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| DM-09 | Refund VOIDED deposit | 400 error — must be PAID |
| DM-10 | Refund REFUNDED deposit | 400 error — must be PAID |

### 7.4 Reactivate Deposit
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| DM-11 | Reactivate VOIDED deposit | Deposit: VOIDED → REQUESTED, Estimate: → SENT |
| DM-12 | Reactivate PAID deposit | 400 error — must be VOIDED |
| DM-13 | Reactivate REFUNDED deposit | 400 error — must be VOIDED |
| DM-14 | Reactivate REQUESTED deposit | 400 error — must be VOIDED |

---

## SECTION 8: ESTIMATE DECLINE

| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| DC-01 | Customer declines SENT estimate (no deposit) | SENT → DECLINED, declined_at set, email to creator |
| DC-02 | Customer declines SENT estimate (has REQUESTED deposit) | SENT → DECLINED, deposit REQUESTED → VOIDED, email to creator |
| DC-03 | Customer declines PENDING estimate | PENDING → DECLINED, deposit voided |
| DC-04 | Customer declines APPROVED estimate | 400 error — wrong status |
| DC-05 | Customer declines CANCELLED estimate | 400 error — wrong status |
| DC-06 | Customer declines already-DECLINED estimate | 400 error — wrong status |
| DC-07 | Customer declines with wrong/missing token | 404 error |
| DC-08 | Customer declines SENT estimate — verify lead status unchanged | Lead stays ESTIMATED (decline does NOT revert lead) |

---

## SECTION 9: ESTIMATE CANCELLATION

| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| EC-01 | Cancel DRAFT estimate | DRAFT → CANCELLED |
| EC-02 | Cancel SENT estimate (no deposit) | SENT → CANCELLED |
| EC-03 | Cancel SENT estimate (has REQUESTED deposit) | SENT → CANCELLED, deposit REQUESTED → VOIDED |
| EC-04 | Cancel PENDING estimate (has REQUESTED deposit) | PENDING → CANCELLED, deposit voided |
| EC-05 | Cancel APPROVED estimate | 400 error |
| EC-06 | Cancel already-CANCELLED estimate | 400 error |

---

## SECTION 10: ESTIMATE EXPIRATION (Cron)

| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| EX-01 | SENT estimate past valid_until, no deposit | Estimate → CANCELLED (reason: "Estimate expired") |
| EX-02 | SENT estimate past valid_until, has REQUESTED deposit | Estimate → CANCELLED, deposit → VOIDED |
| EX-03 | PENDING estimate past valid_until | Estimate → CANCELLED, deposit → VOIDED |
| EX-04 | Expired estimate is last active on lead | Lead reverts to ESTIMATED (if not WON/LOST) |
| EX-05 | Expired estimate but lead has other active estimates | Lead status unchanged |
| EX-06 | Expired estimate but lead is WON | Lead stays WON (sticky) |
| EX-07 | Expired estimate but lead is CANCELLED | Lead stays CANCELLED (terminal — not reverted) |

---

## SECTION 11: STANDARD JOB CREATION

| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| J-01 | Create job from APPROVED estimate (deposit PAID) | Job created, UNASSIGNED, job_number generated, timeline event |
| J-02 | Create job from APPROVED estimate (deposit VOIDED/waived) | Job created, UNASSIGNED |
| J-03 | Create job from APPROVED estimate (no deposit was required) | Job created, UNASSIGNED |
| J-04 | Create job from non-APPROVED estimate | 400 error — "Estimate must be APPROVED" |
| J-05 | Create job from APPROVED estimate with REQUESTED deposit | 400 error — deposit gate |
| J-06 | Create duplicate job for same estimate | 409 error — unique constraint |
| J-07 | Create standard job — customer has no service location | 400 error — "No service location found for customer" |

---

## SECTION 12: URGENT JOB CREATION

| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| UJ-01 | Create urgent job with customer + location | Job created, UNASSIGNED, is_urgent=true, timeline event |
| UJ-02 | Create urgent job with invalid customer | 400 error |
| UJ-03 | Create urgent job with location not belonging to customer | 400 error |

---

## SECTION 13: JOB UPDATE (PATCH)

| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| JU-01 | Update UNASSIGNED job (scope_notes, estimated_duration) | Fields updated |
| JU-02 | Update SCHEDULED job (scope_notes, scheduled dates) | Fields updated |
| JU-03 | Update IN_PROGRESS job | 400 error — only UNASSIGNED/SCHEDULED |
| JU-04 | Update COMPLETED job | 400 error |
| JU-05 | Update CANCELLED job | 400 error |

---

## SECTION 14: JOB ASSIGNMENT & SCHEDULING

| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| JA-01 | Assign UNASSIGNED job to active technician with dates | UNASSIGNED → SCHEDULED, email to tech, timeline event |
| JA-02 | Assign UNASSIGNED job as all-day (is_all_day=true) | SCHEDULED, scheduled_end auto-computed (start + 24h) |
| JA-03 | Reassign SCHEDULED job to different technician | assigned_to updated, stays SCHEDULED |
| JA-04 | Assign job with scheduling conflict (no force) | 409 with conflict details |
| JA-05 | Assign job with scheduling conflict + force=true | Conflict ignored, job scheduled |
| JA-06 | Assign job with walkthrough conflict (no force) | 409 — walkthrough overlap detected |
| JA-07 | Assign job to inactive technician | 400 error |
| JA-08 | Assign job to non-TECHNICIAN role | 400 error |
| JA-09 | Assign job without dates (just technician) | Verify behavior — SCHEDULED with null dates or error? |
| JA-10 | Assign COMPLETED job | 400 error — terminal |
| JA-11 | Assign CANCELLED job | 400 error — terminal |
| JA-12 | Assign IN_PROGRESS job | 400 error — only UNASSIGNED/SCHEDULED |

---

## SECTION 15: JOB STATUS TRANSITIONS

### 15.1 Unassign
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| JS-01 | Unassign SCHEDULED job | SCHEDULED → UNASSIGNED, assigned_to/dates cleared |
| JS-02 | Unassign UNASSIGNED job | 400 error — only SCHEDULED |
| JS-03 | Unassign IN_PROGRESS job | 400 error — only SCHEDULED |
| JS-04 | Unassign COMPLETED job | 400 error — only SCHEDULED |
| JS-05 | Unassign CANCELLED job | 400 error — only SCHEDULED |

### 15.2 Start
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| JS-06 | Start SCHEDULED job | SCHEDULED → IN_PROGRESS, started_at set |
| JS-07 | Start UNASSIGNED job | 400 error — must be SCHEDULED |
| JS-08 | Start IN_PROGRESS job | 400 error — already started |
| JS-09 | Start COMPLETED job | 400 error — terminal |
| JS-10 | Start CANCELLED job | 400 error — terminal |

### 15.3 Complete
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| JS-11 | Complete IN_PROGRESS job with completion_notes | IN_PROGRESS → COMPLETED, completed_at set |
| JS-12 | Complete IN_PROGRESS job without notes | 400 validation error — notes required |
| JS-13 | Complete UNASSIGNED job | 400 error — must be IN_PROGRESS |
| JS-14 | Complete SCHEDULED job | 400 error — must be IN_PROGRESS |
| JS-15 | Complete COMPLETED job | 400 error — already completed |
| JS-16 | Complete CANCELLED job | 400 error — terminal |

### 15.4 Cancel
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| JS-17 | Cancel UNASSIGNED job with reason | UNASSIGNED → CANCELLED |
| JS-18 | Cancel SCHEDULED job with reason | SCHEDULED → CANCELLED |
| JS-19 | Cancel IN_PROGRESS job with reason | IN_PROGRESS → CANCELLED |
| JS-20 | Cancel COMPLETED job | 400 error — terminal |
| JS-21 | Cancel already-CANCELLED job | 400 error — terminal |
| JS-22 | Cancel job without reason | 400 validation error |

### 15.5 Delete
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| JS-23 | Delete UNASSIGNED job | Job removed |
| JS-24 | Delete SCHEDULED job | 400 error — only UNASSIGNED deletable |
| JS-25 | Delete IN_PROGRESS job | 400 error |
| JS-26 | Delete COMPLETED job | 400 error |
| JS-27 | Delete CANCELLED job | 400 error |
| JS-28 | Delete UNASSIGNED job with invoice | 400 error — has invoice |

---

## SECTION 16: JOB NOTES & TIMELINE

| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| JN-01 | Add note to job | Note created with entity_type=JOB |
| JN-02 | List notes for job | Notes returned newest-first |
| JN-03 | Get job timeline | Timeline events returned (CREATED, ASSIGNED, etc.) |

---

## SECTION 17: JOB WALKTHROUGH (URGENT ONLY)

| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| JW-01 | Complete walkthrough on urgent job with notes | walkthrough_notes + walkthrough_completed_at set, timeline event |
| JW-02 | Complete walkthrough on standard job | 400 error — "Walkthrough documentation is only available for urgent jobs" |

---

## SECTION 18: URGENT JOB CHARGES

| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| UC-01 | Add charge to urgent UNASSIGNED job | Charge created, line_total calculated |
| UC-02 | Add charge to urgent SCHEDULED job | Charge created |
| UC-03 | Add charge to urgent IN_PROGRESS job | Charge created |
| UC-04 | Add charge to urgent COMPLETED job | 400 error — terminal |
| UC-05 | Add charge to urgent CANCELLED job | 400 error — terminal |
| UC-06 | Add charge to standard job | 400 error — "Charges can only be added to urgent jobs" |
| UC-07 | Update charge (change qty/price) | line_total recalculated |
| UC-08 | Remove charge | Charge deleted, remaining charges renumbered |

---

## SECTION 19: END-TO-END WORKFLOW PATHS

These are full paths from lead creation to job scheduled, testing the complete chain.

### 19.1Standard Flow — Happy Path (No Deposit)
| # | Path |
|---|------|
| E2E-01 | Create lead (new customer) → Contact → Schedule walkthrough → Complete walkthrough → Create estimate → Send (no deposit) → Customer approves → Create job → Assign to tech → **Job SCHEDULED** |

### 19.2 Standard Flow — Happy Path (Deposit via CHECK)
| # | Path |
|---|------|
| E2E-02 | Create lead (existing customer) → Contact → Schedule walkthrough → Complete walkthrough → Create estimate → Send (deposit, methods=[CHECK,CASH]) → Customer approves (CHECK) → Admin marks deposit received → Create job → Assign to tech → **Job SCHEDULED** |

### 19.3 Standard Flow — Happy Path (Deposit via CARD/Stripe)
| # | Path |
|---|------|
| E2E-03 | Create lead → Contact → Complete walkthrough → Create estimate → Send (deposit, methods=[CARD]) → Customer approves (CARD) → Stripe webhook fires → Create job → Assign to tech → **Job SCHEDULED** |

### 19.4 Standard Flow — Deposit Waived
| # | Path |
|---|------|
| E2E-04 | Create lead → Contact → Walkthrough → Estimate → Send (deposit) → Admin waives deposit (action=waive) → Create job → Assign → **Job SCHEDULED** |

### 19.5 Standard Flow — Customer Changes Payment Method
| # | Path |
|---|------|
| E2E-05 | Create lead → ... → Send (deposit, methods=[CHECK,CARD,CASH]) → Customer approves (CHECK) → Customer changes to CASH → Admin marks received → Create job → Assign → **Job SCHEDULED** |

### 19.6 Standard Flow — Customer Changes to Stripe
| # | Path |
|---|------|
| E2E-06 | Create lead → ... → Send (deposit, methods=[CHECK,CARD]) → Customer approves (CHECK, PENDING) → Customer changes to CARD → Stripe webhook fires → Create job → Assign → **Job SCHEDULED** |

### 19.7 Standard Flow — Skip Walkthrough
| # | Path |
|---|------|
| E2E-07 | Create lead → Contact → Create estimate (skip walkthrough) → Send (no deposit) → Customer approves → Create job → Assign → **Job SCHEDULED** |

### 19.8 Standard Flow — Multiple Estimates (First Declined)
| # | Path |
|---|------|
| E2E-08 | Create lead → Contact → Walkthrough → Create estimate #1 → Send → Customer declines → Create estimate #2 → Send (no deposit) → Customer approves → Create job → Assign → **Job SCHEDULED** |

### 19.9 Standard Flow — Estimate Cancelled, New One Sent
| # | Path |
|---|------|
| E2E-09 | Create lead → Contact → Walkthrough → Create estimate → Send → Admin cancels estimate → Duplicate estimate → Send duplicate → Customer approves → Create job → Assign → **Job SCHEDULED** |

### 19.10 Standard Flow — Deposit Refund, New Estimate
| # | Path |
|---|------|
| E2E-10 | Create lead → ... → Send (deposit) → Customer approves (CHECK) → Admin marks received → Admin refunds deposit → Create new estimate → Send → Approve → Create job → Assign → **Job SCHEDULED** |

### 19.11 Standard Flow — Deposit Reactivated After Void
| # | Path |
|---|------|
| E2E-11 | Create lead → ... → Send (deposit) → Admin waives deposit (action=cancel, estimate cancelled) → Admin reactivates deposit → Customer approves (original method) → Admin marks received → Create job → Assign → **Job SCHEDULED** |

### 19.12 Standard Flow — All-Day Job
| # | Path |
|---|------|
| E2E-12 | Create lead → full flow → Create job → Assign as all-day → **Job SCHEDULED (is_all_day=true)** |

### 19.13 Standard Flow — Assign With Conflict + Force
| # | Path |
|---|------|
| E2E-13 | Create 2 jobs → Assign job #1 → Assign job #2 to same tech, same time → Get 409 → Force assign → **Both SCHEDULED** |

### 19.14 Urgent Flow — Happy Path
| # | Path |
|---|------|
| E2E-14 | Create urgent job → Add charges → Assign to tech → **Job SCHEDULED** |

### 19.15 Urgent Flow — With Walkthrough
| # | Path |
|---|------|
| E2E-15 | Create urgent job → Add charges → Complete job walkthrough (notes) → Assign → **Job SCHEDULED** |

### 19.16 Cancellation: Lead Lost Mid-Workflow
| # | Path |
|---|------|
| E2E-16 | Create lead → Contact → Schedule walkthrough → Mark lead as LOST → Verify: walkthrough auto-cancelled, lead=LOST |

### 19.17 Cancellation: Lead Cancelled Mid-Workflow
| # | Path |
|---|------|
| E2E-17 | Create lead → Contact → Schedule walkthrough → Cancel lead → Verify: walkthrough auto-cancelled, lead=CANCELLED |

### 19.18 Cancellation: Estimate Cancelled After Send
| # | Path |
|---|------|
| E2E-18 | Create lead → ... → Send estimate (with deposit) → Admin cancels estimate → Verify: estimate=CANCELLED, deposit=VOIDED |

### 19.19 Cancellation: Job Cancelled After Scheduling
| # | Path |
|---|------|
| E2E-19 | Full flow → Job SCHEDULED → Cancel job → Verify: job=CANCELLED, reason stored |

### 19.20 Cancellation: Job Unassigned After Scheduling
| # | Path |
|---|------|
| E2E-20 | Full flow → Job SCHEDULED → Unassign → Verify: job=UNASSIGNED, dates cleared → Reassign → **Job SCHEDULED again** |

### 19.21 Edge: Walkthrough Cancel → Reschedule → Complete → Estimate
| # | Path |
|---|------|
| E2E-21 | Create lead → Contact → Schedule walkthrough → Cancel walkthrough → Reschedule walkthrough → Complete walkthrough → Create estimate → Send → Approve → Create job → Assign → **Job SCHEDULED** |

### 19.22 Edge: Multiple Estimates on Same Lead
| # | Path |
|---|------|
| E2E-22 | Create lead → Contact → Walkthrough → Create estimate #1 (send, customer declines) → Create estimate #2 (send, customer declines) → Create estimate #3 (send, no deposit, approve) → Create job → Assign → **Job SCHEDULED** |

### 19.23 Edge: Estimate Expiration (Cron)
| # | Path |
|---|------|
| E2E-23 | Create lead → ... → Send estimate (set valid_until to past) → Run expiration cron → Verify: estimate=CANCELLED, deposit=VOIDED, lead status reverted |

### 19.24 Edge: Decline Then Approve Different Estimate
| # | Path |
|---|------|
| E2E-24 | Create lead → Estimate #1 (with deposit, sent, customer declines → deposit voided) → Estimate #2 (no deposit, sent, approved) → Lead=WON → Create job → Assign → **Job SCHEDULED** |

### 19.25 Standard Flow — Deposit via CASH
| # | Path |
|---|------|
| E2E-25 | Create lead → Contact → Walkthrough → Estimate → Send (deposit, methods=[CASH]) → Customer approves (CASH) → Admin marks received → Create job → Assign → **Job SCHEDULED** |

### 19.26 Standard Flow — Deposit via BANK_TRANSFER
| # | Path |
|---|------|
| E2E-26 | Create lead → Contact → Walkthrough → Estimate → Send (deposit, methods=[BANK_TRANSFER]) → Customer approves (BANK_TRANSFER) → Admin marks received → Create job → Assign → **Job SCHEDULED** |

### 19.27 Cancellation: Lead Lost After Estimate Sent (Before Customer Acts)
| # | Path |
|---|------|
| E2E-27 | Create lead → Contact → Walkthrough → Estimate → Send (with deposit) → Mark lead as LOST → Verify: lead=LOST, estimate still SENT (no auto-cancel on estimate) |

### 19.28 Cancellation: Estimate Expired Mid-Deposit (PENDING)
| # | Path |
|---|------|
| E2E-28 | Create lead → ... → Send (deposit) → Customer approves (CHECK, PENDING) → Estimate expires (cron) → Verify: estimate=CANCELLED, deposit=VOIDED |

### 19.29 Standard Flow — Job Start → Complete (Full Lifecycle)
| # | Path |
|---|------|
| E2E-29 | Full flow → Job SCHEDULED → Start job → Complete job (with notes) → Verify: job=COMPLETED |

### 19.30 Urgent Flow — Full Lifecycle Through Completion
| # | Path |
|---|------|
| E2E-30 | Create urgent job → Add charges → Assign → Start → Complete (with notes) → Verify: job=COMPLETED |

### 19.31 Cancellation: Job Cancelled While IN_PROGRESS
| # | Path |
|---|------|
| E2E-31 | Full flow → Job SCHEDULED → Start → Cancel IN_PROGRESS job → Verify: job=CANCELLED |

### 19.32 Edge: Mark Deposit Received on SENT Estimate (Admin Pre-Approves)
| # | Path |
|---|------|
| E2E-32 | Create lead → ... → Send (deposit) → Admin marks deposit received on SENT estimate (before customer acts) → Verify: estimate=APPROVED, lead=WON → Create job → Assign → **Job SCHEDULED** |

### 19.33 Edge: Waive Deposit (Cancel) → Try Create Job → Blocked
| # | Path |
|---|------|
| E2E-33 | Create lead → ... → Send (deposit) → Admin waives deposit (action=cancel) → Verify: estimate=CANCELLED → Try to create job → 400 (estimate not APPROVED) |

### 19.34 Edge: Multiple Estimates — One Expires While Other Stays Active
| # | Path |
|---|------|
| E2E-34 | Create lead → Send estimate #1 (set valid_until to past) → Send estimate #2 (fresh) → Run cron → Verify: #1=CANCELLED, #2 still SENT, lead stays ESTIMATED |

### 19.35 Edge: Single Estimate Expires → Lead Status Reverts
| # | Path |
|---|------|
| E2E-35 | Create lead → Contact → Walkthrough → Send single estimate (set valid_until to past) → Run cron → Verify: estimate=CANCELLED, lead reverts from ESTIMATED |

### 19.36 Edge: Stripe Deposit Refund → New Estimate on Same Lead
| # | Path |
|---|------|
| E2E-36 | Create lead → Send (deposit, CARD) → Stripe webhook (PAID) → Admin refunds → estimate=CANCELLED → Create new estimate → Send (no deposit) → Approve → Create job → Assign → **Job SCHEDULED** |

### 19.37 Edge: All-Day Job With Conflict + Force
| # | Path |
|---|------|
| E2E-37 | Create 2 jobs → Assign job #1 as all-day → Assign job #2 to same tech as all-day, overlapping → Get 409 → Force assign → **Both SCHEDULED** |

### 19.38 Edge: Walkthrough Conflict Blocks Job Assignment
| # | Path |
|---|------|
| E2E-38 | Create lead → Schedule walkthrough (assigned to Tech1) → Create separate job → Assign job to Tech1 during walkthrough window → Verify: 409 (walkthrough conflict) → Force assign → **Job SCHEDULED** |

### 19.39 Edge: Duplicate Expired Estimate → Send Fresh
| # | Path |
|---|------|
| E2E-39 | Create lead → Send estimate → Estimate expires (cron) → Duplicate expired estimate → Send duplicate → Customer approves → Create job → Assign → **Job SCHEDULED** |

### 19.40 Edge: Lead Lost After Estimate Approved (WON Lead — Terminal Block)
| # | Path |
|---|------|
| E2E-40 | Create lead → Full flow to estimate APPROVED (lead=WON) → Try to mark lost → Verify: 400 (WON is terminal) → Create job proceeds normally → Assign → **Job SCHEDULED** |

---

## SECTION 20: NEGATIVE / GUARD TESTS

These verify that invalid operations are properly blocked.

| # | Scenario | Expected Error |
|---|----------|---------------|
| G-01 | Create job from DRAFT estimate | 400 — not APPROVED |
| G-02 | Create job from SENT estimate | 400 — not APPROVED |
| G-03 | Create job from APPROVED estimate with REQUESTED deposit | 400 — deposit gate |
| G-04 | Create job from APPROVED estimate with REFUNDED deposit | Verify behavior — should REFUNDED pass the gate? |
| G-05 | Send estimate while walkthrough is scheduled on lead | 400 — walkthrough guard |
| G-06 | Approve expired estimate (public) | 400 — expired |
| G-07 | Approve PENDING estimate (public) | 400 — only SENT can be approved |
| G-08 | Decline APPROVED estimate | 400 — wrong status |
| G-09 | Decline DECLINED estimate | 400 — wrong status |
| G-10 | Mark lost on WON lead | 400 — terminal |
| G-11 | Cancel COMPLETED job | 400 — terminal |
| G-12 | Start UNASSIGNED job | 400 — must be SCHEDULED |
| G-13 | Complete SCHEDULED job (not started) | 400 — must be IN_PROGRESS |
| G-14 | Delete SCHEDULED job | 400 — only UNASSIGNED |
| G-15 | Add charge to standard job | 400 — urgent only |
| G-16 | Add charge to COMPLETED urgent job | 400 — terminal |
| G-17 | Refund REQUESTED deposit | 400 — must be PAID |
| G-18 | Reactivate PAID deposit | 400 — must be VOIDED |
| G-19 | Waive PAID deposit | 400 — must be REQUESTED |
| G-20 | Waive VOIDED deposit | 400 — must be REQUESTED |
| G-21 | Job walkthrough on standard job | 400 — urgent only |
| G-22 | Assign COMPLETED job | 400 — terminal |
| G-23 | Assign CANCELLED job | 400 — terminal |
| G-24 | Change payment method on no-deposit estimate | 400 — no deposit exists |
| G-25 | Mark deposit received on DECLINED estimate | 400 — estimate must be SENT/PENDING |
| G-26 | Refund VOIDED deposit | 400 — must be PAID |
| G-27 | Create job from APPROVED estimate with REFUNDED deposit | Verify: does REFUNDED pass the deposit gate? (should fail — only PAID/VOIDED allowed) |
| G-28 | Approve estimate (public) on PENDING estimate | 400 — only SENT can be approved |
| G-29 | Cancel job without reason | 400 — validation error |
| G-30 | Complete job without completion_notes | 400 — validation error |

---

## TOTAL SCENARIO COUNT

| Section | Count |
|---------|-------|
| 1. Lead Lifecycle | 50 |
| 2. Estimate CRUD | 26 |
| 3. Estimate Send | 14 |
| 4. Public Approval No Deposit | 6 |
| 5. Deposit Non-Stripe | 14 |
| 6. Deposit Stripe | 6 |
| 7. Deposit Management | 14 |
| 8. Decline | 8 |
| 9. Cancellation | 6 |
| 10. Expiration | 7 |
| 11. Standard Job Creation | 7 |
| 12. Urgent Job Creation | 3 |
| 13. Job Update | 5 |
| 14. Job Assignment | 12 |
| 15. Job Status Transitions | 28 |
| 16. Job Notes & Timeline | 3 |
| 17. Job Walkthrough | 2 |
| 18. Urgent Charges | 8 |
| 19. End-to-End Paths | 40 |
| 20. Guard/Negative Tests | 30 |
| 21. Read Endpoints & Filters | 20 |
| 22. Data Integrity Verification | 5 |
| **TOTAL** | **314** |

---

## SECTION 21: READ ENDPOINTS & FILTERS

### 21.1 Public Estimate View
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| RD-01 | Get public estimate with valid token | Estimate data returned (line items, totals, deposit info) |
| RD-02 | Get public estimate with missing token | 400 — "Token is required" |
| RD-03 | Get public estimate with invalid token | 404 — not found |
| RD-04 | Get public estimate past valid_until | Returns estimate with expired=true flag |

### 21.2 List Filters
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| RD-05 | Lead list — filter by status (single) | Only matching leads returned |
| RD-06 | Lead list — filter by status (multiple) | Leads with any matching status returned |
| RD-07 | Lead list — filter by assigned_to=UNASSIGNED | Only unassigned leads returned |
| RD-08 | Lead list — filter walkthrough_status=needs_scheduling | Leads with walkthrough_needed=true AND no scheduled_at |
| RD-09 | Lead list — search by customer name | Matching leads returned |
| RD-10 | Estimate list — filter by status | Only matching estimates returned |
| RD-11 | Estimate list — filter by created_by | Only that user's estimates returned |
| RD-12 | Job list — filter by status | Only matching jobs returned |
| RD-13 | Job list — filter by is_urgent | Only urgent/standard jobs returned |
| RD-14 | Job list — filter by assigned_to | Only that tech's jobs returned |

### 21.3 Stats Endpoints
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| RD-15 | Lead stats (standalone) | Returns total, new_this_week, unassigned, won, lost counts |
| RD-16 | Estimate stats (standalone) | Returns per-status count + value |
| RD-17 | Job stats (standalone) | Returns per-status counts |

### 21.4 Helper Endpoints
| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| RD-18 | List estimate creators | Returns active ADMIN/SALES users |
| RD-19 | List lead assignees | Returns active SALES users |
| RD-20 | Get job charges | Returns charges for urgent job |

---

## SECTION 22: DATA INTEGRITY VERIFICATION

| # | Scenario | Expected Outcome |
|---|----------|-----------------|
| DI-01 | Deposit amount calculation (50% of total) | deposit_amount = total_amount * deposit_percentage / 100 |
| DI-02 | Stripe surcharge calculation with rounding | surcharge = Math.round(deposit * rate * 100) / 100 |
| DI-03 | Duplicate estimate preserves correct totals | Duplicated estimate recalculates subtotal/tax/total correctly |
| DI-04 | Charge line_total calculation | line_total = Math.round(qty * unit_price * 100) / 100 |
| DI-05 | Charge removal renumbers remaining charges sequentially | After removing charge #2, charges are 1, 2, 3 (not 1, 3, 4) |

---

## KNOWN BUG FOUND DURING AUDIT

**BUG: `estimate-expiration.ts` line 72 uses `'ESTIMATING'` but Prisma enum is `ESTIMATED`**
The cron job that expires estimates tries to revert lead status to `'ESTIMATING'`, which is an invalid enum value. The migration `20260317000000_walkthrough_module` renamed this enum value. The cron was never updated. This will cause a Prisma runtime error when an estimate expires and the lead needs to revert. **Must fix before testing.**

---

## TEST INFRASTRUCTURE REQUIREMENTS

1. **Database cleanup** — wipe all dev data before test run
2. **Stripe webhook bypass** — skip signature verification in test env (`NODE_ENV=test`)
3. **API helpers** — reusable functions for each API call (create lead, send estimate, fire webhook, etc.)
4. **Test data generators** — unique customers, leads, estimates per test (timestamp-based)
5. **Cron trigger** — ability to call `expireEstimates()` directly in tests
6. **Admin auth** — all tests run as Admin (storageState pattern from existing E2E setup)
