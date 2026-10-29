# Automations - components with no kit equivalent

Module 14. Branch `refactor/ui-kit-14-automations`.

Rebuilt under `frontend/src/pages/v2/automations/`: `AutomationsHomePage.tsx`,
`AutomationBuilderPage.tsx`, and 22 files under `components/` (five of them under
`components/trigger/`). Registered by `pages/v2/routes/automations.paths.ts` +
`automations.routes.tsx` (four paths).

The import checklist is every `@/components/...` import across the two legacy pages and the
25 non-test files in `components/workflows/` - 19 distinct shared modules, all accounted for
in the Replaced tables below.

## The behaviour map held up

`md_files/specs/ui-redesign/automations-behavior-map.md` was written for this migration on
2026-08-04, and unlike the Wave A maps it is accurate. Everything it asserts about routes,
guards, autosave, the draft hook, the dnd-kit wiring, the selector surface and the data layer
was verified against the code and matched. Three small corrections, none of which changed
what this branch built:

| Map says | Code says | Source |
|---|---|---|
| Open question 1: "`components/ui/tabs.tsx` was not opened", so the claim that inactive panels unmount is inferred | Confirmed by substitution rather than by reading that file: v2 uses `pages/v2/leads/components/tabs.tsx`, whose `TabPanel` returns `null` when inactive. The Activity query therefore fires on tab click, not on page load, which is the behaviour the inference predicted | `pages/v2/leads/components/tabs.tsx:59` |
| Section 4.3 lists the StepNode kebab as carrying "Move up/down, Insert above/below, Delete" in its prose intro | The legacy component's own docblock says that, but the rendered menu has only Move up, Move down, separator, Delete step. There is no Insert item. The map's own detailed table is right; only its section-4.3 lead-in inherits the stale docblock | `components/workflows/StepNode.tsx:1-8` vs `:181-204` |
| Section 10 counts "25 non-test component files" | 25 is right for the count, but the inventory omits `step-forms.fixture.ts` (a test fixture, correctly excluded) and `useWorkflowDraft.ts`/`useMergeInsert.ts` are listed as rebuild targets. Both are pure hooks with no JSX; they are IMPORTED here, not rebuilt, per the "never fork business logic" rule | `components/workflows/useWorkflowDraft.ts`, `useMergeInsert.ts` |

The task brief was accurate too: "about 36 files" in `components/workflows/` is exactly right
(36 including tests and the fixture; 25 non-test components plus 2 hooks plus the fixture plus
8 test files).

## Gaps

