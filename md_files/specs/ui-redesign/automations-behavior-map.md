# Automations / Workflows module - behaviour map

Phase 1 mapping artefact for the Automations module of
`md_files/plans/ui-redesign/UI_KIT_MIGRATION_PLAN.md`.
Documentation only. Every statement below was read from the files cited; anything
not verified is listed under "Open questions".

Mapped on 2026-08-04 in the worktree `alpha_crm-worktrees/ui-kit-00b-shell`.

> **Historical note, added 2026-08-27.** The `NOTIFY_TEAM` step type has since been retired from
> the authoring surface by
> `docs/adr/0005-the-bell-is-hardcoded-the-automation-center-owns-email-and-text.md`: the in-app
> bell is hardcoded, the Automation Center owns email and text, and no picker, gallery or config
> schema still offers that step. The refusal itself lives at publish, in `validateStep`. The draft
> write DTO is deliberately NOT one of those doors: it still spans the storage enum, so a workflow
> that already holds a legacy in-app step stays editable and duplicable - the builder re-sends
> every step it hydrated on each autosave, so a write tier that refused the label would block
> every save on that workflow rather than only its publish. The Postgres enum keeps the label so
> historic rows and frozen version JSON still resolve, which is why the rendering maps described
> below still carry it. Every mention of `NOTIFY_TEAM` here - in the `defaultConfig` list, the step-type
> table, the notify-step drawer section, `STEP_ACTION_LABEL` and `STEP_TYPE_META` - records what
> the module looked like on 2026-08-04 and is deliberately left unedited: this is a dated design
> record of the v2 redesign, not a live contract, and rewriting it would falsify a historical
> account. Read those sections as history, not as behaviour to rebuild.

**Notation:** the product copy in this module uses typographic em dashes and
curly quotes in many strings. This repo's output rule forbids emitting an em
dash, so where a verbatim UI string contains one it is written here as
`[emdash]`. When rebuilding, copy the literal character from the source file,
not from this document.

---

## 1. Routes and guards

All four paths live in one nested block in `frontend/src/App.tsx:186-204`.

| Item | Value | Source |
|---|---|---|
| Outer guard | `<ProtectedRoute allowedRoles={['ADMIN','SALES','DISPATCHER','TECHNICIAN']} />` then `<AppLayout />` | `App.tsx:149-150` |
| Module guard | `<ProtectedRoute allowedRoles={['ADMIN','DISPATCHER']} fallback />` | `App.tsx:188` |
| Feature gate | `<RequireFeature feature="automations" />` (nested INSIDE the role guard) | `App.tsx:189` |
| `/automations` | `<WorkflowsHome />`, `React.lazy` | `App.tsx:35, 190` |
| `/automations/new` | `<WorkflowBuilderPage />`, `React.lazy` | `App.tsx:36, 191` |
| `/automations/:id` | `<WorkflowBuilderPage />` (same component) | `App.tsx:192` |
| `/automations/:id/edit` | `<Navigate to=".." relative="path" replace />` | `App.tsx:200-203` |

### Guard semantics, verified

- `ProtectedRoute` (`frontend/src/components/ProtectedRoute.tsx`): while
  `isLoading` it renders a centred `Loading...` div; unauthenticated bounces to
  `/login`; a role miss with `fallback` renders `<NotAuthorizedPage />` **instead
  of** redirecting to `/`. So a SALES or TECHNICIAN user who deep-links to
  `/automations` sees the not-authorized page, not a silent bounce.
- `RequireFeature` (`frontend/src/components/RequireFeature.tsx`): calls
  `useFeature('automations')`; on false it `Navigate`s to
  `/upgrade?feature=automations&required_plan=PRO` with
  `state={{ from: location }}` and `replace`. The plan string comes from
  `catalogEntry('automations').minPlan`.
- Entitlement catalog: `frontend/src/lib/entitlements/catalog.ts:16` -
  `{ key: 'automations', label: 'Automations', minPlan: 'PRO' }`.
- **Ordering matters.** The role guard is the outer of the two, so a SALES user
  on a STARTER org sees NotAuthorized, not the upgrade page. Keep that nesting.
- `/automations/:id/edit` **must stay declared after** `/automations/:id`'s
  sibling routes in the same `RequireFeature` block, and `relative="path"` is
  load-bearing: every parent route is pathless (`AppLayout`, `ProtectedRoute`,
  `RequireFeature`), so with the default `relative="route"` a single `..`
  resolves to `/` rather than `/automations/:id`. The inline comment at
  `App.tsx:193-199` says exactly this.

### Nav entry

`frontend/src/components/layout/nav-registry.ts:93`:

```ts
{ key: 'automations', label: 'Automations', icon: Zap, href: '/automations',
  action: 'read', subject: 'Automation', home: 'Page', feature: 'automations' }
```

It sits in `DEFAULT_LAYOUT_KEYS` between `service-plans` and `pricebook`
(`nav-registry.ts:132`) and is registered as `LAYOUT_ADDITIONS` version 3
(`nav-registry.ts:145`), so existing saved sidebars get it appended on migration.
Sidebar visibility is CASL-filtered on `read Automation` plus the `automations`
feature key.

### CASL inside the module

**There is none.** Grepping `ability`, `useAbility`, `canOn` across
`pages/workflows/*.tsx`, `components/workflows/*.tsx` and
`components/workflows/trigger/*.tsx` returns zero non-test hits. Every
permission decision for this module is made by the two route guards and by the
server (`/api/workflows/*` 403s SALES/TECHNICIAN per the `App.tsx:186-187`
comment). No button in this module is permission-conditional.

---

## 2. WorkflowsHome (`/automations`)

File: `frontend/src/pages/workflows/WorkflowsHome.tsx` (385 lines).

### Composition, top to bottom

```
div.space-y-6
  Hero header
    Zap tile + <Heading level=1 scale="2xl" weight="bold">Automations</Heading> + subtitle
    <Button onClick={navigate('/automations/new')}>+ New automation</Button>
  Stat band            (3 KpiTiles, only when workflows exist)
  My automations       (only when workflows exist)
    <Heading level=2 scale="sm">My automations</Heading>
    <WorkflowRow> per workflow
  Templates gallery    (always rendered - "the front door")
    optional "Start from a recipe" header row + "Start from scratch" outline Button
    per CATEGORY_ORDER: section header + grid of <TemplateCard>
  <Dialog> delete confirmation
```

### Data

| Hook | Endpoint | Notes |
|---|---|---|
| `useWorkflows()` | `GET /api/workflows` | `isLoading` / `isError` / `refetch` all consumed |
| `useWorkflowCatalog()` | `GET /api/workflows/catalog` | `isLoading` / `isError` / `refetch` all consumed |
| `useCreateWorkflow()` | `POST /api/workflows` | used by both "Use this" and "Duplicate" |
| `useToggleWorkflow()` | `POST /api/workflows/:id/toggle` | one instance per `WorkflowRow` |
| `useDeleteWorkflow()` | `DELETE /api/workflows/:id` | instantiated inside `DeleteButton` |

Derived counters (`WorkflowsHome.tsx:59-62`):

```ts
hasWorkflows = Boolean(workflows && workflows.length > 0)
activeCount  = workflows.filter(w => w.status === 'PUBLISHED' &&  w.is_enabled).length
pausedCount  = workflows.filter(w => w.status === 'PUBLISHED' && !w.is_enabled).length
sentAllTime  = workflows.reduce((s, w) => s + w.trigger_count, 0)
```

Formatted through `new Intl.NumberFormat('en-US')`.

### Interactive elements

| Element | Type | Effect |
|---|---|---|
| `+ New automation` | `Button` (default variant) | `navigate('/automations/new')` |
| `Start from scratch` | `Button variant="outline" size="sm"` | `navigate('/automations/new')`; **renders only when `!hasWorkflows && !workflowsLoading && !workflowsError`** |
| `Use this` (per template) | `Button variant="solid" tone="business" size="sm"`, `disabled={createWorkflow.isPending}` | `createWorkflow.mutateAsync(templateToWorkflowBody(template))` then `navigate('/automations/${created.id}')` |
| Workflow row body | bare `<button>` wrapping `FlowTrail` + 3 text lines | `navigate('/automations/${workflow.id}')` |
| Row `Switch` | `@/components/ui/switch` | `toggle.mutate({ id, is_enabled: checked })`; `disabled={isDraft \|\| toggle.isPending}`; `aria-label` is `Pause {name}` when on, `Turn on {name}` when off |
| Draft row switch wrapper | `Tooltip` on a `<span tabIndex={0}>` | tooltip text `Publish first` (a disabled Switch swallows pointer events) |
| Row kebab | `DropdownMenu` on `Button variant="ghost" size="icon" className="h-11 w-11"`, `aria-label={`Actions for ${workflow.name}`}` | menu items below |
| Kebab > `Open` | `DropdownMenuItem` + `ExternalLink` icon | same as row click |
| Kebab > `Duplicate` | `DropdownMenuItem` + `Copy` icon | see duplicate rules below |
| Kebab > `Delete` | `DropdownMenuItem variant="destructive"` after a `DropdownMenuSeparator` | `setDeleteTarget(workflow)` -> opens the dialog |
| `Retry` (error banners) | `Button variant="outline" size="sm"` | `refetchWorkflows()` or `refetchCatalog()` |

**Duplicate rules** (`WorkflowsHome.tsx:69-81`): posts
`{ name: '${workflow.name} (copy)', trigger_type, trigger_config, steps: steps.map(({step_type, config}) => ...) }`
then navigates to the new id. `send_window` is **deliberately not copied** - the
inline comment explains that copying a legacy `BUSINESS_HOURS` row would mint a
new automation with a deferral rule no screen can show. Do not "fix" this.

### The delete dialog

Radix `Dialog`, `open={Boolean(deleteTarget)}`,
`onOpenChange={(open) => !open && setDeleteTarget(null)}`.

- Title: `Delete "{deleteTarget?.name}"?`
- Description: `Its activity history is removed too. This can't be undone.`
- Footer: `Cancel` (`Button variant="outline"`) and `<DeleteButton>`
  (`Button variant="solid" tone="danger"`, `disabled={!workflow || remove.isPending}`,
  Trash2 icon, label `Delete`). On success it calls `onDone()` which clears
  `deleteTarget`; the toast `Automation deleted` comes from `useDeleteWorkflow`.

There is **no typed confirmation** and **no second step** here.

### Template gallery filtering (a real gate, not cosmetic)

`WorkflowsHome.tsx:173-207`:

```ts
const smsAvailable = Boolean(catalog?.capabilities?.sms_available);
const group = (catalog?.templates ?? []).filter(
  (t) => t.category === category && !(!smsAvailable && t.action_type === 'SEND_SMS'),
);
if (group.length === 0) return null;
```

