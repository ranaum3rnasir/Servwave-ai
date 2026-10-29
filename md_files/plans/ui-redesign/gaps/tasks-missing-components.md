# Tasks - components with no kit equivalent

Module 8. Branch `refactor/ui-kit-08-tasks`.
Rebuilt under `frontend/src/pages/v2/tasks/`: `TasksHubPage.tsx`, six views under `views/`, ten
components under `components/`. Registered by `pages/v2/routes/tasks.paths.ts` +
`tasks.routes.tsx` (one path, `/tasks`).

The import checklist is every `@/components/...` import across the hub page, the six views and the
eleven `components/tasks/` components - 24 distinct modules, all accounted for below.

## The behaviour map is materially wrong

`md_files/specs/ui-redesign/tasks-behavior-map.md` is dated 2026-07-29 and the module has moved
under it. Every disagreement below was resolved in favour of the code, per the brief. The two in
bold changed what this branch built.

| Map says | Code says | Source |
|---|---|---|
| **"Verified: BoardView contains no `draggable`, no `onDragStart/onDrop`, no dnd-kit... and no HTML5 DnD of any kind"**, and warns that adopting the kit's Kanban "would ADD an interaction that does not exist today" | BoardView has full native HTML5 drag-and-drop: `draggable` cards, `dataTransfer.setData('task-id', ...)`, per-column `onDragOver`/`onDragLeave`/`onDrop`, `dragOverStatus` ring feedback, drop calls `updateStatus` | `pages/tasks/views/BoardView.tsx:15-25, 77-79, 94-99` |
| **"DashboardView ... Interactive elements: none. No click handler anywhere in this view. It cannot open the drawer."** | Four of the five KPI cards are clickable filters: each toggles `taskFilterStore.category` and calls `onDrillDown()`, which the hub wires to switch to the List tab | `views/DashboardView.tsx:22-37, 61-64` |
| Hub uses Radix `<Tabs>` directly with `TabsList`/`TabsTrigger` | Hub uses `@/components/patterns/TabStrip` (phase 11.6); `data-testid="tasks-tab-rail"` now wraps rail AND panels | `TasksHubPage.tsx:7, 117-134` |
| Filter bar has three Selects (member/department/tag) and a Clear button | It also has a drill-down category pill, Overdue and At risk checkboxes, and two `DateRangeFilter` pairs (due, created) | `components/tasks/TaskFilterBar.tsx:26-29, 120-163` |
| `useFilteredTasks()` filters on `{memberId, departmentId, tag}` | It filters on ten fields and takes an `{applyCategory}` option; Dashboard and History pass `false` | `lib/tasks/useFilteredTasks.ts:7-46` |
| Calendar drop calls `updateTask(id, {due_at})` | It calls a dedicated `reschedule` store action, which is OPTIMISTIC with rollback and an error toast - the one optimistic mutation in the module, contradicting "No mutation in this module is optimistic" | `stores/tasksStore.ts:100-125` |
| Calendar drag is ungated | Drag and drop are gated on `ability.can('update','Task')` via a `canEdit` prop | `views/CalendarView.tsx:539-540` |
| "Raw Tailwind palette classes in CalendarView, StatusPill, PriorityDot, RiskBadge, ListView, MyDayView ... are a token-porting task for the v2 build" | Already done. All six resolve through `design-system/status-registry` (`STATUS_INTENT_CLASSES`/`_FILL`/`_TEXT`/`_HOVER`) or named tokens. There is no `StatusPill`; it is `data/status-badge`'s `StatusBadge` | `components/tasks/PriorityDot.tsx`, `RiskBadge.tsx`, `views/CalendarView.tsx:98-123` |
| ListView renders `<StatusPill>`; MyDayView uses `border-rose-200 bg-rose-50` | `StatusBadge domain="task"`; `border-danger-border bg-danger-surface text-danger-text` | `views/ListView.tsx:84`, `views/MyDayView.tsx:98` |
| `CreateTaskModal` title/desc are bare `<input>`/`<textarea>` | They are `FormField` + `Input` / `Textarea` primitives | `components/tasks/CreateTaskModal.tsx:129-136, 192-200` |
| `TaskCard` shows `StatusPill`, mixed palette | `StatusBadge`, tokens throughout | `components/tasks/TaskCard.tsx` |
| Spec list omits three suites | `tasks-hub-tab-rail.test.tsx`, `tasks-dashboard-kpi.test.tsx`, `formfield-jobs-tasks-crm.test.tsx` and `pages/tasks/views/__tests__/CalendarView.chip-appearance.test.tsx` also exist | `ls src/__tests__` |

