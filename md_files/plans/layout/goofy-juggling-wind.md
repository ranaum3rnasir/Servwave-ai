# Plan: Sidebar Nav Hover — Slide Right Animation

## Context
Add a subtle `translateX` nudge on hover to nav items in the left sidebar. Hardware-accelerated, no layout shift, coloring unchanged. Only non-active items slide (active item is already visually prominent).

## File to Modify
`frontend/src/components/layout/Sidebar.tsx` — one line change

## The Change

**Current** `NavLink` className (line 69):
```
'group flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm font-medium transition-colors',
```

**Updated**:
```
'group flex items-center gap-3 rounded-lg px-4 py-2.5 text-sm font-medium transition duration-200',
```

And in the inactive branch (line 72), add `hover:translate-x-1.5`:
```
'text-text-secondary hover:bg-background-light hover:text-text-primary hover:translate-x-1.5'
```

### Why `transition` instead of `transition-colors`
Tailwind's `transition-colors` only transitions color-related properties. `transition` (no suffix) includes `transform` in its property list — so it covers both color and the translateX in one utility. Duration `200ms` matches the user's spec.

### Why `translate-x-1.5`
Tailwind's spacing scale: `1.5` = `0.375rem` = **6px** at base font size — exactly matching the spec's `translateX(6px)`.

### No change to active state
Active items (`bg-primary text-white shadow-sm`) deliberately do NOT get the translate — they're already the selected state.

### Collapsed sidebar
When collapsed, items still render as `NavLink` with the same className, so the animation applies automatically. The small nudge is fine in collapsed mode too.

## Verification
Run `npm run dev:frontend`, open the sidebar, hover non-active nav items — expect a smooth 6px rightward slide. Active item stays still.

---

# Plan: Customer List & Detail Page Redesign

## Context
The current Customers screens are functional but bare — a basic DataTable and a 3-card detail page. Before moving into Step 5 (Estimates), we're redesigning the Customer screens to be UX-oriented and distinctive, inspired by FSM leaders (Jobber, Workiz, Housecall Pro). This is **primarily a frontend-only change**. No new API endpoints. One minor optional backend filter addition.

---

## Files to Modify
- `frontend/src/pages/CustomersPage.tsx` — enhanced list
- `frontend/src/pages/CustomerDetailPage.tsx` — full redesign
- `backend/src/controllers/customer.controller.ts` — add `ad_source` query filter (minor, 3 lines)

## Files NOT Changed
- `CustomerFormDialog.tsx`, `LocationFormDialog.tsx` — forms untouched
- All shadcn/ui components — used as-is
- All backend routes, middleware, tests

---

## API Constraints (Confirmed)
- **List endpoint** — already returns `ad_source` per customer (just not in the TS interface)
- **Detail endpoint** — returns `leads[]` (last 10 only, `take: 10`) + `_count.leads` + `_count.jobs`. Does NOT return a `jobs[]` array.
- **Open Leads count** — computed client-side from the leads array (status NOT IN [WON, LOST])
- **Jobs tab** — shows a placeholder with count only; full job history comes in Step 6

---

## Part 1: CustomersPage — Enhanced List

### Changes
1. **Extend `Customer` interface** — add `ad_source?: string | null`
2. **Add `adSource` filter state** — wire into query params; reset page on change
3. **Add backend filter** — 3-line addition to `listCustomers` controller: if `ad_source` query param exists, add `WHERE ad_source = $param` to the Prisma query
4. **Add helper functions** — `getInitials(first, last)` + `AD_SOURCE_STYLES` color map + `getAdSourceStyle(source)`
5. **Replace column definitions** with 7 improved columns:
   | # | Column | Change |
   |---|--------|--------|
   | 1 | Customer | Avatar circle (initials, blue bg) + Name bold + email subtext |
   | 2 | Phone | Unchanged |
   | 3 | Company | `—` dash when empty |
   | 4 | Source | Colored badge (Google=blue, Facebook=indigo, Referral=green, Yelp=red, Instagram=pink, Other=gray) |
   | 5 | Leads | Count pill — blue when >0, gray when 0 |
   | 6 | Jobs | Count pill — green when >0, gray when 0 |
   | 7 | Member Since | `"Feb 2026"` formatted date |
6. **Page header** — `<h1>Customers</h1>` + total count badge above the DataTable
7. **Ad Source filter** — `<Select>` dropdown passed as `filters` prop to DataTable (same pattern as LeadsPage status filter)

### New Imports (list page)
```
Avatar, AvatarFallback — @/components/ui/avatar
Badge — @/components/ui/badge
Select, SelectContent, SelectItem, SelectTrigger, SelectValue — @/components/ui/select
cn — @/lib/utils
```

---

## Part 2: CustomerDetailPage — Full Redesign

### New Layout: 3 Zones