So texting templates are hidden per-org until that org can text, and a category
that ends up empty renders nothing at all (no empty section header). Categories
iterate `CATEGORY_ORDER = ['customer','money','team']` from
`components/workflows/workflow-visuals.tsx:124`.

### Loading / error / empty

| State | Rendering |
|---|---|
| `workflowsLoading` (stat band) | 3x `<Skeleton className="h-[76px] w-full" />` in a `grid-cols-3` |
| `workflowsLoading` (list) | 2x `<Skeleton className="h-[92px] w-full" />` |
| `workflowsError` | `<ErrorBanner message="Could not load your automations." onRetry={refetchWorkflows} />` |
| `catalogLoading` | 3x `<Skeleton className="h-[180px] w-full" />` in the responsive grid |
| `catalogError` | `<ErrorBanner message="Could not load the templates gallery." onRetry={refetchCatalog} />` |
| No workflows | Stat band and "My automations" are **both omitted entirely** (no zero-state card); the gallery gains a `Start from a recipe` + `Start from scratch` header row |
| Catalog loaded but every group empty | Nothing renders under the gallery heading - **there is no "no templates" empty state** |

`ErrorBanner` is a local component: `rounded-card border border-danger/20
bg-danger/5 px-4 py-3 text-sm text-danger` with the message on the left and a
`Retry` outline button on the right.

### Row content

`WorkflowRow` shows, in order: `<FlowTrail steps>` (trigger tile plus one tile
per step, decorative, `aria-hidden`), the recipe sentence from
`describeWorkflow(trigger_type, trigger_config, steps, catalog)`, the workflow
`name`, and a stats line `Ran N time(s)` plus, when `last_triggered_at` is set,
` [middot] last {formatDistanceToNow(..., {addSuffix:true})}`. Right side:
`<WorkflowStatusPill status is_enabled>`, the Switch, the kebab.

The row's click target carries **no `aria-label` on purpose** - the comment at
`WorkflowsHome.tsx:296-298` notes an aria-label would swallow the sentence/name/
stats text from screen readers. Preserve that.

---

## 3. WorkflowBuilderPage (`/automations/new` and `/automations/:id`)

File: `frontend/src/pages/workflows/WorkflowBuilderPage.tsx` (379 lines). One
component serves both routes; `useParams<{id: string}>()` distinguishes them.

### Draft state

All working state lives in `useWorkflowDraft()`
(`frontend/src/components/workflows/useWorkflowDraft.ts`, 270 lines) - a plain
`useState` hook with **no I/O, no timers, no react-query**.

`WorkflowDraftState`: `{ name, trigger_type, trigger_config, triggerConfigured,
steps: DraftStep[], selectedUid, dirty, revision, lastSavedAt, server }` where
`server: { id, status, is_enabled, has_unpublished_changes, issues }`.

- `DraftStep` = `{ uid, step_type, config }`. `uid` is
  `crypto.randomUUID()` (fallback `uid-${Date.now()}-${seq++}`) and is the
  React key **and** the dnd-kit sortable id. It is not the server id.
- **Position is array index everywhere.** `draftToInput` maps
  `steps.map(s => ({ step_type, config }))` and the server renumbers.
- `draftToInput` deliberately **omits `send_window`** (docblock lines 134-142).
- Blank draft defaults: `name: 'Untitled automation'`,
  `trigger_type: 'JOB_COMPLETED'`, `trigger_config: null`,
  `triggerConfigured: false`, `steps: []`, `server.status: 'DRAFT'`.
- `triggerConfigured: false` is the "placeholder trigger" flag - a request body
  needs a `trigger_type`, but nothing was chosen, so the UI must show a picker
  rather than describe `JOB_COMPLETED` as a real pick.
- `defaultConfig(type)`: `WAIT -> { duration_minutes: 1440 }`;
  `SEND_TEXT -> { recipient: 'customer', body: '' }`;
  `SEND_EMAIL -> { recipient: 'customer', subject: '', body: '' }`;
  `NOTIFY_TEAM -> { recipient: 'all_admins', body: '' }`;
  `STOP_IF -> { condition: '' }`.
- Selection changes (`selectStep`, `selectTrigger`, `clearSelection`) **never
  mark dirty**. Every other mutator does, and bumps `revision`.
- `issuesByStepIndex` is a `Map<number, ValidationIssue[]>` built from
  `state.server.issues`, dropping `step_index < 0`. **Validation verdicts are
  server-owned and never recomputed client-side.**

### Hydration

```ts
useEffect(() => {
  if (hydratedRef.current) return;
  if (id) { if (workflow) { hydrate(workflow); hydratedRef.current = true; } }
  else { hydratedRef.current = true; }
}, [id, workflow, hydrate]);
```

Hydration happens **exactly once per mount**. A later refetch of
`useWorkflow(id)` does not re-enter the draft. This is why `handlePublish` and
`handleToggle` both fold the mutation response back through `markSaved`.

### Autosave (the single most behaviourally sensitive part of this module)

`AUTOSAVE_DELAY_MS = 3000`.

| Mechanism | Detail |
|---|---|
| Debounce | `useEffect` on `[state.dirty, state.revision]`: when dirty, `setTimeout(flush, 3000)`, cleared on re-run |
| Unmount flush | `useEffect(() => () => void flushRef.current(), [])` - fires on TRUE unmount only |
| Blur flush | the header name `<input>`'s `onBlur` calls `flush()` directly |
| Ref indirection | `flush` is recreated every render (TanStack mutation results change identity), so both effects reach it through `flushRef`. Depending on `flush` directly would turn the unmount cleanup into a save-per-keystroke flood - the comment at lines 133-137 spells this out |
| Re-entrancy guard | `savingRef` blocks a concurrent flush; `stateRef` gives the timer the latest draft |
| Create-on-first-save | if `!s.server.id`, `create.mutateAsync(body)` then `navigate('/automations/${saved.id}', { replace: true })`. No reload, no lost edits |
| Otherwise | `patch.mutateAsync({ id, data: body })` |
| Post-save | `markSaved(rev, saved)` clears `dirty` **only if** `state.revision` is still `rev`; otherwise dirty stays true and the debounce effect re-arms |
| On failure | swallowed `catch {}` - the mutation hooks own the error toast; the draft stays dirty so the next edit retries |

### Header

```
<Link to="/automations">  ArrowLeft + "Automations"
header row (border-b)
  <input aria-label="Automation name" value={state.name} onChange={setName}
         onBlur={flush} maxLength={120} placeholder="Name this automation" />
  sentence line: describeWorkflow(...) or "Choose what starts this automation to get going."
  stamp:  "Saving[emdash]"  |  "Unsaved changes"  |  savedStamp(lastSavedAt)
  Test button  (or a disabled Test wrapped in a Tooltip)
  <PublishControl ... />
```

- `savedStamp(t)` returns `''` when `t == null`, `Saved just now` when the delta
  is under 45s, else `Saved ${formatDistanceToNow(t, { addSuffix: true })}`.
- `testDisabled = state.dirty || !state.server.id`. When disabled, the button is
  wrapped in `<span tabIndex={0}>` inside a `Tooltip` (`delayDuration={0}`)
  reading `Save your changes first`; the Button itself carries `disabled
  aria-disabled`. When enabled, it is a plain `Button variant="outline"` with a
  `FlaskConical` icon that sets `testOpen`.
- The name input is **not** RHF and has **no zod schema** - only `maxLength={120}`.

### Tabs

`Tabs value={tab} onValueChange={setTab}` with `useState('builder')`.
Triggers: `Builder`, `Activity`, `Settings`. **Tab state is component-local -
not in the URL, not persisted.** Reload always lands on Builder.

`TabsContent` panels are not `forceMount`ed, so Radix unmounts the inactive
ones (stated from the absence of the prop; `components/ui/tabs.tsx` was not
opened - see Open questions).

### Builder tab canvas

```
div.rounded-card.border.bg-background-light
  toolbar row: Sparkles + "Guided flow [emdash] drag a bubble to reorder, tap + to
               insert a step. Everything stays on the line."
               <Button variant="outline" size="sm">ListChecks + "Tidy up"</Button>
  <div key={tidyKey} className="animate-in fade-in-0 slide-in-from-top-1 ... duration-300">
    <BuilderSpine ... />
```

`Tidy up` (`handleTidyUp`) does three things and **no network call**:
increments `tidyKey` (which remounts the animated wrapper, replaying the
fade/slide-in), `window.scrollTo({ top: 0, behavior: 'smooth' })`, and toasts
`{ title: 'All tidy [sparkles emoji]', description: 'Your steps are lined up top to bottom.' }`.
It does **not** reorder anything.

### Drawer wiring

```ts
selectedStep = state.selectedUid && state.selectedUid !== 'trigger'
  ? state.steps.find(s => s.uid === state.selectedUid) : undefined
drawerMode = state.selectedUid === 'trigger' ? 'trigger' : selectedStep ? 'step' : null
<StepConfigDrawer open={drawerMode !== null} onOpenChange={(o) => !o && clearSelection()} ... />
```

`handleFixStep(stepIndex)` looks up `state.steps[stepIndex]` and calls
`selectStep(step.uid)`. Dry-run step indexes are index-aligned with the draft's
steps because both walk the saved order.

### Publish and toggle

```ts
handlePublish:  await flush();
                if (!s.server.id || s.server.issues.length > 0) return;
                published = await publish.mutateAsync({ id, enable: true });
                markSaved(stateRef.current.revision, published);
                toast({ title: 'Live [emdash] this automation is now running', description: published.name });
handleToggle:   updated = await toggle.mutateAsync({ id: wfId, is_enabled: enabled });
                markSaved(stateRef.current.revision, updated);
```

Both swallow errors (the hooks toast). `publish` always sends `enable: true`.

The `issues` prop passed down synthesizes a verdict for a never-saved empty
draft, because the server has not spoken yet:

```ts
!state.server.id && state.steps.length === 0
  ? [{ step_index: -1, path: 'steps', message: 'Add at least one step' }]
  : state.server.issues
```

`isPublishing = publish.isPending || isSaving`.

### Loading and hard-error states

| Condition | Rendering |
|---|---|
| `id && workflowLoading && !hydratedRef.current` | `<Skeleton className="h-8 w-40" />` + `<Skeleton className="h-[520px] w-full" />` |
| `id && !hydratedRef.current && (workflowError \|\| (!workflowLoading && !workflow))` | Full-page failure card: back link, `Couldn't load this automation`, `It may have been deleted, or the connection dropped. Nothing was changed.`, `Try again` (outline, `refetchWorkflow`) and `Back to Automations` (solid, `navigate('/automations')`) |

The failure card is a **correctness guard, not cosmetics**: the comment at
lines 220-221 states a real id that failed to load must never fall through to
the blank draft, because the first edit there would CREATE a duplicate workflow.
Any rebuild must keep this branch ahead of the normal return.

