# Logistic Orders QA Defect Fixes — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Fix the two defects found in the live LO QA pass — reports silently excluding the
current day, and the LO stock drill-through being built but unreachable — then close QA
scenarios 3 and 8.

**Architecture:** Two independent PRs against `staging`. PR A adds one shared zod schema that
makes a date-only upper bound inclusive of its whole day, applied at the three query boundaries
that accept one. PR B plumbs the already-implemented `logistic_order_id` movement filter through
to the UI as a deep-linkable drill-through. No migration — both are code-only.

**Tech Stack:** Node 20 · Express · TypeScript · Prisma · Zod 3.24 · Vitest + supertest (backend)
· React 18 · TanStack Query · react-router-dom · Vitest + Testing Library (frontend)

**Design doc:** `md_files/specs/inventory/2026-07-21-lo-qa-defect-fixes-design.md`

## Global Constraints

- **Worktree:** `/Users/ranroffe/ALPHA_CRM/alpha_crm-worktrees/lo-qa-fix` (branch `lo-qa-fix`,
  cut from `origin/staging`). All commands run from there.
- **NEVER run `prisma migrate dev` / `migrate deploy` / `db push`.** The local `.env` points at
  the **live staging database**. This plan adds no migration; if one ever seems necessary, stop
  and ask.
- **No AI attribution in any git artifact** — no `Co-Authored-By: Claude`, no
  `Generated with Claude Code`, in commit messages, PR titles, or PR bodies.
- **PRs open against `staging`**, never `main`. Do not self-merge `main`.
- **Every new test must be revert-checked**: break the implementation, watch the test fail,
  restore it, watch it pass. A green test never seen failing is not evidence. Six placebo tests
  have already been caught in this program.
- **Do not write duplicate tests.** Scenario 3's automated coverage already exists (see Task C1).
- Backend tests: `npm test --workspace=backend`. Frontend tests: `npm test --workspace=frontend`.
  A single file: `npm test --workspace=backend -- src/__tests__/<file>`. Do **not** invoke
  `npx vitest` directly from the worktree — with no local `node_modules` it fetches a
  mismatched vite and fails on `vitest.config.ts`.
  Frontend typecheck: `cd frontend && npx tsc --noEmit`. Backend typecheck: `npm run build --workspace=backend`.

---

## Task A0: Worktree setup (do this first)

The worktree is freshly created and has **no `node_modules`** — every test command fails
until this is done.

- [ ] **Step 1: Install dependencies**

```bash
cd /Users/ranroffe/ALPHA_CRM/alpha_crm-worktrees/lo-qa-fix
npm install
```

This takes several minutes. Expected: exit 0.

- [ ] **Step 2: Confirm both `.env` files are present**

```bash
ls backend/.env frontend/.env
```

Both must exist (they were copied at worktree creation). `backend/.env` points at the
**live staging database** — read-only probes only, never a migration.

- [ ] **Step 3: Establish the pre-existing baseline**

```bash
npm test --workspace=backend
npm test --workspace=frontend
```

Record the pass/fail counts **before touching anything**. Any failure present now is
pre-existing and must not be attributed to this work later.

---

## File Structure

**PR A — inclusive end-of-day bound**

| File | Responsibility |
|---|---|
| Create `backend/src/lib/dateBounds.ts` | The single `inclusiveEndOfDay` zod schema. One export, one job. |
| Create `backend/src/__tests__/date-bounds.test.ts` | Unit tests for the coercion. |
| Modify `backend/src/controllers/report.controller.ts` | `baseFilterSchema.to`, `inventoryUsageQuerySchema.to` |
| Modify `backend/src/controllers/inv-stock.controller.ts` | `listMovementsQuerySchema.occurred_to` |
| Modify `backend/src/__tests__/report-inventory-usage.controller.test.ts` | End-to-end proof via the existing supertest harness. |
| Modify `backend/src/__tests__/inv-stock-movements-filters.test.ts` | Same proof for the Action log. |

**PR B — LO drill-through**

