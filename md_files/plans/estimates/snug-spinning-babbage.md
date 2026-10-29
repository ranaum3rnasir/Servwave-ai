# Plan: Multi-Select Filters + Chip Relocation

## Context
The current filter popover (Option A from previous plan, already implemented) has two UX problems:
1. **Single-select only** — each category (Source, State, Payment Type) allows only 1 value. Users need multi-select (e.g., filter by Google AND Facebook simultaneously).
2. **Active filter chips are below the table** — they're rendered after `DataTable`, below pagination. Hard to see. Should be between the toolbar and the table.
3. **No "Clear all"** — when multiple filters are active, there's no quick way to reset everything.

---

## Changes (4 files)

### 1. `frontend/src/components/ui/data-table.tsx` — Add `activeFilters` prop

- Add `activeFilters?: React.ReactNode` to `DataTableProps` interface
- Render it between the toolbar `<div>` (line 120) and the table card `<div>` (line 123)
- ~5 lines added

### 2. `frontend/src/pages/CustomersPage.tsx` — Multi-select state + UI

**State shape** — convert 3 filters from `string` to `string[]`:
```
adSource: string      →  adSources: string[]
stateFilter: string   →  stateFilters: string[]
paymentType: string   →  paymentTypes: string[]
```
Boolean filters (`taxExempt`, `hasLeads`, `hasJobs`, `dateRange`) stay as `string` — they're inherently single-select.

**Toggle helper:**
```ts
const toggleFilter = (setter: React.Dispatch<React.SetStateAction<string[]>>) => (value: string) => {
  setter(prev => prev.includes(value) ? prev.filter(v => v !== value) : [...prev, value]);
  setPage(1);
};
```

**Dropdown UI** — for Source, State, Payment Type sub-menus:
- Replace `DropdownMenuItem` with `DropdownMenuCheckboxItem` (already exists in our component library, used for column visibility)
- `DropdownMenuCheckboxItem` does NOT close the menu on click (built-in Radix behavior) — perfect for multi-select
- Show selected count in sub-trigger instead of single value
- Remove "All Sources" / "All States" items; add conditional "Clear" item at bottom when selections exist

**Chips** — move from below `DataTable` into `activeFilters` prop:
- One chip per category with comma-joined values: `Source: Google, Facebook`
- Add "Clear all" ghost button at end
- Exclude search from chips (it has its own input clear)

**API params:**
```ts
params: {
  ad_source: adSources.length > 0 ? adSources : undefined,       // Axios serializes as ad_source[]=...
  state: stateFilters.length > 0 ? stateFilters : undefined,
  payment_type: paymentTypes.length > 0 ? paymentTypes : undefined,
  // boolean filters unchanged
}
```

### 3. `backend/src/controllers/customer.controller.ts` — Array param parsing

**Add helper** (top of file or inline):
```ts
function parseArrayParam(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const str = String(value);
  return str ? [str] : [];
}
```

**Parse filters:**
```ts
const adSources = parseArrayParam(req.query.ad_source);
const stateFilters = parseArrayParam(req.query.state);
const paymentTypes = parseArrayParam(req.query.payment_type);
```

**Prisma where clause** — use `{ in: [...] }`:
```ts
...(adSources.length > 0 ? { ad_source: { in: adSources } } : {}),
...(paymentTypes.length > 0 ? { payment_type: { in: paymentTypes } } : {}),
```
For state (nested in locationWhere):
```ts
if (stateFilters.length > 0) locationWhere.state = { in: stateFilters };
```

Backward compatible: `{ in: ['single'] }` behaves like `{ equals: 'single' }`.

### 4. `backend/src/__tests__/customers.test.ts` — Add multi-value filter tests

- Test multi-value `ad_source[]` builds `{ ad_source: { in: [...] } }`
- Test single-value backward compat still works
- ~15 lines added

---

## Verification
1. Open filter popover → Source sub-menu → click Google → stays open → click Facebook → both checked
2. Two chips appear above table: `Source: Google, Facebook`
3. Table filters to show only Google + Facebook customers
4. Click X on chip → removes that filter category
5. Click "Clear all" → all filters reset
6. Boolean filters (Leads, Jobs, Tax Exempt, Member Since) still single-select, unchanged behavior
7. All backend tests pass (`npm test --workspace=backend`)
