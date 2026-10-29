# Invoice Refund Display — Design Spec

**Created:** 2026-05-08
**Status:** Approved by user — ready for implementation planning
**Module:** payments / invoices
**Estimated effort:** 2–3 hours

---

## Problem

When an invoice is refunded, the invoice detail page shows a "Refunded" badge but provides no information about the refund itself. The Payment Summary still shows a green "100% collected" bar, the Payments tab has no refund row, and the totals block has no refund line. An admin cannot answer "how much, when, by whom" without opening Stripe.

Additionally, the full cash lifecycle of a job spans two entities — the Deposit (on the Estimate) and the Invoice Payment — but the invoice page showed neither the deposit cash event nor either refund event. The page looked like a fully-paid, fully-successful invoice even when $310.50 had been cycled in and out.

---

## Design Decision

**Hybrid B+C: Hero signal + Payments ledger + Totals row.**

- The hero card is the at-a-glance signal (badge color only).
- The Payments tab is the full story (chronological ledger of all cash events).
- The totals block is the accounting summary (one new Refunded row).
- No redundant KPI strips or additional cards that would clutter normal paid invoices.

---

## Section 1 — Hero Card Badge

**Change:** The "Refunded" status badge changes from purple (generic) to danger red.

```
I00002   [Refunded]   ← bg-red-100 text-red-700 border border-red-200
Test Stripe · (609) 874-5252 · ranro3@gmail.com
235 Hudson St, Unit 107, Hoboken NJ 07030
Job J00006 · Estimate E00006
Sent 5/5/2026 · Due 6/4/2026 · Paid 5/5/2026
```

**Rules:**
- Applies to both partial and full refunds — the badge text is always "Refunded" (driven by `invoice.status`).
- No other hero card changes (amounts, dates, action buttons are unchanged).
- Implementation: add a `REFUNDED` case to the existing `StatusBadge` component with `variant="destructive"` or equivalent red styling.

---

## Section 2 — Payments Tab (Full Chronological Ledger)

The Payments tab becomes a ledger of every cash event in the job's lifecycle, in chronological order. This includes deposit events from the linked Estimate as well as the invoice payments and any refunds.

```
Payments (4)

DATE        EVENT                  SOURCE      METHOD   AMOUNT      BY
──────────────────────────────────────────────────────────────────────────
Apr 15      Deposit Paid           [ESTIMATE]  CARD    +$155.25    Stripe
May 5       Invoice Paid           [INVOICE]   CARD    +$155.25    Stripe
──── Refunds ──────────────────────────────────────────────────────────────
May 5       Invoice Refunded       [INVOICE]   CARD    −$155.25    System Admin
May 5       Deposit Refunded       [ESTIMATE]  CARD    −$155.25    System Admin
──────────────────────────────────────────────────────────────────────────
4 events · +$310.50 collected · −$310.50 refunded · Net $0.00
```

### Column details

| Column | Content | Notes |
|--------|---------|-------|
| DATE | `MMM D, YYYY` | Tooltip shows full datetime |
| EVENT | Bold label (see event types below) | Left accent bar: green for inbound, red for outbound |
| SOURCE | `[ESTIMATE]` or `[INVOICE]` badge | `[ESTIMATE]` links to the estimate detail page |
| METHOD | Existing CARD / CASH / CHECK badge | — |
| AMOUNT | Right-aligned tabular nums | `+` prefix green for receipts; `−` prefix red for refunds |
| BY | "Stripe" for webhook events; admin full name for in-app actions | — |

### Event types

| Event label | Trigger | Source | Sign |
|---|---|---|---|
| Deposit Paid | `deposit.status === 'PAID'` | ESTIMATE | + |
| Invoice Paid | Payment row with `method = CARD`, not deposit-credit | INVOICE | + |
| Manual Payment | Payment row with `method ≠ CARD` | INVOICE | + |
| Invoice Refunded | `invoice.status === 'REFUNDED'` | INVOICE | − |
| Deposit Refunded | `deposit.status === 'REFUNDED'` | ESTIMATE | − |

### Deposit-credit row

The existing `DEPOSIT-CREDIT` Payment row (synthetic row with `reference_number === 'DEPOSIT-CREDIT'`) is **hidden** in the new ledger. It is replaced by the explicit "Deposit Paid" event derived from `estimate.deposit`. This avoids a confusing duplicate representation of the same deposit cash event.

### Divider

