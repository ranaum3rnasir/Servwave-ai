# Schedule module - behaviour map (UI-kit migration, module 7)

Status: mapping complete 2026-07-29. Documentation only - no code was changed.
Scope: route `/schedule`, `frontend/src/pages/SchedulePage.tsx` (3,290 lines),
`frontend/src/pages/schedule-dark.css` (486 lines), and the 14 modules under
`frontend/src/components/schedule/`.
Every claim below was read from the files named. Ambiguities are parked in
section 12 (Open questions) rather than guessed.

---

## 0. The react-big-calendar boundary (read this first)

The CRM UI kit ships **no calendar component**. The calendar engine therefore
**stays exactly as it is**; only the chrome around it is swappable. The boundary
is mechanically precise:

### 0.1 UNTOUCHABLE - react-big-calendar internals

Anything below is owned by `react-big-calendar@^1.19.4` + its
`addons/dragAndDrop` HOC. A v2 page must import and configure these identically.

| Thing | Where | Why it is untouchable |
|---|---|---|
| `Calendar`, `Views`, `dateFnsLocalizer` | `SchedulePage.tsx:9` | library API |
| `withDnD(Calendar)` -> `DnDCalendar` | `:10`, `:115` | the entire calendar-side DnD engine |
| `react-big-calendar/lib/css/react-big-calendar.css` | `:31` | base grid geometry |
| `react-big-calendar/lib/addons/dragAndDrop/styles.css` | `:32` | drag/resize anchor geometry |
| `.rbc-*` DOM (`.rbc-event`, `.rbc-day-slot`, `.rbc-time-content`, `.rbc-header`, `.rbc-time-header-content`, `.rbc-allday-cell`, `.rbc-addons-dnd-*`, `.rbc-current-time-indicator`, `.rbc-month-view`, `.rbc-time-view`, `.rbc-show-more`, `.rbc-overlay`, `.rbc-date-cell`, `.rbc-today`, `.rbc-slot-selection`) | emitted by the library | **the whole e2e selector surface is built on these class names** |
| Slot/day geometry, drag preview, resize anchors, month "+N more" popup (`popup` prop `:2611`), `dayLayoutAlgorithm="no-overlap"` (`:2609`) | library | behaviour, not styling |
| `onEventDrop` / `onEventResize` / `onDropFromOutside` / `dragFromOutsideItem` / `draggableAccessor` / `resizableAccessor` contract | library props | the app only supplies callbacks |

### 0.2 SWAPPABLE - app chrome around the engine

| Thing | Where |
|---|---|
| Page shell / flex layout / sidebar container | `SchedulePage.tsx:2151-2287` |
| Header rows 1 and 2 (Today/prev/next, date label, Standard-vs-Member toggle, Plan Mode pill, gear, Day/Week/Month switcher, department filter, time-of-day window) | `:2290-2445` |
| Plan Mode banner | `:2448-2489` |
| Left sidebar: `ScheduleSearch`, collapse button, `UnassignedBuckets`, plan-visit cards, resize handle | `:2154-2284` |
| Every dialog / popover / context menu / toast listed in section 5 | `:2619-3287` |
| The two member boards (`TechnicianGridView`, `MemberWeekBoard`) - **hand-rolled, no rbc involved** | `components/schedule/` |
| Custom rbc slot components: `ScheduleEvent` (`:156-338`) and `DayHeader` (`:940-992`) - these render *inside* rbc but their markup is ours | `:994-998` |
| `schedule-dark.css` - 486 lines of `.schedule-cal .rbc-*` overrides | `pages/schedule-dark.css` |

### 0.3 The hard rule for the v2 build

`schedule-dark.css` is **not decoration** - it encodes behaviour:

- the expanded-day-column mechanism (`[data-focus-day="N"]` -> `flex-grow:4` on
  the header cell + `width:400%` on the body column, `:83-102`),
- all-day strip collapse/expand (`.has-allday-events`, `:104-118`),
- drag-preview width/left via the `--drag-preview-width` / `--drag-preview-left`
  CSS vars the page sets on mousedown (`:236-244` + `SchedulePage.tsx:704-733`),
- the resize-handle hit areas (`:249-289`),
- `body.is-dragging * { cursor: grabbing }` (`:231-233`).

**Re-theming this file means re-deriving those rules. Do not "port the tokens"
and drop the structural selectors.** The three raw brand hexes it uses
(`#0C2D3A`, `#071F2B`, `#F7F7F2`) plus the neutral greys (`#dadce0`, `#70757a`,
`#ea4335` for the now-line) will need token equivalents - note this file is
currently exempt from the "no raw hex" rule because it is a CSS override sheet,
not a component.

---

## 1. Route, guards, and who lands here

### 1.1 Route

`frontend/src/App.tsx:132` - `<Route path="/schedule" element={<SchedulePage />} />`.
Lazily imported at `App.tsx:27`. Nested inside:

```
<ProtectedRoute allowedRoles={['ADMIN','SALES','DISPATCHER','TECHNICIAN']}>   (App.tsx:111)
  <AppLayout>                                                                 (App.tsx:112)
    <Route path="/schedule" .../>
```

- No `fallback` prop -> an out-of-role user is `<Navigate to="/" replace />`
  (`ProtectedRoute.tsx:29`); unauthenticated -> `/login` (`:25`).
- **No feature gate, no entitlement gate, no `DemoOnlyRoute`** on this route.
- Sentry names the transaction `/schedule` via `withSentryReactRouterV7Routing`.

### 1.2 The TECHNICIAN landing redirect

There is **no hard-coded `/schedule` redirect**. It is emergent:

`HomeRoute.tsx` (mounted at `/`):
1. `ability.can('read','Dashboard')` -> render `DashboardPage`.
2. otherwise -> first entry of `DEFAULT_LAYOUT_KEYS` (excluding `dashboard` and
   `comingSoon`) whose `(action, subject)` the ability permits.

`nav-registry.ts:93` - `DEFAULT_LAYOUT_KEYS = ['dashboard','schedule','tasks',...]`,
and `schedule` is `{ action: 'read', subject: 'Job' }` (`:58`). A technician has
own-scoped `read Job` but not `read Dashboard`, so `/` -> `<Navigate replace to="/schedule">`.

**Implication for v2:** if the migration adds `/v2/` routes, the redirect target
stays `/schedule` unless `nav-registry` is touched. Do not touch it.

### 1.3 Role capability matrix on this page

`scheduleModel.ts:80-84` - `boardCapabilitiesFor(role)`:

| Role | `memberView` | `readOnly` |
|---|---|---|
| ADMIN | true | false |
| DISPATCHER | true | false |
| SALES | false | false |
| TECHNICIAN | false | **true** |
| unknown / missing role | false | **true** (fails safe) |

Consumed at `SchedulePage.tsx:349-351` as `canMemberView` / `boardReadOnly`.
Separately, `canPlanMode = role === 'ADMIN' || role === 'DISPATCHER'` (`:346`).

Data scoping is **server-side** (`scopeWhereFor`); these flags gate UI controls only.

---

## 2. Component tree

```
SchedulePage  (ScheduleCtx.Provider)
└── div.h-full.flex                                              :2151
    ├── [!sidebarOpen] collapsed rail (w-10, PanelLeftOpen btn)   :2154-2165
    ├── [sidebarOpen] sidebar  (hidden lg:flex, style.width=sidebarWidth)  :2170
    │   ├── ScheduleSearch  (+ PanelLeftClose collapse btn)       :2176-2191
    │   └── UnassignedBuckets                                     :2193-2274
    │        ├── section "Jobs"          (Briefcase)   BucketCard[]
    │        ├── section "Walkthroughs"  (Footprints)  BucketCard[]
    │        └── section "Service Plans" (Repeat)  -> planSlot (page-owned pv- cards)
    ├── sidebar resize handle (6px, -3px margins, cursor-col-resize)  :2280-2284
    └── main canvas                                               :2287
        ├── header
        │   ├── row 1: Today | < | > | dateRangeLabel
        │   │          [centered] Standard/Member toggle (canMemberView) + Plan Mode (canPlanMode)
        │   │          [ml-auto] SettingsGearDropdown                  :2293-2376
        │   └── row 2: day/week/month switcher
        │              [centered, deptShift px] department SelectField
        │              [ml-auto] Full day / Morning / Afternoon        :2379-2443
        ├── [planMode.isActive] Plan Mode banner (Discard All / Confirm All)  :2448-2489
        └── board region                                          :2492-2614
            ├── effectiveGroupedView && WEEK  -> MemberWeekBoard
            │        └── StaffColumn[] -> DaySection[] (7) -> BoardCard[]
            ├── effectiveGroupedView && DAY   -> TechnicianGridView
            │        └── TechColumn[] -> hour drop zones (6-20) + JobCard[]
            └── else -> div.schedule-cal
                 ├── loading overlay (Loader2)                    :2535
                 ├── empty overlay (CalendarX2 + copy)            :2540
                 └── DnDCalendar  (components: {toolbar:null, event:ScheduleEvent, header:DayHeader})

   Portals / overlays (siblings of the flex row, all conditionally rendered):
     ScheduleContextMenu               :2620   right-click on a board event
     sidebar card context menu (inline):2644   right-click on a bucket card
     QuickScheduleCard  (slot)         :2695   click empty time slot
     QuickScheduleCard  (all-day)      :2725   click day header (non-week views)
     ghost context menu (inline)       :2757   right-click a plan-mode ghost
     ghost confirm dialog (inline)     :2799
     confirm-all dialog (inline)       :2867
     plan-mode exit dialog (inline)    :2913
     conflict modal (inline)           :2968   409 force path
     error toast (inline)              :3031
     RescheduleConfirmDialog           :3049
     AssignJobDialog                   :3103   (always mounted, open-driven)
     CancelJobDialog                   :3113   (always mounted, open-driven)
     Add-Department Dialog             :3120
     EventEditor                       :3169   (always mounted, open-driven)
     UnifiedDropModal                  :3196   (always mounted, open-driven)
     needs-crew confirm (inline)       :3213
     unschedule confirm (inline)       :3251
```