`/automations/new` never shows either state - `useWorkflow(undefined)` is
`enabled: false`, and `hydratedRef` latches immediately.

---

## 4. BuilderSpine and the nodes

### 4.1 BuilderSpine (`components/workflows/BuilderSpine.tsx`, 172 lines)

The vertical spine: a fixed `TriggerNode`, then a dnd-kit `SortableContext` of
`StepNode`s joined by a 2px rail with a circular `+` between every pair.

- Library: **`@dnd-kit/core` + `@dnd-kit/sortable`** (this is real dnd-kit, not
  native HTML5 DnD).
- Sensors: `PointerSensor` with `activationConstraint: { distance: 6 }`, and
  `KeyboardSensor` with `sortableKeyboardCoordinates`. Keyboard reordering
  works.
- `collisionDetection={closestCenter}`, `strategy={verticalListSortingStrategy}`.
- `handleDragEnd`: resolves `from`/`to` by `steps.findIndex(s => s.uid === ...)`
  and calls `onMoveStep(from, to)`; a drop on itself or outside is a no-op.
- Local `activeUid` / `overUid` drive `dropTarget` on the hovered node.
- The entire `DndContext` is rendered **only when `steps.length > 0`**.

Empty flow (`steps.length === 0`): a `RailLine` then
`<AddStepButton variant="first" onPick={(t) => onAddStep(t, 0)} />` which reads
`Add your first step`. Never a blank canvas.

Insert points, in order: a `Rail` with
`AddStepButton label="Insert a step at the top"` (inserts at index 0); between
each pair, a `Rail` with `label={`Insert a step after step ${i + 1}`}`
(inserts at `i + 1`); after the last node a `RailLine` then
`<AddStepButton variant="block" onPick={(t) => onAddStep(t)} label="Add a step" />`
(appends).

Footer, always: `[hairline] End of automation [hairline]`.

`lockedTypes = lockedStepTypesFor(catalog)` is threaded into every
`AddStepButton`.

### 4.2 TriggerNode (`components/workflows/TriggerNode.tsx`, 74 lines)

Fixed origin bubble, never sortable. Solid ocean gradient
(`bg-gradient-to-b from-primary to-primary-dark`), white content, a
`Starts here` cap pill, and a bottom port docking it to the rail.

- Title: `triggerConfigured ? describeWorkflow(triggerType, triggerConfig, [], catalog)
  : 'Choose what starts this automation'`.
- Description line: `catalog?.triggers[triggerType]?.description`, only when
  configured.
- The whole card is one `<button aria-label={`Edit trigger: ${title}`}>` calling
  `onSelect` (which opens the drawer in trigger mode).
- `selected` adds `ring-2 ring-on-fill ring-offset-2 ring-offset-primary-dark`.
- **This `aria-label` is a live selector** - `WorkflowBuilderPage.test.tsx` keys
  off `/Edit trigger/`, `/Edit trigger: Choose what starts this automation/` and
  `/Edit trigger: When a job is scheduled/`.

### 4.3 StepNode (`components/workflows/StepNode.tsx`, 232 lines)

One sortable bubble. `useSortable({ id: step.uid })`.

Three interactive zones:

1. **Drag handle** - `<button ref={setActivatorNodeRef} {...attributes} {...listeners}>`,
   `w-11` (44px), `aria-label={`Reorder step ${index + 1}: ${meta.label}`}`,
   `cursor-grab` / `active:cursor-grabbing`, `touch-none`.
2. **Card body** - `<button onClick={onSelect} aria-current={selected || undefined}>`
   showing `StepTypeTile`, the kicker (`Stop if` for STOP_IF else `meta.label`),
   and the `stepSentence(step, catalog)` segments (segments with `strong: true`
   render `font-extrabold`). When STOP_IF and configured, an extra line
   `[flag] If met, the flow ends here`.
3. **Kebab** - `DropdownMenu` on `Button variant="ghost" tone="subtle" size="icon"
   className="h-11 w-11"` with `aria-label={`Step ${index + 1} actions`}`:
   - `Move up` - `disabled={index === 0}` -> `onMoveStep(i, i - 1)`
   - `Move down` - `disabled={index === total - 1}` -> `onMoveStep(i, i + 1)`
   - separator
   - `Delete step` - `variant="destructive"`, **two-press confirm**: the first
     `onSelect` calls `e.preventDefault()` (keeping the menu open) and flips the
     label to `Really delete?`; the second actually deletes. Closing the menu
     resets `confirmingDelete` via `onOpenChange`.

Visual states: `selected` -> `ring-2 ring-primary`; `dropTarget && !isDragging`
-> a 3px `bg-primary` bar above the node; `isDragging` -> `z-20` plus
`rotate(2deg)` composed onto dnd-kit's transform; STOP_IF -> `border-warning/40`.

Issues: when `issues.length > 0` the node renders a `Needs setup` pill
(`AlertTriangle`, `bg-warning/10 text-warning`) **and** a `<ul>` of the server's
verbatim messages below the card. The comment at lines 41-46 is explicit that
the messages are shown verbatim because a bare badge is a dead end.

Top and bottom ports are 9px circles positioned outside the card.

### 4.4 AddStepButton (`components/workflows/AddStepButton.tsx`, 158 lines)

A `Popover` whose trigger is one of three raw button shapes
(`variant='rail' | 'block' | 'first'`), and whose content is a fixed 5-item
picker (`role="menu" aria-label="Add a step"`, `w-[300px] p-0`):

| Type | Label | Description |
|---|---|---|
| `WAIT` | Wait | Pause before the next step |
| `SEND_TEXT` | Send text | Text the customer |
| `SEND_EMAIL` | Send email | Branded email to the customer |
| `NOTIFY_TEAM` | Notify team | In-app alert to your staff |
| `STOP_IF` | Stop if[emdash] | End the flow when a condition is met |

Header strip: `Add a step [emdash] pick one`.

**Locked rows** (`lockedTypes.includes(item.type)`): rendered as a
`<div role="menuitem" aria-disabled="true" tabIndex={0}>` with `opacity-60
cursor-not-allowed`, a `Lock` badge reading `Not connected`
(`SMS_LOCKED_BADGE`), and a `Tooltip side="right"` reading
`Connect a phone number in Communication settings to text customers from an
automation.` (`SMS_LOCKED_TOOLTIP`). A locked row is present but un-pickable -
the product shape stays visible.

`lockedStepTypesFor(catalog)` (`lib/workflows/featureFlags.ts`) returns `[]` when
`catalog.capabilities.sms_available` is true, else `['SEND_TEXT']`.
`DEFAULT_LOCKED_STEP_TYPES = ['SEND_TEXT']` is the prop default, so an
undefined or stale catalog **fails closed**.

Picking calls `setOpen(false)` then `onPick(type)`; `addStep` then sets
`selectedUid` to the new uid, which opens the config drawer immediately.

---

## 5. StepConfigDrawer and the step forms

### 5.1 StepConfigDrawer (`components/workflows/StepConfigDrawer.tsx`, 159 lines)

Radix `Sheet` (right side by default), `SheetContent` is
`flex h-full w-full flex-col gap-0 p-0 sm:max-w-[440px]`.

Header: `StepTypeTile size="lg"`, a kicker (`Trigger` or `STEP_TYPE_META[type].label`)
and a truncated `SheetTitle`:

- trigger mode: `triggerConfigured ? describeWorkflow(...) : 'Choose what starts this automation'`
- step mode: `sentence.configured ? sentenceText(sentence) : `Set up this ${meta.label.toLowerCase()} step``
- fallback `Set this up`

`SheetDescription` is `sr-only`: `Configure this {trigger|step}.`

Body is a `switch` on `step.step_type`, each form keyed `key={step.uid}` so
switching steps remounts the form (this is how a form's local seed state is
reset). The `WAIT` case additionally resolves the anchor:

```ts
const entity = catalog?.triggers[triggerType]?.entity;
const anchor = entity ? catalog?.anchors[entity]?.[0] ?? null : null;
```

Footer: on the left, in step mode only, a two-press `Remove step`
(`Button variant="ghost" tone="danger"`) that flips to `Really remove?` then
calls `onRemoveStep(step.uid)` and closes; on the right always `Done`
(`Button`, closes). Closing resets `confirmRemove`.

**The drawer holds no draft of its own** - every form calls
`onUpdateStepConfig(uid, config)` or `onSetTrigger(type, config)` on each edit,
and the page's autosave persists it.

### 5.2 TriggerForm (`components/workflows/TriggerForm.tsx`, 350 lines)

The trigger drawer body. **No RHF, no zod** - it holds a `LocalSelection`
(`{ subject, mode, eventTrigger?, anchor?, direction?, offsetMinutes? }`, both
`subject` and `mode` nullable) and converts through `lib/workflows/triggerModel.ts`.

Seeding: a one-shot `useEffect` gated on `seededRef` and `catalog` (a lazy
`useState` initializer would freeze at "blank" if the catalog was still loading
on first render). It skips seeding entirely when `triggerConfigured` is false,
but still latches `seededRef` so a later real pick is never second-guessed.

`commit(next)` sets local state, narrows via `toTriggerSelection`, converts via
`selectionToTrigger(sel)` and, **only if that returns a value**, calls
`onSetTrigger(trig.trigger_type, trig.trigger_config)`. An incomplete selection
never reaches the draft.

Stage machine:

| Local state | Renders |
|---|---|
| `subject === null` | `Step 1 of 3 [emdash] choose a subject` caption + `<SubjectPicker>` |
| `subject` set, `mode === null` | subject `CrumbChip` + `<ModeFork>` |
| both set, `mode === 'event'` | both crumbs + `<EventModePanel>` (+ `<TriggerReadback>` when a selection exists) |
| both set, `mode === 'date'` | both crumbs + `<DateModePanel>` (+ `<TriggerReadback>`) |

`CrumbChip`s: subject chip has a trailing `X` and `aria-label={`${label} [emdash] change subject`}`
calling `resetSubject()` (full `BLANK`); mode chip has a trailing `ChevronDown`
and `aria-label={`${label} [emdash] change mode`}` calling `resetMode()` (clears mode only).
`WorkflowBuilderPage.test.tsx` queries `/Jobs [emdash] change subject/`.

Mode-specific fields are **never cleared on a mode toggle** - only `pickSubject`
starts a fresh object, so switching event -> date -> event loses no work.
`pickMode('date')` seeds `anchor: local.anchor ?? anchorFor(subject)?.key`.

`pickSubject(subject, presetTrigger?)` only treats a preset as a complete event
pick when `catalog.triggers[presetTrigger].category === 'events'`; a `timed` or
`date` hit lands on the subject and falls through to the mode picker.

