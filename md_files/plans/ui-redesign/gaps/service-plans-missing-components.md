# Service Plans - components with no kit equivalent

Module 15. Branch `refactor/ui-kit-15-service-plans`, built against
`md_files/specs/ui-redesign/service-plans-behavior-map.md`.

Scope: one route, `/service-plans` -> `/v2/service-plans`. The legacy page
(`pages/service-plans/ServicePlansPage.tsx`) and the legacy
`components/service-plans/RecurrenceBuilder.tsx` are untouched, and
`CustomerDetailPage` keeps importing the legacy `PlanBuilderDialog` unchanged.

## Gaps

| Old component | Used in | What it does | Kit's nearest thing | Why it is not enough | Rec |
|---|---|---|---|---|---|
| `ui/tabs` (`TabsContent`) + `patterns/TabStrip` | the page's Overview / Plans / History rail | controlled tab rail plus one panel per tab | nothing | The kit ships 24 UI primitives and none of them is a tab. Used the leads module's kit-built `pages/v2/leads/components/tabs` (`TabStrip` + `TabPanel`) rather than adding a fifteenth copy of the same hand-wiring. | BUILD |
| `patterns/FormField` | builder dialog: Plan name, Start date, Sold by | label + generated id + control association, works with plain state | `ui-kit/components/form/formField` | The kit's `FormField` is a react-hook-form `Controller`, and `FormLabel`/`FormControl` call `useFormField()`, which throws outside a `<Form>` context. This module has no RHF and no client-side zod at all (ten `useState` hooks and one `canSubmit` boolean). Used `ui-kit/components/ui/label` + an explicit `htmlFor`/`id` pair per field. | BUILD (an RHF-free label/field wrapper) |
| radio / radio-group | recurrence builder, `Ends: Never / On / After` | one exclusive choice out of three | nothing (`ui/switch`, `ui/checkbox`, `ui/select` only) | No radio primitive at all, and the design system's raw-tag ratchet sits at its floor for `<input>` and `<label>`, so three new native radios would have pushed a green ratchet red. Reshaped as a `role="radiogroup"` of kit Buttons carrying `role="radio"` + `aria-checked`, with all three accessible names byte-identical. | BUILD |
| `crm/CustomerPickerWithCreate` | builder dialog, Customer field | searchable customer popover with inline create, duplicate-409 dialog, and a non-passive `wheel` listener that works around Radix Dialog's scroll lock | `ui/command` + `ui/popover` | Reused unchanged. The wheel workaround is a shipped bug fix with a dedicated Playwright spec (`e2e/specs/service-plan-customer-picker-scroll.spec.ts`), and the component belongs to the Customers module's migration, not this one. | KEEP |
| `crm/PickOrAccreteLocation` | builder dialog, Service location field | existing-location Select plus an `+ Add new location` sub-form; owns the `ADD_NEW_LOCATION` sentinel | `ui/select` + `ui/input` | Reused unchanged. `ADD_NEW_LOCATION` is load-bearing in `resolveServiceLocationId`, and the component (with its `AddressAutocomplete`) is shared with Customers and Leads. | KEEP |
| `inventory/lo/TrackedItemSearch` | builder dialog + detail sheet, Default materials | debounced tracked-item search against the price book | `ui/command` | Reused unchanged. Shared with the Inventory module's logistic-order line picker; forking it here would fork that too. | KEEP |
| `crm/address-autocomplete` | transitively, via `PickOrAccreteLocation` | Places autocomplete | nothing | Already recorded in `UI_KIT_MISSING_COMPONENTS.md` 1c. | KEEP |

## Replaced (the audit trail)

Every `@/components/...` import in the two legacy source files, plus the two
non-component imports that carry presentation.