### 2.1 `ScheduleCtx` - the event-component escape hatch

`SchedulePage.tsx:132-144`. `ScheduleEvent` is handed to rbc as a slot component,
so it cannot receive page props. It reads
`{ onEventMouseEnter, onEventMouseLeave, onEventContextMenu, conflictIds }` from
context instead. **Any v2 rewrite must keep an equivalent context** - rbc will
not thread props through.
Note `onEventMouseEnter/Leave` are currently **no-op** callbacks (`:790-791`);
the hover tooltip was removed. The context still carries them.

### 2.2 Supporting modules (`components/schedule/`)

| File | Lines | Role |
|---|---|---|
| `scheduleModel.ts` | 276 | pure domain core: `SchedulableEvent`, 4-state model, `deriveState`, `isOnBoardFor`, `boardCapabilitiesFor`, `eventDangerState`, `conflictedEventIds`, `swapCrew`, `classifyBoardDrop`, `draftFromDrop`, `conflictNoteFor`, `atMinutes`, `hhmmToMin`, `EVENT_TYPE_META`, `STATE_META` |
| `dragChannels.ts` | 54 | the HTML5 dataTransfer codec (see 4.1) |
| `eventAdapters.ts` | 57 | `jobToEvent` / `walkthroughToEvent` |
| `eventPeople.ts` | 34 | `crewPeopleOf` / `ownerOf` / `fullName` |
| `useScheduleData.ts` | 88 | the 4 read queries |
| `useScheduleEvents.ts` | 76 | adapters -> `scheduledEvents` / `bucketEvents` / `visibleBucketEvents` / `conflictIds` |
| `UnassignedBuckets.tsx` | 265 | the 3-bucket sidebar stack + the unschedule drop target |
| `TechnicianGridView.tsx` | 540 | Member x Day hour grid |
| `MemberWeekBoard.tsx` | 433 | Member x Week day-cell board |
| `EventEditor.tsx` | 430 | the only per-person crew edit path |
| `UnifiedDropModal.tsx` | 191 | the D5 drop modal |
| `QuickScheduleCard.tsx` | 225 | slot popover |
| `RescheduleConfirmDialog.tsx` | 138 | from -> to confirm |
| `ContextMenu.tsx` | 83 | board-event right-click menu |
| `ScheduleSearch.tsx` | 280 | scoped `/api/search` combobox |
| `SettingsGearDropdown.tsx` | 125 | legend + staff filter + shortcuts |

All of these have colocated vitest specs (`*.test.tsx` / `*.test.ts`) - 8 test
files. Those tests exercise the **existing** components; a v2 page that keeps
importing them keeps that coverage for free.

---

## 3. Views, view state, and date navigation

### 3.1 The two orthogonal axes

There is no single "view" value. Two independent pieces of state combine:

| State | Values | Where |
|---|---|---|
| `calendarView` | `Views.DAY` / `Views.WEEK` / `Views.MONTH` (string) | `:355`, default `Views.WEEK` |
| `isGroupedView` | `false` = Standard, `true` = Member | `:356`, default `false` |

`effectiveGroupedView = canMemberView && isGroupedView` (`:359`) - a render-time
fallback so a SALES/TECHNICIAN session can never end up on a member board even if
`isGroupedView` flips.

Resulting matrix:

| grouped | calendarView | renders |
|---|---|---|
| false | day | `DnDCalendar` view=day |
| false | week | `DnDCalendar` view=week (default landing) |
| false | month | `DnDCalendar` view=month |
| true | day | `TechnicianGridView` (hand-rolled, 6:00-20:00, 96px/hr, 280px/col) |
| true | week | `MemberWeekBoard` (hand-rolled, 7 day-sections per member column) |
| true | month | **unreachable** - the toggle forces `WEEK` (`:2328`) and the month button is not rendered in grouped mode (`:2383-2386`) |

**Agenda / work_week:** rbc's defaults include them and the `view` prop is typed
to accept them (`:2555`), but nothing in the UI can select them (the toolbar is
replaced by `() => null`, `:995`). Treat agenda as **not implemented**.

### 3.2 State that is NOT persisted

`calendarView`, `isGroupedView`, `currentDate`, `timeWindow`, `roleFilter`,
`departmentFilter`, `focusedDayIndex`, `sidebarOpen` are all plain `useState` -
they reset on remount. Only two things persist:

- sidebar width -> `localStorage['schedule-sidebar-width']` (`useResizableWidth`, clamped 180-420, default 240)
- plan mode -> `localStorage['plan-mode-<tabId>']`, tab id in `sessionStorage['plan-mode-tab-id']` (`usePlanMode.ts:44-54`)

### 3.3 Date navigation

- `handleNavigateToday` (`:866`) -> `setCurrentDate(new Date())`
- `handleNavigatePrev` / `Next` (`:868-882`) - step size depends on `calendarView`:
  day -> `subDays/addDays 1`; month -> `subMonths/addMonths 1`; else -> `subWeeks/addWeeks 1`.
- rbc's own `onNavigate` is also wired (`:2558`) - `setCurrentDate`.
- `onDrillDown` (`:2559-2563`): month-view day-number click -> set date + switch to DAY.
- `handleSelectSlot` in MONTH view (`:1987-1991`): clicking a day cell -> DAY view (no popover).
- `DayHeader` click in WEEK view (`:963-967`): -> that day in DAY view.
- Edge-scroll while dragging (`:887-927`): a `dragover` within 60px of the
  `.schedule-cal` left/right edge starts a 600ms interval that calls
  prev/next repeatedly until the pointer leaves the zone or drag ends.

### 3.4 Date range and label

`dateRange` (`:410-419`): DAY -> `startOfDay..endOfDay`; MONTH -> `startOfWeek(startOfMonth)..endOfWeek(endOfMonth)`;
otherwise -> `startOfWeek..endOfWeek`. `weekStartsOn: 0` (Sunday) throughout.
This object is a **query key** - see section 6.

`dateRangeLabel` (`:804-820`): DAY -> `EEEE, MMMM d, yyyy`; MONTH -> `MMMM yyyy`;
WEEK -> `MMM d – d, yyyy` / `MMM d – MMM d, yyyy` / full both-years form when the
week straddles a year. Rendered in a `<span key={dateRangeLabel}>` so the
`schedule-popup-enter` animation replays on change (`:2305`).

### 3.5 Time-of-day window

`timeWindow` (`:372`) -> `full` (00:00-23:59:59, scrollToTime 06:00) /
`morning` (07:00-12:00) / `afternoon` (12:00-18:00) (`:932-937`), fed to rbc as
`min` / `max` / `scrollToTime`. Because rbc clamps out-of-window events into
slivers, `windowedEvents` (`:1075-1085`) additionally **filters** timed events
outside the window (all-day events and MONTH view are exempt).
The window control only renders in Standard + non-month (`:2425`).

### 3.6 Expanded day column (week view)

`focusedDayIndex` (0-6 or null, `:370`). `handleCalendarDoubleClick` (`:838-857`)
resolves a double-click on `.rbc-day-slot` or `.rbc-header` to a column index via
`Array.indexOf`, and `toggleDayFocus` toggles it. The index lands on the wrapper
as `data-focus-day` (`:2532`) and `schedule-dark.css:83-102` widens both halves.
Reset whenever `currentDate`, `calendarView` or `isGroupedView` changes (`:860-862`).

A 250ms timer (`dayHeaderClickTimer`, `:831`) separates the single click
(navigate / open all-day popover) from the double click (expand column).

### 3.7 Off-hours and today

`slotPropGetter` (`:1195-1201`) paints `#F7F7F2` on slots before 07:00 or from
19:00. `.rbc-today` gets `rgba(12,45,58,0.04)` (`schedule-dark.css:130`).
The now-line is rbc's `.rbc-current-time-indicator`, restyled Google-red with a
left dot (`:165-181`).

---

## 4. Drag and drop - exhaustive

This is the highest-risk surface. There are **three separate DnD systems** in
one page. They share a payload codec but nothing else.

| System | Engine | Where |
|---|---|---|
| A. Calendar internal move/resize | rbc `addons/dragAndDrop` (mouse-based) | `onEventDrop`, `onEventResize` |
| B. Sidebar -> calendar | HTML5 native drag, handed to rbc via `onDropFromOutside` + `dragFromOutsideItem` | `handleDropFromOutside` |
| C. Member boards + unschedule | pure HTML5 native drag, hand-rolled | `TechnicianGridView`, `MemberWeekBoard`, `UnassignedBuckets` |

### 4.1 The drag payload codec (`dragChannels.ts`)

Five `dataTransfer` keys:

| Constant | Value | Written by | Carries |
|---|---|---|---|
| `JOB_ID` | `job-id` | bucket job card (`:1457`) | bare job id |
| `WALKTHROUGH_ID` | `walkthrough-id` | bucket walkthrough card (`:1455`) | **bare lead id** (no `wt-`) |
| `GRID_EVENT_ID` | `grid-event-id` | board cards in both member views | BOARD id |
| `GRID_EVENT_TYPE` | `grid-event-type` | board cards | `'job'`/`'walkthrough'` - write-only today |
| `FROM_MEMBER` | `from-member` | board cards | the lane id the card was dragged from |
| `PLAN_VISIT_PLAN_ID` | `plan-visit-plan-id` | plan-visit card (`:2223`) | service-plan id |