Two banners, independently rendered above the stages:

1. **Legacy trigger** - `triggerConfigured && triggerToSelection(...) === null`.
   Info-toned (`bg-primary-subtle`), names the current trigger from the catalog:
   `This automation currently uses an older timing setup [emdash] {label}. Pick a new
   starting point below to replace it, or close this panel to leave it as-is.`
   Recomputed every render so it disappears the moment a new pick lands. This is
   reachable for the four pre-Part-A timed triggers (`BEFORE_JOB_START`,
   `AFTER_JOB_COMPLETED`, `INVOICE_OVERDUE`, `ESTIMATE_FOLLOW_UP`).
2. **Steps exist** - `stepCount > 0`. Warning-toned (`bg-warning/10`):
   `Changing the trigger can make steps invalid [emdash] we'll flag anything that needs attention.`

Loading: when `!catalog`, the whole form is three `Skeleton`s
(`h-4 w-2/3`, `h-24 w-full`, `h-10 w-full`).

`allowAfter={subject !== 'estimate'}` is passed to `DateModePanel` - "N after
the estimate expiration" can never fire, so it is not offered (issue #867).

### 5.3 trigger/SubjectPicker (`components/workflows/trigger/SubjectPicker.tsx`, 173 lines)

Heading `What is this automation about?`, sub `Pick a subject [emdash] then you'll
never scroll through a giant list.`

- A search `Input` (`aria-label="Search all triggers"`, placeholder
  `Search all triggers[emdash] try "paid", "reminder", "completed"`) with a decorative
  `Search` icon.
- **Empty query** -> a `grid-cols-2` of four subject tiles in `ENTITY_ORDER`
  (`job, estimate, invoice, lead` from `lib/workflows/entities.ts`), labelled
  `Jobs` / `Estimates` / `Invoices` / `Leads & Walkthroughs`, each with a count
  of that subject's `category === 'events'` triggers rendered `N event(s)`, and
  a trailing chevron. Click -> `onPick(subject)` with no preset.
- **Non-empty query** -> `role="listbox" aria-label="Matching triggers"` of at
  most `MAX_RESULTS = 7` hits. The haystack is
  `` `${def.label} ${def.description} ${SUBJECT_META[subject].label}` `` lowercased;
  results are grouped by `ENTITY_ORDER` for stability. **The search has no
  category filter**, so a `timed` or `date` trigger can surface - which is why
  `TriggerForm.pickSubject` re-checks the category. Clicking a hit clears the
  query and calls `onPick(hit.def.entity, hit.key)`.
- No matches -> `<EmptyState density="compact" title="No matches. Try
  "completed", "paid", "reminder", "before"." />`.

Note the deliberate label divergence: this tile says `Leads & Walkthroughs`
while `TriggerForm`'s breadcrumb says `Leads`. Both docblocks say this is
intentional.

### 5.4 trigger/ModeFork (`components/workflows/trigger/ModeFork.tsx`, 117 lines)

Heading `How should it start?`, sub `Two different jobs [emdash] pick the one that
matches what you have in mind.` Two card-shaped `<button aria-pressed>`s:

- `Right after something happens` - `React the moment {a job|an estimate|an
  invoice|a lead} event occurs. You can add a short wait after.`
- `Before or after a date` - `Count from a date you know ahead of time [emdash]
  {anchorLabel} [emdash] and act a set time before or after it.`
  When `anchorLabel === null` the card is `disabled`, `opacity-[.55]`,
  `cursor-not-allowed`, and its body becomes
  `This subject has no scheduled date to count from.` The docblock states this
  lock state is **unreachable today** (every subject has an anchor as of Part A)
  and is kept only because the prop is typed nullable.

Selected state is `border-primary ring-[3px] ring-primary-subtle`. Note that
`TriggerForm` always passes `value={null}`, so the selected ring never actually
shows in the app - the fork is replaced by the panel as soon as a mode is picked.

### 5.5 trigger/EventModePanel (`components/workflows/trigger/EventModePanel.tsx`, 102 lines)

Heading `When this happens[emdash]`, sub `The automation fires the moment this occurs.`
`role="radiogroup" aria-label="When this happens[emdash]"` over
`catalog.triggers` filtered to `def.entity === subject && def.category === 'events'`.
Each option is `<button role="radio" aria-checked>` with a custom dot indicator,
`def.label` and `def.description` **read verbatim from the catalog** (never
hardcoded). `timed` and `date` triggers are excluded by contract.

There is no empty state - if a subject had zero event triggers the list would
render nothing (not observed in the real catalog).

### 5.6 trigger/DateModePanel (`components/workflows/trigger/DateModePanel.tsx`, 286 lines)

Heading `How far from {anchorLabel}?`, sub `Tap a common timing, or set your own.
Counts from {anchorLabel}.`

Presets (verbatim, `aria-pressed` chips):

| key | label | minutes | direction |
|---|---|---|---|
| `1d_before` | 1 day before | 1440 | before |
| `2h_before` | 2 hours before | 120 | before |
| `1d_after` | 1 day after | 1440 | after |
| `3d_after` | 3 days after | 4320 | after |

Plus a dashed `Custom[emdash]` chip. With `allowAfter={false}` the two `after`
presets drop out **and** the direction toggle is removed entirely (not shown
locked), forcing `before`.

