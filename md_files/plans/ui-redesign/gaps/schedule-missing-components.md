# Schedule - components with no kit equivalent

Module 7. Branch `refactor/ui-kit-07-schedule`.

Rebuilt under `frontend/src/pages/v2/schedule/`: `SchedulePage.tsx`, `glyphs.ts`, and nine
components under `components/`. Registered by `pages/v2/routes/schedule.paths.ts` +
`schedule.routes.tsx` (one path, `/schedule`).

The import checklist is every `@/components/...` import across the legacy page and the sixteen
modules under `components/schedule/` - 32 distinct modules, all accounted for below.

---

## 0. The react-big-calendar boundary

The kit ships **no calendar view**. `ui/calendar` is a react-day-picker DATE PICKER: single or
range date selection, no events, no week or day mode, no drop targets, no resize. So
`react-big-calendar@^1.19.4` and its `addons/dragAndDrop` HOC stay, are configured identically,
and are recorded as a KEEP gap. Only the chrome around the engine moved onto the kit.

Everything below is carried over byte-for-byte and was not touched:

- `withDnD(Calendar)`, both rbc stylesheets, `dayLayoutAlgorithm="no-overlap"`, `popup`
- all three DnD systems: rbc-internal move/resize, sidebar -> calendar via
  `onDropFromOutside` + `dragFromOutsideItem`, and the hand-rolled HTML5 member-board drops
- `draggableAccessor` / `resizableAccessor` / `resizable`, and every one of the twelve
  `boardReadOnly` bail-outs
- `rescheduleGate` (money, not status, freezes a job) and `unscheduleGate`
- `classifyBoardDrop` / `swapCrew` - cross-lane is a crew SWAP with the drop slot's time
  ignored, same-lane is a reschedule with crew untouched
- the `isAllDayStripDrop` heuristic, verbatim, including the calendar-day (not raw-ms) maths
  that survives the 23-hour spring-forward day
- `pendingMove` paired with `rescheduleConfirm` - the visual-only optimistic override
- the prefix-matching `setQueriesData` / `getQueriesData` in all four optimistic mutations,
  and the exact query keys `['schedule-jobs', dateRange, departmentFilter]`,
  `['schedule-walkthroughs', dateRange]`, `['schedule-unassigned']`,
  `['schedule-unscheduled-walkthroughs']`
- `ScheduleCtx` (rbc slot components cannot take props), `ScheduleEvent`, `DayHeader`
- `eventStyleGetter` including every `!`-prefixed class, and `slotPropGetter`
- `.schedule-cal`, `data-focus-day`, `has-allday-events`, `plan-mode-active` on the wrapper
- the `--drag-preview-width` / `--drag-preview-left` mousedown effect, the 250ms day-header
  click/double-click discriminator, the capturing 100ms-delayed outside-click listener, the
  edge-scroll-while-dragging interval, the keyboard shortcuts, both `beforeunload` effects
- `Views.WEEK` default, `weekStartsOn: 0` throughout

**No drag implementation was migrated to dnd-kit anywhere in this module.** dnd-kit emits no
`dataTransfer`, and the sidebar, the calendar and both member boards exchange payloads through
five `dataTransfer` channels (`dragChannels.ts`). Half-migrating would break reschedule and
unschedule outright.

### `schedule-dark.css` is imported, not forked

`frontend/src/pages/schedule-dark.css` (490 lines) is imported by the v2 page as
`@/pages/schedule-dark.css`. Despite its name it is a LIGHT theme, and it is not decoration -
it encodes behaviour that lives nowhere else:

| Rule | What it does |
|---|---|
| `[data-focus-day="N"]` -> `flex-grow:4` + `width:400%` | the expanded-day-column mechanism |
| `.has-allday-events` | the all-day strip is `max-height: 0` without it |
| `--drag-preview-width` / `--drag-preview-left` | drag-preview geometry the page sets on mousedown |
| `.rbc-addons-dnd-resize-ns-anchor` hit areas | the resize handles, which are CSS-only |
| `body.is-dragging *` | the grabbing cursor during a drag |

Every one of those is scoped to `.schedule-cal .rbc-*`, i.e. it themes a third-party
component's DOM. Forking it to re-token it means re-deriving those structural selectors by
hand, and any drift between the two copies surfaces as a broken drag preview rather than as a
colour difference. So it is reused as-is and disclosed here rather than copied. **Nothing in
the legacy file was edited by this branch.**

