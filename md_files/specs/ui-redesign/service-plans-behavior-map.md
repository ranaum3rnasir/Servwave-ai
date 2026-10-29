# Service Plans module - behaviour map

Phase 1 mapping artefact for the UI-kit migration
(`md_files/plans/ui-redesign/UI_KIT_MIGRATION_PLAN.md`).
Documentation only. Every statement below was read from the files cited; anything
not verified is listed under "Open questions".

Mapped on 2026-08-04 against `refactor/ui-kit-00b-shell` @ 8c04f7c7.

**Note on quoted UI copy:** this codebase's user-facing strings contain real em
dash (U+2014), en dash (U+2013) and right-single-quote (U+2019) characters. This
document is written under the plain-hyphen rule, so wherever a source string
contains one of those characters it is written here as `<U+2014>` / `<U+2013>` /
`<U+2019>`. Reproduce the literal character in the v2 build, not the placeholder.

---

## 1. Route and guards

| Item | Value | Source |
|---|---|---|
| Path | `/service-plans` (single route, no children, no params, no query params) | `frontend/src/App.tsx:184` |
| Element | `<ServicePlansPage />`, `React.lazy` | `App.tsx:34` |
| Outer guard | `<ProtectedRoute allowedRoles={['ADMIN','SALES','DISPATCHER','TECHNICIAN']} />` wrapping `<AppLayout />` | `App.tsx:149-150` |
| Feature gate | `<RequireFeature feature="service_plans" />` wrapping only this route | `App.tsx:183-185` |
| Entitlement | `service_plans` -> `minPlan: 'PRO'` | `frontend/src/lib/entitlements/catalog.ts:12` |
| Role sub-gate | **none** - there is no nested `ProtectedRoute` with a narrower role list | `App.tsx:183-185` |
| Nav entry | `{ key: 'service-plans', label: 'Service Plans', icon: Repeat, href: '/service-plans', action: 'read', subject: 'ServicePlan', home: 'Page', feature: 'service_plans' }` | `frontend/src/components/layout/nav-registry.ts:91` |
| Sidebar visibility | CASL `ability.can('read','ServicePlan')` **and** the `feature` key | `nav-registry.ts:91` |
| Default layout | `service-plans` sits in `DEFAULT_LAYOUT_KEYS` between `invoices` and `automations`; it was added as `LAYOUT_ADDITIONS` version 2 | `nav-registry.ts:130-145` |

### What `RequireFeature` actually does

`frontend/src/components/RequireFeature.tsx`: if `useFeature('service_plans')` is
false it renders
`<Navigate to="/upgrade?feature=service_plans&required_plan=PRO" state={{from: location}} replace />`.
It does **not** redirect to `/`, and it does not render a partial page. There is
no in-page upgrade prompt inside the Service Plans module itself.

### The role hole (verified, and it matters for the rebuild)

Backend default grants (`backend/src/lib/permissions/defaultGrants.ts:211-214`)
give `read`/`create`/`update`/`delete` on `ServicePlan` to **DISPATCHER** only.
ADMIN passes through `manage all`. **SALES and TECHNICIAN have no `ServicePlan`
grant at all.**

Consequence, verified against the route table: the `/service-plans` route carries
no role sub-gate, so a SALES or TECHNICIAN user in an entitled org who types the
URL (or follows a stale link) **renders the page**, the nav item merely being
hidden. `GET /api/service-plans` then 403s
(`backend/src/routes/service-plan.routes.ts` `canDo('read','ServicePlan')`), and
because the page has no error branch (section 7) they see the plain
`No service plans yet.` empty state, not a permission message. Preserve or fix -
it is a behaviour, and the v2 page will inherit it unless someone decides
otherwise.

### Backend route surface (the authority the UI must not exceed)

`backend/src/routes/service-plan.routes.ts` -
`router.use(authenticate, requireFeature('service_plans'), attachAbility)` then:

| Method + path | Guard | Frontend hook |
|---|---|---|
| `GET /api/service-plans/scheduler-bucket` | `read ServicePlan` | `useSchedulerBucket` - **used by SchedulePage, not by this module** |
| `GET /api/service-plans` | `read ServicePlan` | `useServicePlans` |
| `POST /api/service-plans` | `create ServicePlan` + `validate(createPlanSchema)` | `useCreateServicePlan` |
| `GET /api/service-plans/:id` | `read ServicePlan` | `useServicePlan` |
| `PATCH /api/service-plans/:id` | `update ServicePlan` + `validate(updatePlanSchema)` | `useUpdateServicePlan` |
| `DELETE /api/service-plans/:id` | `delete ServicePlan` | `useDeleteServicePlan` |
| `POST /api/service-plans/:id/activate` | `update ServicePlan` | `useActivateServicePlan` |
| `POST /api/service-plans/:id/renew` | `update ServicePlan` | `useRenewServicePlan` |
| `POST /api/service-plans/:id/cancel` | `update ServicePlan` | `useCancelServicePlan` |
| `POST /api/service-plans/:id/schedule-visit` | `update ServicePlan` + `validate(scheduleVisitSchema)` | `useScheduleVisit` |
| `POST /api/service-plans/:id/skip-visit` | `update ServicePlan` | **no frontend hook exists** |

`skip-visit` is unreachable from any UI in this repo (verified: no `skipVisit` in
`frontend/src/lib/api/service-plans.ts` and no other caller). Do not add one.

### Second entry point (not a route)

`frontend/src/pages/CustomerDetailPage.tsx:30` imports `PlanBuilderDialog` from
`@/pages/service-plans/ServicePlansPage` and renders it at line 1668-1675 with
`key={id}`, `presetCustomerId={id}`, `presetCustomerLabel={displayName}`. It is
opened from a "Service Plan" `DropdownMenuItem` in the customer's create menu
(line 968-973). Both the menu item and the dialog are gated on
`canCreateServicePlan = useModuleAccess('service_plans','create','ServicePlan')`
(line 653) - entitlement AND CASL, per `lib/entitlements/useModuleAccess.ts`.

**Therefore `PlanBuilderDialog` is a cross-module export.** Any v2 rebuild that
moves or renames it breaks CustomerDetailPage. `PlanDetailSheet` and
`resolveServiceLocationId` are also exported, but only tests import them.

---

## 2. Page shell and tab switching

File: `frontend/src/pages/service-plans/ServicePlansPage.tsx` (665 lines, holds
the page, both overlays and all three tab bodies - one file, no `views/` dir).

### Component tree

```
<div className="p-6 space-y-6">
  header row (flex items-center justify-between)
    <h1>Service Plans</h1>
    <Button variant="solid" tone="business" onClick={setBuilderOpen(true)}>  "New Plan"
  <TabStrip tabs=[overview|plans|history] active={activeTab} onChange={setActiveTab}>
    <TabsContent overview className="mt-4"> <OverviewTab plans />
    <TabsContent plans    className="mt-4"> isLoading ? "Loading<U+2026>" : <PlansTab plans onOpen={setDetailId} />
    <TabsContent history  className="mt-4"> <HistoryTab plans />
  <PlanBuilderDialog open={builderOpen} onOpenChange={setBuilderOpen} />   (Radix Dialog)
  <PlanDetailSheet id={detailId} onClose={() => setDetailId(null)} />      (Radix Sheet, side default)
```

### Where view state lives

