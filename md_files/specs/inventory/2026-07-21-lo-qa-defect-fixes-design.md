# Logistic Orders — QA defect fixes (design)

**Date:** 2026-07-21
**Status:** approved
**Base branch:** `staging` (LO-1..LO-5 + #879/#881/#882 all merged)
**Scope:** two defects found in the live 15-scenario QA pass, plus QA coverage for
scenarios 3 and 8.

---

## 0. Correction to the QA report

The QA writeup recorded defect 1 as *"the Inventory Usage report excludes all
LO-driven movements — a report-query bug."* **That diagnosis was wrong.** It is
recorded here because the wrong diagnosis would have produced the wrong fix.

Ground truth, from the staging DB and the code:

- LO processing writes movements correctly: `type='consume'`, correct
  `organization_id`, correct `occurred_at`, `logistic_order_id` stamped.
- The report query is correct — `type: 'consume'`, `tenantWhere(req)`, and it
  even handles LO invoice attribution explicitly
  (`report.controller.ts` §14 H2 / E26 comment).
- The aggregation service (`buildInventoryUsageReport`) is correct.

The actual cause is the **upper date bound**:

- `InventoryUsageReport.tsx:36` sends `to` as a date-only string, `"2026-07-21"`.
- `inventoryUsageQuerySchema` coerces that with `z.coerce.date()` →
  `2026-07-21T00:00:00.000Z`.
- The query is `occurred_at: { gte: from, lte: to }`.

So **every movement that occurred today is excluded from every preset.** The four
LO consume movements happened at 02:22–03:37Z on the 21st and were dropped; the
July-18 legacy pair survived, producing exactly the "5 units, 2 movements,
J00225" that was observed. Because every preset shares `to: end`, "Last 12
months" and "This month" return identical payloads — the symptom that was
misread as caching.

Two consequences that change the shape of the fix:

1. **This is pre-existing and not LO's fault.** LO only made it visible, because
   LO activity happens *today* whereas the legacy fixtures are days old.
2. **It is not confined to this report.** `resolveFilters` (report.controller.ts)
   has the same shape, and `listMovementsQuerySchema.occurred_to`
   (inv-stock.controller.ts) has the same bug. Jobs, Leads, Estimates, Invoices,
   Expenses and the Action log are all affected.

Defect 2 was reported accurately and needs no correction.

---

## 1. Part 1 — inclusive end-of-day upper date bound

### Problem

A date-only upper bound coerces to midnight UTC, making it exclusive of the day
it names. Users read "to 2026-07-21" as *through* the 21st; the API means
*up to the first instant of* the 21st.

### Decision

Introduce one shared zod schema that maps a **date-only** upper bound to the last
millisecond of that day, and leave explicit timestamps untouched.

```
"2026-07-21"             → 2026-07-21T23:59:59.999Z   (date-only ⇒ through end of day)
"2026-07-21T14:00:00Z"   → 2026-07-21T14:00:00.000Z   (explicit timestamp respected)
```

Applied at three boundaries:

| Schema | File | Field |
|---|---|---|
| `baseFilterSchema` | `backend/src/controllers/report.controller.ts` | `to` |
| `inventoryUsageQuerySchema` | `backend/src/controllers/report.controller.ts` | `to` |
| `listMovementsQuerySchema` | `backend/src/controllers/inv-stock.controller.ts` | `occurred_to` |

**Only the upper bound changes.** A date-only `from` coercing to midnight is
already correct for an inclusive start. The asymmetry is deliberate and is
documented in the helper's comment so a future reader does not "fix" it into
symmetry.

### Alternatives rejected

- **Rewrite each query to `lt: to + 1 day`.** Behaviourally equivalent, but
  scatters the same date arithmetic across every call site, where it will drift.
- **Make the frontend send full ISO timestamps.** Touches 6+ report components
  and leaves the API itself still wrong for CSV export and any other consumer.

### Blast radius — stated, not hidden

Jobs, Leads, Estimates, Invoices, Revenue, Payments, Activity, AR-aging,
Inventory Usage and the stock Action log will all begin including the current
day. **Numbers on those reports will change.** That is the fix, not a side
effect. This is why Part 1 ships as its own PR (see §4).

### Testing

- Unit: date-only → `23:59:59.999`; full ISO → unchanged; absent → `undefined`.
- Integration: a consume movement stamped "today at 03:00" appears in
  `/api/reports/inventory-usage` when `to` is today's date — the exact QA failure,
  pinned.
- Integration: the same for `/api/inventory/movements?occurred_to=<today>`.
- **Revert-check every one of them.** Restore `z.coerce.date()`, confirm red,
  restore the fix.

---

## 2. Part 2 — LO drill-through in the stock Action log

### Problem

The backend accepts `logistic_order_id` (`listMovementsQuerySchema`) and returns
`logisticOrderId` / `logisticOrderNumber` on every movement row, and it is
unit-tested. But `MovementFilters` has no such field, `useMovements` never sends
it, and `ActionLogView` renders no control or link for it. Built, tested, and
unreachable.

### Decision

Surface it as a **drill-through**, not as another filter dropdown.

1. `MovementFilters` gains `logisticOrderId`; `useMovements` forwards it as
   `logistic_order_id`.
2. `ActionLogView` reads `logisticOrderId` from a URL query param, so a filtered
   view is deep-linkable and shareable, and renders a dismissible
   "Filtered to LO-J00224-1" chip that clears the param.
3. The `logisticOrderNumber` already present on each row renders as a link —
   mirroring the existing `jobId` → `/jobs/:id` treatment.
4. `LODetailSheet` gains a "View stock activity" link to that filtered log.

**Why not a dropdown:** a drill-through answers the question operators actually
have — *"what stock did this LO move?"* — in one click, and an LO `<SelectField>`
would grow unbounded and be unusable within a month of real use. The existing
filter bar (type / item / location / actor / date) stays as it is.

### One adjacent correctness fix

`ActionLogView`'s CSV export documents itself as snapshotting "the currently
filtered view", but its params omit `job_id`. This is **not** a reachable bug —
`ActionLogView` has no job filter control, so `filters.jobId` is always
`undefined` and that path can never fire in the live UI. It is a latent
inconsistency, not a user-facing defect. Since `logistic_order_id` must be
added to the same params object (and IS reachable — a real filter control
exists for it), `job_id` is added alongside it purely to mirror `useMovements`
and keep the export params future-proofed if a job filter is ever added to
this view. It is called out explicitly so the distinction isn't lost: only the
`logistic_order_id` half is a real, reachable fix.

### Testing

- `useMovements` sends `logistic_order_id` when `logisticOrderId` is set, and
  omits the key entirely when it is not.
- `ActionLogView` reads the URL param, filters, and renders the chip; dismissing
  the chip clears the param.
- The CSV export params carry both `job_id` and `logistic_order_id`.
- Revert-checked as above.

---

## 3. Part 3 — QA coverage for scenarios 3 and 8

### Scenario 3 — SALES approval flow

A SALES user exists and is active in the test org (`sales@alphacrm.com`). The
blocker is not the role: the agent is not permitted to enter passwords, so it
cannot authenticate as another user.

Coverage is therefore split:

- **Automated (agent, durable):** a bare SALES user receives **403 on
  `POST /api/logistic-orders/:id/approve`** (approve is capability-only, not a
  role default), while `create` and `read` succeed. Plus a frontend test pinning
  `LODetailSheet`'s read-only rendering for a viewer without update rights —
  the "SALES trap" fixed during LO-3.
- **Manual (human, one-off):** Ran authenticates as the SALES user and the agent
  drives the UI to confirm the read-only sheet renders correctly.

The security-critical half is automated deliberately, so it survives past this
release rather than depending on someone re-clicking it.

### Scenario 8 — invoice void unwinds a processed LO

Verified precondition: **no invoice in the test org is currently linked to an
LO**, so this scenario has never had data to run against. Setup must be built:

job → LO (anchored) → process (stock deducted) → invoice → void invoice
→ assert the LO unwinds to `RETURNED` and the stock returns.

Run live in the browser as admin, cross-checked against `stock_movements` and
`logistic_orders` with a read-only DB query.

### Scenario 9 — dropped

No organization ever ran the pre-LO-4 stock model, so there is no legacy
`stock_status='SYNCED'` row in existence to freeze. The C2 freeze guard remains
covered by its unit tests (revert-checked during LO-4).

---

## 4. Shipping

**Two PRs against `staging`, not one.**

| PR | Scope | Why separate |
|---|---|---|
| A | Part 1 — end-of-day date bound | Changes numbers on **every** report in the app |
| B | Part 2 + Part 3 automated tests | Inventory/LO-scoped only |

Different blast radii must be independently revertable. Bundled, backing out the
report-wide date change would force backing out the LO drill-through with it.

Both are **code-only — no migration**, so the worktree/`prisma migrate` hazard
does not apply.

### Non-negotiables carried from this program

- Every new test is **revert-checked**: break the fix, watch it go red, restore.
  Six placebo tests have already been caught in this program; a green test that
  has not been seen failing is not evidence.
- No AI attribution in any git artifact.
- PRs open against `staging` first; `main` promotion is a separate, later PR.
