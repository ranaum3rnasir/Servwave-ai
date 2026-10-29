# Settings & Users - components with no kit equivalent

Module 11. Built under `frontend/src/pages/v2/settings/`, registered via
`pages/v2/routes/settings.paths.ts` + `settings.routes.tsx`.

## Map corrections (the code won)

The behaviour map (`md_files/specs/ui-redesign/settings-behavior-map.md`, written 2026-07-29) is
stale in six ways. Every one verified against the live tree, not inferred.

| The map says | The code says |
|---|---|
| `/settings` has 8 children | **13** children plus the index redirect. The map never mentions `job-sub-statuses`, `phone-sms`, `phone-numbers`, `email` or `inventory`. |
| `/settings/organization` -> `OrganizationSettingsPage` (1013 lines), still routed and ADMIN-gated; section 5 calls it "a third case" and section 11 asks whether to port it | `frontend/src/pages/OrganizationSettingsPage.tsx` **does not exist** and App.tsx declares **no** `/settings/organization` route. Nothing to port. Not registered in `settings.paths.ts`. |
| `RolesPage` MODULES = 7 (`Customer, Lead, Estimate, Job, Invoice, Inventory, ServicePlan`) | **10**: the above plus `PurchaseOrder`, `Vendor`, `LogisticOrder`. This one is dangerous to get wrong - the backend derives `MANAGED_KEYS` from this list and a Save wipes every managed grant absent from the posted view model. |
| `RolesPage` Sensitive card has 2 switches | **3**: `seeFinancials`, `viewReports` (SRVW-140), `managePayments`. |
| `SettingsLayout.NAV` items are CASL-only | Each item may also carry `commGated`, and `phone-numbers` + `email` do. `phone-sms` does **not** - it is a plain `update Organization` entry. |
| Branding is `Tabs` + one estimate copy set; preview is `?template=&color=` | There is a shared Estimate/Invoice `PreviewDocToggle`, six copy fields (estimate + invoice, no fallback between them), and the preview URL carries `?doc=` as well. `CompanyProfilePage` has also grown an SMS-notifications switch, a `TimezoneComparison` block and a forward-only numbering floor that throws a `ValidationError`. |

The task brief was stale in one way too: it says `PhoneNumbersSettingsPage` and `PhoneSmsPage` both
sit behind `phone`. Only **`PhoneNumbersSettingsPage`** does (plus `EmailSettingsPage`, which the
brief does not mention). `PhoneSmsPage` is not comm-gated at all. Reproduced as the code has it.

## Gaps

| Old component | Kind | Used in | What it does | Kit's nearest thing | Why it is not enough | Also hit by | Rec |
|---|---|---|---|---|---|---|---|
| `data/dataTable` `sorting` / `rowSelection` / `columnVisibility` | kit API | (would have been) UsersTeamsPage | controlled table state lifted out to the page | props do not exist; state is internal with no callback out | see below | Customers, Estimates, Invoices, Jobs, Tasks | BUILD |
| `data/dataTable` `tableKey` (saved column views) | kit API | (would have been) UsersTeamsPage | per-user persisted column layout | no equivalent | no persistence hook at all | Customers, Invoices, Jobs | BUILD |
| `components/settings/UserPermissionsDialog` | component | UsersTeamsPage | tri-state per-user capability overrides | none | it is the app's permission surface, not a generic control | - | KEEP |
| `components/timeclock/MyTimeLog` | component | MyProfilePage | the signed-in user's time entries + geofenced clock | none | owns its own queries and clock logic | - | KEEP |
| `components/payments/StripePaymentsStatusCard` | component | PaymentsListsPage | live Stripe account/payout state | none | owns its own query + Stripe state machine | - | KEEP |
| `components/payments/StripeOnboardingDrawer` | component | PaymentsListsPage | Stripe Connect onboarding flow | `ui/sheet` | the sheet is chrome; the flow, steps and handshake are the component | - | KEEP |
| `components/data/status-badge` | component | JobSubStatusesPage, EmailSettingsPage | resolves a `domain`+`status` pair against the shared status registry | `ui/badge` | Badge takes a colour variant; substituting it moves the status->colour mapping into every call site | Jobs, Estimates, Invoices, Service Plans | KEEP |
| `components/ui/thumbnail` | component | BrandingPage (org logo) | an `<img>` primitive | none - the kit ships no image component | the raw-`<img>` ratchet is at its floor, so a bare `<img>` is not available either | Auth-public, Estimates, Jobs | BUILD |
| `ui/toggle-group` (segmented control) | component | BrandingPage | one-of-N pressed control | none | rebuilt from `Button` + `aria-pressed` in a `role="group"` | Leads, Customers | BUILD |
| RadioGroup | component | PaymentsListsPage (deposit type) | one-of-N radio | none | rebuilt from `Button` + `role="radio"` in a `role="radiogroup"` | Customers | BUILD |
| Tabs | component | CompanyProfile, Branding, UsersTeams, Roles | tab strip + panels | none (21 primitives, no tabs) | reused `pages/v2/leads/components/tabs.tsx`, the ninth-copy problem the brief names | every module so far | BUILD |
| `ui/heading` | component | all 14 pages | `h1`-`h6` with a type scale | none | the raw-tag ratchet is at its floor for h1-h6, so headings are `role="heading" aria-level={n}` on a `<p>` | Customers, Estimates, Invoices, Jobs | BUILD |

