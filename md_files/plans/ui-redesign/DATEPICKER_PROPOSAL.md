# Datepicker Proposal - one date primitive for the v2 layer

**Target: the v2 presentation layer (`frontend/src/pages/v2`) on branch `refactor/ui-kit-02-leads`.**
Not the legacy app. Every path, line number and token in this document was read out of this worktree.
An earlier revision of this file was written against the legacy tree (`components/common/DateRangeField`,
`pages/reports/DateRangeControl`, `tokens.css`); none of that applies here and it has been discarded.

- Status: **proposal only**. No file under `frontend/src/` is changed by this document.
- Visual demo: `C:\Users\97250\.claude\jobs\16a2dbb5\tmp\datepicker-v2.html` (self-contained, open in a browser).
- Snapshot date: 2026-08-08. The branch is under concurrent edit; line numbers are from that snapshot.

---

## 1. What v2 already has

| Thing | File | State |
|---|---|---|
| `Calendar` | `frontend/src/ui-kit/components/ui/calendar.tsx:17` | react-day-picker `DayPicker`, fully restyled onto v2 tokens (`bg-brand`, `ring-brand`, `text-subtle-foreground`, `bg-brand-subtle` range fills). Range classNames (`range_start`, `range_end`, `range_middle`) are already written even though nothing selects a range yet. **This is the foundation. Keep it.** |
| `DatePicker` | `frontend/src/ui-kit/components/form/datePicker.tsx:26` | Kit Popover + `Calendar`, single date only, `value?: Date` / `onValueChange(date: Date \| undefined)`. Has `clearable` and `disablePast`. **Zero call sites in v2.** |
| `DateRangePicker` | `frontend/src/ui-kit/components/form/datePicker.tsx:83` | Same shape for `DateRange`, `numberOfMonths={2}`. **Zero call sites in v2.** |
| `DateTimePicker` | `frontend/src/pages/v2/tasks/components/dateTimePicker.tsx:41` | v2-local. Popover + `Calendar` + a `Select` of 15-minute slots. String contract `'YYYY-MM-DDTHH:MM'`. **One call site:** `tasks/components/createTaskDialog.tsx:22,:184`. |
| `TimeSelect` | `frontend/src/pages/v2/leads/components/timeSelect.tsx:20` | Time-only `Select`, 15-minute grid, `'HH:MM'` contract. Two call sites: `leads/LeadFormPage.tsx:671,:684`. |
| legacy `TimeSelect` | imported at `frontend/src/pages/v2/schedule/components/quickScheduleCard.tsx:5,:146,:156` | v2 reaching back into `@/components/form/TimeSelect`, with a comment at `:69` recording the gap: "the kit ships a date picker but no TIME picker". |

The dependencies are all installed already (`frontend/package.json`): `react-day-picker ^10.0.1`,
`date-fns ^4.4.0`, `date-fns-tz ^3.2.0`, `@radix-ui/react-popover ^1.1.23`, `framer-motion ^12.43.0`.
`tokens-v2.css` now also carries the first motion tokens (`--motion-duration-fast: 200ms`,
`--motion-duration-panel: 320ms`, `--motion-ease-out: cubic-bezier(0.22, 1, 0.36, 1)`), so an open
animation no longer needs a hardcoded number.

**The single most important fact in this section: the kit `DatePicker` has zero call sites.** Its `Date`
contract can be replaced outright without a migration, because there is nothing to migrate. This
proposal is therefore not "add a component beside the one we have" - it is "finish the one we have,
before it acquires call sites that lock in the wrong contract".

---

## 2. Audit - every date entry point in v2

35 native inputs across 20 files: **27 `type="date"`, 3 `type="datetime-local"`, 5 `type="time"`.**
Paths are relative to `frontend/src/pages/v2/`.

### 2a. Inside a Radix Popover (the hard case - see section 3.2)