| File | Responsibility |
|---|---|
| Modify `frontend/src/lib/api/_mock/inventory/inventory.ts` | `Movement` type gains the two LO fields the server already returns. |
| Modify `frontend/src/lib/api/inventory.ts` | `MovementFilters.logisticOrderId` + `useMovements` param mapping. |
| Modify `frontend/src/components/inventory/ActionLogView.tsx` | URL-param filter, chip, LO link column, CSV export params. |
| Modify `frontend/src/components/inventory/lo/LODetailSheet.tsx` | "View stock activity" link. |
| Modify `frontend/src/__tests__/inventory-action-log.test.tsx` | Filter + chip + export coverage. |
| Modify `frontend/src/__tests__/lo-detail.test.tsx` | The drill-through link. |

---

# PR A — inclusive end-of-day upper date bound

### Task A1: The `inclusiveEndOfDay` schema

**Files:**
- Create: `backend/src/lib/dateBounds.ts`
- Test: `backend/src/__tests__/date-bounds.test.ts`

**Interfaces:**
- Consumes: nothing (leaf module).
- Produces: `inclusiveEndOfDay` — a `z.ZodOptional<z.ZodEffects<...>>` parsing
  `string | Date | undefined` → `Date | undefined`. Used by Task A2 in three schemas.

- [ ] **Step 1: Write the failing test**

Create `backend/src/__tests__/date-bounds.test.ts`:

```ts
/**
 * date-bounds.test.ts — the inclusive upper date bound.
 *
 * A date-only `to` names a whole DAY, so it must include that day. z.coerce.date()
 * mapped it to 00:00:00.000Z, which silently excluded everything that happened on
 * the named day — hiding the entire current day from every report in the app.
 */
import { describe, it, expect } from 'vitest';
import { z } from 'zod';
import { inclusiveEndOfDay } from '../lib/dateBounds';

const schema = z.object({ to: inclusiveEndOfDay });

describe('inclusiveEndOfDay', () => {
  it('maps a date-only string to the LAST millisecond of that day', () => {
    const parsed = schema.parse({ to: '2026-07-21' });
    expect(parsed.to?.toISOString()).toBe('2026-07-21T23:59:59.999Z');
  });

  it('passes an explicit timestamp through untouched', () => {
    const parsed = schema.parse({ to: '2026-07-21T14:30:00.000Z' });
    expect(parsed.to?.toISOString()).toBe('2026-07-21T14:30:00.000Z');
  });

  it('leaves an absent bound undefined', () => {
    expect(schema.parse({}).to).toBeUndefined();
  });

  it('rejects an unparseable string', () => {
    expect(schema.safeParse({ to: 'not-a-date' }).success).toBe(false);
  });

  it('includes a movement that occurred during the named day', () => {
    // The exact QA failure: an LO consume at 03:36Z on the 21st, `to=2026-07-21`.
    const to = schema.parse({ to: '2026-07-21' }).to!;
    expect(new Date('2026-07-21T03:36:15.065Z') <= to).toBe(true);
  });
});
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
cd /Users/ranroffe/ALPHA_CRM/alpha_crm-worktrees/lo-qa-fix
npm test --workspace=backend -- src/__tests__/date-bounds.test.ts
```

Expected: FAIL — `Cannot find module '../lib/dateBounds'`.

- [ ] **Step 3: Write the implementation**

Create `backend/src/lib/dateBounds.ts`:

```ts
import { z } from 'zod';

/**
 * Inclusive UPPER date bound for report / ledger queries.
 *
 * A date-only string ("2026-07-21") names a whole day, so an upper bound of that
 * day must mean "through the END of it". `z.coerce.date()` maps it to
 * 00:00:00.000Z, which makes the bound exclusive of the very day it names —
 * every report preset sends a date-only `to` of TODAY, so that silently hid the
 * entire current day from every report in the app.
 *
 * An explicit timestamp passes through untouched: a caller who names an instant
 * means that instant.
 *
 * DELIBERATELY ASYMMETRIC — the LOWER bound keeps plain `z.coerce.date()`,
 * because a date-only `from` coercing to 00:00:00.000Z is already the correct
 * inclusive start of that day. Do not "fix" this into symmetry.
 */
const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export const inclusiveEndOfDay = z
  .union([z.string(), z.date()])
  .transform((value, ctx) => {
    if (value instanceof Date) return value;
    if (DATE_ONLY.test(value)) return new Date(`${value}T23:59:59.999Z`);
    const parsed = new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'Invalid date' });
      return z.NEVER;
    }
    return parsed;
  })
  .optional();
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
npm test --workspace=backend -- src/__tests__/date-bounds.test.ts
```

