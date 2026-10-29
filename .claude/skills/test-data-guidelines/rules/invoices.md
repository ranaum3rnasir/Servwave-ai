## 1. Status State Machine

```
DRAFT → SENT → PARTIAL → PAID
          \→ VOIDED
DRAFT → Deleted (not a status, actual deletion)
SENT → PAID (single full payment)
SENT → VOIDED
PARTIAL → PAID (remaining balance paid)
```

## 2. Required Fields Per Status

| Status | Required Fields | Must Be Null |
|--------|----------------|-------------|
| DRAFT | job_id (COMPLETED job), subtotal, tax_amount, total_amount, amount_due, tax_rate | public_token, sent_at, due_date, paid_at, voided_at, voided_reason |
| SENT | +sent_at, +public_token, +due_date (calculated from customer payment_type) | paid_at, voided_at, voided_reason |
| PARTIAL | +payments[] (length ≥ 1), amount_due > 0 | paid_at, voided_at, voided_reason |
| PAID | +paid_at, amount_due == 0, payments[] cover total | voided_at, voided_reason |
| VOIDED | +voided_at, +voided_reason (specific reason) | paid_at |

**CRITICAL: The job MUST be COMPLETED before an invoice can be created.**
**CRITICAL: Only one invoice per job (job_id is unique on Invoice).**

## 3. Amount Calculation Rules

**Standard flow (from estimate):**
- `subtotal`: Sum of estimate line items' line_totals + sum of job charges' line_totals
- `discount_amount`: From estimate discount (applies only to estimate taxable items, NOT job charges)
- `tax_rate`: From estimate tax_rate
- `tax_amount`: (taxable estimate items - their share of discount + taxable job charges) × tax_rate
- `deposit_credit`: deposit.amount - deposit.total_refunded (if deposit exists and is PAID)
- `total_amount`: subtotal - discount_amount + tax_amount
- `amount_due`: total_amount - deposit_credit - sum(payments.amount)

**Urgent flow (from job charges):**
- `subtotal`: Sum of job charges' line_totals
- `discount_amount`: 0 (no estimate discount)
- `tax_rate`: From state tax rate or 0 if customer is tax_exempt
- `tax_amount`: taxable charges × tax_rate
- `deposit_credit`: 0 (no deposit on urgent jobs)
- `total_amount`: subtotal + tax_amount
- `amount_due`: total_amount - sum(payments.amount)

**Math invariant:** `amount_due` must NEVER be negative. When amount_due reaches 0, status transitions to PAID.

## 4. Due Date Calculation

Based on customer's `payment_type`:

| Payment Type | Due Date |
|-------------|----------|
| COD (or null) | Same day as sent_at |
| NET 15 | sent_at + 15 days |
| NET 30 | sent_at + 30 days (default fallback) |
| NET 60 | sent_at + 60 days |
| EOM | End of the month of sent_at |

## 5. Payment Rules

| Field | Required | Constraints |
|-------|----------|-------------|
| amount | Yes | > 0, ≤ current amount_due (race-condition protected with row lock) |
| method | Yes | CARD, CASH, CHECK, BANK_TRANSFER |
| paid_at | Yes | ≥ invoice.sent_at |
| collected_by | Recommended | User who collected the payment |
| reference_number | No | Useful for CHECK (check number), BANK_TRANSFER (confirmation) |
| stripe_payment_intent_id | Conditional | Required if method == CARD and paid via Stripe (pi_test_...) |
| notes | No | Optional payment notes |

Multiple payments allowed on one invoice (partial payment flow).

Realistic payment patterns:
- Residential: Single full payment (CASH or CARD on-site, or CHECK mailed)
- Commercial NET 30: Single CHECK or BANK_TRANSFER after due date
- Partial: First payment on-site (50%), remainder within 30 days
- Overdue: Payment arrives after due_date (valid, just late)

## 6. Access Control

| Role | Can See | Can Create | Can Send | Can Void | Can Record Payment |
|------|---------|-----------|----------|----------|--------------------|
| ADMIN | All | Yes | Yes | Yes | Yes |
| DISPATCHER | All | Yes | Yes | No | Yes |
| SALES | Own leads' invoices | No | No | No | No |
| TECHNICIAN | Own jobs' invoices | Own job | No | No | Yes (on-site) |

## 7. Invalid Data for Testing

| # | Violation | Description | Expected Result |
|---|-----------|------------|-----------------|
| I-01 | Invoice on non-COMPLETED job | Job status is SCHEDULED | Should fail creation |
| I-02 | Invoice on job that already has one | Duplicate invoice | Should fail (job_id unique) |
| I-03 | PAID with amount_due > 0 | Math doesn't add up | Impossible state |
| I-04 | PARTIAL with no payments | How is it partial? | Impossible state |
| I-05 | Payment amount > amount_due | Overpayment | Should fail |
| I-06 | Payment paid_at < invoice sent_at | Paid before sent | Temporal violation |
| I-07 | VOIDED without voided_reason | Must explain why | Should fail |
| I-08 | deposit_credit > deposit.amount | Credit exceeds deposit | Math violation |
| I-09 | SENT without due_date | When is payment expected? | Impossible state |
| I-10 | SENT without public_token | Cannot access public page | Impossible state |
| I-11 | Negative payment amount | Invalid | Should fail |
| I-12 | Payment on DRAFT invoice | Can only pay SENT/PARTIAL | Should fail |
| I-13 | Payment on VOIDED invoice | Cannot pay voided | Should fail |
| I-14 | SALES creating invoice | Role not allowed | Should fail |
| I-15 | total_amount inconsistent with line items | Math mismatch | Should fail validation |
| I-16 | amount_due negative | Overpaid | Impossible state |
| I-17 | Void PAID invoice | Already paid | Should fail |
| I-18 | Delete SENT invoice | Can only delete DRAFT | Should fail |