- **Active tab: `useState('plans')` local to `ServicePlansPage` (line 635).**
  Initial tab is `plans`, **not** `overview`. Not in the URL, not in a store, not
  in `localStorage`. Resets on every remount/reload. There is no `?tab=` param.
- `builderOpen: boolean` and `detailId: string | null` are both local `useState`
  in the page (lines 631-632). The detail sheet's open state is derived
  (`open = !!id` in `PlanDetailSheet`).
- `TabStrip` (`components/patterns/TabStrip.tsx`) is **controlled-only** - it
  renders `<Tabs value={active} onValueChange={onChange}>` plus a generated
  `<TabsList>` of `<TabsTrigger>`s, and passes `children` (the `TabsContent`
  panels) through unchanged. No `forceMount`, so Radix unmounts inactive panels.
- All three tabs read the **same** `plans` array from one `useServicePlans()`
  query, so tab switching never refetches.

### There is no Zustand store in the live module

`frontend/src/pages/service-plans/service-plans-store.ts` and
`service-plans-data.ts` **are dead code.** Verified by a repo-wide grep for
`service-plans-store`, `service-plans-data` and `useServicePlansStore`: the only
hits are the store importing the data file and its own `export const`. Nothing
imports either file - not `ServicePlansPage.tsx`, not any test, not any other
page.

They are a leftover mock-first prototype with a completely different data model:
number ids, `SP00001` plan numbers, statuses `Pending approval | Active |
Expires soon | Expired | Pending billing | Cancelled`, a `PlanVisit` list,
seeded generators (`buildPlans`/`buildVisits` off `mulberry32`), pure lifecycle
helpers (`applyApprove`/`applyMarkBilled`/`applyRenew`/`applyCancel`) and KPI /
filter / trend functions (`computePlanKpis`, `filterPlans`, `filterVisits`,
`weeklyVisitTrend`, `completedByTech`). **None of that shape reaches the screen.**
The live module is 100% TanStack Query against the real API.

**Migration instruction: do not port these two files, and do not treat their
statuses, KPIs or filters as the module's behaviour.** They are the single
biggest trap in this map - the task brief's own hint that "a store is involved"
is, on the code, false.

### Permission gating inside the page

**None.** `ServicePlansPage.tsx` contains no `useAppAbility`, no
`useModuleAccess`, no role check, no `useFeature`. Every control (New Plan,
Activate, Renew, Cancel, Delete, Schedule visit, Edit materials) renders for
anyone who reaches the route. Enforcement is entirely server-side, and a denial
is silent (section 7). The only CASL gate anywhere near this module is on
`CustomerDetailPage`, which is a different module's page.

---

## 3. Data layer

### It is TanStack Query, end to end

`frontend/src/lib/api/service-plans.ts` is the single API module. Raw axios
(`@/lib/axios`) wrapped in `useQuery` / `useMutation`. QueryClient defaults
(`App.tsx:92-100`): `retry: 1`, `staleTime: 5 * 60 * 1000`,
`refetchOnWindowFocus: false`. No hook in this file overrides `staleTime`.

Query keys (`service-plans.ts:123-127`):

```ts
export const servicePlanKeys = {
  all:    ['service-plans'],
  detail: (id) => ['service-plans', id],
  bucket: ['service-plans', 'scheduler-bucket'],
};
```

Note `bucket` is a **child of `all`**, so `invalidateQueries({queryKey: all})`
(prefix match) also invalidates the scheduler bucket.

### Reads

| Hook | Endpoint | Response path | Enabled | Used by |
|---|---|---|---|---|
| `useServicePlans()` | `GET /api/service-plans` | `r.data.servicePlans` | always | `ServicePlansPage` (all 3 tabs), `pages/reports/ServicePlansReport.tsx` |
| `useServicePlan(id)` | `GET /api/service-plans/:id` | `r.data.servicePlan` | `!!id` | `PlanDetailSheet` |
| `useSchedulerBucket(enabled)` | `GET /api/service-plans/scheduler-bucket` | `r.data.plans` | prop | `SchedulePage` only |

### Writes and exactly what each invalidates

| Hook | Method + endpoint | Invalidates |
|---|---|---|
| `useCreateServicePlan()` | `POST /api/service-plans` -> `r.data.servicePlan` | `['service-plans']` |
| `useUpdateServicePlan()` | `PATCH /api/service-plans/:id` -> `r.data.servicePlan` | `['service-plans']` + `['service-plans', id]` |
| `useDeleteServicePlan()` | `DELETE /api/service-plans/:id` | `['service-plans']` |
| `useActivateServicePlan()` | `POST /api/service-plans/:id/activate` | `['service-plans']` + `['service-plans', id]` + **`['invoices']`** |
| `useRenewServicePlan()` | `POST /api/service-plans/:id/renew` | same three as activate |
| `useCancelServicePlan()` | `POST /api/service-plans/:id/cancel` | same three as activate |
| `useScheduleVisit()` | `POST /api/service-plans/:id/schedule-visit` | `['service-plans']` + `['service-plans', id]` + `['service-plans','scheduler-bucket']` + **`['schedule-jobs']`** |

The three lifecycle hooks share one factory, `useLifecycleAction(action)`
(`service-plans.ts:185-195`). The `['invoices']` invalidation is because
activate/renew mint a `kind=PLAN` invoice server-side.

**No mutation in this module is optimistic.** Every one awaits the server.

### Additional API calls made from inside the module's dialogs

| Call | Where | Shape |
|---|---|---|
| `useQuery(['customer', customerId, 'plan-locations'])` -> `GET /api/customers/:id` | `PlanBuilderDialog:197-201` | `enabled: open && !!customerId`; reads `r.data.customer ?? r.data`; supplies `service_locations` |
| `api.post('/api/customers/:id/locations')` | `resolveServiceLocationId` (module-scope, exported) | direct axios, **not** a mutation hook; no automatic invalidation - the caller manually invalidates `['customer', customerId, 'plan-locations']` |
| `useUsers()` -> `GET /api/users` | `PlanBuilderDialog` (Sold by) and `PlanDetailSheet` (Assign technician) | query key `['users','all']` (`lib/api/users.ts:71-76`) |
| `useQuery(['customer-picker-search', debouncedQ])` -> `GET /api/customers?search&limit=15` | `CustomerPickerWithCreate` | `enabled: open && mode === 'search'`, `keepPreviousData`, `staleTime: 30_000` |
| `api.post('/api/customers')` (and `?override=true`) | `CustomerPickerWithCreate` inline create | invalidates `['customers']` and `['customer-picker-search']` |
| `listPriceBookItems(q, {trackedOnly:true})` -> `GET /api/price-book/items?is_active=true&limit=100&search=&track_inventory=true` | `TrackedItemSearch` | plain promise, no react-query, 300 ms debounce, reads `r.data.data ?? []` |

### Display helpers that must be reused verbatim, not reimplemented

`lib/api/service-plans.ts`:

- `describeRecurrence(p)` - "Every 2 weeks on Mon, Thu" / "Weekly" / "Monthly" /
  "Annually". Uses `interval_unit`/`interval_count`/`byweekday` when present,
  otherwise falls back to `LEGACY_RECURRENCE[visit_cadence]`. `byweekday` is only
  honoured for `WEEK`. Weekday index is normalised `((d % 7) + 7) % 7`.
