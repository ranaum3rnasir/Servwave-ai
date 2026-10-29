# Jobs - components with no kit equivalent

Module 5. Branch `refactor/ui-kit-05-jobs`.
Pages rebuilt under `frontend/src/pages/v2/jobs/`: `JobsPage.tsx`, `JobFormPage.tsx`,
`JobDetailPage.tsx`, plus `jobsColumns.tsx` and four files under `components/`.
Registered by `pages/v2/routes/jobs.paths.ts` + `jobs.routes.tsx`.

`/jobs/:jobId/statement` is NOT rebuilt here. `pages/v2/customers/StatementPage.tsx` already
serves both scopes from one file (`params.jobId ? 'job' : 'customer'`), exactly as App.tsx mounts
one `StatementPage` on both routes; the jobs route points at that file.

The import checklist is every `@/components/...` import across the three legacy pages - 54 distinct
module rows, all accounted for in the Replaced tables below.

## Gaps

| Old component | Used in | What it does | Kit's nearest thing | Why it is not enough | Rec |
|---|---|---|---|---|---|
| `crm/PickOrCreateCustomer` | create form | the five-field contact block: typeahead over `/api/customers`, customer selection, the inline 409 duplicate banner with its four callbacks | `form/combobox` | the combobox picks a value from a list; this owns a debounced search, the accretion rule (a phone/email edit keeps the link, a name/company edit forks), and the `id="phone"` / `id="email"` inputs the duplicate handshake focuses by DOM id | KEEP |
| `crm/address-autocomplete` | create form | places typeahead that writes line1/city/state/zip in one selection | `form/combobox` | the four-field write and the provider plumbing are the component; a combobox returns one value | KEEP |
| `crm/service-location-map` | create form | static map preview of the typed address | none | no map surface in the kit | KEEP |
| `customers/DuplicateCustomerDialog` | create form (type only) | the `ExistingCustomer` shape; the dialog itself is rendered by `PickOrCreateCustomer` | `ui/confirmDialog` | confirmDialog has no per-field "edit this instead" affordance and no matched-field marking | KEEP |
| `crm/IconRail` | detail | right-hand Activity rail + slide-over panel | none | shared app infrastructure spanning every entity; belongs to a shell migration, not this one | KEEP |
| `crm/InternalCostsCard` | detail, Items tab | staff-only cost/margin panel with its own labor-hours / overhead commits | none | cost model, not presentation | KEEP |
| `leads/TagInput` | detail hero | entity tag add/remove with a create-or-attach popover | `crm/tagInput` | the kit's tagInput is an uncontrolled chip input with no entity binding; this one owns `POST/DELETE /api/jobs/:id/tags` and the org tag vocabulary | KEEP |
| `data/TagChips` | list, Tags column | up to 2 tag chips plus a `+N` pill, coloured from runtime `tag.color` | `ui/badge` | the colour is user data applied as an inline style, which Badge's variant API cannot express | KEEP |
| `jobs/JobLifecycleBar` | detail hero | the six-stage milestone rail, `computeLifecycle` back-fill, the per-node capability model and the Start button under the On Site node | `ui/progress` | progress is one scalar; this is six stages, each with its own reachability, its own click target and Spec B1's unordered semantics | KEEP |
| `jobs/TeamCard` | detail, Overview | crew + dispatcher card with `AssignDispatcherDialog` and the class-level `assign Job` gate | `crm/recordCard` | recordCard is a display shell; the dispatcher dialog and its mutation live inside this one | KEEP |
| `jobs/AiInsightsCard` | detail, Overview | rule-based insights from `deriveJobInsights`, collapse toggle, AI tone | none | pure rules plus an AI-specific card treatment the kit has no tone for | KEEP |
| `jobs/AiJobAssistantBar` | detail, Overview | agent launch tiles built from `buildJobAgentTiles`, plus the disabled ask bar | none | no kit surface for it | KEEP |
| `jobs/PaymentsTab` | detail, Payments | invoice card, deposit drawdown rail, payment history table, Record Payment / Collect deposit links | `ui/table` + `data/statCard` | the financial-state gates (`showRecordPayment`, `showCollectDeposit`) are the component | KEEP |
| `jobs/JobStagesSection` | detail, Logistics | staging + fulfillment blocks, returns `null` on a 403 | none | inventory-RBAC behaviour, not chrome | KEEP |
| `jobs/items/LineItemsEditor` + `JobScopeOfWorkCard` | detail, Items | job-owned billing lines and scope blocks with add/update/delete mutations | none | the kit ships no line-item surface at all | KEEP |
| `jobs/items/JobBillingSummary` | detail, Items | Total / Invoiced / Remaining / Over-billed strip off `computeJobBilling` | `data/statCard` | the four figures are one reconciliation, not four independent metrics, and the over-billed state has no StatCard expression | KEEP |
| `jobs/items/ReceiptCard` | detail, Items | subtotal / discount / tax jurisdiction / total, non-interactive in `variant="job"` | none | money arithmetic plus the "a control is interactive iff its handler prop is provided" contract | KEEP |
| `jobs/overview/CustomerContactCard` | detail, Overview | contact card plus the gated communications preview and its own query | `crm/recordCard` | the `read Communication` gate and the preview query are the component | KEEP |
| `jobs/overview/JobFilesCard` | detail, Overview | attachment preview with a "view all" hand-off | none | no kit file/gallery surface | KEEP |
| `jobs/overview/JobNotesPreview` | detail, Overview | latest notes plus an inline composer | `crm/noteEditor` | noteEditor is a composer only; this also renders the feed and owns the add-note mutation and its invalidation pair | KEEP |
| `jobs/AssignJobDialog` | detail | crew multi-select, all-day toggle, datetime-local range, the 409 conflict panel and its `force: true` retry | `ui/dialog` | the conflict handshake and the all-day snapping are the component | KEEP |
| `jobs/CancelJobDialog` | detail | required cancellation reason, POST cancel | `ui/confirmDialog` | confirmDialog has no reason field | KEEP |
| `jobs/BulkCancelJobsDialog` | list, bulk bar | required reason for a batch cancel, with the voided-invoice warning | `ui/confirmDialog` | same - no reason field, and the copy names a consequence confirmDialog cannot express | KEEP |
| `jobs/EditJobLocationDialog` | detail | pick-an-existing-location / add-new-address two-mode form, plus the `tax_warning` panel that keeps the dialog open | `ui/dialog` | two modes, its own zod schema and the tax-jurisdiction warning | KEEP |
| `jobs/AttachEstimateDialog` | detail, Estimates | attach an existing estimate to the job (R6 EstimateJobLink) | `ui/dialog` | the search and the link mutation are the component | KEEP |
| `jobs/ViewWorkOrderDialog` | detail overflow | printable work-order view of the backing estimate | none | document rendering, no kit equivalent | KEEP |
| `invoices/CreateJobInvoiceDialog` | detail (mounted twice) | line authoring for a job with no estimate, plus the send-after-create path | none | validation, payload mapping and the `existingDraft` / `initialMode` states are the component; carries two contract testids | KEEP |
| `invoices/RecordPaymentDialog` | detail, lifecycle node | amount/method/date entry with the `amountDue` cap and the unspent-deposit guard | `ui/dialog` | money entry with a deposit-consumption warning | KEEP |
| `communication/JobCommunicationsTab` | detail, Communication | unified call/email/sms/whatsapp timeline plus a composer | `data/timeline` | the kit timeline renders events; this owns four channels, the composer and three send mutations | KEEP |
| `tasks/CreateTaskModal` | detail | task creation preset to this job | `ui/dialog` | a full form with its own store writes | KEEP |
| `tasks/JobLeadTasksTab` | detail, Tasks | grouped task lists, AI suggestion flow, task detail drawer | `crm/kanbanBoard` | the kanban is a board primitive; this owns `listTasks`, the AI suggestion call and the drawer | KEEP |
| `inventory/lo/LOList` | detail, Logistics | logistic orders for the job | none | inventory-module surface | KEEP |
| `ui/VideoPreviewDialog` | detail (transitively, via the attachments body) | video playback overlay | `ui/dialog` | no kit media surface | KEEP |
| `pages/JobDetailPage` -> `AttachmentsTabBody` | detail, Attachments | upload control, drag-and-drop zone, photo/document/walkthrough buckets, per-file POST loop | none | **and it may not be re-authored**: its tiles need raw `<a>`, `<img>`, `<input type="file">` and `<label>` elements, and the design-system raw-tag ratchet is at its floor for all four, so a v2 file cannot add one. Imported as a named export from the legacy page, the same move `pages/v2/customers/CustomerFormPage.tsx` made for `customerSchema`. **This is the one import that must be re-homed before the legacy page can be deleted at cutover.** | KEEP |
| `patterns/FormField` | create form | label + hint + error + generated id, with a function-as-child variant | `form/formField` | the kit's is a `Controller` wrapper needing a `FormProvider` and a `render` prop per field; this form is built on `register`/`watch` and three of its controls supply their own DOM. Replaced with a local `Field` helper over the kit `Label` rather than rewriting the form onto the Controller API, which would be a logic change | BUILD (a non-Controller FormItem) |
| `jobs/overview/SectionCard` + `SectionLabel` | detail | card with title / icon / meta / tone slots, plus a small uppercase caption | `ui/card` (`CardHeader`/`CardTitle`/`CardContent`) | the kit Card has no icon or meta slot and no `tone="ai"`. Page-authored sections moved onto kit Card + a local `Caption`; the app children that render SectionCard internally are untouched, so a v2 Overview tab still shows both treatments side by side until those children are migrated | BUILD (icon + meta slots on CardHeader) |
| Tabs (`patterns/TabStrip`, `ui/tabs`) | detail | the nine-tab strip | none | the kit ships no Tabs primitive; reused `pages/v2/leads/components/tabs.tsx` (`TabStrip` / `TabPanel`), which already carries the `role="tablist"`/`tab`/`tabpanel` contract | BUILD |
| `ui/heading` | list, create form, detail | `h1`-`h6` with a scale | `layout/pageHeader` (list + form) | the detail hero's title is an inline identity line, not a page title, so it renders as `role="heading" aria-level={1}` - the raw-tag ratchet counts `<h1>`-`<h6>` outside the primitives and the kit ships no Heading | BUILD |
| An anchor primitive | detail hero | `<a href="tel:">` for the customer phone | none | the `<a>` ratchet is at its floor, so this is a kit Button that sets `window.location.href` - the precedent `pages/v2/leads/components/contactCell.tsx` set | BUILD |
| Kit `DataTable`: no `sorting` / `onSortingChange` | list | sorting is SERVER-side (`sortBy`/`sortDir` on `/api/jobs`) | `data/dataTable` owns a client `SortingState` with no callback out | four sortable headers drive the page's own state instead (`jobsColumns.tsx`), every column declared `enableSorting: false` | BUILD |
| Kit `DataTable`: no `rowSelection` / `onRowSelectionChange` | list | the bulk status/assign bar needs the selected ids, and the selection must drop when the query scope moves (`lib/useScopedRowSelection.ts`) | same - internal state, no callback | worked around with `components/bulkBar.tsx`, a real component under the `children` render prop, so it can hold the reset effect that a render prop cannot | BUILD |
| Kit `DataTable`: no `tableKey` / saved view | list | legacy persists column widths + visibility to `GET/PUT /api/table-views/jobs` via `useTableView('jobs')` | none | no hook-in exists; **a v2 user's column layout is per-session** | BUILD |
| Kit `DataTable`: no pinned columns, per-column resize, header context menu, row virtualization, mobile card layout | list | legacy pins Job #/Customer, resizes with min-width clamping, virtualizes above 40 rows and renders one stacked card per row below `md` | `data/dataTable` flex-fills columns and is one layout at every width | all five are behaviour, not style; they are simply absent in v2 | BUILD |
| Filter popover with a per-domain status chip | list | status facet options painted as the badge the table shows | `crm/filterBar` renders chips, not the facet editor | `pages/v2/leads/components/filterPopover.tsx` hardcodes `domain="lead"`; copied into this module with a `job` lifecycle palette rather than editing a file every other module branch also wants to change | BUILD (hoist to a shared v2 location at integration) |
| Status chip | list, detail | one badge per domain, resolving through `design-system/status-registry` | `ui/badge` | `pages/v2/leads/components/statusChip.tsx` hardcodes a `lead` lifecycle map; a third module-local copy was made rather than a cross-branch edit. Jobs needed its own map: five of the seven job statuses share the `warning` intent, so painting off intent alone leaves the Status column near-monochrome | BUILD (one shared v2 chip at integration) |

