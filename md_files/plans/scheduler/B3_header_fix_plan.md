# B3: Clean Fix for Day/Week Headers

## Root Causes (from investigation)

1. RBC's `.rbc-time-header-cell-single-day { display: none }` hides Day view header — already overridden ✅
2. `.rbc-day-bg` uses `position: absolute; top: 0` and bleeds into the header area
3. The today blue circle (`w-7 h-7` = 28px) doesn't fit cleanly in the header cell

## Google Calendar Approach (from HTML analysis)

Google uses **no overlap** — header and time grid are properly stacked siblings. The date circle is contained within a fixed-height header that has enough padding. No z-index tricks, no overflow hacks.

## Clean Fix (2 changes)

### Change 1: CSS — Properly sized header + background containment

**File:** `frontend/src/pages/schedule-dark.css`

```css
.schedule-cal .rbc-header {
  background: #ffffff;
  border-bottom: 1px solid #dadce0;
  color: #70757a;
  font-size: 0.75rem;
  font-weight: 500;
  padding: 8px 4px;
  text-align: center;
  white-space: nowrap;
  /* White background + z-index prevents .rbc-day-bg from showing through */
  position: relative;
  z-index: 2;
}
```

The key: `background: #ffffff` (opaque white) + `z-index: 2` means even if `.rbc-day-bg` overlaps, the white background covers it. No need for `min-height` or `overflow` hacks — let the content size the cell naturally.

For the today circle to fit, reduce the circle size so it matches the line height of regular date numbers. In week view, use `w-6 h-6` (24px) instead of `w-7 h-7` (28px). In day view, use `w-9 h-9` (36px).

### Change 2: Component — Smaller circle that fits within natural line height

**File:** `frontend/src/pages/SchedulePage.tsx` — DayHeader component

```tsx
<span className={`schedule-day-num font-normal leading-none flex items-center justify-center
  w-6 h-6 rounded-full
  ${isToday ? 'schedule-day-today bg-primary text-white' : 'text-text-primary'}
`}>
  {dayNum}
</span>
```

`w-6 h-6` (24px) fits within the natural padding of the header cell without overflowing.

### Change 3: Remove duplicate/conflicting CSS rules

Remove the duplicate `.rbc-time-header-cell-single-day .schedule-day-num` rule (lines 61-67 — there are two of them). Consolidate into one:

```css
.schedule-cal .rbc-time-header-cell-single-day .rbc-header {
  padding: 12px 8px;
}
.schedule-cal .rbc-time-header-cell-single-day .schedule-day-num {
  font-size: 1.5rem;
  width: 2.25rem !important;
  height: 2.25rem !important;
}
```

## Verification

1. Week view: All 7 headers aligned — today circle (24px) same height as other numbers
2. Day view: "FRI 20" prominent — circle (36px) centered, contained within header
3. No date crossing below the separator line in either view
4. No `.rbc-day-bg` bleeding through (white background covers it)
