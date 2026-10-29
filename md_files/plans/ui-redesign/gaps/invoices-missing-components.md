# Invoices - components with no kit equivalent

Module 6. Branch `refactor/ui-kit-06-invoices`.
Pages rebuilt under `frontend/src/pages/v2/invoices/`: `InvoicesPage.tsx`,
`StandaloneInvoiceFormPage.tsx`, `InvoiceDetailPage.tsx`.
Registered by `pages/v2/routes/invoices.paths.ts` + `invoices.routes.tsx`.

The import checklist is every `@/components/...` import across the three legacy pages - 39 rows,
all accounted for below.

## Gaps

| Old component | Used in | What it does | Kit's nearest thing | Why it is not enough | Rec |
|---|---|---|---|---|---|
| `crm/LineItemsEditor` | standalone form | editable line-item authoring: price-book search, per-line discount/cost/margin, taxable toggle | none | the kit ships no line-item surface at all; the editor also owns the price-book search/abort plumbing and the `blankLineItem()` shape the POST body is built from | KEEP |
| `invoices/InvoiceLineItemsEditor` + `InvoiceScopeOfWorkCard` | detail, Line Items tab | invoice-owned lines, estimate-basis read-only fallback, add/update/delete/billing mutations, edit-lock gating | none | four mutations, `isInvoiceEditable` gating and the `manage_lines` vs `update` split live inside it; rebuilding it forks the edit lock | KEEP |
| `invoices/InvoiceReceiptCard` | detail, Line Items tab | the ONE editable money surface - subtotal, discount, tip, tax jurisdiction, deposit credit, balance | none | pure money arithmetic plus the "a control is interactive iff its handler prop is provided" contract | KEEP |
| `invoices/SendInvoiceDialog` | detail (mounted twice: send + resend) | recipient/CC validation, message body, read-only invoice preview, POST send/resend | `ui/sheet` | the sheet is chrome; the CC chip rules, `EMAIL_RE`, `MAX_CC` and the send/resend endpoint split are the component | KEEP |
| `invoices/RecordPaymentDialog` | detail | amount/method/date/reference/notes, POST payments | `ui/dialog` | money entry with an `amountDue` cap and the documented overpayment behaviour | KEEP |
| `invoices/VoidInvoiceDialog` | detail | reason capture, POST void, synced-line warning | `ui/confirmDialog` | confirmDialog has no reason field and no inventory-return copy | KEEP |
| `invoices/DeleteInvoiceDialog` | detail | DRAFT-only delete with logistic-order consequences | `ui/confirmDialog` | same - it lists the downstream orders a delete would affect | KEEP |
| `invoices/RefundInvoiceDialog` | detail | refund ledger, amount cap at `netPaid`, method/payment targeting, non-taxable concession, reason category | none | prorated refund tax and the `netPaid` cap; self-invalidates, takes no `onSuccess` | KEEP |
| `invoices/CreditInvoiceDialog` | detail | credit amount, excess-refund split, category, reason | none | the `excess = max(parsed - balanceOwed, 0)` split is money logic | KEEP |
| `invoices/VoidPaymentDialog` | detail | per-payment void with category + reason | none | manual-method-only guard mirroring the backend | KEEP |
| `crm/InternalCostsCard` | detail | staff-only cost/margin panel | none | cost model (labor hours, overhead mode/value) with its own commit calls | KEEP |
| `crm/IconRail` | detail | right-hand Activity + Attachments rail | none | shared app infrastructure spanning every entity; belongs to a shell migration, not this one | KEEP |
| `leads/TagInput` | detail hero | entity tag add/remove | `crm/tagInput` | the kit's tagInput is an uncontrolled chip input with no entity binding; this one owns the `POST/DELETE /api/{entity}/:id/tags` calls and the org tag vocabulary | KEEP |
| `data/TagChips` + `tagsColumn` | list, Tags column | renders up to 2 tag chips plus a `+N` pill, coloured from runtime `tag.color` | `ui/badge` | the colour is user data applied as an inline style, which Badge's variant API cannot express | KEEP |
| `estimates/PdfPreviewDialog` | detail overflow | embedded PDF preview with download | none | iframe/blob plumbing, no kit equivalent | KEEP |
| Kit `DataTable`: no `columnVisibility` / `onColumnVisibilityChange` | list | legacy hides 4 money columns on first render (`DEFAULT_COLUMN_VISIBILITY`) | `data/dataTable` owns visibility in internal `useState` seeded `{}` | no prop in or out; worked around with `DefaultHiddenColumns`, a run-once effect over the table instance handed to the `children` render prop | BUILD |
| Kit `DataTable`: no `rowSelection` / `onRowSelectionChange` | list | bulk Send / Send reminder needs the selected ids | same - internal state, no callback | worked around with `SelectionBridge`, which lifts the ids out and resets the selection when the query scope changes (the rule `lib/useScopedRowSelection.ts` states) | BUILD |
| Kit `DataTable`: no `tableKey` / saved view | list | legacy persists column widths + visibility to `GET/PUT /api/table-views/invoices` via `useTableView` | none | no hook-in exists; **this is the one list behaviour v2 does not reproduce** - a v2 user's column layout is per-session | BUILD |
| Tabs | detail | Line Items / Payments | none | the kit ships no Tabs primitive; reused `pages/v2/leads/components/tabs.tsx` (`TabStrip` / `TabPanel`), which already carries the `role="tablist"`/`tab`/`tabpanel` contract | BUILD |
| Filter popover with a per-domain status chip | list | status facet options painted as the badge the table shows | `crm/filterBar` renders chips, not the facet editor | `pages/v2/leads/components/filterPopover.tsx` hardcodes `domain="lead"`; copied into this module with `domain="invoice"` as the ONLY change, rather than editing a file every other module branch will also want to change | BUILD (hoist to a shared v2 location at integration) |