The task brief was stale too: it said "about 6 views" (correct) and pointed at
`react-big-calendar` as a possible reuse - the module has never used it, and it is not a dependency
of this repo.

## Gaps

| Old component | Used in | What it does | Kit's nearest thing | Why it is not enough | Rec |
|---|---|---|---|---|---|
| Kit `crm/kanbanBoard/kanbanCard` (`KanbanItem`) | Board | the kit's own board card | it IS the kit's thing | `KanbanItem` makes `type: WorkType` MANDATORY and `WorkType` is a closed union of `emergency \| maintenance \| installation \| inspection`. A task has no work type, so every card would render a solid glyph with `aria-label="Emergency callout"` or similar - fabricated data presented as fact. It also has no slot for a DUE DATE or a RISK BADGE, the two fields the board is triaged on. Built `pages/v2/tasks/components/taskCard.tsx` on kit `Card`/`Badge`/`Avatar`/`Button` instead | BUILD (a card whose meta row is caller-supplied, or an optional `type`) |
| Kit `crm/kanbanBoard/kanbanBoard` | Board | the kit's board shell | it IS the kit's thing | hardcodes `KanbanCard` with no render slot, so it inherits the row above. Its `KanbanColumn` IS used - the column is where the board's chrome lives, and it composes cleanly inside a locally-owned `DndContext` | BUILD (a `renderCard` prop) |
| Kit `crm/kanbanBoard/kanbanColumn` - dead kebab | Board | column chrome | in use | the column renders an unconditional `MoreHorizontal` Button with **no handler and no way to remove it** (`sr-only` text "{title} column actions"). Using the column therefore ships a visible control that does nothing. Confirmed in the rendered DOM by this module's own test. Not worked around: suppressing it means editing a shared kit file | BUILD (make the kebab opt-in, e.g. `actions?: ReactNode`) |
| Kit `crm/kanbanBoard/kanbanColumn` - empty copy | Board | column chrome | in use | its empty state is hardcoded `No items in this stage`; the legacy board said `Empty`. No prop to change it. A one-word copy change on an empty lane, disclosed rather than fixed by forking the column | BUILD (`emptyLabel` prop) |
| a calendar VIEW | Calendar | month/week/day grids with per-day drop targets and an unscheduled strip | `ui/calendar` | `ui/calendar` is a react-day-picker DATE PICKER: single/range date selection, no events, no week or day mode, no drop targets. The 585-line hand-rolled view is carried over structurally and only its chrome moved onto the kit | KEEP (a calendar view is a module, not a primitive) |
| Tabs | hub | six-tab rail | none | the kit ships 21 UI primitives and none is Tabs. Reused `pages/v2/leads/components/tabs.tsx` (`TabStrip`/`TabPanel`) rather than writing a fifth hand-rolled version - fifth module to need it | BUILD (this is now unanimous across five modules) |
| `crm/AssigneeSelect` | create dialog, drawer | single-owner picker: fetches assignable users, filters by `eligibleFor`, popover + search | `form/combobox` | the combobox is a static-options Command picker; this owns its own `useAssignableUsers` query and eligibility filter. Kept and imported unchanged | KEEP |
| `crm/MultiAssigneeSelect` | create dialog, drawer | watcher multi-select over the same user source | `form/combobox` | same, plus multi-value chips. Kept and imported unchanged | KEEP |
| `components/tasks/LinkedEntitySelect` | create dialog | picker with a TYPE axis (Job/Lead/Customer/Estimate) that re-points the query at four different endpoints, plus a `leads` entitlement gate | `form/combobox` | the combobox has one list and no second axis. Rebuilt on kit `Popover`/`Input`/`Button` at `components/linkedEntitySelect.tsx` keeping every label builder, the query key, the entitlement gate and all four `data-testid`s | BUILD (a combobox with a facet row would cover this and the customer pickers) |
| `form/DateTimePicker` | create dialog | date + 15-minute time picker that works inside a modal Radix Dialog | `form/datePicker` | the kit picker is date-ONLY and emits a `Date`. It also cannot be swapped for a bare `datetime-local` Input: a native picker cannot be dismissed from inside a modal Radix Dialog (#430), which is the whole reason this component exists. Rebuilt on kit `Popover`+`Calendar`+`Select` at `components/dateTimePicker.tsx` so the fix survives | BUILD (a `DateTimePicker` beside `DatePicker`) |
| `form/DateRangeFilter` | filter bar | two `YYYY-MM-DD` string inputs with cross `min`/`max` | `form/dateRangePicker` | the kit range picker emits a `DateRange` of `Date`s; this filter writes two STRINGS straight into the zustand store. Rebuilt inline on two kit date Inputs so the store contract is untouched | KEEP |
| `charts/ChartCard` + `charts/chartTheme` | Dashboard, History | titled frame for a recharts tree, plus shared tooltip styling | none | charts are a no-touch boundary in this migration. `chartTheme` is imported unchanged; only the FRAME was rebuilt on kit `Card` at `components/chartCard.tsx` | KEEP |
| `design-system` `token()` + `status-registry` | Dashboard, History, Calendar, atoms | chart colours and the status label/intent map | none, and none wanted | these are domain logic, not presentation - the registry is the single answer to "what does BLOCKED mean" for the whole app. Imported unchanged in every v2 file | KEEP |

## Replaced (the audit trail)

Every `@/components/...` import across the legacy hub, its six views and its eleven components.

### `pages/tasks/TasksHubPage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/button` | `ui-kit/components/ui/button` | |
| `ui/heading` | `ui-kit/components/layout/pageHeader` `title` | the raw-tag ratchet forbids a new `h1`-`h6` outside the primitives, and PageHeader owns one |
| `ui/tabs` (`TabsContent`) + `patterns/TabStrip` | `pages/v2/leads/components/tabs` (`TabStrip`, `TabPanel`) | gap row above. `TabPanel` returns `null` when inactive, matching Radix `TabsContent`'s unmount default (no `forceMount` was ever passed) |
| `tasks/AiCommandBar` | `pages/v2/tasks/components/aiCommandBar` | |
| `tasks/TaskFilterBar` | `pages/v2/tasks/components/taskFilterBar` | |
| `tasks/CreateTaskModal` | `pages/v2/tasks/components/createTaskDialog` | |
| `tasks/TaskDetailDrawer` | `pages/v2/tasks/components/taskDetailDrawer` | |
| (page header authored inline) | `ui-kit/components/layout/pageHeader` + `pages/v2/pageBreadcrumbs` | `navKey="tasks"`; the legacy page had no breadcrumb |

### `views/DashboardView.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `data/KpiStrip` | `ui-kit/components/data/statCard` (`StatCard`, `StatCardGroup`) | same five tiles, same values, same click predicates, same `active` state. Two disclosed deltas: the kit StatCard ships **no icon** (a documented kit decision - `tone` is a 3px rail instead), and Top Closer, having no `onClick`, renders as a `div` rather than a `button` |
| `charts` (`ChartCard`) | `pages/v2/tasks/components/chartCard` over kit `Card` | gap row |
| `design-system` (`token`) | kept, unchanged | chart boundary |
| (hand-rolled `%`-width `div` bars) | `ui-kit/components/ui/progress` | same measure, now with a real `progressbar` role and an accessible name |
| recharts `LineChart` | kept, byte-identical | chart boundary |

### `views/HistoryView.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `data/KpiStrip` | `ui-kit/components/data/statCard` | four tiles |
| `charts` (`ChartCard`) + `charts/chartTheme` | `pages/v2/tasks/components/chartCard`; `chartTheme` imported unchanged | |
| `tasks/TaskCard` | `pages/v2/tasks/components/taskCard` | |
| (count pill authored inline) | `ui-kit/components/ui/badge` `variant="softNeutral" size="pill"` | |
| (card authored inline) | `ui-kit/components/ui/card` (`Card`/`CardHeader`/`CardTitle`/`CardContent`) | |
| recharts `BarChart` | kept, byte-identical | chart boundary |

### `views/BoardView.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `tasks/TaskCard` | `pages/v2/tasks/components/taskCard` | |
| `form/SelectField` | `ui-kit/components/ui/select` | gains an `aria-label` per row (`Status for {title}`) - the legacy select had none, so on a column of cards a screen reader heard four identical unlabelled comboboxes |
| `design-system/status-registry` | kept, unchanged | |
| (columns authored inline) | `ui-kit/components/crm/kanbanBoard/kanbanColumn` | the kit component this module was asked to find a caller for. Two gap rows above cover what it costs |
| native HTML5 `dataTransfer` DnD | `@dnd-kit/core` + `@dnd-kit/sortable` | REPLACES an interaction, does not add one (see the map table). Adds the keyboard path HTML5 DnD cannot have |

### `views/MyDayView.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/button` | `ui-kit/components/ui/button` | |
| `ui/heading` | plain `p` with kit type tokens | inside a card, not a page title |
| `ui/use-toast` | `ui-kit/components/ui/sonner` (`toast`) | `toast(message)` replaces `toast({ description })` |
| `tasks/PriorityDot` | `pages/v2/tasks/components/atoms` (`PriorityDot`) | |
| `tasks/SuggestedTasksPanel` | `pages/v2/tasks/components/suggestedTasksPanel` | |
| (due chip authored inline) | `ui-kit/components/ui/badge` | `softRed` when overdue, `outline` otherwise |
| (card + dividers authored inline) | `ui-kit/components/ui/card` + `ui/separator` | |

### `views/ListView.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `data/status-badge` (`StatusBadge`) | `pages/v2/tasks/components/atoms` (`TaskStatusChip`) over kit `Badge` | resolves through `status-registry`; only the painting is local |
| `tasks/PriorityDot`, `tasks/LinkedEntityChip` | `components/atoms` | |
| `ui/empty-state` | `ui-kit/components/data/emptyState` | |
| bare `<input>` search | `ui-kit/components/form/searchInput` | |
| plain `<table>` | `ui-kit/components/ui/table` primitives | deliberately NOT `data/dataTable`: the legacy list has fixed columns, no sorting, no column menu and no pagination, and driving it through the TanStack table would add three controls the page has never had |

### `views/CalendarView.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `design-system/status-registry` (`STATUS_INTENT_CLASSES`/`_FILL`/`_HOVER`) | kept, unchanged | including the documented `text-foreground` override for TODO chips, whose text is a task TITLE not a status word, and the `cn` argument ORDER that override depends on |
| `contexts/AbilityContext` (`useAppAbility`) | kept, unchanged | `canEdit = ability.can('update','Task')` still gates every drag source and drop target |
| raw `<button>` toolbar + segmented toggle | `ui-kit/components/ui/button` | `aria-label="Previous period"` / `"Next period"` preserved; the segmented toggle gains `aria-pressed` |
| raw `<button>` chips and rows | `span` with `role="button"`, `tabIndex={0}` and an Enter/Space handler | the raw-`<button>` ratchet is at its floor (664/664), so a new one turns it red. The span keeps the role, the focus order and adds keyboard activation the raw `<button>`s had for free |
| (card authored inline) | `ui-kit/components/ui/card` | |
| native HTML5 DnD | **kept, unchanged** | dnd-kit does not emit `dataTransfer`, so half-migrating breaks reschedule outright. See gaps |

### `components/tasks/*` (all eleven)

| Old component | Replaced by | Notes |
|---|---|---|
| `TaskCard` | `pages/v2/tasks/components/taskCard` | kit `Card`/`Badge`/`Avatar`/`Button`. Both quick-complete `aria-label`s preserved |
| `PriorityDot` | `components/atoms` (`PriorityDot`) | dot+label becomes a SOFT kit Badge - the kit's locked rule is that the solid fill belongs to the status, and a second solid chip on the same row competes with it. Same four-step scale, same labels, same registry |
| `RiskBadge` | `components/atoms` (`RiskBadge`) | still renders ONLY when `atRisk`; `title` still carries the reason |
| `LinkedEntityChip` | `components/atoms` (`LinkedEntityChip`) | 24-char truncation and full-label `title` preserved |
| (`data/status-badge` for the task domain) | `components/atoms` (`TaskStatusChip`) | |
| `AiCommandBar` | `components/aiCommandBar` | kit `Input`+`Button`; `data-testid="tasks-ai-command"` preserved; `taskAI.parse(..., { entities: [] })` unchanged |
| `TaskFilterBar` | `components/taskFilterBar` | kit `Select`/`Checkbox`/`Label`/`Button`/`Input`; every store action call unchanged |
| `CreateTaskModal` | `components/createTaskDialog` | kit `Dialog`; still NO react-hook-form and NO client zod schema (see below) |
| `TaskDetailDrawer` | `components/taskDetailDrawer` | kit `Sheet`; every accessible name preserved |
| `SuggestedTasksPanel` | `components/suggestedTasksPanel` | still hard-coded demo data, still `useState`-only |
| `LinkedEntitySelect` | `components/linkedEntitySelect` | gap row |
| `JobLeadTasksTab` | not touched | it is a JOB/LEAD page component, not part of the Tasks hub. Three v2 modules already import the legacy one directly |
| `ui/dialog`, `ui/sheet`, `ui/select`, `ui/input`, `ui/textarea`, `ui/checkbox`, `ui/popover`, `ui/button` | the `ui-kit` equivalent of each | |
| `patterns/FormField` | `ui-kit/components/ui/label` + a flex column | the kit's `form/formField` is a react-hook-form `Controller` wrapper, and this dialog has no form library - see below |
| `ui/use-toast` | `ui-kit/components/ui/sonner` | |
| `lib/*`, `stores/*`, `contexts/*` | all kept, imported unchanged | no business logic was forked |

## Behaviour deltas (not gaps, but not parity either)

| What | Legacy | v2 | Why |
|---|---|---|---|
| Board drag mechanism | native HTML5 `dataTransfer` | `@dnd-kit` with a `KeyboardSensor` | the kit column requires a `DndContext`, and dnd-kit is the only path that has a keyboard story. Drop semantics are identical: a drop resolving to a status calls `updateStatus`, a drop resolving to At Risk is a no-op (the legacy At Risk lane had no drop handler at all) |
| Board empty column | `Empty` | `No items in this stage` | hardcoded in the kit column, no prop. Gap row |
| Board column kebab | none | a dead `MoreHorizontal` button | hardcoded in the kit column, no prop. Gap row |
| Board card | dot+label priority, `text-danger` overdue line | soft priority badge, `text-status-red-emphasis` overdue line | kit painting; same information, same fields |
| KPI tiles | icon + tinted value | no icon, 3px `tone` rail | the kit's StatCard has no icon slot by design |
| Priority everywhere | coloured dot + word | soft badge with the same word | see above |
| Board status select | no accessible name | `aria-label="Status for {title}"` | four unlabelled comboboxes in a column is a defect, and naming one is not a behaviour change |
| Calendar chips / day rows | `<button>` | `<span role="button" tabIndex=0>` with Enter/Space | the raw-`<button>` ratchet is at its floor |
| Create dialog date field | `form/DateTimePicker` | `components/dateTimePicker` on kit primitives | same value contract (`'' \| 'YYYY-MM-DDTHH:MM'`), same 15-minute step, same modal-safety property |
| Create dialog validation | no RHF, no client zod | unchanged - no RHF, no client zod | deliberate. The only client rule is a non-empty title; the real schema is the server's. Adding a resolver would be a behaviour change dressed as a restyle, so the kit's `form/formField` (a RHF `Controller` wrapper) is not used and plain `Label` + control is |
| Toasts | `ui/use-toast` `{title, description, variant}` | sonner `toast(title, {description})` / `toast.error(...)` | same API shift every prior v2 module made |
| Em dashes and glyphs | literal characters in source | `components/glyphs.ts` unicode escapes | CLAUDE.md forbids an em/en dash in source; these are RENDERED CONTENT, so they are escaped rather than dropped. Rendered output is unchanged |

## Observed but not fixed

| What | Where | Why it is out of scope |
|---|---|---|
| The behaviour map is materially wrong on the two most consequential facts in the module (Board has DnD; Dashboard is interactive). See the table at the top. | `md_files/specs/ui-redesign/tasks-behavior-map.md` | the code won, per the brief. Updating the map is a documentation task |
| `fetchTasks` has a `try/finally` with **no `catch`**. A failed `GET /api/tasks` leaves the page permanently showing an empty board with `loaded: false` and no error anywhere. There is no loading UI either - `tasksStore.loading` exists and is read by no component. | `stores/tasksStore.ts:42-52` | adding an error state is new behaviour, and it belongs in the shared store every surface reads |
| Inline edits in the drawer are unguarded promises. A user without the `update Task` grant gets a 403 and an unhandled rejection - no toast, no revert, the field just silently keeps the new value on screen. | `components/tasks/TaskDetailDrawer.tsx`, reproduced in v2 | fixing it means adding error handling to six shared store actions |
| The drawer computes risk with `ownerOpenCount: 0` hardcoded, while the board feeds the real per-owner count. The SAME task can show "At risk" on the board and not in the drawer. | drawer vs `views/BoardView.tsx:49` | reproduced as-is; picking one is a product decision |
| "Plan my day" toasts the PRE-recompute count, because `ranked` is captured from the current render while the button bumps the nonce that drives the recompute. | `views/MyDayView.tsx:46` | reproduced as-is; the brief says preserve behaviour |
| There is no UI path to DELETE a task anywhere, though `deleteTask` and `DELETE /api/tasks/:id` both exist and are tested. | store/API vs every view | adding one is a product decision |
| `AiCommandBar` and `CreateTaskModal` both call `taskAI.parse(..., { entities: [] })`, so the NL parser can never resolve a linked entity - the feature is wired to an empty list. | `components/tasks/AiCommandBar.tsx:30`, `CreateTaskModal.tsx` | reproduced; populating it is a feature |
| A failed NL parse is a silent no-op: the input clears and nothing is said. | `AiCommandBar.handleSubmit` | reproduced |
| The month cell's `+N more` overflow marker is plain text with no "show all" affordance, so tasks 4+ on a busy day are unreachable from the month view. | `views/CalendarView.tsx` MonthView | reproduced; adding disclosure is new behaviour |
| Calendar reschedule is desktop-only - native HTML5 DnD is pointer-only, and the file's own comment defers touch to #681. | `views/CalendarView.tsx:222` | pre-existing, and the calendar keeps native DnD here |
| `SuggestedTasksPanel` is three hardcoded demo strings and says so on screen. | `components/tasks/SuggestedTasksPanel.tsx` | do not wire it to anything |
| `HomeRoute` redirects a user without `read Dashboard` to the first reachable `DEFAULT_LAYOUT_KEYS` entry, which points at the LEGACY `/tasks`. On the parallel `/v2` path such a user lands on the old page. | `components/layout/HomeRoute.tsx`, `nav-registry.ts` | repointing it means editing shared nav files, which the brief forbids. Under `VITE_UI_V2` the redirect makes it moot. Flagged in `tasks.routes.tsx` |
| `BoardView` and `HistoryView` carry no `data-testid` at all, in legacy or v2 (nothing to carry over). | both views | not a regression; noted so the audit does not read it as a dropped selector |
