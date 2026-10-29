# Tasks module - behaviour map

Phase 1 mapping artefact for `refactor/ui-kit-08-tasks` (module 8 of
`md_files/plans/ui-redesign/UI_KIT_MIGRATION_PLAN.md`).
Documentation only. Every statement below was read from the files cited; anything
not verified is listed under "Open questions".

Mapped on 2026-07-29 against `main` @ 7dfa18e9.

---

## 1. Route and guards

| Item | Value | Source |
|---|---|---|
| Path | `/tasks` (single route, no children, no params) | `frontend/src/App.tsx:131` |
| Element | `<TasksHubPage />`, `React.lazy` | `App.tsx:71` |
| Route guard | `<ProtectedRoute allowedRoles={['ADMIN','SALES','DISPATCHER','TECHNICIAN']} />` wrapping `<AppLayout />` | `App.tsx:111` |
| Extra route gate | none - no nested `ProtectedRoute`, no `DemoOnlyRoute`, no feature/entitlement gate | `App.tsx:131` |
| Nav entry | `{ key: 'tasks', label: 'Tasks', icon: ClipboardList, href: '/tasks', action: 'read', subject: 'Task', home: 'Page' }` | `frontend/src/components/layout/nav-registry.ts:59` |
| Sidebar visibility | CASL-filtered on `ability.can('read','Task')` | `nav-registry.ts` + `Sidebar.tsx` |
| Query param | `?action=new-task` opens the blank create modal once, then is stripped with `replace: true` | `TasksHubPage.tsx:43-49` |

### SALES landing behaviour (verified, and it is indirect)

`/` renders `HomeRoute` (`frontend/src/components/layout/HomeRoute.tsx`). It does
**not** hardcode a SALES redirect. The logic is:

1. `if (ability.can('read','Dashboard')) return <DashboardPage />;`
2. otherwise `Navigate replace` to the **first** entry of `DEFAULT_LAYOUT_KEYS`
   (order: `dashboard, schedule, tasks, leads, jobs, clients, estimates, invoices,
   service-plans, pricebook, billing, reports, inventory, communication, marketing`
   - `nav-registry.ts:94-97`) that is not `dashboard`, is not `comingSoon`, and
   passes `ability.can(dest.action, dest.subject)`.
3. fallback `/leads`.

So SALES lands on `/tasks` **only if** SALES lacks `read Dashboard`, lacks
`read` on the `schedule` destination's subject, and holds `read Task`. That is a
data-driven outcome of the CASL ability, not a literal route rule. **Do not
reimplement this in the v2 page** - `HomeRoute` is shared logic and stays as is.
Consequence for the migration: `/v2/tasks` will not be anyone's landing page
unless `HomeRoute`/`nav-registry` are also pointed at it, which the plan forbids.

---

## 2. Hub shell and view switching

File: `frontend/src/pages/tasks/TasksHubPage.tsx` (112 lines).

### Component tree

```
<div data-testid="tasks-workspace">
  header row
    span(icon ClipboardList) + h1 "Tasks" + subtitle
    <Button size="sm" onClick=setNewTaskOpen(true)>  "+ New Task"
  <div data-testid="tasks-command-filter-panel">      grid, xl:2col
    <AiCommandBar />                                  components/tasks/AiCommandBar.tsx
    <TaskFilterBar />                                 components/tasks/TaskFilterBar.tsx
  <CreateTaskModal open={newTaskOpen} onOpenChange />  components/tasks/CreateTaskModal.tsx
  <Tabs value={activeTab} onValueChange>               components/ui/tabs (Radix)
    <div data-testid="tasks-tab-rail"> <TabsList>
      TabsTrigger dashboard | board | my-day | list | calendar | [history]
    <TabsContent dashboard> <DashboardView />
    <TabsContent board>     <BoardView />
    <TabsContent my-day>    <MyDayView />
    <TabsContent list>      <ListView />
    <TabsContent calendar>  <CalendarView />
    [<TabsContent history>  <HistoryView />]
  <TaskDetailDrawer />                                 shared across all tabs
```

### Where view state lives

- **Active tab: `useState<TabKey>('dashboard')` local to `TasksHubPage`.**
  Not in the URL, not in a store, not in `localStorage`. It resets to `dashboard`
  on every remount/reload. There is no `?tab=` param. This is the single most
  important state fact for the rebuild.
- All six `<TabsContent>` nodes are mounted inside `<Tabs>`; Radix `TabsContent`
  unmounts inactive panels by default (no `forceMount` prop is passed), so only
  the active view's component tree is mounted at a time. Their data source is a
  shared zustand store, so switching tabs does not refetch.
- Filter state (`memberId`, `departmentId`, `tag`) lives in
  `stores/taskFilterStore.ts` - a module-level zustand store, so it survives tab
  switches and even navigation away and back within the SPA session, but not a
  reload (no persist middleware).
- Open-task-drawer state lives in `stores/taskDetailStore.ts`
  (`openTaskId: string | null`).