## Replaced (the audit trail)

Every `@/components/...` import across the three legacy pages, and what stands in for it.

### `pages/InvoicesPage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `data/data-table` (`DataTable`) | `ui-kit/components/data/dataTable/dataTable` + `dataTableToolbar` | server paging drives the kit footer, which is now the page's only paging control; sorting moved to page state (see gaps) |
| `data/KpiStrip` | `ui-kit/components/data/statCard` (`StatCard`, `StatCardGroup`) | four tiles, same values, same click predicates; counts moved into the delta chip |
| `data/status-badge` (`StatusBadge`) | `pages/v2/leads/components/statusChip` over `ui-kit/components/ui/badge` | domain-driven, resolves through `design-system/status-registry` - including the derived `OVERDUE` |
| `data/TagChips` (`tagsColumn`) | kept - `TagChips` used directly in the v2 column def | gap row above |
| `ui/button` | `ui-kit/components/ui/button` | |
| `ui/dialog` | `ui-kit/components/ui/dialog` | "To Be Invoiced" modal |
| `ui/dropdown-menu` | `ui-kit/components/ui/dropdownMenu` | Export menu |
| `ui/empty-state` | `ui-kit/components/data/emptyState` | table empty row + the modal's empty state |
| `ui/stack` | flex utility markup | no kit layout primitive; the kit's own components compose with flex classes |
| `ui/text` | plain `span`/`p` + kit tokens | ditto |
| `ui/use-toast` (`toast`) | `ui-kit/components/ui/sonner` (`toast`) | API differs: `toast(title, { description })` / `toast.error(...)` replaces `toast({ title, description, variant })` |
| `patterns/ListPageShell` | `ui-kit/components/layout/pageHeader` + a plain page div | the shell's three-band rhythm is now header / stat group / table, each spaced by its own margin |
| `filters/FilterBar` | `pages/v2/invoices/components/filterPopover` | same registry, same `FilterState`, same `useFilterState` URL codec; only the controls are kit |
| `filters/AppliedChips` | `ui-kit/components/crm/filterBar` via `pages/v2/leads/components/appliedFilters` | imported and aliased `AppliedFilterBar`; it is module-agnostic despite the name |
| (bulk bar authored inline) | `ui-kit/components/crm/bulkActionBar` | Send / Send reminder, same 25-row cap and titles |
| (modal table authored inline) | `ui-kit/components/ui/table` | |
| (inline `Loading...` text) | `ui-kit/components/ui/spinner` | |

