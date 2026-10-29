# Schedule — UI Enhancements PRD (expand-a-day, sidebar toggle, toolbar wrap)

**Date:** 2026-06-03
**Files touched:**
- `frontend/src/pages/SchedulePage.tsx`
- `frontend/src/pages/schedule-dark.css`
- `frontend/.env` (dev-only preview flag)

**Status:**
- ✅ Toolbar single-row responsive wrap — done, verified
- ✅ Left sidebar collapse/expand toggle — done, verified
- ✅ Double-click to expand a day (Standard **Week** view) — done, verified in preview
- ⬜ Member View "expand a day → taller row" — approved, **not yet built**

---

## 1. Double-click to expand a day (Week view) — primary feature

### Problem
In the Standard **Week** view, all 7 days share equal-width columns. A busy day (e.g.
~15–20 jobs, several overlapping) renders each job as a thin sliver that's hard to read.
Users want to focus one day to read its jobs clearly **without leaving the week** (so they
can still drag jobs between that day and the others).

### Solution
**Double-click a day** (its header or anywhere in its column) → that day's column expands to
**~4× the width** of the other days; the other 6 shrink to thin-but-visible strips that remain
valid drop targets. **Double-click again** to collapse back to equal columns.

- Trigger: double-click (chosen by user).
- Scope: Week view only (Day view = single column; Month has no time grid).
- Resets automatically when the week, view, or board mode changes.
- Drag-to-reschedule between days is unaffected (same grid).

### Implementation
`SchedulePage.tsx`:
- New state: `focusedDayIndex: number | null` (0–6 = Sun–Sat column; `null` = all equal).
- `toggleDayFocus(idx)` — same index toggles off, different index switches focus.
- `handleCalendarDoubleClick(e)` — on the `.schedule-cal` wrapper; resolves the clicked
  column index from `.rbc-day-slot` (body) or `.rbc-header` (header) via `indexOf`, week view only.
- `useEffect` resets `focusedDayIndex` to `null` on `[currentDate, calendarView, isGroupedView]`.
- Wrapper carries `data-focus-day={focusedDayIndex}` and `onDoubleClick={handleCalendarDoubleClick}`.

`schedule-dark.css` — 7 header rules + 7 body rules keyed off `[data-focus-day="N"]`.

### ⚠️ Key technical gotcha (root cause of the first broken attempt)
react-big-calendar sizes its two halves with **different CSS**, so the focused day must be
widened with **different properties that resolve to the same share**:

| Half | rbc default | Override used |
|------|-------------|---------------|
| Header cells (`.rbc-header`) | `flex: 1 0 0%` | `flex-grow: 4 !important` |
| Body columns (`.rbc-time-content > .rbc-day-slot`) | `width: 100%` (shrink to equal share) | `width: 400% !important` |

`flex-grow: 4` and `width: 400%` both resolve to ~40% of the row, keeping the **header cell
aligned with its body column**. The first attempt set `flex` on the body too — because body
columns are width-based (not flex-grow), `flex-basis: 0%` **collapsed the column to 1px**
instead of widening it. That's why the header widened but the jobs stayed tiny.

Index mapping (week starts Sunday): the time gutter is the first child of `.rbc-time-content`,
so body day `i` (0-based) = `nth-child(i+2)`; header day `i` = `.rbc-header:nth-child(i+1)`.

### Verification (live preview, 1440×900)
- Before: all body columns 124px (equal).
- After focusing WED: body `[87, 87, 87, 349, 87, 87, 87]`, header `[93, 94, 94, 350, 94, 94, 94]`.
- WED ≈ 349px (≈4× others); header (350) and body (349) aligned. Jobs render full titles/times.

### Open decision
- **Expansion amount:** currently ~40% (`flex-grow: 4` / `width: 400%`). One-number tweak if a
  bigger (e.g. ~50% via `5` / `500%`) or smaller focus is preferred.
- **Header double-click flash:** the day header already has a single-click action (all-day slot
  popover) that may briefly flash on double-click. Suppress if it proves annoying.

---

## 2. Left sidebar collapse/expand toggle

### Problem
The left panel (Search / Walkthroughs / Unassigned Jobs, fixed `w-60`) couldn't be hidden to
give the calendar more room.

### Solution
- Open state: a **collapse icon** (`PanelLeftClose`) in the panel's top-right corner (next to search).
- Collapsed state: panel hides; a thin vertical rail with an **open icon** (`PanelLeftOpen`) remains.
- Session-only (`sidebarOpen` state); resets to open on full reload.

### Implementation
`SchedulePage.tsx`: `sidebarOpen` state; sidebar `className` toggles `hidden lg:flex` vs `hidden`;
a `w-10` rail rendered when collapsed; icons added to the lucide import.

### Possible follow-ups
- Persist collapsed state in `localStorage`.
- Slide animation on open/close.

---

## 3. Toolbar single-row responsive wrap

### Problem / resolution
The schedule toolbar (Today / nav / date / Standard·Member / Plan Mode / departments /
time-of-day / Day·Week·Month / gear) was briefly forced to a single non-wrapping row, which
pushed controls off the right edge on narrow screens.

### Solution
Restored `flex-wrap` on the header bar: **one line when it fits, wraps to a second line on
smaller screens.** No fixed breakpoint — wraps fluidly as the window resizes.

---

## 4. Dev-only preview auth bypass (not a product feature)

`frontend/.env`: `VITE_PREVIEW_AUTH=1` enables the existing dev-only preview bypass (mock ADMIN,
no backend/login) — `import.meta.env.DEV` gated, ignored in production builds. Remove the line to
restore real login. Used for local UI work without a running backend. See `stores/auth.store.ts`
(`PREVIEW_AUTH`).

---

## Next steps
1. Confirm expansion amount for the Week-view focus (keep ~4× or change).
2. Build the **Member View** equivalent: double-click a day section → that day's row grows taller
   across all staff columns (`components/schedule/MemberWeekBoard.tsx`). Note: Member View shows a
   card list per day and does **not** support drag-between-days, so that benefit won't apply there.
