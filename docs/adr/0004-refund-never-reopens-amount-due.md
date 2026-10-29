# 0004: Refund never reopens amount_due - the rule is kept, the ledger is made honest

- Status: Accepted
- Date: 2026-08-03
- Card: SRVW-97

Note on numbering: `git ls-tree origin/staging docs/adr/` returns only
`0001-gate-automation-engine-at-point-of-effect.md`. ADRs 0002 and 0003 exist as untracked files in
Ran's main worktree and are invisible from a fresh `staging`-based worktree. This file is numbered
0004 deliberately, to avoid colliding with those pending files once they land - it is not a gap.

## Question

`invoice.controller.ts` has documented, since the entity-model rebuild, that "a refund NEVER
reopens amount_due" (`:2385`, `:2625`). `refund_instead` lets an operator force the full give-back
out as cash even while a balance is still owed, but the invoice write only ever touches
`total_refunded` / `net_collected` / `refunded_at` - `amount_due` is untouched by design.

That leaves an open question with two readings:

- **Concession**: the customer's remaining bill is unchanged. The cash that went out on top of
  the still-owed balance is a write-off the business absorbs.
- **Payment reversal**: the returned money should go back onto the balance, and the customer owes
  it again.

Nothing in the shipped code answered this - it silently did neither. The invoice stopped
reconciling (`total_amount != amount_due + net cash + credits`), and the Issue Credit dialog's own
copy and preview claimed a credit was applied when `refund_instead` sets `creditPart` to 0. There
was also no code path at all to restore the receivable on a CARD payment: `refundInvoice` 400s
outside PAID/PARTIALLY_REFUNDED, and `voidPayment` rejects card payments outright.

## Decision

Keep the documented never-reopen rule as the default. Ran's open question on the card is noted and
does not block this work - a defensible default exists:

1. **The give-back on a live balance is a concession, not a reversal, by default.** When
   `refund_instead` forces cash out while `balanceOwed > 0`, the handler now writes a compensating
   `Credit` row (`category: 'REFUND_WRITE_OFF'`) for exactly `refundPart`, alongside the existing
   `Refund` row. `amount_due` is still never touched on this path. This restores the
   reconciliation identity: `total_amount == amount_due + (payments - refunds) + credits`.
2. **An explicit, fenced opt-in exists for the reversal case**: `reopen_balance` on the same
   `/credit` endpoint. It is rejected (400) unless all three hold:
   - `refund_instead` is also set - money can only go back on the balance when it was actually
     sent back as cash.
   - `balanceOwed > 0` - this is load-bearing, not defensive. Without it, the only invoice shape
     with live staging rows (an overpaid or fully-paid invoice, `balanceOwed == 0`) would compute
     `creditPart = 0` / `refundPart = whole give-back` and the handler would set `amount_due` to
     the refunded amount - billing a customer for an overpayment they never owed and feeding AR
     aging/dunning.
   - `invoice.kind !== 'DEPOSIT'` - `voidPayment`'s own reopen path pairs the three-field reopen
     write with a `DepositCreditApplication` un-apply cascade (un-applying every application,
     raising each target invoice's `amount_due`, voiding the synthetic DEPOSIT-CREDIT payment).
     This card's reversal does not mirror that cascade. `applyDepositCredit` never requires the
     deposit invoice to be PAID, so a PARTIAL DEPOSIT invoice with a live drawdown is reachable and
     would otherwise clear the `balanceOwed > 0` guard, leaving the target STANDARD invoice holding
     an active `DepositCreditApplication` and a DEPOSIT-CREDIT payment for dollars that were
     returned - a double-count. The condition under which this fence could be lifted: mirror the
     full cascade (or narrow the reject to only DEPOSIT invoices with an active, non-reversed
     application) on a follow-up card.
   When `reopen_balance` clears all three guards, the invoice update reuses `voidPayment`'s own
   arithmetic and shape: `amount_due = balanceOwed + refundPart`, `status` recomputed the same way,
   `paid_at: null`.
3. **The Issue Credit dialog is corrected to describe both modes truthfully**: the "excess" label
   is gone (`refund_instead` sends the FULL amount, not just the excess), the preview shows the
   full amount as cash out and zero credited, and a new info-callout branch, plus the new dependent
   `reopen_balance` checkbox (rendered only when `refund_instead && balanceOwed > 0`), state in
   words what happens to the balance in each mode.

## Rejected alternative

Relaxing `voidPayment`'s card rejection to allow PI-backed payments was considered and rejected.
`voidPayment` writes no `Refund` row, no `stripe_refund_id`, and no `tax_portion`; its
`void_category` enum has no value for a voluntary customer-requested reversal, forcing either a
lying category or a Prisma enum migration. The credit endpoint already has all of this machinery
(it already moves real Stripe cash via `refund_instead`), so extending it with one opt-in flag is
the smaller, more honest change.

## Why the compensating Credit carries `tax_portion: 0`

The `Refund` row created in the same request already reverses the invoice's tax exactly once
(honouring `non_taxable_concession`). A second non-zero `tax_portion` on the write-off `Credit`
would double-reverse the same tax in any consumer that sums both ledgers. Nothing currently reads
`credits.tax_portion` (it is selected but never summed), so this is a forward-looking choice about
which ledger owns the tax reversal, not a live behaviour change today.

## Evidence the default matters

Staging (`knriiqdqxgfoecsfarlx`) has 3 `refunds` rows total; 2 are give-back-shaped
(`payment_id IS NULL`) and both fired against a zero balance (I00161, fully REFUNDED from PAID; and
I00163, the OVERPAYMENT excess case) - neither is the scenario this card addresses. Zero existing
rows took the `refund_instead`-on-a-live-balance path, so nothing on staging is affected by this
change; the defect was latent, not yet realized.

## User-visible consequences

- The write-off `Credit` lands in the Issue Credit dialog's own ledger table
  (`CreditInvoiceDialog.tsx`) as a row with the full refunded amount and `category`
  (`REFUND_WRITE_OFF`) rendered as raw text - the same way every operator-typed category already
  renders there. A category label map is a separate, un-scoped concern.
- The invoice detail "Credited" figure rises by the refunded amount.
- The customer statement (`statement.controller.ts`) gains a Credit line beside the Refund line for
  the same dollars, which now brings its running balance back in line with `amount_due` - it was
  previously landing on the pre-refund total for a `refund_instead` give-back.

## Pre-existing, untouched gap

A refund on a DEPOSIT invoice with active `DepositCreditApplication` rows does not reverse those
applications on either door (the pre-existing, non-reopen give-back path or this card's new
reversal path, which is fenced off DEPOSIT entirely). `remainingDepositCredit` subtracts refunds so
it blocks future over-application, but nothing un-applies existing rows. Not created or worsened by
this card - named here so it is not mistaken for this card's footprint.

## Coupling to SRVW-84

SRVW-84 made `amountPaidOf` subtract `credits` in both the amount-paid derivation and the
recomputed `amount_due`. The write-off `Credit` this card introduces only round-trips correctly
through a later line edit on the still-editable PARTIAL invoice because of that both-places fix -
verified by a dedicated test in `invoice-lines.test.ts` built off SRVW-84's own credits fixture
shape.

## Assumption

The give-back-on-a-live-balance being a concession by default is a product call Ran can overrule.
If Ran rules the other way, the shape survives: `reopen_balance` becomes the default rather than
the opt-in, and the compensating-Credit branch is removed - but the three guards (requires
`refund_instead`, requires `balanceOwed > 0`, rejects DEPOSIT) must survive with it, since the
zero-balance and DEPOSIT hazards are independent of which way the default falls.