- The task list itself lives in `stores/tasksStore.ts` (zustand, not TanStack
  Query). `TasksHubPage` calls `fetchTasks()` once on mount; `fetchTasks` early
  returns if `loading || loaded`, so it hydrates once per page-load lifetime.

### Permission gating in the hub

```ts
const role = useAuthStore((s) => s.user?.role);
const canSeeHistory = role === 'ADMIN' || role === 'DISPATCHER';
```
`canSeeHistory` gates **both** the History `TabsTrigger` and its `TabsContent`.
This is a raw role string check, **not** CASL. It is the only permission
conditional in the whole Tasks UI.

Everything else (create, edit, delete, comment, nudge) is ungated on the client;
the server enforces `canDo('create'|'update'|'delete', 'Task')`
(`backend/src/routes/task.routes.ts:12-22`). A user without the grant gets a 403
and, for create, a destructive toast; for inline edits in the drawer, an
unhandled rejection (see Open questions).

---

## 3. Data layer (shared by every view)

### Store: `frontend/src/stores/tasksStore.ts`

Zustand, no TanStack Query, therefore **no query keys and no cache invalidation
anywhere in this module**. All mutations write the returned row back into the
`tasks` array by hand.

| Store action | API fn | HTTP | After success |
|---|---|---|---|
| `fetchTasks()` | `listTasks()` | `GET /api/tasks` | `set({tasks, loaded:true})`; no-ops if `loading \|\| loaded` |
| `fetchTaskDetail(id)` | `getTask(id)` | `GET /api/tasks/:id` | replaces (or appends) that row with the rich detail row |
| `addTask(input)` | `createTask(input)` | `POST /api/tasks` | prepends returned row |
| `updateStatus(id, status)` | `updateTaskApi(id,{status})` | `PATCH /api/tasks/:id` | replaces row |
| `updateTask(id, patch)` | `updateTaskApi` | `PATCH /api/tasks/:id` | whitelists `title, description, status, priority, owner_id, due_at, tags`; re-merges client-only `subtasks, activity, comments, ai, watcher_ids` onto the server row |
| `deleteTask(id)` | `deleteTaskApi` | `DELETE /api/tasks/:id` | filters row out |
| `addComment(id, body)` | `addCommentApi` | `POST /api/tasks/:id/comments` | then `fetchTaskDetail(id)` |
| `addSubtask(id, text)` | `addSubtaskApi` | `POST /api/tasks/:id/subtasks` | then `fetchTaskDetail(id)` |
| `toggleSubtask(id, sid, done)` | `updateSubtaskApi` | `PATCH /api/tasks/:id/subtasks/:sid` | then `fetchTaskDetail(id)` |
| `deleteSubtask(id, sid)` | `deleteSubtaskApi` | `DELETE /api/tasks/:id/subtasks/:sid` | then `fetchTaskDetail(id)` |
| `setWatchers(id, ids)` | `updateTaskApi(id,{watcher_ids})` | `PATCH /api/tasks/:id` | then `fetchTaskDetail(id)` |
| `nudge(id)` | `nudgeApi` | `POST /api/tasks/:id/nudge` | then `fetchTaskDetail(id)` |

API module: `frontend/src/lib/api/tasks.ts`. Raw axios (`@/lib/axios`), not
react-query. `mapRowToTask` / `mapDetailToTask` do the row -> `Task` shaping;
list rows always come back with `subtasks: []`, `comments: []`, `activity: []`,
`watcher_ids: []`, which is why the drawer must re-fetch detail on open.

**No mutation in this module is optimistic.** Every one awaits the server.

### TanStack Query calls that DO exist in this module

| Hook | Where | Purpose |
|---|---|---|
| `useAssignableUsers({ eligibleFor: 'task' })` | `useFilteredTasks`, `DashboardView`, `TaskFilterBar`, `AiCommandBar`, `CreateTaskModal` | user list for owner names, filters, NL parsing |
| `useDepartments()` | `TaskFilterBar` | department filter options |
| `useQuery(['linked-entity-search', activeType, debouncedQ])` | `LinkedEntitySelect` | `GET /api/jobs\|/api/leads\|/api/estimates\|/api/customers` with `{search, limit:10}`, `enabled: open`, `placeholderData: keepPreviousData`, `staleTime: 30_000` |

Query key `['linked-entity-search', activeType, debouncedQ]` is the only literal
query key in the module. The `useAssignableUsers` / `useDepartments` keys live in
`lib/api/users.ts` and `lib/api/departments.ts` (not re-read here - see Open questions).

### The filter pipeline every view goes through

`frontend/src/lib/tasks/useFilteredTasks.ts`:

```ts
applyTaskFilter(tasks, { memberId, departmentId, tag }, people)
```
`people` is derived from `useAssignableUsers` and maps `department` to
`u.department?.id ?? ''`. `applyTaskFilter` (`lib/tasks/tasks-logic.ts:153`)
drops a task when `memberId !== 'all' && t.owner_id !== memberId`, when the
owner's department id mismatches, or when `!t.tags.includes(tag)`.