- `planLineItemsTotal(items)` - `sum(quantity * Number(unit_price))`.
- `CADENCE_LABEL` - exported but **not referenced by this page** (grep: the page
  uses `describeRecurrence`).

Page-local helpers (`ServicePlansPage.tsx:41-45`):

- `money = formatCurrency` from `@/lib/utils` - org-configured currency, never a
  hardcoded `$`. There is an explicit comment saying the hardcoded `$` this
  replaced was a real defect.
- `date(s)` = `new Date(s).toLocaleDateString()` or `<U+2014>` when null/undefined.
  **Local timezone, locale-default format.**
- `customerName(p)` = `company_name || "first last" || 'Customer'`, else `<U+2014>`.
- `property(p)` = `[city, state].filter(Boolean).join(', ')`, else `<U+2014>`.

Status labels/colours come from `StatusBadge domain="servicePlan"`, resolved
through `design-system/status-registry.ts:236-241`:
`DRAFT -> Draft/neutral`, `ACTIVE -> Active/success`, `EXPIRED -> Expired/warning`,
`CANCELLED -> Cancelled/danger`. The page always passes `effective_status`
(server-derived), never the raw `status`, to the badge.

---

## 4. Per-tab maps

### 4.1 OverviewTab (`ServicePlansPage.tsx:49-76`)

A 5-tile KPI grid, `grid grid-cols-2 md:grid-cols-5 gap-4`, each tile a
`<Card padding="sm">` with a `text-xs text-text-secondary` label and a
`text-2xl font-semibold text-text-primary mt-1` value.

Tiles, in order, and the exact arithmetic (`useMemo` over `plans`):

| Label | Value |
|---|---|
| `Total plans` | `plans.length` |
| `Active` | count of `p.effective_status === 'ACTIVE'` |
| `Drafts` | count of `p.status === 'DRAFT'` (raw status, **not** effective) |
| `Contract revenue (active)` | `money(sum of Number(p.contract_price) where effective_status === 'ACTIVE')` |
| `Visits remaining` | `sum(p.visits_remaining ?? 0)` across **all** plans regardless of status |

Note the deliberate asymmetry: Active uses `effective_status`, Drafts uses
`status`. Reproduce it.

Interactive elements: **none.** No click handler anywhere in this tab.
Empty state: none - with zero plans it renders five tiles reading `0`, `0`, `0`,
the formatted zero currency, and `0`.
Loading state: none - the `isLoading` branch is only wired to the Plans tab, so
Overview renders zeros during the first fetch.
Selectors: none.

### 4.2 PlansTab (`ServicePlansPage.tsx:80-107`) - the default tab

`<Card padding="none" className="overflow-hidden">` wrapping a
`components/data/table` `<Table>`. Not TanStack Table, not a shared DataTable.

Columns, fixed - no sorting, no filtering, no search, no pagination, no column
menu, no row selection, no bulk actions:

`Plan | Customer | Property | Cadence | Next due | Remaining | Status`

| Cell | Content |
|---|---|
| Plan | `p.service_plan_number`, `<TableCell weight="medium">` |
| Customer | `customerName(p)` |
| Property | `property(p)` |
| Cadence | `describeRecurrence(p)` |
| Next due | `date(p.next_due)`, `<TableCell tone={p.emphasized ? 'highlight' : 'default'}>` |
| Remaining | `p.visits_remaining ?? 'Ongoing'` (note: `??`, so `0` renders as `0`, not "Ongoing") |
| Status | `<StatusBadge domain="servicePlan" status={p.effective_status} />` |

Row interaction: the whole `<TableRow className="cursor-pointer">` has
`onClick={() => onOpen(p.id)}` -> sets `detailId` -> opens `PlanDetailSheet`.
No keyboard affordance, no `role="button"`, no `tabIndex`.

`p.emphasized` is a server-derived boolean (see `ServicePlan` type,
`service-plans.ts:78-83`, alongside `due_soon` and `overdue`); the page never
computes it and never reads `due_soon` / `overdue` directly on this tab.

Empty state: `<Card padding="lg" className="text-center text-text-secondary">`
reading exactly `No service plans yet.` (early return before the table).
Loading state: the page renders `<div className="text-text-secondary">Loading<U+2026></div>`
instead of the tab body while `useServicePlans().isLoading`.
Error state: none - see section 7.
Selectors: none.

### 4.3 HistoryTab (`ServicePlansPage.tsx:111-136`)

Flat-maps every plan's `visits` array, keeps only `v.status === 'COMPLETED'`,
and renders one row per completed visit. Row key is
`` `${p.id}-${v.scheduled_date}` `` (a plan with two completed visits on the same
scheduled date would collide - flagged, not fixed).

Columns: `Plan | Customer | Completed`, where Completed is
`date(v.completed_at ?? v.scheduled_date)`.

No sorting (rows come out in plan order, then visit order as the server returned
them), no filtering, no click handler, no pagination.

Empty state: `<Card padding="lg" ...>` reading exactly `No completed visits yet.`
Loading/error: none.
Selectors: none.

**Whether `GET /api/service-plans` actually includes `visits` on the list rows is
not verified from the frontend** - `visits?: PlanVisit[]` is optional on the type
and `(p.visits ?? [])` guards it. If the list endpoint omits visits, this tab is
permanently empty. Listed under Open questions.

---

## 5. Overlays

### 5.1 PlanBuilderDialog (`ServicePlansPage.tsx:163-421`)

Radix `Dialog`; `DialogContent className="max-w-2xl max-h-[90vh] overflow-y-auto"`;
`DialogHeader` + `DialogTitle` reading `New service plan`. **No
`DialogDescription`.**

Props: `{ open, onOpenChange, presetCustomerId?, presetCustomerLabel? }`.

Close behaviour: `onOpenChange={(o) => { if (!o) reset(); onOpenChange(o); }}` -
closing always resets the form. `reset()` restores `presetCustomerId` /
`presetCustomerLabel` rather than clearing them.

#### There is no zod schema and no react-hook-form on the client

**Verified: the builder uses ten `useState` hooks and a hand-written boolean.**
No RHF, no zodResolver, no field-level error text anywhere. The only feedback for
invalid input is the disabled submit button - there are no inline validation
messages.

#### Fields

| Field | Control | Notes |
|---|---|---|
| Customer | `<CustomerPickerWithCreate value valueLabel onChange>` **or**, when `presetCustomerId` is set, a read-only `<div>` showing `customerLabel \|\| 'Customer'` | Changing the customer clears the location value (`setLocValue(emptyLoc())`). Deliberately not wrapped in `FormField` - see the in-file comment at line 281-283 |
| Service location | `<PickOrAccreteLocation locations value onChange required showPicker />` when a customer is chosen, otherwise the text `Select a customer first.` | Renders its own `FormField` label internally, so a **double label** is visible here; the in-file comment at 298-302 says this is known, pre-existing and out of scope |
| Plan name | `<FormField label="Plan name" htmlFor="plan-name">` + `<Input placeholder="e.g. Annual HVAC Maintenance">` | |
| Start date | `<FormField label="Start date" htmlFor="plan-start-date">` + `<Input type="date">` | |
| Sold by | `<FormField label="Sold by">` using the **render-prop** form so the generated id lands on the Radix `SelectTrigger`; options from `useUsers()`, `placeholder="(optional)"` | no clear-selection option once a user is picked |
| Recurrence | `<RecurrenceBuilder value onChange />` under a raw `<label>Recurrence</label>` | see 5.3 |
| Line items | repeating rows, `grid-cols-[1fr_80px_120px_40px]`: Description `<Input placeholder="Description">`, quantity `<Input type="number" min={1}>`, unit price `<Input type="number" min={0} step="0.01">`, remove `<Button size="sm" variant="ghost" disabled={items.length === 1}>` labelled `<U+2715>` | header row carries an `Add item` `<Button size="sm" variant="outline">`; footer shows `Contract price: {money(total)}` right-aligned |
| Default materials | `TrackedItemSearch` plus, for each picked item, a `grid-cols-[1fr_80px_40px]` row: name + `<code>` sku, qty `<Input type="number" min={0.01} step={0.01} aria-label={`Quantity for ${name}`} className="text-right">`, and a `<Button variant="ghost" aria-label={`Remove ${name}`}>` `<U+2715>` | starts EMPTY; hint text `Tracked parts auto-added to each visit<U+2019>s logistic order. Optional.`; re-picking an item already in the list is a no-op (dedupe on `item_id`) |