---

## 1. Where the behaviour map is wrong

`md_files/specs/ui-redesign/schedule-behavior-map.md` is dated 2026-07-29 and the module has
moved under it. Every disagreement was resolved in favour of the code, per the brief.

| Map says | Code says | Source |
|---|---|---|
| "**Raw hexes still in `SchedulePage.tsx`** - the ghost styles (`:1116-1117`), the slot dim `#F7F7F2` (`:1198`), the plan-mode banner gradient (`:2450`), and the three drag-image tints. These violate the CLAUDE.md token rule today." (open question 8) | **All five are already tokenised.** Ghost styles read `rgb(var(--warning-surface))` / `rgb(var(--info-surface))`; the slot dim reads `rgb(var(--background-light))`; the banner gradient reads `rgb(var(--amber-900))` -> `rgb(var(--warning-strong))`; the drag-image tints read `rgb(var(--warning-strong))` / `rgb(var(--info-strong))` / `rgb(var(--success))`. There is no raw hex left in the file | `pages/SchedulePage.tsx:1154-1162, 1247, 1502-1507, 2268-2270, 2504` |
| `schedule-dark.css` is "486 lines" | 490 | `wc -l` |
| "the 14 modules under `frontend/src/components/schedule/`" | **16** non-test modules (the task brief said "about 18") | `ls` |
| `scheduleModel.ts` is 276 lines, `UnassignedBuckets` 265, `TechnicianGridView` 540, `MemberWeekBoard` 433, `UnifiedDropModal` 191, `QuickScheduleCard` 225, `RescheduleConfirmDialog` 138, `ContextMenu` 83, `ScheduleSearch` 280, `SettingsGearDropdown` 125 | 348, 279, 553, 440, 196, 290, 109, 85, 283, 130 | `wc -l` |
| The page is 3,290 lines | 3,297 | `wc -l` |
| `unscheduleGate` for a walkthrough is "ok only when `status === 'WALKTHROUGH_SCHEDULED'`" | It reads the projected visit fields instead: ok when `walkthrough_scheduled_at` is set and `walkthrough_completed_at` is not. The map's own section 7 documents the fix; section 4.3 was not updated to match | `pages/SchedulePage.tsx:1554-1566` |
| The legacy page carries eight raw `button` elements "left raw per the program's non-Button-shape carve-out" | Correct, and the carve-out's premise no longer holds on the kit: it was about the OLD Button always shipping `rounded-button` (14px) with no radius-only prop. The kit's Button is `rounded-md` at every size, so all eight convert - see the deltas table | `components/ui/button.tsx` vs `ui-kit/components/ui/button.tsx` |

The map is otherwise unusually accurate for this module - sections 0, 4, 6 and 11 in particular
were correct in every claim checked, which is why they are quoted rather than re-derived above.

---

## 2. Gaps