The "Refunds" divider row only renders when `invoice.status === 'REFUNDED'` or `deposit.status === 'REFUNDED'`. On normal PAID invoices the tab looks exactly as it does today (no divider, no deposit row, no refund rows).

### Footer summary line

Small muted text below the last row:
```
N events · +$X collected · −$Y refunded · Net $Z
```
Only the "−$Y refunded" segment renders when refunds exist; otherwise the line reads `N events · +$X collected · Net $X`.

### Tab counter

The tab trigger updates to `Payments (N)` where N = total logical events shown, including deposit and refund rows.

---

## Section 3 — Totals Block (Line Items tab, bottom-right)

One new line added below "Less payments applied" when `invoice.total_refunded > 0`:

```
Subtotal                  $300.00
Tax (0.00%)                 $0.00
Invoice Total             $300.00
Less deposit credit       −$150.00
Less payments applied     −$150.00
Refunded                  +$150.00   ← NEW: danger red, only when refunded
──────────────────────────────────
Balance Due                 $0.00
```

**Rules:**
- Value shown: `invoice.total_refunded` (invoice payment refund only, not deposit).
- Color: `text-red-600` with `+` prefix to signal money-out direction.
- Label: always "Refunded" — the distinction between partial and full is conveyed by the amount shown, not the label. Rationale: there is no `PARTIALLY_REFUNDED` invoice status in the schema; `invoice.status` is `REFUNDED` in both cases. `amount_collected` is not a stored field — deriving it consistently would require summing all non-deposit-credit payments, which is fragile. The amount alone (`+$75.00` vs `+$150.00`) communicates partial vs full without a separate label.
- The row is invisible when `invoice.total_refunded` is null or 0 — zero code-path change for normal PAID invoices.

---

## Data requirements

### Fields already in the API response (`invoiceDetailSelect`)

- `payments` with `method`, `amount`, `paid_at`, `stripe_payment_intent_id`, `reference_number`, `collector`
- `job.estimate.deposit.amount`, `status`, `total_refunded`, `paid_at` (confirmed present at `invoiceDetailSelect` lines ~168–177)

### Fields to add to `invoiceDetailSelect`

| Field | Location | Why needed |
|---|---|---|
| `invoice.refunded_at` | `invoice` table | Ledger "Invoice Refunded" date |
| `invoice.total_refunded` | `invoice` table | Totals block refunded row |
| `invoice.refund_reason` | `invoice` table | Ledger row tooltip/detail |
| `invoice.refund_reason_category` | `invoice` table | Label disambiguation |
| `estimate.deposit.refunded_at` | `job.estimate.deposit` | Ledger "Deposit Refunded" date |
| `estimate.deposit.surcharge_amount` | `job.estimate.deposit` | Correct deposit amount display |

All are schema-present in the stripe-9c branch — this is a `select` list change only, no new queries.

### Frontend type additions

The `InvoiceDetail` TypeScript type needs the six new fields above. The `Deposit` sub-type already has `total_refunded`; add `refunded_at` and `surcharge_amount`.

---

## Files to change

```
backend/src/controllers/invoice.controller.ts    EDIT — add 6 fields to invoiceDetailSelect
frontend/src/pages/InvoiceDetailPage.tsx         EDIT — badge color, ledger tab, totals row
frontend/src/components/ui/status-badge.tsx      EDIT — add REFUNDED → red variant (confirmed kebab-case path)
```

No new components, no schema migrations, no new API endpoints.

---

## Acceptance criteria

1. A REFUNDED invoice shows a red badge in the hero — not purple/gray.
2. The Payments tab shows all cash events (deposit paid, invoice paid, invoice refunded, deposit refunded) in chronological order with correct sign, color, source badge, and "by" attribution.
3. A "Refunds" divider appears between inbound and outbound rows only when refunds exist.
4. The tab counter reflects the total event count.
5. The footer summary line shows net position.
6. The totals block shows a red "Refunded +$150.00" line when `invoice.total_refunded > 0`.
7. Normal PAID invoices (no refunds) are visually unchanged.
8. Partial refunds display correctly: badge is red "Refunded" (same status as full refund in schema), totals row shows the partial amount (e.g. `+$75.00`), ledger shows the refund row with the partial amount.

---

## Out of scope

- Deposit refund detail on the Estimate page (unchanged).
- Invoice PDF showing refund state (tracked in separate deferred plan).
- Email notification on refund (already sent via `charge.refunded` webhook handler).
- Surcharge display as a separate line in the totals block.