#### Location auto-selection effect (a real landmine)

```ts
useEffect(() => {
  const l = locations[0];
  if (locations.length === 1 && l && !locValue.locationId) { setLocValue({...}); }
}, [locations, locValue.locationId]);
```

The in-file comment is explicit: **do not drop `!locValue.locationId`** - without
it, jsdom hits an effect loop that hangs vitest. Carry the guard verbatim.

#### The submit gate (`canSubmit`, line 232-235)

```ts
!!customerId
  && locationChosen
  && name && startDate
  && total > 0
  && items.every((i) => i.name)
  && materials.every((m) => m.qty > 0)
  && (recurrence.end_mode !== 'on' || !!recurrence.end_date)
  && !submitting
```

where `locationChosen` (line 224-228) is
`(locationId set and !== ADD_NEW_LOCATION)` OR
(`ADD_NEW_LOCATION` AND `address_line1` non-blank AND `city` non-blank AND
`state.trim().length === 2` AND `zip.trim().length >= 5`).

So: `sold_by` is optional, description-less line items block submit, a zero total
blocks submit, `Ends -> on a date` with no date blocks submit, and any material
with `qty <= 0` blocks submit (asserted by
`__tests__/service-plan-materials.test.tsx`).

#### Submit path (`submit()`, line 237-273)

1. `setSubmitting(true)`.
2. `resolveServiceLocationId(customerId, locValue, locations.length === 0)`:
   - existing id -> passthrough, no POST;
   - `ADD_NEW_LOCATION` -> `POST /api/customers/:customerId/locations` with
     `{address_line1, address_line2?, city, state, zip, is_primary: hadZeroLocations}`
     (all trimmed; `address_line2` omitted entirely when blank), returns
     `data.location.id`.
3. If a new address was authored, **immediately** `setLocValue({locationId: newId, ...})`
   and `qc.invalidateQueries(['customer', customerId, 'plan-locations'])`. Both
   before the plan create can fail. The comment and
   `__tests__/service-plan-builder-location.test.tsx` spell out why: the location
   POST is not idempotent, so a retry after a failed plan create would otherwise
   orphan a duplicate address and re-send `is_primary: true`, demoting the one it
   just made.
4. `create.mutateAsync({ customer_id, service_location_id, name,
   start_date: new Date(startDate).toISOString(), ...recurrenceToPayload(recurrence),
   contract_price: total, line_items: items,
   material_lines: materials.map(m => ({item_id: m.item_id, qty: m.qty})),
   sold_by: soldBy || null })`.
   **No `visit_cadence` is sent** - the server derives a best-fit one.
   `material_lines` is always present, `[]` when empty (pinned by a test).
5. Success -> `reset()` + `onOpenChange(false)`. There is **no success toast** and
   **no navigation** - the dialog just closes and the invalidated list refetches.
6. Failure -> `toast({ title: 'Could not create plan', description: extractApiError(err, 'Please try again.'), variant: 'destructive' })`.
   The dialog stays open with its state intact so the user can retry.
7. `finally { setSubmitting(false) }`.

Submitting state: the Create button shows a spinning `<Loader2 className="mr-1 h-3.5 w-3.5 animate-spin" />`
before its label and is disabled via `canSubmit`. The Cancel button is **not**
disabled while submitting.

Footer: `<DialogFooter>` with `Cancel` (`variant="outline"`, calls
`onOpenChange(false)` - note this fires the reset through the `onOpenChange`
wrapper) and `Create draft` (`variant="solid" tone="business"`).

#### The zod schema that actually validates this (server-side)

`backend/src/controllers/service-plan.controller.ts:25-75`:

```ts
const lineItemSchema = z.object({
  name: z.string().min(1).max(200),
  quantity: z.number().int().positive(),
  unit_price: z.number().nonnegative(),
});

const materialLineSchema = z.object({
  item_id: z.string().uuid(),
  qty: z.number().positive(),
});

const planObject = z.object({
  customer_id: z.string().uuid(),
  service_location_id: z.string().uuid(),
  name: z.string().min(1).max(200),
  visit_cadence: z.enum(['WEEKLY','BIWEEKLY','MONTHLY','QUARTERLY','SEMIANNUAL','ANNUAL']).optional(),
  interval_unit: z.enum(['DAY','WEEK','MONTH','YEAR']).optional(),
  interval_count: z.number().int().positive().max(366).optional(),
  byweekday: z.array(z.number().int().min(0).max(6)).max(7).optional(),
  occurrence_count: z.number().int().positive().max(10000).nullable().optional(),
  start_date: z.coerce.date(),
  end_date: z.coerce.date().nullable().optional(),
  contract_price: z.number().nonnegative(),
  line_items: z.array(lineItemSchema).default([]),
  material_lines: z.array(materialLineSchema).default([]),
  sold_by: z.string().uuid().nullable().optional(),
  template_id: z.string().uuid().nullable().optional(),
});

export const createPlanSchema = planObject.strict()
  .refine((d) => d.visit_cadence != null || d.interval_unit != null, {
    message: 'A recurrence is required: provide visit_cadence or interval_unit',
    path: ['visit_cadence'],
  });

export const updatePlanSchema = planObject.partial().strip();

export const scheduleVisitSchema = z.object({
  scheduled_start: z.coerce.date(),
  scheduled_end: z.coerce.date().nullable().optional(),
  assigned_to: z.string().uuid().nullable().optional(),
}).strict();
```

`createPlanSchema` is `.strict()` - **an extra key in the POST body is a 400.**
That is a live constraint on the v2 builder: it may not add fields to the payload.

Client/server mismatches worth knowing: the client's `contract_price` is a float
sum, the client never sends `end_date` directly (the recurrence builder produces
it), and `contract_price: 0` passes the server (`nonnegative`) but is blocked
client-side by `total > 0`.

### 5.2 PlanDetailSheet (`ServicePlansPage.tsx:425-625`)

Radix `Sheet`; `SheetContent className="w-full sm:max-w-lg overflow-y-auto"`
(default side, i.e. right); `SheetHeader` + `SheetTitle` = plan number plus the
`StatusBadge`. **No `SheetDescription`.** Driven purely by the page's `detailId`;
`onOpenChange` fires `onClose()` on dismiss.