**BOARD id shapes:** job -> raw job id; walkthrough -> `wt-<leadId>`;
plan visit -> `pv-<planId>`.

- `parseBoardDragId(id)` decodes prefix -> `{kind, entityId}`.
- `resolveBoardDropId(dt, fallback)` normalizes any channel to a BOARD id,
  **restoring the `wt-` prefix** the `walkthrough-id` channel strips. This
  restoration is load-bearing: without it a dropped walkthrough is mistaken for
  a job id (the documented "pre-codec misroute").
- `hasBoardDragPayload(types)` -> true if any of job-id / walkthrough-id /
  grid-event-id is present. Note it deliberately **excludes** `pv-` - plan-visit
  cards can only target the standard calendar.

`draggingJobIdRef` (`:445`) is a page-level ref mirroring the current BOARD id.
It is the fallback when `dataTransfer.getData` returns empty (which it does
during `dragover` in every browser), and it is what
`dragFromOutsideItem` reads to decide whether to show a preview.

Both bucket cards and pv- cards also add `document.body.classList.add('is-dragging')`
on dragstart and remove it on dragend, and build a **custom drag image** - a
number chip tinted by type (`#3b82f6` job / `#c68a3c` walkthrough / `#2F7D5D` plan),
appended off-screen and removed on the next animation frame (`:1460-1470`, `:2225-2234`).

### 4.2 What is draggable

| Source | draggable when | payload |
|---|---|---|
| Standard-calendar event | `draggableAccessor` (`:2587-2593`): `false` if `boardReadOnly`; `false` if `!isGhost && !rescheduleGate(e).ok`; else true | rbc internal (no dataTransfer) |
| Bucket card (Jobs / Walkthroughs) | `draggable={!dragDisabled}` where `dragDisabled = boardReadOnly` (`UnassignedBuckets.tsx:115`) | JOB_ID or WALKTHROUGH_ID |
| Plan-visit card | `draggable={!boardReadOnly}` (`:2218`) | PLAN_VISIT_PLAN_ID |
| `TechnicianGridView` JobCard | `draggable` - **unconditional** (`TechnicianGridView.tsx:167`) | GRID_EVENT_ID + TYPE + FROM_MEMBER |
| `MemberWeekBoard` BoardCard | `draggable` - **unconditional** (`MemberWeekBoard.tsx:118`) | GRID_EVENT_ID + TYPE + FROM_MEMBER |

Member-board cards being unconditionally draggable is safe only because
read-only roles never see the member views at all (`canMemberView` is false for
them) and `handleMemberBoardDrop` bails on `boardReadOnly` (`:2022`). Preserve both.

### 4.3 `rescheduleGate` and `unscheduleGate`

`rescheduleGate` (`:1521-1534`) - money, not status, freezes a job (Spec B1/B-2):
- walkthrough -> blocked iff `isCompletedEvent` ("This walkthrough already happened.")
- job -> blocked iff any `raw.invoices[].sent_at` is set ("This job has already been invoiced.")
- otherwise ok. A completed or cancelled job **can** be dragged; `/assign` un-completes it.

`unscheduleGate` (`:1501-1512`):
- walkthrough -> ok only when `status === 'WALKTHROUGH_SCHEDULED'`
- job -> always ok

A blocked drag surfaces `toast({ title: "Can't reschedule" | "Can't unschedule", description: "<number> - <reason>" })`.

### 4.4 Valid drop targets

| # | Target | Accepts | Handler |
|---|---|---|---|
| 1 | rbc time slot / month cell / all-day strip | rbc-internal event moves; external drags via `onDropFromOutside` | `handleEventDrop` / `handleDropFromOutside` |
| 2 | `TechnicianGridView` hour zone `grid-slot-<techId>-<h>` (14 per column, hours 6-19) | anything `hasBoardDragPayload` | `onDropJob(resolvedId, techId, start=h:00, end=h+2:00, fromMember)` |
| 3 | `MemberWeekBoard` cell `week-cell-<memberId>-<yyyy-MM-dd>` | anything `hasBoardDragPayload` | `onDropJob(resolvedId, memberId, date, fromMember)` - **day granularity, no time** |
| 4 | `UnassignedBuckets` root (`data-testid="unassigned-buckets"`) | **`grid-event-id` only** | `onUnscheduleDrop(boardEventId)` |
| 5 | anywhere else | nothing | drop ignored |

Target 4 refuses the drop entirely when `unscheduleDropDisabled` (= `planMode.isActive || boardReadOnly`, `:2201`) or when the payload lacks `grid-event-id`.

### 4.5 System A - calendar event move (`handleEventDrop`, `:1737-1807`)

Order of operations:
1. `boardReadOnly` -> return.
2. non-ghost -> `rescheduleGate`; blocked -> toast, return.
3. Coerce `start`/`end` to `Date`.
4. If `isAllDayEvent(event) || isAllDay` -> normalize to `startOfDay(start)` .. `+24h`.
5. If the dragged thing **is** a ghost -> `planMode.updateGhostPosition(...)`, return (crew unchanged).
6. If plan mode is active and this is a live event -> `planMode.addGhost({... isFromSidebar:false, crew:[...event.crew] })`, return. **No network call.**
7. Otherwise: `setPendingMove({eventId,newStart,newEnd,crew})` **and**
   `setRescheduleConfirm({event, oldStart, oldEnd, newStart, newEnd})`.
   Nothing is POSTed until the user confirms.

`pendingMove` is a **visual-only optimistic override**: `allEventsWithPending`
(`:1039-1046`) rewrites that one event's start/end/crew so the card visually
stays where it was dropped while the confirm dialog is open. Cancelling clears
both and the card snaps back.

**Crew is never changed by a standard-view drag.** The confirm POSTs the event's
*current* crew (possibly `[]`).

### 4.6 System A - resize (`handleEventResize`, `:1809-1874`)

Same gates (readOnly, rescheduleGate, ghost, plan mode) - but **no confirm
dialog**. On confirm-free path it fires immediately:
- job -> `assignMutation.mutate({jobId, crew: event.crew, start, end})`
- walkthrough -> `walkthroughRescheduleMutation.mutate({leadId, newStart, crew, durationMinutes: round((end-start)/60000)})`

`resizableAccessor` (`:2595-2602`) disables resize for `boardReadOnly`, for
all-day events, and for anything `rescheduleGate` blocks. `resizable={!boardReadOnly}` (`:2594`).

Handle geometry is CSS-only: top anchor is an invisible 8px `ns-resize` strip;
bottom anchor is a white pill that fades in on `.rbc-event:hover`
(`schedule-dark.css:249-289`). rbc's own resize icon is hidden.

**Resize is not implemented in either member view** - no handles are rendered
(`sched-resize.spec.ts` G-08 documents this as a known P2 gap).

### 4.7 System B - sidebar -> standard calendar (`handleDropFromOutside`, `:1880-1976`)

1. `boardReadOnly` -> return.
2. Read + clear `draggingJobIdRef`. No id -> return.
3. `parseBoardDragId`.
4. **`pv-` (plan visit)** -> `scheduleVisitMutation.mutate({id, scheduled_start, scheduled_end, assigned_to: null})`.
   This lazily materialises the next visit as a real Job at status `SCHEDULED`
   with **no crew** (state 4). On success invalidate `['schedule-jobs']` +
   `['schedule-unassigned']`. Errors -> `errorToast`. **No modal.** Return.
5. Look up `bucketEvents.find(e => e.id === rawId)`. Missing -> stale drag ->
   `errorToast('That card is no longer in the Unscheduled bucket.')`.
6. **Plan mode** -> `addGhost({... isFromSidebar:true})` for job or walkthrough. Return.
7. **Otherwise -> open `UnifiedDropModal`**, pre-filled by where it landed:
   - day granularity when `calendarView === MONTH` **or** `isAllDayStripDrop`
     -> `{kind:'standard-day', date: startOfDay(start)}`
   - else -> `{kind:'standard-time', start}`

`isAllDayStripDrop` (`:1962-1966`) is a **workaround**: rbc 1.19.4 hardcodes
`allDay:false` in both DnD wrappers, so the flag is inferred as
`differenceInCalendarDays(end,start) >= 1 && start.getHours()===0 && start.getMinutes()===0`.
Calendar-day math (not raw ms) because the 23-hour spring-forward day broke the
old `spanMs >= 24h` check; the midnight anchor keeps a 22:00+2h drop classified
as timed. **This is a fragile, deliberate hack - copy it verbatim.**

`dragFromOutsideItem` (`:2575-2584`) returns `null` when not dragging, otherwise
a stub `{id, title:'Drop to schedule', start: today 00:00, end: +2h}` so rbc
sizes a 2-hour preview. That stub has **no `raw`** - which is why
`ScheduleEvent` (`:175`) and `eventStyleGetter` (`:1134`) both guard on `e.raw`.

### 4.8 System C - member board drops (`handleMemberBoardDrop`, `:2015-2134`)

Normalised entry point for both member views.

