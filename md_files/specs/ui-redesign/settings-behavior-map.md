# Settings & Users - behaviour map (UI-kit migration, module 11)

Status: mapping complete 2026-07-29. Source of truth: the files listed below, read in full.
Scope: `/settings/*` (8 children), `/users`, `/settings/organization`.
Branch target: `refactor/ui-kit-11-settings`. Documentation only - no code was changed.

Files read for this map:

| Layer | Path |
|---|---|
| Router | `frontend/src/App.tsx` (lines 100-194) |
| Guard | `frontend/src/components/ProtectedRoute.tsx` |
| Shell | `frontend/src/pages/settings/SettingsLayout.tsx` |
| Pages | `frontend/src/pages/settings/{CompanyProfile,Branding,Locations,UsersTeams,Roles,Security,PaymentsLists,MyProfile}Page.tsx` |
| Legacy | `frontend/src/pages/OrganizationSettingsPage.tsx`, `frontend/src/pages/UsersPage.tsx` |
| Dialog | `frontend/src/components/settings/UserPermissionsDialog.tsx` |
| Legacy cmp | `frontend/src/components/settings/{StaffSection,LogoUpload,TemplateSelector,StaffFormDialog}.tsx` |
| API hooks | `frontend/src/lib/api/{organization,users,roles,departments,locations,timeclock}.ts` |
| Store | `frontend/src/stores/settingsGuard.store.ts` |
| Ability | `frontend/src/lib/ability.ts`, `frontend/src/contexts/AbilityContext.tsx` |
| Backend | `backend/src/routes/{role,user}.routes.ts`, `backend/src/controllers/{role,user}.controller.ts`, `backend/src/lib/permissions/{userCapabilities,roleViewModel}.ts` |
| Tests | `frontend/e2e/specs/settings.spec.ts`, `frontend/e2e/pages/settings.page.ts`, `frontend/src/__tests__/settings-*.test.tsx` and siblings |

---

## 1. Routes and guards

All settings routes live inside two nested wrappers (`App.tsx` 111-188):

```
<ProtectedRoute allowedRoles={['ADMIN','SALES','DISPATCHER','TECHNICIAN']}>   // no fallback
  <AppLayout>
    ...
    <ProtectedRoute allowedRoles={['ADMIN']} fallback>                        // fallback = NotAuthorizedPage
      /users                    -> UsersPage
      /settings/organization    -> OrganizationSettingsPage
    </ProtectedRoute>

    /settings                   -> SettingsLayout          // NO role guard at all
      index                     -> <Navigate to="company" replace />
      company | branding | locations | users | roles | security | payments | profile
  </AppLayout>
</ProtectedRoute>
```

`ProtectedRoute` behaviour (`ProtectedRoute.tsx`):
- `isLoading` -> full-screen "Loading..." div.
- not authenticated -> `<Navigate to="/login" replace />` (always, regardless of `fallback`).
- role not in `allowedRoles` -> `fallback ? <NotAuthorizedPage/> : <Navigate to="/" replace/>`.

**Who can reach what - exactly:**

| Route | Route-level guard | Effective reachability |
|---|---|---|
| `/users` | ADMIN only, `fallback` | ADMIN sees the stub page; SALES/DISPATCHER/TECHNICIAN see `NotAuthorizedPage` |
| `/settings/organization` | ADMIN only, `fallback` | same |
| `/settings` and every child | **none** | **any authenticated user of any role can deep-link to any settings tab** |

This is the single most important guard finding. The `/settings/*` children are **not individually
gated**. `SettingsLayout` only filters the *nav list* by CASL (section 2). A TECHNICIAN who types
`/settings/roles` renders `RolesPage`; the page mounts and fires `GET /api/roles`, which the backend
`canDo('read','Role')` guard 403s. React Query surfaces an error, `roles` defaults to `[]`, and the
user sees an empty role list plus "Select a role." - **no NotAuthorizedPage, no redirect, no toast**.
Same shape for `/settings/users` (empty table, read-only), `/settings/company`, `/settings/branding`,
`/settings/payments`, `/settings/security` (all depend on `GET /api/organization`).

Per-tab CASL requirements (from `SettingsLayout.NAV`), i.e. who sees the nav entry:

| Tab | path | CASL requirement | ADMIN | DISPATCHER | SALES | TECHNICIAN |
|---|---|---|---|---|---|---|
| My Profile | `profile` | `always: true` (no check) | yes | yes | yes | yes |
| Company Profile | `company` | `read Organization` | yes | depends on org role grants | depends | depends |
| Branding & Templates | `branding` | `read Organization` | yes | " | " | " |
| Locations | `locations` | `read Location` | yes | " | " | " |
| Users & Teams | `users` | `update User` | yes | usually no | no | no |
| Roles & Permissions | `roles` | `read Role` | yes | usually no | no | no |
| Login & Security | `security` | `read Organization` | yes | " | " | " |
| Payments & Lists | `payments` | `update Organization` | yes | usually no | no | no |

Non-ADMIN grants are org-editable rows in `role_permissions`, so the "depends" cells are data, not
constants. ADMIN gets `manage all`, so every entry is visible.

**Entry points into the module:** only the Header user menu (`components/layout/Header.tsx` 252-259):
"My Profile" -> `/settings/profile`, "Settings" -> `/settings/company`, both routed through
`requestLeave`. The Sidebar has no Settings item - line 379 comments that the gear was retired.
**Nothing in the app links to `/users` or `/settings/organization`** (repo-wide grep: the only hit is
the route declaration itself). Both are URL-only.

---

## 2. SettingsLayout - the nav shell

Two-column flex: a 224px (`w-56`) left nav plus an `<Outlet/>` pane with a sticky-ish header bar.

**Tab declaration.** A module-level `NAV: NavItem[]` array of
`{ to, label, group, action?, subject?, always? }`. Groups render in first-seen order:
`ACCOUNT` (My Profile), `ORGANIZATION` (Company Profile, Branding & Templates, Locations),
`PEOPLE & ACCESS` (Users & Teams, Roles & Permissions, Login & Security), `ADVANCED` (Payments & Lists).
Filter: `visible = NAV.filter(n => n.always || (n.action && n.subject && ability.can(n.action, n.subject)))`.
Groups are derived from the *visible* set, so an empty group disappears. A separator (`border-t`) is
drawn above every group after the first.

**Active state.** `<NavLink>` per item; active = `bg-primary-subtle font-semibold text-primary`,
inactive = `font-medium text-text-primary hover:bg-background-light`, both `rounded-lg px-3 py-2 text-sm`.
The header title comes from a separate lookup: `current = visible.find(n => location.pathname.includes('/settings/' + n.to))`,
rendered under a small "Settings" eyebrow. If the active tab is not in `visible` (a deep-link a user
lacks CASL for), `current` is `undefined` and the `<h1>` renders **empty** - a real, reproducible edge case.

