# Plan: Phone Formatting + Leads Query Fix

## Context

Two issues spotted in the NewEstimateDialog:

1. **Phone numbers are unformatted** — "1234567890" instead of "(123) 456-7890". A `formatPhone()` utility already exists in `frontend/src/lib/utils.ts` but is only used in 2 of 8 phone display locations.

2. **Dialog shows too many leads** — Customer detail shows 1 lead, but the dialog shows 6. The backend `customer_id` filter code is correct (verified in `lead.controller.ts:178-181`), so this is almost certainly because `tsx watch` didn't hot-reload the backend after the filter was added (known gotcha). **Fix: restart backend.** No code change needed for this issue.

## Changes

### 1. Apply `formatPhone()` to all phone displays

**Utility location:** `frontend/src/lib/utils.ts:8-13` (already exists)

Files to update (add `formatPhone()` import and wrap phone values):

| File | Line(s) | Current | Fix |
|------|---------|---------|-----|
| `frontend/src/components/estimates/NewEstimateDialog.tsx` | phone display line | `{customer.phone}` | `{formatPhone(customer.phone)}` |
| `frontend/src/pages/LeadsPage.tsx` | ~80 | Raw phone | `formatPhone()` |
| `frontend/src/pages/LeadDetailPage.tsx` | ~660 | Raw phone | `formatPhone()` |
| `frontend/src/pages/CustomerDetailPage.tsx` | ~888 | Raw phone | `formatPhone()` |
| `frontend/src/pages/EstimateDetailPage.tsx` | ~231 | Raw phone | `formatPhone()` |
| `frontend/src/pages/EstimateFormPage.tsx` | ~244 | Raw phone | `formatPhone()` |

Already formatted (no change needed):
- `CustomersPage.tsx` (line 131 + 232) — already uses `formatPhone()`

### 2. Verify backend restart fixes leads issue

After implementing phone formatting, restart the backend server and verify the dialog only shows leads for the selected customer.

## Verification

1. Restart backend (`npm run dev:backend`)
2. Open Estimates page → click "New Estimate" → search for "Ohad"
3. Expand Ohad Azran → should show only 1 lead ("Test Request")
4. Verify phone shows as "(123) 456-7890" in the dialog
5. Check phone formatting on: LeadsPage, LeadDetailPage, CustomerDetailPage, EstimateDetailPage, EstimateFormPage