```
if (boardReadOnly) return
parsed = parseBoardDragId(droppedId)
if (parsed.kind === 'plan-visit') return          // pv- only targets the standard calendar
anchoredStart = drop.kind === 'time' ? drop.start : atMinutes(drop.date, defaultStartMin)

if (planMode.isActive):
    only sidebar JOB cards ghost (crew:[memberId]); everything else no-ops. return

bucketEv = bucketEvents.find(id)                   // it came from a bucket
if (bucketEv): openDropModal(bucketEv, {member-day | member-week}); return

boardEv = scheduledEvents.find(id)                 // it came from the board
if (!boardEv || !boardEv.start || !boardEv.end) return          // stale drag
if (!rescheduleGate(boardEv).ok) toast + return

decision = classifyBoardDrop({fromMember, toMember, sameDay, hasTime})
```

`classifyBoardDrop` (`scheduleModel.ts:184-194`) is the governing rule, encoded once:

| fromMember | vs toMember | granularity | decision |
|---|---|---|---|
| null | - | - | `noop` (defensive) |
| set | different | any | **`swap`** - crew change, **time/date of the drop slot is IGNORED** |
| set | same | hour slot | `reschedule` |
| set | same | day cell, different day | `reschedule` (keep time-of-day + duration) |
| set | same | day cell, same day | `noop` |

**`swap` path** (`:2091-2119`): `swapCrew(crew, fromMember, toMember)`:
- `noop-not-on` -> silent return (lane member left the crew mid-drag)
- `noop-already-on` -> toast `"<firstName> is already on this job|walkthrough"`
- `swapped` -> `jobCrewSwapMutation` / `walkthroughCrewSwapMutation`, then toast
  `"<toFirst> replaces <fromFirst>" / "<number> - crew updated, schedule unchanged."`

**`reschedule` path** (`:2125-2133`): duration preserved; day cells reuse the
event's existing time-of-day via `atMinutes`. If the computed `newStart` equals
`oldStart` -> silent no-op. Otherwise `setPendingMove` + `setRescheduleConfirm`
(the same confirm flow as System A).

### 4.9 System C - drag to unschedule (D6)

Board card -> `UnassignedBuckets` root. Component-side (`UnassignedBuckets.tsx:171-187`):
`dragOver`/`drop` both bail unless `dataTransfer.types.includes('grid-event-id')`
and `!unscheduleDropDisabled`; hover state paints
`bg-primary-subtle/40 ring-2 ring-inset ring-primary/30`.

Page-side `handleUnscheduleDrop` (`:1541-1555`): re-checks plan mode and
`boardReadOnly`, resolves the event from `scheduledEvents` (missing -> silent
return, ghost/stale), runs `unscheduleGate`, then `setUnscheduleConfirm(ev)`.

Confirm dialog (`:3251-3286`) copy: "Move to Unscheduled? **<number>** goes back
to its bucket. The crew is **kept**; the customer is not notified. This is not a
cancellation." -> `unscheduleMutation`.

### 4.10 Conflict detection

Two independent layers.

**Client-side, visual only** - `conflictedEventIds(scheduledEvents)`
(`scheduleModel.ts:140-154`): O(n^2) pairwise scan; two events conflict if they
share >= 1 crew member **and** their `[start,end)` intervals overlap. Spans jobs
and walkthroughs in one flat pass. Result is a `Set<string>` of event ids,
memoised in `useScheduleEvents`.

`eventDangerState(e, conflictIds)` (`scheduleModel.ts:122-127`) resolves precedence once:
1. ghost -> `null` (drafts never paint red)
2. `deriveState(e) === 4` (timed + 0 crew) -> `'needs-crew'` -> **red FILL**
3. `conflictIds.has(e.id)` -> `'double-booked'` -> **red OUTLINE**
4. else `null`

`needs-crew` wins deliberately (a crew-less event cannot share a member).

**Advisory, drop-modal only** - `conflictNoteFor(draft, scheduledEvents, firstNameById)`
(`scheduleModel.ts:235-253`): first scheduled event sharing >= 1 crew member and
overlapping the draft window, excluding the draft's own event ->
`"overlaps <number> for <firstName>"`. **Never blocks Confirm.**

**Server-side, authoritative** - the backend 409s on `/assign` and
`/walkthrough/schedule`. See 6.3.

### 4.11 Optimistic updates and rollback

| Mutation | Optimistic write | Rollback |
|---|---|---|
| `assignMutation` | `setQueriesData({queryKey:['schedule-jobs']})` **prefix match** - rewrites `scheduled_start`, `scheduled_end`, `assignees: crew.map(id => ({user:{id}}))` on the matching job (`:1229-1239`) | `onError` restores every `[key,data]` captured by `getQueriesData` (`:1251`) |
| `walkthroughRescheduleMutation` | `setQueryData(['schedule-walkthroughs', dateRange])` **exact key** - rewrites `walkthrough_scheduled_at` only (`:1285-1290`) | restores the single snapshot (`:1300-1302`) |
| `jobCrewSwapMutation` | prefix `['schedule-jobs']` - rewrites `assignees` only (`:1355-1359`) | restores all captured keys |
| `walkthroughCrewSwapMutation` | prefix `['schedule-walkthroughs']` - rewrites `walkthrough_performers` (`:1388-1394`) | restores all captured keys |
| `unscheduleMutation`, `completeMutation`, `noWalkthroughMutation`, `scheduleVisitMutation` | **none** - invalidate-only | n/a |
| `pendingMove` (visual) | rewrites start/end/crew in `allEventsWithPending` while the confirm dialog is open | cleared on confirm or cancel |

Notes that matter for a faithful reimplementation:
- The prefix-match (`setQueriesData` / `getQueriesData`) is required because the
  live key is `['schedule-jobs', dateRange, departmentFilter]`. An exact-key
  write silently misses.
- Optimistic writes carry **bare ids** only; display names rehydrate on the
  invalidate-refetch a moment later. Crew swaps flip member-column membership
  instantly because `isOnBoardFor` keys off ids.
- Both crew-swap mutations `cancelQueries` first to stop an in-flight refetch
  clobbering the optimistic state.

### 4.12 What the ~24 DnD e2e specs assert

Specs pinned to this behaviour (all under `frontend/e2e/specs/`):

| Spec | Test ids | What it asserts |
|---|---|---|
| `sched-dnd-core.spec.ts` | D-01,02,04/05,06,08,10,11,12 | cursor is grab/pointer/move on `.rbc-event` and on sidebar card; sidebar card has `draggable="true"`; click (no movement) opens a popup not a drag; center drag moves the event; month-view drag; sidebar drag shows opacity change + drops into `.rbc-calendar`; walkthrough event is draggable; completed events (opacity <= 0.6) resist drag |
| `sched-dnd-targets.spec.ts` | F-01,02,03,05,07,09,12,14 | same-day/different-time, different-day/same-time, diagonal; **F-05 cross-column grid drop**; sidebar -> week calendar; sidebar -> grid tech column; same-position no-op; conflicting slot -> conflict UI (`getByRole('dialog')`) |
| `sched-dnd-visual.spec.ts` | E-01,02,04,07,08,10,11 | drag ghost follows cursor; source-slot indicator; snap to 15/30 min; drop indicator; **`getByText('Drop here')` - the `TechnicianGridView` landing-zone label** (`TechnicianGridView.tsx:375`); Escape cancels; ghost has dashed border + "draft" label; `getByRole('button',{name:/Discard All/i})` |
| `sched-dnd-edge-cases.spec.ts` | H-02/03,05,06/07/08,13/14/15,16,17 | completed/cancelled not draggable; **network failure reverts the event (the rollback path)**; conflict -> Schedule Anyway vs Cancel; plan-mode ghost create/confirm/discard; `getByRole('button',{name:/Confirm All/i})`; plan mode survives reload; `getByText('Discard')`; toast via `[role="status"], [data-sonner-toast]` |
| `sched-resize.spec.ts` | G-01,02,03,06,08,09 | `.rbc-addons-dnd-resize-ns-anchor` exists on hover with `ns-resize` cursor; extend/shorten changes height; min height > 10px; **G-08 documents no resize in grid day view**; **G-09 asserts exactly <= 1 POST to a URL containing `/assign`** |
| `sched-day1-audit.spec.ts` | N-01, D-01,02,05,06,08,09,10,11 | P0: dragging a COMPLETED event; grid-view card drag; `.rbc-event` locator |
| `sched-day2-f-targets.spec.ts` | F-01,02,03,07,09,10,11,12,13,14 | adds F-10 sidebar -> month (`.rbc-date-cell`), F-11 calendar -> sidebar, F-13 drop outside bounds; `getByRole('button',{name:/Schedule Anyway/i})` / `/Cancel/i` |
| `sched-day2-h-edges.spec.ts` | H-05,13/14,17,18, L-05b, L-05c | boundary-slot drop; context-menu "Mark In Progress" / "Reassign|Reschedule" |
| `schedule-dnd.spec.ts` | 4 tests | sidebar -> `.rbc-time-content .rbc-time-slot` opens a dialog with `Assign Technician` and a filled `input[type="datetime-local"]`; sidebar -> tech column pre-selects the tech in `getByRole('combobox')`; existing event drag fires reschedule (asserts event still visible OR `/Scheduling Conflict/` OR `Error`); "By Technician" renders `.rbc-resource-cell, .rbc-header` + `select` |
| `schedule-conflict.spec.ts` | 3 tests | overlapping assign shows `/Scheduling Conflict/`; "Schedule Anyway" overrides; main Assign disabled while the conflict warning shows |
| `sched-demo-f01.spec.ts` | F-01 | single-scenario screenshot-verify demo |