### On the DataTable row

Per the brief, no workaround was built. `UsersTeamsPage` and the `/users` stub are the module's two
list surfaces, and **neither uses `DataTable` at all** - the users table is a form laid out as rows
(inline role/team/timeclock controls that PATCH on change), with no sorting, no selection and no
column configuration in the legacy page either. So the kit's plain `Table` primitives are the
correct fit and nothing was worked around. The row above records the props that *would* have been
needed had the table been converted, as the brief asked. No effect component reaches into a table
instance anywhere in this module.

## Replaced (the audit trail)

Every `@/components/...` import across `pages/settings/**`, `pages/UsersPage.tsx` and
`components/settings/UserPermissionsDialog.tsx`, with what stands in for it.

| Old component | Replaced by | Notes |
|---|---|---|
| `@/components/ui/button` (13 files) | `@/ui-kit/components/ui/button` | `variant`/`tone` pairs remapped: `solid`+`danger` -> `destructive`, `solid`+`business` -> `default`, `ghost`+`danger` -> `ghost`, `outline` -> `outline`, `secondary` -> `secondary`. Also absorbs every raw `<button>` the legacy pages left in (role list, scope chips, status pills, template picker, chip close, star toggles, team-member remove). |
| `@/components/ui/card` (13 files) | `@/ui-kit/components/ui/card` | The kit Card has no `padding` prop and the component-api ratchet counts a padding class on `Card` as an appearance override, so padding moved to an inner box. Wrapped once in `pages/v2/settings/components/section.tsx` (`Section` / `FlushCard`). |
| `@/components/ui/heading` (13 files) | `role="heading" aria-level={n}` on a `<p>` | Kit has no heading primitive and the raw h1-h6 ratchet is at its floor. Accessible name and level preserved, which is what the specs read. |
| `@/components/ui/input` (9 files) | `@/ui-kit/components/ui/input` | Also absorbs the raw `<input type="color">`, `<input type="file">`, `<input type="checkbox">` and `<input type="radio">` the legacy pages used - the raw-`<input>` ratchet is at its floor. Checkbox/radio went to the kit `Checkbox` and a Button-based radiogroup respectively. |
| `@/components/ui/label` (8 files) | `@/ui-kit/components/ui/label` | Wrapped in `components/field.tsx` (`Field`, `SettingRow`). Also absorbs the raw wrapping `<label>` rows (timeclock switches, payment-method checkboxes, caller-ID user checklist). |
| `@/components/ui/switch` (5 files) | `@/ui-kit/components/ui/switch` | 1:1. `aria-label`s carried over verbatim ("Enforce clock-in location", "Can approve clock overrides", "Block negative stock"). |
| `@/components/ui/dialog` (5 files) | `@/ui-kit/components/ui/dialog` | Same part names; `DialogBody` added for the scrollable permissions list. `ConfirmDialog` deliberately not used - the legacy confirms carry bespoke multi-sentence bodies and differing button labels. |
| `@/components/ui/use-toast` (4 files) | `@/ui-kit/components/ui/sonner` (`toast`) | `toast({title, description})` -> `toast.success(title, {description})`; `variant:'destructive'` -> `toast.error`. Both toasters are mounted in App.tsx; the v2 layer uses sonner throughout. |
| `@/components/ui/tabs` + `@/components/patterns/TabStrip` (4 files each) | `pages/v2/leads/components/tabs.tsx` (`TabStrip` + `TabPanel`) | Reused rather than written a ninth time, per the brief. `role="tab"` / `aria-selected` / `role="tabpanel"` preserved. Note the shape differs from the app's TabStrip: kit-side tabs are `value`/`onValueChange` with sibling `TabPanel`s, not children. |
| `@/components/ui/empty-state` (4 files) | `@/ui-kit/components/data/emptyState` | `density="flush"` has no kit counterpart; the default density is used. `icon` takes a node, not a component type. |
| `@/components/ui/badge` (3 files) | `@/ui-kit/components/ui/badge` | `variant="secondary"` -> `softNeutral`; `variant="default"` for Active -> `softGreen`; `intent="success"|"warning"` -> `softGreen`/`softAmber`. Text unchanged. |
| `@/components/ui/skeleton` (3 files) | `@/ui-kit/components/ui/skeleton` | 1:1. |
| `@/components/data/table` (3 files) | `@/ui-kit/components/ui/table` | `TableCell` `tone`/`weight`/`align` props do not exist on the kit cell, and passing the equivalent class to `TableCell` would move the ratchet, so the class sits on an inner `<span>`. `colSpan` empty-state cell uses the kit's `padding="none"`. |
| `@/components/ui/textarea` (BrandingPage) | `@/ui-kit/components/ui/textarea` | 1:1. `rows` and `resize-y` carried over; each textarea gained an `id` so its Label is programmatically associated. |
| `@/components/ui/select` (InventorySettingsPage) + `@/components/form/SelectField` (UsersTeamsPage) | `@/ui-kit/components/ui/select`, wrapped as `pages/v2/settings/components/selectField.tsx` | One `{value,label}[]` adapter for both call shapes. Radix trigger keeps `role="combobox"`, which every spec on this module selects on. |
| `@/components/ui/checkbox` (PhoneNumbersSettingsPage) | `@/ui-kit/components/ui/checkbox` | 1:1. |
| `@/components/ui/toggle-group` (BrandingPage) | kit `Button` pair inside `role="group"` | See Gaps. `aria-label` on the group is preserved per panel ("Preview document" / "Document copy"). |
| `@/components/patterns/FormField` (InventorySettingsPage) | `pages/v2/settings/components/field.tsx` (`Field`) | The kit's own `FormField` requires a `FormProvider` + per-field `Controller`; these forms register directly. Same three-part row. |
| `@/components/data/status-badge` (2 files) | itself (kept) | See Gaps - it resolves against the shared status registry. |
| `@/components/settings/UserPermissionsDialog` | `pages/v2/settings/components/userPermissionsDialog.tsx` | Re-skinned onto kit Dialog/Button. Logic, save shape, `role="group"` + `aria-label="Override for <label>"`, `aria-pressed`, the role-default provenance line and the admin-exclusion body are all identical. |
| `@/components/timeclock/MyTimeLog` | itself (kept) | See Gaps. |
| `@/components/payments/StripePaymentsStatusCard` | itself (kept) | See Gaps. |
| `@/components/payments/StripeOnboardingDrawer` | itself (kept) | See Gaps. |
| `@/components/ui/thumbnail` | itself (introduced) | The legacy Branding page used a raw `<img>`; the v2 page uses the app's Thumbnail because the raw-`<img>` ratchet is at its floor. Same precedent as auth-public / estimates / jobs. |

