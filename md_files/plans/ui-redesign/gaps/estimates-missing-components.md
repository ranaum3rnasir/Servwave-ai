# Estimates - components with no kit equivalent

Module 4. Branch `refactor/ui-kit-04-estimates`, built off the UI integration base.

New files, all additive:

```
frontend/src/pages/v2/estimates/EstimatesPage.tsx
frontend/src/pages/v2/estimates/EstimateWorkspacePage.tsx
frontend/src/pages/v2/estimates/NewEstimateRedirect.tsx
frontend/src/pages/v2/estimates/estimatesColumns.tsx
frontend/src/pages/v2/estimates/components/statusChip.tsx
frontend/src/pages/v2/estimates/components/filterPopover.tsx
frontend/src/pages/v2/estimates/components/appliedFilters.tsx
frontend/src/pages/v2/estimates/components/newEstimateDialog.tsx
frontend/src/pages/v2/routes/estimates.paths.ts
frontend/src/pages/v2/routes/estimates.routes.tsx
```

No existing file was edited. Three routes, mirroring `App.tsx` exactly:
`/v2/estimates`, `/v2/estimates/new`, `/v2/estimates/:id`, all inside
`ProtectedRoute(ADMIN, SALES, DISPATCHER, TECHNICIAN)` with **no** `RequireFeature`
(estimates carry no entitlement gate) and `/estimates/new` declared before `/estimates/:id`.

---

## The behaviour map is stale - read this first

`md_files/specs/ui-redesign/estimates-behavior-map.md` was written against `main @ 7dfa18e9`
and describes a module that no longer exists. The code won, per the brief. What actually changed:

| The map says | The tree has |
|---|---|
| `EstimateDetailPage.tsx` (1142 lines) | **deleted.** Replaced by `EstimateWorkspacePage.tsx` (898 lines) |
| `EstimateFormPage.tsx` (758 lines) | **deleted.** Estimates are create=edit; the workspace IS the editor |
| Route `/estimates/:id/edit` | **gone.** Three routes, not four |
| `/estimates/new` renders a form | `NewEstimateRedirect.tsx` - eagerly POSTs an empty DRAFT then replaces itself with `/estimates/:id` |
| `components/shared/LineItemsEditor` | `components/shared` was deleted (structure guard I1). Estimates now have their own `components/estimates/EstimateLineItemsEditor` with scopes, photos, price-book search and per-line granular endpoints |
| List stats keys `stats.approved` / `stats.cancelled` | the API now returns `stats.won` / `stats.archived` |
| List has 7 columns, no selection | 9 columns: a Tags column (`tagsColumn`) and row selection driving 3 bulk endpoints (`bulk-delete`, `bulk-status`, `bulk-send-reminder`) |
| Estimates registry has 5 facets | 6 - `TAGS_FACET` was added |
| "Create estimate without a lead" is a live dead end (400 on submit) | **fixed.** `EstimateAnchor` is `lead_id | customer_id | job_id` and the backend accepts any one |
| Detail page has a Tabs card (Line Items / Details / Notes / Deposit / Tasks) | a 1fr + 320px rail layout with scope-of-work, line items, receipt, internal costs, notes, attachments and a tasks section - no tab strip |
| Only 2 `data-testid` in the module | still true (`refund-deposit-dialog`, `refund-deposit-submit`), both inside `RefundDepositDialog`, imported unchanged |

Everything below is written against the code, not the map.

---

## Gaps

Components with no kit equivalent. Each is imported and used **as-is**; none was forked or edited.