| File:line | What it picks | Today | Should become |
|---|---|---|---|
| `_shared/filterPopover.tsx:306,:314` | Any date facet, custom range | preset `Select` + 2 native date inputs | `range`, `presentation="inline"` |
| `jobs/components/filterPopover.tsx:266,:274` | Jobs date facet, custom range | same, forked copy | same |
| `estimates/components/filterPopover.tsx:320,:328` | Estimates date facet, custom range | same, forked copy | same |
| `tasks/components/filterPopover.tsx:74,:83` | Task due/created range | 2 native date inputs | same |

All four render inside a `PopoverContent` sized `w-[640px] max-h-[calc(100vh-2rem)] ... overflow-hidden`
(`_shared/filterPopover.tsx:400-402`, `tasks/components/filterPopover.tsx:269-271`). The four `DateRange`
bodies are near-identical forks of one another; `tasks/components/filterPopover.tsx:61` even says so
("A richer picker is a separate proposal; nothing here pre-empts it"). **Consolidating them is the
highest-leverage change in this whole plan.**

### 2b. Report and list-view ranges

| File:line | What it picks | Today | Should become |
|---|---|---|---|
| `reports/components/dateRangeControl.tsx:105,:114` | Shared report custom range | 2 native date inputs inside a `Card` | `range` with presets rail |
| `reports/reports/EstimateConversionReport.tsx:569,:571` | Conversion custom range | 2 native date inputs | `range` |
| `reports/reports/CommissionsReport.tsx:326,:330` | Commissions custom range | 2 native date inputs, inside a local component also called `DateRangePicker` (`:270`) | `range` |
| `reports/reports/InvoicesReport.tsx:257,:262` | Invoices custom range | 2 native date inputs | `range` |
| `inventory/components/actionLogView.tsx:472,:481` | Action-log occurred-between | 2 native date inputs in a toolbar | `range` |

`reports/components/dateRangeControl.tsx` is imported by **nine** report pages: `ArAgingReport`,
`CallTrackingReport`, `ExpensesReport`, `InventoryUsageReport`, `JobStatisticsReport`, `JobsReport`,
`LeadsReport`, `PaymentsReport`, `SalesReport`. One edit there re-skins all nine.

Naming collision worth fixing while in there: `reports/reports/CommissionsReport.tsx:270` declares a
local `DateRangePicker` that has nothing to do with `ui-kit/components/form/datePicker.tsx:83`.

### 2c. Scheduling - date and time as separate controls

| File:line | What it picks | Today | Should become |
|---|---|---|---|
| `jobs/JobFormPage.tsx:513,:516` | Job scheduled start | native date + native time | one `datetime` |
| `jobs/JobFormPage.tsx:521,:524` | Job scheduled end | native date + native time | one `datetime` |
| `leads/LeadFormPage.tsx:667,:671` | Walkthrough start | native date + `TimeSelect` | one `datetime` |
| `leads/LeadFormPage.tsx:680,:684` | Walkthrough end | native date + `TimeSelect` | one `datetime` |
| `schedule/components/eventEditor.tsx:385,:394` | Calendar event start | native date + native time, inside a Dialog | one `datetime` |
| `schedule/components/unifiedDropModal.tsx:143,:153` | Drag-drop reschedule | native date + native time, inside a Dialog | one `datetime` |
| `schedule/components/quickScheduleCard.tsx:146,:156` | Slot start/end time | legacy `TimeSelect`, inside a hand-positioned `fixed z-[60]` card | stays `TimeSelect` (see 5.4) |

### 2d. Single `datetime-local` fields

| File:line | What it picks | Container | Should become |
|---|---|---|---|
| `leads/components/walkthroughTab.tsx:305` | Walkthrough date and time | detail-page tab | `datetime` |
| `tasks/components/taskDetailDrawer.tsx:209` | Task due date and time | kit `Sheet` | `datetime`, portalled into the sheet layer |
| `service-plans/components/planDetailSheet.tsx:229` | Next visit date and time | kit `Sheet` | `datetime`, portalled into the sheet layer |

### 2e. Single dates in forms

