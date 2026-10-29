# Global Test Data Rules

Cross-module rules that apply to ALL test data. Read this file before creating any fixture, factory, or seed data.

---

## 1. Timestamp Sequencing

Every entity has a timeline. Timestamps must be **chronologically consistent** — no event can happen before its prerequisite.

### Minimum Realistic Gaps

These are the minimum realistic time gaps between events. Test data should use gaps at or above these values. Gaps below these are suspicious and may indicate impossible states.

| Transition | Minimum Gap | Typical Gap | Notes |
|-----------|-------------|-------------|-------|
| Lead created → contacted | 30 minutes | 2–6 hours | Sales needs time to review and call |
| Lead contacted → walkthrough scheduled | 1 hour | 1–3 days | Scheduling takes coordination |
| Walkthrough scheduled → walkthrough performed | 4 hours | 1–5 days | Travel + prep time, future appointment |
| Walkthrough completed → estimate created | 1 hour | 1–3 days | Sales writes up findings |
| Estimate created → estimate sent | 5 minutes | 0–2 hours | Review and approval before sending |
| Estimate sent → customer approval | 1 hour | 1–7 days | Customer reviews, possibly gets competing quotes |
| Estimate sent → estimate expired | 30 days | 30 days | Controlled by `estimate_validity_days` AppSetting |
| Approval → deposit paid (Stripe) | 1 minute | 1–5 minutes | Same session checkout |
| Approval → deposit paid (non-Stripe) | 1 day | 1–10 days | Check mailed or bank transfer |
| Deposit paid → job created | 30 minutes | 0–3 days | Dispatcher creates and schedules |
| Job created → job assigned/scheduled | 5 minutes | 0–2 days | Dispatcher finds open slot |
| Job scheduled → job started | 0 minutes | 0–7 days | Tech arrives at scheduled time |
| Job started → job completed | 30 minutes | 1–8 hours | Depends on job scope |
| Job completed → invoice created | 15 minutes | 0–3 days | Admin/dispatcher reviews and invoices |
| Invoice created → invoice sent | 5 minutes | 0–1 day | Review before sending |
| Invoice sent → payment received | 0 minutes | 0–60 days | Depends on payment terms (COD–NET 60) |

### Absolute Rules (Hard Failures)

These are NOT guidelines — violating them creates impossible states:

- `contacted_at >= lead.created_at`
- `walkthrough_completed_at >= walkthrough_scheduled_at`
- `estimate.sent_at >= estimate.created_at`
- `estimate.approved_at >= estimate.sent_at`
- `estimate.declined_at >= estimate.sent_at`
- `estimate.valid_until = estimate.sent_at + validity_days`
- `deposit.paid_at >= deposit.requested_at`
- `deposit.requested_at = estimate.sent_at` (created simultaneously)
- `job.started_at >= job.scheduled_start` (within ~30 min tolerance)
- `job.completed_at >= job.started_at`
- `invoice.sent_at >= invoice.created_at`
- `invoice.due_date` follows payment_type calculation (see `sla-reference.md`)
- `payment.paid_at >= invoice.sent_at`
- `invoice.paid_at = last payment's paid_at` (when amount_due reaches 0)

### Anchoring Pattern

All workflow test data should anchor timestamps to a `baseDate` and express subsequent events as offsets:

```typescript
const baseDate = new Date('2026-02-10T09:00:00Z');
const contacted = addHours(baseDate, 4);          // T+4h
const walkthroughScheduled = addDays(baseDate, 3); // T+3d
// ... etc
```

This makes tests deterministic, timezone-safe, and easy to adjust.

---

## 2. Audit Trail Requirements

**Every action must have an actor.** Test data must document who performed each state transition.

