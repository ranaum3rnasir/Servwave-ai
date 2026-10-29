# Plan: Add Price Book Item Thumbnails to Estimate Line Items

## Context
Price book items can have images (uploaded to Supabase Storage, stored as `image_url` on `PriceBookItem`). Estimate line items already have an FK (`price_book_item_id`) linking to their source price book item. Currently, no image is shown anywhere in the estimate flow. We want to display a small thumbnail next to each line item that was sourced from the price book, across all three estimate pages.

## Scope
- Show a thumbnail (from `PriceBookItem.image_url`) next to each line item on:
  1. **EstimateFormPage** (edit/create form)
  2. **EstimateDetailPage** (read-only detail)
  3. **PublicEstimatePage** (customer-facing)
- Items without a price book source (manually typed) show a placeholder icon
- No schema changes needed — `EstimateLineItem.price_book_item_id` → `PriceBookItem.image_url` relation already exists in Prisma

## Changes

### 1. Backend: Include `image_url` in estimate responses
**File:** `backend/src/controllers/estimate.controller.ts`

- **`estimateDetailSelect`** (~line 94-111): In the `line_items.select`, add a nested `price_book_item` select:
  ```ts
  price_book_item: { select: { image_url: true } },
  ```

- **`estimatePublicSelect`** (~line 140-155): Same — add nested `price_book_item` with `image_url`. Note: `unit_cost` is already excluded from public; `image_url` is safe to expose.

### 2. Frontend: EstimateFormPage (form view)
**File:** `frontend/src/pages/EstimateFormPage.tsx`

- **Form schema** (~line 27-32): Add `image_url: z.string().nullable().optional()` to `lineItemSchema` (client-side only, not submitted to API)
- **Edit mode data population** (~line 128-133): When populating form from `estimateData`, extract `price_book_item?.image_url` into each line item's `image_url` field
- **Grid columns** (~line 391): Update `grid-cols-[40px_1fr_100px_120px_80px_80px_40px]` → add a 48px column after the `#` column for thumbnail: `grid-cols-[40px_48px_1fr_100px_120px_80px_80px_40px]`
- **Header row** (~line 372-380): Add empty header cell for the thumbnail column
- **Line item rows** (~line 382-447): After the sequence `#` cell, add a thumbnail cell:
  - If `image_url` exists: render a 36x36 rounded image
  - Otherwise: render a small `Package` or `ImageOff` icon from Lucide as placeholder

### 3. Frontend: EstimateDetailPage (read-only)
**File:** `frontend/src/pages/EstimateDetailPage.tsx`

- **Type definition** (~line 346): Expand the inline type to include `price_book_item?: { image_url?: string | null }`
- **Table header** (~line 335-343): Add a narrow `<th>` after `#` for the image column (no label, just width)
- **Table body** (~line 346-355): Add `<td>` after sequence cell with thumbnail or placeholder

### 4. Frontend: PublicEstimatePage (customer-facing)
**File:** `frontend/src/pages/PublicEstimatePage.tsx`

- **Interface** (~line 31-39): Add `price_book_item?: { image_url?: string | null }` to the `line_items` array type
- **Table header** (~line 176-183): Add narrow `<th>` after `#`
- **Table body** (~line 186-194): Add `<td>` after sequence cell with thumbnail or placeholder

## Thumbnail Cell Pattern (reuse across all 3 pages)
```tsx
{/* 36x36 thumbnail */}
{li.price_book_item?.image_url ? (
  <img
    src={li.price_book_item.image_url}
    alt=""
    className="h-9 w-9 rounded object-cover"
  />
) : (
  <div className="h-9 w-9 rounded bg-gray-100 flex items-center justify-center">
    <Package className="h-4 w-4 text-gray-400" />
  </div>
)}
```

## Files Modified (5 total)
1. `backend/src/controllers/estimate.controller.ts` — 2 select objects
2. `frontend/src/pages/EstimateFormPage.tsx` — schema, grid, data population, cells
3. `frontend/src/pages/EstimateDetailPage.tsx` — type, header, body
4. `frontend/src/pages/PublicEstimatePage.tsx` — interface, header, body

## Verification
1. Type-check: `npx tsc --noEmit` from `frontend/`
2. Open an estimate that has price-book-sourced line items → verify thumbnails appear on Detail page
3. Click Edit → verify thumbnails appear on Form page
4. Send the estimate → open public link → verify thumbnails appear
5. Create a new estimate with manually-typed items → verify placeholder icons appear
6. Backend tests: `npm test --workspace=backend` — ensure no regressions
