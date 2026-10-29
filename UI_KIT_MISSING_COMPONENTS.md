# Missing components - old UI still in use because the kit has no equivalent

Status: **complete.** Started 2026-08-04 in Phase 0, appended by every module branch.
Last consolidated after **all fifteen modules landed** (2026-08-05). This is the final roll-up.

> ## Follow-up pass, 2026-08-06 - what is no longer open
>
> A second pass closed most of the work this document had left standing. Read this box before
> trusting any section below it; where the two disagree, this box is newer.
>
> | Was | Now |
> |---|---|
> | **Section 5** - 87 v2 references into legacy page modules blocking cutover | **Closed.** Every one re-homed to `lib/`, `components/`, `styles/` or `pages/v2/_shared/`, with no re-export shims. `grep -rn "@/pages/" frontend/src/pages/v2 \| grep -v "@/pages/v2"` returns **0**. The count in section 5 was understated: 33 data/logic sites, not ~30, and 6 dashboard sites, not 5 |
> | **Section 2b** - `statCard` has no meta slot and ties delta tint to direction; `CardTitle` renders a `div` | **Closed.** `statCard` gained `meta` and `delta.goodDirection`, and passing `children` is now a compile error rather than a silent discard. A new `ui-kit/components/ui/heading.tsx` landed and `CardTitle` renders a real `h3` through it - which also closes the **#1 BUILD item**, `Heading`, hit by 13 of 15 modules. The icon slot stays deliberately absent; the docblock argument was re-examined and held |
> | **Section 3d** - five Inventory sub-views still render legacy chrome | **Closed.** All five rebuilt on the kit. Two Badge/Card ratchets were at their ceilings; the four offending overrides were **removed rather than re-baselined**, and every consequence is logged in `md_files/plans/ui-redesign/gaps/inventory-missing-components.md` |
> | **Section 3d** - four rebuilt Schedule components have no v2 coverage | **Closed.** Four suites ported, 60 tests, each validated by breaking the v2 component and watching it go red |
>
> **Two shell gaps this document never recorded**, found by a browser cross-check rather than by
> reading code: the v2 topbar dropped the organisation name and logo that `layout/Header.tsx` has
> always carried, and the v2 sidebar had no Customize control. Both are now closed. Both shells
> read the same per-user localStorage layout, so a reorder persists across them.
>
> **One defect this document could not have recorded**, for the same reason: `/v2/inventory`
> rendered its Category column clipped. Cause was the kit table's `table-layout: auto` against
> legacy's `table-fixed` - the browser recomputes widths from content, so the sticky offsets for
> pinned columns, which accumulate the *assigned* widths, park every pinned column after the first
> at an edge that is not its own. Five of the six pinned tables were affected. Fixed by measuring
> rendered widths.
>
> **The five rebuilt Inventory sub-views are covered too** - seven suites, 56 cases, each validated
> by breaking the v2 component and watching it go red *while the legacy suite stayed green in the
> same run*, which is what proves the two files target different components. That work turned up
> the sharpest fact in this box: **there is no legacy `StagingView` suite anywhere in the repo.**
> Nothing imports `components/inventory/StagingView`. The 821-line view had no coverage on either
> layer, and its new suite is its first. `loList` was promoted to `pages/v2/_shared/` for the cost
> of one import line, so `pages/v2/jobs/JobDetailPage.tsx` now renders the v2 list and the Jobs
> Logistics tab no longer shows legacy chrome inside a v2 page.
>
> **Still open:** the remaining section 2b kit API gaps, the section 6 catalogues, and the KEEP
> list. Three kit-level findings are new, all raised by the Inventory port and all deliberately not
> chased there, because each would move every v2 list at once:
> - The DataTable's resize grip folds a `role="separator"` `aria-label` into every column header's
>   accessible name, so a header called "Anchor" answers to `Anchor Resize Anchor column`. Nothing
>   is lost visually, but it breaks `getByRole('columnheader', { name })` for every future port.
> - The DataTable footer's rows-per-page `Select` has no accessible name, leaving two unlabelled
>   comboboxes on Low stock distinguishable only by order.
> - `tsconfig` excludes `src/__tests__` but not `src/pages/**/__tests__`, so a ported suite is
>   typechecked where its original was not. Worth knowing before the next port.
>
> Two behaviour deltas worth carrying into the cutover decision, both from the Schedule port:
> v2 renders call and text affordances as kit Buttons assigning `window.location.href` where legacy
> renders `<a href="tel:">` - same destination, but no middle-click, no copy-link, and they are
> absent from a screen reader's link list, a consequence of the raw-anchor ratchet being at its
> floor. And the v2 context menu is protected from `SchedulePage`'s outside-click dismissal while
> the legacy one is not, because the page skips `[class*="z-["]` and only the v2 surface matches.

Rule this file records (from the migration brief): where the CRM UI kit has no equivalent for an
old component, the **old component is used** and the gap is written down here. Nothing is
half-built and nothing is silently dropped.

Each row says what is missing, where the old component is still used, and a recommendation:

- **BUILD** - worth adding to the kit; it is generic and used in many places
- **KEEP** - specific enough that a kit version would have one caller; leave it as is
- **DROP** - the v2 pages do not need it; it goes away at cutover

Two things changed since the Wave A consolidation and they change how this document reads:

1. **Two of Wave A's kit-API gaps were closed mid-migration**, not deferred to cutover. The
   `DataTable` state props and the `Button` `asChild` defect are now history, with tests. They are
   recorded in section 2 as history rather than as open gaps, because the argument for fixing the
   rest of section 2 is that these two got fixed and the workarounds went away.
2. **Fourteen of the fifteen modules wrote a ledger.** Leads did not, and one is not coming - see
   section 9. Where a count below includes Leads it is a code observation or another module's
   report, never a Leads row, and it is labelled as such.

---

## 1. The BUILD list, ranked by how many modules hit it

This is the section to read. A gap reported once is a module's opinion. A gap twelve modules
solved separately is a hole in the kit.

Fifteen numbered modules ran: **Dashboard** (01), **Leads** (02), **Customers** (03),
**Estimates** (04), **Jobs** (05), **Invoices** (06), **Schedule** (07), **Tasks** (08),
**Reports** (09), **Inventory** (10), **Settings** (11), **Communication** (12),
**Auth/Public** (13), **Automations** (14), **Service Plans** (15). The Phase 0 **Shell** is
counted separately where it contributes, because it is not one of the fifteen.

"Hit by" counts modules whose code had to work around the gap, verified in the tree. "Filed
BUILD" counts modules that wrote a BUILD row, which is always a smaller number - the same absence
was often logged as a shape difference, a delta or an observation instead.

### The top seven

| # | What to build | Hit by | Filed BUILD | Evidence |
|---|---|---|---|---|
| 1 | **Tabs** (`TabStrip` + `TabPanel`) | **12 of 15** - Leads, Customers, Estimates, Jobs, Invoices, Tasks, Reports, Inventory, Settings, Communication, Automations, Service Plans | 11 (all but Leads, which authored the workaround) | Ten modules import `pages/v2/leads/components/tabs.tsx` **verbatim** - verified importers: automations, communication, customers, inventory, invoices, jobs, reports, service-plans, settings, tasks. Nobody forked it. Estimates filed a BUILD row for a tab component but has no tab strip in v2 at all; its sibling-estimate navigator (`features/estimate-workspace/EstimateTabs`) is imported unchanged. **Not hit: Dashboard, Schedule, Auth/Public** |
| 2 | **Heading** | **13 of 15** - everything except Schedule and Service Plans | 6 (Customers, Jobs, Reports, Inventory, Settings, Automations) | `role="heading" aria-level={n}` on a `<p>`, `<span>` or `<div>` is the workaround in ten modules, counted by file: auth-public 6, settings 8, inventory 4, customers 3, jobs 3, communication 2, invoices 2, leads 2, estimates 1, reports 1 (a single `pages/v2/reports/components/heading.tsx` imported by **19** report files). Tasks and Automations dropped to a plain `<p>` with **no** heading role, so their document outline is flatter than the legacy page's. Dashboard's widget titles moved to the kit's `CardTitle`, which renders a `div` - same loss by a different route. The raw-tag ratchet for `<h1>`-`<h6>` is at its floor, so no v2 page may author a real heading tag, and `layout/pageHeader` only titles a page. **Auth/Public filed DROP** - see section 8 |
| 3 | **A FormField that works without react-hook-form** | **8 of 15** - Leads, Customers, Jobs, Schedule, Tasks, Settings, Service Plans, Auth/Public | 4 (Customers, Service Plans, Jobs, Schedule) | Re-verified on the final tree: `ui-kit/components/form/formField` is imported by **zero** files under `pages/v2/`. Customers wrote a local 12-line `Field` twice; Jobs wrote its own; Settings wrapped one as `components/field.tsx` (`Field` / `SettingRow`); Leads, Service Plans and Auth/Public use bare kit `Label` plus a hand-written `htmlFor`/`id` pair per field; Schedule and Tasks use kit `Label` plus a flex column. Auth/Public's ids are load-bearing (`e2e/global-setup.ts` locates `#email` / `#password`), and the kit's FormField generates its own. **Auth/Public filed KEEP** - see section 8 |
| 4 | **A data-bound tag surface** (`TagInput` + `TagChips`) | **6 of 15** - Leads, Customers, Estimates, Jobs, Invoices, Schedule | 3 (Customers, Estimates, Schedule) | All six import `leads/TagInput` and/or `data/TagChips` unchanged. Verified in the kit source: `crm/tagInput` takes `value: string[]` and emits `onValueChange` - free text, no org vocabulary, no `POST/DELETE /api/{entity}/:id/tags`. `ui/badge` has a closed variant vocabulary and `tag.color` is runtime user data applied as an inline style. **The recommendation is contested three ways** - see section 8 |
| 5 | **A toggle group / segmented control** | **8 of 15** by workaround - Schedule, Reports, Settings, Automations, Communication, Inventory, Service Plans, Tasks | 4 (Schedule, Reports, Settings, Automations) | Every one is a `role="group"` or `role="radiogroup"` of kit Buttons carrying `aria-pressed`, which the raw controls never had. File counts: reports 8, automations 5, settings 5, communication 4, schedule 3, inventory 2, service-plans 1, tasks 1. Schedule needed it four times in one module (Standard/Member, Day/Week/Month, Full day/Morning/Afternoon, Jobs/Walkthroughs) and built `components/segmented.tsx`; Reports needed it in 11 reports. It was item 13 on the Wave A "not yet reached by any module" list - Schedule reached it first |
| 6 | **RadioGroup** | **5 of 15** - Customers, Service Plans, Settings, Reports, Automations | 2 (Service Plans, Settings) | `role="radiogroup"` of kit Buttons carrying `role="radio"` + `aria-checked`, verified in all five. **Not a kit-only gap:** `frontend/src/components/ui/` has no radio primitive either, and the raw-tag ratchet for `<input>`/`<label>` is at its floor, so no module could fall back to natives. Overlaps item 5 - both are the same absence (an exclusive-choice control) wearing two shapes, and one primitive with a `type` axis would close both |
| 7 | **A confirm dialog with an icon slot and a body slot** | **6 of 15** - Schedule, Estimates, Invoices, Jobs, Inventory, Settings | 1 (Schedule) | Schedule filed it precisely and built `pages/v2/schedule/components/confirmDialog.tsx`, because all three of its confirmations exist to show a body. The other five recorded the identical absence as "confirmDialog has no free-text reason field" or "bespoke multi-sentence bodies": Estimates (`CancelEstimateDialog`, `DeclineEstimateInternalDialog`, `VoidApprovalDialog`), Invoices (`VoidInvoiceDialog`, `DeleteInvoiceDialog`), Jobs (`CancelJobDialog`, `BulkCancelJobsDialog`), Inventory (`DeleteItemDialog`, `DeleteVendorDialog`), Settings (all five confirms). Six modules, one prop pair. Verified in the kit source - see section 2 |