### `pages/StandaloneInvoiceFormPage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/breadcrumb` | `pages/v2/pageBreadcrumbs` over the kit's `layout/nav/breadcrumbs` | derived trail, `navKey="invoices"` + `label="New Invoice"` |
| `ui/button` | `ui-kit/components/ui/button` | |
| `ui/card` | `ui-kit/components/ui/card` (`Card`, `CardContent`) | |
| `ui/heading` | `ui-kit/components/layout/pageHeader` `title` | |
| `crm/PickOrCreateCustomer` | `pages/v2/leads/components/pickCustomer` (`PickCustomerFields`) | prop-compatible drop-in; it imports the ORIGINAL's types and duplicate-guard helpers, so #259/#267 have one implementation, not two. `#email` / `#phone` ids preserved, which `handleEditField` depends on |
| `crm/PickOrAccreteLocation` | `pages/v2/leads/components/pickLocation` (`PickLocation`) | same value type (`PickOrAccreteLocationValue`), same `ADD_NEW_LOCATION` sentinel, both still imported from the original |
| `customers/DuplicateCustomerDialog` | dialog rendered inside `PickCustomerFields`; the `ExistingCustomer` TYPE is still imported from the original | |
| `crm/LineItemsEditor` | kept as-is | gap row above |
| `hooks/useIsMobile` (`useMediaQuery`) | `ui-kit/hooks/useMediaQuery` | same contract; the JS gate that mounts EXACTLY ONE customer block (#259) is unchanged |

### `pages/InvoiceDetailPage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `ui/breadcrumb` | `ui-kit/components/layout/nav/breadcrumbs` | the three-case trail (incoming state / job / invoices) is unchanged; only the last two crumbs' hrefs move to `v2Path`, Jobs stays legacy |
| `ui/card` | `ui-kit/components/ui/card` | hero + tabs container |
| `ui/button` | `ui-kit/components/ui/button` | including the `tel:`/`mailto:` links, which are `variant="link"` Buttons rather than raw anchors (the raw-`<a>` ratchet is at its floor) |
| `ui/badge` | `ui-kit/components/ui/badge` | Deposit / Service Plan kind badges, ledger Source + Method chips |
| `data/status-badge` | `pages/v2/leads/components/statusChip` | |
| `ui/dropdown-menu` | `ui-kit/components/ui/dropdownMenu` | overflow menu; `variant="destructive"` on Void/Delete instead of a text-danger class |
| `ui/skeleton` | `ui-kit/components/ui/skeleton` | bespoke loading skeleton rebuilt on kit primitives |
| `ui/empty-state` | `ui-kit/components/data/emptyState` | empty payments ledger |
| `ui/heading`, `ui/text`, `ui/stack` | `role="heading"` + plain markup and flex utilities | the raw-tag ratchet forbids a new `h1`-`h6` outside the primitives |
| `ui/tabs` (`TabsContent`) + `patterns/TabStrip` | `pages/v2/leads/components/tabs` (`TabStrip`, `TabPanel`) | gap row above |
| `ui/use-toast` | `ui-kit/components/ui/sonner` | |
| `data/KpiStrip` | `ui-kit/components/data/statCard` | the Payments stat row |
| `jobs/overview/SectionCard` | plain section header + `StatCardGroup` | the card's tinted header band has no kit analogue and carried no behaviour |
| `crm/IconRail` | kept | gap |
| `crm/InternalCostsCard` | kept | gap |
| `leads/TagInput` | kept | gap |
| `estimates/PdfPreviewDialog` | kept | gap |
| `invoices/InvoiceReceiptCard` | kept | gap |
| `invoices/InvoiceLineItemsEditor` (+ `InvoiceScopeOfWorkCard`) | kept | gap |
| `invoices/SendInvoiceDialog` | kept | gap |
| `invoices/RecordPaymentDialog` | kept | gap |
| `invoices/VoidInvoiceDialog` | kept | gap |
| `invoices/DeleteInvoiceDialog` | kept | gap |
| `invoices/RefundInvoiceDialog` | kept | gap |
| `invoices/CreditInvoiceDialog` | kept | gap |
| `invoices/VoidPaymentDialog` | kept | gap |

`components/payments/` was checked and is NOT used by any of the three pages - it holds only the
Stripe onboarding drawer, banner and settings status card, all of which live in Settings.

## Behaviour deltas (not gaps, but not parity either)

| What | Legacy | v2 | Why |
|---|---|---|---|
| Saved table view | column widths + visibility persisted per user via `tableKey="invoices"` | per-session only | kit DataTable has no `tableKey`; escalated |
| "Clear all" on the chip bar | cleared facets AND the search box, reset to page 1 | clears facets and resets to page 1; the search box keeps its value | the kit FilterBar wires its own clear-all to `onChange({})`. The search box gained its own Reset in the table toolbar, so nothing is unreachable |
| Money-detail columns | hidden on first render, not persisted | same, via a run-once effect | see gaps |
| `getAvailableActions`, `isOverdue`, `getDueDateLabel`, `isDepositCreditPayment`, `round2` | live un-exported inside `InvoiceDetailPage.tsx` | copied byte-identically into `pages/v2/invoices/invoiceDerivations.ts` | the brief forbids editing a legacy page, even to add an `export`. `buildLedgerEvents` and `deriveInvoiceMoney` ARE exported and are imported, not copied - the money arithmetic has exactly one implementation. **Escalated: these five belong in `lib/`.** |

## Observed but not fixed

| What | Where | Why it is out of scope |
|---|---|---|
| The behaviour map is stale. It is dated 2026-07-29 and describes a Notes tab, a "Payment Summary waterfall" card, a `window.confirm` delete and a `canCopyLink = !!public_token` gate - none of which exist. The live page instead has an IconRail, an `InvoiceReceiptCard`, scopes, service fees, PDF preview/download, a `DeleteInvoiceDialog`, tags, and a payment-link mint on copy. The list page has since grown tags, bulk send/resend and the "To Be Invoiced" modal. | `md_files/specs/ui-redesign/invoices-behavior-map.md` vs the three pages | the code won, per the brief. Updating the map is a documentation task |
| `/invoices/:id/edit` does not exist in `App.tsx`. The overflow "Edit" item navigates there and falls through to the catch-all, bouncing the user to `/`. | `InvoiceDetailPage.tsx` overflow menu (map OQ-2) | reproduced deliberately; hiding or repointing it is a behaviour change |
| A technician holding the per-user `create Invoice` capability sees "New Invoice" on the list (CASL says yes) but `/invoices/new` is role-gated to ADMIN+DISPATCHER, so the click renders `NotAuthorizedPage`, and the controller 403s even past the route. | `InvoicesPage.tsx` header action (map OQ-3) | reproduced; the fix is to gate the button on role, which changes who sees what |
| The standalone form's shared `LineItemsEditor` collects `discount_type`, `discount_value` and `unit_cost`; `buildPayload` drops all three and the backend schema does not accept them. Values typed there are silently lost. | `StandaloneInvoiceFormPage.tsx` (map OQ-4) | reproduced; either the editor should hide those controls here or the API should take them - both are behaviour changes |
| `RecordPaymentDialog` seeds its `datetime-local` from `new Date().toISOString().slice(0,16)`, which is UTC, while the control is read as local time. A non-UTC user gets a shifted default. | `components/invoices/RecordPaymentDialog.tsx` (map OQ-6) | a legacy component this branch reuses unchanged |
| `stats.collected_this_month` is computed and returned by the list endpoint and rendered nowhere. | `invoice.controller.ts` list stats (map OQ-7) | adding a fifth tile is a product decision |
| The KPI "active" predicate ENUMERATES facet keys (`noOtherFacetsOrStandalone`). A facet added to `invoicesRegistry` without being added there leaves a tile lit over a list narrowed further than its count implies, and clicking it drops the new filter. | `InvoicesPage.tsx`, carried over verbatim | pre-existing fragility; making it registry-driven is a refactor of shared filter code |