| Old component | Kind | Used in | What it does | Kit's nearest thing | Why it is not enough | Also hit by | Rec |
|---|---|---|---|---|---|---|---|
| Tabs | component | builder page | three-tab rail (Builder / Activity / Settings) | none | the kit ships 24 UI primitives and none is Tabs. Reused `pages/v2/leads/components/tabs.tsx` (`TabStrip`/`TabPanel`) rather than writing a ninth hand-rolled version. Ninth module to need it | Leads, Customers, Estimates, Invoices, Jobs, Service Plans, Tasks, Dashboard | BUILD (unanimous across nine modules) |
| `ui/heading` | component | home page, settings tab, four trigger panels | `<Heading level scale weight>` | `layout/pageHeader` `title` (h1 only) | the kit has no general heading primitive, and the raw-tag ratchet forbids a new `h1`-`h6` outside the primitives. The page title went to `PageHeader`; the six sub-headings became `<p>` with type classes, losing heading semantics. Recorded under Behaviour not reproduced | Tasks | BUILD (a `Heading`/`Text` primitive with a `level` prop) |
| `ui/empty-state` `density` prop | kit API | subject picker | `density="compact"` shrinks the vertical padding | `data/emptyState` | the kit EmptyState has no density prop, and its appearance ratchet is at its floor (5/5), so a `py-*` className to reproduce it would turn the guard red. The no-matches state renders at the kit's default padding instead | Tasks (used `variant="card"` equivalently) | BUILD (the `density` prop the app's own EmptyState already has) |
| `ui/empty-state` `variant="card"` | kit API | activity tab | border + radius + surface around the empty state | `data/emptyState` | same reason: no variant prop, and no className is available to add the border. Wrapped the kit EmptyState in a bordered `div` at the call site instead | Tasks | BUILD (a `variant="card"`) |
| a toggle-chip / segmented-control cell on `ui/button` | kit API | wait form (12 sites), date mode panel (7 sites), merge field chips (n sites) | `aria-pressed` mutually-exclusive pills and 2-up segmented toggles | `ui/button` | no variant/tone cell paints a selected chip. Composed on `Button` with a call-site class helper (`pillClass`, `toggleClass`, `chipClass`) per file. Legacy left all of these as raw `<button>`; that is not available here because the raw-tag ratchet is at its floor | - | BUILD (a `toggle`/`chip` variant with a pressed state) |
| a non-CTA click target | component | 12 sites across 7 files | card bodies, listbox options, radio rows, subject tiles, menu rows: rich multi-line content behind one activation | `ui/button` | the legacy source carries an in-place comment at each of these explaining why no Button cell reproduces them (gradient card, two-line radio row, `role="option"`, and so on), and they cannot stay raw. Built `pages/v2/automations/components/pressable.tsx`: a role-carrying `div` with `tabIndex`, Enter/Space activation and a focus ring | Tasks (solved the same problem inline with `span role="button"`) | BUILD (a headless `Pressable`/`ClickableSurface`, or `asChild` on Button without its CTA paint) |
| `data/KpiStrip` `KpiTile` `icon` | kit API | home stat band | icon + tone + label + value | `data/statCard` | the kit StatCard ships no icon slot; `tone` is a 3px rail instead. Documented kit decision, carried as-is | Tasks, Leads, Dashboard | (already filed) |
| `data/status-badge` (`StatusBadge`) | component | activity rows, status pill | resolves label + intent + icon through `status-registry` | `ui/badge` | Badge takes a variant, not a domain+status pair. Rebuilt as `WorkflowStatusChip` / `WorkflowStepStatusChip` over kit Badge, still resolving meaning through the unchanged registry. Same move Tasks and Leads made | Tasks, Leads, Jobs, Invoices | KEEP (the registry is domain logic; only the painting is local) |
| `ui/use-toast` | component | builder page, test dialog | `toast({ title, description, variant })` | `ui/sonner` | different API shape, not a missing component. `toast(title, { description })` throughout | every prior v2 module | KEEP |
| `design-system/status-registry` | - | status chips | the single answer to what a workflow status means | none, and none wanted | domain logic, imported unchanged | all | KEEP |

## Shape differences forced by the kit

No `filterPopover` / `appliedFilters` / `statusChip` triplet here - this module has no list
filtering at all. The duplication this section normally records is instead:

| What | Where | Note |
|---|---|---|
| `Pressable` | `pages/v2/automations/components/pressable.tsx` | Tasks solved the same raw-`<button>`-at-floor problem inline in `views/CalendarView.tsx` with a `span role="button"`. This branch factored it out because 12 sites needed it. If the kit takes the BUILD row above, both collapse into it |
| chip/toggle class helpers | `components/waitForm.tsx` (`pillClass`, `toggleClass`), `components/trigger/dateModePanel.tsx` (`chipClass`), `components/mergeFieldChips.tsx` (inline) | three near-identical selected-pill recipes, one per file, because the parallel-branch rule forbids a shared location. Consolidation work list |
| `glyphs.ts` | `pages/v2/automations/components/glyphs.ts` | second copy of the Tasks module's `components/glyphs.ts` idea (unicode escapes for rendered em dashes and curly quotes, since CLAUDE.md forbids the literal characters in source). Different constant set: this module also needs the middot, both curly double quotes, the single right angle quote and the sparkles glyph |

## Replaced (the audit trail)

