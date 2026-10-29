# Unified Line Items — Batch 3: Scope-of-Work Card + Two-Card Receipt (Invoice + Job)

## Context

Final batch of the 3-batch roadmap (`md_files/specs/estimates/2026-07-15-unified-line-items-scope-receipt-relationships-prd.md`).
Batch 1 (PR #814, merged) shipped the backend: `scopes Json?` on Invoice/Job, the shared totals
calculator folding scope `flat_price` into subtotal/tax, and full per-scope CRUD routes on both
surfaces (`POST/PATCH/DELETE /api/invoices/:id/scopes[/:idx]`, `GET/POST/PATCH/DELETE
/api/jobs/:id/scopes[/:idx]`). Batch 2 (PR #816, review-gated) shipped the merged line-items table
(Cost/Selling+margin/drag-reorder/edit dialog) and — critically for this batch — already threads a
`canSeePricing` prop (`ability.can('read','Invoice')`) through both `LineItemsEditor.tsx` (Job) and
`InvoiceLineItemsEditor.tsx` (Invoice).

**Grounding confirmed this batch is frontend-only.** No backend changes needed:
- Invoice scope routes are complete; `invoiceDetailSelect` already selects `scopes: true` (no
  separate GET needed — scopes ride along with every invoice detail fetch, mirroring line_items).
- Job scope routes are complete including a dedicated `GET /api/jobs/:id/scopes` (Job's
  `jobDetailSelect` does NOT embed scopes, by design — same reason line-items has its own GET; the
  new `ScopeOfWorkCard` fetches scopes itself, mirroring how `LineItemsEditor`/`JobBillingSummary`
  already do their own separate `listJobLines` fetch instead of relying on job-detail).
- `JobBillingSummary`'s Total/Invoiced/Remaining numbers already reflect a job's scope flat_price
  today (Batch 1 wired `computeJobBilling` inside `job-lines.controller.ts`'s `billingFor()`, which
  backs the `/line-items` endpoint this component's data comes from) — no change needed there.
- The frontend has **zero** scope API client code today (`grep -i scope frontend/src/lib/api/{invoices,jobs}.ts`
  → no matches) — this is the one real gap to fill before any UI can call the existing backend.

## Explicitly deferred (keep this batch tightly scoped)

- **AI "Polish" button** on scope blocks (PRD §5.4) — per the project's own "no honest-looking fake"
  rule (§C), shipping a mock Polish button is worse than not shipping one; real AI wiring is a
  separate, larger piece of work. Not built this batch.
- **"Use preset" / "Save as preset"** per-scope-block (PRD §5.5) — `ScopePreset` has the needed
  `is_taxable`/`internal_cost` columns, but `scope-preset.controller.ts`'s `createScopePresetSchema`
  + `create()` handler don't accept/persist them yet (a real, small, pre-existing gap found during
  grounding) — and the existing preset-picker UI (`ScopePresetPicker.tsx`/`ScopeOfWorkBlock.tsx`)
  is estimate-only, single-scope-per-entity, and doesn't fit the new multi-block array model. Both
  the backend fix and a multi-block preset picker are real scope creep for this batch; deferred as
  a named follow-up, not silently dropped.
- **Estimate-side adoption** (PRD S1b/S2/S3) — unchanged, still blocked on PR #740.

## What ships this batch

### 1. Frontend API client (new)

**`frontend/src/lib/api/invoices.ts`** — add:
```ts
export interface Scope {
  id: string; title: string; body: string | null;
  flat_price: number | string | null; is_taxable: boolean;
  internal_cost: number | string | null; // absent from the response entirely when !canSeePricing
}
addInvoiceScope(invoiceId, payload)    // POST /api/invoices/:id/scopes
updateInvoiceScope(invoiceId, idx, payload) // PATCH /api/invoices/:id/scopes/:idx
deleteInvoiceScope(invoiceId, idx)     // DELETE /api/invoices/:id/scopes/:idx
```
All three mirror the existing `add/update/deleteInvoiceLine` shape exactly (same file, lines
94-106) and return the updated invoice (already includes `scopes` per `invoiceDetailSelect`).

**`frontend/src/lib/api/jobs.ts`** — add the same `Scope` shape (or import a shared one — see
"Shared types" below) plus:
```ts
listJobScopes(jobId)               // GET  /api/jobs/:id/scopes
addJobScope(jobId, payload)         // POST /api/jobs/:id/scopes
updateJobScope(jobId, idx, payload) // PATCH /api/jobs/:id/scopes/:idx
deleteJobScope(jobId, idx)          // DELETE /api/jobs/:id/scopes/:idx
```
Read the actual handler response shapes in `backend/src/controllers/job-lines.controller.ts` before
typing these (the plan text above is the contract from Batch 1's design, not yet re-verified against
the shipped response bodies — verify during implementation, don't assume).

**Shared `Scope` type**: define once (e.g. `frontend/src/lib/api/jobs.ts` since Job needs the richer
`listJobScopes`) and import into `invoices.ts`, rather than duplicating the interface — avoids the
two shapes silently drifting.

### 2. `ScopeOfWorkCard` (new, shared) — `frontend/src/components/jobs/items/ScopeOfWorkCard.tsx`

Mirrors `LineItemsTable.tsx`'s shared-component placement (same directory, used by both Job and
Invoice). Multi-block card, one block = `{title, body, flat_price, is_taxable, internal_cost}`:
- Header: title with count badge ("Scope of Work (2)"); sage `+ Add scope of work` (no "Use preset"
  button — deferred, see above).
- Per block: title (required) + optional body/description; a dashed `+ Flat price` affordance when
  `flat_price` is null, else an editable price; a labeled `Taxable` Yes/No pill; a staff-only
  `internal_cost` field (gated `canSeePricing`, and only meaningful/rendered when `flat_price` is
  set — PRD EC-20); trash (immediate delete + Undo-toast, no confirm, matching the existing
  line-item delete UX); move up/down when >1 block (mirror `LineItemRow`'s existing move-up/down
  buttons from Batch 2 — reuse that exact pattern, no drag-and-drop needed here since blocks are a
  short list, not a large table).
- Empty state (0 blocks): just the `+ Add scope of work` CTA, no card chrome around nothing.
- Props: `scopes: Scope[]`, `canEdit: boolean`, `canSeePricing: boolean`, `locked: boolean` (inert
  when true, no confirm dialogs change), `onAdd`, `onUpdate(idx, patch)`, `onDelete(idx)`,
  `onReorder(newOrder: Scope[])`.
- Taxable toggle / price edit / delete each disable themselves while their own write is in flight
  (mirror the existing per-line in-flight pattern in `LineItemRow.tsx`) — not a page-wide spinner.

### 3. `InternalCostsCard` (new, shared) — `frontend/src/components/jobs/items/InternalCostsCard.tsx`

Card B, staff-only (parent gates whether to render it at all on `canSeePricing`; the card itself
does not re-check permissions — matches the existing convention where `canSeePricing` is computed
once per page and threaded down, not re-derived per component).
```
Item cost   · materials   Σ(unit_cost × qty) over MATERIAL lines
Labor cost  · services    Σ(unit_cost × qty) over SERVICE lines
Scope of work · flat      Σ scope.internal_cost (only where flat_price is set — EC-20)
Total cost
Margin                    costed-basis rule (PRD §9.2) — $ and %, "—" not "100%" when no costed lines
```
Props: `lines: LineItem[]`, `scopes: Scope[]`. Pure presentational + the costed-basis calc (PRD
§9.2 formula, verbatim):
```
costedRevenue = Σ(netOf(line) where unit_cost != null) + Σ(scope.flat_price where internal_cost != null)
costedCost    = Σ(unit_cost × qty where unit_cost != null) + Σ(scope.internal_cost where internal_cost != null)
marginPct     = costedRevenue > 0 ? round1(margin$ / costedRevenue × 100) : null   // null → "—", never 100%
```
This calc does not exist anywhere in the frontend today (confirmed during grounding) — net-new
logic, needs its own dedicated unit tests given the null-cost edge cases (PRD EC-3).

### 4. Job wiring — `frontend/src/components/jobs/items/LineItemsEditor.tsx` + `pages/JobDetailPage.tsx`

- `LineItemsEditor.tsx` already has `ability`/`canManage` (Batch 2). Add its own `canSeePricing =
  ability.can('read', 'Invoice')` (this file doesn't have it yet — Job's Cost-column gating lives
  one level up, need to confirm exactly where during implementation) and a `useQuery(['job-scopes',
  jobId], () => listJobScopes(jobId))` + mutations, mirroring the existing `listJobLines` pattern in
  the same file.
- `JobDetailPage.tsx` Items tab (~line 1299-1303): add `<ScopeOfWorkCard>` as a new `SectionCard`
  sibling between `<JobBillingSummary>` and `<LineItemsEditor>` (narrative/pricing context before
  the itemized table, matching the PRD's card ordering), and `<InternalCostsCard>` (gated
  `canSeePricing`) after `<LineItemsEditor>`.
- No change to `JobBillingSummary` itself — its numbers are already correct (see Context above).

### 5. Invoice wiring + receipt consolidation — `pages/InvoiceDetailPage.tsx` + `components/invoices/InvoiceLineItemsEditor.tsx`

Three existing places currently render invoice totals (grounded exact locations,
`InvoiceDetailPage.tsx`):
1. Page-header hero amount (~714-720) — **kept as-is**, simple `formatCurrency(amountDue)` display,
   no duplicated calculator logic, out of scope for this consolidation.
2. "Payment Summary" `<Card>` (~743-784) — **removed**, folded into the new receipt card.
3. The "invoice-only money tail" block under the Line Items tab (~804-838, its own comment already
   calls this a "hybrid totals" stopgap) — **removed**, folded into the new receipt card.

New **`InvoiceReceiptCard`** (Card A, `frontend/src/components/invoices/InvoiceReceiptCard.tsx`):
Subtotal → Discount → Taxable (post-proportion base, faint) → Tax rate/Tax → Tip → **Total** (hero
row within the card) → Deposit credit → **Balance due** → the existing collected-% progress bar
(carried over from the old Payment Summary card). Rendered once, in the Line Items tab, replacing
both removed blocks. Reuses the already-server-computed `invoice.subtotal/tax_amount/total_amount/
amount_due` fields — no new frontend math for this card (Batch 1 already made those fields
scope-aware).

Add `<ScopeOfWorkCard>` above `<InvoiceLineItemsEditor>` in the Line Items `TabsContent`, and
`<InternalCostsCard>` (gated `canSeePricing`, which `InvoiceLineItemsEditor.tsx` already computes
per Batch 2) after it.

### Non-goals confirmed during grounding
- `TotalsFooter.tsx` (the inline table-footer, editable discount/tip/tax) is **not** one of the "3
  places" and is not being removed — it stays exactly as Batch 2 left it. Card A is the page-level
  receipt; `TotalsFooter` is the live-editing control surface inside the table. Distinct concerns.

## Process (mirrors Batch 1/2)

- Worktree: `git worktree add ../alpha_crm-worktrees/scope-work-receipt -b feat/scope-work-receipt origin/staging`
  — **must be cut after PR #816 (Batch 2) merges**, so `canSeePricing` and the merged table already
  exist on the branch base.
- Issue: `gh issue create`, label `ready-for-agent`, body = this plan's summary + acceptance
  criteria; PR body says `Fixes #<n>`.
- Frontend TDD (no backend changes expected — if implementation surfaces a real backend gap not
  caught by this grounding pass, treat it as a discovered addition and flag it explicitly, same
  discipline as Batches 1/2).
- Live Playwright verification against local dev servers (Job + Invoice surfaces), `ZZ TEST` demo
  data only, before calling it done.
- Adversarial review pass before PR, same severity-gated threshold as Batches 1/2.
- PR against `staging`, no AI attribution.

## Verification
1. `cd frontend && npx vitest run` — full suite green, new `ScopeOfWorkCard`/`InternalCostsCard`
   tests included, zero regressions in `job-items-editor.test.tsx` / `invoice-line-items-editor.test.tsx`.
2. `npx tsc --noEmit` (frontend) clean.
3. `npm run build` (frontend) clean.
4. Live Playwright pass: add/edit/delete/reorder a scope block on both a Job and a Draft Invoice;
   confirm Card A's Balance Due and Card B's margin update correctly; confirm `internal_cost`/Card B
   are absent end-to-end for a pricing-restricted role (not just visually hidden — check the actual
   network response body for that role, since backend-side stripping is the real security boundary,
   frontend gating is UX only).
