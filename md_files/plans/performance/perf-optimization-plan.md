# Performance Optimization Plan

## Context
Pages load too slowly. Investigation found the root causes span three layers: (1) every API request is blocked by async auth overhead on both frontend and backend, (2) list endpoints fire 7-15 separate DB queries for stats, and (3) missing database indexes cause full table scans. This plan addresses all findings in priority order.

---

## Phase 1: Quick Wins (~1 day)

### 1.1 Make axios interceptor synchronous
**Files:** `frontend/src/lib/supabase.ts`, `frontend/src/lib/axios.ts`

**What:** The request interceptor at `axios.ts:10-16` calls `await supabase.auth.getSession()` on every request, blocking dispatch.

**Fix:**
- In `supabase.ts`: add a module-level `currentAccessToken` variable. Subscribe to `supabase.auth.onAuthStateChange()` to keep it updated. Also seed it with an initial `getSession()` call. Export a `getAccessToken()` getter.
- In `axios.ts:10-16`: replace the async interceptor with a sync one that reads `getAccessToken()`.
- In `axios.ts:40-43`: replace the second `getSession()` call in the 401 handler with `getAccessToken()` (already updated by the refresh that just fired).

### 1.2 Disable refetchOnWindowFocus
**File:** `frontend/src/App.tsx:28-35`

**What:** Add `refetchOnWindowFocus: false` to QueryClient default options. One line.

### 1.3 Cache backend auth verification
**File:** `backend/src/middleware/authenticate.ts`

**What:** Every request makes 2 sequential calls: `supabaseAdmin.auth.getUser(token)` (network) + `prisma.user.findUnique()` (DB). Add an in-memory `Map<token, {user, expiresAt}>` cache with 60s TTL.

**Fix:**
- Add `CachedAuth` interface and `tokenCache` Map at module level
- On cache hit: skip both Supabase and Prisma calls, use cached user directly
- On cache miss: run both calls in **parallel** via `Promise.all` (currently sequential), then cache
- Add `setInterval` every 5 min to evict expired entries
- Export `clearTokenCache(userId?)` for cache invalidation

**Cache invalidation:** Import and call `clearTokenCache()` in `backend/src/controllers/user.controller.ts` after user update/deactivate operations.

**Test fix:** Call `clearTokenCache()` in `beforeEach` of `backend/src/__tests__/middleware.test.ts` to prevent cross-test contamination.

### 1.4 Change columnResizeMode to 'onEnd'
**File:** `frontend/src/components/ui/data-table.tsx:206`

**What:** Change `'onChange'` to `'onEnd'`. One line. Stops hundreds of re-renders during column resize drag.

---

## Phase 2: Medium Effort (3-5 days)

### 2.1 Collapse stats queries with groupBy
**Files:**
- `backend/src/controllers/estimate.controller.ts:420-447`
- `backend/src/controllers/job.controller.ts:291-308`

**Estimates:** Replace 12 individual status queries (6 counts + 6 aggregates) with:
```ts
prisma.estimate.groupBy({
  by: ['status'],
  where: scopeWhere,
  _count: true,
  _sum: { total_amount: true },
})
```
Reduces 15 queries to 4 (findMany + count + groupBy + deposit aggregate). Transform the array result into the existing `{ draft: { count, value }, sent: { count, value }, ... }` response shape.

**Jobs:** Replace 5 status counts with:
```ts
prisma.job.groupBy({
  by: ['status'],
  where: scopeWhere,
  _count: true,
})
```
Reduces 7 queries to 3. Transform into existing `{ unassigned: N, scheduled: N, ... }` shape.

**Leads:** Keep as-is (heterogeneous date/null filters, not pure status grouping).

**Response format must not change** — frontend consumes existing shape.

### 2.2 Add missing database indexes
**File:** `backend/prisma/schema.prisma`

Add:
- `ServiceLocation`: `@@index([customer_id])`
- `Deposit`: `@@index([status])`
- `Payment`: `@@index([invoice_id])`
- `Customer`: `@@index([email])`, `@@index([phone])`

