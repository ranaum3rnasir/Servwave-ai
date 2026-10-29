# Invoice & Payments — Design Spec

**Step:** 8 — Invoicing & Payments
**Date:** 2026-03-26
**Status:** Approved (brainstorm complete, spec reviewed)

---

## 1. Overview

The invoicing and payments module completes the end-to-end workflow: Lead → Estimate → Job → **Invoice → Payment**. It supports two flows:

- **Standard flow:** Completed job (from estimate) → Create invoice (deposit credit auto-applied) → Send to customer → Customer pays (Stripe or manual) → Close
- **Urgent flow:** Completed urgent job → Create invoice (no deposit) → Technician records on-site payment or sends invoice → Close

---

## 2. Schema Changes

One Prisma migration.

### 2.1 Add to `InvoiceStatus` enum

```
VOIDED
```

Final enum: `DRAFT | SENT | PARTIAL | PAID | VOIDED`

### 2.2 Add fields to `Invoice` model

```prisma
discount_amount  Decimal   @default(0) @db.Decimal(12, 2)  // Snapshot of estimate discount at invoice creation time
tax_rate         Decimal   @default(0) @db.Decimal(5, 4)   // Snapshot of tax rate used at creation time
voided_at        DateTime?
voided_reason    String?
```

### 2.3 Update `Payment` model

```prisma
reference_number  String?   // Check number, transaction ID, etc.
collected_by      String?   @db.Uuid  // Make nullable for Stripe webhook payments (no user session)
```

Update the `collector` relation to optional: `User?` instead of `User`.

### 2.4 No other model changes

Job, Deposit, Estimate, Customer — all unchanged.

### 2.5 Invoice creation math

```
subtotal       = sum(estimate_line_items.line_total) + sum(job_charges.line_total)
discount       = estimate.discount_amount (or 0 for urgent jobs)
```

**Tax calculation:**
- The estimate-level discount applies ONLY to estimate line items (not job charges)
- Discount is prorated across taxable estimate items proportionally
- Each item's `is_taxable` flag is respected (both EstimateLineItem and JobCharge)
- Tax rate source: `estimate.tax_rate` for standard jobs; `StateTaxRate` lookup by `job.service_location.state` for urgent jobs

```
estimate_taxable_total = sum(taxable estimate items) - prorated discount on taxable items
job_charge_taxable     = sum(taxable job charges)
tax_amount             = (estimate_taxable_total + job_charge_taxable) * tax_rate
```

- If `customer.tax_exempt === true`, `tax_amount = 0` regardless of line item taxability

```
total_amount   = subtotal - discount + tax_amount
deposit_credit = deposit.amount - deposit.total_refunded (if deposit status is PAID, else 0)
amount_due     = total_amount - deposit_credit
```

- A fully refunded deposit (`total_refunded === amount`) results in $0 deposit credit
- A VOIDED deposit also results in $0 deposit credit

`amount_due` is updated in-place each time a payment is recorded (same transaction).

### 2.6 Invoice numbering

Format: `I00001` (single letter prefix + 5-digit zero-padded sequential number). Matches the existing convention: `L00001` (leads), `E00001` (estimates), `J00001` (jobs). Generated via `I${String(nextNum).padStart(5, '0')}`.

---

## 3. API Endpoints

### 3.1 New: `/api/invoices/*`

| Method | Endpoint | Auth | Roles | Description |
|--------|----------|------|-------|-------------|
| POST | `/api/invoices` | Yes | Admin, Dispatcher, Tech (own) | Create invoice from completed job |
| GET | `/api/invoices` | Yes | All | List invoices (paginated, filtered, search, bundled stats) |
| GET | `/api/invoices/:id` | Yes | All | Invoice detail |
| PATCH | `/api/invoices/:id` | Yes | Admin, Dispatcher | Edit DRAFT (due_date only) |
| DELETE | `/api/invoices/:id` | Yes | Admin, Dispatcher | Delete DRAFT invoice only |
| POST | `/api/invoices/:id/send` | Yes | Admin, Dispatcher | DRAFT → SENT |
| POST | `/api/invoices/:id/void` | Yes | Admin only | SENT/PARTIAL → VOIDED (requires reason) |
| POST | `/api/invoices/:id/payments` | Yes | Admin, Dispatcher, Tech (own) | Record manual payment |
| GET | `/api/invoices/:id/notes` | Yes | All | Get notes |
| POST | `/api/invoices/:id/notes` | Yes | Admin, Dispatcher, Tech (own) | Add note |
| GET | `/api/invoices/:id/public` | No | Token-based | Public invoice view |
| POST | `/api/invoices/:id/public/checkout` | No | Token-based | Create Stripe Checkout for card payment |