The **entire body is behind `{plan && (...)}`** - while `useServicePlan(id)` is
loading, the sheet is open and completely empty. There is no skeleton, no
spinner, and no error branch.

#### Read-only detail grid (`grid grid-cols-2 gap-y-2`)

`plan.name` sits above it as `font-medium text-text-primary text-base`. Rows:

| Label | Value |
|---|---|
| Customer | `customerName(plan)` |
| Property | `property(plan)` |
| Recurrence | `describeRecurrence(plan)` |
| Term | `date(start_date) <U+2013> {end_date ? date(end_date) : 'Ongoing'}` (separator is an en dash, U+2013) |
| Next due | `date(next_due)`, wrapped in `className={plan.emphasized ? 'text-danger-text font-medium' : ''}` |
| Visits remaining | `visits_remaining === null ? 'Ongoing (no end date)' : `${visits_remaining} of ${planned_visit_count}`` |
| Contract price | `money(contract_price)` |
| Renewals | `plan.renewals_count` |

#### Line items block

`Line items` heading, then one `flex justify-between text-text-secondary` row per
item: `{name} <U+00D7> {quantity}` on the left, `money(Number(unit_price) * quantity)`
on the right. **No empty state** - a plan with no line items renders just the
heading. Read-only, never editable in the UI.

#### Default materials block (the one editable region)

Two modes, driven by `editingMaterials: boolean` (local `useState`).

Read mode:
- Heading row: `Default materials` plus an `Edit` `<Button size="sm" variant="outline">`
  (rendered only when not editing).
- With lines: one `flex justify-between` row each, `{item_name}` plus, when
  `item_id === null`, an inline `<span className="ml-1 text-xs text-warning">(removed from catalog)</span>`;
  right side `<U+00D7> {Number(qty)}`.
- Without lines: `<p className="text-xs text-text-secondary">No default materials <U+2014> tracked parts auto-added to each visit<U+2019>s logistic order.</p>`.
  A test explicitly asserts this empty state renders *something*, so the `Edit`
  button stays discoverable.

Edit mode (`startEditingMaterials`, line 449-456):
- Seeds `materialsDraft` from `plan.material_lines`, **filtering out every line
  with `item_id === null`** (a dead catalog ref has no id left to resend) and
  setting `item_sku: null` on every seeded row (so seeded rows show no SKU, while
  freshly picked ones do - a real visual inconsistency, pinned by tests).
- Rows are the same `grid-cols-[1fr_80px_40px]` shape as the builder, with the
  same `aria-label={`Quantity for ${name}`}` and `aria-label={`Remove ${name}`}`.
- `TrackedItemSearch` adds rows, deduped on `item_id`, `qty: 1`.
- Footer: `Cancel` (`size="sm" variant="outline"`, just `setEditingMaterials(false)`,
  no API call) and `Save materials` (`variant="solid" tone="business"`,
  `disabled={updatePlan.isPending || materialsDraft.some(m => m.qty <= 0)}`,
  spinner while pending).
- `saveMaterials()` -> `updatePlan.mutateAsync({ id, material_lines: draft.map(m => ({item_id, qty})) })`
  -> `PATCH /api/service-plans/:id`; success closes the editor; failure toasts
  `Could not save materials` / `extractApiError(err,'Please try again.')` and
  **leaves the editor open**.

**Materials are editable at every plan status.** This is deliberate and is
enforced on the server too: `updatePlan` (controller line 316-331) rejects any
non-DRAFT edit whose keys fall outside `{name, sold_by, material_lines}` with
`400 Only name, sold_by, and materials can be edited on a <status> plan`. The
UI exposes no editor for `name` or `sold_by` at all, so `material_lines` is the
only PATCH this module ever sends.

#### Invoices block

Rendered only when `plan.invoices && plan.invoices.length > 0`. One row per
invoice: `{invoice_number} ({kind})` and `money(total_amount)`. **Not clickable -
there is no link to the invoice detail page.** The `public_token` and `status`
fields on `ServicePlanInvoiceRef` are unused here.

#### Lifecycle action row (`flex flex-wrap gap-2 pt-2 border-t border-border`)

Branches on the **raw** `plan.status`, not `effective_status`:

| Condition | Buttons |
|---|---|
| `status === 'DRAFT'` | `Activate` (`solid`/`business`, `disabled={activate.isPending}`, `activate.mutate(plan.id)`) and `Delete` (`outline`, `disabled={del.isPending}`, `del.mutate(plan.id, { onSuccess: onClose })`) |
| `status === 'ACTIVE'` **and** `plan.end_date` truthy | `Renew` (`solid`/`business`, `renew.mutate(plan.id)`) |
| `status === 'ACTIVE'` | `Cancel plan` (`outline`, `cancel.mutate(plan.id)`) |
| `EXPIRED` or `CANCELLED` | **nothing** - the bordered row renders empty |

`Renew` is hidden for an open-ended (`end_date === null`) active plan; the in-file
comment says renewal only means something for a fixed term.

**There is no confirmation dialog on Delete and none on Cancel plan.** Both fire
straight through on one click. Delete closes the sheet on success.

**None of the four lifecycle mutations passes an `onError`**, and none of the
hooks defines one either - a 400/403/500 on Activate, Renew, Cancel, Delete or
Schedule visit produces **no toast, no inline message and no visible change**.
Only the two `mutateAsync`+`try/catch` paths (plan create, save materials) surface
errors. This is the module's biggest error-handling gap; see section 7.

#### Schedule next visit block

Rendered when `status === 'ACTIVE'` **and** (`visits_remaining === null` OR
`visits_remaining > 0`). Contents:

- heading `Schedule next visit`
- `<Input type="datetime-local" value={visitDate}>` - local state, no label, no
  `min`, no `step`
- `<Select value={tech} onValueChange={setTech}>` with
  `placeholder="Assign technician (optional)"`, options from `useUsers()` (**every**
  user, not filtered to technicians, and no clear option)
- `<Button size="sm" disabled={!visitDate || schedule.isPending}>Schedule visit</Button>`
  -> `schedule.mutate({ id, scheduled_start: new Date(visitDate).toISOString(), assigned_to: tech || null }, { onSuccess: () => setVisitDate('') })`

`new Date(datetime-local).toISOString()` converts local wall-clock to UTC. The
technician selection is **not** cleared on success, only the date. No toast on
success; the sheet stays open and re-renders from the invalidated detail query.

### 5.3 RecurrenceBuilder (`frontend/src/components/service-plans/RecurrenceBuilder.tsx`, 209 lines)

The module's only file under `components/service-plans/`. Fully controlled; the
parent owns `RecurrenceValue`.

```ts
export type EndMode = 'never' | 'on' | 'after';
export interface RecurrenceValue {
  interval_unit: IntervalUnit;   // 'DAY'|'WEEK'|'MONTH'|'YEAR'
  interval_count: number;
  byweekday: number[];           // 0=Sun .. 6=Sat
  end_mode: EndMode;
  end_date: string;              // yyyy-mm-dd, only when end_mode === 'on'
  occurrence_count: number;      // only when end_mode === 'after'
}
export const DEFAULT_RECURRENCE = {
  interval_unit: 'MONTH', interval_count: 1, byweekday: [],
  end_mode: 'never', end_date: '', occurrence_count: 12,
};
```