| Old component | Kind | Used in | What it does | Kit's nearest thing | Why it is not enough | Also hit by | Rec |
|---|---|---|---|---|---|---|---|
| `react-big-calendar` + `addons/dragAndDrop` | component | the Standard board (day/week/month) | the whole calendar engine: slot geometry, event layout, drag-to-move, resize-to-extend, slot selection, month overflow popup, all-day strip, current-time indicator, and the `.rbc-*` DOM the entire e2e selector surface is built on | `ui/calendar` | `ui/calendar` is a react-day-picker DATE PICKER. It selects a date. It has no events, no week or day mode, no drop targets and no resize. There is nothing to substitute | Tasks (hand-rolled its own) | KEEP (a calendar engine is not a primitive) |
| `pages/schedule-dark.css` | component | the Standard board | 490 lines of `.schedule-cal .rbc-*` overrides that encode the focus-day column expansion, the all-day strip collapse, the drag-preview geometry and the resize hit areas | none | it themes a third-party component's DOM. The kit has no opinion about `.rbc-*` and cannot grow one | - | KEEP (imported, never forked - see section 0) |
| `schedule/TechnicianGridView` | component | Member + Day | the hand-rolled Member x Hour board: 14 hour drop zones per column at 96px/hr, 280px columns, idle-column hatching, `data-testid="grid-slot-<techId>-<hour>"` | none | this IS the calendar surface for grouped Day view, and it is 553 lines of pointer-only HTML5 drag geometry with 18 dataTransfer/drag sites. It has exactly TWO `@/components/...` imports - `ui/empty-state` and `data/TagChips`, and the second is a KEEP everywhere else in the program. Forking a thousand lines of the highest-risk DnD code in the app to swap ONE component, and orphaning `TechnicianGridView.test.tsx` in the process, is a bad trade | - | KEEP |
| `schedule/MemberWeekBoard` | component | Member + Week | the hand-rolled Member x Week board: seven day cells per member column, per-day "N jobs / X hrs" header, `data-testid="week-cell-<memberId>-<yyyy-MM-dd>"` | none | identical reasoning: 440 lines, 22 dataTransfer/drag sites, the same two `@/components/...` imports, and `MemberWeekBoard.test.tsx` depends on its testid pattern | - | KEEP |
| `ui/collapse` | component | the bucket stack | animated height collapse for each bucket body | none | the kit ships 24 UI primitives and none is a collapse. It was already item 15 on the roll-up's "present in the old set, absent from the kit, not yet reached by any module" list - **this module is the first to reach it.** Imported unchanged | - | BUILD |
| `crm/MultiAssigneeSelect` | component | drop modal, event editor | the crew multi-select: owns its own `useAssignableUsers` query, an eligibility filter and multi-value chips | `form/combobox` | the combobox is a static-options Command picker with one list, no data source and no eligibility rule. Imported unchanged | Tasks | KEEP |
| `form/TimeSelect` | component | quick-schedule popover | 15-minute Radix Select over times of day | `form/datePicker` | the kit picker is date-ONLY. It also cannot be swapped for a native `<input type="time">`: the page's outside-click listener whitelists `[data-radix-popper-content-wrapper]` specifically so picking a time does not close the popover, and a native picker is not in that wrapper. Imported unchanged | Tasks (filed the same absence as `DateTimePicker`) | BUILD (a TimePicker beside DatePicker) |
| `data/TagChips` | component | bucket cards, both member boards | renders an entity's org tag vocabulary, colour from `tag.color` runtime data | `crm/tagInput` / `ui/badge` | the kit's tagInput takes `value: string[]` and emits `onValueChange` - free text, no org vocabulary. `ui/badge` has a closed variant vocabulary and `tag.color` is user data applied as an inline style. Imported unchanged | Customers, Estimates, Invoices | BUILD (this is now four modules) |
| `jobs/AssignJobDialog` | component | quick-schedule popover -> "select job" | crew multi-select, all-day checkbox, start/end `datetime-local`, its own inline 409 conflict block with its own "Schedule Anyway", and its own mutations | none | it is a JOBS module component with its own mutations and its own conflict flow, not schedule chrome. Rebuilding it here would fork the Jobs module's write path. Imported unchanged | - | KEEP (belongs to Jobs) |
| `jobs/CancelJobDialog` | component | context menu -> "Cancel Job" | the job cancellation flow | none | same: a Jobs module component with its own mutation. Imported unchanged | - | KEEP (belongs to Jobs) |
| `ui/confirmDialog` - no icon slot, no body slot | kit API | plan-mode ghost confirm, confirm-all, reschedule confirm | a titled confirmation with a detail block | it IS the kit's thing | `ConfirmDialogProps` (lines 13-24) declares `title`, `description`, `confirmLabel`, `cancelLabel`, `isPending`, `destructive`, `onConfirm` - and nothing else. It hardcodes `<AlertTriangle />` and renders no children. All three of this module's confirmations exist to show a BODY: the crew/customer/location about to be committed, the scrollable list of drafts in view, and the from/to panel with its notification list. A confirmation that dropped the body would ask the user to confirm something the dialog no longer names. Built `components/confirmDialog.tsx` on the kit's Dialog parts with an `icon` and a `children` slot | - | BUILD (`icon?: ReactNode` and `children` on the kit component) |
| a Modal with three footer actions | component | plan-mode exit dialog | Cancel / Discard & Exit / Confirm All & Exit | `ui/confirmDialog` | the kit's confirm holds a fixed Cancel+Confirm pair, and the kit ships no Modal at all. The legacy page reached for `ui/modal` for exactly this reason. Assembled from the kit's Dialog parts directly at the call site | - | KEEP (three-action dialogs are rare enough to compose) |
| a toggle group (`SegmentedGroup` / `Segment`) | component | Standard/Member, Day/Week/Month, Full day/Morning/Afternoon, Jobs/Walkthroughs | four segmented controls, six cells in the header alone | none | `toggle-group` was item 13 on the roll-up's unreached list - **this module is the first to reach it.** Built `components/segmented.tsx` on kit Button | - | BUILD (this module needed it four times over) |
| `form/formField` outside react-hook-form | kit API | drop modal, event editor | label + control + error | it IS the kit's thing | `useFormField()` destructures `getFieldState` off `useFormContext()`, which is `createContext(null)`, so outside a `<Form>` it throws a TypeError immediately. Neither of this module's dialogs has a form library. Used kit `Label` + a flex column, the same shape Leads, Customers, Service Plans and Tasks all landed on | Customers, Service Plans, Tasks, Leads | BUILD (this is now five modules) |
| `data/emptyState` - no `density` / `variant` | kit API | event editor ("No crew"), bucket bodies, search dropdown | a compact empty state inside a small panel | it IS the kit's thing | the legacy `ui/empty-state` takes `density="compact" \| "flush"` and `variant="card"`; the kit's takes `icon`, `title`, `description`, `action` and nothing else, and its own `px-5 py-11` padding. Inside a 240px sidebar bucket that is a lot of whitespace. The EmptyState appearance ratchet is at its floor, so a call-site `py-` override is not available either. Used as-is and disclosed | - | BUILD (a `density` prop, or a `compact` variant) |