Custom row (revealed by the chip): `Input type="number" min={0}
aria-label="Timing amount"`, a `Select aria-label="Timing unit"` over
minutes/hours/days/**weeks**, an optional `Before|After` segmented control,
then the anchor label and a period.

- `CUSTOM_UNIT_MINUTES` extends the shared `UNIT_MINUTES` with
  `weeks: UNIT_MINUTES.days * 7`; the shared `OffsetUnit` has no `weeks`, so
  `splitOffset` never produces "weeks" on the reverse path (a stored 2-week
  value reopens as "14 days" - numerically identical, documented as not a bug).
- `commitCustom` **refuses to emit** when the text is blank, non-finite,
  negative, or when `n * unitMinutes` is not an integer. Same "never propagate a
  value the server would 400 on" guard as `TriggerForm` and `WaitForm`.
- `customOpen` and the custom fields are seeded **once** from `value` via
  `useState` initializers and thereafter only through this component's own
  handlers. The four preset chips' active state, by contrast, is fully reactive.
- Deliberate design constraint recorded in the docblock: there is **no** "on the
  day" / "morning of" / day-part option anywhere, and the product owner
  explicitly rejected the concept. Do not add one during a rebuild.

### 5.7 trigger/TriggerReadback (`components/workflows/trigger/TriggerReadback.tsx`, 201 lines)

The live summary card under the trigger builder. `bg-background-light`,
kicker `[clock] This automation will[emdash]`, then a `<p role="status">` (a live
region, and the single stable node tests read `.textContent` from).

Sentence assembly:

- event mode with a resolved trigger:
  `The moment {articleizeEventLabel(def.label)}, ` + `send the customer an ` +
  `email` + `.`
- event mode without one: `Pick the event that starts it.`
- date mode, complete: `dateLeadPhrase(direction, offsetMinutes, anchorLabel)` + the
  same tail. `dateLeadPhrase`: `value === 0` -> `Just before {anchor}, ` /
  `Right after {anchor}, `; `value === 1 && unit === 'days'` ->
  `The day before|after {anchor}, `; otherwise `{pluralizeUnit} before|after
  {anchor}, ` where the unit word is singularized only at N === 1.
- date mode, incomplete: `Choose a timing to complete this.`

`articleizeEventLabel` picks `an` when the first word starts with a vowel
(`Invoice is paid` -> `an invoice is paid`).

**Rule-one note** - rendered only for `direction === 'before'`, carrying the one
`data-testid` in the whole module:

```
data-testid="trigger-readback-note"
"If {anchor} is **still coming up** but it's too late for the full head start, we
 send right away. If {anchor} has **already passed**, we skip it [emdash] no reminder
 for something that's over."
```

The sentence used to end with the hardcoded tail `send the customer an email.`
regardless of the workflow's actual first step. That tail is GONE: the sentence
now describes the trigger and nothing else, and the eyebrow reads
`This automation starts...` rather than `This automation will...`. It named an
audience some triggers cannot reach at all (a task's audiences are staff only)
and asserted an email on a draft that may have no steps, or whose first step is
a text. The "what happens" half belongs to the step bubbles.

### 5.8 WaitForm (`components/workflows/WaitForm.tsx`, 371 lines)

Two modes; the mode toggle (`Wait a set time` | `Before / after {anchor.label}`)
renders **only when an `anchor` prop was resolved**. Initial mode is `anchored`
when `anchor && config.mode === 'anchored'`, else `relative`.

**Relative sub-form** - RHF + `zodResolver(relativeFieldsSchema)` where
`relativeFieldsSchema = waitRelativeConfigSchema.omit({ mode: true })`,
`mode: 'onChange'`, `defaultValues: { duration_minutes: startMinutes }` with
`startMinutes = config.duration_minutes` when finite and > 0, else `1440`.

Presets: `1 hour` 60, `4 hours` 240, `1 day` 1440, `3 days` 4320, `1 week` 10080,
plus `Custom`. Custom reveals `Input type="number" min={1} aria-label="Wait amount"`
and `Select aria-label="Wait unit"` over minutes/hours/days. Every write calls
`setValue(..., { shouldDirty: true, shouldValidate: true })` **and**
`onChange({ duration_minutes: minutes })` - **including an invalid `NaN`**, which
is what makes the inline error appear. Readback:
`Wait **{formatOffset(duration)}** before the next step.`, replaced by the RHF
error message when `formState.errors.duration_minutes` is set.

**Anchored sub-form** - not RHF. Local `aDirection` / `aOffset` / `aCustom` /
`aValue` / `aUnit`. `emitAnchored` builds
`{ mode: 'anchored', anchor: anchor.key, direction, offset_minutes }` and only
calls `onChange` when `waitAnchoredConfigSchema.safeParse(candidate).success` -
so an invalid anchored value is **never** pushed to the draft (a bad value would
400 every autosave). Same preset row plus `Before` / `After` toggles
(`aria-pressed`), custom fields `aria-label="Timing amount"` /
`aria-label="Timing unit"`, `min={0}`. Invalid state shows
`Set the timing [emdash] whole minutes, 0 up to the 90-day limit.`; valid shows
`Wait until **{formatOffset} {direction} {anchor.label}**, then continue.`

Switching modes re-emits the config for the mode being entered.

### 5.9 SendTextForm (`components/workflows/SendTextForm.tsx`, 90 lines)

Exports the shared `StepFormProps` interface
(`{ config, triggerType, catalog, onChange }`) used by the other messaging forms.

- Recipient is **fixed**: a static `Send to` label plus a `Customer` pill. Not a
  control. The emitted config always carries `recipient: 'customer'`.
- RHF + `zodResolver(sendTextConfigSchema)`, `mode: 'onChange'`,
  `defaultValues: { recipient: 'customer', body: String(config.body ?? '') }`.
- `SMS_LIMIT = 320`. A live `N / 320` meter: `text-text-secondary` normally,
  `text-warning` above 300, `text-danger` above 320.
- `Textarea id="text-body"` `min-h-28`, placeholder
  `Hi {{customer.first_name}}, a reminder from {{org.name}}[emdash]`.
  Both `onChange` and `onBlur` re-push
  `{ recipient: 'customer', body: getValues('body') }`.
- `<MergeFieldChips>` below.
- Standing honesty note (`bg-warning/10`): `Texts are saved to the customer's
  conversation now and will send automatically once the phone system is connected.`

### 5.10 SendEmailForm (`components/workflows/SendEmailForm.tsx`, 158 lines)

Split ownership: **recipients are NOT in RHF**. A local
`emailContentSchema = z.object({ subject: min(1,'Add a subject line').max(200,
'Subject is too long (200 characters max)'), body: min(1,'Write the email')
.max(5000,'Email is too long (5,000 characters max)') })` covers only the copy;
`recipients` / `userIds` / `customEmails` are `useState`, seeded once from
`normalizeRecipientFields(config)` (a `useMemo` with `[]` deps and an eslint
disable).

`push(overrides?)` assembles the emitted config:

```ts
{ recipients, subject, body }
  + recipient: toLegacySingularRecipient(recipients)   // only when exactly 1
  + user_ids     when userIds.length > 0
  + custom_emails when customEmails.length > 0
```

The `overrides` parameter exists because reading state right after `setState` in
the same tick would push the stale snapshot.

Fields: `RecipientMultiSelect` under a `Send to` label,
`Input id="email-subject"` (placeholder `Your appointment with {{org.name}}`),
`Textarea id="email-body"` `min-h-32` (placeholder `Hi {{customer.first_name}}, [emdash]`),
then `MergeFieldChips`. `used` is the union of `mergeFieldsIn(subject)` and
`mergeFieldsIn(body)`. Options come from
`catalog?.audiences?.[triggerType]?.SEND_EMAIL ?? []`.

### 5.11 NotifyTeamForm (`components/workflows/NotifyTeamForm.tsx`, 121 lines)

Same shape as SendEmailForm minus subject and custom emails. Local
`notifyContentSchema` covers only `body` (`min(1,'Write the message')`,
`max(5000,'Message is too long (5,000 characters max)')`). Label is `Notify`
rather than `Send to`. `customEmails` is hardcoded `[]` and
`onCustomEmailsChange` is a documented no-op (the catalog never offers `custom`
for `NOTIFY_TEAM`). Options from `catalog?.audiences?.[triggerType]?.NOTIFY_TEAM ?? []`.
Placeholder: `New lead: {{lead.name}} [emdash] reach out while it's hot.`

### 5.12 StopIfForm (`components/workflows/StopIfForm.tsx`, 87 lines)

RHF + `zodResolver(stopIfConfigSchema)` (`{ condition: z.string().min(1,'Pick a
condition') }.strict()`), `mode: 'onChange'`.

- `entity = catalog?.triggers[triggerType]?.entity`;
  `conditions = catalog?.stop_if.conditions[entity] ?? []`;
  labels from `catalog.stop_if.labels`, falling back to
  `c.replace(/_/g, ' ')`.
- **`conditions.length === 0`** (lead triggers today) replaces the whole form
  with a warning card: `Stop conditions aren't available for this trigger` /
  `This trigger has nothing to check against, so a Stop-if step will never do
  anything here. Remove it to keep the flow clean.`
- Otherwise: `Label` `Stop this automation if[emdash]` and a `Select id="stop-condition"
  aria-label="Stop condition"` with placeholder `Pick a condition`. **Always
  controlled** - the empty string keeps Radix in controlled mode so the first
  selection does not trip React's uncontrolled-to-controlled warning.
- Footnote: `The flow checks this right before each following step [emdash] if it's
  true, the automation ends here.`

Note: this form does not render an inline error for the empty condition - the
`Needs setup` badge on the node is the feedback.

### 5.13 RecipientMultiSelect (`components/workflows/RecipientMultiSelect.tsx`, 255 lines)

Fully controlled. One `Checkbox` row per `AudienceOption` served by the catalog
(the component does **no filtering of its own** - channel and entity narrowing
are server-side). Each option's optional `hint` renders as helper text under its
row.

`toggle(key)` also clears the revealed sub-picker's value when its audience is
unticked (`specific_user` -> `onUserIdsChange([])`, `custom` -> `onCustomEmailsChange([])`),
so an invisible orphaned value can never be saved.

Two reveals:

- **`specific_user`** -> `SpecificUserField`: `useAssignableUsers()` (no options
  object, so query key `['users','assignable',null,null,null]`,
  `GET /api/users?assignable=true`), rendered as a bordered checkbox list of
  `${first_name} ${last_name}`, each `aria-label`ed with the full name. Empty
  selection shows `Pick at least one team member`.
- **`custom`** (SEND_EMAIL only) -> `CustomEmailsField`: chip-style multi-email
  input, `Input type="email" aria-label="Custom email address"`, placeholder
  `Add email and press Enter`. Commit paths: `Enter`, `Tab`, a trailing comma
  typed into the field, or `blur`. `Backspace` on an empty input removes the
  last chip. Validation is `EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/` with two
  messages: `Enter a valid email address` and `That address is already added`.
  Each chip has an `X` button `aria-label={`Remove ${email}`}`. Empty shows
  `Enter at least one email address`.

Zero recipients shows `Pick at least one recipient` in danger text (the parent
still emits the empty array; the block is server-side).

`normalizeRecipientFields(config)` folds legacy shapes: `recipients[]` if
present, else `[config.recipient]`; `user_ids[]` else `[user_id]`;
`custom_emails[]` else `[custom_email]`. `foldLegacyAudienceKey` maps the
pre-v2.1 `assigned_techs` to the canonical `assigned_team`.
`toLegacySingularRecipient` mirrors a single recipient back onto `recipient`
(reversing the alias) purely so `stepSentence` / `describeWorkflow`, which still
read `config.recipient`, keep rendering a specific sentence.

### 5.14 MergeFieldChips (`components/workflows/MergeFieldChips.tsx`, 161 lines)

Tap-to-insert `{{field}}` chips, grouped into collapsible per-entity sections.

- `FIELD_GROUPS` maps prefixes to labels: `org.` Company, `customer.` Customer,
  `recipient.` Recipient, `job.` Job, `technician.` Job, `estimate.` Estimate,
  `invoice.` Invoice, `lead.` `Lead & walkthrough`. Anything unmatched lands in
  a trailing `Other` group rather than vanishing.
- `defaultOpenGroup`: the first non-base group containing an already-used field,
  else the first non-base group, else the first group.
  `BASE_GROUP_LABELS = {Company, Customer, Recipient}` never start expanded.
  Open state is `useState<Set<string>>` seeded once.
- Section header is `<button aria-expanded aria-label={`${label} (${count})`}>`
  with a chevron and a right-aligned count.
- Each chip is `<button aria-pressed={isUsed} title={`{{${field}}}`}>` labelled
  from `catalog.merge_field_labels[field] ?? field`, with a `Check` icon and
  filled styling when in use, `Plus` otherwise.
- Returns `null` when `fields.length === 0`. Header text: `Insert a field`.

### 5.15 useMergeInsert (`components/workflows/useMergeInsert.ts`, 69 lines)

Caret-aware insertion. `bind(name, rhfRef)` returns a composed `ref` (capturing
the live DOM node alongside RHF's ref) plus an `onFocus` that records
`lastFocused`. `insert(field)` reads the live node (never a possibly-stale RHF
value), splices `{{field}}` at `selectionStart..selectionEnd`, calls
`apply(name, next)`, then restores focus and caret in a `requestAnimationFrame`.
Falls back to `primaryName` (always `'body'` here) when nothing was focused yet.

This is why the SendEmailForm chip row inserts into whichever of subject/body
was focused last. Any rebuild that swaps the Input/Textarea primitives must keep
forwarding refs, or insertion silently no-ops (`if (!el) return`).

---

## 6. PublishControl, TestWorkflowDialog, Activity, Settings

### 6.1 PublishControl (`components/workflows/PublishControl.tsx`, 126 lines)

Purely prop-driven; the page owns the mutations and toasts.
`isDraft = status !== 'PUBLISHED'`, `hasIssues = issues.length > 0`,
`pending = hasUnpublishedChanges || dirty`.

| State | Renders |
|---|---|
| DRAFT, no issues | `Publish` (`Button variant="solid" tone="business"`, Rocket icon, `disabled={isPublishing}`) |
| DRAFT, issues | The same button `disabled aria-disabled`, wrapped in `<span tabIndex={0} aria-label={reason}>` inside a `Tooltip delayDuration={0}` showing `reason` |
| PUBLISHED, not pending | `<LivePill pending={false}>` = `Live [middot] up to date` (CheckCircle2, success) + the `Switch` |
| PUBLISHED, pending, no issues | `<LivePill pending>` = `Live [middot] editing draft` (PencilLine, primary) + `Switch` + `Publish changes` |
| PUBLISHED, pending, issues | same, but `Publish changes` disabled inside the tooltip wrapper |

`blockedReason(issues)` (exported, unit-testable): counts **distinct**
`step_index >= 0` values and returns `Fix N step(s) that need(s) setup`; with no
step-level issues it falls back to `issues[0].message`, then to
`This automation isn't ready to publish`.

The `Switch` is `aria-label`ed `Pause this automation` / `Turn this automation on`
and `disabled={isToggling}`.

The disabled-button-inside-a-focusable-span idiom appears in three places in
this module (here twice, the Home draft switch, and the builder's Test button)
because a disabled button swallows pointer events and would kill the tooltip.

### 6.2 TestWorkflowDialog (`components/workflows/TestWorkflowDialog.tsx`, 192 lines)

Radix `Dialog`, `max-h-[90vh] max-w-2xl overflow-y-auto`.
Title `[flask] Test this automation`, description
`Nothing is sent to customers [emdash] this is a safe dry run.`

- On open (`useEffect` on `[open, workflowId]` with a `firedRef` latch) it fires
  `test.mutate({ id, send_to_me: false })` once. On close it resets `firedRef`
  and calls `test.reset()`, so every open is a fresh run.
- Body: `loading = test.isPending && steps.length === 0` -> two
  `Skeleton h-16`; `steps.length === 0` -> `Add a step to try this automation.`;
  otherwise one `DryRunStepRow` per step.
- Footer: `Close` (`Button variant="outline"`) and `Send a test to me`
  (`Button variant="solid" tone="business"`,
  `disabled={test.isPending || steps.length === 0}`), which re-runs the same
  mutation with `send_to_me: true` and toasts
  `{ title: 'Test sent', description: 'Test sent to your email + notifications' }`.

`DryRunStepRow` branches on `step.outcome`:

| outcome | chip | body |
|---|---|---|
| `would_send` | `Would send` (Send, success) | `step.detail`, plus a `Preview message` / `Hide preview` disclosure (`aria-expanded`) revealing `rendered.subject` (bold) and `rendered.body` (`whitespace-pre-wrap`) when `step.rendered` exists |
| `would_wait` | `Waits` (Clock, neutral) | `Waits {detail} here` |
| `would_check` | `Guard check` (OctagonPause, warning) | `step.detail` |
| `needs_setup` | `Needs setup` (AlertTriangle, warning) | `step.detail` + a `Fix it` `Button variant="outline" size="sm"` |

`Fix it` closes the dialog then calls `onFixStep(step.step_index)`, which the
page maps to `selectStep(state.steps[stepIndex].uid)` - opening that step's
drawer. **The index alignment between dry-run steps and draft steps is a
contract**; do not reorder either list independently.

### 6.3 WorkflowActivity (`components/workflows/WorkflowActivity.tsx`, 135 lines)

`useWorkflowActivity(id)` -> `GET /api/workflows/:id/activity` (no `limit` is
passed from the page, so the param is `undefined`).

- Loading -> three `Skeleton h-24 w-full`.
- Empty -> `<EmptyState variant="card" icon={History} className="max-w-sm">`
  whose title is status-aware (`emptyStateHint`):
  - not PUBLISHED: `Nothing has run yet [emdash] publish and turn it on to start.`
  - PUBLISHED but disabled: `Nothing has run yet [emdash] turn it on to start.`
  - PUBLISHED and enabled: `Nothing has run yet [emdash] the first time it runs, you'll see it here.`
  The comment is explicit that telling someone to publish something they already
  published reads as a silent failure. Preserve the three-way branch.
- Rows -> `<StatusBadge domain="workflowStep" status={row.status} />`, the
  `row.detail ?? '[emdash]'` line, a meta line
  `Step {n} [middot] {action label}` plus optional `[middot] {entity_label}` and
  `[middot] To {recipient_summary}`, and a right-aligned relative timestamp.
- `row.source === 'legacy'` adds a small `History` glyph in a `Tooltip`
  (`delayDuration={0}`) with an `sr-only` twin, both reading
  `From the previous automations engine`.
- `STEP_ACTION_LABEL`: WAIT `Wait`, SEND_TEXT `Text the customer`, SEND_EMAIL
  `Send an email`, NOTIFY_TEAM `Notify the team`, STOP_IF `Check a condition`.
- `relativeTime` is hand-rolled: `just now` under a minute, `Nm ago`, `Nh ago`,
  `Nd ago` under 7 days, then `toLocaleDateString('en-US', { month:'short',
  day:'numeric' })`. **There is no error state** - `isError` is not consumed, so
  a failed fetch renders the empty state.

`STATUS_REGISTRY.workflowStep` (`frontend/src/design-system/status-registry.ts:331`):
SENT `Sent`/success, SKIPPED `Skipped`/neutral, FAILED `Failed`/danger,
STOPPED `Stopped`/warning, CONTINUED `Continued`/neutral, PENDING
`Scheduled`/warning. The feed is a union of two backing Prisma enums; PENDING is
off the wire, not client-only.

### 6.4 WorkflowSettings (`components/workflows/WorkflowSettings.tsx`, 107 lines)

Two cards in a `max-w-xl` stack.

1. Name card: `Label` `Automation name` + `Input id="settings-name"
   aria-label="Automation name (Settings)" maxLength={120}` bound straight to
   the draft's `name` via `onSetName`. **No RHF, no zod.** Editing here marks the
   draft dirty and rides the same 3s autosave; there is no blur flush on this
   input.
2. Danger zone: `Heading level=3` `Danger zone`, copy
   `Deleting removes this automation for everyone in your organization.`, and
   `Delete this automation` (`Button variant="outline" tone="danger"`,
   `disabled={!id}` - so it is dead on an unsaved `/automations/new` draft).

Confirm dialog (`max-w-md`): title `Delete "{name}"?`, description
`Its activity history is removed too. This can't be undone.`, `Cancel` and a
`Button variant="solid" tone="danger" disabled={remove.isPending}` `Delete` that
calls `remove.mutate(id, { onSuccess: () => navigate('/automations') })`.

The docblock records that the per-automation "When can it send?" window was
removed from the product; `send_window` survives in the DB/API for old rows but
**nothing in the app writes it**. Do not reintroduce a control for it.

### 6.5 workflow-visuals (`components/workflows/workflow-visuals.tsx`, 137 lines)

Shared vocabulary, all token-sourced:

- `TRIGGER_VISUAL` = Zap / `bg-primary-subtle` / `text-primary`.
- `STEP_TYPE_META`: WAIT Clock `bg-background-light`; SEND_TEXT MessageSquare,
  SEND_EMAIL Mail, NOTIFY_TEAM Bell all `bg-primary-subtle`; STOP_IF
  OctagonPause `bg-warning/10 text-warning`.
- `StepTypeTile({ type, size })` - `sm` 32px, `md` 40px, `lg` 44px, `rounded-ic`,
  `title={meta.label}`.
- `FlowTrail({ steps })` - `aria-hidden` decorative trail of tiles joined by
  1px rails.
- `CATEGORY_META` for the three template categories with title, blurb and tile
  colours; `CATEGORY_ORDER = ['customer','money','team']`.
- `workflowDisplayStatus({status, is_enabled})` -> `DRAFT | LIVE | PAUSED`, and
  `WorkflowStatusPill` renders `<StatusBadge domain="workflow" ...>`
  (`DRAFT` PenLine/neutral, `LIVE` CheckCircle2/success, `PAUSED`
  PauseCircle/neutral).

The file's own docblock notes `rounded-control` is not a registered utility in
this repo (a pre-existing no-op in the legacy file) and that bare `rounded` is
used instead. Worth knowing before a kit swap "fixes" radii.

---

## 7. Data layer

Module: `frontend/src/lib/api/workflows.ts` (403 lines). All TanStack Query,
axios via `@/lib/axios`.

| Hook | Method + endpoint | Query key | Invalidates on success |
|---|---|---|---|
| `useWorkflows()` | `GET /api/workflows` | `['workflows']` | - |
| `useWorkflow(id)` | `GET /api/workflows/:id` | `['workflows', id]`, `enabled: Boolean(id)` | - |
| `useWorkflowCatalog()` | `GET /api/workflows/catalog` | `['workflows','catalog']`, `staleTime: 10 * 60_000` | - |
| `useWorkflowActivity(id, limit)` | `GET /api/workflows/:id/activity?limit=` | `['workflows', id, 'activity', limit]`, `enabled: Boolean(id)` | - |
| `useCreateWorkflow()` | `POST /api/workflows` | - | `['workflows']` |
| `usePatchWorkflow()` | `PATCH /api/workflows/:id` | - | `['workflows']` and `['workflows', id]` |
| `usePublishWorkflow()` | `POST /api/workflows/:id/publish` body `{ enable }` | - | `['workflows']` and `['workflows', id]` |
| `useToggleWorkflow()` | `POST /api/workflows/:id/toggle` body `{ is_enabled }` | - | `['workflows']` and `['workflows', id]` |
| `useDeleteWorkflow()` | `DELETE /api/workflows/:id` | - | `['workflows']` and `['workflows', id]` |
| `useTestWorkflow()` | `POST /api/workflows/:id/test` body `{ send_to_me }` | - | `['workflows']` and `['workflows', id]` |
| `useAssignableUsers()` | `GET /api/users?assignable=true` | `['users','assignable',null,null,null]` (`lib/api/users.ts:88-100`) | - |

**Prefix-match consequence (important, and easy to break):** TanStack Query
invalidates by key prefix, so `invalidateQueries({ queryKey: ['workflows'] })`
also invalidates `['workflows','catalog']`, `['workflows', id]` and
`['workflows', id, 'activity', limit]`. Every mutation in this module therefore
invalidates the catalog too; the catalog's 10-minute `staleTime` is what keeps
that from becoming a refetch storm. A rebuild that renames keys must preserve
this hierarchy or the builder will refetch far more, or far less, than it does today.

### Error toasts (all from the mutation hooks, all `variant: 'destructive'`)

| Hook | Title | Description fallback |
|---|---|---|
| `useCreateWorkflow` | `Could not create automation` | `Something went wrong saving the automation` |
| `usePatchWorkflow` | `Could not save automation` | `Something went wrong saving the automation` |
| `usePublishWorkflow` | `Could not publish automation` | `Something went wrong publishing the automation` |
| `useToggleWorkflow` | `Could not update automation` | `Something went wrong` |
| `useDeleteWorkflow` | `Could not delete automation` | `Something went wrong` |
| `useTestWorkflow` | `Test failed` | `Could not send the test` |

Descriptions run through `extractApiError(err, fallback)`.

### Success toasts

| Source | Toast |
|---|---|
| `useToggleWorkflow` | `Automation turned on` / `Automation paused`, description = workflow name |
| `useDeleteWorkflow` | `Automation deleted` |
| `WorkflowBuilderPage.handlePublish` | `Live [emdash] this automation is now running`, description = published name |
| `WorkflowBuilderPage.handleTidyUp` | `All tidy [sparkles]` / `Your steps are lined up top to bottom.` |
| `TestWorkflowDialog.handleSendToMe` | `Test sent` / `Test sent to your email + notifications` |

**There are no optimistic updates anywhere in this module.** Every mutation
awaits the server.

### Pure helpers (reuse verbatim, do not reimplement)

`frontend/src/lib/workflows/`:

- `describeWorkflow.ts` - `describeWorkflow(trigger_type, trigger_config, steps,
  catalog)` joins a trigger clause and per-step clauses with ` -> ` (a real arrow
  glyph in source); `formatOffset(minutes)`; `anchorLabel(catalog, anchor)`;
  `templateToWorkflowBody(template)` which uses `template.steps` verbatim when
  present and otherwise folds `action_type`/`action_config` into one step with a
  narrowly-assembled config (a stray key would 400 on create).
- `stepSentence.ts` - `stepSentence(step, catalog)` returns
  `{ configured, segments: SentenceSegment[] }`; `sentenceText(sentence)` flattens it.
- `triggerModel.ts` - `selectionToTrigger`, `triggerToSelection`,
  `DATE_ANCHORED_BY_SUBJECT`, and the `BuilderSubject` / `BuilderMode` /
  `TriggerSelection` / `TriggerConfig` types.
- `timing.ts` - `OffsetUnit`, `UNIT_MINUTES`, `splitOffset` (largest whole unit:
  days -> hours -> minutes).
- `anchors.ts` - types only (`AnchorKey`, `WaitDirection`); the anchor **data**
  is served by the catalog.
- `entities.ts` - `ENTITY_ORDER = ['job','estimate','invoice','lead']`.
- `recipients.ts` - `RECIPIENT_FORM_LABELS` and `recipientsFor()`; **legacy
  6-member shape**, still referenced by the sentence helpers.
- `featureFlags.ts` - `lockedStepTypesFor`, `SMS_LOCKED_BADGE`,
  `SMS_LOCKED_TOOLTIP`, `DEFAULT_LOCKED_STEP_TYPES`.
- `stepSchemas.ts` - the zod mirrors of the backend per-step schemas (see below).

### stepSchemas.ts, verbatim bounds

```ts
MAX_WAIT_MINUTES = 60 * 24 * 90                 // 90 days
EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/
MERGE_FIELD_RE = /\{\{([a-z_.]+)\}\}/g

waitRelativeConfigSchema = { mode: literal('relative'),
  duration_minutes: number('Set how long to wait').int('Use a whole number of minutes')
    .min(5,'Wait at least 5 minutes').max(MAX,'That's longer than the 90-day limit') }.strict()

waitAnchoredConfigSchema = { mode: literal('anchored'),
  anchor: enum(['job.scheduled_start','lead.walkthrough_scheduled_at']),
  direction: enum(['before','after']),
  offset_minutes: number('Set the timing').int(...).min(0,'Timing can't be negative').max(MAX, ...) }.strict()

waitConfigSchema = preprocess(default mode:'relative' when absent,
  discriminatedUnion('mode', [relative, anchored]))

EMAIL_RECIPIENT  = enum(['customer','assigned_techs','all_admins','all_dispatchers','custom'])
NOTIFY_RECIPIENT = enum(['assigned_techs','all_admins','all_dispatchers','specific_user'])

sendTextConfigSchema   = preprocess(withRecipientsArray, {
  recipient: literal('customer').optional(),
  recipients: array(literal('customer')).min(1),
  body: string.min(1,'Write the text message').max(320,'Texts are capped at 320 characters') }.strict())

sendEmailConfigSchema  = preprocess(withRecipientsArray, {
  recipient: EMAIL_RECIPIENT.optional(), recipients: array(EMAIL_RECIPIENT).min(1),
  subject: min(1,'Add a subject line').max(200,'Subject is too long (200 characters max)'),
  body: min(1,'Write the email').max(5000,'Email is too long (5,000 characters max)'),
  custom_email?: string, custom_emails?: string[] }.strict()
  .superRefine(recipient === 'custom' => custom_email required + EMAIL_RE))

notifyTeamConfigSchema = preprocess(withRecipientsArray, {
  recipient: NOTIFY_RECIPIENT.optional(), recipients: array(NOTIFY_RECIPIENT).min(1),
  body: min(1,'Write the message').max(5000,'Message is too long (5,000 characters max)'),
  user_id?: string, user_ids?: string[] }.strict()
  .superRefine(recipient === 'specific_user' => user_id required, 'Pick the team member to notify'))

stopIfConfigSchema = { condition: string.min(1,'Pick a condition') }.strict()
```

Note the mismatch the code itself flags: `stepSchemas.ts`'s recipient enums are
the **legacy 6-member** vocabulary, while `RecipientMultiSelect` speaks the
9-member `AudienceKey` set from the catalog. `SendEmailForm` and
`NotifyTeamForm` therefore use **local content-only schemas**, not these,
and recipient legality stays server-owned. Do not "unify" them during a UI swap.

### Forms inventory

| Form | RHF? | Schema | Submit path |
|---|---|---|---|
| Builder header name | no | none (`maxLength={120}`) | `setName` -> draft -> autosave `POST`/`PATCH` |
| WorkflowSettings name | no | none (`maxLength={120}`) | same |
| TriggerForm | no | none (uses `triggerModel` conversion as the guard) | `onSetTrigger` -> draft -> autosave |
| DateModePanel custom | no | integer/finite/non-negative guard in `commitCustom` | `onChange` -> TriggerForm -> draft |
| WaitForm relative | yes | `waitRelativeConfigSchema.omit({mode:true})` | `onChange({ duration_minutes })` -> draft |
| WaitForm anchored | no | `waitAnchoredConfigSchema.safeParse` gate | `onChange({mode:'anchored',...})` -> draft |
| SendTextForm | yes | `sendTextConfigSchema` | `onChange({ recipient:'customer', body })` |
| SendEmailForm | yes (copy only) | local `emailContentSchema` | `push()` -> `onChange(cfg)` |
| NotifyTeamForm | yes (copy only) | local `notifyContentSchema` | `push()` -> `onChange(cfg)` |
| StopIfForm | yes | `stopIfConfigSchema` | `onChange({ condition })` |
| RecipientMultiSelect custom emails | no | `EMAIL_RE` + duplicate check | `onCustomEmailsChange` |

**No form in this module has a submit button.** Everything is
change-propagation into the draft plus debounced autosave. The only explicit
"commit" actions are Publish, Toggle, Delete, and the dry-run Test.

---

## 8. Selector surface and existing specs

### data-testid

**Exactly one in the entire module:**

| Selector | Location |
|---|---|
| `trigger-readback-note` | `components/workflows/trigger/TriggerReadback.tsx:182`; asserted in `trigger/__tests__/TriggerReadback.test.tsx:188,199,223` |

Everything else is queried by role, accessible name, label, placeholder or text.

### Accessible names the specs bind to (must survive a rebuild)

From `pages/workflows/WorkflowsHome.test.tsx` and
`pages/workflows/WorkflowBuilderPage.test.tsx`:

| Name / pattern | Origin |
|---|---|
| `Actions for {workflow.name}` | Home row kebab trigger |
| `Pause {name}` / `Turn on {name}` | Home row Switch |
| `/duplicate/i`, `Delete`, `Really delete?`, `Retry`, `Start from scratch`, `Use this` | Home menu items, dialog, banners, template card |
| `Pause this automation` / `Turn this automation on` | `PublishControl` Switch |
| `/^publish$/i`, `Publish changes` | `PublishControl` |
| `/^test$/i` | builder header Test button |
| `Automation name` | builder header input `aria-label` |
| `Automation name (Settings)` | Settings input `aria-label` |
| `/delete this automation/i` | Settings danger-zone button |
| `Activity`, `Settings`, `Builder` | builder `TabsTrigger`s |
| `/Edit trigger/`, `/Edit trigger: Choose what starts this automation/`, `/Edit trigger: When a job is scheduled/` | `TriggerNode` |
| `Step {n} actions`, `Move up`, `/Move down/i`, `Delete step`, `Really delete?` | `StepNode` kebab |
| `Reorder step {n}: {label}` | `StepNode` drag handle |
| `Insert a step`, `Insert a step at the top`, `Insert a step after step {n}`, `Add a step` | `AddStepButton` |
| `/Send email/i`, `/Job completed/i` | `AddStepButton` picker rows, `EventModePanel` radios |
| `/Jobs [emdash] change subject/` | `TriggerForm` crumb chip |
| `Done`, `Remove step`, `Really remove?` | `StepConfigDrawer` footer |
| `Fix it` | `TestWorkflowDialog` needs-setup row |
| `Search all triggers` | `SubjectPicker` search input |
| `Wait amount`, `Wait unit`, `Timing amount`, `Timing unit` | `WaitForm` / `DateModePanel` |
| `Stop condition` | `StopIfForm` Select trigger |
| `Custom email address`, `Remove {email}` | `RecipientMultiSelect` |
| `{group} ({count})` | `MergeFieldChips` section toggles |

### Vitest specs constraining the module

`src/pages/workflows/WorkflowsHome.test.tsx`,
`src/pages/workflows/WorkflowBuilderPage.test.tsx` (the largest, ~480 assertions
deep), and per-component:
`AddStepButton.test.tsx`, `MergeFieldChips.test.tsx`, `NotifyTeamForm.test.tsx`,
`PublishControl.test.tsx`, `RecipientMultiSelect.test.tsx`,
`SendEmailForm.test.tsx`, `SendTextForm.test.tsx`, `StopIfForm.test.tsx`,
`TestWorkflowDialog.test.tsx`, `TriggerForm.test.tsx`, `WaitForm.test.tsx`,
`WorkflowActivity.test.tsx`, `WorkflowSettings.test.tsx`,
`useWorkflowDraft.test.ts`, plus `components/workflows/trigger/__tests__/*` and
`lib/workflows/{describeWorkflow,stepSchemas,stepSentence,featureFlags}.test.ts`.
`components/workflows/step-forms.fixture.ts` holds the shared catalog fixture.

### Playwright

`frontend/e2e/specs/workflow/` exists but is the **business** workflow suite
(estimate/job/invoice journeys), not this module - the only `automation`
mentions there are backend trigger-event names in
`redesign-28-emails.spec.ts:14` and `redesign-23-transitions-gaps.spec.ts`.
**There is no Playwright spec for the Automations UI.**

---

## 9. Loading / empty / error / disabled summary

### Loading

| Surface | Treatment |
|---|---|
| Home stat band | 3x `Skeleton h-[76px]` |
| Home workflow list | 2x `Skeleton h-[92px]` |
| Home template gallery | 3x `Skeleton h-[180px]` |
| Builder first load (`:id` only) | `Skeleton h-8 w-40` + `Skeleton h-[520px]` |
| TriggerForm without catalog | `Skeleton h-4 w-2/3` + `h-24` + `h-10` |
| TestWorkflowDialog | 2x `Skeleton h-16` |
| WorkflowActivity | 3x `Skeleton h-24` |

The rest of the builder renders instantly against the local draft - there is no
skeleton for the spine or the drawer.

### Empty states, verbatim

| Surface | Text |
|---|---|
| Home, no workflows | stat band and list omitted; gallery header becomes `Start from a recipe` + `Start from scratch` |
| Home, empty template category | section not rendered at all |
| BuilderSpine, no steps | `Add your first step` bubble |
| BuilderSpine footer, always | `End of automation` |
| TestWorkflowDialog, no steps | `Add a step to try this automation.` |
| WorkflowActivity, no rows | one of the three `emptyStateHint` strings |
| WorkflowActivity row with no detail | `[emdash]` |
| SubjectPicker, no search matches | `No matches. Try "completed", "paid", "reminder", "before".` |
| StopIfForm, no conditions for entity | `Stop conditions aren't available for this trigger` card |
| RecipientMultiSelect, nothing ticked | `Pick at least one recipient` |
| SpecificUserField, nothing ticked | `Pick at least one team member` |
| CustomEmailsField, no chips | `Enter at least one email address` |
| MergeFieldChips, no fields | renders `null` |

### Error states

| Surface | Treatment |
|---|---|
| Home, workflows fetch | `ErrorBanner` + `Retry` |
| Home, catalog fetch | `ErrorBanner` + `Retry` |
| Builder, workflow fetch | full-page failure card with `Try again` + `Back to Automations` |
| Every mutation | destructive toast from the hook (table in section 7) |
| WorkflowActivity fetch | **none** - `isError` is not consumed; a failure shows the empty state |
| Autosave failure | **no UI of its own** - the stamp stays on `Unsaved changes`, the toast comes from the hook, the draft stays dirty and retries on the next edit |

### Disabled states

| Control | Disabled when |
|---|---|
| Home row Switch | `isDraft \|\| toggle.isPending` (tooltip `Publish first`) |
| Template `Use this` | `createWorkflow.isPending` (all cards at once) |
| Home dialog `Delete` | `!workflow \|\| remove.isPending` |
| Builder `Test` | `state.dirty \|\| !state.server.id` (tooltip `Save your changes first`) |
| `Publish` / `Publish changes` | `isPublishing` (= `publish.isPending \|\| isSaving`), or issues exist (tooltip = `blockedReason`) |
| PublishControl Switch | `isToggling` |
| StepNode `Move up` / `Move down` | first / last index |
| AddStepButton locked row | `lockedTypes.includes(type)` -> `aria-disabled`, not `disabled` |
| ModeFork date card | `anchorLabel === null` (unreachable today) |
| Settings `Delete this automation` | `!id` |
| Settings dialog `Delete` | `remove.isPending` |
| TestWorkflowDialog `Send a test to me` | `test.isPending \|\| steps.length === 0` |

---

## 10. Component import inventory (the rebuild checklist)

Every `@/components/...` import across the module's two pages and 25 non-test
component files.

| Import | Used by |
|---|---|
| `@/components/ui/button` | WorkflowsHome, WorkflowBuilderPage, PublishControl, StepConfigDrawer, StepNode, TestWorkflowDialog, WorkflowSettings |
| `@/components/ui/input` | RecipientMultiSelect, SendEmailForm, WaitForm, WorkflowSettings, trigger/DateModePanel, trigger/SubjectPicker |
| `@/components/ui/label` | NotifyTeamForm, SendEmailForm, SendTextForm, StopIfForm, WaitForm, WorkflowSettings |
| `@/components/ui/textarea` | NotifyTeamForm, SendEmailForm, SendTextForm |
| `@/components/ui/select` | StopIfForm, WaitForm, trigger/DateModePanel |
| `@/components/ui/checkbox` | RecipientMultiSelect |
| `@/components/ui/switch` | WorkflowsHome, PublishControl |
| `@/components/ui/tooltip` | WorkflowsHome, WorkflowBuilderPage, AddStepButton, PublishControl, WorkflowActivity |
| `@/components/ui/skeleton` | WorkflowsHome, WorkflowBuilderPage, TestWorkflowDialog, TriggerForm, WorkflowActivity |
| `@/components/ui/dialog` | WorkflowsHome, TestWorkflowDialog, WorkflowSettings |
| `@/components/ui/sheet` | StepConfigDrawer |
| `@/components/ui/popover` | AddStepButton |
| `@/components/ui/dropdown-menu` | WorkflowsHome, StepNode |
| `@/components/ui/tabs` | WorkflowBuilderPage |
| `@/components/ui/heading` | WorkflowsHome, WorkflowSettings |
| `@/components/ui/empty-state` | WorkflowActivity, trigger/SubjectPicker |
| `@/components/ui/use-toast` | WorkflowBuilderPage, TestWorkflowDialog |
| `@/components/data/KpiStrip` (`KpiTile`) | WorkflowsHome |
| `@/components/data/status-badge` (`StatusBadge`) | WorkflowActivity, workflow-visuals |

Module-internal imports (rebuild targets, not shared kit):
`@/components/workflows/{workflow-visuals, useWorkflowDraft, BuilderSpine,
StepConfigDrawer, PublishControl, WorkflowActivity, WorkflowSettings,
TestWorkflowDialog}` plus the relative imports `TriggerNode`, `StepNode`,
`AddStepButton`, `MergeFieldChips`, `RecipientMultiSelect`, `useMergeInsert`,
the five step forms, and `trigger/{SubjectPicker, ModeFork, EventModePanel,
DateModePanel, TriggerReadback}`.

Non-`@/components` third-party UI dependencies: `@dnd-kit/core`,
`@dnd-kit/sortable`, `@dnd-kit/utilities` (BuilderSpine + StepNode),
`date-fns` `formatDistanceToNow` (WorkflowsHome, WorkflowBuilderPage),
`react-hook-form` + `@hookform/resolvers/zod` (five forms), `lucide-react`
throughout.

**No component in this module imports `@/components/ui/form`,
`@/components/data/data-table`, or any table primitive.** The workflow list is
hand-rolled cards, not a DataTable.

---

## 11. Migration risks specific to this module

1. **Autosave is the load-bearing mechanism, and it is fragile by design.**
   The `flushRef` indirection, the `savingRef` guard, the `revision`-compare in
   `markSaved`, the blur flush and the unmount flush are four interlocking
   pieces with explicit comments explaining why each exists. A rebuild that
   restructures the header (e.g. moving the name input into a kit form
   component) must keep the `onBlur -> flush()` edge and must not add or remove
   effect dependencies around `flush`.
2. **Create-on-first-save plus `navigate(replace)`.** `/automations/new` has no
   server id until the first flush. Anything that reads `state.server.id`
   (Test button, Settings delete, PublishControl's synthesized issue) behaves
   differently in that window. Do not "simplify" by creating eagerly on mount -
   that would litter drafts.
3. **The failed-load guard must stay ahead of the normal render.** Falling
   through to the blank draft on a failed `:id` load creates a duplicate
   workflow on the first keystroke.
4. **dnd-kit is already in use here** (unlike Tasks' BoardView). The kit's
   `KanbanBoard` is horizontal/column-based; this spine is a single vertical
   `SortableContext` where `uid` is the sortable id and position is array index.
   Any swap must keep `KeyboardSensor` + `sortableKeyboardCoordinates` (keyboard
   reordering is a shipped affordance) and the kebab's Move up/Move down as the
   drag-free equivalents.
5. **`key={step.uid}` on each drawer form is semantic, not incidental.** The
   forms seed local state from `config` once; without the key, switching from
   one step to another of the same type would show the previous step's values.
6. **`useMergeInsert` needs real DOM refs.** If a kit Input/Textarea does not
   forward its ref, merge-field insertion silently does nothing.
7. **Never-emit guards.** `WaitForm`'s anchored branch, `DateModePanel`'s
   `commitCustom` and `TriggerForm`'s `commit` all refuse to push invalid values
   into the draft, precisely because every push feeds a debounced autosave that
   would otherwise 400 on a loop. Preserve them.
8. **Two-press destructive confirms** appear in two places (StepNode kebab,
   drawer footer) and a real dialog in two others (Home row delete, Settings).
   They are not interchangeable; the kebab one depends on
   `e.preventDefault()` inside `onSelect` to keep the Radix menu open.
9. **The disabled-button-in-a-focusable-span idiom** appears four times. Replacing
   it with a plain disabled Button kills the explanatory tooltip, which is the
   only place the user learns *why* Publish or Test is blocked.
10. **`aria-label` omission on the Home row is deliberate.** Adding one hides the
    sentence/name/stats from screen readers.
11. **The empty-string-controlled Select in StopIfForm** avoids React's
    uncontrolled-to-controlled warning; keep the `''` sentinel.
12. **`send_window` is dead in the UI but alive in the API.** Do not surface it,
    and do not copy it on duplicate.
13. **Feature/role gate nesting**: role guard outside, `RequireFeature` inside.
    Swapping them changes what a SALES user on STARTER sees.
14. **The single `data-testid`** (`trigger-readback-note`) must survive; every
    other spec hook is an accessible name, so renaming any `aria-label` in the
    table in section 8 breaks tests.

---

## 12. Open questions

1. **`components/ui/tabs.tsx` was not opened.** The claim that inactive
   `TabsContent` panels unmount is inferred from the absence of a `forceMount`
   prop. This matters: `WorkflowActivity` fires its query on mount, so if panels
   were force-mounted the activity fetch would fire on page load rather than on
   tab click. Verify before changing tab behaviour.
2. **`components/ui/{button,switch,skeleton,dialog,sheet,popover,dropdown-menu,
   tooltip,heading,empty-state,checkbox,input,label,textarea,select}` internals
   were not opened** - they are shared kit, imported not forked. Their exact
   variant/tone/size vocabularies (`variant="solid" tone="business"`,
   `tone="subtle"`, `tone="strong"` on Label, `EmptyState density="compact"` vs
   `variant="card"`) are used here as-is and were taken from the call sites.
3. **`@/components/data/KpiStrip`'s `KpiTile`** was only inspected for its prop
   surface (`icon`, `tone`, `label`, `value`; tones `success`/`neutral`/`primary`
   used here). Its internals were not read.
4. **`describeWorkflow`'s `triggerClause` / `stepClause` internals** (lines
   1-220) were not read in full - only the public entry points and
   `templateToWorkflowBody`. If a rebuild needs to change how a sentence renders,
   read that file first.
5. ~~**`TriggerReadback` hardcodes `send the customer an email.`**~~ ANSWERED:
   fixed, not preserved. The tail named an audience the trigger may not be able
   to reach (no task trigger can reach a customer) and asserted a step the admin
   had not configured. The sentence is now the trigger alone, in BOTH twins - see
   section 5.7.
6. **`ModeFork` always receives `value={null}`** from `TriggerForm`, so its
   `aria-pressed` selected ring is dead code in the app (reachable only in unit
   tests). Preserve or drop - needs a decision.
7. **`WorkflowActivity` never renders an error state.** A failed activity fetch
   is indistinguishable from "nothing has run yet". Preserve or fix?
8. **Backend `workflow.controller.ts` was not opened.** All server-side
   validation statements here are sourced from the frontend mirrors' own
   docblocks (`stepSchemas.ts`, `featureFlags.ts`, `RecipientMultiSelect.tsx`),
   which claim 1:1 parity with
   `backend/src/services/automations/workflowValidation.ts` and `catalog.ts`.
   That parity was **not independently verified** in this pass.
9. **The `/automations/:id/edit` redirect has no test coverage** that I found.
   Its correctness rests entirely on `relative="path"` and route ordering; a
   rebuild should add one rather than trust the comment.
10. **Whether `/v2/automations` should be reachable from the sidebar** is
    undecided here - `nav-registry.ts` points at `/automations` and this document
    does not touch that. Same question the Tasks map raised.