**All six views call `useFilteredTasks()`, so the filter bar affects every tab.**

### Domain logic (pure, must be reused verbatim, not reimplemented)

`frontend/src/lib/tasks/tasks-logic.ts`:
- `isOverdue(task, now)` - false when `!due_at` or `status === 'DONE'`.
- `assessRisk(task, {now, ownerOpenCount})` -> `{score, reason, atRisk}`.
  Score: overdue +45 / <24h +30 / <48h +18; age in stage >=5d +20, >=3d +10;
  ownerOpenCount >=8 +20, >=5 +10; `BLOCKED` +15; capped 100. **`atRisk = score >= 50`.**
- `rankMyDay(tasks, userId, now)` - own non-DONE tasks, bucketed
  overdue(0)/due-today-UTC(1)/other(2), then priority `URGENT<HIGH<MEDIUM<LOW`,
  then oldest-updated first.
- `computeStats(tasks, now)` -> `{open, atRisk, onTimePct, blocked, topCloserId, byAssignee, trend}`;
  `onTimePct` is 100 when nothing is done; `trend` is 8 weekly buckets of closures.
- `computeHistory(tasks, now)` -> `{snapshot, flow(8 weeks created/closed), upcoming{thisWeek,nextWeek,later}}`;
  overdue tasks are excluded from "upcoming".

`frontend/src/lib/tasks/taskAI.ts` exports
`{ parse, rollup, suggestTasks, suggestAssignee, assessRisk, rankMyDay }` - a
local heuristic NL parser, **no network call, no LLM**.

---

## 4. Per-view maps

### 4.1 DashboardView (default tab)

File: `pages/tasks/views/DashboardView.tsx` (127 lines).

Tree: `<KpiStrip>` -> `div[data-testid="dashboard-insight-panel"]` ->
`grid md:2col` of two `<ChartCard>`s.

- **KPI strip** (`components/ui/KpiStrip`): Open (`ListChecks`, primary),
  At Risk (`AlertTriangle`, amber), On-Time % (`CheckCircle`, emerald),
  Blocked (`Ban`, rose), Top Closer (`Star`, neutral - resolves
  `stats.topCloserId` through `userNameById`, falls back to the raw id, then `-`).
- **Insight panel**: `taskAI.rollup(tasks, now)` string. Static text, no controls.
- **Open by Assignee**: hand-rolled horizontal bars (`div` width `%` of
  `maxOpen`), a `⚑` glyph with `title="{n} overdue"` when `row.overdue > 0`.
  Empty state: `"No open tasks."`.
- **Completion Trend (8 weeks)**: recharts `LineChart` inside
  `ResponsiveContainer height=200`. Colours come from `token('--primary')`,
  `token('--border-color')`, `token('--text-secondary')`, `token('--surface-light')`
  via `@/design-system`. `isAnimationActive={false}`.

Interactive elements: **none.** No click handler anywhere in this view. It cannot
open the drawer.

Data source: `useFilteredTasks()` + `useAssignableUsers({eligibleFor:'task'})`.
Loading/error: none rendered - `rawUsers` defaults to `[]`, and with an empty
task list `Math.max(...[] , 1)` yields `1`, so it renders zeros rather than a
skeleton.

Selectors: `data-testid="dashboard-insight-panel"`.

### 4.2 BoardView - **NOT a drag-and-drop kanban**

File: `pages/tasks/views/BoardView.tsx` (101 lines).

**Verified: BoardView contains no `draggable`, no `onDragStart/onDrop`, no
`dnd-kit`, no `react-beautiful-dnd`, and no HTML5 DnD of any kind.** It is a
static 5-column flex board. Status is changed through a `<SelectField>` rendered
under each card. Any assumption that the kit's dnd-kit `KanbanBoard` is a
drop-in replacement here is wrong: adopting it would **add** an interaction that
does not exist today, which is a behaviour change, not a presentation swap.

Tree:

```
div.flex.gap-4.overflow-x-auto
  for each of 5 columns (min-w-[260px])
    header: label + count pill
    cards:
      <TaskCard task riskResult /> (whole card click -> taskDetailStore.open(t.id))
      if column !== 'DONE':
        <SelectField value={t.status} onValueChange={updateStatus(t.id, v)} />
      empty column -> <p>Empty</p>
```

Columns, in order:
1. `AT_RISK` - label `"⚠ At Risk"`. Contains every non-DONE task whose
   `assessRisk(...).atRisk` is true. **These tasks are removed from their status
   column** (the partition is exclusive - see the `if/else` at lines 46-50).
2. `TODO` "To Do" · 3. `IN_PROGRESS` "In Progress" · 4. `BLOCKED` "Blocked" ·
   5. `DONE` "Done" (from `TASK_STATUSES`).