---

## 3. Replaced (the audit trail)

Every `@/components/...` import across the legacy page and the sixteen `components/schedule/`
modules. Rows marked KEEP are imported unchanged and have a gap row above.

### `pages/SchedulePage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/button` | `ui-kit/components/ui/button` | `variant="onDark"` and `tone="danger"` have no kit equivalent; the banner's two actions become `secondary` and `default`, and the destructive ones become `variant="destructive"` |
| `ui/input` | `ui-kit/components/ui/input` | |
| `ui/dialog` | `ui-kit/components/ui/dialog` | plus `DialogBody` and `DialogIcon`, which the legacy set does not have. The kit's `DialogHeader` is a flex ROW, so title+description are wrapped in one child at every call site |
| `ui/modal` | kit Dialog parts, assembled at the call site | gap row - three footer actions |
| `ui/confirm-dialog` | `pages/v2/schedule/components/confirmDialog` (`ScheduleConfirmDialog`) over kit Dialog | gap row - no icon slot, no body slot |
| `form/SelectField` | `ui-kit/components/ui/select` primitives | the wrapper took an options ARRAY; the kit ships the primitives, so trigger/content/item are written out. Same Radix behaviour, same `role="combobox"`, same accessible name, same `__add__` sentinel |
| `ui/empty-state` | `ui-kit/components/data/emptyState` | `icon={CalendarX2}` becomes `icon={<CalendarX2 />}` - the kit takes an element, not a component reference |
| `ui/use-toast` | `ui-kit/components/ui/sonner` (`toast`) | `toast({title, description})` becomes `toast(title, {description})` at all ten call sites. The mounted `KitToaster` is already in `App.tsx:310` |
| `schedule/SettingsGearDropdown` | `pages/v2/schedule/components/settingsGearDropdown` | |
| `schedule/ContextMenu` | `pages/v2/schedule/components/contextMenu` | |
| `schedule/RescheduleConfirmDialog` | `pages/v2/schedule/components/rescheduleConfirmDialog` | |
| `schedule/ScheduleSearch` | `pages/v2/schedule/components/scheduleSearch` | |
| `schedule/QuickScheduleCard` | `pages/v2/schedule/components/quickScheduleCard` | |
| `schedule/UnassignedBuckets` | `pages/v2/schedule/components/unassignedBuckets` | |
| `schedule/EventEditor` | `pages/v2/schedule/components/eventEditor` | |
| `schedule/UnifiedDropModal` | `pages/v2/schedule/components/unifiedDropModal` | |
| `schedule/TechnicianGridView` | kept, imported unchanged | gap row |
| `schedule/MemberWeekBoard` | kept, imported unchanged | gap row |
| `schedule/scheduleModel`, `dragChannels`, `eventPeople`, `useScheduleData`, `useScheduleEvents` | kept, imported unchanged | shared domain logic and data hooks - forking any of them is the failure mode the brief exists to prevent |
| `jobs/AssignJobDialog`, `jobs/CancelJobDialog` | kept, imported unchanged | gap rows |
| `layout/search-shared` | kept, imported unchanged | a type plus three pure helpers |
| eight raw `button` elements | kit `Button`, `Segment`, or `MenuItem` | the sidebar open/collapse pair, the Standard/Member pair, Plan Mode, the view switcher, the time-of-day window, and the sidebar context-menu row. See the deltas table |
| the three residual hand-rolled overlays | **kept hand-rolled**, kit tokens only | conflict modal, needs-crew warning, D6 unschedule confirm. See section 5 |
| (page header authored nowhere - the legacy board has none) | `ui-kit/components/layout/pageHeader` + `pages/v2/pageBreadcrumbs` | `navKey="schedule"` |