| Action | Actor Role(s) | Field(s) Set |
|--------|--------------|-------------|
| Create lead | ADMIN, SALES | `created_by` (implicit via auth) |
| Assign lead | ADMIN, SALES | `assigned_to` → SALES user |
| Contact lead | ADMIN, SALES | `contacted_at`, `contacted_note` |
| Schedule walkthrough | ADMIN, SALES, DISPATCHER | `walkthrough_assigned_to` → SALES or TECHNICIAN |
| Cancel walkthrough | ADMIN, DISPATCHER | `walkthrough_cancelled_by`, `walkthrough_cancelled_at`, `walkthrough_cancelled_reason` |
| Complete walkthrough | SALES, TECHNICIAN (the performer) | `walkthrough_completed_at`, `walkthrough_notes` |
| Create estimate | SALES | `created_by` |
| Send estimate | ADMIN, SALES, DISPATCHER | `sent_at` |
| Approve estimate | Customer (public, no auth) | `approved_at`, `signature_data`, `signature_ip`, `signature_at` |
| Decline estimate | Customer (public, no auth) | `declined_at` |
| Cancel estimate | ADMIN, SALES, DISPATCHER | `cancelled_at`, `cancelled_reason` |
| Mark deposit received | ADMIN, DISPATCHER | `marked_received_by`, `marked_received_at` |
| Waive deposit | ADMIN | `voided_by`, `voided_at` |
| Refund deposit | ADMIN | `refunded_by`, `refunded_at`, `refund_reason`, `refund_reason_category` |
| Create job | ADMIN, DISPATCHER, TECHNICIAN | `created_by` (implicit) |
| Assign job | ADMIN, DISPATCHER | `assigned_to` → TECHNICIAN |
| Start job | ADMIN, DISPATCHER, TECHNICIAN | `started_at` |
| Complete job | ADMIN, DISPATCHER, TECHNICIAN | `completed_at`, `completion_notes` |
| Cancel job | ADMIN, DISPATCHER | `cancelled_at`, `cancelled_reason` |
| Create invoice | ADMIN, DISPATCHER, TECHNICIAN (own job) | `created_by` |
| Send invoice | ADMIN, DISPATCHER | `sent_at` |
| Void invoice | ADMIN | `voided_at`, `voided_reason` |
| Record payment | ADMIN, DISPATCHER, TECHNICIAN (own job) | `collected_by`, `paid_at` |

---

## 3. UUID & External ID Patterns

### UUIDs

All entity IDs are UUIDs (v4 format). In test fixtures:

- **Backend unit tests:** Use deterministic UUIDs for readability:
  ```
  c0000000-0000-0000-0000-000000000001  (customer)
  e0000000-0000-0000-0000-000000000001  (lead)
  f0000000-0000-0000-0000-000000000001  (estimate)
  j0000000-0000-0000-0000-000000000001  (job)
  00000000-0000-0000-0000-000000000901  (invoice)
  ```
  Prefix letter matches entity type. Increment the last digits for multiple instances.

- **E2E tests:** Never hardcode IDs — let the API generate them. Store returned IDs for subsequent steps.

### Stripe External IDs

| ID Type | Prefix | Example | When Set |
|---------|--------|---------|----------|
| Checkout session | `cs_test_` | `cs_test_a1b2c3d4e5f6` | Stripe checkout created |
| Payment intent | `pi_test_` | `pi_test_x9y8z7w6v5u4` | Payment completed |
| Refund | `re_test_` | `re_test_m3n4o5p6q7r8` | Refund processed |
| Webhook event | `evt_test_` | `evt_test_1234567890` | Webhook received |

Rules:
- Always use `_test_` prefix (never live keys in test data)
- Suffix should be unique per fixture (use random-looking alphanumeric)
- `stripe_checkout_session_id` and `stripe_payment_intent_id` are only set for CARD payments via Stripe
- Non-Stripe CARD payments (manually recorded) do NOT have Stripe IDs

### Auto-Generated Numbers

| Entity | Format | Example | Rule |
|--------|--------|---------|------|
| Lead | `L` + 5-digit zero-padded | `L00001` | Auto-generated by API. Mock in backend tests; never hardcode in E2E. |
| Estimate | `E` + 5-digit zero-padded | `E00001` | Same |
| Job | `J` + 5-digit zero-padded | `J00001` | Same |
| Invoice | `I` + 5-digit zero-padded | `I00001` | Same |

---

## 4. Role Permissions Matrix

Quick reference for which roles can perform which actions. Test data must not show a role performing an action it cannot.