## Replaced (the audit trail)

Every `@/components/...` import across the three legacy pages, and what stands in for it.

### `pages/JobsPage.tsx` (11 rows)

| Old component | Replaced by | Notes |
|---|---|---|
| `data/data-table` (`DataTable`) | `ui-kit/components/data/dataTable/dataTable` + `dataTableToolbar` | server paging drives the kit footer, which is now the page's only paging control; sorting and selection moved out (see gaps) |
| `data/KpiStrip` | `ui-kit/components/data/statCard` (`StatCard`, `StatCardGroup`) | six tiles, same values, same active predicates and the same toggle-off-to-clear behaviour; the legacy `sub` line moved into the delta chip, and the per-tile `tone` was dropped for the reason the leads and customers modules give |
| `data/status-badge` (`StatusBadge`) | `pages/v2/jobs/components/statusChip` over `ui-kit/components/ui/badge` | domain-driven, still resolves labels through `design-system/status-registry` (including the `UNASSIGNED` -> "Unscheduled" rename) |
| `data/TagChips` (`tagsColumn`) | kept - `TagChips` used directly in the v2 column def | the helper's own `meta` shape does not carry the kit's `label`, so the column is declared inline; gap row above |
| `filters/FilterBar` | `pages/v2/jobs/components/filterPopover` | same `jobsRegistry`, same `FilterState`, same `useFilterState` URL codec; only the controls are kit |
| `filters/AppliedChips` | `pages/v2/jobs/components/appliedFilters` over `ui-kit/components/crm/filterBar` | same chip vocabulary, same 3-value collapse, same per-chip removal asymmetry |
| `jobs/BulkCancelJobsDialog` | kept | gap row above |
| `ui/button` | `ui-kit/components/ui/button` | |
| `ui/dropdown-menu` | `ui-kit/components/ui/dropdownMenu` | Export menu, bulk status menu, bulk assign menu |
| `ui/heading` | `ui-kit/components/layout/pageHeader` | the `Briefcase` glyph beside the title is gone - PageHeader has no icon slot, and the kit's stated rule is that a decorative glyph beside a page title carries no information |
| `ui/use-toast` (`toast`) | `ui-kit/components/ui/sonner` (`toast`) | API differs: `toast(title, { description })` / `toast.error(...)` replaces `toast({ title, description, variant })` |
| (bulk bar authored inline) | `ui-kit/components/crm/bulkActionBar` via `pages/v2/jobs/components/bulkBar` | same two menus, same ability gates, same `window.confirm` copy, same mutations and invalidation set |