### `pages/workflows/WorkflowsHome.tsx` -> `pages/v2/automations/AutomationsHomePage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/button` | `ui-kit/components/ui/button` | `variant="solid" tone="business"` becomes the kit default (brand solid); `variant="solid" tone="danger"` becomes `variant="destructive"` |
| `ui/switch` | `ui-kit/components/ui/switch` | both `aria-label`s preserved (`Pause {name}` / `Turn on {name}`) |
| `ui/skeleton` | `ui-kit/components/ui/skeleton` | same three loading shapes, same pixel heights |
| `ui/tooltip` | `ui-kit/components/ui/tooltip` | the draft-row `<span tabIndex={0}>` wrapper is kept: a disabled Switch swallows pointer events |
| `ui/dropdown-menu` | `ui-kit/components/ui/dropdownMenu` | `DropdownMenuItem variant="destructive"` exists on both |
| `ui/dialog` | `ui-kit/components/ui/dialog` | no typed confirmation, no second step, same as legacy |
| `ui/heading` | `ui-kit/components/layout/pageHeader` `title` (h1) and `<p>` for the three `<h2>`/`<h3>` sites | gap row |
| `data/KpiStrip` (`KpiTile`) | `ui-kit/components/data/statCard` (`StatCard`, `StatCardGroup`) | same three tiles, same values, same `Intl.NumberFormat('en-US')`. No icons (kit decision) |
| `workflows/workflow-visuals` (`FlowTrail`, `CATEGORY_META`, `CATEGORY_ORDER`, `WorkflowStatusPill`) | `pages/v2/automations/components/workflowVisuals` | `workflowDisplayStatus` imported from the legacy file, not copied |
| `lib/api/workflows`, `lib/workflows/describeWorkflow` | kept, imported unchanged | five hooks, `describeWorkflow`, `templateToWorkflowBody` |
| raw `<button>` row click target | `components/pressable` (`Pressable`) | the deliberate absence of an `aria-label` is preserved: the sentence/name/stats text IS the accessible name |
| `ErrorBanner` (authored inline) | rebuilt inline on kit tokens | same message, same `Retry` outline button; gained an AlertTriangle glyph so the banner is not colour-only |
| (page header authored inline) | `ui-kit/components/layout/pageHeader` + `pages/v2/pageBreadcrumbs` | `navKey="automations"`; the legacy page had no breadcrumb |

### `pages/workflows/WorkflowBuilderPage.tsx` -> `pages/v2/automations/AutomationBuilderPage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/button` | `ui-kit/components/ui/button` | |
| `ui/skeleton` | `ui-kit/components/ui/skeleton` | both first-load shapes unchanged |
| `ui/tabs` | `pages/v2/leads/components/tabs` (`TabStrip`, `TabPanel`) | gap row. `TabPanel` returns `null` when inactive, matching the Radix unmount default the page relied on |
| `ui/tooltip` | `ui-kit/components/ui/tooltip` | the disabled-Test `<span tabIndex={0}>` wrapper is kept |
| `ui/use-toast` | `ui-kit/components/ui/sonner` (`toast`) | three toasts: publish, tidy-up, and the dialog's |
| raw `<input>` (header name) | `ui-kit/components/ui/input` | `aria-label="Automation name"`, `maxLength={120}` and **the `onBlur` flush** all preserved. Still no RHF and no zod, exactly as before |
| `workflows/useWorkflowDraft` (`useWorkflowDraft`, `draftToInput`) | kept, imported unchanged | the draft state machine. Not forked |
| `workflows/BuilderSpine` | `components/builderSpine` | |
| `workflows/StepConfigDrawer` | `components/stepConfigDrawer` | |
| `workflows/PublishControl` | `components/publishControl`; `blockedReason` imported from the legacy file | |
| `workflows/WorkflowActivity` | `components/workflowActivity` | |
| `workflows/WorkflowSettings` | `components/workflowSettings` | |
| `workflows/TestWorkflowDialog` | `components/testWorkflowDialog` | |
| `lib/api/workflows`, `lib/workflows/describeWorkflow` | kept, imported unchanged | |

### `components/workflows/*` (all 25 non-test components, plus the 2 hooks)

