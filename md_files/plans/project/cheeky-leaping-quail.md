# Fix Slow KPI Loading — Bundle API Calls & Parallelize SQL

## Context

KPI cards on the Leads page and Customer Detail page take noticeably long to load because:
1. **Leads page** makes 2 API calls (`/api/leads` + `/api/leads/stats`) — stats could be bundled into the list response
2. **Customer Detail** makes 2 API calls (`/api/customers/:id` + `/api/customers/:id/summary`) — the summary endpoint runs 3 raw SQL queries **sequentially** instead of in `Promise.all`

Goal: Each page should make **1 API call** and all DB queries should run in parallel.

---

## Step 1: Bundle lead stats into list response

**File:** `backend/src/controllers/lead.controller.ts` — `list` handler (line 151)

Current `Promise.all` runs `findMany` + `count` (2 queries). Add the 5 stat counts to the same `Promise.all`:

```
const [leads, total, totalAll, newThisWeek, unassigned, wonThisMonth, lostThisMonth] = await Promise.all([
  prisma.lead.findMany(...),
  prisma.lead.count({ where }),
  prisma.lead.count(),
  prisma.lead.count({ where: { created_at: { gte: startOfWeek } } }),
  prisma.lead.count({ where: { assigned_to: null, status: { in: ['NEW','CONTACTED','ESTIMATING'] } } }),
  prisma.lead.count({ where: { status: 'WON', updated_at: { gte: startOfMonth } } }),
  prisma.lead.count({ where: { status: 'LOST', lost_at: { gte: startOfMonth } } }),
]);
```

Response becomes:
```json
{ "leads": [...], "pagination": {...}, "stats": { "total": 42, "new_this_week": 5, ... } }
```

Copy the date math (startOfWeek, startOfMonth) from the existing `getStats` handler (line 428).

**Keep the `/stats` endpoint alive** — it's tested and may be useful standalone. No breaking change.

**File:** `frontend/src/pages/LeadsPage.tsx`

- Remove the separate `useQuery(['lead-stats'])` call
- Read stats from the main list query: `data?.stats`
- Remove `statsLoading` — use main `isLoading` for both

---

## Step 2: Parallelize customer summary SQL queries

**File:** `backend/src/controllers/customer.controller.ts` — `getSummary` handler (line 441)

Current: 3 sequential `await` calls (lines 452, 490, 507). Change to:

```
const [financialResult, estimateResult, depositResult] = await Promise.all([
  prisma.$queryRaw<...>`...financial SQL...`,
  prisma.$queryRaw<...>`...estimate SQL...`,
  prisma.$queryRaw<...>`...deposit SQL...`,
]);
```

This alone cuts summary response time by ~2/3 since the 3 independent queries run in parallel.

---

## Step 3: Bundle customer summary into detail response

**File:** `backend/src/controllers/customer.controller.ts` — `getById` handler (line ~189)

Current `Promise.all` runs customer findUnique + notes findMany. Add the 3 summary SQL queries to the same `Promise.all`:

```
const [customer, notes, financialResult, estimateResult, depositResult] = await Promise.all([
  prisma.customer.findUnique({ ... }),
  prisma.note.findMany({ ... }),
  prisma.$queryRaw`...financial...`,
  prisma.$queryRaw`...estimate...`,
  prisma.$queryRaw`...deposit...`,
]);
```

Response becomes:
```json
{ "customer": {...}, "summary": { "financials": {...}, "estimates": {...}, "deposits": {...} } }
```

**Keep the `/summary` endpoint alive** — tested, no breaking change.

**File:** `frontend/src/pages/CustomerDetailPage.tsx`

- Remove the separate `useQuery(['customer', id, 'summary'])` call
- Read summary from main query: `data?.summary`
- Remove `summaryLoading` — use main `isLoading`

---

## Step 4: Update tests

**File:** `backend/src/__tests__/leads.test.ts`
- Update `GET /api/leads` tests: mock the 5 additional `count` calls, assert `stats` in response

**File:** `backend/src/__tests__/customers.test.ts`
- Update `GET /api/customers/:id` tests: mock `$queryRaw` for the 3 summary queries, assert `summary` in response

---

## Files Modified

| File | Change |
|------|--------|
| `backend/src/controllers/lead.controller.ts` | Bundle stats into `list` handler's `Promise.all` |
| `backend/src/controllers/customer.controller.ts` | Parallelize 3 SQL queries in `getSummary`; bundle summary into `getById` |
| `frontend/src/pages/LeadsPage.tsx` | Remove separate stats query, read from list response |
| `frontend/src/pages/CustomerDetailPage.tsx` | Remove separate summary query, read from detail response |
| `backend/src/__tests__/leads.test.ts` | Update list tests for stats in response |
| `backend/src/__tests__/customers.test.ts` | Update getById tests for summary in response |

## Verification

1. `npm test --workspace=backend` — all tests pass
2. `npx tsc --noEmit` from `frontend/` — clean
3. Visual: Leads page KPI strip loads instantly with the table (single request)
4. Visual: Customer Detail KPI strip loads instantly with the hero card (single request)