### `pages/JobFormPage.tsx` (11 rows)

| Old component | Replaced by | Notes |
|---|---|---|
| `crm/PickOrCreateCustomer` | kept | gap row above |
| `crm/address-autocomplete` | kept | gap row above |
| `crm/service-location-map` | kept | gap row above |
| `customers/DuplicateCustomerDialog` | kept (type import only) | gap row above |
| `patterns/FormField` | local `Field` helper over `ui-kit/components/ui/label` | gap row above |
| `ui/button` | `ui-kit/components/ui/button` | |
| `ui/heading` | `ui-kit/components/layout/pageHeader` | title + breadcrumbs + the Back action |
| `ui/input` | `ui-kit/components/ui/input` | |
| `ui/select` | `ui-kit/components/ui/select` | job type, source, service location |
| `ui/switch` | `ui-kit/components/ui/switch` | the Schedule reveal; gained an `aria-label`, which the legacy switch has none of |
| `ui/textarea` | `ui-kit/components/ui/textarea` | service request |
| (bare `rounded-xl` div) | `ui-kit/components/ui/card` | padding on an inner div, never as a className on Card |

### `pages/JobDetailPage.tsx` (32 rows)

| Old component | Replaced by | Notes |
|---|---|---|
| `communication/JobCommunicationsTab` | kept | gap row |
| `crm/IconRail` | kept | gap row |
| `crm/InternalCostsCard` | kept | gap row |
| `data/status-badge` | `pages/v2/jobs/components/statusChip` | used for the `job`, `invoice` and `estimate` domains |
| `inventory/lo/LOList` | kept | gap row |
| `invoices/CreateJobInvoiceDialog` | kept | gap row; mounted twice, as today |
| `invoices/RecordPaymentDialog` | kept | gap row |
| `jobs/AiInsightsCard` | kept | gap row |
| `jobs/AiJobAssistantBar` | kept | gap row |
| `jobs/AssignJobDialog` | kept | gap row |
| `jobs/AttachEstimateDialog` | kept | gap row |
| `jobs/CancelJobDialog` | kept | gap row |
| `jobs/EditJobLocationDialog` | kept | gap row |
| `jobs/JobLifecycleBar` | kept | gap row |
| `jobs/JobStagesSection` | kept | gap row |
| `jobs/PaymentsTab` | kept | gap row |
| `jobs/TeamCard` | kept | gap row |
| `jobs/ViewWorkOrderDialog` | kept | gap row |
| `jobs/items/JobBillingSummary` | kept | gap row |
| `jobs/items/LineItemsEditor` (`LineItemsEditor`, `JobScopeOfWorkCard`) | kept | gap row |
| `jobs/items/ReceiptCard` | kept | gap row |
| `jobs/overview/CustomerContactCard` | kept | gap row |
| `jobs/overview/JobFilesCard` | kept | gap row |
| `jobs/overview/JobNotesPreview` | kept | gap row |
| `jobs/overview/SectionCard` (`SectionCard`, `SectionLabel`) | `ui-kit/components/ui/card` (`Card`/`CardHeader`/`CardTitle`/`CardContent`) + a local `Caption` | gap row |
| `leads/TagInput` | kept | gap row |
| `patterns/TabStrip` + `ui/tabs` (`TabsContent`) | `pages/v2/leads/components/tabs` (`TabStrip`, `TabPanel`) | same nine tab values, same gates, same order |
| `tasks/CreateTaskModal` | kept | gap row |
| `tasks/JobLeadTasksTab` | kept | gap row |
| `ui/VideoPreviewDialog` | kept, reached through the imported attachments body | gap row |
| `ui/badge` | `ui-kit/components/ui/badge` | sub-status, Plan Visit, walkthrough marker |
| `ui/breadcrumb` | `ui-kit/components/layout/nav/breadcrumbs` (+ the `BreadcrumbItem` TYPE still imported from the app) | the type is the wire shape of `location.state.breadcrumbs`, which callers in other modules set - importing it is not a presentation choice |
| `ui/button` | `ui-kit/components/ui/button` | including the pencil affordances and the schedule tile, both of which were raw `<button>`s |
| `ui/card` | `ui-kit/components/ui/card` | |
| `ui/confirm-dialog` | `ui-kit/components/ui/confirmDialog` | same delete confirmation, same synced-inventory sentence |
| `ui/dropdown-menu` | `ui-kit/components/ui/dropdownMenu` | Actions menu, sub-status menu; `variant="destructive"` on Cancel and Delete |
| `ui/empty-state` | `ui-kit/components/data/emptyState` | not-found, no-linked-estimate, no-notes |
| `ui/heading` | `role="heading" aria-level={1}` span | gap row |
| `ui/select` | `ui-kit/components/ui/select` | inline service-type edit |
| `ui/skeleton` | `ui-kit/components/ui/skeleton` | the loading tree was rebuilt to match the real tab count instead of the legacy hard-coded four labels |
| `ui/use-toast` | `ui-kit/components/ui/sonner` | |
| page-local `AttachmentsTabBody` | imported from `@/pages/JobDetailPage` | gap row - the one import that blocks deleting the legacy page |
| page-local `NotesTabBody` | re-authored on kit `Card` / `Textarea` / `Button` / `EmptyState` / `Badge` | its only raw element was a `<textarea>`, which the kit's Textarea replaces one-for-one; the mutation, its invalidation pair, the Cmd/Ctrl+Enter submit and the newest-first sort are unchanged |
| `pages/StatementPage` (route sibling) | `pages/v2/customers/StatementPage` | the Customers module's file already handles the job scope; the route points at it rather than copying it |