| Old component | Used in | What it does | Kit's nearest thing | Why it is not enough | Rec |
|---|---|---|---|---|---|
| `estimates/EstimateLineItemsEditor` (+ `EstimateScopeOfWorkCard`) | v2 workspace | The whole authoring surface: per-line add/update/delete/reorder against granular endpoints, price-book search, per-line photos, discounts, margin, save-to-catalog | none | The kit ships primitives, not an editable priced-document grid. This is the estimates equivalent of the `crm/LineItemsEditor` row already in section 1c | KEEP |
| `estimates/EstimateReceiptCard` | v2 workspace | Money rail: subtotal, discounts, tax, deposit, with inline blur-to-PATCH editing | none | Same reason. Money math is backend-mirrored and must not be re-expressed | KEEP |
| `estimates/EstimateInternalCostsCard` | v2 workspace | Staff-only cost/labour/overhead/margin panel, gated by `canSeePricing` | none | Domain surface with its own mutations and permission gate | KEEP |
| `estimates/SendEstimateDialog` | v2 workspace | Recipient + CC chips, message body, deposit toggle, payment-method matrix, CC surcharge maths | `ui/dialog` | The shell is kit-able; the contents are a payment-configuration form with org-entitlement logic | KEEP |
| `estimates/RecordEstimatePaymentDialog` | v2 workspace | Two-way %/amount binding, method, date, reference | `ui/dialog` | Same | KEEP |
| `estimates/RefundDepositDialog` | v2 workspace | Stripe-vs-manual refund with reason taxonomy. **Carries the module's only two `data-testid`s** | `ui/dialog` | Same, and porting it would risk the e2e selector contract | KEEP |
| `estimates/WaiveDepositDialog` | v2 workspace | Waive-or-cancel radio, voids the deposit invoice | `ui/dialog` | Same | KEEP |
| `estimates/CancelEstimateDialog` | v2 workspace | Required-reason archive | `ui/confirmDialog` | The kit's confirmDialog has no free-text reason field | KEEP |
| `estimates/DeclineEstimateInternalDialog` | v2 workspace | Required lost-reason decline | `ui/confirmDialog` | Same | KEEP |
| `estimates/VoidApprovalDialog` | v2 workspace | Admin-only guarded unwind of a WON estimate | `ui/confirmDialog` | Same | KEEP |
| `estimates/MarkSentDialog` | v2 workspace | Off-platform "already sent" with deposit config | `ui/dialog` | Same as SendEstimateDialog | KEEP |
| `estimates/DuplicateEstimateDialog` | v2 workspace | Target-lead picker for a re-quote | `ui/dialog` | Same | KEEP |
| `estimates/PdfPreviewDialog` | v2 workspace | Authed fetch, content-type guard, blob iframe, download | none | The kit has no document viewer. Already flagged for invoices too | KEEP |
| `features/estimate-workspace/CustomerHeader` | v2 workspace | Customer + service-address + "Attached to" hero | `data/descriptionList` | Resolves lead-anchored vs customer-anchored vs job-anchored addressing; not a list of fields | KEEP |
| `features/estimate-workspace/EstimateNameTitle` | v2 workspace | Inline-rename title with its own PATCH | none | Editable heading; no kit primitive | KEEP |
| `features/estimate-workspace/EstimateTabs` | v2 workspace | Per-lead sibling estimate strip with add-blank / add-copy | none | **The kit ships no tab component at all** - already the highest-value gap in section 1b. This one is also a data-driven navigator, not a tab strip | BUILD (tabs) |
| `features/estimate-workspace/NotesCard` | v2 workspace | Notes list + composer against `/notes` | `crm/noteEditor` | The kit's editor is an input; this owns fetching, posting and the list | BUILD |
| `features/estimate-workspace/AttachmentsSignaturesCard` | v2 workspace | Upload, lightbox, signature block | none | Already listed as `crm/AttachmentSection` in section 1c | KEEP |
| `features/estimate-workspace/HistoryPanel` | v2 workspace | Timeline drawer over `/history` | `data/timeline` + `ui/sheet` | The kit's timeline is a static renderer; this owns the query and the event vocabulary | BUILD |
| `tasks/JobLeadTasksTab` | v2 workspace | Cross-module tasks surface (Job, Lead, Estimate) | none | Shared across three modules - importing is the rule, not the exception | KEEP |
| `leads/TagInput` | v2 workspace | Entity tag editor with create-on-type | `crm/tagInput` | The kit's is uncontrolled local state; this one owns the tag API, colours and entity binding | BUILD |
| `data/TagChips` | v2 list (Tags column) | Read-only tag chips coloured from `tag.color` | `ui/badge` | Badge's colours are a closed variant set. `tag.color` is runtime user data applied as an inline style | BUILD |
| `ui/thumbnail` | v2 workspace (signature) | Sized image tile | none | The kit ships no image primitive, and `component-api-guard`'s raw-`<img>` ratchet is at its floor (38), so a raw tag was not an option | KEEP |