| File:line | What it picks | Container | Should become |
|---|---|---|---|
| `customers/CustomerFormPage.tsx:821` | "Customer since" backdate | form page | `single`, `maxDate` today |
| `_shared/planBuilderDialog.tsx:235` | Service-plan start date | kit `Dialog` | `single`, portalled into the dialog layer |
| `_shared/recurrenceBuilder.tsx:153` | Recurrence "ends on" | inside `planBuilderDialog` (`:260`) | `single`, portalled |

### 2f. Time only - not migrating

| File:line | What it picks | Verdict |
|---|---|---|
| `settings/CompanyProfilePage.tsx:285` | Default schedule start time | native `type="time"`. No date axis. Move to `TimeSelect` for consistency, not to `DatePicker`. |

### 2g. Already themed

| File:line | Verdict |
|---|---|
| `tasks/components/dateTimePicker.tsx:41` (via `tasks/components/createTaskDialog.tsx:184`) | Keep the file and its exported name; replace its body with the new primitive. Its tests and its #430 guarantee both survive. |

---

## 3. The two blockers, addressed

A proposal that does not answer these is not implementable. Both are already written down in the code.

### 3.1 The `Date`-versus-string contract mismatch

Recorded at `tasks/components/dateTimePicker.tsx:35-38`: "The kit's own `form/datePicker` is date-ONLY -
it emits a `Date` and has no time axis at all - so it cannot stand in here." The same objection was
written a second time in the filter bar that has since been refactored, and survives verbatim in
`tasks/components/filterPopover.tsx:56-61`.

Every v2 consumer holds strings, not `Date`:

- zustand filter stores hold `{ from: string; to: string }` in `YYYY-MM-DD` (`_shared/filterPopover.tsx:55-62`).
- react-hook-form registers plain strings: `form.register('scheduled_date')` at `jobs/JobFormPage.tsx:513`,
  `f.register('scheduled_end_date')` at `leads/LeadFormPage.tsx:680`.
- `tasks/components/dateTimePicker.tsx:16` states the contract explicitly: `'YYYY-MM-DDTHH:MM'`.
- report pages hold `customFrom` / `customTo` strings straight off `e.target.value`.

**Decision: no `Date` object ever crosses the component boundary.** `value` and `onChange` are strings
in exactly the shapes the native inputs already emit, so every migration is a one-for-one swap with no
adapter at the call site and no schema change.

This is not only ergonomic, it removes a whole bug class. `new Date('2026-08-11')` parses as **UTC**
midnight and renders as August 10 anywhere west of Greenwich. `dateTimePicker.tsx:91,:98,:99` currently
calls `new Date(value)` on a `'YYYY-MM-DDTHH:MM'` string, which is parsed as local time and is therefore
correct today - but the same helper applied to a date-only string would silently shift the day.
The primitive parses date-only strings by parts (`new Date(y, m - 1, d)`) and never by `Date.parse`.
`lib/format-date.ts:38` formats with `timeZone: 'UTC'` while `lib/format-date.ts:46` `isoDateLocal` uses
local parts; that inconsistency is a live inconsistency worth resolving under this work, and the
"date-only strings are never parsed as a `Date`" rule resolves it.

### 3.2 Issue #430 - the modal layering problem, and its popover-in-popover twin

Recorded at `tasks/components/dateTimePicker.tsx:26-39`: a native `datetime-local` popup is an OS-level
widget that a modal Radix Dialog's dismissable-layer regime cannot close, so it gets orphaned on screen.
The fix already in place is to use a portalled Radix Popover, which joins the dialog's layer stack.

That fix must be preserved, and it has two edges:

**Edge 1 - Dialogs and Sheets.** `_shared/planBuilderDialog.tsx`, `schedule/components/eventEditor.tsx`,
`schedule/components/unifiedDropModal.tsx` are Dialogs; `tasks/components/taskDetailDrawer.tsx` and
`service-plans/components/planDetailSheet.tsx` are Sheets. A Radix Popover works inside them, but the kit's
`PopoverContent` (`ui-kit/components/ui/popover.tsx:24`) hardcodes `<PopoverPrimitive.Portal>` and spreads
its props onto `Content` only - **there is no way to pass Portal a `container`.** Adding an optional
`container` passthrough to `PopoverContent` is a one-line, backward-compatible change and is a
prerequisite for the sheet cases, where portalling to `document.body` puts the calendar outside the
sheet's own stacking and scroll context.

