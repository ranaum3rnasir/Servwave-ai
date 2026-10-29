# Move Summary to Bottom + Fix Discount Column

## Context

The current layout puts totals/discount/scope notes in a sticky left sidebar. This is unintuitive — users scroll down through line items and expect to find the summary at the bottom, not look left. Industry standard (Jobber, HouseCallPro, FieldPulse — see reference screenshots) puts the summary section **below** the line items table. The Discount column header also needs fixing.

## File to modify

`frontend/src/pages/EstimateFormPage.tsx`

## Changes

### 1. Fix Discount column header
- Rename "Disc." → "Discount"
- Change alignment from `text-right` to `text-center`
- The dropdown (% / $ / —) stays left-aligned within the cell, value input appears next to it when selected

### 2. Remove the sidebar layout entirely
- Remove the `<div className="flex gap-4 items-start">` wrapper that creates the sidebar + main split
- Remove the `<div className="w-[280px] shrink-0 sticky top-4 ...">` sidebar
- Remove the separate mobile totals card (`lg:hidden`)
- Scope notes + Tax state move to a horizontal row above line items (or into the lead info banner area)

### 3. Move Scope Notes + Tax State above line items
- Single horizontal card with two fields side by side:
  ```
  [Scope Notes (textarea, flex-1)] [Tax Rate dropdown (w-[200px])]
  ```
- No separate mobile handling needed — just stack on small screens via `grid grid-cols-1 lg:grid-cols-[1fr_200px]`

### 4. Add Summary section below line items table
Based on the reference screenshots (Jobber, FieldPulse, HouseCallPro), the summary goes below the line items:

```
┌──────────────────────────────────────────────────────────────┐
│ Line Items table...                                          │
└──────────────────────────────────────────────────────────────┘

┌──────────────────────────────────────────────────────────────┐
│                                                              │
│                              Subtotal           $1,250.00    │
│                                                              │
│                    Discount  [$0.00] [$ ▾]      -$0.00       │
│                    (discount name input)                      │
│                                                              │
│                    Tax rate  [New Jersey ▾]       $82.81      │
│                                                              │
│                    ─────────────────────────────────────      │
│                              Total              $1,332.81    │
│                                                              │
│                    ─────────────────────────────────────      │
│                    Cost breakdown                             │
│                    Total Cost                    $795.00      │
│                    Profit/Margin            40.3% ($537.81)   │
│                                                              │
└──────────────────────────────────────────────────────────────┘
```

**Layout:** Right-aligned summary within the card, using `max-w-md ml-auto` to push it to the right side (like invoices).

**Summary rows (top to bottom):**
1. **Subtotal** — read-only, right-aligned
2. **Line Discounts** — shown only if > 0, orange text
3. **Discount** — editable: discount name input + type dropdown (% / $) + value input + computed amount. This is the estimate-level discount (moved from sidebar)
4. **Tax rate** — state dropdown + computed tax amount (moved from sidebar)
5. **Divider**
6. **Total** — bold, large font
7. **Divider**
8. **Cost breakdown** — Total Cost + Margin % with color coding

### 5. Move Scope Notes inline
- Scope notes moves to a collapsible section or a simple textarea above the search bar, within the main flow (no sidebar)
- Can be part of the lead info card, or its own small card above search

## Verification

1. `npx tsc --noEmit` — no new type errors
2. Visual: summary section appears below line items, not in sidebar
3. Discount controls work in summary section (type toggle + value input)
4. Tax state dropdown works in summary section
5. All totals calculate correctly (subtotal, discounts, tax, total, cost, margin)
6. Scope notes field is accessible without sidebar
7. Mobile: layout stacks naturally without separate mobile components