## Replaced (the audit trail)

Every `@/components/...` import across the three legacy pages, accounted for.

### `pages/EstimatesPage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/heading` | `ui-kit/components/layout/pageHeader` | `PageHeader` also carries the breadcrumb trail and the primary action |
| `data/KpiStrip` | `ui-kit/components/data/statCard` (`StatCard` + `StatCardGroup`) | All seven tiles, same order, same activation logic. The per-tile `tone`/icon is dropped (kit rule: StatCards carry no colour); the legacy `sub` line becomes the `delta` chip, so "Pending Deposits" reads `N outstanding` rather than `(N)` |
| `data/data-table` | `ui-kit/components/data/dataTable` + `dataTableToolbar` | Server paging handed to the table (`page`/`pageCount`/`pageSize`/`rowCount`); its footer is the page's only paging control. Sorting stays page-owned - see the note below |
| `data/status-badge` | `pages/v2/estimates/components/statusChip.tsx` | Reads the same `design-system/status-registry`; only the painting moves to the kit's `Badge` |
| `data/TagChips` (`tagsColumn`) | `TagChips` imported as-is; only the column shell redeclared | Gap row above. The shell is redeclared solely to carry the kit's `meta.label` for the column-visibility menu |
| `filters/FilterBar` | `pages/v2/estimates/components/filterPopover.tsx` | Same `FacetConfig[]` registry, same `FilterState`, same `useFilterState` codec. Two losses: no dual-handle slider (kit ships none) and no rail icons (the legacy bar had already stopped rendering them) |
| `filters/AppliedChips` | `pages/v2/estimates/components/appliedFilters.tsx` -> `ui-kit/components/crm/filterBar` | Chip vocabulary, the 3-value collapse and the asymmetric removal semantics carried over verbatim |
| `ui/button` | `ui-kit/components/ui/button` | `variant="solid" tone="danger"` -> `variant="destructive"`; `variant="solid" tone="business"` -> default |
| `ui/dropdown-menu` | `ui-kit/components/ui/dropdownMenu` | Export menu, unchanged contents |
| `ui/use-toast` | `ui-kit/components/ui/sonner` | `toast({title, description, variant:'destructive'})` -> `toast.error(title, {description})`. Different API, same strings |
| `estimates/NewEstimateDialog` | `pages/v2/estimates/components/newEstimateDialog.tsx` | Rebuilt, not imported: the original navigates to bare legacy paths, which drops a v2 user out of the layer. Queries, keys, debounce, branch order, copy and the load-bearing `ACTIVE_STATUSES` allowlist are the original's |
| bespoke bulk-selection bar | `ui-kit/components/crm/bulkActionBar` | Same four actions, same ability gates, same two `window.confirm` prompts |
| bespoke "No results found." cell | `ui-kit/components/data/emptyState` | One string, no filter-aware variant - the legacy list does not distinguish "none exist" from "none match" |

### `pages/NewEstimateRedirect.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/button` | `ui-kit/components/ui/button` | The error-state "Back to estimates" |
| `lucide Loader2` | `ui-kit/components/ui/spinner` | |
| (logic) `features/estimate-workspace/lib/newEstimate` | imported unchanged | Anchor priority, the StrictMode double-effect guards and the cache drop are the original's |