**Two of these specs assert behaviour the current code no longer has** -
`schedule-dnd.spec.ts` expects a sidebar-to-calendar drop to open
`AssignJobDialog` ("Assign Technician"), but the current code opens
`UnifiedDropModal` (title `Schedule - <title>`). It also uses
`sp.byTechnicianButton` (`'By Technician'`), a label replaced by "Member View".
Treat those as pre-existing red, not as regressions the v2 branch introduced -
but **verify their current pass/fail status before the v2 build starts**, so the
baseline is known.

---

## 5. Interactive elements and what they open

### 5.1 Header row 1

| Element | Where | Action |
|---|---|---|
| `Today` button | `:2296` | `setCurrentDate(new Date())` |
| `<` `ChevronLeft` | `:2299` | prev day/week/month |
| `>` `ChevronRight` | `:2302` | next |
| date-range label span | `:2305` | display only, `key`-remounted for animation |
| `Standard` button | `:2317` | `setIsGroupedView(false)`. **Only when `canMemberView`** |
| `Member View` button | `:2325` | `setIsGroupedView(true)`; if current view is MONTH, force WEEK |
| `Plan Mode` / `Planning` pill | `:2341` | `handlePlanModeToggle`. **Only when `canPlanMode`** |
| gear (`Schedule settings`) | `SettingsGearDropdown` | Radix `Popover` -> legend + (grouped only) staff filter + shortcut list |

`SettingsGearDropdown` content: legend rows for Job / Walkthrough / Service Plan
accents, "Needs crew (unstaffed)" (solid danger), "Double-booked" (danger
outline), "Completed" (text-soft); staff filter `All Staff` / `Technicians` /
`Sales`; shortcut list T,1,2,3,S,G.

### 5.2 Header row 2

| Element | Where | Action |
|---|---|---|
| `day` / `week` / `month` buttons | `:2387` | `setCalendarView(v)`. Month omitted in grouped mode. DOM text is the lowercase `Views` constant, CSS-capitalized - **e2e matches `/^month$/i`** |
| department `SelectField` | `:2405` | `all` + one option per department + (if `can('create','Department')`) the `__add__` sentinel. Selecting `__add__` opens the Add-Department dialog and leaves the filter untouched |
| `Full day` / `Morning` / `Afternoon` | `:2432` | `setTimeWindow`. Standard + non-month only |

### 5.3 Sidebar

| Element | Action |
|---|---|
| `PanelLeftOpen` (collapsed rail) | `setSidebarOpen(true)` |
| `PanelLeftClose` | `setSidebarOpen(false)` |
| `ScheduleSearch` input | debounced 300ms combobox -> `GET /api/search?scope=schedule`; Enter/Arrow keys; selecting a result jumps `currentDate` and pulses `highlightedEventId` for 3s |
| resize handle | `onMouseDown={startSidebarResize}` -> `useResizableWidth` |
| bucket section header | toggles that bucket open/closed (`aria-expanded`) |
| bucket card **click** | `handleBucketCardClick` -> `setEditorEventId(ev.id)` -> **EventEditor** |
| bucket card **right-click** | `handleBucketCardContextMenu` -> sidebar context menu (service-plan cards return early) |
| bucket card **drag** | see 4.1 |
| plan-visit card **click** | `navigate('/service-plans')` |

### 5.4 Board

| Gesture | Standard calendar | TechnicianGridView | MemberWeekBoard |
|---|---|---|---|
| left-click an event | `onSelectEvent` -> `openEditorFor` -> **EventEditor** (ghosts return early) | `onEventClick` -> `openEditorFor` (fallback `onSelectJob` -> `setEditorEventId`) | `onEventClick` -> `openEditorFor` (fallback `onSelectEvent`); ghosts return early |
| right-click an event | `ScheduleEvent.handleContextMenu` -> ctx -> `handleEventContextMenu` -> ghost menu if ghost else `ScheduleContextMenu` | ghost menu only (`onEventContextMenu` is **not passed** by the page) | ghost menu only |
| click an empty slot | `onSelectSlot` -> MONTH: drill to day; else (non-readOnly) `QuickScheduleCard` at last mouse position | n/a | n/a |
| click a day header | WEEK: drill to Day view; other views (non-readOnly): all-day `QuickScheduleCard` | n/a | n/a |
| double-click day header/column | WEEK only: expand/collapse that column | n/a | n/a |
| month "+N more" | rbc `.rbc-overlay` popup (`popup` prop) | n/a | n/a |

### 5.5 Dialogs, popovers, menus, toasts - full inventory

| Overlay | Trigger | Contents / exits |
|---|---|---|
| `EventEditor` (Radix Dialog) | any live card click, or context-menu "Edit crew & schedule" | state chip, owner (read-only), `MultiAssigneeSelect` crew + "Save crew" (appears only when dirty), date/time inputs + duration select + "Save time" (dirty only), tel:/sms: contact links for customer and crew, "Mark Complete" (jobs, `canComplete`), "Move to Unscheduled" (timed, `canUnschedule`), "View details ->", an `ExternalLink` icon top-right. **Clicking any non-interactive area navigates to the detail page** (`INTERACTIVE_SELECTOR` guard). `readOnly` renders crew and schedule as plain text with no save buttons. Suppressed (id retained) while `conflictToast` or `unscheduleConfirm` is up |
| `UnifiedDropModal` (Radix Dialog) | every bucket -> board drop (all four target kinds) | date / start time / duration / crew; fields seeded by the drop glow `ring-2 ring-ai`; advisory conflict note; caption "highlighted = auto-filled ..."; Cancel / Schedule. **Pure - never POSTs.** Hidden (draft kept) while the needs-crew warning is up |
| needs-crew warning (`role="alertdialog"`, z-[70]) | Confirm with `draft.crew.length === 0` | "Nobody is assigned" -> Back / Schedule anyway |
| `RescheduleConfirmDialog` | any confirmed reschedule (System A drag, member same-lane drop) | from -> to panel, "Crew (unchanged)" list, amber "Notification emails will be sent to:" listing customer + each technician, Cancel / "Confirm & Notify" |
| unschedule confirm (z-[70]) | D6 drop, or editor "Move to Unscheduled" | Cancel / Unschedule |
| conflict modal (z-50) | any 409 from assign or walkthrough schedule | message + per-conflict rows (`WT`/`JOB` chip, number, time range), Cancel / "Schedule Anyway" (re-POSTs with `force:true`) |
| error toast (fixed bottom-right, z-50) | `setErrorToast(...)` | red card + Dismiss |
| `AssignJobDialog` | **only** from `QuickScheduleCard`'s "select job" (both slot and all-day variants) | crew multi-select, All-Day checkbox, start/end `datetime-local` (or a single date when all-day), its own inline 409 conflict block with its own "Schedule Anyway", Cancel / Assign (disabled until crew non-empty) |
| `CancelJobDialog` | context menu -> "Cancel Job" (jobs only) | job cancellation flow |
| Add-Department dialog | department select -> `+ Add department` | Input + Enter, Cancel / Create; on success sets the filter to the new id |
| `ScheduleContextMenu` (fixed, z-50) | right-click a standard-calendar event | "Open Job Details" / "Open Lead"; then (non-readOnly) "Edit crew & schedule", separator, "Cancel Job" / "Cancel Walkthrough". Position clamped by `safeX`/`safeY` (208x112) |
| sidebar context menu (fixed, z-50, w-48) | right-click a bucket card | walkthrough: "View Lead" + (non-readOnly) "No Walkthrough Needed"; job: "View Job" |
| ghost context menu (fixed, z-50, w-44) | right-click a ghost | Confirm / Remove. Closes on any outside click (50ms-delayed listener) |
| ghost confirm dialog | ghost menu -> Confirm | date/time, "Assign to: <crew names or 'No crew'>", customer, location; Cancel / "Confirm & Schedule" |
| confirm-all dialog | banner -> Confirm All (only when >= 1 ghost is in view) | scrollable list of visible ghosts; Cancel / "Confirm N Changes" |
| plan-mode exit dialog | Plan Mode toggle off while ghosts exist | Cancel / "Discard & Exit" / "Confirm All & Exit" |
| `QuickScheduleCard` (fixed, z-[60], 260x360) | empty-slot click, or day-header click outside week view | Jobs / Walkthroughs tabs, search input, result list; picking a job -> `AssignJobDialog` pre-filled; picking a walkthrough -> **immediate** `walkthroughRescheduleMutation` (org default duration, or 1440 for the all-day variant) |
| gear popover | gear button | see 5.1 |
| `ScheduleSearch` dropdown (`role="listbox"`) | typing >= 2 chars | Jobs / Walkthroughs sections, "5+ results - refine your search" cap notice |
| shadcn `toast()` | crew updated, crew swapped, scheduled, completed, unscheduled, can't-reschedule, can't-unschedule, already-on-crew | app-level `<Toaster />` in `App.tsx:204` |

**Tooltips:** there are none on events. `handleEventMouseEnter/Leave` are no-ops
(`:790-791`) and the code comments record the hover tooltip as removed. Native
`title` attributes remain on: the sidebar collapse/open buttons, the department
select wrapper, and crew avatar chips in `UnassignedBuckets`.

### 5.6 Keyboard

Global `keydown` listener (`:737-763`), skipped when the target is
INPUT/TEXTAREA/SELECT:

| Key | Action |
|---|---|
| `t` / `T` | today |
| `1` / `2` / `3` | day / week / month |
| `s` / `S` | Standard view |
| `g` / `G` | Member view - **only when `canMemberView`** |
| `Escape` | clears conflict toast, error toast, context menu, slot popover, all-day popover, sidebar context menu, ghost context menu, unschedule confirm, and `needsCrewConfirm` (which returns you to the still-open drop modal) |