### `components/schedule/SettingsGearDropdown.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/popover` | `ui-kit/components/ui/popover` | |
| raw `button` trigger | `ui-kit/components/ui/button` `variant="ghost"` + `border` | the legacy comment says outline was rejected because it carries an idle surface fill; ghost-plus-hairline is the treatment it was reaching for. `aria-label="Schedule settings"` preserved |
| three raw `button` staff-filter rows | `ui-kit/components/ui/button` | gain `aria-pressed` |
| (section rules authored inline) | `ui-kit/components/ui/separator` | |
| the legend swatches | **kept on `bg-info` / `bg-warning` / `bg-ai` / `bg-danger` / `border-danger` / `bg-text-soft`** | NOT chrome. Each swatch is a key to a colour `eventStyleGetter` is actually painting, and that function is inside the calendar boundary. Re-tokening the swatches would leave the legend describing colours that are not on the board |

### `components/schedule/ContextMenu.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| three raw `button` rows | `pages/v2/schedule/components/menuSurface` (`MenuItem`) over kit Button | |
| (surface authored inline) | `menuSurface` (`MenuSurface`) | deliberately NOT the kit's `DropdownMenu` - see section 5 |
| (separator authored inline) | `ui-kit/components/ui/separator` | |

### `components/schedule/RescheduleConfirmDialog.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/confirm-dialog` | `components/confirmDialog` (`ScheduleConfirmDialog`) | gap row |
| (from/to panel, crew line, email notice) | kit tokens on the same markup | copy unchanged, including "Crew (unchanged)" and "Confirm & Notify" |

### `components/schedule/ScheduleSearch.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| raw `input` + hand-rolled magnifier + raw `button` clear | `ui-kit/components/form/searchInput` | it owns the magnifier, the clear affordance and the 300ms debounce, so the local debounce effect is gone. The combobox ARIA is passed through and overrides the kit's `role="searchbox"` |
| `ui/empty-state` | `ui-kit/components/data/emptyState` | `density="compact"` dropped - gap row |
| raw `button role="option"` rows | `div role="option"` | see the deltas table - this is an a11y correction, not only a ratchet move |
| (footer rule authored inline) | `ui-kit/components/ui/separator` | |
| `layout/search-shared` | kept, imported unchanged | |

### `components/schedule/QuickScheduleCard.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| raw `button` close | `ui-kit/components/ui/button` `size="icon-sm"` | `aria-label="Close"` preserved |
| two raw `button` tabs | `components/segmented` | gap row |
| raw `input` filter | `ui-kit/components/ui/input` | gains an `aria-label` - the legacy field had none |
| two raw `button` result-row families | `ui-kit/components/ui/button` `variant="ghost"` | |
| `form/TimeSelect` | kept, imported unchanged | gap row |

### `components/schedule/UnifiedDropModal.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/dialog` | `ui-kit/components/ui/dialog` (+ `DialogBody`, `DialogFooter`) | |
| `ui/button` | `ui-kit/components/ui/button` | `variant="solid" tone="business"` becomes the kit default |
| `ui/label` | `ui-kit/components/ui/label` | |
| `ui/input` | `ui-kit/components/ui/input` | |
| `form/SelectField` | `ui-kit/components/ui/select` primitives | `aria-label="Duration"` preserved |
| `patterns/FormField` | kit `Label` + a flex column | gap row |
| `crm/MultiAssigneeSelect` | kept, imported unchanged | gap row. `role="group"` + `aria-labelledby` wrapper preserved |
| `schedule/scheduleModel` | kept, imported unchanged | |