Expected: PASS, 5 tests.

- [ ] **Step 5: Revert-check**

Temporarily change `T23:59:59.999Z` to `T00:00:00.000Z`. Re-run. Expected: the
first and fifth tests FAIL. Restore the fix, re-run, expect PASS. Record both
outcomes in the PR body.

- [ ] **Step 6: Commit**

```bash
git add backend/src/lib/dateBounds.ts backend/src/__tests__/date-bounds.test.ts
git commit -m "fix(reports): add inclusive end-of-day upper date bound schema"
```

---

### Task A2: Apply the bound at the three query boundaries

**Files:**
- Modify: `backend/src/controllers/report.controller.ts` (`baseFilterSchema`, `inventoryUsageQuerySchema`)
- Modify: `backend/src/controllers/inv-stock.controller.ts` (`listMovementsQuerySchema`)
- Test: `backend/src/__tests__/report-inventory-usage.controller.test.ts`

**Interfaces:**
- Consumes: `inclusiveEndOfDay` from Task A1.
- Produces: no new exports; changes the runtime meaning of `to` / `occurred_to` on
  `/api/reports/*` and `/api/inventory/movements`.

- [ ] **Step 1: Write the failing end-to-end test**

Append to `backend/src/__tests__/report-inventory-usage.controller.test.ts`, inside the
existing `describe('GET /api/reports/inventory-usage', ...)` block. It uses the file's
existing `mockAuthAs` / `authHeader` / `mockPrisma` harness:

```ts
  it('a date-only `to` includes movements from that whole day (QA: today was invisible)', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .get('/api/reports/inventory-usage?from=2026-07-01&to=2026-07-21')
      .set(authHeader('admin'));
    expect(res.status).toBe(200);

    const { lte } = mockPrisma.stockMovement.findMany.mock.calls[0][0].where.occurred_at;
    expect(lte.toISOString()).toBe('2026-07-21T23:59:59.999Z');
    // The exact movement the QA pass lost: an LO consume at 03:36Z on the 21st.
    expect(new Date('2026-07-21T03:36:15.065Z') <= lte).toBe(true);
  });
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npm test --workspace=backend -- src/__tests__/report-inventory-usage.controller.test.ts
```

Expected: FAIL — received `2026-07-21T00:00:00.000Z`. **This failure is the defect
reproduced in a test.** Do not proceed until you have seen it.

- [ ] **Step 3: Apply the schema in `report.controller.ts`**

Add to the import block near the other `../lib/*` imports:

```ts
import { inclusiveEndOfDay } from '../lib/dateBounds';
```

In `baseFilterSchema`, replace the `to` line:

```ts
const baseFilterSchema = z.object({
  anchor: z.enum(['created', 'sent', 'decided']).default('sent'),
  from: z.coerce.date().optional(),
  to: inclusiveEndOfDay,
  rep: z.string().default('all'),
  source: z.string().default('all'),
  jobType: z.string().default('all'),
  model: z.enum(['decided', 'sent']).default('sent'),
});
```

In `inventoryUsageQuerySchema`, replace the `to` line:

```ts
const inventoryUsageQuerySchema = z.object({
  from: z.coerce.date().optional(),
  to: inclusiveEndOfDay,
});
```

- [ ] **Step 4: Apply the schema in `inv-stock.controller.ts`**

Add to the import block:

```ts
import { inclusiveEndOfDay } from '../lib/dateBounds';
```

In `listMovementsQuerySchema`, replace the `occurred_to` line:

```ts
  occurred_from: z.coerce.date().optional(),
  occurred_to: inclusiveEndOfDay,
```

