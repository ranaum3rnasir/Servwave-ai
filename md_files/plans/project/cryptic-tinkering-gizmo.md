# Switch Address Autocomplete from Geoapify to Google Maps Places API

## Context
The current address autocomplete uses Geoapify REST API, but during testing the results feel unintuitive — addresses don't match expectations, suggestions are sometimes off. Switching to Google Maps Places Autocomplete will provide better US address quality and more intuitive suggestions. Google offers $200/month free credit (~70K autocomplete sessions), which is more than enough for MVP.

## Approach: REST API (no JS SDK)
Keep the same architecture — a custom `AddressAutocomplete` component calling a REST endpoint with `fetch()`. This avoids loading the Google Maps JS SDK bundle (~200KB) and keeps the implementation pattern identical to what we have today.

**API:** [Google Places Autocomplete (New)](https://developers.google.com/maps/documentation/places/web-service/autocomplete)
- Endpoint: `https://places.googleapis.com/v1/places:autocomplete`
- Auth: API key via `X-Goog-Api-Key` header
- Restricts to US addresses via `includedRegionCodes: ["us"]`
- Returns structured `addressComponents` for parsing

**Note:** After getting autocomplete predictions, we need a second call to [Place Details](https://developers.google.com/maps/documentation/places/web-service/place-details) to get the full structured address (street number, route, city, state, zip). The autocomplete response only returns place IDs and display text.

## Scope

### Files to modify (2)
1. **`frontend/src/components/ui/address-autocomplete.tsx`** — Replace Geoapify API calls with Google Places API calls. Keep the same component interface (`ParsedAddress`, `value`/`onChange`/`onSelect` props).
2. **`frontend/.env.example`** — Replace `VITE_GEOAPIFY_API_KEY` with `VITE_GOOGLE_MAPS_API_KEY`

### Files NOT changing
- `CustomerFormPage.tsx` — no changes (same component API)
- `LeadFormPage.tsx` — no changes (same component API)
- `LocationFormDialog.tsx` — no changes (same component API)
- `e2e/pages/lead-form.page.ts` — no changes (E2E tests type directly, don't use autocomplete API)
- Backend files — no changes (backend has no address autocomplete involvement)

## Implementation Plan

### Step 1: Update env config
- **`frontend/.env.example`**: Replace `VITE_GEOAPIFY_API_KEY=` with `VITE_GOOGLE_MAPS_API_KEY=`
- User adds their key to `frontend/.env` (git-ignored)

### Step 2: Rewrite `address-autocomplete.tsx`
Keep the same exports and component interface:
```typescript
// These stay identical
export interface ParsedAddress {
  address_line1: string;
  city: string;
  state: string;  // 2-letter code
  zip: string;
}

interface AddressAutocompleteProps {
  value: string;
  onChange: (value: string) => void;
  onSelect: (address: ParsedAddress) => void;
  placeholder?: string;
  className?: string;
  disabled?: boolean;
  id?: string;
}
```

**Internal changes:**
- Replace `VITE_GEOAPIFY_API_KEY` with `VITE_GOOGLE_MAPS_API_KEY`
- Replace Geoapify types with Google Places types
- **Autocomplete call:** `POST https://places.googleapis.com/v1/places:autocomplete` with body `{ input, includedRegionCodes: ["us"], languageCode: "en" }` and headers `{ "X-Goog-Api-Key": key, "Content-Type": "application/json" }`
- **Place Details call:** On selection, call `GET https://places.googleapis.com/v1/places/{placeId}` with field mask `addressComponents,formattedAddress` to get structured address
- Parse `addressComponents` to extract: `street_number` + `route` → `address_line1`, `locality` → `city`, `administrative_area_level_1` (short) → `state`, `postal_code` → `zip`
- Same debounce (300ms), same min chars (3), same dropdown UI, same fallback to plain input if no API key

### Step 3: Manual verification
- Start the frontend (`npm run dev:frontend`)
- Navigate to Create Customer page → type an address → verify suggestions appear and selecting one populates all fields
- Navigate to Create Lead page → same test
- Navigate to Edit Location dialog → same test

## Google Cloud Setup (User prerequisite)
1. Go to [Google Cloud Console](https://console.cloud.google.com)
2. Create a project (or use existing)
3. Enable "Places API (New)"
4. Create an API key (restrict to HTTP referrers for security)
5. Add key to `frontend/.env` as `VITE_GOOGLE_MAPS_API_KEY=AIza...`

## Key Design Decisions
- **REST API, no JS SDK** — keeps bundle size unchanged, same fetch-based pattern
- **Two API calls per selection** (autocomplete + place details) — this is how Google's API works; autocomplete returns predictions with place IDs, details returns structured address
- **Same component contract** — zero changes needed in any consuming component
- **Graceful degradation preserved** — if no API key, falls back to plain text input