### `components/schedule/EventEditor.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/dialog` | `ui-kit/components/ui/dialog` (+ `DialogBody`) | |
| `ui/button` | `ui-kit/components/ui/button` | |
| `ui/label`, `ui/input` | the kit equivalents | |
| `form/SelectField` | `ui-kit/components/ui/select` primitives | |
| `ui/empty-state` | `ui-kit/components/data/emptyState` | `density="flush"` dropped - gap row |
| two raw `a href="tel:"` / `"sms:"` | `ui-kit/components/ui/button` setting `window.location.href` | the raw-anchor ratchet is at its floor; same substitution the Leads module made in `contactCell.tsx`. They still match `INTERACTIVE_SELECTOR`, so the whole-popup click guard keeps treating them as controls |
| (section rules authored inline) | `ui-kit/components/ui/separator` | |
| `crm/MultiAssigneeSelect` | kept, imported unchanged | gap row |
| `schedule/scheduleModel`, `schedule/eventPeople` | kept, imported unchanged | |

### `components/schedule/UnassignedBuckets.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| raw `button` disclosure row | `ui-kit/components/ui/button` | `aria-expanded` preserved |
| `ui/empty-state` | `ui-kit/components/data/emptyState` | `variant="card"` dropped - gap row |
| ("crew kept" and "soon" pills authored inline) | `ui-kit/components/ui/badge` `softGreen` / `softPurple` | |
| `ui/collapse` | kept, imported unchanged | gap row |
| `data/TagChips` | kept, imported unchanged | gap row |
| `schedule/scheduleModel`, `schedule/dragChannels` | kept, imported unchanged | `GRID_EVENT_ID` is the D6 channel gate |
| (bucket card authored inline) | plain div on kit tokens, NOT kit `Card` | Card's appearance ratchet is at its floor and the card is almost entirely conditional appearance |

### `components/schedule/TechnicianGridView.tsx`, `MemberWeekBoard.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| both files | **not rebuilt** | gap rows. Each has exactly two `@/components/...` imports (`ui/empty-state`, `data/TagChips`), zero raw tags, and 18 / 22 dataTransfer-and-drag sites. Imported unchanged by the v2 page, which keeps `TechnicianGridView.test.tsx` and `MemberWeekBoard.test.tsx` covering them |

---

## 4. Shape differences forced by the kit

| Thing | Files | Note |
|---|---|---|
| `SegmentedGroup` / `Segment` | `pages/v2/schedule/components/segmented.tsx` | first copy of a toggle group in the program. Used four times in this module |
| `MenuSurface` / `MenuItem` | `pages/v2/schedule/components/menuSurface.tsx` | first copy of a hand-positioned context-menu surface |
| `ScheduleConfirmDialog` | `pages/v2/schedule/components/confirmDialog.tsx` | first copy of a confirm dialog with an icon and a body slot |
| `glyphs.ts` (`EM` / `EN`) | `pages/v2/schedule/glyphs.ts` | second copy in the program - Tasks has `components/glyphs.ts`. CLAUDE.md forbids a literal em or en dash in source, and this page RENDERS both (record number joined to customer; the two ends of a time range). Escaped, so rendered output is unchanged |

---

## 5. Behaviour deliberately NOT moved onto the kit

### The three residual hand-rolled overlays

The conflict modal, the needs-crew warning and the D6 unschedule confirm stay hand-rolled
overlays. Only their paint moved onto kit tokens. The legacy file carries three long comments
explaining why, and they still hold:

- `conflictToast` gates `EventEditor`'s own `open` prop (`!conflictToast && !unscheduleConfirm`)
  and can be set from INSIDE an already-open EventEditor, on a live 409 from
  `handleEditorSaveTime`. Converting it to a Radix dialog would put its mount/open in the same
  tick as EventEditor's ~200ms exit animation.
- `needsCrewConfirm` gates `UnifiedDropModal`'s `open`, and "Back" flips it false and reopens
  UnifiedDropModal on the very next render - a same-tick Radix-dialog swap in both directions.
- `unscheduleConfirm` is set from EventEditor's `onUnschedule` and gates EventEditor's `open`;
  Cancel reopens EventEditor on the next render.

There is no test coverage on this file to catch a live focus-lock regression, so all three were
left on their original markup rather than risk breaking scheduling for a paint change.

### The two hand-positioned context menus

