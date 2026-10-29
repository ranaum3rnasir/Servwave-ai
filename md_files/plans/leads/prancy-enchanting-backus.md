# Fix Lead Address Display & Naming Consistency

## Context
The leads list Location column shows "—" even though leads have service addresses filled in. This happens because the list query only includes `service_city` and `service_state`, but the existing E2E test leads were created before these fields were part of the form — so they're null in the DB. For **real leads** created via the form, the Location column should already work. However, we should also handle a fallback: if the lead's service address fields are empty, fall back to the customer's primary service location.

Additionally, the lead detail page has confusing naming: "Service Address" (left column, the lead's address) and "Service Locations" (right column, the customer's locations). These need clearer differentiation.

## Changes

### 1. Location column fallback — Backend (`backend/src/controllers/lead.controller.ts`)
- Add customer's primary service location to `leadListSelect` so the frontend can fall back when `service_city`/`service_state` are null:
  ```
  customer: {
    select: {
      ...,
      service_locations: { where: { is_primary: true }, take: 1, select: { city: true, state: true } }
    }
  }
  ```

### 2. Location column fallback — Frontend (`frontend/src/pages/LeadsPage.tsx`)
- Update the Location column cell: try `service_city`/`service_state` first, fall back to `customer.service_locations[0]` city/state
- Update Lead interface to include `customer.service_locations`

### 3. Rename labels on lead detail page (`frontend/src/pages/LeadDetailPage.tsx`)
- Left column: "Service Address" → **"Job Site Address"**
- Right column: "Service Locations" → **"Customer Locations"**

## Files Modified
- `backend/src/controllers/lead.controller.ts` — expand `leadListSelect` customer include
- `frontend/src/pages/LeadsPage.tsx` — Location column fallback logic + interface update
- `frontend/src/pages/LeadDetailPage.tsx` — rename 2 labels

## Verification
1. Run `npm test --workspace=backend` — all tests pass
2. Open leads list at http://localhost:5173/leads — Location column shows city/state from the customer's primary location when the lead has no service address
3. Open a lead detail page — confirm "Job Site Address" and "Customer Locations" labels