```
┌─────────────────────────────────────────────────────┐
│  HERO HEADER (full width card)                      │
│  [Avatar 64px] Name / Company / Phone+Email         │
│  [Edit] [Delete]                    (right side)    │
│  ─────────────────────────────────────────          │
│  Total Leads │ Open Leads │ Total Jobs │ Member Since│
└─────────────────────────────────────────────────────┘
┌──────────────────┐  ┌─────────────────────────────── ┐
│  LEFT SIDEBAR    │  │  TABS: Activity / Leads /      │
│  (w-80, 320px)   │  │        Jobs / Notes            │
│                  │  │                                 │
│  Contact Details │  │  Activity: Timeline feed of     │
│  ─ phone(s)      │  │    lead events (newest first)   │
│  ─ email         │  │                                 │
│  ─ company       │  │  Leads: Table (status, request, │
│  ─ ad source     │  │    assigned, date) clickable    │
│  ─ billing/tax   │  │                                 │
│                  │  │  Jobs: Placeholder with count   │
│  Service         │  │                                 │
│  Locations       │  │  Notes: "Coming soon"           │
│  (existing logic)│  │                                 │
└──────────────────┘  └─────────────────────────────────┘
```

### Hero Header Details
- 64px initials `Avatar` (blue bg, white text)
- Name (`text-2xl font-semibold`) + company (`text-sm text-secondary`)
- Inline phone + email with icons
- Edit/Delete buttons right-aligned (existing logic, no permission change)
- `<Separator>` then 4-column KPI grid:
  - **Total Leads** — `customer._count.leads`
  - **Open Leads** — `leads.filter(l => !['WON','LOST'].includes(l.status)).length` (from leads array)
  - **Total Jobs** — `customer._count.jobs`
  - **Member Since** — `"Feb 2026"` formatted

### Left Sidebar — Contact Details Card
- Phone (primary + ext), Secondary phone (if present), Email (if present), Company (if present)
- Separated section for: Ad Source badge, Allow Billing (✓ yes / — no), Tax Exempt (✓ yes / — no)
- Entire metadata section hidden if all three are absent

### Left Sidebar — Service Locations Card
- Identical logic to current — just moved into sidebar column

### Main Content — Tabs (underline style, not pill)
`TabsList` override: `bg-transparent`, `rounded-none`, `border-b-2` with `data-[state=active]:border-primary`

**Activity tab (default):**
- Builds unified item list from `leads[]` array, sorted newest-first
- Vertical timeline with left border + dots
- Each item: label (service_request truncated to 60 chars), StatusBadge, date
- Empty state if no leads

**Leads tab:**
- Plain `<table>` (not DataTable) — simpler for embedded view
- Columns: Status badge, Service Request (truncated 70 chars), Assigned To, Date
- Click row → `navigate(/leads/:id)`
- Footer note: "Showing up to 10 most recent leads"
- Empty state if no leads

**Jobs tab:**
- Placeholder only: Briefcase icon, "X Jobs", "Full job history available in Jobs module"

**Notes tab:**
- Placeholder: FileText icon, "Coming in a future update"

### Local Sub-components (defined in same file)
`ActivityFeed`, `LeadsTable`, `JobsPlaceholder`, `NotesPlaceholder` — local functions above the main component, not separate files.

### New Imports (detail page)
```
Tabs, TabsList, TabsTrigger, TabsContent — @/components/ui/tabs
Avatar, AvatarFallback — @/components/ui/avatar
Badge — @/components/ui/badge
Separator — @/components/ui/separator
cn — @/lib/utils
CheckCircle2, Briefcase, FileText — lucide-react
Building2, Mail — lucide-react (may already be present)
```

---

## Edge Cases
| Case | Handling |
|------|----------|
| No company | Omit company row everywhere |
| No email | Omit email row everywhere |
| No secondary phone | Omit that row |
| No ad_source | Omit badge; omit Source column value shows `—` |
| No service locations | "No locations added." (existing) |
| No leads | Empty states in Activity + Leads tabs |
| `_count.jobs = 0` | Jobs tab count badge hidden; placeholder shows "0 Jobs" |
| `allow_billing=false`, `tax_exempt=false`, no `ad_source` | Skip entire metadata section |

---

## Backend Change (Minor)
`customer.controller.ts` — `listCustomers` function, add to the `where` clause:
```typescript
...(ad_source ? { ad_source } : {}),
```
Read the `ad_source` from `req.query`. No new route, no schema change, no test changes needed (existing tests don't test this filter).

---

## Implementation Order
1. Backend: add `ad_source` filter to `listCustomers`
2. CustomersPage: extend interface + add helpers + replace columns
3. CustomersPage: add page header + ad_source Select filter
4. CustomerDetailPage: extend interface, compute openLeadsCount
5. CustomerDetailPage: replace header with hero header
6. CustomerDetailPage: restructure into sidebar + main layout
7. CustomerDetailPage: add tabs with all 4 tab contents
8. CustomerDetailPage: cleanup old cards/wrappers
9. TypeScript check: `npx tsc --noEmit` from `frontend/`

---

## Verification
1. Run `npm run dev:backend` + `npm run dev:frontend`
2. Navigate to `/customers` — verify: initials avatars, colored source badges, count pills, total count badge, ad source filter dropdown
3. Click a customer with data — verify: hero header renders, KPI strip shows counts, sidebar shows contact info + locations, Activity tab shows lead timeline
4. Click a customer with no leads — verify: empty states render, Open Leads = 0
5. Switch between tabs — verify: Leads table rows are clickable, Jobs shows placeholder, Notes shows placeholder
6. Run `npm test` from `backend/` — verify all 92 tests still pass