- [ ] **Step 5: Run the test and confirm it passes**

```bash
npm test --workspace=backend -- src/__tests__/report-inventory-usage.controller.test.ts
```

Expected: PASS, including the pre-existing tests in that file.

- [ ] **Step 6: Add the same proof for the Action log**

The file is `backend/src/__tests__/inv-stock-movements-filters.test.ts`. Read its existing
harness first and match its mock/auth naming rather than assuming it mirrors the report
test's conventions. Add:

```ts
  it('a date-only `occurred_to` includes that whole day', async () => {
    mockAuthAs('admin');
    await request(app)
      .get('/api/inventory/movements?occurred_to=2026-07-21')
      .set(authHeader('admin'));

    const { lte } = mockPrisma.stockMovement.findMany.mock.calls[0][0].where.occurred_at;
    expect(lte.toISOString()).toBe('2026-07-21T23:59:59.999Z');
  });
```

Then run it:

```bash
npm test --workspace=backend -- src/__tests__/inv-stock-movements-filters.test.ts
```

- [ ] **Step 7: Revert-check both**

Revert `to: inclusiveEndOfDay` back to `z.coerce.date().optional()` in
`inventoryUsageQuerySchema`. Re-run both test files. Expected: the two new tests FAIL.
Restore. Re-run. Expected: PASS.

- [ ] **Step 8: Run the full backend suite and typecheck**

```bash
npm test --workspace=backend
npm run build --workspace=backend
```

Expected: 0 failures, build exit 0. **If any pre-existing report test fails, read it before
changing it** — a report asserting the old exclusive bound is asserting the bug, and its
fixture dates must be re-read to confirm which behaviour is correct. Record every such test
touched, and why, in the PR body.

- [ ] **Step 9: Commit and open PR A**

```bash
git add -A
git commit -m "fix(reports): make a date-only upper date bound inclusive of its day

A date-only \`to\` ('2026-07-21') coerced to 00:00:00.000Z, making the bound
exclusive of the day it names. Every report preset sends a date-only \`to\` of
today, so the entire current day was hidden from every report — surfaced by the
Logistic Orders QA pass, where same-day LO consumption never appeared in
Inventory Usage.

Applied at the three boundaries that take an upper date bound: baseFilterSchema.to,
inventoryUsageQuerySchema.to, listMovementsQuerySchema.occurred_to. The lower bound
is deliberately left as z.coerce.date() — midnight is already the correct inclusive
start of a day."
git push -u origin lo-qa-fix
```

Open the PR against `staging`. The body must state the blast radius plainly: jobs, leads,
estimates, invoices, revenue, payments, activity, AR-aging, inventory-usage and the stock
Action log all begin including the current day, so **their numbers will change**.

---

# PR B — LO drill-through in the stock Action log

> Cut a fresh branch from `staging` for this PR so it is independently revertable:
> `git checkout -b lo-drill-through origin/staging`

### Task B1: Plumb `logisticOrderId` through the data layer

**Files:**
- Modify: `frontend/src/lib/api/_mock/inventory/inventory.ts` (the `Movement` type)
- Modify: `frontend/src/lib/api/inventory.ts` (`MovementFilters`, `useMovements`)
- Test: `frontend/src/__tests__/inventory-action-log.test.tsx`

**Interfaces:**
- Consumes: the server already returns `logisticOrderId` / `logisticOrderNumber` on every
  movement row (`inv-stock.controller.ts` `mapMovement`) and already accepts
  `logistic_order_id` (`listMovementsQuerySchema`). No backend change.
- Produces: `MovementFilters.logisticOrderId?: string` and the two new `Movement` fields,
  consumed by Tasks B2 and B3.

- [ ] **Step 1: Write the failing test**

Test `useMovements` directly rather than through `ActionLogView`, so this task has a
genuine red before the UI exists. Create
`frontend/src/__tests__/use-movements-lo-filter.test.tsx`:

```tsx
/**
 * useMovements → logistic_order_id. The movements endpoint has accepted this
 * filter since LO-2, but nothing in the frontend could send it.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderHook, waitFor } from '@testing-library/react';
import api from '@/lib/axios';
import { useMovements } from '@/lib/api/inventory';
import { createTestQueryClient } from './helpers';
import { QueryClientProvider } from '@tanstack/react-query';

const mockApi = vi.mocked(api);

function wrapper({ children }: { children: React.ReactNode }) {
  return (
    <QueryClientProvider client={createTestQueryClient()}>{children}</QueryClientProvider>
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  mockApi.get.mockResolvedValue({ data: { data: [], meta: {} } });
});

describe('useMovements — Logistic Order filter', () => {
  it('sends logistic_order_id when logisticOrderId is set', async () => {
    renderHook(() => useMovements({ logisticOrderId: 'lo-uuid-1' }), { wrapper });
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    expect(mockApi.get.mock.calls[0][1]!.params.logistic_order_id).toBe('lo-uuid-1');
  });

  it('omits the key entirely when it is unset', async () => {
    renderHook(() => useMovements({}), { wrapper });
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());
    expect(mockApi.get.mock.calls[0][1]!.params.logistic_order_id).toBeUndefined();
  });
});
```

Check `frontend/src/__tests__/helpers.tsx` for the actual exported name of the query-client
factory and match it; if it is not exported, construct a `new QueryClient` with retries
disabled inline.

- [ ] **Step 2: Run it and confirm the FIRST test fails**

```bash
npm test --workspace=frontend -- src/__tests__/use-movements-lo-filter.test.tsx
```

Expected: the first test FAILS (`logistic_order_id` is `undefined` — `useMovements` does
not forward it yet); the second passes. Do not proceed until you have seen that failure.

- [ ] **Step 3: Add the two fields to the `Movement` type**

In `frontend/src/lib/api/_mock/inventory/inventory.ts`, in `export type Movement = {`,
after the `invoiceNumber?: string;` line:

```ts
  invoiceId?: string;
  invoiceNumber?: string;
  /** §14 H2: which Logistic Order issued these units (server-joined). */
  logisticOrderId?: string;
  logisticOrderNumber?: string;
```

- [ ] **Step 4: Add the filter field and param mapping**

In `frontend/src/lib/api/inventory.ts`, in `export type MovementFilters = {`, after
`jobId?: string;`:

```ts
  jobId?: string;
  /** Drill-through: show only the movements a single Logistic Order posted. */
  logisticOrderId?: string;
```

In `useMovements`, in the `params` object, after `job_id: filters.jobId,`:

```ts
            job_id: filters.jobId,
            logistic_order_id: filters.logisticOrderId,
```

- [ ] **Step 5: Typecheck**

```bash
cd frontend && npx tsc --noEmit
```

Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add frontend/src/lib/api/inventory.ts frontend/src/lib/api/_mock/inventory/inventory.ts frontend/src/__tests__/inventory-action-log.test.tsx
git commit -m "feat(inventory): plumb logisticOrderId through the movements data layer"
```

---

### Task B2: Deep-linkable LO filter + chip + link column in ActionLogView

**Files:**
- Modify: `frontend/src/components/inventory/ActionLogView.tsx`
- Test: `frontend/src/__tests__/inventory-action-log.test.tsx`

**Interfaces:**
- Consumes: `MovementFilters.logisticOrderId` and `Movement.logisticOrderId` /
  `.logisticOrderNumber` from Task B1.
- Produces: the URL contract `/inventory/activity?lo=<uuid>`, consumed by Task B3.

- [ ] **Step 1: Write the failing tests**

Add to `frontend/src/__tests__/inventory-action-log.test.tsx`. The file renders via
`renderWithProviders`; confirm how it supplies a router and set the initial URL the same
way (read the helper before writing this):

```ts
  it('reads ?lo= from the URL, filters by it, and shows a dismissible chip', async () => {
    renderWithProviders(<ActionLogView />, { initialEntries: ['/inventory/activity?lo=lo-uuid-1'] });

    await waitFor(() => {
      const params = mockApi.get.mock.calls.find(
        (c) => c[0] === '/api/inventory/movements',
      )![1]!.params;
      expect(params.logistic_order_id).toBe('lo-uuid-1');
    });

    expect(screen.getByText(/LO-J00224-1/)).toBeInTheDocument();
  });

  it('CSV export honours the job and LO filters it claims to snapshot', async () => {
    renderWithProviders(<ActionLogView />, { initialEntries: ['/inventory/activity?lo=lo-uuid-1'] });
    await waitFor(() => expect(mockApi.get).toHaveBeenCalled());

    await userEvent.click(screen.getByRole('button', { name: /export/i }));

    await waitFor(() => {
      const exportCall = mockApi.get.mock.calls
        .filter((c) => c[0] === '/api/inventory/movements')
        .at(-1)!;
      expect(exportCall[1]!.params.logistic_order_id).toBe('lo-uuid-1');
      expect(exportCall[1]!.params.limit).toBe(100);
    });
  });