## Deliberate presentation departures

Not gaps - decisions, each recorded so the audit does not have to re-derive them.

| What | Legacy | v2 | Why |
|---|---|---|---|
| Search debounce | inside `DataTable` (300 ms) | `useDebounce(searchInput, 300)` on the page | the kit toolbar lifts every keystroke; page still snaps to page 1 on the keystroke, so no state is written from an effect |
| Applied-chip bar visibility | `Object.keys(value).length > 0` | `facetSelectionCount(...) > 0` per facet | the legacy gate leaves an empty chip row after clearing the last value of a facet, because `value` keeps the emptied entry |
| Empty export | silent no-op | an informational toast | the leads module's precedent; costs no behaviour |
| Selection column | always rendered | only when the viewer can act on it | the legacy bulk bar is entirely ability-gated, so a viewer with neither a status verb nor `assign Job` could tick rows and be offered nothing |
| Customer cell | plain text | a link to the customer | the row still navigates to the job (`stopPropagation` on the link); the detail page already links the customer, so the list now matches |
| Job status palette | five of seven statuses amber | purple / blue x2 / amber x2 / green / slate | the kit's own lifecycle grammar, cited by name in `pages/v2/leads/components/statusChip.tsx`. Seven statuses do not fit six hues, so `SCHEDULED`+`EN_ROUTE` and `ON_SITE`+`IN_PROGRESS` deliberately pair |
| Deposit status casing | `capitalize` class on the badge | sentence-cased in JS | the component-API ratchet counts an appearance token handed to Badge and sits at its floor |
| Detail-page delete | app `ConfirmDialog` | kit `ConfirmDialog` | same two-button confirmation; the description now names the job number |