`recurrenceToPayload(v)` (pure, unit-tested) returns
`{ interval_unit, interval_count: Math.max(1, count), byweekday: unit === 'WEEK' ? byweekday : [], end_date: end_mode === 'on' && end_date ? new Date(end_date).toISOString() : null, occurrence_count: end_mode === 'after' ? Math.max(1, count) : null }`.
So weekday selections are silently dropped for non-weekly units, and the two
terminators are mutually exclusive by construction.

Layout: `rounded-lg border border-border p-4`, inner
`grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-2`.

Left column:
- `Repeats every` label over `<Input type="number" min={1} className="w-20" aria-label="Interval count">`
  plus `<Select aria-label="Interval unit">` with options labelled
  `days | weeks | months | years` (values `DAY|WEEK|MONTH|YEAR`). The input clamps
  with `Math.max(1, Number(v) || 1)`.
- **Conditional render:** the `Repeat on` weekday chip row appears **only when
  `interval_unit === 'WEEK'`**. Seven raw `<button type="button" aria-pressed aria-label={fullDayName}>`
  chips, `h-8 w-8 rounded-full`, Sunday-first, short labels `S M T W T F S`,
  active style `bg-primary text-on-fill`, inactive `bg-background-light text-text-secondary hover:bg-border`.
  Toggling keeps `byweekday` sorted ascending.

Right column - `Ends` radio group, `name="recurrence-end-mode"`:
- `Never` (`aria-label="Never ends"`)
- `On` (`aria-label="Ends on a date"`) + `<Input type="date" aria-label="End date" disabled={end_mode !== 'on'}>`
- `After` (`aria-label="Ends after a number of occurrences"`) + `<Input type="number" min={1} className="w-16" aria-label="Occurrence count" disabled={end_mode !== 'after'}>` + the word `occurrences`

The two paired inputs are **disabled, not hidden**, when their radio is not
selected. The `aria-label`s above are the entire selector surface for this
component's tests - keep every one of them byte-exact.

### 5.4 Nested overlays reached from the builder

- `CustomerPickerWithCreate` (`components/crm/CustomerPickerWithCreate.tsx`) - a
  Radix `Popover` whose trigger is `<Button variant="outline">` reading the
  selected label or `Select customer`. Two modes: `search` (debounced 300 ms
  `<Input aria-label="Search customers">`, a `max-h-60 overflow-y-auto` results
  list, and a `Create "<query>"` row gated on `ability.can('create','Customer')`)
  and `create` (an inline new-customer form with `PickOrAccreteLocation showPicker={false}`).
  It can open a third overlay, `DuplicateCustomerDialog`, on a duplicate-customer
  409. Its `onInteractOutside` is suppressed while `dup || saving`.
  **Carries a real, load-bearing DOM workaround:** a callback ref attaches a
  non-passive `wheel` listener to the results list, because the modal Dialog's
  `react-remove-scroll` lock otherwise kills wheel scrolling in the portalled
  popover. This is regression-tested in Playwright (section 6). A v2 rebuild that
  swaps this picker for a kit `Command`/`Combobox` **must reproduce the wheel
  workaround or re-verify against a real browser.**
- `PickOrAccreteLocation` (`components/crm/PickOrAccreteLocation.tsx`) - a
  `FormField`-wrapped `Select` listing existing locations plus a
  `+ Add new location` sentinel (`ADD_NEW_LOCATION = '__add_new__'`), and, when
  that sentinel is chosen, a new-address sub-form of `Address` (an
  `AddressAutocomplete`), `Unit`, `City`, `State` (`maxLength={2}`) and `ZIP`,
  ids prefixed `pal-` by default. Placeholder text: `Select a service location`.
- `TrackedItemSearch` (`components/inventory/lo/TrackedItemSearch.tsx`) - 300 ms
  debounce, `aria-label="Search tracked items"`, placeholder
  `Search tracked items by name or SKU<U+2026>`, spinner while searching, absolute
  `z-20 max-h-64` results panel, `<EmptyState density="flush" title="No tracked items match." />`
  when a search returns nothing. Clears itself after a pick. A failed search is
  swallowed (`.catch(() => setResults([]))`) and shows the same empty state.

---

## 6. Selector surface

**The Service Plans module has zero `data-testid` attributes.** Verified by grep
across `frontend/src/pages/service-plans/` and
`frontend/src/components/service-plans/`. Every existing test keys off roles,
labels, placeholders and `aria-label`s instead, so those strings are the contract:

| Selector | Location | Asserted by |
|---|---|---|
| `role="tablist"` and its exact class string | page tab rail | `__tests__/service-plans-page-tab-rail.test.tsx:29` |
| `role="tab"` names `['Overview','Plans','History']`, `Plans` active by default | page tab rail | same file, lines 47-49 |
| the `Plans` trigger's exact class string | page tab rail | same file, lines 39-45 |
| `button` name `New Plan` | page header | `e2e/specs/service-plan-customer-picker-scroll.spec.ts:38` |
| `button` name `Select customer` | `CustomerPickerWithCreate` trigger | same spec, line 39 |
| `.max-h-60.overflow-y-auto` (a class selector) | picker results list | same spec, line 41 |
| `button` name `/create draft/i` | builder submit | builder-location + materials tests |
| placeholder `e.g. Annual HVAC Maintenance` | Plan name input | both builder tests |
| placeholder `Description` | first line-item description input | both builder tests |
| `input[type="date"]` (first on the page) | Start date | both builder tests, via `document.querySelector` |
| `input[step="0.01"]` (first on the page) | line-item unit price | both builder tests, via `document.querySelector` |
| text `Select a service location` -> `.closest('button')` | location Select trigger | builder-location test line 78 |
| `option` name `/add new location/i` | location Select item | builder-location test line 79 |
| labels `/^address/i`, `/city/i`, `/state/i`, `/zip/i` | new-address sub-form | builder-location test lines 81-84 |
| `aria-label="Search tracked items"` | `TrackedItemSearch` | materials test |
| `aria-label={`Quantity for ${name}`}` | material qty inputs (builder + sheet) | materials test |
| `aria-label={`Remove ${name}`}` | material remove buttons | materials test |
| `button` names `/^edit$/i`, `/^cancel$/i`, `/save materials/i` | detail-sheet materials editor | materials test |
| text `Default materials`, `/no default materials/i`, `/removed from catalog/i` | detail-sheet materials block | materials test |
| `aria-label`s `Interval count`, `Interval unit`, `End date`, `Occurrence count`, `Never ends`, `Ends on a date`, `Ends after a number of occurrences`, and the seven full weekday names (`Sunday`..`Saturday`) | `RecurrenceBuilder` | `components/service-plans/__tests__/RecurrenceBuilder.test.tsx` |

The tab-rail test is the strictest constraint in the module: it pins the rendered
`class` attribute of the `tablist` and of a `TabsTrigger` **byte for byte**, and
asserts the `Tabs` root has an empty class (no Card, no wrapper). Any v2 page
that reuses `TabStrip` with different variants or a surrounding wrapper will fail
it - though note that test imports the real `@/pages/service-plans/ServicePlansPage`,
so a `pages/v2/` copy does not trip it unless the v1 file is edited.

### Existing specs that constrain the module

Vitest:
- `frontend/src/__tests__/service-plans-page-tab-rail.test.tsx` - the tab rail
  markup contract above. Mocks `@/lib/api/users` and stubs `api.get` to
  `{ data: { servicePlans: [] } }`.