Run: `npx prisma migrate dev --name add_performance_indexes`

### 2.3 Eliminate auth waterfall with localStorage cache
**File:** `frontend/src/stores/auth.store.ts`

**What:** On page refresh, users see blank "Loading..." while `getSession()` + `GET /api/auth/me` complete sequentially.

**Fix:**
- Add `getCachedUser()` / `setCachedUser()` helpers using `localStorage` key `alpha_crm_user`
- Initialize store with cached user if available: `isLoading: !cachedUser`, `user: cachedUser`, `isAuthenticated: !!cachedUser`
- `checkAuth()`: skip `getSession()` entirely (fix 1.1 already handles token). Just call `/api/auth/me`. On success, update cache. On failure, clear cache and redirect.
- `login()`: call `setCachedUser(data.user)` on success
- `logout()`: call `setCachedUser(null)`

ProtectedRoute needs **no changes** — it already reads `isLoading` from the store.

### 2.4 Vite manual chunk splitting
**File:** `frontend/vite.config.ts`

Add `build.rollupOptions.output.manualChunks`:
- `vendor-react`: react, react-dom, react-router-dom
- `vendor-query`: @tanstack/react-query, @tanstack/react-table
- `vendor-radix`: @radix-ui/* packages
- `vendor-supabase`: @supabase/supabase-js
- `vendor-utils`: axios, date-fns, date-fns-tz, lucide-react, zustand

---

## Phase 3: Larger Refactors (1-2 weeks)

### 3.1 Split customer detail heavy query
**Files:** `backend/src/controllers/customer.controller.ts:239-387`, `frontend/src/pages/CustomerDetailPage.tsx`

**Backend:** Remove the `leads` include (lines 250-273) and `jobs` include (lines 274-310) from `getById()`. Keep: core fields, service_locations, _count, notes, financial aggregations.

**Frontend:** Leads/Jobs tabs fetch their own data using existing list endpoints (`/api/leads?customer_id=X`, `/api/jobs?customer_id=X`) with TanStack Query `enabled: activeTab === 'leads'` pattern.

### 3.2 DataTable virtualization
**Files:** `frontend/src/components/ui/data-table.tsx`, `frontend/package.json`

- Install `@tanstack/react-virtual`
- Add `useVirtualizer` targeting the existing scroll container (line 329)
- Virtualize only when `rows.length > 40`
- Wrap `TruncatedCell` in `React.memo`
- Hoist `TooltipProvider` to wrap the entire DataTable once (not per-cell)

### 3.3 Reactive auth via onAuthStateChange
**Files:** `frontend/src/stores/auth.store.ts`, `frontend/src/App.tsx`, new `frontend/src/lib/auth-listener.ts`

Replace the `useEffect(() => checkAuth())` in App.tsx with a centralized `onAuthStateChange` listener that drives the Zustand store. Handles `SIGNED_OUT`, `SIGNED_IN`, `TOKEN_REFRESHED`, `INITIAL_SESSION` events. Enables cross-tab auth sync.

---

## Verification

### After Phase 1:
- `npm test --workspace=backend` — all 501+ tests pass
- Login/logout flow works
- Network tab: requests fire without async delay between them
- Tab switching no longer triggers refetches
- Column resize is smooth (no jank during drag)

### After Phase 2:
- `npm test --workspace=backend` — all tests pass
- `npx prisma migrate dev` succeeds, migration SQL contains expected CREATE INDEX
- Estimates page loads with correct stats (compare before/after values)
- Jobs page loads with correct stats
- Page refresh shows app instantly (no loading flash for returning users)
- `npm run build` produces multiple vendor chunks in `dist/assets/`

### After Phase 3:
- Customer detail page loads faster, tabs lazy-load data on click
- Large tables (100 rows) scroll smoothly
- Auth state syncs across browser tabs
- Full E2E suite passes: `npx playwright test --config=e2e/playwright.config.ts`