## Observed but not fixed

| What | Where | Why it is out of scope |
|---|---|---|
| The behaviour map is substantially stale | `md_files/specs/ui-redesign/jobs-behavior-map.md` | see the branch report; the code was followed throughout |
| Dead computed values: `canUnassign`, `canAddNotes`, `remainingUnbilled` (explicitly `void`ed) | `pages/JobDetailPage.tsx` `getAvailableActions` | carried over verbatim rather than dropped - removing them is a behaviour-adjacent cleanup, not a restyle |
| `canCreateInvoice` is a CLASS-level `create Invoice` check | `pages/JobDetailPage.tsx` | a technician holding the per-user grant sees "Create Invoice" on ANY job they can read, including jobs they are not assigned to, where the API 403s. Narrowing it to `canOnJob` would be a logic change |
| `record_payment` and `reschedule` grants are not consulted by this module | `pages/JobDetailPage.tsx` | the Schedule/Reschedule affordance is gated on `assign`, and the Payments tab's Record Payment link carries no ability check at all. Both are pre-existing |
| The same communications payload is fetched twice under two keys | `CustomerContactCard` (`job-communications-preview`) and `JobCommunicationsTab` (`job-communications`) | deduplicating changes cache behaviour for both consumers |
| `AssignJobDialog`'s conflict-override POST drops `is_all_day` | `components/jobs/AssignJobDialog.tsx` | an all-day booking forced through a conflict loses the flag. Looks like a bug; it is current behaviour and lives in a shared component |
| The attachment upload loop aborts mid-batch on the first failure | `AttachmentsTabBody` | a failure on file 3 of 5 leaves 1 and 2 uploaded, silently skips 4 and 5, and fires one toast |
| The list query has no `isError` branch | `pages/JobsPage.tsx` | a failed fetch renders identically to an empty list. Reproduced as-is; adding an error state is a behaviour change |
| `No results found.` covers both "no jobs exist" and "no jobs match" | `pages/JobsPage.tsx` | same - the kit's own EmptyState doc calls this out as the usual mistake, but distinguishing them here is a behaviour change |
| `TeamCard` and `AssignTeamPopover` load avatars from `i.pravatar.cc` | `components/jobs/TeamCard.tsx` | a third-party image request seeded by user id, on a permissioned page. Untouched shared component |
| The detail page's active tab is not in the URL | both legacy and v2 | a deep link cannot open a specific tab and a reload returns to Overview. Preserved deliberately |
| `e2e/specs/redesign/01-journey.spec.ts` (J-05) asserts there is NO `/jobs/new` route | `frontend/e2e/` | its header comment says the New Job button opens a `NewJobDialog` titled "Create Job". No such component exists in the repo and `App.tsx` does register `/jobs/new`. The spec is stale or targets another build; not resolved here |
| `e2e/specs/wt-job-detail.spec.ts` + `e2e/pages/job-detail-v2.page.ts` target `Walkthrough` and `Work Items` tabs | `frontend/e2e/` | neither tab exists in the current nine-tab set, so those locators cannot match today |
| The brief's note about `react-signature-canvas` does not apply to Jobs | - | the only importer in the tree is `pages/PublicEstimatePage.tsx`; no jobs page, component or dialog uses it |