- `frontend/src/__tests__/service-plan-builder-location.test.tsx` -
  `resolveServiceLocationId` passthrough/POST, and the "location is created at
  most once across retries" invariant.
- `frontend/src/__tests__/service-plan-materials.test.tsx` - the LO-5 materials
  template: builder add/remove/payload/qty gate, detail-sheet read block,
  removed-from-catalog flag, empty state, and the editable-on-ACTIVE PATCH path.
- `frontend/src/components/service-plans/__tests__/RecurrenceBuilder.test.tsx` -
  `recurrenceToPayload` mapping plus chip/radio/interval interactions.
- `frontend/src/lib/api/__tests__/service-plans.test.ts` - the API module
  (not opened in detail for this map; see Open questions).
- `frontend/src/__tests__/service-plans-report.test.tsx` - the **reports** module's
  `ServicePlansReport`, which shares `useServicePlans`. Out of this module's
  scope, but a shared-API change breaks it.

Playwright: `frontend/e2e/specs/service-plan-customer-picker-scroll.spec.ts` -
the only e2e spec touching `/service-plans`. It seeds 20 customers, opens
`New Plan` -> `Select customer`, and asserts the results list actually scrolls on
`mouse.wheel`. It is a **real-browser-only** regression test (jsdom cannot
reproduce it).

---

## 7. Loading / empty / error summary

### Loading

| Surface | Behaviour |
|---|---|
| Plans tab, first fetch | `<div className="text-text-secondary">Loading<U+2026></div>` replaces the tab body |
| Overview tab, first fetch | **no loading UI** - renders five zero tiles |
| History tab, first fetch | **no loading UI** - renders `No completed visits yet.` |
| Detail sheet, first fetch | **no loading UI** - the sheet opens completely empty until `plan` arrives |
| Builder, customer locations | **no loading UI** - the location Select is simply empty |
| Any in-flight mutation | button-level only: `disabled` plus, for plan-create and save-materials, an inline `Loader2` spinner |

There is no skeleton anywhere in the module.

### Error

There is **no error UI in the Service Plans module at all**, with exactly two
exceptions, both toasts:

1. `Could not create plan` / `extractApiError(err, 'Please try again.')`,
   `variant: 'destructive'` - `PlanBuilderDialog.submit`.
2. `Could not save materials` / `extractApiError(err, 'Please try again.')`,
   `variant: 'destructive'` - `PlanDetailSheet.saveMaterials`.

Everything else fails silently:
- `useServicePlans()` error -> `data` undefined -> `plans = []` (defaulted at the
  destructure, line 630) -> the page shows `No service plans yet.` No retry
  affordance. This is what a 403 looks like to a SALES user (section 1).
- `useServicePlan(id)` error -> the sheet stays open and blank forever.
- `activate` / `renew` / `cancel` / `del` / `schedule` errors -> nothing at all.
- `resolveServiceLocationId`'s POST throwing is caught by `submit`'s outer
  `try/catch`, so it surfaces as `Could not create plan` even though the plan
  create never ran.

The one global error path that does fire is the axios 402 interceptor
(`frontend/src/lib/axios.ts:65-67` -> `handle402`), which toasts rather than
navigating. In practice it cannot trigger here, because `RequireFeature` already
blocked entry for an unentitled org.

### Empty states, verbatim

| Surface | Text |
|---|---|
| Plans tab | `No service plans yet.` |
| History tab | `No completed visits yet.` |
| Detail sheet, materials | `No default materials <U+2014> tracked parts auto-added to each visit<U+2019>s logistic order.` |
| Detail sheet, line items | **none** - just an empty block under the heading |
| Detail sheet, invoices | **none** - the whole block is conditional |
| Overview tiles | **none** - zeros |
| Builder, no customer chosen yet | `Select a customer first.` |
| Customer picker, no matches | `<EmptyState density="flush" title="No matches" />` |
| Customer picker, error | `Couldn't load customers. Try again.` (the only error text in any nested control) |
| Tracked item search, no matches | `<EmptyState density="flush" title="No tracked items match." />` |

---

## 8. Where the "plan-visit job cannot be invoiced" rule surfaces

The integrity rule is real and it **does** surface in the UI - but in the **Jobs**
module, not in Service Plans.

- Backend: `backend/src/controllers/invoice.controller.ts:585-588` and
  `backend/src/controllers/job.controller.ts:4119` both return
  `400 This job is a service plan visit and cannot be invoiced <U+2014> the plan was already paid upfront.`
  when the job has a `source_plan_id`.
- Frontend: `frontend/src/pages/JobDetailPage.tsx:221-223`

  ```ts
  canCreateInvoice: ability.can('create', 'Invoice')
    && job.status !== 'CANCELLED'
    && !job.source_plan_id,
  ```

  so the Create Invoice action is **hidden**, not disabled, on a plan-visit job.
- `JobDetailPage.tsx:1042` computes `const isPlanVisit = !!job.source_plan;` and
  line 1300 renders a `Service Plan ({job.source_plan.service_plan_number})`
  provenance chip.
- The AI copilot persona carries the same rule as instruction text
  (`backend/src/services/copilot/persona.ts:84`).

**Inside the Service Plans module itself, nothing mentions or displays this
rule.** The detail sheet's Invoices block lists the plan's own `kind=PLAN`
invoices and offers no invoicing action, so there is nothing to gate. A v2
Service Plans page needs no new UI for it; the rule lives in the Jobs module's
map.

---

## 9. Component import inventory (the rebuild checklist)

Every `@/components/...` import in the module's two source files.

### `pages/service-plans/ServicePlansPage.tsx`