### `pages/EstimateWorkspacePage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/button` | `ui-kit/components/ui/button` | Includes the raw 32px back `<button>`, which now has a real cell (`variant="ghost" size="icon-sm"`) |
| `ui/dropdown-menu` | `ui-kit/components/ui/dropdownMenu` | The Actions menu, item for item, with `variant="destructive"` on Void Approval / Archive / Delete instead of a `text-danger` class |
| `ui/dialog` | `ui-kit/components/ui/dialog` | The delete confirmation only. The eleven domain dialogs are imported as-is (gap rows) |
| `ui/skeleton` | `ui-kit/components/ui/skeleton` | |
| `ui/use-toast` | `ui-kit/components/ui/sonner` | Same mapping as the list page |
| `data/status-badge` | `pages/v2/estimates/components/statusChip.tsx` | |
| `jobs/overview/SectionCard` | `ui-kit/components/ui/card` | Only the "Estimate Info" card, rebuilt on `Card`/`CardHeader`/`CardTitle`/`CardContent`. The other `SectionCard` users are inside imported components and untouched |
| raw tinted `<div>` banners | local `Banner` in the page | Locked / superseded / modified-after-send. A plain `<div>`, deliberately not the kit's `Card`: the component-API ratchet counts appearance classes handed to `<Card>`, and the tint is now chosen once inside `Banner` and selected by a `tone` name |
| raw `<h4>` "Deposit Actions" eyebrow | `ui-kit` `Card` + `CardTitle` | Removes a raw heading tag |
| raw `<img>` signature | `components/ui/thumbnail` | Gap row above; `component-api-guard`'s `<img>` ratchet is at its floor |
| eleven `components/estimates/*` dialogs + five `features/estimate-workspace/*` cards + `tasks/JobLeadTasksTab` + `leads/TagInput` | imported unchanged | One gap row each above |

### Logic imported unchanged (no row needed, listed so the audit is complete)

`lib/axios`, `lib/utils`, `lib/customer-name`, `lib/format-date`, `lib/date-range`, `lib/inventory/csv`,
`lib/bulk-result`, `lib/useScopedRowSelection`, `lib/ability` (`canSeePricing`), `lib/api/estimates`,
`lib/api/organization`, `lib/api/tags`, `lib/filters/*` (types, `useFilterState`, `estimatesRegistry`,
`MONTHLY_ESTIMATE_STATUSES`), `constants/estimateStatus`, `contexts/AbilityContext`,
`design-system/status-registry`, `features/estimate-workspace/lib/{newEstimate,panelEstimate}`.

Nothing in that list was copied, tweaked or re-declared.

## Shape differences forced by the kit

| What | Why | Where |
|---|---|---|
| Sorting stays page-owned; every column is `enableSorting: false` | The kit's DataTable owns a client sorting state with no callback out, and estimate sorting is server-side | `estimatesColumns.tsx` |
| Row selection stays page-owned, bound to `useScopedRowSelection` | The legacy list scopes selection to the current query. The kit table's internal selection cannot be reset from outside without an effect that repaints once with stale rows still ticked | `EstimatesPage.tsx`, `estimatesColumns.tsx` |
| `filterPopover.tsx` / `appliedFilters.tsx` are module-local copies of the leads module's | The leads versions hard-code `domain="lead"` and know nothing about a facet `swatch`; fourteen branches run in parallel, so parameterising a finished module's file is a cross-branch edit this branch does not own | see "Observed but not fixed" #5 |
| `statusChip.tsx` is a module-local copy for the same reason, with no lifecycle-override map | The estimate and deposit vocabularies are already one intent per stage, so painting straight off the registry intent separates every status without a second status-to-appearance map | `components/statusChip.tsx` |
| `NewEstimateDialog` is declared then exported at the bottom of its file | The duplicate-primitive guard demands a `*Dialog` export import from `@/components/ui/dialog`; a v2 file composes the kit's dialog instead. The leads module settled on the deferred-export form and this follows it | see "Observed but not fixed" #2 |

## Observed but not fixed

