# Pre-Testing Bug Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix 12 bugs discovered during the workflow test scenario audit, before running the 314-scenario E2E test suite.

**Architecture:** All fixes are in backend controllers, cron, and webhook. Each fix is isolated — no cross-dependencies between tasks. Tests updated alongside code using existing Vitest + Supertest patterns.

**Tech Stack:** Node 20, Express, TypeScript, Prisma, Vitest, Zod

---

## Task 1: Fix `ESTIMATING` → `ESTIMATED` in Cron (BUG 3 — Critical)

**Files:**
- Modify: `backend/src/cron/estimate-expiration.ts:72`
- Modify: `backend/src/cron/estimate-expiration.ts:55` (comment)
- Modify: `backend/src/__tests__/estimate-expiration.test.ts:147,153,159`

- [ ] **Step 1: Fix the enum value in cron**

In `backend/src/cron/estimate-expiration.ts`:
- Line 55: Change comment from `ESTIMATING` to `ESTIMATED`
- Line 72: Change `'ESTIMATING'` to `'ESTIMATED'`

```typescript
// Line 55
// Check if lead should revert to ESTIMATED

// Line 72
data: { status: 'ESTIMATED' },
```

- [ ] **Step 2: Fix the test expectations**

In `backend/src/__tests__/estimate-expiration.test.ts`:
- Line 147: Change test name from `ESTIMATING` to `ESTIMATED`
- Line 153: Change mock return from `'ESTIMATING'` to `'ESTIMATED'`
- Line 159: Change expected value from `'ESTIMATING'` to `'ESTIMATED'`

- [ ] **Step 3: Run tests**

Run: `npm test --workspace=backend -- --run estimate-expiration`
Expected: All 8 tests pass

- [ ] **Step 4: Commit**

```bash
git add backend/src/cron/estimate-expiration.ts backend/src/__tests__/estimate-expiration.test.ts
git commit -m "fix: cron uses invalid ESTIMATING enum — change to ESTIMATED"
```

---

## Task 2: Exclude CANCELLED Leads from Cron Revert (BUG 4 — Medium)

**Files:**
- Modify: `backend/src/cron/estimate-expiration.ts:69`
- Modify: `backend/src/__tests__/estimate-expiration.test.ts` (add test)

- [ ] **Step 1: Add test for CANCELLED lead not reverted**

In `backend/src/__tests__/estimate-expiration.test.ts`, add after the "should NOT revert a LOST lead" test:

```typescript
it('should NOT revert a CANCELLED lead', async () => {
  const estimate = makeExpiredEstimate({ lead_id: 'lead-5' });
  mockPrisma.estimate.findMany.mockResolvedValue([estimate]);
  mockTransaction();
  mockPrisma.estimate.count.mockResolvedValue(0);
  mockPrisma.lead.findUnique.mockResolvedValue({ status: 'CANCELLED' });

  await expireEstimates();

  expect(mockPrisma.lead.update).not.toHaveBeenCalled();
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=backend -- --run estimate-expiration`
Expected: New test FAILS (CANCELLED is not in the exclusion list)

- [ ] **Step 3: Fix the exclusion list**

In `backend/src/cron/estimate-expiration.ts` line 69, change:
```typescript
if (lead && !['LOST', 'WON', 'CANCELLED'].includes(lead.status)) {
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=backend -- --run estimate-expiration`
Expected: All 9 tests pass

- [ ] **Step 5: Commit**

```bash
git add backend/src/cron/estimate-expiration.ts backend/src/__tests__/estimate-expiration.test.ts
git commit -m "fix: exclude CANCELLED leads from cron revert on estimate expiration"
```

---

## Task 3: Fix Lead → WON Overriding LOST/CANCELLED (BUG 1 — High)

**Files:**
- Modify: `backend/src/controllers/estimate.controller.ts:1199,1542,1671`
- Modify: `backend/src/controllers/webhook.controller.ts:75`
- Modify: `backend/src/__tests__/estimates.test.ts` (add tests)
- Modify: `backend/src/__tests__/webhook.test.ts` (add test)