**Edge 2 - popovers inside popovers.** Eight of the 27 date inputs (section 2a) sit inside a 640px
`PopoverContent` that is itself capped with `max-h-[var(--radix-popover-content-available-height)]` and
`overflow-hidden`. Radix does not hard-break here: the nested content is portalled but remains a React
tree descendant, so the parent's capture handler sees the interaction as inside and does not dismiss.
But the pattern is already causing trouble in exactly this panel - the preset `Select` carries
`position="popper" side="bottom" avoidCollisions={false}` with a comment at `_shared/filterPopover.tsx:292-295`
explaining that Radix otherwise flips it up and detaches it from its own control.

Layering a second floating surface on top gives us: two `--elevation` shadows stacked, Escape with two
meanings (does it close the calendar or the filter panel?), a 400px calendar over a 340px column at
narrow widths, and reposition churn as the parent panel scrolls.

**Decision: `presentation`, not z-index.** The primitive renders either as a popover (default) or
**inline, in normal flow** - same component, same props, same string contract. Inside a filter panel it
is inline: one layer, one Escape, and it scrolls with the panel because it is part of it. The demo puts
the two side by side.

**Edge 3, found during this audit and not previously recorded.** `schedule/SchedulePage.tsx:794`
runs a hand-rolled document-level outside-click listener that whitelists
`[data-radix-popper-content-wrapper]` so that picking a time in `quickScheduleCard`'s `TimeSelect` does
not close the card. Any new portalled picker introduced under that card inherits the whitelist for free,
but a picker rendered `inline` inside the card would not be matched by it and must instead be covered by
the card's own `fixed`/`z-[` selector at `SchedulePage.tsx:793` (both are branches of one `if`,
`SchedulePage.tsx:792-795`). This is the reason `quickScheduleCard`
is left alone in phase ordering.

---

## 4. Recommendation

> **Finish `ui-kit/components/form/datePicker.tsx`. Give it a string contract, three modes
> (`single` / `datetime` / `range`) and two presentations (`popover` / `inline`), a presets rail and a
> typed-entry row. Add no dependency.**

Reasoning, in order of weight:

1. **The contract can still be changed for free.** Zero call sites. Six months from now, after the v2
   migration has wired 27 date fields to whatever exists, it will not be free.
2. **react-day-picker v10 is already installed and already themed.** `ui-kit/components/ui/calendar.tsx`
   is `classNames`-driven with no bundled CSS, so every pixel resolves to a v2 token. It gives us
   `mode="single" | "range" | "multiple"`, `numberOfMonths`, `disabled` matchers, `defaultMonth`,
   `modifiers`, a real `role="grid"` with roving arrow-key focus, PageUp/PageDown month paging and
   Home/End week bounds. Hand-rolling any of that is a direct violation of CLAUDE.md rule 8.
3. **The range classNames are already written** (`calendar.tsx:50-51,:59-61`) and unexercised. The work
   is smaller than it looks.
4. **It keeps the rollback contract intact.** `tokens-v2.css`'s header states the point of the parallel
   layer: the whole v2 presentation rolls back by deleting that file and its import. A datepicker built
   on kit primitives and kit tokens rolls back with it. A datepicker built on a new third-party design
   system does not.

Alternatives considered and rejected:

| Option | Verdict |
|---|---|
| Leave the natives | Cannot be themed, no dark mode, OS-inconsistent, no presets, and #430 recurs on every `datetime-local`. Also inconsistent with itself: two of the range facets already use a preset `Select` and two do not. |
| `@react-aria/datepicker` | Best-in-class segmented typed entry and a11y, but it introduces a second headless-primitive ecosystem beside Radix, a second mental model, and real bytes - to buy semantics RDP v10 already provides. |
| MUI / AntD datepicker | Ships a foreign design system and theming layer. Direct violation of the design-tokens boundary. |
| `react-datepicker` | Its own stylesheet to fight, weaker a11y, and a net-new dependency replacing one we already pay for. |
| Hand-rolled on Temporal | Calendar math, DST arithmetic and keyboard nav, by hand. No. |

