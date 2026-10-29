# Plan: CustomerDetailPage UX Enhancements

## Context
The CustomerDetailPage has several UX issues: duplicate contact info (phone/email/company shown in both hero header AND sidebar), Edit/Delete buttons are too prominent while primary actions (+New Lead) are missing, KPI metrics have inconsistent color treatment, and the activity timeline uses generic circles instead of meaningful icons. These changes improve information hierarchy, reduce redundancy, and add action-oriented CTAs.

---

## Changes

### 1. Hero Header — Remove duplicate contact info, add primary CTAs

**Current:** Avatar + name + phone/email inline + Edit/Delete buttons
**New:** Avatar + name + company (keep) + ad source badge. Remove phone/email from header (already shown in sidebar Contact Details).

**Action buttons restructured:**
- Primary: `+ New Lead` button (navigates to `/leads/new?customer=${id}`)
- Secondary: `Edit` outline button (navigates to `/customers/${id}/edit`)
- Overflow: 3-dot `DropdownMenu` with "Delete Customer" (danger) option
  - Uses existing `frontend/src/components/ui/dropdown-menu.tsx`
  - Import: `DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuTrigger`
  - Add `MoreHorizontal` icon from lucide-react

### 2. KPI Strip — Consistent color treatment

**Current:** Open Leads uses `text-primary` (blue), all others use `text-text-primary` (black) — inconsistent.
**New:** All four metrics use `text-text-primary` for the number. Remove the blue color from Open Leads. This keeps the strip clean and uniform.

### 3. Sidebar Contact Details — Add divider between contact info and admin data

**Current:** Contact info (phone, email, company) and admin data (ad source, billing, tax exempt) are separated by a `<Separator />` but only when admin data exists.
**Change:** The `<Separator />` already exists (line 448). No change needed here — it's already correct. Keep as-is.

### 4. Activity Timeline — Status-specific icons

**Current:** All timeline dots are generic `border-primary` circles.
**New:** Replace with status-specific colored icons:
- `NEW` → `Circle` (blue fill, `bg-info text-white`)
- `CONTACTED` → `PhoneOutgoing` (orange, `bg-warning/10 text-warning`)
- `ESTIMATING` → `FileText` (purple, `bg-purple-100 text-purple-600`)
- `WON` → `CheckCircle2` (green, `bg-success/10 text-success`)
- `LOST` → `XCircle` (red, `bg-danger/10 text-danger`)

Each icon replaces the plain circle dot. Size stays `h-3.5 w-3.5` inside a `h-5 w-5` rounded-full container. The vertical timeline line remains.

### 5. NOT implementing (deferred)
- **Map integration for service locations** — requires API key setup and adds complexity; not worth it for Phase 0 MVP
- **+New Job button** — Jobs module (Step 6) isn't built yet; will add when Job routes exist

---

## Files Modified
1. `frontend/src/pages/CustomerDetailPage.tsx` — all changes in this single file

## Verification
- Hero header: no phone/email, shows avatar + name + company + ad source badge
- Action buttons: "+ New Lead" primary, "Edit" outline, 3-dot menu with "Delete"
- KPI strip: all four numbers use same `text-text-primary` color
- Activity timeline: each lead shows a status-specific icon instead of empty circle
- Delete still works via dropdown menu → opens same confirmation dialog
- "+ New Lead" navigates to `/leads/new?customer=${id}`
- `npx tsc --noEmit` passes from `frontend/`