Outside-click dismissal (`:767-786`) uses a **capturing `mousedown`** listener
attached after a 100ms delay, so it fires before rbc's own selection handlers;
it skips targets matching `[class*="fixed"][class*="z-["]`.

`beforeunload` warning while plan mode has ghosts (registered **twice**, `:609`
and `:619` - identical duplicate effects).

---

## 6. Every API call

### 6.1 Reads

| Hook / site | Query key | Endpoint | Params |
|---|---|---|---|
| `useScheduleData` | `['schedule-jobs', dateRange, departmentFilter]` | `GET /api/jobs` | `status: ['SCHEDULED','EN_ROUTE','ON_SITE','IN_PROGRESS','COMPLETED']`, `scheduled_after`, `scheduled_before`, optional `department_id`, `limit: 500` |
| `useScheduleData` | `['schedule-walkthroughs', dateRange]` | `GET /api/leads` | `walkthrough_after`, `walkthrough_before`, `limit: 500` |
| `useScheduleData` | `['schedule-unassigned']` | `GET /api/jobs` | `status: 'UNASSIGNED'`, `limit: 100` |
| `useScheduleData` | `['schedule-unscheduled-walkthroughs']` | `GET /api/leads` | `walkthrough_status: 'needs_scheduling'`, `limit: 100` |
| inline (`:402`) | `['departments']` | `GET /api/departments` | staleTime 5min |
| `useAssignableUsers({departmentId})` | `['users','assignable', deptId, null, null]` | `GET /api/users` | `assignable: true`, optional `department_id`. staleTime 30s, `keepPreviousData` |
| `useAssignableUsers()` (org-wide) | `['users','assignable', null, null, null]` | same, no dept | used for **all name lookups** so a dept filter can never blank a crew name |
| `useOrganization` | `['organization']` | `GET /api/organization` | supplies `default_schedule_start_time`, `default_job_duration_min`, `default_walkthrough_duration_min` |
| `useSchedulerBucket(canSeePlans)` | `['service-plans','scheduler-bucket']` | `GET /api/service-plans/scheduler-bucket` | enabled only when `ability.can('read','ServicePlan')` |
| `ScheduleSearch` | `['schedule-search', q, startISO, endISO]` | `GET /api/search` | `scope: 'schedule'`, `rangeStart`, `rangeEnd`. enabled at >= 2 chars, staleTime 30s |

`QueryClient` defaults (`App.tsx:74-82`): `retry: 1`, `staleTime: 5min`,
`refetchOnWindowFocus: false`.

### 6.2 Writes

| Mutation | Method + endpoint | Body | Invalidates on success |
|---|---|---|---|
| `assignMutation` (`:1205`) | `POST /api/jobs/:id/assign` | `assignee_ids` (full REPLACE array, `[]` valid), `scheduled_start`, `scheduled_end`, optional `force:true` | `['schedule-jobs']`, `['schedule-unassigned']`, `['jobs']`, `['job', jobId]`; clears `conflictToast` |
| `walkthroughRescheduleMutation` (`:1266`) | `POST /api/leads/:id/walkthrough/schedule` | `walkthrough_scheduled_at`, `performer_ids`, `walkthrough_duration_minutes`, `force` (default false) | `['schedule-walkthroughs', dateRange]`, `['schedule-unscheduled-walkthroughs']`, `['lead', leadId]`; clears `conflictToast` |
| `jobCrewSwapMutation` (`:1342`) | `POST /api/jobs/:id/assignees` | `assignee_ids` | `['schedule-jobs']`, `['jobs']`, `['job', jobId]` |
| `walkthroughCrewSwapMutation` (`:1373`) | `POST /api/leads/:id/walkthrough/performers` | `performer_ids` | `['schedule-walkthroughs']`, `['lead', leadId]` |
| `unscheduleMutation` (`:1409`) | job: `POST /api/jobs/:id/unassign` · walkthrough: `POST /api/leads/:id/walkthrough/unschedule` | none | all four schedule keys, plus `['jobs']`+`['job',id]`+`servicePlanKeys.bucket` (job) or `['lead',id]` (walkthrough); toast "Unscheduled - crew kept" |
| `completeMutation` (`:1435`) | `POST /api/jobs/:id/complete` | none | `['schedule-jobs']`, `['schedule-unassigned']`, `['jobs']`; toast "Job completed" |
| `noWalkthroughMutation` (`:1324`) | `PATCH /api/leads/:id` | `{ walkthrough_needed: false }` | `['schedule-unscheduled-walkthroughs']`, `['leads']` |
| `scheduleVisitMutation` (`useScheduleVisit`) | `POST /api/service-plans/:id/schedule-visit` | `scheduled_start`, `scheduled_end`, `assigned_to: null` | hook: `['service-plans']`, detail, bucket, `['schedule-jobs']`; call site adds `['schedule-jobs']`, `['schedule-unassigned']` |
| `createDept` (`useCreateDepartment`) | `POST /api/departments` | `{ name }` | `['departments']` |
| ghost confirm (`handleConfirmGhost`, `:629`) | raw `api.post` - `/api/jobs/:id/assign` or `/api/leads/:id/walkthrough/schedule` | same shapes | all four schedule keys |
| `AssignJobDialog` (its own mutations) | `POST /api/jobs/:id/assign` (+ force variant) | `assignee_ids`, `scheduled_start`, `scheduled_end`, `is_all_day` | `['job',id]`, `['jobs']`, `['job-timeline',id]`, `['schedule-unassigned']`, `['schedule-jobs']` |

### 6.3 Error handling contract

- **409** on assign or walkthrough-schedule -> `setConflictToast({message, conflicts, pendingPayload})`.
  `pendingPayload` is a discriminated union (`{kind:'job'|...}`) so "Schedule
  Anyway" can re-POST through the correct mutation with `force:true`.
- **anything else** -> `setErrorToast(extractApiError(err, '<fallback>'))`.
- `submitDropDraft` closes the drop modal optimistically; a **non-409** failure
  restores the modal with the draft intact (`restoreDraftOnNon409`, `:1697-1701`).
  A 409 leaves it closed and flows into the page-level conflict modal.

---

## 7. Assignment logic

### 7.1 The domain model (`scheduleModel.ts`)

**Crew and schedule are independent axes.** Four states (`deriveState`):

| State | crew | time | label | lives |
|---|---|---|---|---|
| 1 | 0 | none | Fresh | Unassigned bucket |
| 2 | >= 1 | set | Scheduled | Board |
| 3 | >= 1 | none | Crewed, unscheduled | Unassigned bucket ("crew kept" chip + avatars) |
| 4 | 0 | set | Needs assignment | Standard view only - **red flag** |

`isOnBoardFor(e, memberId) = e.crew.includes(memberId)` - the single
column-membership predicate both member views share. Consequences:
- a 2-person crew renders **in both columns** (D1);
- state-4 events are structurally invisible in member views (no crew -> no lane),
  which is why "needs crew" red fill is a Standard-view-only surface.

The **commission owner** (`ownerOf`) is explicitly **off-board** - a read-only
field in the editor, never a column.

### 7.2 Technicians / roster / capacity

- `roster` = `useAssignableUsers({departmentId})` - department scoping is
  **server-side**.
- `orgRoster` = `useAssignableUsers()` - org-wide, used for **every name lookup**
  (editor, drop modal, ghost dialogs, `firstNameById`, avatars) so a dept filter
  cannot blank a crew name.
- `boardMembers = roster.filter(u => roleFilter === 'all' || u.role === roleFilter)`
  (`:1105`) - the gear's Staff Filter is a **client-side role narrow** only.
- Both member views additionally filter `is_active`.
- **There is no capacity model.** No max-jobs-per-tech, no hours budget, no
  utilisation bar. The only per-member aggregate is `MemberWeekBoard`'s
  per-day-cell header: `"N jobs · X hrs"` (`MemberWeekBoard.tsx:266-270`).
  `TechnicianGridView` marks a member with zero same-day events as "idle":
  ocean-tinted 45deg hatch + "available (drop work here)" plus a
  `bg-primary-subtle/30` header tint. **Idle columns are never hidden** (D3).

### 7.3 Crews

- REPLACE semantics everywhere: `assignee_ids` / `performer_ids` are always the
  **full array**; `[]` is a valid, deliberate value.
- Per-person editing exists in exactly **one** place: `EventEditor`'s
  `MultiAssigneeSelect` + explicit "Save crew".
- Drags never do per-person edits - a cross-lane drag is a whole-lane **swap**
  (`swapCrew`, 1:1, preserves crew size); a same-lane drag is a **reschedule**
  with crew untouched.
- A reschedule and a resize both POST the event's **current** crew alongside the
  new times, so scheduling can never silently drop assignees.

### 7.4 Unassigned queue

`UnassignedBuckets` renders three collapsible sections from one `BUCKETS` array
(the documented extensibility seam):

| Bucket | Icon | Source | Empty copy |
|---|---|---|---|
| Jobs | `Briefcase` | `visibleBucketEvents` type `job` | "Nothing here - all Jobs are scheduled." · error: `AlertCircle` + "Failed to load jobs" |
| Walkthroughs | `Footprints` | type `walkthrough` | "Nothing here - all Walkthroughs are scheduled." |
| Service Plans | `Repeat` | page-supplied `planSlot` (live pv- cards) when `can('read','ServicePlan')`, otherwise the stub | live: `CheckCircle2` + "No plan visits due" · stub: "Recurring visits land here (Step 9E)" + a "soon" badge |

