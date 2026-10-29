# Lead Detail Page Redesign — Unified Single-View Layout

## Context

The current Lead Detail page has two problems:
1. **Two disconnected cards** (hero card + tabs card) create visual fragmentation
2. **Tabs hide critical info** — customer contact, walkthrough, and assignment are buried behind clicks

The user wants a **single, cohesive view** where everything feels connected.

## UX Research Summary

Key findings from [Nielsen Norman Group](https://www.nngroup.com/articles/tabs-used-right/), [Eleken](https://www.eleken.co/blog-posts/tabs-ux), and [Fresh Consulting](https://www.freshconsulting.com/insights/blog/uiux-principle-21-when-and-when-not-to-use-tabs/):

- **Tabs fail when users need to see multiple sections simultaneously** — a lead page requires seeing customer + request + estimates + walkthrough together to make decisions
- **NNG says:** "If users must repeatedly switch between tabs to compare information, a design that puts everything on one big page works better"
- **Amazon/Workiz pattern:** Content that's "more powerful when grouped together" should use continuous scrolling, not tabs
- **HubSpot's approach:** 3-column layout (left sidebar properties + middle activity + right associations) — everything visible, no tabs for critical data
- **Tabs work for 2-5 parallel, non-sequential sections** — but lead data IS sequential (who → what → when → how much), making tabs counterproductive
- **Alternative to tabs:** Scrollable single page with clear section headings and visual hierarchy

**Bottom line:** For an action-oriented FSM CRM where dispatchers need to make quick decisions, a single scrollable view with all info visible beats tabs.

---

## 3 Layout Options

### Option A: "Single Card, Two Columns" (Recommended)

One unified card. Left column = lead story (request → walkthrough → estimates). Right column = context sidebar (customer → assignment → notes). No tabs at all.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Leads > Lead from Ryan Morrell                                          │
├─────────────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ HEADER                                                              │ │
│ │ Lead from Ryan Morrell  [Walkthrough Scheduled ▾]                   │ │
│ │ Morrell Construction · Created Feb 23, 2026                         │ │
│ │ + Tag                           [Create Est] [Edit] [Assign] [Lost]│ │
│ │─────────────────────────────────────────────────────────────────────│ │
│ │ Est. Value  │  Estimates  │  Days Open  │  Source                   │ │
│ │   $4,200    │      1      │     12      │  Referral                 │ │
│ │─────────────────────────────────────────────────────────────────────│ │
│ │                                                                     │ │
│ │  LEFT (flex-1)                    │  RIGHT (w-80, border-l)         │ │
│ │                                   │                                  │ │
│ │  SERVICE REQUEST                  │  CUSTOMER                        │ │
│ │  "Commercial door repair needed   │  Ryan Morrell                    │ │
│ │   for warehouse entrance..."      │  Morrell Construction            │ │
│ │                                   │  📞 (732) 484-3062   [tel link] │ │
│ │  Job Type: Plumbing               │  ✉  ryan@morrell.com [mailto]   │ │
│ │  Source: Referral                 │                                  │ │
│ │  Lead Notes: "..."                │  ── Job Site ──                  │ │
│ │                                   │  📍 436 Fairview Ave             │ │
│ │  ─────────────────────────        │     Colonia, NJ 07067            │ │
│ │                                   │                                  │ │
│ │  WALKTHROUGH                      │  ── Locations ──                 │ │
│ │  Scheduled: Feb 25, 10:00 AM      │  📍 436 Fairview (Primary)      │ │
│ │  Completed: —                     │  📍 120 Main St                  │ │
│ │  Notes: "Needs 2-person crew,     │                                  │ │
│ │   bring ladder..."                │  ─────────────────────────       │ │
│ │  [Edit Walkthrough]               │                                  │ │
│ │                                   │  ASSIGNED TO                     │ │
│ │  ─────────────────────────        │  👤 John Smith (Sales)           │ │
│ │                                   │  [Reassign]                      │ │
│ │  ESTIMATES                        │                                  │ │
│ │  ┌─────────────────────────────┐  │  ─────────────────────────       │ │
│ │  │ EST-2026-0012  SENT  $4,200│  │                                  │ │
│ │  │ EST-2026-0011  DRAFT $3,800│  │  NOTES                           │ │
│ │  └─────────────────────────────┘  │  [Add a note...        ] [Send] │ │
│ │  [+ New Estimate]                 │                                  │ │
│ │                                   │  "Called customer, waiting       │ │
│ │                                   │   for callback" — JS, Feb 23    │ │
│ │                                   │  "Initial inquiry via phone"    │ │
│ │                                   │   — SA, Feb 22                  │ │
│ └───────────────────────────────────┴──────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

**Why this works:**
- **One card = one connected unit.** No visual gap between hero and content
- **Natural reading flow:** Left column tells the lead story top-to-bottom (request → walkthrough → estimates). Right column is the reference panel (who, where, team, notes)
- **Action-oriented:** Phone/email are clickable links, "Edit Walkthrough" is inline, "New Estimate" is right there
- **No tabs = no hidden info.** Everything a dispatcher needs is visible without clicking
- **Consistent with project patterns:** Uses the same `border-l` / `divide-x` pattern as CustomerDetailPage sidebar, just integrated into one card
- **Mobile:** Columns stack — right column moves below left column

---

### Option B: "Single Card, Pinned Sidebar + Scrollable Main"

Same single-card concept, but the right sidebar is sticky/pinned while the left column scrolls. Better for leads with many estimates.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Leads > Lead from Ryan Morrell                                          │
├─────────────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ HEADER (same as Option A)                                           │ │
│ │ Lead from Ryan Morrell  [Status ▾]       [Create Est] [Edit] [...]  │ │
│ │ + Tag                                                               │ │
│ │─────────────────────────────────────────────────────────────────────│ │
│ │ KPI Strip (same as Option A)                                        │ │
│ │─────────────────────────────────────────────────────────────────────│ │
│ │                                                                     │ │
│ │  LEFT (scrollable)                │  RIGHT (sticky, w-80)           │ │
│ │                                   │                                  │ │
│ │  [Service Request section]        │  CUSTOMER (always visible)       │ │
│ │  [Walkthrough section]            │  📞 phone  ✉ email              │ │
│ │  [Estimates table - can be long]  │                                  │ │
│ │  [Notes section]                  │  JOB SITE (always visible)       │ │
│ │  ↕ scrolls independently          │  📍 address                     │ │
│ │                                   │                                  │ │
│ │                                   │  ASSIGNED TO (always visible)    │ │
│ │                                   │  👤 Name                         │ │
│ │                                   │  [Reassign]                      │ │
│ │                                   │                                  │ │
│ │                                   │  (sticky — doesn't scroll)       │ │
│ └───────────────────────────────────┴──────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

**Pros:** Customer contact + assignment always visible even when scrolling through long estimate lists
**Cons:** Sticky positioning adds complexity; notes move to left column (less natural); mobile loses the pinned benefit

---

### Option C: "Single Card, Sections with Anchor Nav"

One card, all sections stacked vertically (no columns), with a thin horizontal section nav at the top that scrolls-to-section on click. Think GitHub README anchor links.

```
┌─────────────────────────────────────────────────────────────────────────┐
│ Leads > Lead from Ryan Morrell                                          │
├─────────────────────────────────────────────────────────────────────────┤
│ ┌─────────────────────────────────────────────────────────────────────┐ │
│ │ HEADER + KPI strip (same as above)                                  │ │
│ │─────────────────────────────────────────────────────────────────────│ │
│ │ Section Nav: [Request] [Customer] [Walkthrough] [Estimates] [Notes] │ │
│ │─────────────────────────────────────────────────────────────────────│ │
│ │                                                                     │ │
│ │  CUSTOMER + SERVICE REQUEST (2-col grid)                            │ │
│ │  ┌──────────────────────┬───────────────────────────────────┐       │ │
│ │  │ SERVICE REQUEST      │ CUSTOMER          JOB SITE        │       │ │
│ │  │ "Commercial door..." │ Ryan Morrell      📍 436 Fairview │       │ │
│ │  │ Type: Plumbing       │ 📞 (732) 484-3062   Colonia, NJ  │       │ │
│ │  │ Source: Referral     │ ✉ ryan@morrell.com                │       │ │
│ │  │ Assigned: J. Smith   │                                   │       │ │
│ │  └──────────────────────┴───────────────────────────────────┘       │ │
│ │                                                                     │ │
│ │  WALKTHROUGH                                                        │ │
│ │  ┌─────────────────────────────────────────────────────────┐        │ │
│ │  │ Scheduled: Feb 25  │  Completed: —  │  [Edit]           │        │ │
│ │  │ Notes: "Needs 2-person crew..."                         │        │ │
│ │  └─────────────────────────────────────────────────────────┘        │ │
│ │                                                                     │ │
│ │  ESTIMATES (full-width table)                                       │ │
│ │  ┌─────────────────────────────────────────────────────────┐        │ │
│ │  │ Number        Status   Total    Created By    Date      │        │ │
│ │  │ EST-2026-0012 SENT     $4,200   John Smith    Feb 24    │        │ │
│ │  │                              [+ New Estimate]           │        │ │
│ │  └─────────────────────────────────────────────────────────┘        │ │
│ │                                                                     │ │
│ │  NOTES (full-width)                                                 │ │
│ │  ┌─────────────────────────────────────────────────────────┐        │ │
│ │  │ [Add a note...                            ] [Send]      │        │ │
│ │  │ "Called customer..." — JS, Feb 23                       │        │ │
│ │  └─────────────────────────────────────────────────────────┘        │ │
│ └─────────────────────────────────────────────────────────────────────┘ │
└─────────────────────────────────────────────────────────────────────────┘
```

**Pros:** Full-width sections give more room for estimates table; anchor nav provides quick jumping without hiding content
**Cons:** Long vertical scroll; customer info scrolls out of view; less "dashboard" feel; anchor nav adds marginal value over just scrolling

---

## Recommendation: Option A

**Option A (Single Card, Two Columns)** is the best balance of:
- Connected feel (one card, no separation)
- Information density (everything visible without scrolling on 1080p)
- Action-oriented (contact links, inline edit, estimates table all visible)
- Consistency (uses existing `border-l` / `divide-x` pattern)
- Simplicity (no sticky positioning or anchor nav complexity)

---

## Implementation Plan (for chosen option)

### File to modify
- `frontend/src/pages/LeadDetailPage.tsx` — single file change

### What changes
1. Remove the two-card structure (hero card + tabs card) → merge into one card
2. Remove `Tabs` component entirely — replace with two-column scrollable layout
3. Move `DetailsTab` content into left column sections (Service Request → Walkthrough → Estimates)
4. Move customer/assignment/notes into right column sidebar
5. Make walkthrough inline-editable (expand/collapse) instead of a separate tab
6. Keep header + KPI strip at top of the single card

### Reusable patterns
- `StatusBadge`, `Breadcrumb`, `TagInput`, `formatCurrency`, `formatDate` — all stay
- `StatusDropdown` component — stays in header
- `AssignLeadDialog`, `MarkLostDialog` — stay as dialogs
- Right column uses `w-80 border-l border-border` pattern (from CustomerDetailPage)

### Verification
1. `npx tsc --noEmit` from `frontend/` — type check
2. Manual browser test at 1440px, 1024px, 768px, 375px
3. Verify all actions: edit, assign, mark lost, create estimate, status change, add note, edit walkthrough
4. Run E2E tests: `npx playwright test --config=e2e/playwright.config.ts` from `frontend/`