`MenuSurface` is not the kit's `DropdownMenu`. Both menus open at raw viewport coordinates from
a `contextmenu` event with no trigger element to anchor to, and the PAGE owns their dismissal -
a capturing, 100ms-delayed `mousedown` listener that skips `[class*="fixed"][class*="z-["]`,
plus the global Escape handler. Radix would take both over. The `fixed` + `z-[...]` class pair
on the surface is load-bearing for that listener, not styling.

### The error toast is not sonner

`errorToast` is a page-owned, MANUALLY dismissed surface: it is cleared by its own Dismiss
button and by the global Escape handler, and stays on screen until one of those happens. sonner
auto-dismisses after 4s, so routing a failed schedule write through `toast.error` would drop it
off the screen while the user was still looking at the board. The ten advisory one-way toasts
(crew updated, crew swapped, scheduled, completed, unscheduled, can't reschedule, can't
unschedule, already-on-crew) DO go through sonner.

---

## 6. Behaviour deltas (not gaps, but not parity either)

| What | Legacy | v2 | Why |
|---|---|---|---|
| Page title | none - the board is full-bleed | kit `PageHeader` + `PageBreadcrumbs navKey="schedule"` | every v2 module has one; the board becomes a flex column so it still owns its own height |
| Segmented toggle cells | raw button elements, no pressed state | kit Buttons with `aria-pressed` | four unlabelled identical controls per group was a defect; naming the state of a control is not a behaviour change |
| Prev/next date buttons | no accessible name at all | `aria-label="Previous period"` / `"Next period"` | the e2e suite locates them by `.lucide-chevron-left` / `.lucide-chevron-right`, which the identical icons preserve |
| Search result rows | `button role="option"` | `div role="option"` | under `aria-activedescendant` the options must not be focusable. The old markup added a tab stop per result and let focus leave the input while `aria-activedescendant` still claimed it was there. Arrow keys and Enter were always on the input |
| Quick-schedule filter field | raw `input`, no accessible name | kit `Input` with `aria-label` | |
| Plan-mode banner | a two-stop amber GRADIENT built from `--amber-900` and `--warning-strong` | the flat `status-amber` fill | the kit has no gradient ramp, and `status-amber` is the one token the whole app already uses for "pending, not yet committed" |
| Plan-mode banner actions | `variant="onDark"` + a hand-built inverse fill | kit `secondary` and `default` | the kit has no on-dark variant |
| `tel:` / `sms:` in the editor | anchors | kit Buttons setting `window.location.href` | raw-anchor ratchet at its floor |
| Cross-module navigation | bare `/jobs/:id`, `/leads/:id`, `/service-plans` | `preferV2Path(...)` | a v2 page navigating to a bare legacy path drops the user out of the v2 layer with no way back whenever the flag is off. `preferV2Path` resolves to the v2 route only when the module has one, so it can never 404. In `detailUrlOf` it is applied to the PATH only and `?tab=walkthrough` is appended after - the matcher compares path segments and a query string would make the last one unmatchable |
| Empty states inside panels | `density="compact"` / `"flush"` / `variant="card"` | the kit's single padded shape | gap row - the kit has no density prop and the EmptyState ratchet is at its floor |
| Toasts | `ui/use-toast` `{title, description}` | sonner `toast(title, {description})` | the same API shift every prior v2 module made |
| Em and en dashes | literal characters in source | `glyphs.ts` unicode escapes | CLAUDE.md forbids them in source; these are RENDERED CONTENT and the e2e surface matches on text, so they are escaped rather than dropped. Rendered output is identical |

---

## 7. Behaviour not reproduced

None.

Every gate, mutation, query key, drag channel, drop classification, optimistic write, rollback,
keyboard shortcut, testid and literal string listed in the behaviour map's section 11
reimplementation checklist is present in the v2 page. The three items above that read like
losses - the empty-state densities, the banner gradient, the on-dark button variant - are
appearance-only and are recorded as deltas, not as behaviour.

---

## 7a. Test coverage the v2 path does not inherit

Stated plainly because it is easy to miss: `components/schedule/` ships eight colocated vitest
suites, and they test the LEGACY components. Four of those components were rebuilt here, so on
the `/v2/schedule` path their coverage does not carry over:

| Legacy suite | Still covers what the v2 page imports? |
|---|---|
| `TechnicianGridView.test.tsx` | **yes** - the v2 page imports the legacy component unchanged |
| `MemberWeekBoard.test.tsx` | **yes** - same |
| `scheduleModel.test.ts`, `dragChannels.test.ts`, `eventAdapters.test.ts`, `eventPeople.test.ts`, `useScheduleData.test.tsx`, `useScheduleEvents.test.tsx` | **yes** - all six cover shared logic the v2 page imports unchanged |
| `UnassignedBuckets.test.tsx` | no - the v2 page imports `pages/v2/schedule/components/unassignedBuckets` |
| `EventEditor.test.tsx` | no - rebuilt |
| `UnifiedDropModal.test.tsx` | no - rebuilt |
| `ContextMenu.test.tsx` | no - rebuilt |

Nothing regressed: all twelve files and 149 tests under `src/components/schedule` still pass,
because this branch modifies no legacy file. But the four rebuilt components are uncovered on
the v2 path, and `UnassignedBuckets` is the one that matters most - it owns the D6
drag-to-unschedule drop target and its `grid-event-id` channel gate. Porting those four suites
against the v2 components is the obvious follow-up and was not done here.

## 8. Observed but not fixed

| What | Where | Why it is out of scope |
|---|---|---|
| **The `reschedule Job` per-user grant is unreachable on this page.** `backend/src/lib/permissions/userCapabilities.ts` makes `reschedule` an admin-grantable per-user capability, but `SchedulePage.tsx` gates purely on `boardCapabilitiesFor(role)`, which returns `readOnly: true` for every TECHNICIAN regardless of grants. A granted technician therefore gets a read-only board and has to reschedule from `/jobs/:id`. `canOnJob` (`lib/ability.ts:46`) is imported by neither the legacy page nor any file under `components/schedule/`. | `components/schedule/scheduleModel.ts:80-84` vs `userCapabilities.ts` | Reproduced EXACTLY. Wiring the grant in would widen who can write to the schedule - a permission change dressed as a restyle, and the single most dangerous thing this migration could do by accident. The behaviour map raises it as open question 2; it needs the permissions owner, not a UI branch |
| `assign` is the verb the backend actually enforces on three of the page's four main writes (`job.routes.ts:29,31`, `lead.routes.ts:38,40`) but it is **not** in `USER_CAPABILITIES` | `backend/src/lib/permissions/userCapabilities.ts` | backend surface; worth confirming with the permissions owner |
| The empty-state copy says "No jobs scheduled **this week**" in Day and Month view too | v2 page, reproduced verbatim | a presentation swap does not get to fix copy. Behaviour map open question 5 |
| `beforeunload` is registered by two byte-identical effects | v2 page, both carried over | harmless, and dropping one is a behaviour change in a file this large. Behaviour map open question 4 |
| `!border-solid` in `eventStyleGetter` does not resolve to any CSS rule - it is one of the 52 classes the unresolved-class guard already reports | v2 page, carried over verbatim | it is inside `eventStyleGetter`, which is the calendar boundary. Removing it is provably a no-op visually, but it is still a change to event colouring. The class NAME count did not grow; only the file list under that one name did |
| `.schedule-sidebar-section` and `.schedule-chevron` in `schedule-dark.css` appear dead - no `.tsx` applies them | `pages/schedule-dark.css` | the file is imported, not forked, and this branch edits no legacy file |
| Two colour systems for events: the standard calendar uses `info`/`warning`/`text-soft`, the member boards use `EVENT_TYPE_META` plus raw `slate`/`emerald` | `eventStyleGetter` vs `scheduleModel.boardCardScheme` | unifying them is a visual change that needs sign-off. Behaviour map open question 7 |
| Resize is not implemented in either member view - no handles are rendered | `TechnicianGridView`, `MemberWeekBoard` | a known P2 gap that `sched-resize.spec.ts` G-08 documents as such. Adding it is a feature |
| Two e2e specs assert behaviour the code no longer has: `schedule-dnd.spec.ts` expects a sidebar drop to open `AssignJobDialog` ("Assign Technician") when it now opens `UnifiedDropModal`, and uses the label `By Technician` which is now `Member View` | `frontend/e2e/specs/schedule-dnd.spec.ts` | pre-existing red against the LEGACY page, not introduced here. Playwright was not run on this branch - see the report |
| The kit's `DialogHeader` is a flex ROW, so a title and its description sit side by side unless wrapped | `ui-kit/components/ui/dialog.tsx` | worked around at all five call sites by wrapping them in one child. A `DialogHeaderText` part, or a row/column prop, would remove the trap |