There are 4 locations that use `status: { not: 'WON' }`. All must change to `status: { notIn: ['WON', 'LOST', 'CANCELLED'] }`.

- [ ] **Step 1: Add test — approve shouldn't transition LOST lead to WON**

In `backend/src/__tests__/estimates.test.ts`, in the approve section, add a test that mocks the lead as LOST and verifies `lead.updateMany` is called with the `notIn` filter. The key assertion is that the where clause excludes LOST and CANCELLED.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=backend -- --run estimates`
Expected: FAIL — current code uses `{ not: 'WON' }` which would match LOST leads

- [ ] **Step 3: Fix all 4 locations**

In `backend/src/controllers/estimate.controller.ts`, change lines 1199, 1542, 1671:
```typescript
// OLD:
where: { id: existing.lead_id, status: { not: 'WON' } },
// NEW:
where: { id: existing.lead_id, status: { notIn: ['WON', 'LOST', 'CANCELLED'] } },
```

In `backend/src/controllers/webhook.controller.ts`, change line 75:
```typescript
// OLD:
where: { id: deposit.estimate.lead_id, status: { not: 'WON' } },
// NEW:
where: { id: deposit.estimate.lead_id, status: { notIn: ['WON', 'LOST', 'CANCELLED'] } },
```

- [ ] **Step 4: Run all tests**

Run: `npm test --workspace=backend`
Expected: All tests pass (501+ tests)

- [ ] **Step 5: Commit**

```bash
git add backend/src/controllers/estimate.controller.ts backend/src/controllers/webhook.controller.ts backend/src/__tests__/estimates.test.ts backend/src/__tests__/webhook.test.ts
git commit -m "fix: lead WON transition now excludes LOST and CANCELLED states"
```

---

## Task 4: Cancel Estimates When Lead Goes LOST/CANCELLED (BUG 2 — High)

**Files:**
- Modify: `backend/src/controllers/lead.controller.ts` — `markLost()` (line 1055) and `cancelLead()` (line 896)
- Modify: `backend/src/__tests__/leads.test.ts` (add tests)

- [ ] **Step 1: Add test — markLost should cancel active estimates and void deposits**

In `backend/src/__tests__/leads.test.ts`, add in the markLost section:

```typescript
it('should cancel DRAFT/SENT/PENDING estimates and void REQUESTED deposits when marking lost', async () => {
  // Mock lead exists with CONTACTED status
  // Mock estimate.updateMany to cancel non-terminal estimates
  // Mock deposit.updateMany to void REQUESTED deposits
  // Call markLost
  // Assert estimate.updateMany called with status: { in: ['DRAFT', 'SENT', 'PENDING'] }
  // Assert deposit.updateMany called with status: 'REQUESTED'
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm test --workspace=backend -- --run leads`
Expected: FAIL — current code doesn't touch estimates

- [ ] **Step 3: Add cascade logic to `markLost()`**

In `backend/src/controllers/lead.controller.ts`, after the lead update (line ~1092) and before the timeline event, add:

```typescript
// Cancel all active estimates for this lead
await prisma.estimate.updateMany({
  where: {
    lead_id: param(req, 'id'),
    status: { in: ['DRAFT', 'SENT', 'PENDING'] },
  },
  data: {
    status: 'CANCELLED',
    cancelled_at: new Date(),
    cancelled_reason: 'Lead marked as lost',
  },
});

// Void any REQUESTED deposits on this lead's estimates
const estimateIds = await prisma.estimate.findMany({
  where: { lead_id: param(req, 'id') },
  select: { id: true },
});
if (estimateIds.length > 0) {
  await prisma.deposit.updateMany({
    where: {
      estimate_id: { in: estimateIds.map(e => e.id) },
      status: 'REQUESTED',
    },
    data: { status: 'VOIDED', voided_at: new Date() },
  });
}
```

- [ ] **Step 4: Add same cascade logic to `cancelLead()`**

Same pattern as markLost, with `cancelled_reason: 'Lead cancelled'`.

- [ ] **Step 5: Add test for cancelLead cascade**

- [ ] **Step 6: Run all tests**

Run: `npm test --workspace=backend`
Expected: All tests pass

- [ ] **Step 7: Commit**

```bash
git add backend/src/controllers/lead.controller.ts backend/src/__tests__/leads.test.ts
git commit -m "fix: cancel active estimates and void deposits when lead goes LOST/CANCELLED"
```

---

## Task 5: Guard `reactivateDeposit` Against CANCELLED Estimates (BUG 5 — Medium)

**Files:**
- Modify: `backend/src/controllers/estimate.controller.ts` — `reactivateDeposit()` (~line 1837)
- Modify: `backend/src/__tests__/estimates.test.ts` (add test)

- [ ] **Step 1: Add test — reactivate on CANCELLED estimate should 400**

```typescript
it('should reject reactivation if estimate is CANCELLED', async () => {
  // Mock estimate with status CANCELLED and deposit VOIDED
  // Call POST /estimates/:id/reactivate-deposit
  // Assert 400 with message about estimate status
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — current code only checks deposit status, not estimate status

- [ ] **Step 3: Add estimate status guard**

In `reactivateDeposit()`, after the VOIDED check (line ~1840), add:

```typescript
if (existing.status === 'CANCELLED' || existing.status === 'DECLINED') {
  res.status(400).json({ error: `Cannot reactivate deposit on a ${existing.status.toLowerCase()} estimate` });
  return;
}
```

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=backend`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add backend/src/controllers/estimate.controller.ts backend/src/__tests__/estimates.test.ts
git commit -m "fix: guard reactivateDeposit against CANCELLED/DECLINED estimates"
```

---

## Task 6: Block Deposit Refund When Job Exists (BUG 6 — Medium)

**Files:**
- Modify: `backend/src/controllers/estimate.controller.ts` — `refundDeposit()` (~line 1716)
- Modify: `backend/src/__tests__/estimates.test.ts` (add test)

- [ ] **Step 1: Add test — refund should 400 if job exists for estimate**

```typescript
it('should reject refund if a job exists for the estimate', async () => {
  // Mock estimate with APPROVED status, PAID deposit, and linked job
  // Call POST /estimates/:id/refund-deposit
  // Assert 400 with message about existing job
});
```

- [ ] **Step 2: Run test to verify it fails**

- [ ] **Step 3: Add job existence check**

In `refundDeposit()`, after the deposit PAID check, add:

```typescript
// Check if a job already exists for this estimate
const existingJob = await prisma.job.findUnique({
  where: { estimate_id: id },
  select: { id: true, job_number: true, status: true },
});
if (existingJob) {
  res.status(400).json({
    error: `Cannot refund deposit — job ${existingJob.job_number} exists. Cancel the job first.`,
  });
  return;
}
```

Note: The `refundDeposit` function needs to select the estimate with its job relation. Check if `existing` already includes job — if not, add `job: { select: { id: true } }` to the findUnique select.

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=backend`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add backend/src/controllers/estimate.controller.ts backend/src/__tests__/estimates.test.ts
git commit -m "fix: block deposit refund when job already exists for estimate"
```

---

## Task 7: Recalculate Totals on Metadata-Only Estimate Update (BUG 7 — Medium)

**Files:**
- Modify: `backend/src/controllers/estimate.controller.ts` — `update()` (~line 665-680)
- Modify: `backend/src/__tests__/estimates.test.ts` (add test)

- [ ] **Step 1: Add test — changing tax_rate without line_items should recalculate totals**

```typescript
it('should recalculate totals when tax_rate changes without line_items', async () => {
  // Mock existing DRAFT estimate with subtotal=1000, tax_rate=0.08, tax_amount=80, total=1080
  // PATCH with { tax_rate: 0.10 } (no line_items)
  // Assert estimate.update data includes recalculated tax_amount=100, total_amount=1100
});
```

- [ ] **Step 2: Run test to verify it fails**

Expected: FAIL — current code doesn't recalculate

- [ ] **Step 3: Add recalculation to metadata-only update path**

In the `else` branch (line 665-680), when `tax_rate` or `discount_type`/`discount_value` change, fetch existing line items, recalculate totals, and include them in the update:

```typescript
// If tax or discount changed, recalculate totals from existing line items
if (tax_rate !== undefined || discount_type !== undefined || discount_value !== undefined) {
  const lineItems = await prisma.estimateLineItem.findMany({
    where: { estimate_id: existing.id },
  });
  const newTaxRate = tax_rate ?? Number(existing.tax_rate);
  const newDiscountType = discount_type !== undefined ? (discount_type || null) : existing.discount_type;
  const newDiscountValue = discount_value !== undefined ? (discount_value ?? null) : existing.discount_value ? Number(existing.discount_value) : null;

  // Recalculate using same logic as create path
  const rawSubtotal = lineItems.reduce((sum, li) => sum + Number(li.line_total), 0);
  let discountAmount = 0;
  if (newDiscountType === 'PERCENTAGE' && newDiscountValue) {
    discountAmount = Math.round(rawSubtotal * (newDiscountValue / 100) * 100) / 100;
  } else if (newDiscountType === 'FIXED_AMOUNT' && newDiscountValue) {
    discountAmount = Number(newDiscountValue);
  }
  const subtotal = Math.round((rawSubtotal - discountAmount) * 100) / 100;
  const taxableTotal = lineItems.filter(li => li.is_taxable).reduce((sum, li) => sum + Number(li.line_total), 0);
  const taxableAfterDiscount = rawSubtotal > 0 ? taxableTotal * (subtotal / rawSubtotal) : 0;
  const tax_amount = Math.round(taxableAfterDiscount * newTaxRate * 100) / 100;
  const total_amount = Math.round((subtotal + tax_amount) * 100) / 100;

  // Include recalculated fields in update data
  updateData.subtotal = subtotal;
  updateData.tax_amount = tax_amount;
  updateData.total_amount = total_amount;
  updateData.discount_amount = discountAmount;
}
```

Note: The exact recalculation logic must match the existing `calculateTotals` helper used in the create/update-with-line-items path. Read that function first and reuse it.

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=backend`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add backend/src/controllers/estimate.controller.ts backend/src/__tests__/estimates.test.ts
git commit -m "fix: recalculate totals when tax/discount changes without line items"
```

---

## Task 8: Move Webhook Idempotency Record Inside Transaction (BUG 11 — Low)

**Files:**
- Modify: `backend/src/controllers/webhook.controller.ts:57-88,137-140`
- Modify: `backend/src/__tests__/webhook.test.ts` (update expectations)

- [ ] **Step 1: Move stripeEvent.create inside the transaction**

In `webhook.controller.ts`, move lines 138-140 inside the `$transaction` block (before line 88):

```typescript
await prisma.$transaction(async (tx) => {
  // ... existing deposit/estimate/lead/timeline updates ...

  // Record event for idempotency (inside transaction)
  await tx.stripeEvent.create({
    data: { stripe_event_id: event.id, event_type: event.type },
  });
});
```

Remove the old lines 137-140 that were outside the transaction.

- [ ] **Step 2: Update webhook tests**

Verify the test expectations still match — the `stripeEvent.create` should now be called via the `tx` object instead of the top-level `prisma`.

- [ ] **Step 3: Run tests**

Run: `npm test --workspace=backend`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add backend/src/controllers/webhook.controller.ts backend/src/__tests__/webhook.test.ts
git commit -m "fix: move Stripe idempotency record inside transaction boundary"
```

---

## Task 9: Delete Dead `validators/` Directory (DEAD CODE)

**Files:**
- Delete: `backend/src/validators/auth.validators.ts`
- Delete: `backend/src/validators/common.ts`
- Delete: `backend/src/validators/customer.validators.ts`
- Delete: `backend/src/validators/estimate.validators.ts`
- Delete: `backend/src/validators/job.validators.ts`
- Delete: `backend/src/validators/user.validators.ts`
- Delete: `backend/src/validators/lead.validators.ts`

- [ ] **Step 1: Verify no imports exist**

Run: `grep -r "from.*validators" backend/src/controllers/ backend/src/routes/`
Expected: No matches (already verified)

- [ ] **Step 2: Delete the directory**

```bash
rm -rf backend/src/validators/
```

- [ ] **Step 3: Run tests to verify nothing breaks**

Run: `npm test --workspace=backend`
Expected: All tests pass

- [ ] **Step 4: Commit**

```bash
git add -A backend/src/validators/
git commit -m "chore: remove dead validators directory — all schemas are inline in controllers"
```

---

## Task 10: Scope Sales Stats to User's Own Data (BUG 9 — Medium)

**Note:** This is a lower-priority fix since we're testing with Admin/Dispatcher roles only in the E2E suite. However, fixing it now prevents data leakage.

**Files:**
- Modify: `backend/src/controllers/estimate.controller.ts` — `list()` stats queries (~lines 432-444)
- Modify: `backend/src/__tests__/estimates.test.ts` (add test)

- [ ] **Step 1: Add test — Sales user stats should be scoped**

```typescript
it('should scope stats to own leads for SALES role', async () => {
  // mockAuthAs('SALES')
  // GET /estimates
  // Assert stats queries include lead filter: { assigned_to: salesUserId }
});
```

- [ ] **Step 2: Fix stats queries to apply role filter**

In the `list()` function, extract the `where` clause into a variable and reuse it for both the paginated query and all stats queries. When the user is SALES, the where clause already includes `lead: { assigned_to: req.user.id }` — apply the same filter to the stats Promise.all.

- [ ] **Step 3: Apply same fix to job stats and lead stats if affected**

Check `job.controller.ts` list() stats and `lead.controller.ts` list() stats for the same pattern.

- [ ] **Step 4: Run tests**

Run: `npm test --workspace=backend`
Expected: All tests pass

- [ ] **Step 5: Commit**

```bash
git add backend/src/controllers/estimate.controller.ts backend/src/__tests__/estimates.test.ts
git commit -m "fix: scope estimate/job stats to Sales user's own data"
```

---

## Execution Order

Tasks are independent and can be run in parallel, but recommended order:

1. **Task 1** — Cron `ESTIMATING` fix (Critical, simplest)
2. **Task 2** — Cron CANCELLED exclusion (builds on Task 1)
3. **Task 3** — Lead WON override fix (High severity)
4. **Task 4** — Cascade estimates on lead lost/cancel (High severity)
5. **Task 5** — Reactivate deposit guard (Medium)
6. **Task 6** — Refund deposit job check (Medium)
7. **Task 7** — Metadata update recalculation (Medium)
8. **Task 8** — Webhook idempotency fix (Low)
9. **Task 9** — Dead code cleanup (Housekeeping)
10. **Task 10** — Sales stats scoping (Medium)

**After all tasks:** Run full test suite: `npm test --workspace=backend`
Expected: All 501+ tests pass (plus ~10-15 new tests added).

---

## Out of Scope (Noted But Not Fixed Now)

- **BUG 10: Race condition in number generation** — Low risk at MVP traffic. Fix with `SELECT FOR UPDATE` or sequence table during Step 10 (Polish).
- **BUG 8: EXPIRED vs CANCELLED estimate status** — Product decision needed on whether to use the EXPIRED enum value. Currently functional with CANCELLED + `cancelled_reason: "Estimate expired"`. Defer to Step 10.
- **BUG 12: Decimal serialization** — Frontend may already handle string numbers. Verify during E2E testing; fix if it causes display issues.