`ownerOpen` is a `Map<owner_id, non-DONE count>` built from the **filtered** task
list and fed into `assessRisk` as `ownerOpenCount`, so the filter bar changes
which tasks are judged at-risk.

Note the quirk: the `AT_RISK` column's `col.key !== 'DONE'` is true, so at-risk
cards do get a status select. Changing status calls
`updateStatus -> PATCH /api/tasks/:id`; the card re-partitions on the next render
because `assessRisk` re-runs.

Interactive elements: card click (opens drawer), status `SelectField` (PATCH).
No hover menu, no delete, no create.
Loading/error: none. Empty column -> `"Empty"`. Empty board -> five "Empty" columns.
Selectors: **none** - BoardView has no `data-testid` at all.

### 4.3 MyDayView

File: `pages/tasks/views/MyDayView.tsx` (120 lines). Root
`data-testid="my-day-surface"`.

Tree: header (`h2` "Your day, planned" + subtitle, right side `Plan my day`
button) -> `<SuggestedTasksPanel embedded />` -> ranked `<ol>` or empty state.

- **`Plan my day` / `Refresh plan` button** (`Button variant="outline" size="sm"`):
  increments a `nonce` (which is a dependency of the `rankMyDay` memo, forcing a
  recompute against a fresh `new Date()`), records `plannedAt = Date.now()`, and
  fires a toast `Your day has been planned · N task(s)` via
  `useToast()`. Label flips to `Refresh plan` once `plannedAt` is set, and a
  caption `Planned at H:MM · N items` appears beneath. **No network call.**
  Known nuance: the toast reads the *pre-recompute* `ranked.length` because
  `ranked` is captured from the current render.
- **`<SuggestedTasksPanel embedded />`** - see 5.5.
- **Ranked list**: `taskAI.rankMyDay(tasks, currentUserId, new Date())`, where
  `currentUserId = useAuthStore(s => s.user?.id) ?? ''`. Each `<li>` is
  click-to-open-drawer, showing rank ordinal, title, `<PriorityDot>` and a due
  chip (`Overdue · MMM d` in rose, or `Due · MMM d`, formatted `timeZone: 'UTC'`),
  or `"No due date"`.

Empty state: `"Nothing on your plate today."`.
Loading/error: none.
Selectors: `data-testid="my-day-surface"`, plus `suggested-tasks-panel` from the child.

### 4.4 ListView

File: `pages/tasks/views/ListView.tsx` (124 lines).

Tree: card wrapper -> `div[data-testid="tasks-list-toolbar"]` (bare `<input>`
search + `"N tasks"` counter) -> plain `<table>` (not TanStack Table, not the
shared DataTable).

Columns (fixed, no sorting, no resizing, no column menu, no pagination):
`Task # | Title | Owner | Status | Priority | Linked | Due | Created`.

- Local `query` state filters client-side over `title`, `owner_name ?? owner_id`,
  and `linked_entity?.label`, case-insensitive, on top of `useFilteredTasks()`.
- Row `onClick` -> `taskDetailStore.open(t.id)`; the whole `<tr>` is clickable,
  `cursor-pointer`, no keyboard affordance.
- Cells: `task_number` in `font-mono`; title `line-clamp-2`;
  `<StatusPill>`, `<PriorityDot>`, `<LinkedEntityChip>`; due date via
  `formatExactDate` in rose when `isOverdue`, dimmed `-` when null;
  created via `formatExactDate`.

Empty state: single row, `colSpan={8}`, `"No tasks match your search."`.
Loading/error: none.
Selectors: `data-testid="tasks-list-toolbar"`.

### 4.5 CalendarView - **this is where the drag-and-drop actually lives**

File: `pages/tasks/views/CalendarView.tsx` (585 lines). Root
`data-testid="tasks-calendar-card"`. **Hand-rolled calendar - no
`react-big-calendar`, no external calendar library.**