```

The rendered chip text comes from the first returned row's `logisticOrderNumber`, so add
`logisticOrderId: 'lo-uuid-1'` and `logisticOrderNumber: 'LO-J00224-1'` to the `MOVES`
fixture at the top of that file.

- [ ] **Step 2: Run and confirm both fail**

```bash
npm test --workspace=frontend -- src/__tests__/inventory-action-log.test.tsx
```

Expected: FAIL — `logistic_order_id` is `undefined`, and the chip text is not found.

- [ ] **Step 3: Read the URL param**

In `ActionLogView.tsx`, extend the react-router import:

```ts
import { Link, useSearchParams } from "react-router-dom";
```

Inside `ActionLogView()`, above the existing `useState` calls:

```ts
  const [searchParams, setSearchParams] = useSearchParams();
  const logisticOrderId = searchParams.get("lo") ?? undefined;
```

Add it to the `filters` memo — both the object and the dependency array:

```ts
  const filters = useMemo<MovementFilters>(
    () => ({
      type: type === "all" ? undefined : type,
      itemId: itemId === "all" ? undefined : itemId,
      locationId: locationId === "all" ? undefined : locationId,
      actorUserId: actorUserId === "all" ? undefined : actorUserId,
      occurredFrom: occurredFrom || undefined,
      occurredTo: occurredTo || undefined,
      logisticOrderId,
    }),
    [type, itemId, locationId, actorUserId, occurredFrom, occurredTo, logisticOrderId],
  );
```

- [ ] **Step 4: Fix the CSV export params**

In `handleExport`, the params object currently omits `job_id` despite the file's own comment
promising it snapshots "the currently-filtered view". This is not a reachable bug today —
`ActionLogView` has no job filter control, so `filters.jobId` is always `undefined` — but
`logistic_order_id` (which IS reachable, via the new drill-through) belongs in the same
params object, so add `job_id` alongside it to mirror `useMovements` and future-proof the
export if a job filter is ever added here. Add both keys:

```ts
        params: {
          type: filters.type,
          item_id: filters.itemId,
          location_id: filters.locationId,
          job_id: filters.jobId,
          logistic_order_id: filters.logisticOrderId,
          actor_user_id: filters.actorUserId,
          occurred_from: filters.occurredFrom,
          occurred_to: filters.occurredTo,
          page: 1,
          limit: 100,
        },
```

- [ ] **Step 5: Render the chip**

Directly above the results table, render when `logisticOrderId` is set. The label prefers the
first row's joined `logisticOrderNumber` and degrades to a generic label rather than printing
a raw UUID at the user:

```tsx
      {logisticOrderId && (
        <div className="flex items-center gap-2 px-6 py-2">
          <span className="inline-flex items-center gap-2 rounded-control border border-border bg-primary-subtle px-3 py-1 text-sm text-text-primary">
            Filtered to {rows[0]?.logisticOrderNumber ?? "one Logistic Order"}
            <button
              type="button"
              aria-label="Clear Logistic Order filter"
              className="text-text-secondary hover:text-text-primary"
              onClick={() => {
                const next = new URLSearchParams(searchParams);
                next.delete("lo");
                setSearchParams(next, { replace: true });
                resetPage();
              }}
            >
              ×
            </button>
          </span>
        </div>
      )}