| Import | Symbols used | Notes for the rebuild |
|---|---|---|
| `@/components/service-plans/RecurrenceBuilder` | `RecurrenceBuilder`, `recurrenceToPayload`, `DEFAULT_RECURRENCE`, `RecurrenceValue` | module-local; `recurrenceToPayload` is pure and unit-tested - reuse, do not rewrite |
| `@/components/ui/button` | `Button` | variants used: `solid`+`tone="business"`, `outline`, `ghost`; sizes `sm` and default |
| `@/components/ui/card` | `Card` | uses the **legacy** `padding` prop with values `sm`, `none`, `lg` (the file's own docs say `pad` is the current scale) |
| `@/components/data/status-badge` | `StatusBadge` | always `domain="servicePlan"`, always `status={effective_status}` |
| `@/components/ui/input` | `Input` | types: text, `date`, `datetime-local`, `number` |
| `@/components/patterns/FormField` | `FormField` | used both with `htmlFor` and in render-prop form (`Sold by`); three sites deliberately do **not** use it, each with an in-file justification comment |
| `@/components/ui/tabs` | `TabsContent` | only `TabsContent` - the `Tabs`/`TabsList`/`TabsTrigger` come from `TabStrip` |
| `@/components/patterns/TabStrip` | `TabStrip` | controlled-only; no `card`/`listVariant`/`triggerVariant` passed, so it renders its bare default |
| `@/components/data/table` | `Table`, `TableHeader`, `TableBody`, `TableRow`, `TableHead`, `TableCell` | uses `TableCell weight="medium"` and `TableCell tone="highlight"` |
| `@/components/ui/dialog` | `Dialog`, `DialogContent`, `DialogHeader`, `DialogTitle`, `DialogFooter` | no `DialogDescription` |
| `@/components/ui/sheet` | `Sheet`, `SheetContent`, `SheetHeader`, `SheetTitle` | no `SheetDescription`, no explicit `side` |
| `@/components/ui/select` | `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem` | three instances: Sold by, Assign technician, plus the interval unit inside `RecurrenceBuilder` |
| `@/components/crm/CustomerPickerWithCreate` | `CustomerPickerWithCreate` | carries the non-passive wheel workaround; e2e-guarded |
| `@/components/crm/PickOrAccreteLocation` | `PickOrAccreteLocation`, `ADD_NEW_LOCATION`, `PickOrAccreteLocationValue`, `ServiceLocationOption` | `ADD_NEW_LOCATION` is a load-bearing sentinel in `resolveServiceLocationId` |
| `@/components/inventory/lo/TrackedItemSearch` | `TrackedItemSearch` | shared with the Logistic Order line picker - cross-module, do not fork |
| `@/components/ui/use-toast` | `useToast` | the module's only feedback channel |

Non-component imports in the same file, listed because the rebuild needs them
too: `@/lib/axios` (`api`), `@tanstack/react-query` (`useQuery`, `useQueryClient`),
`lucide-react` (`Loader2` - the module's only icon import),
`@/lib/api/service-plans` (nine hooks plus `planLineItemsTotal`,
`describeRecurrence`, the `ServicePlan` type), `@/lib/api/users` (`useUsers`),
`@/lib/utils` (`extractApiError`, `formatCurrency`).

### `components/service-plans/RecurrenceBuilder.tsx`

| Import | Symbols used |
|---|---|
| `@/components/ui/input` | `Input` |
| `@/components/ui/select` | `Select`, `SelectTrigger`, `SelectValue`, `SelectContent`, `SelectItem` |
| `@/lib/api/service-plans` | `IntervalUnit` (type only) |

No icon imports, no `Button` - the weekday chips are raw `<button>` elements with
an in-file comment saying they are deliberately not `Button`-shaped.

### Transitively pulled in (not imported by the module, but rendered by it)

`components/ui/popover`, `components/ui/empty-state`, `components/crm/address-autocomplete`,
`components/crm/PickOrCreateCustomer` (`getDuplicateCustomer`,
`computeMatchedCustomerFields`), `components/customers/DuplicateCustomerDialog`,
`contexts/AbilityContext` - all via `CustomerPickerWithCreate` /
`PickOrAccreteLocation` / `TrackedItemSearch`.

---

## 10. Migration risks specific to this module

1. **`service-plans-store.ts` and `service-plans-data.ts` are dead code with a
   contradictory data model.** A builder who reads the directory listing and
   assumes the store is the state layer will rebuild the wrong module. The live
   page is TanStack Query only. Do not port them, and do not "wire them up".
2. **`PlanBuilderDialog` is imported by `CustomerDetailPage`.** It is not a
   private page component. A v2 copy must leave the v1 export standing, or the
   Customers module breaks.
3. **`createPlanSchema` is `.strict()`.** Adding any field to the POST body -
   even a harmless one - is a 400. The client also deliberately omits
   `visit_cadence` and lets the server derive it.
4. **The non-idempotent location POST.** `resolveServiceLocationId` plus the
   `setLocValue` pin plus the `plan-locations` invalidation are one unit. A
   refactor that drops the pin re-introduces duplicate-address accretion, and
   there is a test that will catch it.
5. **The location auto-select effect's `!locValue.locationId` guard** exists to
   stop a jsdom effect loop that hangs vitest. Removing it does not fail loudly -
   it hangs the test run.
6. **The customer picker's non-passive wheel listener** is a real-browser
   workaround for Radix Dialog's scroll lock. Swapping the picker for a kit
   combobox without reproducing it silently regresses a shipped bug fix that has
   a dedicated Playwright spec.
7. **The tab-rail test pins exact class strings.** If the v2 page is a copy under
   `pages/v2/`, it is unaffected; if anyone edits the v1 page's `TabStrip` usage
   or variants, it fails.
8. **Silent lifecycle failures.** Activate/Renew/Cancel/Delete/Schedule visit have
   no `onError`. Adding toasts is an improvement but it is a **behaviour change**
   and needs sign-off under the "no behaviour change" rule.
9. **No confirmation on destructive actions.** `Delete` (DRAFT) and `Cancel plan`
   (ACTIVE) are single-click. A kit `AlertDialog` would be an addition, not a
   port.
10. **All date display is local-timezone** (`toLocaleDateString`), and both
    date-to-API conversions (`new Date(startDate).toISOString()`,
    `new Date(visitDate).toISOString()`) convert local wall-clock to UTC. Any kit
    date component that formats or parses in UTC shifts plans by a day. Note this
    is the **opposite** convention from the Tasks module, which is UTC throughout.
11. **The status branches use raw `status` for actions and `effective_status` for
    badges**, and the Overview tiles mix the two. Collapsing them to one field
    changes what renders.
12. **`Remaining` uses `??` not `||`.** A plan with `visits_remaining: 0` shows
    `0`, not `Ongoing`. An innocuous-looking swap to `||` inverts that.

---

## 11. Open questions

1. **Does `GET /api/service-plans` include `visits` on list rows?** The History
   tab depends entirely on it, the type marks `visits` optional, and the page
   guards with `?? []`. The backend `listPlans` include shape was not opened. If
   the list endpoint omits visits, the History tab is permanently empty today and
   the v2 rebuild would be "reproducing" a dead tab. Verify before building.
2. **The `HistoryTab` row key collides** for two completed visits of the same plan
   sharing a `scheduled_date`. Preserve or fix - it needs an explicit decision.
3. **Seeded material rows show no SKU, freshly picked ones do.**
   `startEditingMaterials` hard-codes `item_sku: null`. Cosmetic inconsistency,
   pinned by no test either way. Preserve or fix.
4. **Is the SALES/TECHNICIAN direct-URL hole intentional?** They reach the page
   with no role sub-gate and see a misleading empty state instead of a permission
   message. Confirm before the v2 route block copies the same guard shape.
5. **`Assign technician` lists every user**, not just technicians. `useUsers()`
   returns all org users; there is no `eligibleFor` filter as there is in the
   Tasks module's `useAssignableUsers`. Preserve or fix.
6. `frontend/src/lib/api/__tests__/service-plans.test.ts` was not opened. If it
   pins hook behaviour or invalidation targets beyond what section 3 records,
   read it before touching the API module (the plan forbids changing shared logic
   anyway).
7. `Card`, `Table`/`TableCell`, `StatusBadge`, `FormField`, `EmptyState`,
   `AddressAutocomplete` and `DuplicateCustomerDialog` internals were not opened -
   they are shared components outside this module and are imported, not forked.
   Only their prop surfaces as used here are recorded.
8. **Service Plans is not in the migration plan's 13-module table**
   (`UI_KIT_MIGRATION_PLAN.md:153-168` lists Dashboard through Auth & Public, with
   no Service Plans row). Which branch/PR owns this module, and whether `/v2/service-plans`
   is in scope at all, is undecided in the plan as written.
9. Radix `TabsContent` unmount-on-inactive is inferred from `TabStrip` passing no
   `forceMount`, not from reading `components/ui/tabs.tsx`. It matters here only
   for whether the detail sheet's local `visitDate` / `editingMaterials` state
   survives - it does, because both overlays are mounted by the page, outside the
   `Tabs` tree.