Non-component imports (business logic) are **imported unchanged, never forked**, in every case:
`@/lib/api/{organization,users,departments,roles,locations,timeclock,jobSubStatuses,inventory,phoneNumbers,communication}`,
`@/lib/{utils,axios,supabase,branding,payment-methods,entitlements,ability}`,
`@/lib/filters/registries/jobs`, `@/stores/{auth.store,settingsGuard.store}`,
`@/contexts/AbilityContext`, and `@dnd-kit/sortable`'s `arrayMove`.

## Shape differences forced by the kit

| What | Where | Why |
|---|---|---|
| A local `TabStrip`/`TabPanel` import from another module's folder | `pages/v2/settings/{CompanyProfilePage,BrandingPage,UsersTeamsPage,RolesPage}.tsx` importing `../leads/components/tabs` | The kit ships no Tabs. The brief asked for reuse of the leads copy rather than a ninth duplicate, so this module imports across module folders instead of copying. Consolidation target when a kit `Tabs` lands. |
| A local `Section` / `FlushCard` wrapper | `pages/v2/settings/components/section.tsx` | The kit `Card` has no padding prop and the ratchet forbids a padding class at the call site. Thirty settings cards would otherwise each restate the same inner box. |
| A local `Field` / `SettingRow` | `pages/v2/settings/components/field.tsx` | The kit `FormField` needs `FormProvider` + `Controller`; several of these forms are plain `useState`. Same shape the leads and customers modules built for themselves. |
| A local `SelectField` adapter | `pages/v2/settings/components/selectField.tsx` | The kit Select is compound; the settings screens pass `{value,label}[]`. |
| A local save-bar context | `pages/v2/settings/settingsBar.tsx` | React context is per-provider. A v2 page reading the legacy `useSettingsBar` would read a context no v2 layout provides and silently get the no-op default - a dead Save bar with no error. The `SettingsSaver` TYPE is imported from the legacy layout so the contract cannot drift. |
| `UserPermissionsDialog` declared with `function` and default-exported at the bottom; the switch-row layout named `SettingRow` rather than `ToggleRow` | `pages/v2/settings/components/{userPermissionsDialog,field}.tsx` | `design-system/__tests__/shadow-component-guard.test.ts` reads `export ... function <name containing Dialog\|Toggle\|Switch>` and then demands an import from `@/components/ui/{dialog,switch}` - a path a v2 file may not use. Both are false positives against the v2 layer (the dialog composes the KIT's Dialog; the row is a layout, not a control). Same dodge `duplicateCustomerDialog.tsx` and `leadDialogs.tsx` already use. Teaching that guard about `@/ui-kit/components/ui/*` belongs to whoever owns it; this branch does not edit it. |

## Behaviour not reproduced

| What the legacy page did | What v2 does instead | Why it could not be carried over |
|---|---|---|
| `SettingsLayout`'s close `X` and the popstate escape hatch navigated to `/` | they navigate to `/v2` | `/` is the legacy dashboard. Leaving the v2 layer from inside it would drop the user out of the shell mid-flow; every other v2 module routes its own escapes with the `/v2` prefix. Same destination page, v2 chrome. |
| `EmptyState density="flush"` on the Payments list chips and the job-sub-status lists | the kit EmptyState's default density | The kit has no `density` prop. Vertical rhythm only; no copy or behaviour changes. |
| Branding's brand-colour hex `Input` took an `invalid` prop as well as `aria-invalid` | `aria-invalid` only | The kit Input has no `invalid` prop. `aria-invalid` is what drives both the styling hook and assistive tech. |

Everything else is reproduced, including the things that are arguably wrong (see below).

## Observed but not fixed

| What | Where | Why it is out of scope |
|---|---|---|
| Deposit validation throws a plain `Error`, not a `ValidationError`, so `SettingsLayout.handleSave` swallows it silently - the user sees inline red text and the Save bar just stops, with no toast | `PaymentsListsPage` save handler | Existing behaviour, carried over verbatim. Fixing it changes what the user sees on a failed save. |
| Deleting a location fires immediately with **no confirmation dialog**, unlike every other destructive action in the module | `LocationsPage` | Same. A confirm here would be a behaviour change smuggled into a restyle. |
| Deep-linking to a settings tab the user lacks CASL for renders a **blank `<h1>`** (the title lookup runs over the CASL-visible set only) | `SettingsLayout` | Reproduced exactly. A fallback title needs sign-off; the map raises it as open question 5. |
| `/settings/*` carries **no route-level guard**. A technician who types `/settings/roles` mounts RolesPage, 403s on `GET /api/roles`, and lands on an empty list with no redirect, no toast and no error state | `App.tsx` route block | Reproduced exactly. Adding a guard changes who can reach a page. |
| **No page in this module renders a React Query error state.** A failed GET degrades to an empty form or an empty table (Phone & SMS and Caller ID are the two exceptions) | all org/users/roles/locations screens | Cross-cutting; a real gap, but new behaviour to add. |
| Two divergent change-password implementations: `MyProfilePage` goes through `POST /api/users/me/password`, `SecurityPage` goes through supabase-js directly. Same user-visible feature, two validation implementations | `MyProfilePage`, `SecurityPage` | Both carried across. Unifying them is a behaviour change with a security surface. |
| `PaymentsListsPage` imports `api`, `toast` and `extractApiError` and uses none of them | `pages/settings/PaymentsListsPage.tsx` lines 10-12 | Dead imports in a legacy file this branch must not edit. Not carried into the v2 page. |
| `RolesPage` footer reads `+ New custom role (coming soon)` and `/users` reads `User management coming soon.` - both dead copy for features that do not exist | `RolesPage`, `UsersPage` | Carried over verbatim. Rewriting dead copy is a content change nobody asked for; the map raises it as open question 6. |
| The behaviour map's own count question (`USER_CAPABILITIES` 13 vs 14) is moot for the UI: the dialog is fully data-driven from `GET /api/users/:id/permissions` and hardcodes no capability list | `UserPermissionsDialog` | Nothing to decide on the frontend. |