```

- [ ] **Step 6: Render the LO as a link in each row**

In the row cell that currently renders the job link, add the LO beneath it so the ledger
shows which document moved the stock:

```tsx
                  <td className="px-4 py-2.5">
                    {m.jobId ? (
                      <Link to={`/jobs/${m.jobId}`} className="font-medium text-primary hover:underline">
                        {m.jobNumber ?? "Job"}
                      </Link>
                    ) : (
                      <span className="text-text-secondary">—</span>
                    )}
                    {m.logisticOrderId && (
                      <Link
                        to={`/inventory/activity?lo=${m.logisticOrderId}`}
                        className="mt-0.5 block font-mono text-[11px] text-text-secondary hover:text-primary hover:underline"
                      >
                        {m.logisticOrderNumber ?? "Logistic Order"}
                      </Link>
                    )}
                  </td>
```

- [ ] **Step 7: Run the tests and confirm they pass**

```bash
npm test --workspace=frontend -- src/__tests__/inventory-action-log.test.tsx
```

Expected: PASS, all tests in the file including the pre-existing ones.

- [ ] **Step 8: Revert-check**

Remove `logisticOrderId,` from the `filters` memo. Re-run. Expected: the URL-param test
FAILS. Restore. Separately, remove `logistic_order_id` from the export params. Expected:
the export test FAILS. Restore. Re-run: PASS.

- [ ] **Step 9: Commit**

```bash
git add frontend/src/components/inventory/ActionLogView.tsx frontend/src/__tests__/inventory-action-log.test.tsx
git commit -m "feat(inventory): deep-linkable Logistic Order filter in the stock Action log

The movements endpoint has accepted logistic_order_id since LO-2 and returns
logisticOrderNumber on every row, but nothing in the UI could reach it. The Action
log now reads ?lo= from the URL, shows a dismissible chip, and renders each row's
LO as a link.

Also adds job_id to the CSV export params, which documented itself as
snapshotting the currently filtered view but omitted it. Not a reachable bug —
this view has no job filter control — but it mirrors useMovements and
future-proofs the export alongside the logistic_order_id addition."
```

---

### Task B3: "View stock activity" link on the LO detail sheet

**Files:**
- Modify: `frontend/src/components/inventory/lo/LODetailSheet.tsx`
- Test: `frontend/src/__tests__/lo-detail.test.tsx`

**Interfaces:**
- Consumes: the `/inventory/activity?lo=<id>` URL contract from Task B2.
- Produces: nothing downstream.

- [ ] **Step 1: Write the failing test**

Add to `frontend/src/__tests__/lo-detail.test.tsx`, following that file's existing render
helper and fixture conventions (read them first):

```ts
  it('a PROCESSED order links to its stock activity; a DRAFT does not', async () => {
    renderSheet({ status: 'PROCESSED' });
    const link = await screen.findByRole('link', { name: /view stock activity/i });
    expect(link).toHaveAttribute('href', expect.stringContaining('/inventory/activity?lo='));
  });
```

Add a second case asserting a `DRAFT` order renders no such link — a DRAFT has posted no
movements, so the link would lead to an empty log.

- [ ] **Step 2: Run and confirm it fails**

```bash
npm test --workspace=frontend -- src/__tests__/lo-detail.test.tsx
```

Expected: FAIL — no matching role/name.

- [ ] **Step 3: Render the link**

`Link` is already imported in this file. Render it only for statuses that have actually
posted movements — `PROCESSED` and `RETURNED`:

```tsx
              {(lo.status === 'PROCESSED' || lo.status === 'RETURNED') && (
                <Link
                  to={`/inventory/activity?lo=${lo.id}`}
                  className="text-sm font-medium text-primary hover:underline"
                >
                  View stock activity
                </Link>
              )}
```

Place it in the sheet's metadata area near the status badge. Read the surrounding JSX and
match its spacing idiom rather than pasting this block blind.

- [ ] **Step 4: Run and confirm it passes**

```bash
npm test --workspace=frontend -- src/__tests__/lo-detail.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Revert-check**

