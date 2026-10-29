# Estimate, EstimateLineItem, EstimateSendConfig & Deposit -- Test Data Rules

## 1. Status State Machine

```
DRAFT -> SENT -> APPROVED
           \-> DECLINED
           \-> EXPIRED (auto, via cron)
           \-> CANCELLED
DRAFT -> CANCELLED
```

Note: PENDING exists in the enum but is transitional -- used only during Stripe checkout flow. Do NOT create fixtures with PENDING status unless specifically testing Stripe checkout.

## 2. Required Fields Per Status

| Status | Required Fields | Must Be Null |
|--------|----------------|-------------|
| DRAFT | lead_id, created_by, line_items (>=1), subtotal, tax_amount, total_amount, tax_rate | sent_at, approved_at, declined_at, expired_at, cancelled_at, public_token, signature_data, signature_at, signature_ip |
| SENT | +sent_at, +public_token, +EstimateSendConfig (deposit_required, payment_methods if deposit) | approved_at, declined_at, expired_at, cancelled_at, signature_* |
| APPROVED | +approved_at, +signature_data (valid base64 PNG), +signature_at, +signature_ip | declined_at, expired_at, cancelled_at |
| DECLINED | +declined_at | approved_at, expired_at, cancelled_at, signature_* |
| EXPIRED | +expired_at (set by cron when valid_until passed) | approved_at, declined_at, cancelled_at, signature_* |
| CANCELLED | +cancelled_at, +cancelled_reason | approved_at, declined_at, expired_at, signature_* |

## 3. Line Item Rules

- Minimum 1 line item per estimate
- `sequence`: Sequential starting at 1
- `description`: Realistic work description (e.g., "Replace evaporator coil -- Trane XR15 compatible")
- `quantity`: Positive number (typically 1-10)
- `unit_price`: >= 0, Decimal(12,2). Realistic for trade work ($50-$5000)
- `is_taxable`: boolean (labor typically taxable, some materials may not be)
- `discount_type`: Optional -- PERCENTAGE or FIXED_AMOUNT
- `discount_value`: Only if discount_type set
- `line_total`: `quantity * unit_price - discount_amount` (must be mathematically consistent)

Math consistency rules:
- `subtotal` = sum of all `line_total`
- `tax_amount` = sum of taxable line_totals x `tax_rate`
- `discount_amount` = estimate-level discount applied proportionally to taxable items
- `total_amount` = `subtotal - discount_amount + tax_amount`
- All amounts are Decimal(12,2) -- round to 2 decimal places

## 4. Deposit Rules

Only present when estimate has `deposit_required: true` in EstimateSendConfig.

**EstimateSendConfig fields:**
- `deposit_required`: boolean
- `deposit_percentage`: Decimal(5,2), default from AppSetting (typically 50%)
- `deposit_amount`: Calculated from total x percentage
- `payment_methods`: JSON array of accepted methods (e.g., ["CARD", "CHECK"])

**Deposit status rules:**

| Status | Required Fields | Must Be Null |
|--------|----------------|-------------|
| REQUESTED | estimate_id, amount, deposit_percentage | paid_at, payment_method, marked_received_*, voided_*, refunded_* |
| PAID (non-Stripe) | +paid_at, +payment_method (CASH/CHECK/BANK_TRANSFER), +marked_received_by, +marked_received_at | voided_*, refunded_* |
| PAID (Stripe) | +paid_at, +payment_method (CARD), +stripe_checkout_session_id (cs_test_...), +stripe_payment_intent_id (pi_test_...) | voided_*, refunded_* |
| VOIDED | +voided_at, +voided_by | paid_at, refunded_* |
| REFUNDED | +refunded_at, +refunded_by, +refund_reason, +refund_reason_category, +total_refunded | voided_* |

Deposit amount must never exceed estimate total_amount.

## 5. Signature Data Spec

When status is APPROVED, ALL three signature fields are required:
- `signature_data`: Valid base64 PNG data URI. Use: `data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==` (1x1 transparent PNG) for tests.
- `signature_ip`: Valid IPv4 address (e.g., "73.162.45.201", "192.168.1.100"). Generate realistic IPs, not "0.0.0.0".
- `signature_at`: Must be >= `sent_at`. Typically equals `approved_at`.

**CRITICAL: An APPROVED estimate without signature_data is an impossible state.**

## 6. Lead Status Guard

An estimate can only be SENT if the associated lead is NOT in `WALKTHROUGH_SCHEDULED` status. The lead must be at least CONTACTED (and walkthrough completed if walkthrough_needed=true).

When an estimate is first sent, the lead auto-transitions:
- If lead is NEW or CONTACTED -> lead becomes ESTIMATED
- If lead is already ESTIMATED or later -> no change

When an estimate is approved:
- Lead transitions to WON (if not already)

## 7. Invalid Data for Testing

| # | Violation | Description | Expected Result |
|---|-----------|------------|-----------------|
| E-01 | APPROVED without signature_data | `signature_data: null` | Impossible state |
| E-02 | APPROVED without signature_at | Missing timestamp | Impossible state |
| E-03 | APPROVED without signature_ip | Missing IP | Impossible state |
| E-04 | SENT without public_token | Cannot access public page | Should fail |
| E-05 | SENT without EstimateSendConfig | Missing deposit config | Should fail |
| E-06 | Line items with inconsistent totals | `line_total != quantity * unit_price - discount` | Math violation |
| E-07 | tax_amount inconsistent | Manual calc doesn't match | Math violation |
| E-08 | total_amount inconsistent | subtotal - discount + tax != total | Math violation |
| E-09 | Deposit PAID without payment_method | How was it paid? | Should fail |
| E-10 | Deposit PAID via CARD without Stripe IDs | Card payment requires Stripe | Should fail |
| E-11 | Deposit amount > total_amount | Deposit exceeds estimate | Should fail |
| E-12 | approved_at < sent_at | Approved before sent | Temporal violation |
| E-13 | declined_at < sent_at | Declined before sent | Temporal violation |
| E-14 | No line items | Empty estimate | Should fail creation |
| E-15 | Sending estimate while lead is WALKTHROUGH_SCHEDULED | Guard violation | Should fail |
| E-16 | DRAFT estimate with public_token | Token only generated on send | Impossible state |
| E-17 | Negative unit_price | Invalid pricing | Should fail |
| E-18 | Zero quantity | No items | Should fail |