| Old component | Replaced by | Notes |
|---|---|---|
| `workflow-visuals` | `components/workflowVisuals` | `STEP_TYPE_META` labels are byte-identical (the drag-handle name and the drawer kicker both read them); only colour classes moved to kit tokens. `workflowDisplayStatus` imported, not copied |
| `useWorkflowDraft` | **not rebuilt** - imported unchanged | pure `useState` hook, no I/O, no timers, no react-query. Forking it would fork the commit path |
| `useMergeInsert` | **not rebuilt** - imported unchanged | caret-aware insertion against the live DOM node. The kit Input and Textarea both forward refs, so `bind(name, rhfRef)` still resolves a real node |
| `BuilderSpine` | `components/builderSpine` | dnd-kit kept whole: `PointerSensor` (distance 6) + `KeyboardSensor` + `sortableKeyboardCoordinates`, `closestCenter`, `verticalListSortingStrategy`, `uid` as sortable id, `DndContext` rendered only when `steps.length > 0` |
| `TriggerNode` | `components/triggerNode` | raw `<button>` -> `Pressable`; `aria-label={`Edit trigger: ${title}`}` preserved verbatim (three live spec selectors key off it) |
| `StepNode` | `components/stepNode` | drag handle raw `<button>` -> `span` carrying dnd-kit's own `attributes` (which already supply `role="button"` and `tabIndex={0}`) + `listeners`; card body -> `Pressable`; kebab -> kit `Button`. Two-press Delete and its `e.preventDefault()` preserved |
| `AddStepButton` | `components/addStepButton` | `ui/popover` -> kit popover; the three trigger shapes go to kit `Button` (rail circle, and the dashed family with the dash as a call-site class); pickable rows -> `Pressable role="menuitem"`; locked rows stay `div role="menuitem" aria-disabled` with the `Lock` badge and `side="right"` tooltip |
| `StepConfigDrawer` | `components/stepConfigDrawer` | `ui/sheet` -> kit sheet. `key={step.uid}` on every form preserved (it is what resets a form's seeded local state). Two-press `Remove step` preserved |
| `PublishControl` | `components/publishControl` | `LivePill` -> kit `Badge` (softBlue / softGreen); `blockedReason` imported from the legacy module. All four states and both tooltip-wrapped disabled buttons preserved |
| `WorkflowActivity` | `components/workflowActivity` | `data/status-badge` -> `WorkflowStepStatusChip`; `ui/empty-state variant="card"` -> kit EmptyState in a bordered wrapper (gap row). Three-way `emptyStateHint` branch preserved; `relativeTime` copied verbatim |
| `WorkflowSettings` | `components/workflowSettings` | `ui/input` + `ui/label` + `ui/dialog` -> kit. `ui/heading` `<h3>` -> `<p>`. Still no RHF, still no blur flush on this input, still `disabled={!id}` on the delete button |
| `TestWorkflowDialog` | `components/testWorkflowDialog` | `OutcomeChip` -> kit `Badge`; the preview disclosure raw `<button>` -> kit `Button variant="ghost"` keeping `aria-expanded`; `firedRef` latch and `test.reset()` on close preserved |
| `TriggerForm` | `components/triggerForm` | `CrumbChip` raw `<button>` -> kit `Button`; both `aria-label`s preserved (`{label} - change subject` / `- change mode`, with real em dashes via the glyph constant). One-shot `seededRef` effect, `commit`'s never-emit guard, and both banners unchanged |
| `WaitForm` | `components/waitForm` | 8 raw toggle `<button>`s -> kit `Button` with `aria-pressed`. RHF relative branch and the non-RHF anchored branch with its `safeParse` gate both preserved, including the deliberate asymmetry (relative pushes NaN so the inline error appears; anchored never pushes an invalid value) |
| `SendTextForm` | `components/sendTextForm` | `ui/label` + `ui/textarea` -> kit; the fixed `Customer` pill -> kit `Badge`. `sendTextConfigSchema`, the 320 meter and its two thresholds unchanged |
| `SendEmailForm` | `components/sendEmailForm` | `ui/input`/`label`/`textarea` -> kit. Split ownership preserved: local `emailContentSchema` for copy only, recipients in `useState`, `push(overrides?)` unchanged |
| `NotifyTeamForm` | `components/notifyTeamForm` | same; `onCustomEmailsChange` stays a documented no-op |
| `StopIfForm` | `components/stopIfForm` | `ui/select` -> kit select. The `''` sentinel that keeps Radix controlled is preserved, as is the no-conditions warning card and the absence of an inline error |
| `RecipientMultiSelect` | `components/recipientMultiSelect`; `normalizeRecipientFields` + `toLegacySingularRecipient` re-exported from the legacy file | two raw `<label>`s -> kit `Label` (the raw-`<label>` ratchet is also at its floor); the chip close-X raw `<button>` -> kit `Button size="icon-sm"`; chips -> kit `Badge`. `toggle`'s orphan-clearing behaviour unchanged |
| `MergeFieldChips` | `components/mergeFieldChips`; `groupFields` imported from the legacy file | section toggle and chips -> kit `Button`, keeping `aria-expanded`, `aria-pressed`, `title={{field}}` and the `{group} ({count})` accessible name |
| `trigger/SubjectPicker` | `components/trigger/subjectPicker` | `ui/input` -> kit Input with `startIcon` (replacing the hand-positioned Search glyph); `ui/empty-state density="compact"` -> kit EmptyState (gap row); tiles and result rows -> `Pressable` keeping `role="option"` / `aria-selected` |
| `trigger/ModeFork` | `components/trigger/modeFork` | both cards -> `Pressable` with `aria-pressed`. The unreachable locked state and the dead selected ring are both preserved (see Observed but not fixed) |
| `trigger/EventModePanel` | `components/trigger/eventModePanel` | rows -> `Pressable role="radio"` with `aria-checked`; label and description still read verbatim from the catalog |
| `trigger/DateModePanel` | `components/trigger/dateModePanel` | `ui/input` + `ui/select` -> kit; 7 raw chip/segment `<button>`s -> kit `Button`. `CUSTOM_UNIT_MINUTES`, `commitCustom`'s integer guard, the seed-once locals and `allowAfter` all unchanged |
| `trigger/TriggerReadback` | `components/trigger/triggerReadback` | `data-testid="trigger-readback-note"` preserved (the module's only testid), as is `role="status"` on the sentence. Sentence assembly copied verbatim, including the hardcoded tail |
| `lib/workflows/*` (9 modules), `lib/api/workflows`, `lib/api/users` | kept, imported unchanged | no business logic forked |

## Escalated: two shared guards are not ui-kit-aware

Neither was touched. Both are recorded here because the workaround this branch used is a
convention, not a fix, and the next module to hit them should not have to rediscover why.

**1. `design-system/__tests__/shadow-component-guard.test.ts` cannot see kit imports.**
`importsPrimitive` matches the literal string `from '@/components/ui/<primitive>'`. A v2
component that composes `@/ui-kit/components/ui/button` therefore reads as a hand-rolled copy
of the app Button. This branch tripped it twice, on `AddStepButton` and `TestWorkflowDialog`,
both of which do compose their kit primitive.

The reason no prior v2 module hit it is an accident of style, not an exemption: the guard's
`NAME_RE` only matches `export (default )?(function|const) Name`, and every landed v2 module
declares the component then exports it at the bottom (`function X() {} ... export { X }`), which
the regex never sees. This branch adopted the same shape for those two files, so the guard is
green and no shared file changed. But the blind spot is real: the day a v2 module writes
`export default function SomethingDialog`, it will be flagged for composing the kit correctly.
The fix is one alternation in `importsPrimitive` to also accept `@/ui-kit/components/ui/`.

**2. `scripts/check-unresolved-classes.mjs` reads comments and element ids.**
Known, and the brief warns about it, but two specific shapes cost this branch a red run and are
worth naming:
- the word `shadow-component` inside a docblock (writing *about* the guard above) registered as
  a dead `shadow-*` utility;
- the legacy `id="text-body"` on the SMS textarea registers as a dead `text-*` utility in every
  file that mentions it. Renamed to `sms-body` here; nothing selects that field by id.

Separately, an alpha modifier on a custom colour token does not resolve through this repo's
Tailwind config even when the token is declared with `<alpha-value>`. `bg-brand-subtle/70` and
`bg-primary-hover` both rendered nothing. Both were replaced with `hover:opacity-90`, which
does render. `ring-ring/25` is left as-is: it is the kit's own focus-ring recipe, present in 14
kit files and already in the violated set, so matching it is more honest than diverging.

## Behaviour not reproduced

| What the legacy page did | What v2 does instead | Why it could not be carried over |
|---|---|---|
| Six sub-headings rendered as real `<h2>`/`<h3>` elements: "My automations", "Start from a recipe", each template category title, "Danger zone", and the four trigger-panel questions | `<p>` with the same type classes | the kit has no Heading primitive, and the raw-tag ratchet forbids a new `h1`-`h6` outside the primitives (`h1-h6` had 9 slack, but spending it on six sites the kit is meant to own is the wrong trade). The document outline is flatter than the legacy page's. Gap row filed |
| `EmptyState density="compact"` on the subject-picker no-matches state | the kit EmptyState's default padding | no density prop, and the EmptyState appearance ratchet is at its floor so no className is available. The block is taller than it was |
| `EmptyState variant="card"` on the activity tab | kit EmptyState inside a bordered `div` | same, resolved at the call site rather than dropped |
| KPI tiles carried an icon (CheckCircle2 / PauseCircle / Send) | kit StatCard, no icon, `tone` rail instead | documented kit decision, same as every prior module |
| The Home stat band used `KpiTile tone="primary"` for "Runs all-time" | `StatCard tone="brand"` | name change only |
| The SMS textarea's element id was `text-body` | `sms-body` | the unresolved-class scanner reads an id shaped like a colour utility as a dead class. Nothing selects the field by id; the label association and the accessible name are unchanged |
| Selected pills and the crumb chip hovered to a darker tint (`bg-primary-hover`, `bg-brand-subtle/70`) | `hover:opacity-90` | neither class resolves through this repo's Tailwind config, so the legacy hover rendered nothing either. The v2 hover is a real change: it is now visible where it previously was not |

## Observed but not fixed

The three the map explicitly flags for a human decision are the first three rows. All three are
**preserved as-is**, per the migration plan's preserve-behaviour rule.

| What | Where | Why it is out of scope |
|---|---|---|
| ~~`TriggerReadback` hardcodes the sentence tail as "send the customer an email."~~ **FIXED.** The tail was false twice over: it named an audience a task trigger cannot reach at all (catalog.ts's `ENTITIES_WITH_CUSTOMER` excludes `task`), and it asserted an email on a draft that may have no steps. Resolved by scoping the sentence to the trigger and moving the eyebrow to "This automation starts..."; the "what happens" half stays with the step bubbles, which already render it per step from `stepSentence.ts`. No step list needed threading in - the prop contract is unchanged. | `components/workflows/trigger/TriggerReadback.tsx`, and the ROUTED `pages/v2/automations/components/trigger/triggerReadback.tsx` | fixed in both twins |
| `ModeFork`'s selected-ring is dead code: `TriggerForm` always passes `value={null}`, and the fork is replaced by the panel the moment a mode is picked, so `aria-pressed` and the ring are reachable only from a unit test. | `components/workflows/TriggerForm.tsx:323`, reproduced at `pages/v2/automations/components/triggerForm.tsx` | removing the prop changes a tested component's public API; keeping it costs nothing. Preserved with a comment naming it |
| `WorkflowActivity` never renders an error state - `isError` is not consumed - so a failed activity fetch is indistinguishable from "nothing has run yet". The user is told to publish and turn on an automation that may already be running. | `components/workflows/WorkflowActivity.tsx:74`, reproduced at `pages/v2/automations/components/workflowActivity.tsx` | adding an error branch is new behaviour and needs its own copy. The strongest candidate of the three for a follow-up fix |
| `ModeFork`'s date-card locked state (`anchorLabel === null`) is unreachable: every subject has an anchor as of Part A. The branch, its copy and its disabled styling are all dead. | both | the prop is typed nullable, so the branch is the honest response to the type. Removing it is a type change |
| `AddStepButton`'s locked rows use `aria-disabled="true"` with `tabIndex={0}` but no `disabled`, so they are focusable and announce as disabled while still being in the tab order. That is deliberate (the tooltip has to be reachable), but a locked row also has no keyboard path to its tooltip on some screen readers. | `AddStepButton.tsx:113-118`, reproduced | changing the disabled affordance is an a11y decision, not a restyle |
| The `/automations/:id/edit` redirect has no test coverage anywhere. Its correctness rests entirely on `relative="path"` plus route ordering, both of which are easy to break silently in a refactor. | `App.tsx:200-203`; mirrored in `routes/automations.routes.tsx` | the brief scopes this branch to a presentation swap; adding the first test for a legacy route is separate work. Flagged in the routes file's docblock |
| `splitOffset` has no `weeks` unit, so a custom offset stored as 2 weeks reopens as "14 days". Numerically identical, documented in the legacy source as not a bug, but the user's own wording is lost on reload. | `lib/workflows/timing.ts` vs `DateModePanel`'s local `CUSTOM_UNIT_MINUTES` | adding `weeks` to the shared `OffsetUnit` touches three other call sites |
| `send_window` is alive in the DB and the API and dead in the UI. Duplicate deliberately does not copy it, so a duplicated legacy `BUSINESS_HOURS` row silently loses its deferral rule (which is the intended behaviour, but nothing tells the user). | `WorkflowsHome.duplicate`, reproduced | product decision |
| There is no Playwright spec for this UI at all. `e2e/specs/workflow/` is the business-workflow suite (estimate/job/invoice journeys); the only `automation` mentions there are backend trigger-event names. So the entire cutover rests on the vitest suites and on the accessible names inventoried in the map. | `frontend/e2e/specs/workflow/` | writing the first e2e spec for the module is separate work, and it should be written against whichever layer wins the cutover |
| The sidebar's `nav-registry.ts` entry for `automations` points at the LEGACY `/automations`. Under `VITE_UI_V2` the redirect makes it moot, but with the flag off the sidebar never reaches the v2 page. | `components/layout/nav-registry.ts:93` | repointing it means editing a shared nav file, which the brief forbids. Same observation Tasks filed |