### `pages/service-plans/ServicePlansPage.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `components/service-plans/RecurrenceBuilder` (`RecurrenceBuilder`) | `pages/v2/service-plans/components/recurrenceBuilder.tsx` | Presentation only. `recurrenceToPayload`, `DEFAULT_RECURRENCE`, `RecurrenceValue` and `EndMode` are still IMPORTED from the legacy module - that reducer is pure, unit-tested and shared with the legacy page. Every `aria-label` is byte-identical. |
| `components/ui/button` | `ui-kit/components/ui/button` | `variant="solid" tone="business"` -> the kit's default; `outline` -> `outline`; `ghost` -> `ghost`. `size="sm"` kept; icon-only buttons use `size="icon-sm"`. |
| `components/ui/card` | `ui-kit/components/ui/card` | The legacy `padding` prop (`sm`/`none`/`lg`) has no kit counterpart; the kit `Card` is padding-free and its children own their inset. `padding="lg"` centred empty cards became `data/emptyState` instead. |
| `components/data/status-badge` (`StatusBadge`) | `pages/v2/leads/components/statusChip` (`StatusChip`) | Same `design-system/status-registry` lookup, kit `Badge` painting. `servicePlan` has no lifecycle override, so it falls back to intent: Draft neutral, Active green, Expired amber, Cancelled red - the same four meanings. Still fed `effective_status`, never the raw `status`. |
| `components/ui/input` | `ui-kit/components/ui/input` | text, `date`, `datetime-local`, `number` all carried over with the same `min`/`step`. |
| `components/patterns/FormField` | `ui-kit/components/ui/label` + explicit `htmlFor`/`id` | See the gap row. The three sites that deliberately did NOT use `FormField` (Customer, Service location, Recurrence, Line items, Default materials) are still bare labels, for the same reasons. |
| `components/ui/tabs` (`TabsContent`) | `pages/v2/leads/components/tabs` (`TabPanel`) | See the gap row. |
| `components/patterns/TabStrip` | `pages/v2/leads/components/tabs` (`TabStrip`) | Controlled the same way; initial tab is still `plans`, not `overview`. |
| `components/data/table` (`Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell`) | `ui-kit/components/ui/table` | Plain primitives, NOT the kit's `DataTable`: this list has no sorting, search, column menu or pagination today and `DataTable` brings a paging footer with it. `TableCell weight="medium"` -> `className="font-medium"`; `tone="highlight"` has no kit counterpart, so the emphasis moved onto the value (`<span className="text-destructive font-medium">`) rather than onto the cell. |
| `components/ui/dialog` | `ui-kit/components/ui/dialog` | Gained `DialogBody` as the scroll region; `max-w-2xl max-h-[90vh]` carried over as layout classes. Still no `DialogDescription`. |
| `components/ui/sheet` | `ui-kit/components/ui/sheet` | Gained `SheetBody`. Width is now the kit's own `min(26.25rem,100vw)` instead of `w-full sm:max-w-lg`. Still no `SheetDescription`, still the default (right) side. |
| `components/ui/select` | `ui-kit/components/ui/select` | Three instances: Sold by, Assign technician, and the interval unit inside the recurrence builder. |
| `components/crm/CustomerPickerWithCreate` | itself (reused) | gap row above |
| `components/crm/PickOrAccreteLocation` | itself (reused) | gap row above |
| `components/inventory/lo/TrackedItemSearch` | itself (reused) | gap row above |
| `components/ui/use-toast` (`useToast`) | `ui-kit/components/ui/sonner` (`toast`) | `toast({variant:'destructive'})` -> `toast.error(title, { description })`. Both call sites (plan create, save materials) keep their exact copy. |
| `lucide-react` (`Loader2`) | the kit Button's `isLoading` prop | The kit Button renders its own spinner and disables itself, so the inline `<Loader2 className="animate-spin" />` is gone from both submit buttons. |

### `components/service-plans/RecurrenceBuilder.tsx`

| Old component | Replaced by | Notes |
|---|---|---|
| `components/ui/input` | `ui-kit/components/ui/input` | `Interval count`, `End date`, `Occurrence count` - same aria-labels, same `disabled`-not-hidden rule. |
| `components/ui/select` | `ui-kit/components/ui/select` | `Interval unit`, same four options and labels. |
| raw `<button>` weekday chips | `ui-kit/components/ui/button` (`size="icon-sm"`) | Still `aria-pressed` toggles with full-day-name `aria-label`s. Square rather than round: `rounded-full` on a kit Button would be an appearance decision at a call site, which is exactly what `layering-guard` forbids. |
| raw `<input type="radio">` end-mode group | `role="radiogroup"` of kit Buttons | See the gap row. |

### Non-component imports carried over unchanged

`@/lib/axios`, `@tanstack/react-query`, `@/lib/api/service-plans` (all nine
hooks plus `planLineItemsTotal` and `describeRecurrence`), `@/lib/api/users`
(`useUsers`), `@/lib/utils` (`extractApiError`, `formatCurrency`), and
`resolveServiceLocationId` - imported from the legacy page module rather than
copied, because the non-idempotent location POST it guards is one invariant with
one test pinning it.

## Deliberate presentation changes

Not behaviour changes, but visible ones, listed so a reviewer does not have to
find them in the diff.