| Action | ADMIN | DISPATCHER | SALES | TECHNICIAN |
|--------|:-----:|:----------:|:-----:|:----------:|
| **Leads** |
| Create lead | x | | x | |
| View all leads | x | x | | |
| View own leads | | | x | |
| Assign lead | x | x | x | |
| Contact lead | x | x | x | |
| Schedule walkthrough | x | x | x | |
| Cancel walkthrough | x | x | | |
| Mark lost | x | x | x | |
| **Estimates** |
| Create estimate | x | | x | |
| View all estimates | x | x | | |
| View own estimates | | | x | |
| Send estimate | x | x | x | |
| Cancel estimate | x | x | x | |
| Deposit: mark received | x | x | | |
| Deposit: waive | x | | | |
| Deposit: refund | x | | | |
| **Jobs** |
| Create job | x | x | x (urgent) | x (urgent) |
| View all jobs | x | x | | |
| View own jobs | | | x (via lead) | x |
| Assign/unassign job | x | x | | |
| Start job | x | x | | x |
| Complete job | x | x | | x |
| Cancel job | x | x | | |
| Add charges | x | x | | x |
| **Invoices** |
| Create invoice | x | x | | x (own job) |
| View all invoices | x | x | | |
| View own invoices | | | x (via lead) | x (own job) |
| Send invoice | x | x | | |
| Void invoice | x | | | |
| Record payment | x | x | | x (own job) |
| **Admin** |
| Manage users | x | | | |
| Manage settings | x | | | |
| Manage price book | x | x | | |

---

## 5. Decimal Precision & Math Rules

All monetary values use `Decimal(12,2)` — always round to 2 decimal places.

### Calculation Order

1. `line_total = quantity × unit_price` (per line item)
2. `subtotal = Σ line_totals`
3. `discount_amount` = estimate-level discount (proportional to taxable items only)
4. `tax_amount = (Σ taxable line_totals − their share of discount) × tax_rate`
5. `total_amount = subtotal − discount_amount + tax_amount`
6. `deposit_credit = deposit.amount − deposit.total_refunded` (if deposit PAID)
7. `amount_due = total_amount − deposit_credit − Σ payment.amounts`

### Invariants

- `amount_due >= 0` always (never negative)
- `amount_due == 0` ↔ status is PAID
- `amount_due > 0 && payments.length > 0` → status is PARTIAL
- `deposit.amount <= estimate.total_amount`
- `payment.amount <= invoice.amount_due` at time of recording (row-locked)

### Tax Rate Sources

- Estimates: `tax_rate` stored on estimate (from state tax rate at creation time)
- Invoices: inherit `tax_rate` from their job's estimate
- Urgent invoices: use state tax rate directly, or 0 if customer is `tax_exempt`
- Default tax rate (env): `0.0875` (8.75%) — see `env.ts`
- Texas state tax rate (seeded): `0.0625` (6.25%) — see `seed.ts`

---

## 6. Realistic Volume Guidelines

When generating bulk test data (for load testing, pagination, or realistic scenarios):

| Entity | Realistic Count (per SMB company) | Notes |
|--------|----------------------------------|-------|
| Customers | 200–500 | Mix of residential (70%), commercial (20%), landlords (10%) |
| Service locations | 1.2× customers | Most have 1, landlords/PMs have multiple |
| Leads per month | 30–80 | Seasonal: higher in summer (HVAC), winter (heating) |
| Estimates per lead | 1–2 (rarely 3) | Multi-estimate is edge case |
| Jobs per month | 20–60 | ~70% from estimates, ~30% urgent |
| Invoices per month | 20–60 | 1:1 with completed jobs |
| Payments per invoice | 1 (90%), 2 (9%), 3+ (1%) | Partial payment is uncommon |
| Technicians | 5–30 | The target company size |
| Sales staff | 1–5 | Smaller team |
| Dispatchers | 1–3 | Often overlaps with admin |

### Conversion Rates

- Lead → Estimate: ~80%
- Estimate → Approved: ~60%
- Approved → Completed Job: ~95%
- Invoice → Paid: ~92% (8% voided/written off)

---

## 7. Timezone Handling

- Backend stores all timestamps as `Timestamptz(6)` (UTC with microsecond precision)
- Frontend displays in browser's local timezone
- Cron jobs run at fixed UTC times (e.g., expiration at 5 AM UTC = midnight EST)
- Test data should use UTC timestamps with `Z` suffix or explicit timezone offset
- When testing date boundaries (e.g., expiration), account for UTC vs local timezone differences