### The rest of the BUILD list

| # | What to build | Hit by | Notes |
|---|---|---|---|
| 8 | **An image / thumbnail primitive** | **5** - Auth/Public, Settings, Inventory, Estimates, Jobs | The kit ships no image component; `ui/avatar` covers the 34-46px circular chip and nothing else. The raw-`<img>` ratchet is at its floor (38/38), so a page cannot author its own. Auth/Public, Settings and Inventory filed BUILD; Estimates filed KEEP on `ui/thumbnail`; Jobs cannot re-author `AttachmentsTabBody` partly for this reason. Inventory's Price Book hero photos ride as a CSS `background-image` because Avatar cannot do a 2:1 banner |
| 9 | **An anchor / link primitive** | **6** - Auth/Public, Jobs, Inventory, Schedule, Leads, Invoices | The raw-`<a>` ratchet is at its floor (44/44). Auth/Public, Jobs and Inventory filed BUILD; Schedule, Leads and Invoices worked around it with `variant="link"` Buttons that set `window.location.href`, or `window.open`. Inventory's brand Website link loses middle-click, open-in-new-tab and the URL on hover. **Wave A filed this as DROP** - see section 8 |
| 10 | **`ui/collapse`** | **2** - Reports, Schedule | Both import the legacy `@/components/ui/collapse` unchanged (`reports/reports/ArAgingReport.tsx:11`, `schedule/components/unassignedBuckets.tsx:11`). It was item 15 on the Wave A "present in the old set, absent from the kit, not yet reached" list; Schedule reached it first and Reports second. The kit has no accordion, no disclosure and no collapse |
| 11 | **A headless clickable surface** (`Pressable`) | **2** - Automations, Tasks | Automations built `pages/v2/automations/components/pressable.tsx` for 12 sites across 7 files (card bodies, listbox options, radio rows, subject tiles, menu rows). Tasks solved the same raw-`<button>`-at-floor problem inline in `views/CalendarView.tsx` with `span role="button" tabIndex={0}`. Would also be satisfied by `asChild` on Button without its CTA paint |
| 12 | **A TimePicker / DateTimePicker beside `form/datePicker`** | **2** - Schedule, Tasks | The kit picker is date-only. Schedule imports `form/TimeSelect` unchanged (a native `<input type="time">` is not an option: the page's outside-click listener whitelists `[data-radix-popper-content-wrapper]`). Tasks rebuilt `form/DateTimePicker` on kit `Popover`+`Calendar`+`Select` because a native picker cannot be dismissed from inside a modal Radix Dialog (#430) |
| 13 | **`crm/noteEditor` needs a data-bound wrapper** | **2** - Estimates, Jobs | The kit's editor is a composer; `features/estimate-workspace/NotesCard` and `jobs/overview/JobNotesPreview` each own the fetch, the post, the list and the invalidation pair |
| 14 | **`crm/kanbanBoard` needs a `renderCard` prop** | **1** - Tasks | Three separate rows from one module: `KanbanItem` makes `type: WorkType` mandatory (a task has no work type, so every card would announce fabricated data); `kanbanBoard` hardcodes `KanbanCard` with no render slot; `kanbanColumn` ships an unconditional kebab Button with no handler and a hardcoded `No items in this stage` empty string. The column IS used, so the dead kebab is live in the v2 board |
| 15 | **A combobox with a second (facet/type) axis** | **1** - Tasks | `LinkedEntitySelect` has a type axis (Job/Lead/Customer/Estimate) that re-points the query at four endpoints. The same shape would cover `crm/CustomerPickerWithCreate` and `crm/PickOrAccreteLocation` |
| 16 | **`data/timeline` + `ui/sheet` fetching HistoryPanel** | **1** - Estimates | The kit's timeline is a static renderer; `HistoryPanel` owns the query and the event vocabulary |
| 17 | **`filters/RangeSlider`** (dual-handle numeric range) | **1** - Estimates | Estimates' filter popover lost the dual-handle slider outright; the kit ships none |
| 18 | **A file-drop primitive** | **1** - Inventory | CSV import drag-and-drop intake. `ImportCSVDialog` is imported whole |
| 19 | **`layout/GlobalSearch` behind `TopBarSearch`** | Shell | See 6a |
| 20 | **`NotificationBell` + `NotificationPanel`** behind `TopBarAction` | Shell | See 6a |
| 21 | `alert`, `chip` | **0 of 15** | Present in the old set, absent from the kit, and **never reached by any of the fifteen modules** - verified: no file under `pages/v2/` imports either. They are the two Phase 0 directory-level predictions that turned out not to matter. `toggle-group` and `collapse`, the other two, were both reached |

**Twenty-one BUILD items** after fifteen modules, against sixteen after six. The Phase 0 version of
this file said that a BUILD list past roughly a dozen is the honest signal that the kit is not yet
a complete design system for this app. That line was crossed in Wave A and the migration finished
anyway - which is the useful result. The list did not grow the way it grew in Wave A: nine of the
ten new modules added no new item to the top seven, they added weight to the existing ones. Items
1 to 7 are the whole argument. Each was hand-rolled by five or more independent branches.

---

## 2. Kit component API gaps

Different from a missing component. The component exists, it is the right component, and its props
do not let a page use it. **Every claim below was re-checked against the kit source on the final
tree**, not carried forward from a ledger.

### 2a. Closed during the migration (history, not open gaps)

These are here because they are the argument for closing the rest.

| What | Fixed by | Evidence |
|---|---|---|
| **`DataTable` could not express sorting, selection, column visibility, a saved view, pinned columns, per-column resize or a mobile layout** | `93362f4a feat(ui-kit): let DataTable express sorting, selection, visibility, saved views, pinning, resize and cards`, adopted by all five v2 lists in `9387ce86` | `DataTableProps` now declares `sorting`/`onSortingChange`/`manualSorting`, `rowSelection`/`onRowSelectionChange`, `columnVisibility`/`onColumnVisibilityChange`/`defaultColumnVisibility`, `savedView`, `enableColumnResizing` and `mobileCards`. A `useTableState` helper gives each one three modes (controlled, observed, internal). `frontend/src/pages/v2/__tests__/listTableAdoption.test.tsx` covers all five lists across sorting, selection, default visibility, saved-view restore and save, pinning, resize grips and the card layout, and names which assertions were red before |
| **`Button` threw for every `asChild` caller** | `35c02cd4 fix(ui-kit): make Button usable with asChild` | `{children}` is now wrapped in Radix `<Slottable>`. Regression test at `frontend/src/ui-kit/__tests__/button-aschild.test.tsx`, three cases including the spinner-alongside-slotted-child path. The Auth/Public ledger found it and named the two already-merged sites that were crashing (`customers/components/detailTabs.tsx`, `customers/CustomerDetailPage.tsx`); the test's own docblock names the same two |

Two consequences worth stating plainly, because several ledgers still describe the old world:

- **`frontend/src/pages/v2/invoices/components/tableEffects.tsx` no longer exists.** Its
  `DefaultHiddenColumns` and `SelectionBridge` render-nothing components were deleted when
  `defaultColumnVisibility` and `rowSelection` landed.
- **`frontend/src/pages/v2/customers/components/bulkBar.tsx` still exists but is now presentation
  only** - the selection lives in the page's `useScopedRowSelection` and reaches the table through
  `rowSelection`/`onRowSelectionChange`. Its own docblock says so.
- **The per-user saved column layout is back.** `pages/v2/savedViewMenu.tsx` renders Save current
  view / Reset column widths for all five lists against the same `/api/me/table-views/:key` record
  the legacy lists write. This retires the single largest "behaviour not reproduced" row of Wave A.

The Settings ledger (committed 08-05 03:43) still records `sorting` / `rowSelection` /
`columnVisibility` / `tableKey` as "props do not exist". The DataTable commit landed at 03:22, so
that row is stale by 21 minutes. Settings converted no table, so nothing in the module is wrong -
only the row.

### 2b. Open

| Kit component | The gap | Hit by | Verified |
|---|---|---|---|
| `data/dataTable` | **No `<tfoot>` and no below-body slot.** `children` renders above the body, so there is no way to put a totals row under the columns it totals | **1** - Reports | Confirmed: no footer slot anywhere in `dataTable.tsx`, `dataTableToolbar.tsx` or `dataTablePagination.tsx`. **Count correction:** the brief says nine report tables. The Reports ledger says both things - its gap row enumerates ten table instances (ArAging, Commissions x2, Expenses, Invoices, JobProfitability, Payments, Sales, TechPerformance, Timesheets) across nine reports, and its behaviour row says "9 tables". Ten table instances, nine reports. Totals now render as a labelled `ReportTableTotals` strip beneath the table |
| `data/dataTable` | **No `rowClassName`** - no way to tint a row from its own data | **1** - Reports (4 tables: ItemsServices, Expenses, CampaignRoi, JobStatistics) | Confirmed absent. In each of the four the signal survives in a cell or a badge, so nothing became unreadable |
| `data/dataTable` | **No `stickyHeader`, no `flat`** - the table always draws its own card frame and never scrolls its own body | **1** - Reports (2 tables: JobStatistics call-back history, EstimateConversion drill) | Confirmed absent |
| `data/dataTable` | **No row virtualization** | **3** - Jobs, Inventory, Customers | Confirmed absent, and **deliberately so**: the source carries a `NOT HERE: row virtualization` block explaining that `useVirtualizer` needs a measurable scroll viewport and this table grows to its content while the page scrolls. Jobs filed BUILD, Inventory filed **KEEP (scoped out by decision)** - see section 8 |
| `data/dataTable` | **No per-header context menu** | **1** - Jobs | Confirmed: column visibility lives in `DataTableViewOptions` inside the toolbar, not on the header. This is a relocation rather than a loss, and no module reported a user-facing consequence |
| `ui/progress` | **No `tone`.** The indicator hard-codes `bg-brand`, so a threshold meter's colour cannot carry its warning | **2** - Reports, Communication | Confirmed: `<ProgressPrimitive.Indicator className="bg-brand h-full w-full flex-1 …">`, no variant axis. **Correction to the brief:** two modules, not one. Reports' comm-tracking `CadenceTab` and Communication's `planUsage` both hand-built a bar out of kit status tokens rather than delete the warning band. Communication's ledger puts it bluntly - substituting `ui/progress` "silently deletes the limit warning" |
| `data/statCard` | **No icon slot** (deliberate), **no meta / sub slot**, and the **delta tint is keyed off `direction`** | icon: ~10 modules, accepted by all but two. meta slot: **3** - Dashboard, Reports, Inventory. delta tint: **1** - Dashboard | All three confirmed. `StatCardProps` is `label`, `value`, `delta`, `tone`, `active`, `loading` - it spreads `...props` onto the host then supplies its own JSX children, so a passed `children` is discarded. `const deltaVariant = { up: "softGreen", down: "softRed", flat: "softNeutral" }` is the whole sentiment model, so a falling cost cannot read as good. The docblock says "Deliberately no icon tile" and gives the reason. **The meta slot is the one that costs information:** all ten of Dashboard's `kpi.*` tiles carry a meta line (`"42% of $80,000 goal"`, `"3 jobs done"`, `"12 won · 4 lost · 30d"`) and adopting StatCard would delete a line of real data from every one, which is why `pages/dashboard/widgets/KpiCard` is reused whole. Reports carries the same need across 22 call sites; Inventory truncated its caption strings into the `delta` chip and lost the long form |
| `ui/card` | **`CardTitle` renders a `div`**, so a card title is outside the heading outline | **1 filed** - Dashboard; structurally every module | Confirmed: `function CardTitle({...}: React.ComponentProps<"div">)` returning a `div`. Dashboard is the only ledger that names it, and names it honestly as "the one accessibility difference from the legacy shell". It compounds item 2: a v2 page can neither author a heading tag nor get one from the kit |
| `ui/confirmDialog` | **No icon slot, no body slot** | **6** - see BUILD item 7 | Confirmed: `ConfirmDialogProps` declares `open`, `onOpenChange`, `title`, `description`, `confirmLabel`, `cancelLabel`, `isPending`, `destructive`, `onConfirm` - and nothing else. `<AlertTriangle />` is hardcoded inside a `DialogIcon`, and the component renders no children |
| `data/emptyState` | **No `density`, no `variant`** | **6** - Schedule, Reports, Settings, Automations, Inventory, Tasks | Confirmed: `EmptyStateProps` is `icon`, `title`, `description`, `action` over a fixed `px-5 py-11`. The legacy `ui/empty-state` takes `density="compact" \| "flush"` and `variant="card"`. The EmptyState appearance ratchet is at its floor (5/5), so a call-site `py-` override is not available either. Inside a 240px Schedule sidebar bucket that is a lot of whitespace; Automations wrapped the kit state in a bordered `div` to get `variant="card"` back |
| `ui/card` | **No `tone`, no `padding`** | **3** - Auth/Public, Settings, Service Plans | Auth/Public has 13 banner sites that were `Card tone="success\|warning\|danger\|info\|neutral"`; the `Card` appearance ceiling is at its floor (2/2) so a `className` tint is not available. Worked around with a plain tinted div (`publicShell.tsx`'s `PublicNotice`). Settings wrapped the padding problem once as `components/section.tsx`; Service Plans moved `padding="lg"` empty cards to `data/emptyState`. Auth/Public files `padding` as KEEP - a different authoring model rather than a gap |
| `ui/table` | **`TableCell` has no `align` / `weight` / `tone`** | **3** - Auth/Public, Reports, Settings | The `TableCell` appearance ceiling is at its floor (3/3), so the classes cannot go on the primitive. All three landed on the same fix independently: an inner span or block wrapper. Reports named theirs `components/td.tsx` and it covers 60 call sites |
| `ui/button` | **No `tone` axis** | **1 filed** - Auth/Public; remapped silently by every other module | Six flat variants and no tone. `destructive` is a solid red, too loud for a secondary Decline sitting beside Approve, so both public Decline controls are plain `outline`. Every module reports the same `variant`+`tone` -> `variant` remap in its Replaced table |
| `ui/input` | **No `invalid` prop** | **1** - Settings | `aria-invalid` only. That is what drives both the styling hook and assistive tech, so it is a shape difference more than a gap |
| `ui/dialog` | **`DialogHeader` is a flex ROW**, so a title and its description sit side by side unless wrapped | **1** - Schedule (worked around at five call sites) | A `DialogHeaderText` part, or a row/column prop, would remove the trap |
| `crm/kanbanBoard` | **`kanbanColumn` renders a dead kebab and a hardcoded empty string** | **1** - Tasks | Using the column ships a visible `MoreHorizontal` control that does nothing, confirmed in the rendered DOM by the module's own test. Suppressing it means editing a shared kit file |
| `form/formField` | **Cannot be used outside a react-hook-form context** | **8** - see BUILD item 3 | Re-verified unchanged on the final tree. `useFormField()` calls `useFormContext()` and destructures `getFieldState` from it; RHF's form context is `createContext(null)`, so outside a `<Form>` the destructure throws a TypeError immediately. The explicit `if (!fieldContext) throw new Error(...)` guard below it is still **unreachable** - `FormFieldContext` defaults to `{}`, which is truthy, and the destructure has already thrown. That detail matters only because someone fixing this will otherwise delete the wrong line |

---

## 3. Behaviour NOT reproduced in v2

Read this before cutover. Every row is a thing a legacy page does that the v2 page does not, drawn
from every ledger that recorded one. It is longer than Wave A's because Wave A had nowhere to put
these; the `gaps/README.md` format added a required section and it worked.

### 3a. Lists and tables

| What the legacy page did | What v2 does | Module |
|---|---|---|
| `ResizableTable` virtualized rows past 40 | No virtualization at any row count | Jobs, Inventory, Customers |
| The Inventory Stock table rendered every filtered row in one scrolling table | The kit DataTable **pages client-side at 25**, with its own footer. The kit table has no virtualizer and always mounts `getPaginationRowModel`; rendering an unpaged catalog would mount every row | Inventory |
| A per-header context menu on the legacy table | Column visibility moved into the toolbar's view-options menu | Jobs |
| The Inventory Stock table had a header checkbox and per-row checkboxes | Dropped. They were decorative - no `checked`, no `onChange`, no bulk bar anywhere on the page | Inventory |
| 9 report tables rendered a `<tfoot>` totals row aligned under its columns | A labelled `ReportTableTotals` strip immediately beneath the table, each entry keeping its column header as its label | Reports |
| ItemsServices tinted a row over expected by more than 15%; Expenses tinted the expanded row; CampaignRoi tinted the most-profitable row; JobStatistics tinted the selected tech row | No tint in any of the four. In each case the signal already exists in a cell, a badge or a heading | Reports |
| JobStatistics call-back history was `stickyHeader` + `flat` inside a card, capped at `max-h-96`; EstimateConversion's drill table was `flat` | Normal tables, page-scrolled, each drawing its own card frame | Reports |
| Reports' `ResizableTable` kept per-user column WIDTHS in internal state | Widths are per-session. Pre-existing: `ResizableTable` never persisted them either. The Fields VISIBILITY list still persists, per report, in localStorage (`jobsReport.visibleFields.v1` and siblings) | Reports |
| Inventory lists had per-user saved column layouts | Not wired. No legacy inventory list passed `tableKey` (all six call sites checked), so there is no stored layout to carry into `savedView`. Left unwired rather than inventing new keys | Inventory |

**Resolved since Wave A and deliberately not listed above:** the per-user saved column view on
Customers, Estimates, Invoices, Jobs and Leads. Wave A recorded it as the one list behaviour v2 did
not reproduce; the `savedView` prop and `pages/v2/savedViewMenu.tsx` restored it, and
`listTableAdoption.test.tsx` pins it for all five. Pinned columns, per-column resize and the
sub-`md` card layout were restored in the same pass.

### 3b. Navigation, chrome and copy

| What the legacy page did | What v2 does | Module |
|---|---|---|
| Inventory breadcrumbs read `Operations > Inventory > Vendors` / `> Purchase Orders` | They read **`Home > Operations > Vendors`** / `> Purchase Orders`. `PageBreadcrumbs` derives the middle crumb from the nav registry, and `inv-vendors` / `inv-pos` are CHILD entries that `getDestination` cannot resolve (`BY_KEY` is built from top-level rows only). `/inventory/price-book` is unaffected - `pricebook` is a top-level key, so it still reads `Home > Inventory > Price Book` | Inventory |
| `SettingsLayout`'s close `X` and the popstate escape hatch navigated to `/` | They navigate to `/v2`. Same destination page, v2 chrome | Settings |
| Inventory tile sub-copy was a full caption line under the value ("filtered, click to clear", "of 4 total, click to show only active") | Shortened into StatCard's `delta` chip, which is a short pill beside the value, not a caption line | Inventory |
| KPI tiles carried a lucide icon (every module) | No icon. StatCard has no icon slot by design | Reports, Inventory, Tasks, Automations, Dashboard, and every list module |
| ReportCard drew a 3px left accent bar and lifted on hover; ReportShell drew a round icon medallion beside the title | A hover fill on the link, no lift, no medallion. The accent-bar hover class was one of the 54 the unresolved-class guard reports as producing no CSS, so it never drew | Reports |
| `EmptyState density="compact"` / `"flush"` / `variant="card"` in panels, sidebars and pickers | The kit's single padded shape (Automations wraps it in a bordered div to get the card back) | Schedule, Reports, Settings, Automations, Inventory |
| `PriceBookPage`'s visibility options read `🌐 Catalog only` / `🔒 Internal only`; the PO page's clear chip carried a literal `×` | Plain text options; an icon-carrying ghost Button | Inventory |
| Six Automations sub-headings were real `<h2>`/`<h3>` elements | `<p>` with the same type classes. The document outline is flatter | Automations |
| Dashboard widget titles were `Heading level={2}` -> a real `h2` | `CardTitle` -> a `div`. Widget titles leave the heading outline | Dashboard |
| Automations' selected pills and crumb chip hovered to a darker tint (`bg-primary-hover`, `bg-brand-subtle/70`) | `hover:opacity-90`. Neither legacy class resolves in this Tailwind config, so the legacy hover rendered nothing - **the v2 hover is a real change, visible where it previously was not** | Automations |
| Schedule's plan-mode banner was a two-stop amber gradient; its banner actions used `variant="onDark"` | A flat `status-amber` fill; kit `secondary` and `default`. The kit has no gradient ramp and no on-dark variant | Schedule |
| Auth/Public: Decline was `outline`+`danger`, Approve was `solid`+`business`; the login card was `shadow-xl ring-1 ring-border` | Plain `outline`, the kit default solid, and the kit Card's own `shadow-sm` + border | Auth/Public |
| Six Auth/Public strings carried a U+2014, U+2013 or U+2212 | The same strings with plain hyphens. Checked against every committed assertion first - no e2e or unit matcher spans a dash | Auth/Public |
| Dashboard's five em-dash strings (header subline, Needs Attention empty state, edit-toolbar copy, `formatTime(null)`, Unassigned lane placeholder) | Plain hyphens. No test reads any of them | Dashboard |
| The sidebar's Customize toggle read `✎ Customize` / `✓ Done` and sat under a `SIDEBAR` eyebrow above the nav | A kit ghost Button carrying a lucide `Pencil` / `Check`, in a `SidebarToolbar` block in the same position. Same wording, same place; the two glyphs are icons rather than literal characters, which is the kit's idiom everywhere else | Shell |
| The legacy Customize toggle was a raw `<button>` with a "Raw by design" note: a translucent pill (`bg-on-fill/10` idle, `/20` hover) that no Button cell carried **on a dark sidebar** | The v2 sidebar is transparent on the light page surface, so the reasoning does not carry: the kit's `variant="ghost"` is exactly that treatment there. Built on the primitive, not raw. The legacy note stays true of the legacy sidebar | Shell |

### 3c. Losses with a functional edge

| What the legacy page did | What v2 does | Module |
|---|---|---|
| InboxPage rendered a per-message **account dot** (`mAcct.dot`) | The provider NAME is shown; the coloured dot is not. `ACCOUNTS[].dot` is a raw Tailwind palette class (`bg-red-500`) handed out by the data seam, and rendering it would put a raw palette class in a v2 component. The seam has to hand out a token or a variant name instead. **Flagged, not fixed** | Communication |
| `PriceBookPage`'s brand "Website" was `<a target="_blank">` | A link-styled Button calling `window.open(safeHref(url), '_blank', 'noopener,noreferrer')`. Loses middle-click, open-in-new-tab and the URL on hover | Inventory |
| Not-authorized "Go back" was a real `<a href="/">` | A `<button>` calling `navigate('/v2')`. Same loss of middle-click | Auth/Public |
| `PriceBookPage` Groups/Categories hero photos were `<img>` in an `aspect-[2/1]` box | The same box with the photo as a CSS `background-image` | Inventory |
| The Inventory Stock detail panel was a `w-96` aside pinned in a full-height flex row with `animate-panel-in` | Kit `MasterDetail`'s detail pane (24rem) with a narrow-viewport stack and a "Back to items" control. The entry animation has no kit counterpart | Inventory |
| Inventory toasts were bespoke fixed-position divs with hand-rolled 2.5-4.5 s timers, one per page | One kit sonner toast. Dismissal timing is now the toaster's | Inventory |
| PhonePage's `ModulePlaceholder` and its `SECTION_META` | Not ported - dead code. The branch that renders it is `section !== "calls"` and every non-calls section has its own branch above it, so nothing can reach it | Communication |
| Tasks' board empty column read `Empty` | `No items in this stage`, hardcoded in the kit column with no prop | Tasks |
| Tasks' board had no column kebab | A dead `MoreHorizontal` button, hardcoded in the kit column with no prop | Tasks |
| Tasks' board drag was native HTML5 `dataTransfer` | `@dnd-kit` with a `KeyboardSensor`. This REPLACES an interaction rather than adding one, and adds the keyboard path HTML5 DnD cannot have. Drop semantics identical | Tasks |
| Branding's brand-colour hex Input took an `invalid` prop as well as `aria-invalid` | `aria-invalid` only | Settings |
| `/auth/callback` under `VITE_UI_V2=true` | **Still renders the LEGACY page.** `lib/auth-listener.ts` pins its OAuth race-guard to the exact pathname `/auth/callback`; a `/v2`-prefixed path would let the global listener race `finalizeOAuthLogin()` and `GET /api/auth/me` would 401 the not-yet-finalized Google identity. The v2 page is built and routed at `/v2/auth/callback` but is not registered for the flag redirect. **Escalated - a shared-file change** | Auth/Public |
| `NotAuthorized` under a failed v2 role check | Renders the LEGACY page inside `V2AppLayout`. `components/ProtectedRoute.tsx` imports `pages/NotAuthorizedPage` directly. **Escalated - a shared-file change** | Auth/Public |
| Invoices' chip-bar "Clear all" cleared facets AND the search box | Clears facets and resets to page 1; the search box keeps its value. The search box gained its own Reset in the table toolbar, so nothing is unreachable | Invoices |
| Schedule's `errorToast` was a manually dismissed page-owned surface | **Deliberately kept hand-rolled**, not routed through sonner: sonner auto-dismisses after 4s and would drop a failed schedule write off the screen while the user was still looking at the board. The ten advisory one-way toasts DO go through sonner | Schedule |
| The sidebar is ONE flat list, so a Customize drag can move a shortcut anywhere in it | The v2 sidebar buckets rows by `pages/v2/navSections.ts`, which decides FROM THE KEY which heading a row appears under. A drag within a section reorders and persists exactly as legacy does; **a drop into another section is ignored**, because honouring it would move the key in the stored array and change nothing on screen - the section map would put the row straight back. **Logged, not fixed:** closing it means either letting the user reorder the sections themselves or making section membership per-user data, and both are a design decision about the v2 nav, not a port | Shell |
| Customize could reorder or unpin any row it showed, because every row was a top-level registry key | Group children are lifted to flat siblings here, and a child key (`inv-vendors`, `comm-whatsapp`) is not in the registry's top-level map at all - it can never be pinned. So editing shows only the pinned keys and the lifted children drop out for the duration. This is what the legacy sidebar does too (it flattens its groups while editing); the visible difference is only that v2 shows those children when NOT editing | Shell |

### 3d. Two structural items that are not component gaps at all

> **CLOSED 2026-08-06** on `refactor/ui-kit-18-inventory-views`. All five are rebuilt under
> `frontend/src/pages/v2/inventory/components/` (`stagingView`, `assetsView` +
> `assetHistoryPanel`, `lowStockView`, `actionLogView`, `loList`) and the v2 `InventoryPage`
> imports those instead. The legacy components are untouched and still serve the legacy routes,
> and `lo/LOList` is still what the jobs and service-plans v2 modules mount. Per-view detail,
> KEEP rows and appearance deltas: `md_files/plans/ui-redesign/gaps/inventory-missing-components.md`,
> section "Slice 2". The paragraph below is the original finding, kept as the record.

**The five Inventory sub-views still look legacy below the tab strip.** [CLOSED 2026-08-06 - all
five rebuilt on the kit. One correction to the paragraph below: only `StagingView` had all four of
header, breadcrumb, KPI row and filter chips. `LowStockView`, `ActionLogView` and `LOList` had a
header and filter controls but no breadcrumb and no KPI row, and `AssetsView` had no header block
at all - its create button lived in the filter row.] `/inventory/staging`,
`/inventory/assets`, `/inventory/low-stock`, `/inventory/activity` and `/inventory/logistic-orders`
render the LEGACY sub-view components verbatim (`StagingView` 970 lines, `AssetsView`,
`LowStockView`, `ActionLogView`, `lo/LOList`), each of which draws its own header, breadcrumb, KPI
row and filter chips in the legacy design system. Five of the six v2 Inventory tabs therefore mix
kit chrome above the tab strip with legacy chrome below it. Each is a 250-1,000 line page in
component form carrying its own queries and mutations, so restyling one means rewriting it. They
are the obvious next slice and each is independent of the others.

**Four rebuilt Schedule components have no v2 test coverage.** [CLOSED 2026-08-06 - all four
ported, 60 tests. See the follow-up box at the top.] `components/schedule/` ships **twelve**
colocated vitest suites and they test the LEGACY components. (This paragraph said "eight" until
2026-08-06, contradicting the "all twelve files and 149 tests" two paragraphs below it. Twelve is
correct - the table under this paragraph lists eight "yes" rows plus four "no" rows, which is
where the wrong number came from.) Four of those were rebuilt, so on the
`/v2/schedule` path their coverage does not carry over:

| Legacy suite | Covers what the v2 page imports? |
|---|---|
| `TechnicianGridView.test.tsx`, `MemberWeekBoard.test.tsx` | **yes** - the v2 page imports both components unchanged |
| `scheduleModel`, `dragChannels`, `eventAdapters`, `eventPeople`, `useScheduleData`, `useScheduleEvents` | **yes** - all six cover shared logic the v2 page imports unchanged |
| `UnassignedBuckets.test.tsx` | **no** - rebuilt as `pages/v2/schedule/components/unassignedBuckets` |
| `EventEditor.test.tsx` | **no** - rebuilt |
| `UnifiedDropModal.test.tsx` | **no** - rebuilt |
| `ContextMenu.test.tsx` | **no** - rebuilt |

Nothing regressed - all twelve files and 149 tests under `src/components/schedule` still pass,
because that branch modified no legacy file. But the four rebuilt components are uncovered on the
v2 path, and `UnassignedBuckets` is the one that matters most: it owns the D6 drag-to-unschedule
drop target and its `grid-event-id` channel gate. Porting those four suites is the obvious
follow-up and was not done.

Schedule's own ledger records **"Behaviour not reproduced: None."** for the page itself, and it is
the only module that can say so - every gate, mutation, query key, drag channel, drop
classification, optimistic write, rollback, keyboard shortcut, testid and literal string in the
behaviour map's reimplementation checklist is present. The empty-state densities, the banner
gradient and the on-dark button variant are appearance deltas, recorded in 3b.

---

## 4. Duplicated by design - the consolidation work list

The parallel-branch rule forbade a shared location: parameterising a finished module's file is a
cross-branch edit no module branch owns. So the same file exists several times **on purpose**. This
is the work list for the consolidation pass, not a defect list. Every path below was verified on
the final tree.

| Thing | Copies | Files | Modules importing a copy instead of owning one |
|---|---|---|---|
| `filterPopover.tsx` | **5** | `pages/v2/leads/components/filterPopover.tsx` (origin, 402 lines) · `pages/v2/estimates/components/filterPopover.tsx` (472) · `pages/v2/invoices/components/filterPopover.tsx` (462) · `pages/v2/jobs/components/filterPopover.tsx` (402) · `pages/v2/inventory/components/filterPopover.tsx` (250) | Customers imports the leads copy (`CustomersPage.tsx`). The forks are narrow: invoices differs from the leads original only in `domain="lead"` becoming `domain="invoice"`; estimates adds a facet `swatch`; jobs carries a job lifecycle palette. **Inventory's is a different animal** - it is not built on `lib/filters` at all, because inventory's `Filters` type is its own and `useInventoryFilters` consumes it directly. It should probably not be consolidated with the other four |
| `appliedFilters.tsx` | **4** | `pages/v2/leads/components/appliedFilters.tsx` (origin, exports `LeadFilterBar`) · `pages/v2/customers/components/appliedFilters.tsx` (`CustomerFilterBar`) · `pages/v2/estimates/components/appliedFilters.tsx` · `pages/v2/jobs/components/appliedFilters.tsx` | Invoices imports the leads copy, aliased `AppliedFilterBar`. The customers copy is the one with a real reason to exist: it carries three constraints that are deliberately not registry facets (`open_leads`, `active_jobs`, `include_archived`) |
| `statusChip.tsx` | **3** | `pages/v2/leads/components/statusChip.tsx` (origin, 58 lines) · `pages/v2/estimates/components/statusChip.tsx` (58) · `pages/v2/jobs/components/statusChip.tsx` (80) | Customers, Inventory, Invoices (3 files) and Service Plans (2 files) all import the leads copy. The estimates copy drops the lifecycle-override map; the jobs copy needs its own, because five of the seven job statuses share the `warning` intent and painting off intent alone leaves the Status column near-monochrome |
| `glyphs.ts` (unicode escapes for rendered em/en dashes) | **3** | `pages/v2/tasks/components/glyphs.ts` · `pages/v2/schedule/glyphs.ts` · `pages/v2/automations/components/glyphs.ts` | CLAUDE.md forbids the literal characters in source and all three modules render them. Different constant sets - Automations also needs the middot, both curly double quotes, the single right angle quote and the sparkles glyph |
| A label/field row over kit `Label` | **6 shapes** | `customers/CustomerFormPage.tsx` `Field` · `customers/components/locationFormDialog.tsx` `Field` · `jobs/JobFormPage.tsx` `Field` · `settings/components/field.tsx` (`Field`, `SettingRow`) · Schedule and Tasks inline a flex column · Leads, Service Plans and Auth/Public use a bare `Label` + explicit `htmlFor`/`id` | This is BUILD item 3 wearing six coats |
| A section heading | **2 shapes** | `pages/v2/reports/components/heading.tsx` (one file, 19 importers - the only module that factored it out) · every other module inlines `role="heading" aria-level={n}` at each site | BUILD item 2 |
| An exclusive-choice control | **4 shapes** | `pages/v2/schedule/components/segmented.tsx` (`SegmentedGroup` / `Segment`) · Reports' 8 files of `role="radiogroup"` kit Buttons · Settings' Button pair in a `role="group"` · Automations' three near-identical class helpers (`waitForm.tsx` `pillClass`/`toggleClass`, `trigger/dateModePanel.tsx` `chipClass`, `mergeFieldChips.tsx` inline) | BUILD items 5 and 6 |
| A clickable non-CTA surface | **2** | `pages/v2/automations/components/pressable.tsx` (12 sites) · Tasks' inline `span role="button" tabIndex={0}` in `views/CalendarView.tsx` | BUILD item 11 |
| A confirm dialog with a body | **1 so far** | `pages/v2/schedule/components/confirmDialog.tsx` | Five other modules avoided the kit's confirmDialog entirely rather than build one. BUILD item 7 |
| Reports' own de-duplication | **-1** | `pages/v2/reports/components/fieldsPicker.tsx` | Worth naming as the counter-move: Jobs, Leads and Sales reports each shipped a byte-identical FilterPanel and FieldsModal in the legacy layer, and the v2 module has one copy. Within-module, so it needs no consolidation pass |

**The counter-example is worth as much as the list.** `pages/v2/leads/components/tabs.tsx` exists
**once** and is imported by ten modules, as are `contactCell.tsx`, `pickCustomer.tsx` and
`pickLocation.tsx`. Where a leads-authored file was domain-neutral, nobody forked it. Only the
files that hard-code a domain got copied, which tells the consolidation pass exactly what to
parameterise: the domain, and nothing else.

**And the rule has already lapsed once, correctly.** `pages/v2/savedViewMenu.tsx` sits at the v2
root rather than in one module's `components/`, because all five lists render it and none of them
owns it - the same reason `uiV2.ts` and `pageBreadcrumbs.tsx` sit there. That is the shape the
consolidation should take for the files above.

---

## 5. v2-to-legacy imports that block deleting a legacy page at cutover

> **CLOSED 2026-08-06. This whole section is history.** Every import below was re-homed, with no
> re-export shims left behind - a shim would mean the legacy file still could not be deleted, which
> was the entire point. The acceptance check is `grep -rn "@/pages/" frontend/src/pages/v2 | grep
> -v "@/pages/v2"`, and it returns nothing: not one import statement and not the `schedule-dark.css`
> side-effect import either.
>
> Four things the table below got wrong, recorded because the errors are instructive:
> - **33 data/logic sites, not ~30**, across 24 modules; **6 dashboard sites, not 5** (`types` is
>   imported twice). 86 import statements plus 1 CSS reference, 87 in total.
> - **The invoice helpers were not "copied byte-identically" into v2.** Three had their parameter
>   types widened to structural subsets, and `getAvailableActions` had lost the two-line D4 note
>   explaining why the technician role default was removed. Only the bodies matched. The duplicate
>   had already drifted - which is the argument for hoisting, stated better than the original row
>   stated it.
> - **`jobs-data.ts` and `leads-data.ts` imported runtime values**, not just types, from the legacy
>   page files (`buildMockJobs`, `LEADS`). Re-homing had to go further than this table describes or
>   `lib/` would have depended on a page.
> - **`pages/dashboard/widgets/**` had to move too**, for the same reason: the registry renders
>   them, so leaving them under `pages/` would have left a component importing a page. All 24
>   widget ids were diffed identical before and after.
>
> One deliberate non-move: `/auth/callback` stays out of `AUTH_PUBLIC_V2_PATHS`, because
> registering it makes `V2FlagRedirect` hop the live OAuth return - a cutover routing decision with
> a real Google-sign-in risk, not re-homing. `lib/auth-listener.ts`'s race guard was widened to
> cover `/v2/auth/callback` (a registered route that was genuinely exposed to the race), so that
> decision is unblocked.

A v2 file importing from `@/pages/` outside `pages/v2/` means the legacy module cannot be deleted
until the import is re-homed. Every one of these is deliberate - the alternative was forking
business logic, which the migration brief forbids - but they are a cutover work list, not a
standing arrangement. Found by grepping `pages/v2/**` for `@/pages/` imports and excluding
`@/pages/v2`; the counts are import-site counts.

### 5a. Legacy PAGE modules held open by a named export

| v2 file | Imports | From | Why |
|---|---|---|---|
| `pages/v2/jobs/JobDetailPage.tsx:65` | `AttachmentsTabBody` | `@/pages/JobDetailPage` | **The hard one.** Its tiles need raw `<a>`, `<img>`, `<input type="file">` and `<label>` elements and the raw-tag ratchet is at its floor for all four, so a v2 file cannot re-author it. The Jobs ledger calls it "the one import that must be re-homed before the legacy page can be deleted at cutover" |
| `pages/v2/invoices/invoiceDerivations.ts:24-29` | `buildLedgerEvents`, `deriveInvoiceMoney`, `type LedgerEvent`, `type InvoiceMoneyFigures` | `@/pages/InvoiceDetailPage` | Money arithmetic must have exactly one implementation. Five sibling helpers (`getAvailableActions`, `isOverdue`, `getDueDateLabel`, `isDepositCreditPayment`, `round2`) were un-exported and had to be copied byte-identically instead - **the Invoices ledger escalates all five as belonging in `lib/`** |
| `pages/v2/customers/CustomerFormPage.tsx:22` | `customerSchema` | `@/pages/CustomerFormPage` | The form's validation contract |
| `pages/v2/customers/CustomersPage.tsx:24` | `DEFAULT_CUSTOMERS_SORTING` | `@/pages/CustomersPage` | |
| `pages/v2/service-plans/components/planBuilderDialog.tsx:26` | `resolveServiceLocationId` | `@/pages/service-plans/ServicePlansPage` | It guards a non-idempotent location POST - one invariant with one test pinning it |
| `pages/v2/customers/CustomerDetailPage.tsx:26` | `PlanBuilderDialog` | `@/pages/service-plans/ServicePlansPage` | A whole component, not a helper. Customers renders the legacy service-plan builder unchanged |
| `pages/v2/communication/TextPage.tsx:13` | `mergeServerThreads` | `@/pages/communication/TextPage` | One convergent merge, or polling duplicates conversations |
| `pages/v2/settings/settingsBar.tsx:6` | `type SettingsSaver` | `@/pages/settings/SettingsLayout` | Type only - the save contract, imported so it cannot drift |

### 5b. Legacy page-adjacent modules (data, logic, fixtures, layout)

Not found by the brief, found by the grep. These are the larger blocker by volume, because they
hold open whole legacy directories rather than single files.

| From | Sites | What |
|---|---|---|
| `@/pages/reports/report-catalog` | **29** | The report catalog. Every v2 report resolves its own metadata through it |
| `@/pages/reports/*-data.ts` / `*-logic.ts` (24 modules) | ~30 | `activity-logic` (7), `communication-tracking-logic` (3), `estimates-report-logic` (2), plus one each for arAging, payments, expenses, items-services, call-tracking, estimate-conversion, revenue, leads, jobs, invoices, inventory-usage, payment-fees and their data siblings. All imported unchanged - forking any would be a second definition of a report's arithmetic |
| `@/pages/reports/_shared` | **7** | `hashStr`, `mulberry32`, `rangeRnd`, `Delta`, `Sparkline` - pure arithmetic and two token-only renderers, re-exported rather than copied |
| `@/pages/reports/LeadsReport`, `@/pages/reports/JobsReport` | 2 | The `Lead` / `Job` / `Status` TYPES. Those fixtures are shared with the live DTO rehydration |
| `@/pages/reports/DateRangeControl` | 1 | The `Opt` type |
| `@/pages/dashboard/layout/*` | 5 | `useDashboardLayout` (owns the localStorage key `alpha:dashboard-layout:v1:<userId>` and the reorder splice arithmetic), `widgetRegistry` (`WIDGETS` - the v2 registry DERIVES from it and never restates an id), `EditableWidget`, `CatalogDrawer`, `types` (`SIZE_SPAN`, `TimeRange`). A drifted widget id is a widget that stops rendering for everyone who has already customised their page |
| `@/pages/schedule-dark.css` | 1 | 490 lines of `.schedule-cal .rbc-*` overrides. **Imported, never forked**, because it encodes behaviour that lives nowhere else: the focus-day column expansion (`[data-focus-day="N"]` -> `flex-grow:4` + `width:400%`), the all-day strip collapse (`.has-allday-events`), the drag-preview geometry variables, the resize hit areas, and `body.is-dragging *`. Re-deriving those structural selectors by hand would surface any drift as a broken drag, not as a colour difference |

**Two escalations that are not imports but belong here**, because both must be resolved before the
`/v2` layer can stand alone: `components/ProtectedRoute.tsx` imports `pages/NotAuthorizedPage`
directly, and `lib/auth-listener.ts` pins its OAuth race-guard to the exact pathname
`/auth/callback`. Both are shared files no module branch could edit. See 3c.

---

## 6. Confirmed gaps (verified in code)

### 6a. Shell - found while wiring the v2 topbar (Phase 0)

The kit ships the *chrome* for each of these and none of the *surface* behind it. Unchanged since
Wave A; no numbered module reached any of them.

| Old component | What the kit has | Why it is not enough | Used by | Rec |
|---|---|---|---|---|
| `layout/GlobalSearch` | `TopBarSearch` | An input, an icon and a shortcut hint, wired to nothing. No query, debounce, grouped result list, keyboard navigation or settings-guard on select. | v2 topbar, legacy header | BUILD |
| `notifications/NotificationBell` (+ `NotificationPanel`) | `TopBarAction` with a `badge` | An icon that can carry a number. No panel, no realtime subscription, no mark-seen-on-open, no mobile sheet variant. | v2 topbar, legacy header | BUILD |
| `communication/phone/Dialer` (`GlobalDialer`) | nothing | Click-to-call surface and WebRTC device. Confirmed independently by Communication, which also owns the dedicated `/phone` tab surface. | v2 topbar, legacy header | KEEP |
| `timeclock/ClockInOutMenu` | nothing | Geofenced clock in/out, rendered inside the user menu. | v2 topbar, legacy header | KEEP |
| WhatsApp brand glyph | nothing | Lucide ships no brand icons and neither does the kit. Duplicated into `pages/v2/WhatsAppGlyph.tsx` because the original is inline in the legacy header, which must stay untouched. | v2 topbar | KEEP |
| `layout/SidebarAddShortcut` | nothing | The Add-shortcut picker behind the sidebar's Customize mode. It reads `NAV_REGISTRY`, applies the CASL and demo-org filters and returns a key - almost none of it presentation, and a v2 copy would be a second list to keep in step with the registry. Imported unchanged by `pages/v2/V2SidebarNav.tsx`. | v2 sidebar, legacy sidebar | KEEP |
| `ui/dropdown-menu` (legacy, in the user menu) | `ui/dropdownMenu` | Used *here* only because `ClockInOutMenu` is built from legacy menu items and must render inside the same menu. Resolves when `ClockInOutMenu` is ported. | v2 topbar user menu | DROP (at cutover) |

### 6b. Primitives with no kit counterpart

`frontend/src/components/ui/` holds **40** primitives (verified: 40 `.tsx` files excluding stories
and tests). `frontend/src/ui-kit/components/ui/` holds **24** (verified by file count). Hit counts
are from section 1.

| Old primitive | Notes | Rec |
|---|---|---|
| `tabs` + `patterns/TabStrip` | Twelve of fifteen modules. The single highest-value gap. -> BUILD #1 | BUILD |
| `heading` | Thirteen of fifteen. Reclassified in Wave A from "different authoring model" once four modules hand-rolled `role="heading"`; nine more followed. -> BUILD #2 | BUILD |
| radio / radio-group | **Missing from both systems.** No radio primitive in the old set either; legacy used raw `<input type="radio">`, which the ratchet now forbids. -> BUILD #6 | BUILD |
| `toggle-group` | Segmented control. Reached first by Schedule, which needed it four times in one module. -> BUILD #5 | BUILD |
| `collapse` | Disclosure. Reached by Schedule and Reports; both import the legacy one unchanged. -> BUILD #10 | BUILD |
| `link`, `action-link` | Typed link primitives. **Reclassified from DROP.** Auth/Public, Jobs and Inventory all filed BUILD after hitting the raw-`<a>` ratchet floor. -> BUILD #9 | BUILD |
| `thumbnail` | The kit ships no image primitive and `ui/avatar` is a circular initials fallback. -> BUILD #8 | BUILD |
| `alert` | Inline page-level messaging. The kit has `sonner` toasts, which are transient and not a substitute. **Never reached by any of the fifteen modules** | BUILD |
| `chip` | The kit has `badge` (static) and `crm/tagInput` (editable). Neither is a removable standalone chip. **Never reached** | BUILD |
| `AttachmentLightbox`, `VideoPreviewDialog` | The attachment viewing surface. Confirmed by Estimates and Jobs. | KEEP |
| `box`, `stack`, `inline`, `surface`, `text` | Layout and typography primitives. The kit expects utility classes plus `layout/container`; confirmed workable by Invoices, Service Plans and every later module. | DROP |
| `modal` | The kit's `dialog` covers it. Confirmed per call site by Customers, Estimates, Invoices, Service Plans, Reports and Communication. **One exception:** Schedule's plan-mode exit dialog has three footer actions (Cancel / Discard & Exit / Confirm All & Exit) and the kit's confirm holds a fixed pair, so it is assembled from Dialog parts at the call site. Three-action dialogs are rare enough to compose. | DROP |
| `toast` / `toaster` / `use-toast` | The kit ships `sonner`. Not missing, but a **different API** - every call site changes shape. All fifteen modules made the same mapping: `toast({title, description, variant:'destructive'})` -> `toast.error(title, {description})`. Schedule is the one module that kept a page-owned toast surface, for a stated reason (see 3c). | DROP |

Covered by the kit despite different names, listed so nobody re-reports them:
`breadcrumb` -> `layout/nav/breadcrumbs` · `empty-state` -> `data/emptyState` ·
`confirm-dialog` -> `ui/confirmDialog` · `data/ResizableTable` -> `data/dataTable` ·
`data/KpiStrip` -> `data/statCard` · `patterns/PageHeader` -> `layout/pageHeader` ·
`filters/FilterBar` -> `crm/filterBar` · `hooks/useIsMobile` -> `ui-kit/hooks/useMediaQuery` ·
`patterns/Toolbar` -> `data/dataTable/dataTableToolbar`.
`patterns/FormField` -> `form/formField` **is struck from this list** - see section 2b.

### 6c. Rich components with no kit counterpart

| Old | Notes | Rec |
|---|---|---|
| `components/charts/*` (10) + `recharts` | The kit ships no chart of any kind. Confirmed by Dashboard, Reports (17 imports across 16 report files) and Tasks. Approved exception: chart internals are a no-touch boundary because colour there carries meaning. | KEEP |
| `react-big-calendar` (Schedule) | The kit ships no calendar view. `ui/calendar` is a react-day-picker date picker: no events, no week or day mode, no drop targets, no resize. Tasks hand-rolled a 585-line calendar view rather than adopt it, and has never used rbc. | KEEP |
| `crm/LineItemsEditor` and its per-module descendants | Confirmed by Estimates, Invoices and Jobs. See section 7, money surfaces. | KEEP |
| `crm/address-autocomplete`, `crm/service-location-map` | Places autocomplete and Static Maps preview. Confirmed by Customers, Jobs and, transitively, Service Plans. | KEEP |
| `crm/AttachmentSection`, `AttachmentsPanel`, `estimates/PdfPreviewDialog` | Upload, attachment lists, document viewing. Confirmed by Estimates, Invoices and Jobs independently. | KEEP |
| `react-signature-canvas` | Public estimate approve flow, including the `ResizeObserver` that re-syncs the pixel buffer. **Correction:** the Wave A note attaching this to job signatures is wrong. The only importer in the tree is `pages/PublicEstimatePage.tsx`; the Jobs ledger checked and no jobs page, component or dialog uses it. | KEEP |
| `filters/RangeSlider` | Numeric range filter. Estimates lost the dual-handle slider for want of it. | BUILD |
| `pages/dashboard/layout/{EditableWidget,CatalogDrawer}` | The dashboard customisation surface. `EditableWidget` renders a bare fragment when not editing - a zero-DOM layout contract any wrapper would break - and its drag source is the native HTML5 API. `CatalogDrawer` is a sticky non-modal `<aside>` inside the page flex row, not a `Sheet`. | KEEP |

---

## 7. The KEEP list, grouped

Around 120 KEEP rows across fourteen ledgers, and the individual rows are in those ledgers. What
matters at this level is the **shape** of what the kit does not cover. Every group below is a
domain surface: the behaviour is the component, and a kit version would have one caller.

**Money surfaces** - the largest group and the one with the strongest case for staying out of the
kit. Money arithmetic is backend-mirrored and must have exactly one implementation.
`crm/LineItemsEditor` · `crm/InternalCostsCard` ·
`estimates/{EstimateLineItemsEditor, EstimateScopeOfWorkCard, EstimateReceiptCard, EstimateInternalCostsCard}` ·
`invoices/{InvoiceLineItemsEditor, InvoiceScopeOfWorkCard, InvoiceReceiptCard}` ·
`jobs/items/{LineItemsEditor, JobScopeOfWorkCard, JobBillingSummary, ReceiptCard}` ·
`jobs/PaymentsTab` · and the transactional dialogs that move money or unwind it:
`RecordEstimatePaymentDialog`, `RefundDepositDialog`, `WaiveDepositDialog`, `SendEstimateDialog`,
`MarkSentDialog`, `RecordPaymentDialog`, `RefundInvoiceDialog`, `CreditInvoiceDialog`,
`VoidPaymentDialog`, `VoidInvoiceDialog`, `DeleteInvoiceDialog`, `CancelEstimateDialog`,
`DeclineEstimateInternalDialog`, `VoidApprovalDialog`, `DuplicateEstimateDialog`,
`SendInvoiceDialog`, `CreateJobInvoiceDialog`.
Recurring across six ledgers: `ui/confirmDialog` has **no free-text reason field and no body slot**,
which is why so many confirm-shaped dialogs could not use it. That is BUILD item 7.

**Pickers and remote lookups** - each fetches a remote API and parses a payload; the popover is the
smallest part of it. `crm/address-autocomplete` (Places v1, 3-char minimum, 300 ms debounce) ·
`crm/service-location-map` (Static Maps preview) · `crm/PickOrCreateCustomer` /
`crm/CustomerPickerWithCreate` (carries a shipped non-passive `wheel` fix with its own Playwright
spec) · `crm/PickOrAccreteLocation` (owns the load-bearing `ADD_NEW_LOCATION` sentinel) ·
`crm/AssigneeSelect` and `crm/MultiAssigneeSelect` (own `useAssignableUsers` and an eligibility
filter; hit by Tasks and Schedule) · `inventory/lo/TrackedItemSearch` (shared with Service Plans) ·
`inventory/{LocationSelector, CategorySelector, CategoryManagerDropdown}` (managed lists with
inline create/edit and permission gating) · `communication/phone/shared` `DateRangeControl`.
The kit's `form/combobox` filters a client-side option list; none of these are that.

**Attachments and documents** - `crm/AttachmentSection` · `AttachmentsPanel` ·
`features/estimate-workspace/AttachmentsSignaturesCard` · `jobs/overview/JobFilesCard` ·
`ui/thumbnail` · `ui/AttachmentLightbox` · `ui/VideoPreviewDialog` · `estimates/PdfPreviewDialog`
(flagged independently by Estimates, Invoices and Jobs) · `jobs/ViewWorkOrderDialog` ·
`inventory/POPreviewDialog` · `react-signature-canvas` · `inventory/ImportCSVDialog`.
The kit ships no image primitive, no document viewer and no file-drop target.

**Charts and maps** - `components/charts/*` (10) + `chartTheme` + `recharts` ·
`design-system` `token()` / `chartPalette` / `severityRamp` · `crm/service-location-map`.
Approved no-touch boundary: colour carries meaning inside them. Reports alone has 17 chart imports
across 16 report files.

**Calendar and scheduling engine** - `react-big-calendar` + `addons/dragAndDrop` ·
`pages/schedule-dark.css` · `schedule/TechnicianGridView` (553 lines, 18 dataTransfer/drag sites) ·
`schedule/MemberWeekBoard` (440 lines, 22 sites). The kit's `ui/calendar` is a date picker. All
four are imported unchanged, which is also what keeps their existing test suites meaningful.

**Telephony and messaging** - `communication/phone/{CallsView, CallFlows, CallGroups, NumbersView,
CallMaskingView, BlockedCallersView, TrainingView, DispatchView, PerformanceView, SmsInboxView,
TextingView, Dialer}` · `communication/inbox/{ComposeWindow, InlineComposer, NoMailboxChip,
InboxDirectory}` · `communication/shared/atoms` `JobBadge`. Twelve of these are whole sub-views
with their own queries, and two of them (`CallsTable`, `CallDetailDrawer`) are also mounted by the
Reports module - rebuilding either would fork a surface that has to stay identical in two places.

**Inventory domain dialogs and sub-views** - 21 `inventory/*Dialog` components (`AddItemDialog`
1,026 lines, `TransferDialog` 1,205, `NewPODialog` 1,217, `AddGroupDialog` 784) plus five sub-views
(`StagingView`, `assets/AssetsView`, `LowStockView`, `ActionLogView`, `lo/LOList`) and three cards
(`LocationStockHealth`, `VendorCard`, `itemDetailPanel`'s legacy origin). `lo/LOList` is also
mounted by Jobs and Service Plans, so its props are load-bearing for two other modules.

**Jobs domain surfaces** - `jobs/JobLifecycleBar` (six stages under Spec B1's unordered semantics,
not a `ui/progress` scalar) · `jobs/{TeamCard, AiInsightsCard, AiJobAssistantBar, JobStagesSection,
AssignJobDialog, CancelJobDialog, BulkCancelJobsDialog, EditJobLocationDialog, AttachEstimateDialog}` ·
`jobs/overview/{CustomerContactCard, JobNotesPreview}` · `crm/IconRail`.

**Settings and platform** - `settings/UserPermissionsDialog` (the app's permission surface) ·
`timeclock/{MyTimeLog, GeofenceSettingsDialog, EmployeePayrollCard}` ·
`payments/{StripePaymentsStatusCard, StripeOnboardingDrawer}` · `brand/{ServWaveMark, GoogleIcon}`
(GoogleIcon's four literal hexes are a documented trademark exemption and must never be tokenised).

**Dashboard customisation** - `pages/dashboard/layout/{useDashboardLayout, defaultLayout, types,
widgetRegistry, EditableWidget, CatalogDrawer}` · `pages/dashboard/widgets/KpiCard` ·
`lib/dashboard/insightRules`. Imported whole because a fork would be a second definition of what a
user's saved layout MEANS, and the failure mode is silent.

**Cross-module surfaces** - owned by a migration that has run but whose component still lives in
the app tree, so importing remains the rule. `tasks/JobLeadTasksTab` (used by Customers, Estimates
and Jobs) · `tasks/CreateTaskModal` · `communication/{CustomerCommunicationsTab,
JobCommunicationsTab}` · `crm/IconRail` (spans every entity; belongs to a shell migration) ·
`service-plans/PlanBuilderDialog` (imported by `CustomerDetailPage` unchanged) ·
`customers/BulkTagPopover` · `estimates/{NewEstimateDialog, EstimateDocumentView}`
(EstimateDocumentView is shared three ways and pinned by `estimate-detail-preview.test.tsx`) ·
`ui/breadcrumb`'s `BreadcrumbItem` **type**, still imported as the cross-page
`location.state.breadcrumbs` contract even though the rendering moved to the kit.

---

## 8. Where the ledgers disagree

Recorded rather than resolved. Each needs one decision, not fourteen. The first three are Wave A's
and two of them have since been settled by events.

1. **`leads/TagInput`.** Customers -> **BUILD** ("the kit tagInput needs a data-bound wrapper before
   any page can use it"). Estimates -> **BUILD**. Invoices -> **KEEP** ("it owns the
   `POST/DELETE /api/{entity}/:id/tags` calls and the org tag vocabulary"). Jobs -> **KEEP** (same
   reason as Invoices). **Two to two.** The disagreement is really about scope: whether the wrapper
   belongs in the kit or in `crm/`.

2. **`data/TagChips`.** Estimates -> **BUILD**. Schedule -> **BUILD** ("this is now four modules").
   Customers -> **KEEP**. Invoices -> **KEEP**. Jobs -> **KEEP**. **Two to three.** All five give
   the *same* reason - `tag.color` is runtime user data and `ui/badge`'s variants are a closed set -
   and reach opposite conclusions from it. The real question is whether the kit's Badge should
   accept a runtime colour at all, which is a design-system decision, not a module one.

3. **The saved table view on Customers.** *Settled.* Invoices reported the loss of
   `tableKey`/`useTableView`; the Customers ledger asserted its list never had the feature, which
   the code contradicted (`pages/CustomersPage.tsx:552` passes `tableKey="customers"`). Invoices was
   right. The point is now moot: the `savedView` prop restored the feature for all five lists and
   `listTableAdoption.test.tsx` asserts the restore reads the same `/api/me/table-views/:key`
   record the legacy list wrote.

4. **Classification of the `filterPopover` duplication.** *Settled.* Invoices filed it as a gap row
   with `Rec: BUILD`; Estimates filed the identical fact as an observation. `gaps/README.md` was
   amended, and every Wave B ledger filed it under "Shape differences forced by the kit" as
   instructed.

5. **`ui/heading`.** Auth/Public -> **DROP**. Customers, Jobs, Reports, Inventory, Settings and
   Automations -> **BUILD**. Auth/Public's reasoning is that `<p role="heading" aria-level={n}>`
   preserves the accessible name, which is what `e2e/global-setup.ts` matches on, so nothing is
   lost. The other six answer that the document OUTLINE is lost, and Automations quantifies it -
   six real `<h2>`/`<h3>` elements became `<p>`. **Six to one for BUILD**, and the dissent is about
   whether a flat heading outline is a defect.

6. **`patterns/FormField`.** Auth/Public -> **KEEP** ("kit FormField is fine elsewhere"). Customers,
   Service Plans, Jobs and Schedule -> **BUILD**. Auth/Public's case is specific and correct for
   its own module: the kit's FormField generates its own control id (`${useId()}-control`) and
   `e2e/global-setup.ts` locates `#email` / `#password` by raw id, so it could not be used there
   under any API. That is an argument for an id passthrough, not against the BUILD row. **Four to
   one.**

7. **A link / anchor primitive.** Wave A recorded `action-link` and `link` as **DROP**, on the
   strength of Invoices mapping `tel:`/`mailto:` links to `variant="link"` Buttons. Auth/Public,
   Jobs and Inventory then all filed **BUILD**, and Inventory names the concrete loss: middle-click,
   open-in-new-tab and the URL on hover, on an external brand website link. **Reclassified to BUILD
   in section 6b.** The DROP was a Wave A call made before a module needed a real navigation target.

8. **`data/statCard`'s missing icon slot.** Reports -> **BUILD**. Communication -> **KEEP**
   ("accepted, not worked around - the `tone` rail carries the same colour coding"). Dashboard files
   BUILD but on a different prop, the **meta slot**, and is explicit that the icon is the least of
   its three misses. Not really a contradiction: the icon is a documented kit decision that nine
   modules accepted, and the meta slot is the one that deletes information. Treat item 2b's statCard
   row as one BUILD for the meta slot and a settled no for the icon.

9. **Row virtualization.** Jobs -> **BUILD** (listed among five missing DataTable behaviours).
   Inventory -> **KEEP (scoped out by decision)**, and quotes the kit source, which is right: the
   kit table grows to its content and the PAGE scrolls, so there is no measurable viewport for a
   virtualizer. Inventory is correct on mechanism; Jobs is correct that the behaviour is gone. Both
   rows are in section 3a as a loss rather than as a BUILD.

10. **"Also hit by: Dashboard" on the Tabs row.** The Inventory and Automations ledgers both list
    Dashboard among the modules that hit the Tabs gap. **The code says no.** No file under
    `pages/v2/dashboard/` imports `pages/v2/leads/components/tabs.tsx` and none renders a tablist;
    Dashboard's v2 page is a widget grid with an edit toolbar. Both ledgers are wrong on that one
    cell. Section 1 counts twelve, not thirteen.

11. **How many primitives the kit ships.** Tasks says 21, Settings says 21, Communication says 21;
    Service Plans, Schedule and Automations say 24. **24 is correct today** - verified by counting
    `frontend/src/ui-kit/components/ui/*.tsx`. The kit grew during the migration, so the earlier
    number was true when it was written. Both numbers appear in ledgers written days apart; neither
    author was wrong at the time.

12. **How many report tables need a `<tfoot>`.** The Reports ledger says both **9** (its
    behaviour-not-reproduced row) and enumerates **10** table instances (its gap row, which counts
    Commissions twice). Ten table instances across nine reports. Recorded in 2b.

Nothing else in the fourteen ledgers contradicts anything else in them.

---

## 9. Per-module ledgers

Each module branch wrote `md_files/plans/ui-redesign/gaps/<module>-missing-components.md` and its
rows are folded into this file. **All fifteen modules are complete.**

| # | Module | Ledger | Status |
|---|---|---|---|
| 0 | Shell (Phase 0) | this file, section 6a | done |
| 01 | Dashboard | `gaps/dashboard-missing-components.md` | done |
| 02 | Leads | **none, and none is coming** | done - see below |
| 03 | Customers | `gaps/customers-missing-components.md` | done |
| 04 | Estimates | `gaps/estimates-missing-components.md` | done |
| 05 | Jobs | `gaps/jobs-missing-components.md` | done |
| 06 | Invoices | `gaps/invoices-missing-components.md` | done |
| 07 | Schedule | `gaps/schedule-missing-components.md` | done |
| 08 | Tasks | `gaps/tasks-missing-components.md` | done |
| 09 | Reports | `gaps/reports-missing-components.md` | done |
| 10 | Inventory | `gaps/inventory-missing-components.md` | done |
| 11 | Settings & Users | `gaps/settings-missing-components.md` | done |
| 12 | Communication | `gaps/communication-missing-components.md` | done |
| 13 | Auth & Public | `gaps/auth-public-missing-components.md` | done |
| 14 | Automations | `gaps/automations-missing-components.md` | done |
| 15 | Service Plans | `gaps/service-plans-missing-components.md` | done |

**Leads has no ledger and one will not be back-filled.** Module 02 was built before the ledger
format existed, so `gaps/leads-missing-components.md` does not exist and its absence is not a
finding. Everywhere Leads appears in a count above, the evidence is one of two things and is
labelled as such:

- **Code it left behind**, read directly:
  `pages/v2/leads/components/{tabs,statusChip,filterPopover,appliedFilters,contactCell,pickCustomer,pickLocation}.tsx`.
  Four of those seven are now imported by other modules rather than forked, and `tabs.tsx` alone has
  ten importers.
- **Another module's report about a leads-owned component**, attributed here so the claim has an
  author:
  - Invoices: `pages/v2/leads/components/filterPopover.tsx` hardcodes `domain="lead"`, which is why
    four modules copied it (`invoices-missing-components.md`, Gaps).
  - Jobs: `pages/v2/leads/components/statusChip.tsx` hardcodes a `lead` lifecycle map, which is why
    Jobs made a third copy rather than a cross-branch edit (`jobs-missing-components.md`, Gaps).
  - Jobs: `pages/v2/leads/components/contactCell.tsx` set the precedent for replacing a raw `<a>`
    with a kit Button that sets `window.location.href` (`jobs-missing-components.md`, Gaps).
  - Schedule: the same `tel:`/`sms:` substitution, cited to the Leads module by name
    (`schedule-missing-components.md`, §3).
  - Schedule: the `Label` + flex column field shape is "the same shape Leads, Customers, Service
    Plans and Tasks all landed on" (`schedule-missing-components.md`, Gaps).
  - Reports and Inventory both list Leads under "Also hit by" for Heading and Tabs.
  - Reports: the `sub` line -> `delta` chip mapping on StatCard "follows the Leads precedent"
    (`reports-missing-components.md`, Gaps).
  - Inventory: dropping decorative header/row checkboxes with no bulk bar behind them is "the same
    call the leads module made" (`inventory-missing-components.md`, Behaviour not reproduced).
  - Settings: the toggle-group and Heading rows list Leads under "Also hit by".

---

## 10. How to read the recommendations

**BUILD** rows are the real output of this document. If the BUILD list stays short, the kit covers
the app and cutover is mostly deletion. If it grows past roughly a dozen, the honest conclusion is
that the kit is not yet a complete design system for this app, and that is a decision to surface
early rather than at the end.

Fifteen modules settled it. The list is at twenty-one items. Seven of them were hand-rolled
independently by five or more branches that could not see each other, and eleven more are missing
props on components the kit already ships.

The shape of the answer has not changed since Wave A, only its confidence:

- **The kit's coverage of primitives is good.** Around 120 KEEP rows, and almost every one is a
  domain surface - money arithmetic, a telephony sub-view, a calendar engine, a 1,200-line PO
  builder - that no design system should own. Nothing in section 7 is an argument against the kit.
- **Its coverage of composition is where the holes are:** tabs, headings, a context-free field, an
  exclusive-choice control, a tag surface bound to real data, a confirm dialog with a body, and a
  disclosure. Seven items, twelve modules deep at the top.
- **And the fix rate is the encouraging number.** Two of Wave A's kit-API gaps were closed
  mid-migration rather than deferred, and both closures deleted workarounds rather than adding to
  them: `tableEffects.tsx` is gone, `bulkBar.tsx` is presentation again, and the saved column view -
  Wave A's single largest "behaviour not reproduced" row - came back for all five lists with a test
  that names which assertions were red before. That is the argument for section 2b. The other
  fourteen rows there are the same kind of change.

None of it blocks cutover. Section 5 does. Section 3 is what someone has to read and accept before
the switch is thrown.