Toolbar: `‹` (aria-label "Previous period") · `Today` · `›` (aria-label "Next
period") · period label · a 3-way segmented control `Day | Week | Month`.
`view` and `anchor` are both local `useState`; default view is `month`,
default anchor `new Date()`. Navigation shifts the anchor by 1 day / 7 days /
1 month (with day clamping for short months).

Everything is computed in **UTC** (`getUTCFullYear/Month/Date`, `Date.UTC`,
`Intl.DateTimeFormat(..., { timeZone: 'UTC' })`). Preserve this exactly - it is
the reason a task due at 23:00 local can appear on the "next" day.

#### Drag-and-drop interaction model (native HTML5 DnD)

| Aspect | Value |
|---|---|
| Library | **none** - native HTML5 drag events |
| Draggable source | `TaskChip` (a `<button draggable>`), and the unscheduled-strip buttons in Month view |
| Payload | `e.dataTransfer.setData('task-id', task.id)`, `effectAllowed = 'move'` |
| Drop target | Month day cell (`onDragOver`/`onDragLeave`/`onDrop`, only when `day !== null`), Week day column (always) |
| Hover feedback | `dragOverDay` / `dragOverDayIdx` local state -> `ring-2 ring-inset ring-primary/40` |
| Drop effect | reads `task-id`, keeps the task's original `HH:MM` (`due_at.slice(11,16)`) or defaults to `'09:00'`, builds `new Date(\`${YYYY-MM-DD}T${HH:MM}:00Z\`)`, calls `updateTask(id, { due_at: iso })` -> `PATCH /api/tasks/:id` |
| Day view | **no drop target and no draggable chips** - read-only list |
| Keyboard path | **none** - there is no keyboard-accessible reschedule |
| Touch | native HTML5 DnD, so effectively desktop-only |

This is a genuine migration hazard: the kit's `KanbanBoard`
(`crm-ui-kit-complete_1/crm-ui-kit/src/components/crm/kanbanBoard/`) uses
`@dnd-kit`. Mixing dnd-kit chips with these native drop handlers will not work -
dnd-kit does not emit `dataTransfer`. If the calendar is rebuilt on dnd-kit it
must be rebuilt on **both** sides (draggable and droppable) together, and the
resulting `due_at` computation must reproduce the "keep original HH:MM, else
09:00, in UTC" rule byte for byte.

#### MonthView

7-column grid, `WEEKDAY_LABELS = Sun..Sat`, leading/trailing blank cells
(`bg-background-light opacity-40`, not drop targets). Today's cell gets
`bg-primary/5` and a filled `bg-primary text-white` day badge.
Max `MAX_PER_CELL = 3` chips per cell; overflow renders `＋N more` as **plain
text, not a button** - there is no "show all" affordance.
Chips sorted by `due_at` ascending. Chip click -> `open(t.id)`.
Below the grid, an **Unscheduled strip** appears when any filtered task has
`due_at === null`: `Unscheduled (N)` plus a wrap of draggable pill buttons
(click opens the drawer, drag schedules the task).

#### WeekView

Header row of 7 days (`Sun`..`Sat` + UTC date), body of 7 droppable columns,
`min-h-[200px]`. Chips render with `showTime` (`HH:MM` UTC, `font-mono`).
Empty column -> a dim `-`.

#### DayView

Header with the full UTC date, then a divided list of rows:
`HH:MM | status dot | title | owner_name ?? owner_id`. Row click -> drawer.
Empty -> `"No tasks due this day."`.

Status colour maps are **raw Tailwind palette classes** (`bg-gray-400`,
`bg-blue-500`, `bg-amber-500`, `bg-emerald-500` and the chip variants) - these
violate the CLAUDE.md token rule and are a token-porting task for the v2 build.

Selectors: `data-testid="tasks-calendar-card"`; `aria-label="Previous period"` /
`"Next period"`.

### 4.6 HistoryView (ADMIN + DISPATCHER only)

File: `pages/tasks/views/HistoryView.tsx` (111 lines).

Three sections:
1. `<KpiStrip>`: Open (`Circle`, neutral) / In Progress (`TrendingUp`, primary) /
   Blocked (`Ban`, amber) / Closed (`CheckCircle2`, emerald) from
   `computeHistory(...).snapshot`.
2. `<ChartCard title="Task flow — created vs closed">` -> recharts `BarChart`
   `height=260` with a `Legend`, two bars `Created` (`token('--primary')`) and
   `Closed` (`token('--success')`), `radius=[4,4,0,0]`, `isAnimationActive={false}`.
3. `"What's coming"` card -> three `UpcomingGroup`s (This week / Next week /
   Later), each a label + count pill and a `grid sm:2 lg:3` of `<TaskCard>`s.

Interactive elements: only the `TaskCard` click -> drawer (inherited).
Empty states: per-group `-`; all-empty -> `"Nothing scheduled ahead."`.
Selectors: **none.**

---

## 5. Shared task components

### 5.1 CreateTaskModal (`components/tasks/CreateTaskModal.tsx`, 261 lines)

Radix `Dialog`, `max-w-xl max-h-[90vh] overflow-y-auto`, title `"New Task"`.
Props: `{ open, onOpenChange, initialParse?: ParsedTask|null, presetEntity?: LinkedEntity|null }`.

Fields (all **local `useState` - there is NO react-hook-form and NO zod schema on
the client**):

| Field | Control | Notes |
|---|---|---|
| NL box | bare `<input>` + `Parse` button, Enter also parses | `taskAI.parse(text, {people, entities: [], now})` - **`entities` is always `[]`**, so NL never resolves a linked entity |
| Title `*` | bare `<input>` | required only via `disabled={!title.trim()}` on Create and an early `return` in `handleCreate` |
| Owner | `<AssigneeSelect eligibleFor="task" placeholder="— Unassigned —">` | |
| Watchers | `<MultiAssigneeSelect eligibleFor="task">` | omitted from the payload when empty |
| Due Date | `<DateTimePicker value={dueDatetimeLocal}>` | `datetime-local` string; converted `new Date(v).toISOString()` on submit (local -> UTC) |
| Priority | `<SelectField>` over `TASK_PRIORITIES` | default `MEDIUM` |
| Linked To | `<LinkedEntitySelect disabled={Boolean(presetEntity)}>` | |
| Description | `<textarea rows={3}>` | |

Submit (`handleCreate`) -> `tasksStore.addTask({... status:'TODO', tags: []})` ->
`POST /api/tasks`. On success: `resetForm()` + `onOpenChange(false)`.
On failure: destructive toast `"Failed to create task"` with
`extractApiError(err, 'Something went wrong. Please try again.')`.
Submitting state: Create button reads `Creating…` and both buttons disable.

**Validation actually enforced is server-side zod**
(`backend/src/controllers/task.controller.ts`):

```ts
createTaskSchema = z.object({
  title: z.string().min(1),
  description: z.string().optional(),
  status: z.enum(['TODO','IN_PROGRESS','BLOCKED','DONE']).optional(),
  priority: z.enum(['LOW','MEDIUM','HIGH','URGENT']).optional(),
  owner_id: z.string().uuid().nullable().optional(),
  due_at: z.string().datetime({ offset: true }).nullable().optional(),
  linked_entity_type: z.enum(['JOB','LEAD','CUSTOMER','ESTIMATE']).optional(),
  linked_entity_id: z.string().uuid().optional(),
  tags: z.array(z.string()).optional(),
  watcher_ids: z.array(z.string().uuid()).optional(),
  ai_source: z.enum(['MANUAL','AI_NL','AI_TEMPLATE','AI_EXTRACT']).optional(),
  ai_suggested_by: z.string().optional(),
}).refine(d => (d.linked_entity_type == null) === (d.linked_entity_id == null),
  { message: 'linked_entity_type and linked_entity_id must both be provided or both omitted',
    path: ['linked_entity_id'] });

updateTaskSchema = z.object({ title?, description?, status?, priority?,
  owner_id?, due_at?, tags?, watcher_ids? });   // same rules, all optional
commentSchema        = z.object({ body: z.string().min(1) });
subtaskCreateSchema  = z.object({ text: z.string().min(1) });
subtaskUpdateSchema  = z.object({ text: z.string().min(1).optional(), done: z.boolean().optional() });
```

### 5.2 TaskDetailDrawer (`components/tasks/TaskDetailDrawer.tsx`, 435 lines)

Radix `Sheet side="right"`, `w-[440px] sm:max-w-[440px]`, `p-0`, mounted once by
the hub and driven entirely by `taskDetailStore.openTaskId`. On every id change
it calls `fetchTaskDetail(id)` (`GET /api/tasks/:id`).

Sections and every control:

- **Header**: `task_number` (mono), `SheetTitle asChild` wrapping an editable
  `<input>` (`defaultValue`, `key={id+'-title'}`) - commits on **blur** if
  changed, Enter blurs. Then `<StatusPill>` `<PriorityDot>` `<RiskBadge>` and a
  **Nudge** button (`aria-label="Nudge assignee"`) -> `POST /api/tasks/:id/nudge`
  then re-fetch detail.
- **Quick actions**: Radix `Select` (`h-8 w-[160px]`) over `TASK_STATUSES` ->
  `updateStatus` -> `PATCH`. Label text `"Change status"`.
- **Details `<dl>`**: Owner (`AssigneeSelect` -> `updateTask({owner_id})`),
  Watchers (`MultiAssigneeSelect` -> `setWatchers` -> `PATCH` + re-fetch),
  Due (`<input type="datetime-local" step={900}>` -> `updateTask({due_at})`,
  with an `(overdue)` marker), Priority (`SelectField` -> `updateTask`),
  Linked (`LinkedEntityChip` or `-`), Tags (read-only pills or `-`),
  Created by (`created_by_name ?? created_by` + `formatExactDate(created_at)`),
  Completed (`formatExactDate(completed_at)` or `-`).
- **Description**: `<textarea defaultValue key={id+'-desc'}>` committing on blur.
- **Subtasks**: `N/M done` counter; each row a checkbox (`toggleSubtask`), the
  text (line-through when done) and a `×` button
  (`aria-label="Delete subtask"` -> `deleteSubtask`). Add row: `<input>` + a
  button `aria-label="Add subtask"` labelled `Add subtask`; Enter also adds.
  Empty: `"No subtasks."`.
- **Activity**: `task.activity` sorted newest-first, labels from
  `ACTIVITY_LABELS` (created / assigned / status_changed / priority_changed /
  due_changed / commented / nudged / completed). Empty (and no comments):
  `"No activity yet."`.
- **Comments** block (only when `comments.length > 0`) then a composer
  `<textarea>` + `Post` button (`Posting…` while in flight) ->
  `POST /api/tasks/:id/comments` then re-fetch detail.

Risk in the drawer is computed with `ownerOpenCount: 0` (hard-coded), so the
drawer's `RiskBadge` can disagree with the board's. Reproduce as is.

There is **no delete-task control in the UI** even though `deleteTask` /
`DELETE /api/tasks/:id` exist in the store and API.

Selectors: no `data-testid` of its own; specs key off roles/labels
(`/delete subtask/i`, `/add subtask/i`, `/^post$/i`, `/nudge/i`) and off the
mocked `assignee-select` / `multi-assignee-select` testids.

### 5.3 AiCommandBar (`components/tasks/AiCommandBar.tsx`, 77 lines)

`data-testid="tasks-ai-command"`. Sparkles avatar + a borderless `<input>`; a
`Go` button appears only when the input is non-empty. Enter or `Go` runs
`taskAI.parse(text, { people, entities: [], now })`; if `result.title` is
truthy it stores the parse and opens its **own** `CreateTaskModal` with
`initialParse`. The input is cleared either way. No network call, no toast on a
failed parse - silent no-op.

### 5.4 TaskFilterBar (`components/tasks/TaskFilterBar.tsx`, 103 lines)

Three Radix `Select`s (`h-9 w-44`): Member (`Everybody` + `useAssignableUsers`),
Department (`All departments` + `useDepartments`), Tag (`All tags` + the sorted
distinct union of `tags` across the **unfiltered** store list). A
`Clear filters` button renders only when any filter is off `'all'`, calling
`reset()`. Writes to `taskFilterStore`. No `data-testid`.

### 5.5 SuggestedTasksPanel (`components/tasks/SuggestedTasksPanel.tsx`, 105 lines)

`data-testid="suggested-tasks-panel"`. **Hard-coded demo data** -
`SEED_SUGGESTIONS` is three literal strings with `entity: null`; the subtitle
says so explicitly ("Demo - will read live calls, notes & inbox when comms wiring
lands"). `Accept` -> `addTask({title, linked_entity: item.entity ?? pageEntity})`
and removes the item; `Dismiss` removes it locally. State is `useState`, so a
remount restores all three. Empty: `"No more suggestions."`.

### 5.6 Presentational atoms

| Component | Behaviour | Palette |
|---|---|---|
| `StatusPill` | `Badge variant="outline"`, labels To Do / In Progress / Blocked / Done | raw `bg-gray-100`, `bg-blue-50`, `bg-amber-50`, `bg-emerald-50` |
| `PriorityDot` | dot + label Urgent/High/Medium/Low | raw `bg-rose-500`, `bg-amber-500`, `bg-blue-500`, `bg-gray-400` |
| `RiskBadge` | renders `⚠ At risk` **only when `result.atRisk`**, `title={reason}` | raw `amber-*` |
| `LinkedEntityChip` | `null` when no entity; type label + label truncated at 24 chars with `…`, `title` = full label | tokens |
| `TaskCard` | whole card click -> drawer; optional `onStatusChange` renders a Circle/CheckCircle2 quick-complete with `stopPropagation`; owner initials avatar or `Unassigned`; due line or `No due date`; `LinkedEntityChip` unless `hideLinkedEntity`; `RiskBadge` | mixed |

`TaskCard`'s `onStatusChange` prop is **not passed by any of the six views** -
the quick-complete toggle only appears where `JobLeadTasksTab` uses it.

---

## 6. Selector surface (carry every one of these into v2)

| Selector | Location |
|---|---|
| `tasks-workspace` | `TasksHubPage` root - asserted in `src/__tests__/tasks-quick-create.test.tsx:74` |
| `tasks-command-filter-panel` | hub, command+filter grid |
| `tasks-tab-rail` | hub, tab strip wrapper |
| `tasks-ai-command` | `AiCommandBar` |
| `dashboard-insight-panel` | `DashboardView` |
| `my-day-surface` | `MyDayView` root |
| `tasks-list-toolbar` | `ListView` toolbar |
| `tasks-calendar-card` | `CalendarView` root |
| `suggested-tasks-panel` | `SuggestedTasksPanel` - asserted in `src/__tests__/SuggestedTasksPanel.test.tsx:40` |
| `linked-entity-select-trigger`, `linked-entity-search-input`, `type-toggle-{JOB\|LEAD\|CUSTOMER\|ESTIMATE}`, `entity-option-{id}` | `LinkedEntitySelect` |
| `aria-label="Previous period"` / `"Next period"` | `CalendarView` toolbar |
| `aria-label="Nudge assignee"` / `"Delete subtask"` / `"Add subtask"` / `"Clear linked entity"` | drawer + select |
| `aria-label="Mark task done"` / `"Mark task as to-do"` | `TaskCard` quick-complete |

**BoardView and HistoryView carry no test ids at all.**

### Existing specs that constrain the module

Vitest, all under `frontend/src/__tests__/`:
`tasks-hub-hydrate.test.tsx` (mounts the hub, mocks `DashboardView` as
`data-testid="dashboard-view"`, asserts the store hydrates once),
`tasks-quick-create.test.tsx` (asserts `?action=new-task` opens the modal and the
URL is rewritten to `/tasks`, and that the sidebar `New` -> `New Task` menuitem
navigates to `/tasks?action=new-task`), `CreateTaskModal.test.tsx`,
`TaskDetailDrawer.test.tsx`, `SuggestedTasksPanel.test.tsx`,
`entity-tasks-tab.test.tsx`, `job-task-signals.test.tsx`, `taskAI.test.ts`,
`tasks-logic.test.ts`, `task-filter-history.test.ts`, `tasks-store-api.test.ts`.

`ls frontend/e2e/specs` matched nothing for `task` - **there is no Playwright
spec for this module.**

---

## 7. Loading / empty / error summary

There is **no loading UI anywhere in the Tasks module**. `tasksStore.loading`
exists but is never read by a component. No skeletons, no spinners.

There is **no error UI anywhere**. `fetchTasks` has a `try/finally` with no
`catch`, so a failed `GET /api/tasks` leaves the page permanently showing an
empty board with `loaded: false`. Only `CreateTaskModal` surfaces an error, and
only as a toast.

Empty states, verbatim:

| View | Text |
|---|---|
| BoardView column | `Empty` |
| DashboardView / Open by Assignee | `No open tasks.` |
| ListView | `No tasks match your search.` |
| MyDayView | `Nothing on your plate today.` |
| CalendarView / Day | `No tasks due this day.` |
| CalendarView / Week column | `—` |
| HistoryView / all upcoming | `Nothing scheduled ahead.` |
| HistoryView / one group | `—` |
| Drawer subtasks | `No subtasks.` |
| Drawer activity | `No activity yet.` |
| SuggestedTasksPanel | `No more suggestions.` |
| LinkedEntitySelect results | `No matches` |

---

## 8. Migration risks specific to this module

1. **The kit's dnd-kit `KanbanBoard` does not map onto BoardView.** BoardView has
   no DnD today. Dropping the kit board in adds an interaction and removes the
   per-card status `SelectField`. If the kit board is used, its `onDragEnd` must
   call `updateStatus(id, status)` and the At Risk lane must stay an exclusive
   partition (a task in At Risk is absent from its status column).
2. **The real DnD is in CalendarView and it is native HTML5.** dnd-kit and
   `dataTransfer` do not interoperate; migrating one half breaks reschedule.
3. **Active tab is component-local `useState`.** Any v2 refactor that lifts it to
   the URL is a behaviour change (Back button, deep links, reload) and needs
   sign-off.
4. **No TanStack Query here.** There are no query keys to invalidate; a builder
   who "modernises" the store to react-query is changing shared logic, which the
   plan forbids.
5. **All date maths is UTC.** `CalendarView`, `rankMyDay`'s day bucket and the
   MyDay due chip all use UTC. Any kit date component that formats in local time
   will silently shift tasks by a day.
6. **Raw Tailwind palette classes** in `CalendarView`, `StatusPill`,
   `PriorityDot`, `RiskBadge`, `ListView` (`text-rose-600`) and `MyDayView`
   (`border-rose-200 bg-rose-50 text-rose-700`) must become tokens in v2 per the
   CLAUDE.md boundary - visually identical, token-sourced.
7. **`SuggestedTasksPanel` is demo data.** Do not wire it to anything.
8. **`DashboardView` is entirely non-interactive.** Kit KPI/chart components must
   not introduce click-through, drill-down or row selection.

---

## 9. Open questions

1. **Should `/v2/tasks` be reachable as a landing page?** `HomeRoute` +
   `nav-registry` point at `/tasks`. Under the `VITE_UI_V2` flag the alias makes
   this moot, but on the parallel `/v2` path a SALES user redirected from `/`
   will land on the **old** page. Confirm that is acceptable.
2. `useAssignableUsers` and `useDepartments` query keys, `staleTime` and their
   loading/error surfaces were **not** opened (they live in `lib/api/users.ts`
   and `lib/api/departments.ts`). If the v2 pages need to show a loading state
   for the filter bar, read those first.
3. `KpiStrip`, `ChartCard` and `SelectField`/`AssigneeSelect`/
   `MultiAssigneeSelect`/`DateTimePicker` internals were not opened - they are
   shared components outside this module and are imported, not forked.
4. Radix `TabsContent` unmount-on-inactive is stated from the absence of a
   `forceMount` prop, not from reading `components/ui/tabs.tsx`. If a view must
   keep state across tab switches, verify.
5. `MyDayView`'s "Plan my day" toast reports the pre-recompute count. Is that a
   bug to preserve or to fix? The plan says preserve behaviour; flagging it so
   the choice is explicit.
6. There is no UI path to delete a task despite `deleteTask` existing. Confirm no
   v2 page should add one.
7. `assessRisk` is called with `ownerOpenCount: 0` in the drawer but with the
   real count in BoardView, so the same task can show At Risk in one place and
   not the other. Preserve or fix - needs a decision.