**Save bar.** Right side of the header: `Discard` (ghost), `Save Changes` (primary, label flips to
"Saving..." while in flight), and an `X` icon button that `guardedNav('/')`. Both Discard and Save are
`disabled={!saver.isDirty || saving}`.

**The saver contract (context).** `SettingsLayout` exports
`useSettingsBar()` returning `{ registerSaver }`, and the type
`SettingsSaver = { save: () => Promise<void>|void; discard: () => void; isDirty: boolean }`.
Each child page calls `registerSaver({...})` inside a `useEffect` keyed on its own dirty state. This is
the module's central coupling: **every v2 page must keep calling `registerSaver` with identical
semantics or the shared Save bar goes dead.**

`handleSave()` awaits `saver.save()`, toasts `{ title: 'Settings saved' }` on success. On throw it
toasts `destructive` **only** when `err.name === 'ValidationError'` (BrandingPage's invalid hex is the
one producer); every other error is assumed to have been toasted by the mutation's own `onError` and is
deliberately swallowed to avoid double-toasting.

**Unsaved-changes guard (#113)** via `stores/settingsGuard.store.ts` (zustand):
- Layout publishes `saver.isDirty` into the store on every change; resets `setDirty(false)` + `cancelPending()` on unmount.
- `beforeunload` listener while dirty (browser reload/close prompt).
- `popstate` listener while dirty: re-pushes the current entry to cancel Back/Forward, then
  `requestLeave(() => navigate('/'))`. It seeds one extra history entry on mount so the first Back has
  something to cancel. Reason documented in the store: the app uses the declarative router, so
  `useBlocker` is unavailable.
- In-shell `NavLink` clicks call `e.preventDefault()` and `guardedNav('/settings/<to>')` when dirty.
- External exit paths (Header user menu, Header comms buttons, GlobalSearch, AppLayout brand logo,
  Sidebar nav + Quick Create) all call `requestLeave` themselves.
- Confirm `Dialog`: title "Discard unsaved changes?", body "You have unsaved changes that will be lost.",
  buttons `Keep editing` (ghost, `cancelPending`) and `Discard` (destructive; calls `saver.discard()`
  then `resolvePending()`).

---

## 3. Per page

### 3.1 CompanyProfilePage (`/settings/company`) - 308 lines

Tree: `Tabs[defaultValue="profile"]` -> `TabsList(Profile | Identifiers & Numbering)`.

- **Profile tab**, 5 `Card`s:
  1. *General & Legal* - `name` (marked required visually only), `display_name`, `legal_name`, `tax_id`, `business_type`, `industry` (comma-joined `string[]`, split/trim/filter on change via `setValue(..., {shouldDirty:true})`).
  2. *Contact* - `phone` (tel), `email`, `support_email`, `billing_email` (all `type=email`), `website` (url).
  3. *Email Notifications* - one `Switch` bound to `email_sending_enabled` (org-wide outgoing-mail kill switch; helper text notes login/security mail is unaffected).
  4. *Localization & Defaults* - `timezone`, `currency` (maxLength 3), `date_format`, `country` (maxLength 2); then a `Scheduling Defaults` sub-block: `default_job_duration_min` and `default_walkthrough_duration_min` (number, min 15 max 1440 step 15, `valueAsNumber`), `default_schedule_start_time` (`type=time`).
  5. *Headquarters Address* - `address_line1`, `address_line2`, `city`, `state`, `postal_code`; a `mailing_same_as_hq` Switch; when **off**, a bordered sub-grid appears with the 6 mailing fields (`mailing_address_line1/2`, `mailing_city`, `mailing_state`, `mailing_postal_code`, `mailing_country`).
- **Numbering tab** - one `Card` with a `Table` over `DOC_ROWS` = Customers, Leads, Estimates, Jobs, Invoices, Service Plans. Per row: prefix `Input`, next-number `Input[type=number, valueAsNumber]`, and a live monospace preview `prefix + String(next).padStart(org.number_padding ?? 5, '0')`.

**Form:** `react-hook-form`, `useForm<Partial<OrgFormValues>>({ defaultValues: {} })`. **No zod resolver,
no zodResolver, no validation rules at all** on this page - validation is entirely server-side.
`reset(...)` on `org` arrival maps ~35 fields with explicit fallbacks.

**Submit:** `handleSubmit` -> `dirtyValues(formState.dirtyFields, values)` (only dirty keys are sent) ->
early-return if the payload is empty -> `update.mutateAsync(payload)` -> `reset(values)` to clear dirty.
Registered as the layout saver; `discard` is `reset()`.

Interactive elements that open nothing: every control is inline. No dialogs on this page.

### 3.2 BrandingPage (`/settings/branding`) - 271 lines

Tree: `Tabs[defaultValue="branding"]` -> `TabsList(Branding | Document Copy)`.

- **Branding tab** - a `lg:grid-cols-[minmax(0,1fr)_340px]` split.
  - Left: *Document Template* card with two toggle buttons from `TEMPLATES = [{alpha-classic,'Classic'},{crm-default,'CRM Default'}]` (selected gets a `✓` suffix); *Live Preview* card containing an `<iframe title="Document preview">` at `h-[700px]`.
  - Right: *Company Logo* card - a 64px preview box (`org.logo_url` or the text "No logo"), a hidden `<input type="file" accept="image/*">` and a `Replace logo` outline `Button` that `fileRef.current?.click()`; label flips to "Uploading..." while pending. *Brand Color* card - a native `<input type="color">`, a hex text `Input` with `aria-invalid`, and a 5-swatch opacity ramp (`1 / .8 / .6 / .4 / .2`) rendered with `style={{ backgroundColor: brandColor }}`.
- **Document Copy tab** - one `Card`, three `Textarea`s: `estimate_terms` (rows 8), `estimate_notes` (rows 8), `estimate_payment_terms` (rows 5, placeholder "e.g. Net 30").

**State, not RHF.** Five `useState`s seeded once from `org` behind a `loaded` flag. `isDirty` is a manual
5-way comparison against `org` with the same fallbacks.

**Validation:** `HEX_RE = /^#[0-9A-Fa-f]{6}$/`. When invalid, the hex Input gets `border-danger` +
`aria-invalid`, an inline `Enter a 6-digit hex color, e.g. #0C2D3A` appears, and `save()` throws
`new Error('Brand color must be a 6-digit hex, e.g. #0C2D3A')` with `name='ValidationError'` - the one
error the layout toasts itself. Comment says the server enforces the same regex.

**PDF preview pipeline** (the most intricate behaviour on the page):
- `useEffect` keyed on `[template, brandColor, hexValid, org?.brand_color, org?.logo_url]`.
- Cache key `${template}|${color}|${org?.logo_url ?? ''}` in a `useRef<Map<string,string>>`; a cache hit sets the URL synchronously with no spinner.
- Otherwise: `setPreviewLoading(true)`, **350 ms debounce**, then an authed `fetch` (token from `getAccessToken()`, `Authorization: Bearer`) to `${VITE_API_URL||''}/api/organization/preview-pdf?template=<t>&color=<encoded>`; response `.blob()` -> `URL.createObjectURL` -> cached + rendered.
- Uses the last-saved `org.brand_color` while the typed hex is invalid.
- Cancellation flag plus `clearTimeout` on cleanup; all cached blob URLs `revokeObjectURL`d on unmount.

**Logo upload:** `onLogoChange` -> `uploadLogo.mutateAsync(file)` immediately on file selection (no
confirm, no crop, no client-side size/type check beyond `accept="image/*"`). `useUploadLogo` posts
`multipart/form-data` to `/api/organization/logo`.

**Design-token conflict (flagged, requirement 8).** BrandingPage does not theme the app - `brand_color`
is described in-page as "the accent on estimate & invoice PDFs and email headers" and is consumed
server-side when rendering PDFs. It never writes a CSS variable and never touches
`design-system/tokens.css`. Two frictions for the migration:
1. The literal `'#0C2D3A'` appears **five times** as a JS default and `style={{backgroundColor: brandColor}}` is a runtime inline colour. Both are raw-hex-shaped. The tokens guard (`src/design-system/__tests__/tokens-guard.test.ts`) is deliberately **scoped** to `src/design-system/**`, `src/components/charts/**` and an allowlist under `src/components/ui/**`, so `pages/settings/**` is not scanned today and this does not fail CI. A v2 page that lands kit components under a scanned path would newly trip it.
2. A user-chosen arbitrary hex can never be a design token by construction. Keep it as data (inline style / CSS custom property set at runtime), do not attempt to fold it into the token file.

### 3.3 LocationsPage (`/settings/locations`) - 181 lines

Tree: header row (`Business Locations` + `+ New Location` primary button) -> optional error banner ->
`Card > Table` -> conditional inline editor `Card`.

- Table columns: Branch, Address (`[address_line1, city, state].filter(Boolean).join(', ')` or an em-dash-free `-`... actually the file uses the `—` character), Time Zone, Staff (`loc._count?.members ?? 0`), and a `Delete` ghost button.
- **Whole row is clickable** (`cursor-pointer`, `onClick={() => setEditing(loc)}`); the Delete button calls `e.stopPropagation()` first.
- **Delete has no confirmation dialog** - it fires `remove.mutateAsync(loc.id)` straight away and only reports failure into the inline error banner. Divergence from every other destructive action in this module.
- Editor card (`editing !== null`): title `Edit Branch` / `New Branch`; fields `name` (required marker), `address_line1`, `city`, `state`, `timezone`, `phone`. Buttons `Cancel` (clears `editing`) and `Save`/`Create`, disabled when the name is blank or a mutation is pending.
- `buildPayload` deliberately strips server-controlled keys (`id`, `created_at`, `manager`, `_count`); the comment notes `code` and `manager` were removed from this screen.
- `registerSaver({ save: noop, discard: noop, isDirty: false })` - the shared Save bar is intentionally
  inert here; saving is per-row.
- Errors: `extractApiError(e, 'Failed to save location' | 'Failed to delete location')` into a
  `rounded-lg bg-danger/10` banner.

### 3.4 UsersTeamsPage (`/settings/users`) - 716 lines, the biggest surface

Tree: `Tabs[defaultValue="users"]` -> `TabsList(Users | Teams)` + **six dialogs + one imported dialog**
mounted as siblings of the tabs.

**CASL gating computed once at the top** (`useAppAbility()`):
`canCreateUser`, `canUpdateUser`, `canDeleteUser` (User), `canUpdateTimeclock` (Timeclock),
`canCreateTeam`, `canUpdateTeam`, `canDeleteTeam` (Department). The stated intent is that a read-only
viewer (a DISPATCHER with `read User` but no writes) gets a read-only table; ADMIN is `manage all`, so
every flag is true.

**Users tab.**
- Status pill filter: `all | active | inactive`, client-side over `users`.
- `+ Invite User` button (only if `canCreateUser`) toggles an **inline Card form** (not a dialog):
  `first_name`, `last_name`, `email`, `phone`, role `SelectField` (ADMIN/SALES/DISPATCHER/TECHNICIAN,
  default `TECHNICIAN`), department `SelectField` (`NONE` -> null). Submit disabled unless first and
  last name are non-blank and the email matches the inline regex `/.+@.+\..+/`. **No zod schema.**
  Payload sends `phone: invite.phone.trim() || null`; `phone_ext` is in the payload type but not in the form.
- Table columns: Name (+ a `No login` secondary `Badge` when `!u.has_login`), Email, Phone
  (`phone` + ` x<ext>`), Role (inline `SelectField` that PATCHes on change when `canUpdateUser`, else
  plain text), Team (inline `SelectField` with `— No team —`, each department, and a sentinel
  `__create__` -> `+ Create new team…`), Time clock (two `Switch`es with `aria-label`
  "Enforce clock-in location" / "Can approve clock overrides", each PATCHing immediately; read-only
  text fallback otherwise), Status `Badge` (Active/Inactive), and an action cluster.
- Action cluster, all conditional:
  - `Edit` (canUpdateUser) -> **Edit-details dialog** (name, phone, extension only; email/role/team excluded by design).
  - `Permissions` (canUpdateUser **and** `u.role !== 'ADMIN'`) -> `UserPermissionsDialog` (section 4).
  - `Send invite` (canUpdateUser, `is_active`, `!has_login`) -> immediate `sendInvite.mutateAsync(u.id)`, no confirm.
  - Active users: `Revoke login` (canUpdateUser + `has_login`) -> **confirm dialog**; `Deactivate` (canUpdateUser) -> **confirm dialog** ("they'll be signed out and their login removed - reactivating later won't restore it").
  - Inactive users: `Reactivate` -> immediate PATCH `{is_active:true}`, no confirm; `Delete` (canDeleteUser) -> **permanent-delete confirm dialog** whose copy warns deletion is blocked if history exists.

**Teams tab.**
- `New team name` input + `+ Add Team` (canCreateTeam).
- 2-column grid of department `Card`s. Each: name, `Rename` (canUpdateTeam -> rename dialog),
  `Delete` (canDeleteTeam -> confirm dialog), a member list (empty -> "No members") with a per-member
  `Remove` link (PATCH `department_id: null`), a **display-only** `Team head` select (label literally
  says "(display-only)"; PATCHes `head_id`), and an `+ Add member…` select over active non-members.

**Dialogs inventory:** create-team-from-dropdown (Enter submits; on success creates the department then
PATCHes the pending user into it), rename-team (Enter submits; no-op if unchanged), permanent-delete
user, revoke-login, edit-user-details, deactivate, delete-team, plus `UserPermissionsDialog`.

`registerSaver({ save: noop, discard: noop, isDirty: false })` - shared Save bar inert; every mutation
is immediate.

### 3.5 RolesPage (`/settings/roles`) - see section 4

### 3.6 SecurityPage (`/settings/security`) - 296 lines

Three `Card`s in a `max-w-2xl` column plus one dialog.

1. *Two-Factor Authentication* - a `Switch` for `mfa_sms_enabled` (an **org-level** policy). Turning it
   **on** opens the `Set up SMS authentication` dialog (copy: SMS delivery isn't connected yet, so this
   is stored as policy); confirming sets local `sms=true` (dirty). Turning it **off** flips local state
   directly. Persisted only through the layout Save bar -> `PATCH /api/organization { mfa_sms_enabled }`.
2. *Email authentication* - a **per-user** enrollment flow that deliberately does NOT go through
   `useUpdateOrganization` (in-file comment warns against it). Raw axios, three endpoints:
   - mount: `GET /api/auth/mfa/status` -> `enrolled` (catch -> false).
   - `Enable email authentication` -> `POST /api/auth/mfa/setup` -> stores `challengeId`, reveals a
     6-digit code `Input` (`inputMode=numeric`, `autoComplete=one-time-code`, `maxLength=6`, digits-only
     via `replace(/\D/g,'')`), with `Cancel` / `Confirm` (Confirm disabled under 6 chars).
   - `Confirm` -> `POST /api/auth/mfa/enable { challengeId, code }` -> success message "Email authentication is on."
   - `Disable email authentication` -> `POST /api/auth/mfa/disable`.
   - Buttons render only while `emailEnrolled !== null && emailChallengeId === null`.
   - Messages render as a local `{ok,text}` line in `text-success` / `text-danger`.
3. *Change Password* - **bypasses the API entirely**: re-authenticates with
   `supabase.auth.signInWithPassword({ email, password: current })`, then `supabase.auth.updateUser({password})`.
   Client rules: current password required; new >= 8 chars; new === confirm. Inline `{ok,text}` message.
   This is a second, divergent password implementation - see MyProfilePage below.

### 3.7 PaymentsListsPage (`/settings/payments`) - 325 lines

Two rows of two cards; RHF `useForm<FormValues>` with **no zod resolver**; everything driven by
`setValue(..., {shouldDirty:true})` + `watch`.

- *Accepted Payment Methods* - a checkbox per `PAYMENT_METHOD_ORDER` (`lib/payment-methods`). CARD has
  two special states: `cardNotAvailable` (no `org.stripe_account_id`) -> disabled + 50% opacity +
  "(Stripe not connected - contact support)"; `cardLocked` (Stripe connected) -> disabled +
  "(locked - Stripe is integrated)". Both are non-interactive, so CARD is never user-togglable.
- *Default Deposit* - radio pair `PERCENTAGE` / `FIXED`; then either a percentage number Input
  (min 0, max 100, step .5) or a fixed-amount Input (min 0, step .01).
- *Lead/Customer Sources* and *Job Types* - identical `ListSection`s: chips with an `X` remove button,
  an add Input (`maxLength 50`, Enter submits) and an `Add` button. Duplicate detection is
  case-insensitive; empty state is the italic "No options - add some below.".

**Validation runs inside `save`** (not a resolver): PERCENTAGE outside 0-100 or NaN -> sets
`depositError` and `throw new Error('Invalid deposit percentage')`; FIXED negative or NaN ->
`'Invalid deposit fixed amount'`. Note these throws are **plain `Error`s, not `ValidationError`s**, so
`SettingsLayout.handleSave` swallows them silently - the user only sees the inline red text under the
field and the Save bar simply stops. Worth carrying over exactly, and worth raising as a UX bug.

### 3.8 MyProfilePage (`/settings/profile`) - 201 lines

Two `Card`s.
1. *My Details* - RHF over `{first_name, last_name, phone, phone_ext}` seeded from
   `useAuthStore().user`; `Email` and `Role` render as `disabled readOnly` Inputs. Footnote:
   "Your role, team, and access are managed by an administrator." Submit sends only dirty keys via
   `dirtyValues` -> `PATCH /api/users/me` -> `applyUserPatch(...)` into the auth store so the Header
   name updates without a `/api/auth/me` refetch -> `reset(values)`.
   `register('first_name', {required:true})` / `last_name` are the only RHF rules in the module.
2. *Change Password* - self-contained; hidden entirely when `user.has_login === false` (seats with no
   login). Rules: current non-empty, new >= 8 (inline "Password must be at least 8 characters."),
   new === confirm (inline "Passwords do not match."). Submits through
   `useChangeMyPassword` -> `POST /api/users/me/password { current_password, password }` - the backend
   re-verifies the current password. Toasts `{title:'Password updated'}` and clears all three fields.

**Duplication finding:** MyProfilePage changes the password through the API; SecurityPage changes it
through the Supabase client directly. Same user-visible feature, two code paths, two validation
implementations. Do not unify during the UI swap - record it and leave both.

### 3.9 UsersPage (`/users`) - 17 lines

A single `Card` with a `Users` icon, an `<h2>Users</h2>` and the body text
**"User management coming soon."** No hooks, no API calls, no state.

### 3.10 OrganizationSettingsPage (`/settings/organization`) - 1013 lines

The pre-module monolith. One `<form>` with `zodResolver(orgSchema)` - **the only zod schema in this
module** (`OrganizationSettingsPage.tsx` 36-67):

```
name              z.string().min(1,'Name is required')
legal_name / address_line1 / address_line2 / city / state / postal_code
                  z.string().nullable().optional()
email             z.string().email('Invalid email').or(z.literal('')).nullable().optional()
phone / website / brand_color / estimate_template
                  z.string().nullable().optional()
estimate_terms / estimate_notes / estimate_payment_terms
                  z.string().nullable().optional()
accepted_payment_methods  z.array(z.enum(['CARD','EXTERNAL_CARD','BANK_TRANSFER','CHECK','CASH'])).default([])
source_options / job_type_options  z.array(z.string()).default([])
{lead,estimate,job,invoice}_prefix  z.string().regex(/^[A-Za-z0-9-]{0,10}$/,'Up to 10 alphanumeric or dash characters').nullable().optional()
number_padding    z.coerce.number().int().min(1).max(10).nullable().optional()
{lead,estimate,job,invoice}_next_number  z.coerce.number().int().positive().nullable().optional()
```

Sections: Branding (`LogoUpload`, brand-colour swatch + hidden colour input, `TemplateSelector` + PDF
iframe preview - **undebounced, template-only, no colour param**), Company Info, Accepted Payment
Methods (same CARD rules, additionally disabled when `!isAdmin`), `DepositPercentageSection`
(own `useQuery`/`useMutation` straight to `PATCH /api/organization`), `RequireWalkthroughSection`
(`PATCH /api/settings/require_walkthrough_before_send` - an endpoint no other page in this module
touches), Estimate Document Copy, Numbering (incl. `number_padding`, which the new Company Profile
does **not** expose), Source Options, Job Type Options, a `type="submit"` Save button, `StaffSection`
(its own user list with `window.confirm` for deactivate and a `StaffFormDialog`), and Departments.

Submit strips empty-string prefixes before PATCHing (backend wants absent, not `''`), sets a transient
`Settings saved.` message for 3 s, and puts failures in a local `submitError`.

---

## 4. RolesPage and the permission model (the critical page)

### 4.1 What RolesPage actually edits

`RolesPage.tsx` is 245 lines. Layout: a 224px role list on the left, a detail pane on the right.

- **Role list**: buttons from `useRoles()` (`GET /api/roles`), each showing `r.label` and `r.userCount`.
  Selecting a role goes through `requestLeave(() => setSelected(r.role))` - an *intra-page* switch that
  a router blocker could never catch, which is exactly why the guard lives in a zustand store.
  A static footer reads `+ New custom role (coming soon)` - **custom roles do not exist**.
- **Detail header**: role label; when `!editable`, the warning line `Full access — non-reducible`;
  when `editable`, a `Reset to default` outline button -> `POST /api/roles/:role/reset` with **no confirm dialog**.
- **Tabs**: `Permissions` and `Data Scope`.

**Permissions tab** - a `<table>` of `MODULES × CRUD`:
`MODULES = Customer, Lead, Estimate, Job, Invoice, Inventory, ServicePlan`;
`CRUD = read('View'), create('Create'), update('Edit'), delete('Delete')`.
Each cell is a `Switch` bound to `draft.matrix[subject][action]`, `disabled={!editable}`.
Below it a *Sensitive* card with two switches: `See financial data` (`sensitive.seeFinancials`) and
`Record & refund payments` (`sensitive.managePayments`).

**Data Scope tab** - per module, four chips `Owned | Team | Location | All`.
`SCOPE_REAL = {Lead, Job, Estimate, Invoice}`. For a non-real subject (Customer, Inventory, ServicePlan)
every chip except `All` is disabled with the title
`No record-ownership field — applies at All`, and `All` renders active regardless of state. Footnote:
"Customers & Inventory have no record-ownership field, so scope applies at the 'All' level."

**Draft/dirty model.** `useRolePermissions(selected)` loads a `RoleViewModel`; `draft` is a
`structuredClone` of it. `isDirty = JSON.stringify(draft) !== JSON.stringify(loaded)`. The saver is
registered with `isDirty: isDirty && editable`; `save` strips the `editable` key before
`PUT /api/roles/:role/permissions`; `discard` re-clones `loaded`.

### 4.2 What the backend does with that view model

- `ROLE_META` (`role.controller.ts` 18-23): ADMIN `Administrator (Owner)`, `fullAccess:true`,
  `editable:false`; SALES / DISPATCHER / TECHNICIAN all `editable:true`.
- `GET /api/roles/ADMIN/permissions` returns a synthetic all-true `adminViewModel()` with
  `editable:false` and `general.description = 'Full access (non-reducible)'`. `PUT` on ADMIN is a 400.
- `assembleRoleViewModel` / `viewModelToGrants` (`lib/permissions/roleViewModel.ts`) map the surface to
  real `role_permissions` rows. `SENSITIVE.seeFinancials -> read Report`;
  `SENSITIVE.managePayments -> record_payment Invoice + record_payment Estimate + refund Invoice`.
  Scope values become Prisma condition templates with `{{userId}}` / `{{teamId}}` / `{{locationId}}`
  placeholders (`SCOPE_CONDITIONS`).
- **`MANAGED_KEYS`** is the safety net: a role Save only adds/removes pairs the matrix can express.
  Out-of-surface grants (lifecycle verbs such as `revise`, `archive`, `send`, `assign`, `complete`,
  `delete Lead`, and org-settings' `read Location`) are **preserved, never stripped**. Any v2 page that
  posts a different view-model shape risks silently deleting grants - do not reshape the payload.
- `PUT` and `reset` both call `clearPermissionCache(orgId)` and write two audit records
  (`writeSettingsAudit` + `logAudit`), actions `role.permissions_updated` / `role.reset`.
- Route guards: `GET` needs `read Role`; `PUT` and `reset` need `update Role` (`role.routes.ts`).

### 4.3 Per-user capability grants - NOT on RolesPage

**Key finding for requirement 4: RolesPage does not expose the per-user capability grants at all.**
`create Job`, `create Invoice`, `record_payment`, `reschedule` and the rest live in a completely
different surface: the `Permissions` button on each row of **UsersTeamsPage**, which opens
`components/settings/UserPermissionsDialog.tsx`.

The dialog is **fully data-driven** from `GET /api/users/:id/permissions`; it hardcodes no capability
list. The backend builds that list from `backend/src/lib/permissions/userCapabilities.ts`
(`USER_CAPABILITIES`, 13 entries today):

| action | subject | label | own-condition | impliesRead |
|---|---|---|---|---|
| create | Lead | Create leads | OWN_LEAD | yes |
| update | Lead | Edit own leads | OWN_LEAD | yes |
| create | Estimate | Create estimates | OWN_ESTIMATE_VIA_LEAD | yes |
| update | Estimate | Edit own estimates | OWN_ESTIMATE_VIA_LEAD | yes |
| create | Job | Create jobs | OWN_JOB | yes |
| update | Job | Edit own jobs | OWN_JOB | yes |
| en_route | Job | Mark own jobs en-route | OWN_JOB | yes |
| arrive | Job | Mark own jobs on-site | OWN_JOB | yes |
| start | Job | Start own jobs | OWN_JOB | yes |
| complete | Job | Complete own jobs | OWN_JOB | yes |
| reschedule | Job | Reschedule own jobs | OWN_JOB | yes |
| create | Invoice | Create invoices | OWN_INVOICE_VIA_JOB | yes |
| update | Invoice | Edit own invoices | OWN_INVOICE_VIA_JOB | yes |
| record_payment | Invoice | Record payments | OWN_INVOICE_VIA_JOB | yes |

(The table lists 14 rows because `USER_CAPABILITIES` has 14 entries; the dialog test comment says 13 -
treat the module file as authoritative and the count as data, not a constant.)

Grants are **fixed own-scoped**: the DB override row is bare (`action`, `subject`, `effect`); the
own-condition is looked up at ability-build time in `defineAbility.ts`. There is no scope column.
`impliesRead: true` auto-adds the paired own-scoped `read <subject>`.

**How the UI distinguishes role defaults from per-user grants** - this is the answer to requirement 4:

1. **Different screens.** Role defaults are the RolesPage matrix (org-wide, per role). Per-user grants
   are a per-row dialog in UsersTeamsPage. There is no cross-link or breadcrumb between them.
2. **Different vocabulary.** RolesPage uses binary `Switch`es. The dialog uses a **tri-state button
   group**: `Inherit` (secondary when active) / `Allow` (`business` variant) / `Deny` (`destructive`);
   inactive options are `outline`. Each group carries `role="group"` and
   `aria-label={"Override for " + c.label}`, and each button carries `aria-pressed`.
3. **Explicit inline provenance.** Under every capability the dialog prints
   `Role default: Allowed by role` or `Role default: Not in role`, computed server-side from the live
   `role_permissions` rows (`roleAllowed`). The dialog header explains:
   "Inherit follows their role; Allow grants it even if the role doesn't; Deny removes it."
4. **Grouping.** `groupBySubject()` groups capabilities under an uppercase subject heading, preserving
   API order.
5. **Admin exclusion, twice.** The `Permissions` button is hidden when `u.role === 'ADMIN'`; and if the
   dialog is reached anyway, `data.editable === false` replaces the whole body with
   "Administrators have full access, which can't be overridden." (backend also 400s the PUT).
6. **Effective state** (`effective = override==='deny' ? false : override==='allow' ? true : roleAllowed`)
   is returned by the API but **not rendered** - the dialog shows role default + override only. If the
   v2 page wants an "effective" badge, that is new behaviour and must be raised, not invented.

**Save semantics:** only `allow`/`deny` entries are sent; a capability set back to `inherit` is simply
omitted, and `putPermissions` deletes-then-recreates all managed rows in one transaction (absence = inherit).
Unsupported `(action, subject)` pairs are rejected 400 by `isManagedCapability`.

**Front-end consumption of these grants** (out of module but load-bearing): `lib/ability.ts` exports
`canOnJob(ability, verb, job, userId)` with a long comment explaining that
`ability.can(verb, subject('Job', job))` returns false for every technician, because the own-job
condition uses Prisma's `some` operator, which the Mongo/sift matcher cannot evaluate. It checks the
type-level `can` first (so inverted deny rules win), then requires assignment when every matching rule
is conditional. **Do not touch or re-implement this during the UI swap.**

---

## 5. UsersTeamsPage vs UsersPage - verdict

**Both routes are live; they are not duplicates. `/users` is a dead stub.**

Evidence, all read directly:
- `pages/UsersPage.tsx` is 17 lines: a card that says "User management coming soon." No hooks, no API.
- `pages/settings/UsersTeamsPage.tsx` is 716 lines and is the real, shipping user-management screen.
- Repo-wide grep for `to="/users"` / `'/users'` in `frontend/src` returns exactly one hit: the route
  declaration in `App.tsx:171`. Nothing navigates there. The Sidebar has no Users entry.
- The e2e page object and spec (`e2e/pages/settings.page.ts`, `e2e/specs/settings.spec.ts`) only know
  the `/settings/*` screens; `/users` is untested.

`/settings/organization` (`OrganizationSettingsPage`, 1013 lines) is a **third** case: it is a real,
working page that is functionally superseded by the Settings module but is still routed, still ADMIN-gated,
and still unlinked from any nav. Its overlap with the module is near-total (branding, company info,
payment methods, deposit, document copy, numbering, source/job-type lists, staff, departments) with two
exclusives: `number_padding` and the `require_walkthrough_before_send` app setting - neither of which
the new module exposes.

**Recommendation for the build phase (decision for the owner, not for the builder):**
port `UsersTeamsPage` fully; port `/users` as-is (it is 17 lines); treat `/settings/organization` as
lowest priority or explicitly out of scope. Do not delete anything - the plan forbids it.

---

## 6. API surface

| Page | Hook | Method + endpoint | Query key / invalidation |
|---|---|---|---|
| Company, Branding, Security, Payments | `useOrganization` | `GET /api/organization` | key `['organization']` |
| " | `useUpdateOrganization` | `PATCH /api/organization` | invalidates `['organization']`; `onError` destructive toast "Save failed" |
| Branding | `useUploadLogo` | `POST /api/organization/logo` (multipart) | invalidates `['organization']`; toast "Logo upload failed" |
| Branding | raw `fetch` | `GET /api/organization/preview-pdf?template=&color=` | not in React Query; blob + local Map cache |
| Locations | `useLocations` | `GET /api/locations` | `['locations']` |
| Locations | `useCreateLocation` | `POST /api/locations` | invalidates `['locations']` (**no onError toast**) |
| Locations | `useUpdateLocation` | `PATCH /api/locations/:id` | invalidates `['locations']` (no toast) |
| Locations | `useDeleteLocation` | `DELETE /api/locations/:id` | invalidates `['locations']` (no toast) |
| Users&Teams | `useUsers` | `GET /api/users` -> `data.users` | `['users','all']` |
| Users&Teams | `useInviteUser` | `POST /api/users/invite` | invalidates `['users']` **and** `['departments']`; success toast varies on `email_sent`, falling back to pasting `invite_url` |
| Users&Teams | `useSendInvite` | `POST /api/users/:id/invite` | invalidates `['users']`; same dual toast |
| Users&Teams | `useUpdateUser` | `PATCH /api/users/:id` | invalidates `['users']`; toast "Update failed" |
| Users&Teams | `useDeactivateUser` | `DELETE /api/users/:id` | invalidates `['users']`; toast "Deactivate failed" |
| Users&Teams | `useDeleteUser` | `DELETE /api/users/:id/permanent` | invalidates `['users']`; toast "Delete failed" |
| Users&Teams | `useRevokeLogin` | `POST /api/users/:id/revoke-login` | invalidates `['users']`; toast "Could not disable login" |
| Users&Teams | `useDepartments` | `GET /api/departments` -> `data.departments` | `['departments']` |
| Users&Teams | `useCreateDepartment` | `POST /api/departments {name}` | invalidates `['departments']` |
| Users&Teams | `useUpdateDepartment` | `PATCH /api/departments/:id {name, head_id}` | invalidates `['departments']` |
| Users&Teams | `useDeleteDepartment` | `DELETE /api/departments/:id` | invalidates `['departments']` |
| Users&Teams | `useUpdateUserTimeclockSettings` | `PATCH /api/timeclock/users/:id/timeclock-settings` | invalidates `['users']`; toast "Update failed" |
| Permissions dialog | `useUserPermissions` | `GET /api/users/:id/permissions` | `['user-permissions', id]`, `enabled: !!id` |
| Permissions dialog | `useUpdateUserPermissions` | `PUT /api/users/:id/permissions {overrides}` | invalidates `['user-permissions', id]` **and** `['users']`; success toast "Permissions updated" |
| Roles | `useRoles` | `GET /api/roles` | `['roles']` |
| Roles | `useRolePermissions` | `GET /api/roles/:role/permissions` | `['roles', role, 'permissions']`, `enabled: !!role` |
| Roles | `useUpdateRolePermissions` | `PUT /api/roles/:role/permissions` | invalidates `['roles', role]`; toast "Save failed" |
| Roles | `useResetRole` | `POST /api/roles/:role/reset` | invalidates `['roles', role]`; toast "Reset failed" |
| My Profile | `useUpdateMe` | `PATCH /api/users/me` | invalidates `['users']`; also `applyUserPatch` into the auth store |
| My Profile | `useChangeMyPassword` | `POST /api/users/me/password {current_password, password}` | no invalidation; toast "Password change failed" |
| Security | raw axios | `GET /api/auth/mfa/status`, `POST /api/auth/mfa/{setup,enable,disable}` | none - local `useState` only |
| Security | supabase-js | `auth.signInWithPassword`, `auth.updateUser` | none |
| Org Settings (legacy) | inline `useMutation` | `PATCH /api/organization`, `PATCH /api/settings/require_walkthrough_before_send` | own `queryClient` calls |

Backend route guards: `/api/roles/*` -> `canDo('read'|'update','Role')`; `/api/users/:id/permissions`
-> `canDo('update','User')` (managing permissions is an admin-level act, deliberately gated on the
*update* right, not read); `/api/users/me*` needs only `authenticate`.

---

## 7. Entitlements: plans and feature flags

**Nothing in the Settings UI surfaces org plans or feature flags. Verified, not assumed.**

- `git grep -l "feature_overrides"` across the whole repo on `main` returns exactly one file: `CLAUDE.md`.
- `grep -rn "useFeature|features\[|entitlements"` over `frontend/src` returns **no matches**.
- `grep -rn "requireFeature"` over `backend/src` returns **no matches**; there is no
  `backend/src/lib/entitlements/` directory in this checkout.

So on the branch this map was written against: `STARTER`/`PRO`/`SCALE` and `feature_overrides` are
operated entirely out-of-band (the `/onboard-org`, `/change-org-plan`, `/audit-org-entitlements` skills
computing SQL applied via Supabase MCP), with no admin-facing screen. Consequences for the migration:

- There is **no plan badge, no upgrade prompt and no feature-flag toggle** to port. A v2 Settings page
  must not invent one.
- `phone` is the master switch for the entire Communication module (9 backend `comm-*` route groups plus
  the Communication nav and tabs), `minPlan` PRO, and is written **`false` for every newly onboarded
  org regardless of plan**. Nothing in Settings reflects or changes that.
- Gating middleware (`requireFeature`/`useFeature`) is **not deployed to prod**, so overrides are
  recorded but inert there. Do not build UI that implies the flag is enforced.
- If entitlements UI is wanted, it is new scope and belongs in a separate plan.

---

## 8. States: loading, empty, error

| Page | Loading | Empty | Error |
|---|---|---|---|
| SettingsLayout | none (children own it) | if the active tab is not in the visible nav set the `<h1>` renders blank | save errors -> toast (ValidationError) or the mutation's own toast |
| Company Profile | none - `useOrganization` has no `isLoading` branch, so every field renders empty until `reset()` fires | n/a | `useUpdateOrganization` destructive toast only; no inline field errors (no resolver) |
| Branding | preview: spinner + "Generating preview…"; logo button -> "Uploading…" | logo box -> "No logo" | preview failure -> "Preview unavailable"; hex invalid -> inline red + ValidationError toast; upload failure -> toast |
| Locations | none | table row `colSpan=5`, "No locations yet." | inline `bg-danger/10` banner from `extractApiError` |
| Users & Teams | none - no `isLoading` branch anywhere | table simply renders zero rows (**no empty-state copy**); a team card with no members shows "No members" | every mutation toasts; no inline errors |
| Roles | none - `roles` and `draft` default to `[]`/`null` | detail pane -> "Select a role."; role list simply empty | `useUpdateRolePermissions` / `useResetRole` toasts; a 403 on `GET /api/roles` degrades to the empty list with no message |
| Security | button labels "Working…" / "Confirming…" / "Updating…" | n/a | local `{ok,text}` line, `text-danger` |
| Payments & Lists | none | list chips -> italic "No options - add some below." | inline `depositError` text (**toast suppressed** - the throw is a plain Error) |
| My Profile | password button -> "Updating…" | n/a | inline field messages + mutation toast |
| Org Settings (legacy) | full-page `Loader2` spinner while `isLoading` | n/a | `submitError` state + per-field zod messages |

Cross-cutting gap worth flagging to the builder: **no page in this module renders a React Query error
state**. A failed GET degrades to an empty form or an empty table.

---

## 9. Selector surface

**There is not a single `data-testid` in `pages/settings/**`, `pages/UsersPage.tsx`,
`pages/OrganizationSettingsPage.tsx`, or `components/settings/**`.** Verified by grep. Every test
depends on accessible roles, visible text, or raw attribute selectors, so the v2 pages must preserve
**labels, roles and ARIA attributes verbatim** - there is no testid safety net.

### e2e - `frontend/e2e/specs/settings.spec.ts` (+ `e2e/pages/settings.page.ts`)

| Selector | Where it comes from |
|---|---|
| `getByRole('button').filter({has: '.bg-primary-subtle'}).last()` then `getByRole('menuitem', {name:'Settings'})` | Header user pill + menu; must land on `/settings/company` |
| `getByRole('link', {name})` for `Company Profile`, `Branding & Templates`, `Locations`, `Users & Teams`, `Roles & Permissions`, `Login & Security` | `SettingsLayout` NAV labels - **do not rename these strings** |
| `getByRole('tab', {name})` for `Profile`, `Identifiers & Numbering`, `Permissions`, `Data Scope` | Radix `TabsTrigger` |
| `getByText('Customers', {exact:true})` | numbering table row label |
| `getByRole('button', {name:'Save Changes'})` and its enabled/disabled state | layout save bar |
| `getByText('Settings saved')` | layout success toast |
| `getByText('Settings', {exact:false}).first()` | the "Settings" eyebrow, asserted on every screen |
| `input[name="display_name"]` (fill + `toHaveValue` after reload) | RHF `register('display_name')` - the v2 page **must keep RHF `register` so the `name` attribute survives** |
| `getByRole('button', {name:/Sales/}).first()` | role list button (label + userCount) |
| `getByRole('switch').first()` | first permission-matrix cell |
| `getByRole('button', {name:'Reset to default'})` | roles header |
| API waits on `/api/roles`, `/api/roles/SALES/permissions`, `/api/roles/SALES/reset`, `/api/organization` | endpoints must not change |
| `settings.goto(screen)` for `company | branding | locations | users | roles | security` | route paths |

### vitest - `frontend/src/__tests__/`

Specs: `settings-branding`, `settings-company-profile`, `settings-guard`, `settings-layout-save`,
`settings-locations`, `settings-payments`, `settings-roles`, `settings-security`,
`settings-unsaved-guard`, `my-profile-page`, `users-teams-page`, `users-teams-page-rbac-gate`,
`user-permissions-dialog`; plus `lib/api/users.test.tsx` and `lib/api/departments.test.tsx`.

Selectors they depend on (extracted from the specs):

- Roles: `getByRole('button', {name:/Dispatcher/})`, `getByRole('heading', {name:'Sales'})`,
  `getAllByRole('switch')`, `getByRole('tab', {name:'Data Scope'})`,
  `getByRole('button', {name:'Keep editing'})`, `getByText('Estimate')`, `getByText('Invoice')`.
- Permissions dialog: `getAllByRole('group', {name:/^Override for /})`,
  `getByRole('group', {name:'Override for Create invoices'})`,
  `getByRole('group', {name:'Override for Record payments'})`,
  `getByRole('button', {name:'Allow'|'Inherit'})`, `getByText('Create estimates')`,
  `getByText('Record payments')`, `getByRole('button', {name:'Save'})`.
  **The `aria-label` template `` `Override for ${c.label}` `` is load-bearing.**
- Users & Teams: `getByRole('button', {name:/invite user/i})`, `/^edit$/i`, `/^permissions$/i`,
  `'Deactivate'`, `getByRole('combobox')` / `getAllByRole('combobox')` (the `SelectField`s),
  `getByRole('switch')` (timeclock), `getByText('TECHNICIAN')`, `getByText(/login removed/i)`
  (deactivate dialog copy).
- Company Profile: `getByDisplayValue('60')`, `getByText('Default job duration (min)')`,
  `getByText('Default walkthrough duration (min)')`, `getByText('Default start time')`,
  `getByText(/Used by the scheduler/)`.
- Branding: `getByRole('tab', {name:'Document Copy'})`, `getByDisplayValue('Sample terms')`.
- Payments: `getByText('Default Deposit')`, `getByText('Lead/Customer Sources')`,
  `getByText('Job Types')`, `getByPlaceholderText(/New source/)`.
- Security: `getByText('Email authentication')`, `getByRole('button', {name:/^confirm$/i})`,
  `getByText('Change Password')`, `getByText(/Current password/)`,
  `getByRole('button', {name:'Update password'})`.
- My Profile: `getByText('My Details')`, `getByRole('button', {name:/update password/i})`,
  `getByDisplayValue('Jane')`, `getAllByDisplayValue('')`.
- Locations: `getByText('Main Branch')`.
- Guard specs: `getByTestId('pathname')` (a test harness element, not app code),
  `getByRole('link', {name:'Leads'})`, `getByRole('link', {name:'ServWave dashboard'})`,
  `getByRole('button', {name:'Phone messages'})` - these live in Sidebar/Header, not this module, but
  the guard tests mount them together.

`user-permissions-dialog.test.tsx` attaches its own `api.put` mock because the global axios mock in
`src/__tests__/setup.ts` defines only get/post/patch/delete - relevant if a v2 test is added.

---

## 10. Risks for the build phase

1. **`registerSaver` is the module's spine.** Six of the eight tabs register a saver, two register a
   no-op saver on purpose. Any v2 page that forgets it, or that registers with a different `isDirty`
   derivation, breaks the shared Save/Discard bar and every guard path that depends on it.
2. **RolesPage payload shape must not drift.** `viewModelToGrants` + `MANAGED_KEYS` on the backend mean
   a mis-shaped PUT can silently strip lifecycle grants the matrix cannot represent.
3. **Zero data-testids.** The whole test surface is label/role/attribute based, including
   `input[name="display_name"]` and `aria-label="Override for <label>"`. Renaming a nav label, a tab, or
   a button breaks e2e.
4. **The unsaved-changes guard spans four mechanisms** (store, `beforeunload`, `popstate` with a seeded
   history entry, and per-link `preventDefault`). It is easy to lose one when re-laying-out the shell.
5. **`/settings/*` has no route guard** - the v2 shell must reproduce the "nav filtered, route open,
   API 403s into an empty state" behaviour exactly, or it will change who can see what.
6. **Branding's PDF preview** (debounce + blob cache keyed on template|colour|logo_url + revoke on
   unmount) is easy to regress into a fetch storm.
7. **Payments' silent validation failure** (plain `Error`, not `ValidationError`) is existing behaviour
   that must be carried over verbatim even though it is arguably a bug.
8. **Two divergent change-password implementations** (API vs supabase-js) must both survive.

---

## 11. Open questions

1. Is `/users` (the 17-line "coming soon" stub) intended to stay routed, or should it be dropped from
   the v2 route block? Nothing links to it and nothing tests it. Owner decision.
2. Is `/settings/organization` in scope for module 11 at all? It is a 1013-line unlinked legacy page
   whose only exclusive features are `number_padding` and `require_walkthrough_before_send`. Porting it
   costs roughly as much as the entire new Settings module.
3. `USER_CAPABILITIES` has 14 entries in the module file; the dialog test comment says "the full managed
   set (13 capabilities)". Which is authoritative - is one entry newly added and the comment stale?
4. The Locations delete path has no confirmation dialog while every other destructive action in the
   module does. Intentional, or a gap to preserve as-is during a presentation-only swap?
5. `SettingsLayout` renders an empty `<h1>` when the current path is not in the CASL-visible nav set.
   Should the v2 shell reproduce the blank title, or is a fallback title acceptable (that would be a
   behaviour change and needs sign-off)?
6. RolesPage's "+ New custom role (coming soon)" and UsersPage's "User management coming soon" are both
   dead copy. Carry them over verbatim, or drop them in v2?
7. `PaymentsListsPage` throws a plain `Error` on invalid deposit input, which the layout swallows. Fix
   in v2 (a behaviour change), or reproduce the silent failure?
8. Should the per-user permissions dialog surface the `effective` field the API already returns? It is
   currently fetched and discarded. Adding it is new behaviour.