Ordering is **FIFO / array order - no re-sort** (`UnassignedBuckets.tsx:190`).
Count badge per section. State-3 cards show a `crew kept` pill, overlapping
initials avatars, and "re-drop remembers the crew".
Footer hint "Drag a board card back here to **unschedule** - the crew is kept."
renders only when the stack actually accepts drops.

Plan-visit cards carry: plan number, `visits_remaining` badge ("N left" /
"Ongoing"), customer, city/state, recurrence, "Next due <date>"; border colour
`rose-300` when overdue, `amber-300` when due soon.

---

## 8. Permission gating

### 8.1 Frontend gates on this page

| Gate | Source | Effect |
|---|---|---|
| route roles | `App.tsx:111` | all four roles allowed |
| `canPlanMode` | `role === ADMIN \|\| DISPATCHER` (`:346`) | hides the Plan Mode pill; a `useEffect` (`:544-546`) **force-deactivates** a localStorage-restored plan mode for a role that can't plan, discarding ghosts without POSTing |
| `canMemberView` | `boardCapabilitiesFor` | hides the Standard/Member toggle; disables the `G` shortcut; `effectiveGroupedView` pins the board to Standard |
| `boardReadOnly` | `boardCapabilitiesFor` | see 8.2 |
| `canSeePlans` | `ability.can('read','ServicePlan')` | omits `planSlot`, disables the scheduler-bucket query |
| `canCreateDepartment` | `ability.can('create','Department')` | hides the `+ Add department` option (mirrors the ADMIN-only `POST /api/departments`) |

### 8.2 `boardReadOnly` - every enforcement point

Defence in depth, 12 sites:

`draggableAccessor` (`:2588`) · `resizable` (`:2594`) · `resizableAccessor` (`:2596`) ·
`handleEventDrop` (`:1749`) · `handleEventResize` (`:1819`) · `handleDropFromOutside` (`:1882`) ·
`handleMemberBoardDrop` (`:2022`) · `handleUnscheduleDrop` (`:1544`) ·
`handleEditorSaveCrew` (`:1600`) · `handleEditorSaveTime` (`:1625`) ·
unschedule-confirm button (`:3275`) · `handleSelectSlot` (`:1993`) and `DayHeader` click (`:969`)
both skip the popover. Plus props: `UnassignedBuckets dragDisabled` /
`unscheduleDropDisabled` (`:2201-2202`), `EventEditor readOnly` (`:3173`),
`ScheduleContextMenu readOnly` (`:2625`), plan-visit card `draggable` (`:2218`),
sidebar context-menu "No Walkthrough Needed" (`:2663`), `editorCanComplete` (`:1592`).

### 8.3 The per-user grants (the caller's point 8)

`backend/src/lib/permissions/userCapabilities.ts` is the authoritative list of
admin-grantable **per-user** toggles. Relevant ones:

- `reschedule` / `Job` - "Reschedule own jobs", own-scoped via
  `{ assignees: { some: { user_id } } }`, `impliesRead: true`.
- `create` / `Job`, `create` / `Invoice`, `record_payment` / `Invoice`,
  `update` / `Job`, `start`, `arrive`, `complete`, `en_route` - all own-scoped.

**Important correction to the brief: `assign` is NOT a per-user capability.**
It does not appear in `USER_CAPABILITIES`. But `assign` is the verb the backend
actually enforces on the schedule's three main writes:

```
job.routes.ts:29  POST /:id/assign      canDo('assign','Job')
job.routes.ts:31  POST /:id/assignees   canDo('assign','Job')
job.routes.ts:34  POST /:id/unassign    canDo('unassign','Job')
job.routes.ts:38  POST /:id/complete    canDo('complete','Job')
lead.routes.ts:38 POST /:id/walkthrough/schedule    canDo('schedule_walkthrough','Lead')
lead.routes.ts:40 POST /:id/walkthrough/performers  canDo('schedule_walkthrough','Lead')
lead.routes.ts:42 POST /:id/walkthrough/unschedule  canDo('schedule_walkthrough','Lead')
```

So `reschedule Job` is a grant an admin can hand a technician, but nothing in
`SchedulePage.tsx` reads it - the page gates purely on `boardCapabilitiesFor(role)`,
which makes **every** technician read-only regardless of grants. A granted
technician therefore sees a read-only board and would have to reschedule from
`/jobs/:id`. This is a real behaviour, not a bug to fix during the migration -
**reproduce it exactly** and log it as a follow-up if it looks wrong.

`canOnJob` (`frontend/src/lib/ability.ts:46`) - the per-instance helper the rest
of the app uses - is **not imported by SchedulePage.tsx or any file under
`components/schedule/`**. Do not introduce it during the swap.

---

## 9. States: loading, empty, error, theming

### 9.1 Loading

- `isLoading = jobsLoading || walkthroughsLoading` (`:2136`).
- Standard calendar: absolute `bg-white/70 z-10` overlay + `Loader2` spinner (`:2535-2539`).
- Both member views: identical overlay at `z-50` with `pointer-events-none`.
- `ScheduleSearch`: `Loader2` inside the dropdown while fetching with no results yet.
- The unassigned and walkthrough bucket queries have **no loading state** - the
  buckets simply render empty until data lands.
- Suspense fallback for the lazy route: `App.tsx:84-90` "Loading...".

### 9.2 Empty

| Surface | Copy |
|---|---|
| Standard calendar, zero events, not loading | `CalendarX2` + "No jobs scheduled this week" + "Drag a job from the panel on the left to assign it" (pointer-events-none overlay, `:2540-2550`). **Note the copy says "this week" in day and month views too.** |
| Jobs bucket | "Nothing here - all Jobs are scheduled." |
| Walkthroughs bucket | "Nothing here - all Walkthroughs are scheduled." |
| Service Plans (live, empty) | `CheckCircle2` + "No plan visits due" |
| Service Plans (stub) | "Recurring visits land here (Step 9E)" |
| `TechnicianGridView` / `MemberWeekBoard`, no active staff | "No active staff members found." |
| `MemberWeekBoard` empty day cell | "Available" (italic) + header "No events" |
| `TechnicianGridView` idle column | 45deg hatch + "available (drop work here)" |
| `QuickScheduleCard` | "No unscheduled jobs" / "No walkthroughs to schedule" |
| `ScheduleSearch` | "No results for \"<q>\"" |

### 9.3 Error

- Unassigned-jobs query failure -> `unassignedError` -> the Jobs bucket renders
  `AlertCircle` + "Failed to load jobs". **This is the only per-query error UI**;
  the other three queries fail silently into an empty board.
- All mutation errors -> the bottom-right error toast, except 409s.
- There is no `ErrorBoundary` local to this page - it inherits the app-level one
  (`App.tsx:201`).

### 9.4 Event colouring (`eventStyleGetter`, `:1109-1191`)

Precedence, top wins:

1. ghost -> dashed 2px border, 12% tinted fill, `opacity 0.7`, `cursor: grab`
   (walkthrough `#06b6d4`, job `#3b82f6` - **raw hexes, currently in the page**)
2. `needs-crew` -> `!bg-danger !text-white !border-0` (red FILL)
3. `double-booked` -> `!bg-white !text-text-primary !border-2 !border-solid !border-danger` (red OUTLINE)
4. completed/cancelled -> `!bg-text-soft !text-white`, `opacity 0.6`, `cursor: default`
5. walkthrough -> `!bg-warning/10 !text-warning !border-l-4 !border-l-warning`
6. in-flight (`EN_ROUTE`/`ON_SITE`/`IN_PROGRESS`) -> `!bg-info !text-white`
7. scheduled -> `!bg-info/10 !text-info !border-l-4 !border-l-info`

Plus, when `event.id === highlightedEventId`: `boxShadow 0 0 0 3px rgba(12,45,58,0.5)`
+ `animation: search-highlight 1.5s ease-in-out infinite` + `zIndex 10`.

The `!` (important) modifier is required to outrank rbc's own `.rbc-event` rules.
**Any token remapping must preserve the `!` prefixes.**

Member-view cards use `EVENT_TYPE_META` accents plus `slate` (completed) /
`emerald` (in progress) schemes - a *different* palette from the standard
calendar. That divergence is deliberate and pre-existing.

### 9.5 Content thresholds inside `ScheduleEvent`

Height is estimated from duration at rbc's 48px/hour (`:244-255`):

| estimated height | shows |
|---|---|
| < 32px | title only |
| 32-52px | + time range |
| 53-79px | + performer names (the whole crew, comma-joined) |
| >= 80px | + address with `MapPin` |

All-day events render as a single-line pill: `"<number> — <customer>"` with an
`AlertTriangle` when double-booked and a "needs crew" tag when applicable.

### 9.6 `schedule-dark.css`

486 lines, all scoped under `.schedule-cal` (except `body.is-dragging`,
`.schedule-popup-enter`, `.schedule-dialog-enter`, `.schedule-backdrop-enter`,
`.schedule-toast-enter`, `.schedule-sidebar-section`, `.schedule-chevron`, and the
`search-highlight` keyframes). **Despite the filename it is a LIGHT theme** -
white backgrounds, Google-Calendar greys. There is no dark mode here.

Blocks, in order: base · time-view · day headers (incl. the Day-view
`rbc-time-header-cell-single-day` display fix and the larger date number) ·
**focus-day column expansion** · all-day strip collapse/expand · today highlight ·
time gutter · grid lines · current-time indicator · event pill · drag ghost
(`.rbc-addons-dnd-dragged-event`: 0.3 opacity, transparent, dashed, children
`opacity: 0`) · `body.is-dragging *` grabbing cursor · **drag preview sized from
the CSS vars** · resize handles · slot selection · month view · show-more ·
overlay popup · resource header · plan-mode amber gradient overlay ·
`search-highlight` keyframes · two separate `prefers-reduced-motion` blocks ·
popup/dialog/backdrop/toast enter animations · sidebar-section collapse ·
chevron rotation.