Change the status condition to `false &&`. Expected: the PROCESSED test FAILS. Restore.
Re-run: PASS. **Then `grep -rn "false &&" frontend/src/components/inventory` and confirm
zero residue before committing** — a neutered guard was accidentally left in the tree once
already in this program.

- [ ] **Step 6: Full frontend suite and typecheck**

```bash
npm test --workspace=frontend
cd frontend && npx tsc --noEmit
```

Expected: 0 failures, exit 0.

- [ ] **Step 7: Commit and open PR B**

```bash
git add -A
git commit -m "feat(inventory): link a processed Logistic Order to its stock activity"
git push -u origin lo-drill-through
```

Open against `staging`.

---

# Part C — QA closure

### Task C1: Scenario 3 — verify existing coverage, do not duplicate it

**Files:** none modified.

The automated coverage for scenario 3 **already exists**. Confirm it, do not rewrite it:

| Assertion | Location |
|---|---|
| SALES gets 403 on `POST /api/logistic-orders/:id/approve` | `backend/src/__tests__/logistic-orders.test.ts:643` |
| An approve capability override flips SALES to 200 | same file, next test |
| `approve` is capability-only — no role can ever hold it | `backend/src/__tests__/permissions-logistic-orders.test.ts:50` |
| SALES holds exactly read/create/submit | same file, `:111` |
| SALES sees a locked picker + notes on an existing DRAFT | `frontend/src/__tests__/lo-detail.test.tsx:278` |

- [ ] **Step 1: Run them and capture the evidence**

```bash
npm test --workspace=backend -- src/__tests__/logistic-orders.test.ts src/__tests__/permissions-logistic-orders.test.ts
npm test --workspace=frontend -- src/__tests__/lo-detail.test.tsx
```

Expected: PASS. Record the counts for the QA report.

- [ ] **Step 2: Hand off the live UI pass**

The agent cannot authenticate as another user. Ask Ran to log into `sales@alphacrm.com` on
staging, then drive the UI to confirm: the LO list is visible, create works, the existing-LO
sheet is read-only, and no Approve button renders. Report what is actually observed.

---

### Task C2: Scenario 8 — invoice void unwinds a processed LO

**Files:** none modified — this is live QA against staging.

Verified precondition: **no invoice in the test org is currently linked to an LO**, so this
scenario has never had data to run against. Build it.

- [ ] **Step 1: Build the fixture live in the browser as admin**

Create a job → create an LO anchored to it → add a tracked line with a known quantity →
Process it. Record the LO number and the item's on-hand before and after.

- [ ] **Step 2: Create and void the invoice**

Create an invoice from that job, then void it.

- [ ] **Step 3: Verify in the UI**

The LO should show `RETURNED`, and the item's on-hand should be back to its pre-process
value.

- [ ] **Step 4: Verify in the database (read-only)**

Use a read-only probe script — **SELECT statements only, never a write**:

```sql
SELECT l.number, l.status, m.type, m.qty, m.occurred_at
FROM logistic_orders l
LEFT JOIN stock_movements m ON m.logistic_order_id = l.id
WHERE l.number = '<the LO number>'
ORDER BY m.occurred_at;
```

Expected: status `RETURNED`, with a `consume` row and a matching `return` row of equal
quantity.

- [ ] **Step 5: Report**

If the LO does not unwind, that is a third defect — stop, capture the evidence, and report
it rather than fixing it inline.

---

## Definition of done

- [ ] PR A open against `staging`, CI green, blast radius stated in the body.
- [ ] PR B open against `staging`, CI green.
- [ ] Every new test revert-checked, with both outcomes recorded in the PR body.
- [ ] `grep -rn "false &&"` over touched directories returns no new residue.
- [ ] Scenario 3 existing-coverage evidence captured; live UI pass handed to Ran.
- [ ] Scenario 8 run end-to-end with DB confirmation, or its failure reported.
- [ ] No migration added. No AI attribution in any commit or PR body.