### 4.1 How it covers the real needs

| Need | Answer |
|---|---|
| Single date | `mode="single"`. Trigger renders `EEE, d MMM yyyy` (the format `datePicker.tsx:46` already chose, with the reason recorded at `:45`: `03/04` is ambiguous across locales, `4 Mar` is not). |
| Date and time | `mode="datetime"`: `Calendar` plus a slot column at `stepMinutes` (default 15, per issue #416) plus optional duration chips. Collapses the seven paired date-plus-time controls in section 2c into four. |
| Date ranges | `mode="range"` with `numberOfMonths={2}` (1 under 640px), hover preview between anchors, day-count readout, and an explicit **Apply** so a half-picked range never fires a report query. |
| Typed entry | A text row above the grid. Strict `date-fns/parse` against `YYYY-MM-DD` then `MM/DD/YYYY`, then a short keyword table (`today`, `tomorrow`, `+3d`, `-7d`). Invalid input never mutates the committed value; it sets `aria-invalid` and an inline hint. No natural-language date library in v1. |
| Presets | Data-driven rail. `RANGE_PRESETS` ships as the exact list already in `_shared/filterPopover.tsx:54-63` (Any time / Today / This week / This month / Last 7 / Last 30 / Last 90 / This year) plus This quarter and Year to date for the report surfaces, so filter behaviour is unchanged where it is already correct. `DAY_PRESETS` ships Today / Tomorrow / Next Monday / In a week / End of month. |
| Keyboard | RDP v10 supplies the grid semantics and roving focus. We add: Escape closes and restores focus to the trigger (Radix), Enter commits, and in `datetime`/`range` the typed input is the initial focus target. In `presentation="inline"` there is no focus trap at all, which is the correct behaviour inside a filter panel. |
| Timezone | Date-only values stay plain `YYYY-MM-DD` strings and are never `Date.parse`d. Date-time values resolve against the **org** timezone via `date-fns-tz`, not the browser's, and the popover shows an explicit line ("Times shown in America/New_York"). If no org timezone is reachable client-side, default to the browser zone and say so in the same line. |
| Mobile | Under 640px, `presentation="popover"` renders as a kit `Sheet` from the bottom, day cells go to a 44x44px touch target, and range mode drops to one month. `presentation="inline"` is already mobile-correct. |
| Motion | 200ms scale-and-fade on open using `--motion-duration-fast` and `--motion-ease-out`, gated behind `prefers-reduced-motion`. The kit `PopoverContent` already animates (`popover.tsx:36-37`); the picker should not add a second, competing animation. |
| Dark mode | Every value is a token. `tokens-v2.css` remaps the full palette under `.dark` (unlike `tokens.css`), so dark mode here is a matter of using tokens rather than a prerequisite work item. |

### 4.2 Optional, and worth keeping on the roadmap

The demo sketches **capacity dots** on day cells and **availability dots** on time slots (green light,
amber filling, red fully booked) using `--status-green` / `--status-amber` / `--status-red`. For a
dispatcher this converts a blind pick into an informed one. It needs a capacity endpoint that does not
exist, so it ships behind optional `dayLoad` / `slotAvailability` props and stays dark until it does.

---

## 5. API sketch

```ts
// frontend/src/ui-kit/components/form/datePicker.tsx  (replaces the current body)

type IsoDay   = string;  // 'YYYY-MM-DD'       - date only, timezone free
type IsoLocal = string;  // 'YYYY-MM-DDTHH:MM' - wall clock in the org timezone
type IsoRange = { from: IsoDay | ''; to: IsoDay | '' };

interface PresetDef<T> {
  key: string;
  label: string;
  /** Resolved lazily, so "Today" is correct at open time and not at module load. */
  resolve: () => T;
}

interface BaseProps {
  /** 'popover' (default) or 'inline'. Use 'inline' inside a Popover, a narrow
   *  column, or any surface where a second floating layer would stack. */
  presentation?: 'popover' | 'inline';
  disabled?: boolean;
  invalid?: boolean;
  placeholder?: string;
  id?: string;
  className?: string;
  'aria-label'?: string;
  /** IANA zone for "today", slot labels and the footer line. Defaults to the
   *  org timezone, NOT the browser. */
  timeZone?: string;
  minDate?: IsoDay;
  maxDate?: IsoDay;
  /** Extra unselectable days (blackouts, holidays). */
  disabledDays?: IsoDay[];
  /** Show the typed-entry row. Default: true for datetime and range, false for single. */
  allowTyping?: boolean;
  /** Portal target when presentation is 'popover' and the picker lives inside a
   *  Dialog or Sheet. Requires the one-line `container` passthrough on
   *  ui-kit/components/ui/popover.tsx's PopoverContent. */
  container?: HTMLElement | null;
  align?: 'start' | 'center' | 'end';
}

interface SingleProps extends BaseProps {
  mode?: 'single';
  value: IsoDay | '';
  onChange: (v: IsoDay | '') => void;
  presets?: PresetDef<IsoDay>[] | false;   // false = no rail; default DAY_PRESETS
  clearable?: boolean;                     // default true
  disablePast?: boolean;                   // kept from today's API
  dayLoad?: Record<IsoDay, 'free' | 'busy' | 'full'>;
}

interface DateTimeProps extends BaseProps {
  mode: 'datetime';
  value: IsoLocal | '';
  onChange: (v: IsoLocal | '') => void;
  stepMinutes?: number;                    // default 15 (issue #416)
  minTime?: string;                        // 'HH:MM'
  maxTime?: string;                        // 'HH:MM'
  durations?: Array<{ label: string; minutes: number | 'allDay' }>;
  onDurationChange?: (minutes: number | 'allDay') => void;
  slotAvailability?: Record<string, 'free' | 'busy' | 'full'>;  // keyed 'YYYY-MM-DDTHH:MM'
  presets?: PresetDef<IsoLocal>[] | false;
}

interface RangeProps extends BaseProps {
  mode: 'range';
  value: IsoRange;
  onChange: (v: IsoRange) => void;
  numberOfMonths?: 1 | 2;                  // default 2, auto-1 under 640px
  presets?: PresetDef<IsoRange>[] | false; // default RANGE_PRESETS
  /** Require an explicit Apply before onChange fires. Default true for
   *  presentation='popover', false for 'inline' (a filter panel commits per keystroke today). */
  requireApply?: boolean;
  maxSpanDays?: number;
  showDayCount?: boolean;                  // default true
}

export type DatePickerProps = SingleProps | DateTimeProps | RangeProps;
export function DatePicker(props: DatePickerProps): JSX.Element;

export const DAY_PRESETS: PresetDef<IsoDay>[];
export const RANGE_PRESETS: PresetDef<IsoRange>[];   // mirrors _shared/filterPopover.tsx:54-63

/** Exported and unit-testable on its own. Returns null for unparseable input. */
export function parseDateInput(
  raw: string,
  opts: { today: IsoDay; timeZone: string },
): IsoDay | null;
```

Notes on the shape:

- **Strings in, strings out.** No `Date` crosses the boundary, in either direction.
- The discriminated union makes TypeScript reject `slotAvailability` on a `single` picker and
  `numberOfMonths` on a `datetime` picker at compile time.
- `presets?: ... | false` lets a caller drop the rail without passing an empty array that would render
  an empty column.
- `DateRangePicker` (`datePicker.tsx:83`) is deleted and its name freed. It has zero call sites, and
  `<DatePicker mode="range">` is the same thing with a working contract. Delete also removes the
  confusion with the unrelated local `DateRangePicker` at `reports/reports/CommissionsReport.tsx:270`,
  which should be renamed in the same pass.

### 5.1 Files created or changed by the build

| File | Change |
|---|---|
| `ui-kit/components/form/datePicker.tsx` | Rewritten. Three modes, two presentations, string contract. |
| `ui-kit/components/form/datePicker.presets.ts` | New. `DAY_PRESETS`, `RANGE_PRESETS`. |
| `ui-kit/lib/dateInput.ts` | New. `parseDateInput`, `isoDayToParts`, org-timezone helpers. |
| `ui-kit/components/ui/calendar.tsx` | Additive only: a `modifiers` classNames entry for the capacity dot. Range states are already styled. |
| `ui-kit/components/ui/popover.tsx` | One line: pass an optional `container` through to `PopoverPrimitive.Portal`. Backward compatible. |
| `pages/v2/_shared/dateRangeFacet.tsx` | New. The one shared facet body that the four forked `DateRange` blocks collapse into. |
| `design-system/__tests__/component-api-guard.test.ts` | Update the counts it asserts for popover triggers and ghost buttons. |

---

## 6. Migration, ordered by leverage

Each phase is independently shippable and independently revertable. Per CLAUDE.md, each is its own PR
into `staging` first.

### Phase 1 - build the primitive. No call sites touched.
`datePicker.tsx`, `datePicker.presets.ts`, `dateInput.ts`, the `calendar.tsx` modifier, the `popover.tsx`
`container` passthrough. Unit tests for `parseDateInput` covering both accepted formats, the keyword
table, DST boundaries, and rejection of garbage. `npx tsc --noEmit` clean. Zero behaviour change.

### Phase 2 - **the single highest-leverage change**: one shared date-range facet.
Extract `_shared/dateRangeFacet.tsx` built on `<DatePicker mode="range" presentation="inline">` and point
all four forks at it:

- `_shared/filterPopover.tsx:303-321` - covers `customers/CustomersPage.tsx:42`,
  `invoices/InvoicesPage.tsx:48`, `leads/LeadsPage.tsx:36`
- `jobs/components/filterPopover.tsx:263-281` - covers `jobs/JobsPage.tsx:37`
- `estimates/components/filterPopover.tsx:317-335` - covers `estimates/EstimatesPage.tsx:38`
- `tasks/components/filterPopover.tsx:63-91` - covers `tasks/components/taskFilterBar.tsx:12`

Six list pages re-skinned, 8 native inputs removed, four forks collapsed to one, and the
popover-in-popover problem solved by construction rather than by z-index. Store contracts untouched.

### Phase 3 - second highest leverage: the shared report control.
`reports/components/dateRangeControl.tsx:105,:114` becomes `<DatePicker mode="range">` with the presets
rail. **Nine** report pages inherit it without being opened: `ArAgingReport`, `CallTrackingReport`,
`ExpensesReport`, `InventoryUsageReport`, `JobStatisticsReport`, `JobsReport`, `LeadsReport`,
`PaymentsReport`, `SalesReport`. Keep the "By: field" row exactly as it is.

### Phase 4 - the shared datetime picker.
`tasks/components/dateTimePicker.tsx` keeps its file, its exported name and its props, and becomes a thin
wrapper over `<DatePicker mode="datetime">`. `tasks/components/createTaskDialog.tsx:184` does not change,
and the existing tests keep passing, which is the point: the #430 guarantee is re-verified rather than
re-argued.

### Phase 5 - scheduling surfaces (highest daily value, merges paired controls).
- `jobs/JobFormPage.tsx:513,:516,:521,:524` - two `datetime` pickers
- `leads/LeadFormPage.tsx:667,:671,:680,:684` - two `datetime` pickers
- `schedule/components/eventEditor.tsx:385,:394` - one `datetime` picker, `container` = dialog content
- `schedule/components/unifiedDropModal.tsx:143,:153` - one `datetime` picker, `container` = dialog content
- `leads/components/walkthroughTab.tsx:305`
- `tasks/components/taskDetailDrawer.tsx:209` - `container` = sheet content
- `service-plans/components/planDetailSheet.tsx:229` - `container` = sheet content

### Phase 6 - remaining ranges and single dates.
- `reports/reports/EstimateConversionReport.tsx:569,:571`
- `reports/reports/CommissionsReport.tsx:326,:330` (and rename the local `DateRangePicker` at `:270`)
- `reports/reports/InvoicesReport.tsx:257,:262`
- `inventory/components/actionLogView.tsx:472,:481`
- `customers/CustomerFormPage.tsx:821`
- `_shared/planBuilderDialog.tsx:235` and `_shared/recurrenceBuilder.tsx:153` - both `container` = dialog content

### Phase 7 - optional.
Capacity endpoint feeding `dayLoad` and `slotAvailability` on the scheduling pickers.

### Not migrating
- `settings/CompanyProfilePage.tsx:285` - time only. Move it to `TimeSelect`, not to `DatePicker`.
- `schedule/components/quickScheduleCard.tsx:146,:156` - the two `TimeSelect`s are load-bearing against
  `SchedulePage.tsx:792-795`'s outside-click whitelist. Leave them until that listener is replaced.
  Worth doing separately: `quickScheduleCard.tsx:5` still imports `TimeSelect` from the legacy tree,
  while `leads/components/timeSelect.tsx` is the v2 port of the same component - two copies, one of
  which crosses the layer boundary.
- `react-big-calendar` views and the schedule grid - those are calendar **views**, not pickers.

**If only one phase ever ships, ship phase 2.** It removes the most duplication, fixes the most
surfaces, and is the only one that resolves an interaction problem rather than a styling one.

---

## 7. Risks and open questions

1. **Org timezone source.** The API assumes an org timezone is reachable client-side. If it is not,
   `timeZone` falls back to the browser zone and the footer line must say which one it used.
2. **`lib/format-date.ts` is internally inconsistent** - `:38` formats in UTC, `:46` `isoDateLocal` uses
   local parts. The "date-only strings are never `Date.parse`d" rule settles it, but the existing helper
   should be brought in line in the same PR that introduces `dateInput.ts`.
3. **`component-api-guard.test.ts` counts specific component usages** (see its notes at `:1196`, `:1316-1317`,
   `:1673`). Every phase will move those counts; budget for updating the assertions and their comments.
4. **The branch is under concurrent edit.** `tasks/components/filterPopover.tsx` did not exist when this
   audit began and now carries two of the 27 inputs. Re-run the audit greps at the start of each phase.
5. **`requireApply` differs by presentation.** Filter panels currently commit per keystroke; report
   controls should not. Defaulting `requireApply` off for `inline` preserves today's behaviour in the
   place where changing it would be a behaviour regression disguised as a restyle.
6. **Scope discipline.** Phases 5 and 6 touch 12 files between them. One PR per phase, into `staging`
   first.

---

## 8. Validation checklist, per phase

- [ ] `npx tsc --noEmit` clean.
- [ ] `npm test --workspace=frontend` green, including `__tests__/CreateTaskModal.test.tsx` and the
      v2 filter and reports tests touching the migrated surfaces.
- [ ] Token guard and `component-api-guard` green, with any changed counts explained in the test comment.
- [ ] No raw hex and no raw Tailwind palette class anywhere in the component.
- [ ] Trigger renders `EEE, d MMM yyyy`; range trigger renders `d MMM - d MMM yyyy`.
- [ ] Keyboard: Tab to trigger, Enter opens, arrows move, PageUp/PageDown page months, Enter commits,
      Escape closes and returns focus to the trigger.
- [ ] Inside a Dialog and inside a Sheet: the picker dismisses on Escape and outside click while the
      dialog or sheet stays open (the #430 regression test).
- [ ] Inside a filter Popover: no second floating layer, and the panel does not close when a day is clicked.
- [ ] Touch targets 44x44px minimum in the mobile sheet.
- [ ] Verified in light and dark, at 375px / 768px / 1024px / 1440px.
- [ ] `prefers-reduced-motion` respected.