| What | Was | Now | Why |
|---|---|---|---|
| Plans tab, first fetch | `<div>Loading…</div>` | centred kit `Spinner` | Same one loading surface; the kit has a spinner and a bare word is not a loading state. |
| Overview tiles, first fetch | five tiles reading `0` | kit `StatCard` skeletons | `StatCard` ships a `loading` state. Rendering real zeros over an in-flight fetch says something false. |
| Empty states | `<Card padding="lg" className="text-center …">` | `data/emptyState` | Same two strings, verbatim: `No service plans yet.` and `No completed visits yet.` |
| `Delete` (DRAFT plan) | `variant="outline"` | `variant="destructive"` | A one-click hard delete with no confirmation step. The kit says this with a variant, never a colour class at the call site. Same action, same guard, same payload. `Cancel plan` stays `outline` - it is a lifecycle transition, not a deletion. |
| line-item remove button | `✕` text, no accessible name | `<X />` icon + `aria-label="Remove line item N"` | An icon-only control with no name is unusable by a screen reader. No test reads it. |
| `datetime-local` visit input | no label at all | `sr-only` "Visit date and time" label | Same reason. Nothing visible changed. |
| KPI tiles | `Card` grid, hand-built | `data/statCard` `StatCardGroup` | No `tone` and no `onClick`: the tiles are not filters here, so they render as divs, exactly as inert as they were. |

## Observed but not fixed

| What | Where | Why it is out of scope |
|---|---|---|
| Activate / Renew / Cancel / Delete / Schedule-visit pass no `onError`, and neither do their hooks. A 400/403/500 produces no toast, no message and no visible change. | `PlanDetailSheet` lifecycle row + schedule block; `lib/api/service-plans.ts` | Adding error handling changes what the user sees on failure. That is a behaviour change and needs sign-off, not a restyle. Reproduced exactly. |
| No confirmation dialog on `Delete` (DRAFT) or `Cancel plan` (ACTIVE) - both fire on one click. | `PlanDetailSheet` | A kit `confirmDialog` here would be an addition, not a port. |
| The detail sheet's whole body is behind `{plan && …}`, so it opens completely empty while the detail query runs, and stays empty forever if it errors. | `PlanDetailSheet` | Same reason: no skeleton and no error branch exist today. |
| `useServicePlans()` failing leaves `plans = []`, so an error renders the `No service plans yet.` empty state with no retry affordance. | `ServicePlansPage` | This is also what a 403 looks like (see the next row). Fixing it means designing an error state the module has never had. |
| The `/service-plans` route carries no role sub-gate, but the backend grants `read ServicePlan` to DISPATCHER only (ADMIN via `manage all`). A SALES or TECHNICIAN user in an entitled org who types the URL renders the page and sees the empty state instead of a permission message. | `App.tsx:183-185`, mirrored in `routes/service-plans.routes.tsx`; `backend/src/lib/permissions/defaultGrants.ts:211-214` | Guards are copied, not designed. Narrowing the role list here would change who can reach a page. Flagged for a decision. |
| `HistoryTab`'s row key is `${plan.id}-${visit.scheduled_date}`, which collides when one plan completes two visits on the same scheduled date. | `ServicePlansPage` HistoryTab | A key change is a rendering-correctness fix, not a restyle. Reproduced as-is. |
| Entering the materials editor hard-codes `item_sku: null` on every seeded row, so saved materials show no SKU while freshly picked ones do. | `PlanDetailSheet.startEditingMaterials` | Cosmetic inconsistency in the legacy data mapping, pinned by no test either way. |
| `Assign technician` lists EVERY org user, not just technicians, and offers no clear-selection option. Selecting a technician is also not reset after a successful schedule - only the date is. | `PlanDetailSheet` schedule block | `useUsers()` has no `eligibleFor` filter; adding one touches shared API code another module owns. |
| The Service location field shows a DOUBLE label: the dialog renders one and `PickOrAccreteLocation` renders its own through `FormField` internally. | builder dialog | Fixing it means editing a component the Customers module owns. Pre-existing, carried over. |
| `pages/service-plans/service-plans-store.ts` and `service-plans-data.ts` are DEAD CODE. Verified by a repo-wide grep across `src/` and `e2e/`: zero importers. They carry a contradictory data model (numeric ids, `SP00001` numbers, six invented statuses, seeded generators, KPI/filter/trend helpers) that reaches no screen. | `pages/service-plans/` | Deleting a legacy file is out of scope for this branch. Neither file was ported and neither was consulted. They should go at cutover. |
| `POST /api/service-plans/:id/skip-visit` exists on the backend with no frontend hook and no caller anywhere in the repo. | `backend/src/routes/service-plan.routes.ts` | Unreachable from any UI. Not added - the migration reproduces the surface, it does not extend it. |
| `CADENCE_LABEL` is exported from `lib/api/service-plans.ts` and referenced by nothing in this module (the page uses `describeRecurrence`). | `lib/api/service-plans.ts` | Shared lib file; possibly used by another module. Not touched. |
