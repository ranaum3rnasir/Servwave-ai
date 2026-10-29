# Plan: Add Time Filtering to Estimates Screen

## Context

The Estimates page currently filters by Status (multi-select) and Created By (single-select). The user wants to add time-based filtering. The CustomersPage already implements this exact pattern — a "Member Since" single-select dropdown with preset options (Last 30 days, Last 90 days, Last year). We'll reuse that approach for Estimates.

---

## Step 1: Backend — Add `created_after` query param to estimate `list()`

**Edit:** `backend/src/controllers/estimate.controller.ts` — `list()` handler (~line 232)

Add after `createdByFilter`:
```typescript
const createdAfter = (req.query.created_after as string) || '';
```

Add to `where` clause (before search):
```typescript
if (createdAfter) {
  where.created_at = { gte: new Date(createdAfter) };
}
```

**Pattern reuse:** Identical to `customer.controller.ts` lines 114, 146-149.

---

## Step 2: Frontend — Add date range filter to EstimatesPage

**Edit:** `frontend/src/pages/EstimatesPage.tsx`

1. Add state: `const [dateRange, setDateRange] = useState('');`

2. Add constants:
```typescript
const DATE_RANGE_OPTIONS = [
  { value: '30', label: 'Last 30 days' },
  { value: '90', label: 'Last 90 days' },
  { value: '365', label: 'Last year' },
];
const DATE_LABELS: Record<string, string> = { '30': 'Last 30 days', '90': 'Last 90 days', '365': 'Last year' };
```

3. Add `dateRange` to query key and compute `created_after` param:
```typescript
created_after: dateRange ? new Date(Date.now() - Number(dateRange) * 86400000).toISOString() : undefined,
```

4. Add "Date Range" `DropdownMenuSub` inside the Filter dropdown (after Created By):
   - "All Time" option clears the filter
   - 3 preset options with checkmark indicator
   - Same single-select pattern as Created By / Customer's Member Since

5. Update `activeFilterCount` to include `dateRange`
6. Update `clearAllFilters` to reset `dateRange`
7. Add `FilterChip` for active date range

---

## Step 3: Backend tests

**Edit:** `backend/src/__tests__/estimates.test.ts`

Add 1 test:
- `created_after` filter applies `gte` to `where.created_at`

---

## Step 4: Run tests

```bash
npm test --workspace=backend
```

---

## Files Modified

| File | Change |
|------|--------|
| `backend/src/controllers/estimate.controller.ts` | Add `created_after` param to `list()` where clause |
| `frontend/src/pages/EstimatesPage.tsx` | Add Date Range filter (state, dropdown, chip, query param) |
| `backend/src/__tests__/estimates.test.ts` | Add `created_after` filter test |

## Verification

1. `npm test --workspace=backend` — all tests pass
2. Open Estimates page → Filter → Date Range → select "Last 30 days" → table filters, chip appears
3. "Clear all" resets the date filter