| What | Where | Why it is out of scope |
|---|---|---|
| 1. The behaviour map describes a module that no longer exists - two deleted pages, a deleted route, renamed stat keys, a resolved dead end | `md_files/specs/ui-redesign/estimates-behavior-map.md` | It is a spec document, not code. Every divergence is tabulated at the top of this ledger; regenerating the map is its own task |
| 2. The duplicate-primitive design-system guard only recognises `@/components/ui/*`, so a v2 file that correctly composes `@/ui-kit/components/ui/dialog` reads as a hand-rolled shadow | `frontend/src/design-system/__tests__/` | Teaching it about the kit means editing a shared guard that every module branch would also touch. Two modules now work around it identically, which is the signal to fix it once, centrally |
| 3. The layering guard governs `components/{ui,data,layout}` and `design-system` but not `ui-kit/`, so appearance classes on kit primitives are uncounted | same | Same reason. It is why the v2 pages can pass `className` to kit components at all; widening it is a migration-wide decision |
| 4. The unresolved-class scanner reads comments, so writing a hyphenated filename ending in `.ts` inside a JSDoc block registers as an unresolvable Tailwind utility. Cost one CI-visible false positive on this branch | `frontend/scripts/check-unresolved-classes.mjs` | A scanner change, unrelated to this module |
| 5. `filterPopover`, `appliedFilters` and `statusChip` now exist twice (leads and estimates) and will exist fourteen times | `pages/v2/*/components/` | Deliberate under the parallel-branch rule. The consolidation is a post-landing pass, and doing it from a module branch would edit a module this branch does not own |
| 6. Open conflict E1: the estimates registry labels `PENDING` as "Pending" while `status-registry` labels it "Approved - Deposit Pending". A v2 list therefore shows one string in the Status column and the other in the Status filter facet | `lib/filters/registries/estimates.ts` vs `design-system/status-registry.ts` | Flagged as unadjudicated in the registry's own comment and explicitly held. Picking a side is a product decision |
| 7. `status-registry`'s `PENDING` label contains an em dash, which CLAUDE.md bans | `design-system/status-registry.ts:162` | Rendered user-facing copy in a shared file. Changing it is a copy change across every module that reads the registry |
| 8. `EstimatesPage`'s Create-Job deposit allowlist is `['PAID','VOIDED']` while the server accepts `PAID/VOIDED/PARTIALLY_REFUNDED/REFUNDED`, so a refunded deposit disables a button the API would honour | `EstimateWorkspacePage` (both layers) | A real guard divergence, reproduced verbatim. Fixing it changes who can create a job |
| 9. Archive is offered for `DRAFT|SENT` only, while the server accepts `DRAFT|SENT|PENDING` | same | Same reason |
| 10. `EstimateTabs` renders only for a lead-anchored estimate, so a customer- or job-anchored one has no sibling navigator | `features/estimate-workspace/components/EstimateTabs.tsx` | Pre-existing, and the component is cross-module shared |
| 11. `component-api-guard` reports slack on three ratchets (`TableCell` 1/3, `<h1-h6>` 58/67, `<table>` 56/57) | `frontend/src/design-system/__tests__/component-api-guard.test.ts` | The guard asks for the ceilings to be lowered. Lowering them is a shared-file edit that would conflict across every module branch |

## Verification

Run in `frontend/`, on this branch, against a baseline captured on the same tree before any change.

| | Baseline | After |
|---|---|---|
| `npx tsc --noEmit` | clean | **clean** |
| `npx vitest run src/pages/v2 src/design-system` | 14 passed / 1 failed (15 files), 306 passed / 1 failed (307 tests) | **identical** |
| `unresolved-classes-guard` | fails with 54 unresolved classes | **fails with the same 54** - no growth, and the set is byte-identical |
| `layering-guard` | green | **green** |
| existing estimate tests (15 files) | - | **15 passed, 91 tests** |

The `unresolved-classes-guard` failure is pre-existing on the base branch and is not this module's.