**Key distinctions:**
- **DELETE**: Only for DRAFT invoices (never sent, no paper trail needed). Hard-deletes the invoice so the job can be re-invoiced.
- **VOID**: Only for SENT or PARTIAL invoices (they were sent, need audit trail). Sets status to VOIDED, preserves the record.

Line items and totals are derived from the job and estimate and cannot be manually edited. To change amounts, update job charges before creating the invoice.

### 3.2 Extended: `/api/webhooks/stripe`

**Backward-compatible routing:** The existing webhook checks `session.metadata?.depositId`. The new logic checks `metadata.invoiceId` first (new path), then falls back to `metadata.depositId` (existing deposit path). This avoids modifying existing deposit checkout session creation and ensures backward compatibility with in-flight deposit sessions.

### 3.3 Role-based access

| Action | Admin | Dispatcher | Technician | Sales |
|--------|-------|------------|------------|-------|
| Create invoice | Yes | Yes | Own jobs only | No |
| View list/detail | Yes | Yes | Own jobs only | Read-only (own leads' jobs) |
| Send invoice | Yes | Yes | No | No |
| Record payment | Yes | Yes | Own jobs only | No |
| Edit (DRAFT only) | Yes | Yes | No | No |
| Delete (DRAFT only) | Yes | Yes | No | No |
| Void invoice | Yes | No | No | No |

**Implementation notes:**
- Technician guard: `invoice → job.assigned_to === req.user.id`
- Sales visibility filter: `invoice → job.estimate.lead.assigned_to === req.user.id`

### 3.4 List endpoint filters

- `status` — multi-value (e.g., `status=SENT,PARTIAL`)
- `created_after` / `created_before` — date range
- `overdue` — boolean (due_date < today AND status IN SENT, PARTIAL)
- Search: invoice number, customer name, job number

### 3.5 Bundled stats (in list response)

Computed via `Promise.all` in the list handler:

| Stat | Calculation |
|------|------------|
| Due ($ + count) | sum(amount_due) + count where status IN (SENT, PARTIAL) |
| Overdue ($ + count) | sum(amount_due) + count where due_date < today AND status IN (SENT, PARTIAL) |
| Collected this month | sum(payments.amount) where paid_at in current month |
| Unsent (count) | count where status = DRAFT |
| Need Invoices (count) | count of completed jobs with no invoice (LEFT JOIN / NOT EXISTS) |

---

## 4. Controller Logic

### 4.1 `create(req, res)`

1. Validate: job exists, status is COMPLETED, no existing non-deleted invoice for this job
2. Validate: job has at least one line item (estimate line items or job charges). Return 400 if empty: "Cannot create invoice with no line items."
3. Technician guard: `job.assigned_to === req.user.id`
4. Fetch job with estimate (line items, deposit, discount) + job charges + customer (with payment_type)
5. Calculate due date from customer's `payment_type`:
   - COD = today
   - NET 15 = +15 days
   - NET 30 = +30 days
   - NET 60 = +60 days
   - EOM = end of current month
   - Default fallback (null/undefined payment_type) = NET 30
6. Calculate totals (see §2.5)
7. Generate `invoice_number`: `I00001` (same sequential pattern as estimates/jobs)
8. Create Invoice in transaction
9. Create timeline event: `INVOICE_CREATED`
10. Return invoice

### 4.2 `send(req, res)`

1. Validate: invoice exists, status is DRAFT
2. Generate `public_token` (crypto.randomUUID)
3. Update: status → SENT, sent_at, public_token
4. Set due_date if not already set (using customer payment_type, fallback NET 30)
5. Timeline event: `INVOICE_SENT`
6. Fire-and-forget: `sendInvoiceEmail()` to customer
7. Return updated invoice

### 4.3 `void(req, res)`

1. Validate: invoice exists, status is SENT or PARTIAL only (not DRAFT — use DELETE; not PAID or VOIDED)
2. Require `voided_reason` in body
3. Update: status → VOIDED, voided_at, voided_reason
4. Timeline event: `INVOICE_VOIDED`
5. Return updated invoice

**Voiding with payments:** When a PARTIAL invoice is voided, existing payments remain on record for accounting purposes. The void reason should document the refund plan (manual Stripe refund, credit memo, etc.). No automatic refund is triggered.

**Re-invoicing after void:** A voided invoice's job CAN have a new invoice created. The `create()` guard checks for "no existing non-VOIDED invoice" — if the only invoice is VOIDED, creation is allowed. Implementation: query `invoice WHERE job_id = X AND status != 'VOIDED'` — if none found, allow creation.

### 4.4 `delete(req, res)`

1. Validate: invoice exists, status is DRAFT
2. Hard-delete the invoice from the database
3. No timeline event needed (never sent, no audit trail)
4. Return 204

### 4.5 `recordPayment(req, res)`

1. Validate: invoice exists, status is SENT or PARTIAL
2. Validate body: amount (> 0, <= amount_due), method (CARD/CASH/CHECK/BANK_TRANSFER), paid_at (default now), reference_number (optional), notes (optional)
3. Technician guard: own job only
4. Transaction (with row lock on Invoice to prevent race conditions):
   - Re-read invoice with `SELECT FOR UPDATE` (via `prisma.$queryRaw` or interactive transaction) to get current amount_due
   - Validate amount <= current amount_due (prevents double-payment race condition)
   - Create Payment (collected_by = req.user.id, reference_number)
   - Update amount_due = amount_due - payment.amount
   - If amount_due <= 0: status → PAID, set paid_at
   - Else if status was SENT: status → PARTIAL
5. Timeline event: `PAYMENT_RECEIVED` (and `INVOICE_PAID` if fully paid)
6. Fire-and-forget emails:
   - `sendPaymentReceivedEmail()` to customer
   - If fully paid: `sendInvoicePaidEmail()` to customer
   - `sendPaymentReceivedAlert()` internal

### 4.6 `createPublicCheckout(req, res)`

1. Validate: invoice exists via public_token, status is SENT or PARTIAL
2. Calculate: paymentAmount = amount_due, surchargeAmount = amount_due * surchargeRate
3. Create Stripe Checkout Session with metadata: `{ invoiceId: invoice.id }` (no `type` field needed — routing is by checking `invoiceId` vs `depositId`)
4. Return checkout URL

Note: Stripe Checkout sessions expire after 24 hours by default. No cleanup needed on our side if the customer abandons the session.

### 4.7 Webhook extension

On `checkout.session.completed`:
1. Check `session.metadata?.invoiceId` first (new invoice path)
2. If not found, check `session.metadata?.depositId` (existing deposit path — unchanged)
3. For invoice path:
   - Extract invoiceId from metadata
   - Idempotency check via StripeEvent table
   - Verify amount matches (payment + surcharge)
   - Transaction (with row lock): create Payment (method: CARD, stripe_payment_intent_id), update amount_due, update status
   - Fire-and-forget emails
   - Record StripeEvent

---

## 5. Email Functions

Four new functions in `backend/src/lib/email.ts`:

| Function | To | Subject | Trigger |
|----------|-----|---------|---------|
| `sendInvoiceEmail` | Customer | "Invoice {number} from Alpha CRM" | send() |
| `sendPaymentReceivedEmail` | Customer | "Payment Received — Invoice {number}" | recordPayment(), webhook |
| `sendInvoicePaidEmail` | Customer | "Invoice {number} — Paid in Full" | When amount_due reaches 0 |
| `sendPaymentReceivedAlert` | Internal | "[Internal] Payment received on {number}" | recordPayment(), webhook |

All follow existing fire-and-forget pattern. Failures logged, don't block response.

---

## 6. Timeline Events

| Event Type | Description | Entity |
|------------|-------------|--------|
| INVOICE_CREATED | "Invoice {number} created" | Invoice |
| INVOICE_SENT | "Invoice {number} sent to customer" | Invoice |
| PAYMENT_RECEIVED | "Payment of {amount} received via {method}" | Invoice |
| INVOICE_PAID | "Invoice {number} paid in full" | Invoice |
| INVOICE_VOIDED | "Invoice {number} voided: {reason}" | Invoice |

Invoice timeline events also surface on the Job timeline (cross-entity, same way estimate events appear on lead timelines).

---

## 7. Frontend

### 7.1 New Pages

#### InvoicesPage (list)

**KPI strip (5 cells):**

| Due | Overdue | Collected (Month) | Unsent | Need Invoices |
|-----|---------|-------------------|--------|---------------|
| $ + count | $ + count (red) | $ + count (green) | count (amber) | count |

**Table columns:** Invoice #, Customer, Job, Created, Subtotal, Tax, Discount, Deposit Credit, Total, Due Date (red if overdue), Amount Due, Status badge

**Features:** Status multi-filter, date range filter, overdue toggle, search, CSV export, page size selector

#### InvoiceDetailPage

**Hero card:**
- Invoice # (14px, secondary) + status badge
- Customer name (link) + phone (tel: link) + email (mailto: link)
- Job site address (from job → service_location)
- Job + Estimate links
- Sent/due dates with computed label ("24 days left" or "5 days overdue")
- **Remaining due as hero number** (32px bold, right side). Red if overdue, default otherwise.
- Contextual primary CTA:
  - DRAFT: "Send Invoice"
  - SENT/PARTIAL: "Record Payment ($X)"
  - PAID/VOIDED: no primary CTA
- Overflow menu: Void (SENT/PARTIAL, Admin only), Delete (DRAFT), Copy Public Link (SENT+), Print/PDF

**Overdue banner:** When due_date < today AND status SENT/PARTIAL. Red alert with AlertTriangle icon: "OVERDUE — X days past due (was due {date})". Red border on hero card. Badge shows "OVERDUE" instead of "SENT".

**Payment waterfall card:**
- Progress bar (% paid, color-coded)
- Breakdown columns: Invoice Total → Deposit Credit → Payment(s) → Remaining
- Collapses to "Payments Applied -$X (N payments)" when > 4 entries, with link to Payments tab

**Tabs (3):**
- **Line Items** — Unified table with Source column (gray "Estimate" / amber "Job" tags per row). Totals at bottom-right: Subtotal → Discount (annotated "(from estimate)") → Tax → Invoice Total → bridge line: "Less payments applied: -$X | Balance due: $X"
- **Payments** — Payment history table (date, amount, method, reference #, collected by, notes) + Record Payment button
- **Notes** — Polymorphic notes (same pattern)

**Loading state:** Layout-faithful skeleton loading matching existing detail page patterns.

#### PublicInvoicePage

**No auth, token-validated.** States:
- Loading, Error, Voided, Paid (receipt: payment history + "Paid in Full" confirmation)
- SENT/PARTIAL: invoice view (header, line items, totals, deposit credit, payment history, amount due) + "Pay by Card ($X + $Y card fee)" button → Stripe Checkout redirect
- Non-card instructions: "Contact us to arrange payment"
- Stripe return: success/cancelled banners

### 7.2 New Dialogs

#### RecordPaymentDialog
- Amount (pre-filled with remaining due, editable, max = amount_due)
- Payment Method (select: Cash / Check / Card / Bank Transfer)
- Date (defaults to today, can backdate)
- Reference # (optional — check number, transaction ID)
- Notes (optional)
- Validation: amount > 0 and <= amount_due, method required
- Overpayment blocked (validation error if amount > amount_due)

#### VoidInvoiceDialog
- Reason (required textarea)
- Destructive confirmation (red button)
- Only available for SENT/PARTIAL status

### 7.3 Modified Existing Pages

- **JobDetailPage:** Wire "Create Invoice" button → POST /api/invoices → navigate to InvoiceDetailPage
- **CustomerDetailPage:** Invoices tab queries customer's invoices
- **App.tsx:** Add routes `/invoices`, `/invoices/:id`, `/invoices/:id/public`
- **nav-config.ts:** Update Invoices nav item
- **search.controller.ts:** Extend global search to include invoices

---

## 8. Credit Card Surcharge

Same pattern as deposits. When customer pays by card on the public invoice page:
- `surchargeAmount = amount_due * CREDIT_CARD_SURCHARGE_RATE` (default 3.5%)
- Stripe Checkout total = amount_due + surchargeAmount
- Displayed to customer before checkout: "Amount: $768.00 + Card Fee: $26.88 = $794.88"
- Payment recorded for the invoice amount ($768.00), surcharge goes to Stripe

---

## 9. Due Date Calculation

Auto-calculated from customer's `payment_type` when invoice is created. Admin/Dispatcher can override before sending.

```
COD       → same day
NET 15    → created_at + 15 days
NET 30    → created_at + 30 days
NET 60    → created_at + 60 days
EOM       → end of current month
(default) → +30 days (when payment_type is null/undefined)
```

---

## 10. Out of Scope (Deferred)

- Bulk actions / row selection on InvoicesPage
- Overdue reminder cron job / Send Reminder email action
- Customer payment history snippet on detail page
- Next/previous invoice navigation
- Payment plans / formal schedules
- Invoice-level discounts (separate from estimate discount)
- Aging buckets (1-30, 31-60, 61-90, 90+ days)
- Collection rate / DSO trend metrics (Dashboard — Step 9)