Two of those classes (`.schedule-sidebar-section`, `.schedule-chevron`) appear
to be **dead** - no `.tsx` in the repo applies them (the buckets do their own
collapse with conditional rendering). Verify before deleting.

---

## 10. Selector surface

### 10.1 `data-testid` - only three exist

| testid | Component | Consumed by |
|---|---|---|
| `unassigned-buckets` | `UnassignedBuckets.tsx:168` | `UnassignedBuckets.test.tsx` (vitest) |
| `grid-slot-<techId>-<hour>` | `TechnicianGridView.tsx:343` | `TechnicianGridView.test.tsx` |
| `week-cell-<memberId>-<yyyy-MM-dd>` | `MemberWeekBoard.tsx:227` | `MemberWeekBoard.test.tsx` |

**No Playwright spec uses any testid on this page.** The entire e2e surface is
class names, roles, and literal text.

### 10.2 The real e2e selector surface

Structural (rbc-owned, must survive):
`.rbc-calendar` · `.rbc-event` · `.rbc-time-view` · `.rbc-month-view` ·
`.rbc-time-content` · `.rbc-time-slot` · `.rbc-day-slot` · `.rbc-header` ·
`.rbc-resource-cell` · `.rbc-date-cell` · `.rbc-today` / `.rbc-now` ·
`.rbc-show-more` · `.rbc-current-time-indicator` ·
`.rbc-addons-dnd-resize-ns-anchor`

App-owned (must be carried into v2):
`.schedule-cal` (wrapper) · `.animate-spin` (the loading spinner locator) ·
`.lucide-chevron-left` / `.lucide-chevron-right` (prev/next buttons are located
**by their icon class**) · `.lucide-panel-right-close` / `.lucide-panel-right-open`
(referenced by `sched-sidebar.spec.ts` - note the current code uses
`PanelLeftClose`/`PanelLeftOpen`, i.e. `lucide-panel-left-*`; already stale) ·
`.w-60.border-r` (page object's sidebar locator - **already stale**, the sidebar
is now `style={{width: sidebarWidth}}`) · `input[placeholder*="Search schedule"]` ·
`[class*="fixed"][class*="bg-white"][class*="shadow"]` (popup heuristics) ·
`[class*="pointer-events-none"][class*="fixed"]` (empty overlay) ·
`span[class*="font-semibold"][class*="min-w"]` (date-range label) ·
`select` (department `SelectField` / staff filter)

Accessible names / literal text:
`Today` · `/^day$/i` `/^week$/i` `/^month$/i` · `Standard` · `/Member View/` ·
`By Technician` (**stale**) · `/Plan Mode|Planning/i` · `/Discard All/i` ·
`/Confirm All/i` · `Schedule Anyway` · `Cancel` · `Dismiss` · `Assign` ·
`/Reassign/i` · `Assign Technician` · `Scheduled Start` · `Scheduled End` ·
`/Scheduling Conflict/` · `Error` · `No jobs scheduled this week` ·
`Drag a job from the panel on the left` · `Drop here` · `View Job` · `View Lead` ·
`No Walkthrough Needed` · `Schedule settings` (aria-label) ·
`Filter schedule by department` (aria-label) · `Close` (aria-label,
`QuickScheduleCard`) · `Open panel` / `Collapse panel` (title attrs) ·
`Duration` (aria-label) · `Open full page` (aria-label) ·
`role="combobox"` (search input + shadcn selects) · `role="listbox"` ·
`role="dialog"` · `role="alertdialog"` (needs-crew) · `role="option"` ·
`role="group"` (drop-modal crew) · `role="status"` / `[data-sonner-toast]` (toasts)

### 10.3 Selectors the specs expect that the code no longer emits

Record these so a v2 test run can tell regression from pre-existing rot:

| Expected by | Reality |
|---|---|
| `Unassigned Jobs` heading / `getByRole('button',{name:/unassigned jobs/i})` (`schedule.page.ts:51`, `redesign/04-schedule.spec.ts:113`) | buckets are labelled `Jobs`, `Walkthroughs`, `Service Plans` |
| `All jobs are assigned` (`schedule.page.ts:52`, `sched-sidebar.spec.ts`) | copy is now "Nothing here - all Jobs are scheduled." |
| `Drag onto the calendar or click to assign` (`schedule.page.ts:53`) | copy is now "Drag a board card back here to unschedule - the crew is kept." |
| `By Technician` button (`schedule.page.ts:64`, `schedule-dnd.spec.ts`) | label is `Member View` |
| `Open` / `All` toggle (`schedule.page.ts:87-88`, `sched-interactions.spec.ts` M-12, `wt-schedule-views.spec.ts`) | **no such toggle exists in the current page** |
| sidebar-card click -> `AssignJobDialog` (`redesign/04-schedule.spec.ts` DLV-23d, `schedule-sidebar.spec.ts`) | click now opens `EventEditor` |
| sidebar drop -> `AssignJobDialog` (`schedule-dnd.spec.ts`) | drop now opens `UnifiedDropModal` |
| hover tooltip (`sched-interactions.spec.ts` L-01/L-02, `sched-text-overflow.spec.ts` A-03) | tooltips removed; handlers are no-ops |
| `.w-60.border-r` sidebar | width is now inline-styled and resizable |
| `[data-hour]` grid drop zones (`schedule.page.ts:187`) | zones use `data-testid="grid-slot-..."` |

**Action for the build phase:** run the full schedule spec set against `main`
first and record the baseline. Without it, "the v2 branch broke 9 specs" is
unfalsifiable.

---

## 11. Reimplementation checklist (what a v2 page must not lose)

1. `withDnD(Calendar)` + both rbc stylesheets + `schedule-dark.css`, imported in
   that order.
2. `ScheduleCtx` (or an equivalent) - rbc slot components cannot take props.
3. Every `!`-prefixed Tailwind class in `eventStyleGetter`.
4. The `--drag-preview-width` / `--drag-preview-left` mousedown/mouseup effect.
5. `.schedule-cal` on the wrapper and `data-focus-day` on the same element.
6. `hasAllDayEvents` -> `has-allday-events` class (the all-day strip is collapsed
   to `max-height: 0` without it).
7. `plan-mode-active` class on the board wrapper.
8. The `isAllDayStripDrop` heuristic, verbatim.
9. Prefix-matching `setQueriesData` / `getQueriesData` in all four optimistic
   mutations.
10. All twelve `boardReadOnly` bail-outs.
11. The `pendingMove` visual override paired with `rescheduleConfirm`.
12. The three `data-testid` patterns (the vitest suites depend on them).
13. The exact query keys - `['schedule-jobs', dateRange, departmentFilter]`,
    `['schedule-walkthroughs', dateRange]`, `['schedule-unassigned']`,
    `['schedule-unscheduled-walkthroughs']`. Mixed prefix/exact invalidation is
    intentional.
14. `Views.WEEK` as the default, `weekStartsOn: 0` everywhere.
15. The 250ms day-header click/double-click discriminator.
16. The capturing, 100ms-delayed outside-click `mousedown` listener.
17. `openDropModal` reading org defaults (`default_schedule_start_time`,
    `default_job_duration_min`, `default_walkthrough_duration_min`).
18. Every literal string listed in 10.2 - e2e matches text, not testids.

---

## 12. Open questions (recorded, not guessed)

1. **Agenda view.** rbc's default `views` includes `agenda` and `work_week`, and
   the `view` prop type lists them, but nothing selects them. Is agenda meant to
   exist? Currently: no.
2. **`reschedule Job` per-user grant is unreachable on this page.** A technician
   granted it still gets a read-only board because `boardCapabilitiesFor` keys on
   role alone. Intended, or a gap? Mapped as-is; not changed.
3. **`assign` is not in `USER_CAPABILITIES`** despite being the verb three of the
   page's four main writes enforce. The brief called it a per-user grant. Worth
   confirming with the permissions owner.
4. **Duplicate `beforeunload` effect** at `:609` and `:619` - byte-identical.
   Harmless; carry over or drop one? Recommend carrying both to keep the diff
   presentational.
5. **Empty-state copy says "this week"** in Day and Month views too. Bug or
   accepted? Reproduce verbatim; do not "fix" during a presentation swap.
6. **`.schedule-sidebar-section` and `.schedule-chevron`** in `schedule-dark.css`
   appear unused. Confirm before pruning.
7. **Two colour systems for events** - the standard calendar uses
   `info`/`warning`/`text-soft` tokens; the member views use
   `EVENT_TYPE_META` + raw `slate`/`emerald` Tailwind palette classes. Should the
   v2 unify them, or is the divergence load-bearing? Unifying is a **visual**
   change, so it needs sign-off.
8. **Raw hexes still in `SchedulePage.tsx`** - the ghost styles (`:1116-1117`),
   the slot dim `#F7F7F2` (`:1198`), the plan-mode banner gradient (`:2450`), and
   the three drag-image tints. These violate the CLAUDE.md token rule today. The
   v2 page is the natural place to tokenise them - but that is a visual delta and
   should be called out in the PR, not slipped in.
9. **`sched-*` legacy specs seed a hardcoded demo-org admin** and are documented
   in `redesign/04-schedule.spec.ts` as "org-mismatched against the provisioned
   throwaway org". How many of the 24 DnD specs actually run green today? Needs a
   baseline run before Phase 2.
