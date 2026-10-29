# Organization Settings Module — Design Spec (MVP)

**Date:** 2026-06-03
**Branch:** `servwave`
**Status:** Design + decisions APPROVED 2026-06-03 — spec finalized, ready for implementation plan.
**Approved prototype:** `prototype-v2.html` (visual companion) — this spec is the written form of that clickable design.
**Source research:** `Administration, Roles, and Permissions in Modern Field Service Management Platforms.md` (the "MD"). Every MD area is accounted for in §9 (Completeness Map); deferrals are explicit, not silent.

---

## 1. Purpose & Scope

ServWave needs a first-class **Settings** area where an org administrator manages the company profile, branding, locations, users & teams, **roles & permissions**, and login/security — without leaving the app shell.

The keystone is **Roles & Permissions**: the backend already ships a complete CASL RBAC engine (catalog, default grants, ability middleware, per-org `RolePermission` rows) but has **no management UI and no management endpoints**. This module exposes that engine.

**In scope (this implementation):** the six screens in the approved prototype, the settings shell (top-right user menu → platform sidebar → settings menu → content), and the backend endpoints they require.

**Out of scope (mapped to V2/Enterprise in §9):** business hours, service-area maps, SSO/SCIM, session/IP policies, an audit-log *screen* (audit data is still persisted — §8.6), billing, integrations marketplace, custom roles, field-level visibility.

---

## 2. Locked Foundational Decisions

These were settled during brainstorming and are not reopened here:

1. **Design system = servwave indigo.** No new palette. Tokens (confirmed from `frontend/tailwind.config.js` + `frontend/DESIGN.md`): primary `#4f46e5`, primary-subtle `#eef2ff`, background `#f8fafc`, surface `#ffffff`, text-primary `#0f172a`, text-secondary `#475569`, border `#e2e8f0`; semantic success/danger/warning/info `#10B981/#EF4444/#F59E0B/#3B82F6`; radius 12px cards / 6px inputs / pill; Cal.com 3-layer `shadow-card`; sidebar 240px, header 56px; Inter only.
2. **Entry point = top-right user menu.** Clicking the user's name in the header opens a dropdown: **My Profile · Settings · Log out**. "Settings" enters the settings area. (No settings group buried in the platform sidebar.)
3. **Nesting = platform sidebar → settings menu → content.** The platform's own left sidebar stays visible (it is the app shell). Settings renders a *second* menu column to its right, then the content pane. A sub-bar above the content holds the breadcrumb (`Settings › <Screen>`) and **Discard / Save Changes / ✕**.
4. **Settings menu groups (final):**
   - **ORGANIZATION** — Company Profile · Branding & Templates · Locations
   - **PEOPLE & ACCESS** — Users & Teams · Roles & Permissions · Login & Security
   - (No "Automations" group — email templates are not part of Settings.)

---

## 3. Architecture & Information Architecture

### 3.1 Frontend shell
- Settings is a **nested route** under the existing authenticated `AppLayout`, so the platform sidebar and header persist. A new `SettingsLayout` renders the settings menu + sub-bar + `<Outlet/>`.
- Routes:
  - `/settings/company` → Company Profile
  - `/settings/branding` → Branding & Templates
  - `/settings/locations` → Locations
  - `/settings/users` → Users & Teams
  - `/settings/roles` → Roles & Permissions
  - `/settings/security` → Login & Security
  - `/settings` redirects to `/settings/company`.
- **Header user menu:** add a dropdown to the existing header (`My Profile` → `/settings/security` or a profile page [profile page = V2 stub], `Settings` → `/settings/company`, `Log out` → existing logout). The existing sidebar "Settings & Admin" footer dropdown is **retired** (entry now lives top-right — §10.5).
- **Menu visibility is CASL-filtered.** Each settings menu item declares an `(action, subject)`; it renders only if `ability.can(action, subject)`. Mapping in §6.5.
- **Save model:** each screen owns a React Hook Form + Zod form. The sub-bar's **Save Changes** submits the active screen's form (PATCH); **Discard** resets to last-loaded values; **✕** leaves settings (back to dashboard). Switching screens or hitting ✕ with a dirty form prompts an unsaved-changes guard.

### 3.2 Component boundaries (one job each)
| Unit | Responsibility | Depends on |
|------|----------------|-----------|
| `SettingsLayout` | menu + sub-bar + dirty-guard + outlet | CASL ability, router |
| `CompanyProfilePage` | org identity/contact/localization/address form | `useOrganization`, `useUpdateOrganization` |
| `BrandingPage` | logo + brand color (Identity tab); template + live preview (Documents tab) | org hooks, `useOrgLogoUpload`, `previewPdf` |
| `LocationsPage` | branch table + edit panel | `useLocations` CRUD hooks |
| `UsersTeamsPage` | users table (tab) + teams cards→members (tab) | `useUsers`, `useDepartments` |
| `RolesPage` | role list + permission matrix + data scope + general | `useRoles`, `useRolePermissions` |
| `SecurityPage` | 2FA toggles + change password | `useOrgSecurity`, Supabase auth |

Each page is independently testable; the layout knows nothing of a screen's internals beyond "it exposes a form with submit/reset/isDirty."

### 3.3 Backend shape
- Controllers stay thin and **multi-tenant**: every query/mutation spreads `tenantWhere(req)` (org scoping) and is guarded by `canDo(action, subject)`.
- Reuse existing: `GET/PATCH /api/organization`, `POST /api/organization/logo`, `GET /api/organization/preview-pdf`, `GET/POST/PATCH/DELETE /api/users` (+ `/staff`, `/:id/invite`), `GET/PATCH /api/settings/:key`, department endpoints.
- New: **Locations CRUD** and **Roles/Permissions read+write** (§6).

### 3.4 Data flow (one screen, end-to-end)
`Top-right menu → /settings/roles → RolesPage → useRolePermissions(role) → GET /api/roles/:role/permissions (canDo('read','Role') + tenantWhere) → controller assembles UI view-model from PERMISSION_CATALOG + RolePermission rows → toggles render → user edits → Save → PUT /api/roles/:role/permissions → controller diffs to RolePermission upserts/deletes → clearPermissionCache(org) → 200 → query invalidates.`

---

## 4. Screen Specs

### 4.1 Company Profile (`/settings/company`) — MVP
Mirrors MD §1.1 (General, Contact, Address, Regulatory). **Deviation:** Customer Types removed (user: redundant in ServWave). The screen has **two tabs: Profile and Numbering.**

**Profile tab:**
- **Identity hero card:** logo tile, company name + Active badge, DBA + ORG id, chips (industry, timezone), inline "Tax ID needs reverification" warning when applicable, "Replace logo".
- **General & Legal:** Company Name*, Display/DBA Name, Legal Entity Name, EIN/Tax ID, Business Type (select), Industry/Trade (multi-select).
- **Contact:** Primary Phone, Support Email, Billing Email, Website.
- **Localization & Defaults:** Time Zone, Currency, Date Format, Country.
- **Addresses:** Headquarters (street, suite, city, state, ZIP, country) + a "Mailing address same as HQ" toggle. **Toggling it off reveals a full separate Mailing Address block** (street, suite, city, state, ZIP, country); toggling on hides it. The mailing fields persist only when the toggle is off.

**Numbering tab — "Identifiers & Numbering"** (its own tab, not a scroll-down card — per user). Per-org document numbering, preserving today's functionality:
- A row per document type — **Customers (C), Leads (L), Estimates (E), Jobs (J), Invoices (I)** — each with an editable **Prefix**, **Next number**, and a **live Preview** (`prefix + next`).
- **No padding control** (removed per user — it conflicted with a freely-typed next number). The **Next number field carries its own width**: entering `00001` previews `C00001`; entering `3243265` previews `C3243265`. What you type is what gets issued.
- Note: a prefix **locks once the first document of that type is issued** (mirrors existing `*_first_issued_at`).

**New Organization columns required** (most profile fields already exist — see §5): `display_name`, `legal_name`(exists), `tax_id`, `business_type`, `industry` (Json/string[]), `support_email`, `billing_email`, `timezone`, `currency`, `date_format`, `mailing_same_as_hq` (bool, default true), `mailing_address_line1/line2/city/state/postal_code/country`.

### 4.2 Branding & Templates (`/settings/branding`) — MVP
Two tabs (MD §1.4; typography + email templates removed per user).
- **Brand Identity:** Company Logo (upload, constraints, preview) + Brand Color (hex + auto-generated palette swatches).
- **Document Templates:** template selector (Alpha Classic ✓ / CRM Default) **with the Live Preview stacked directly below** (Invoice/Estimate toggle). Backed by existing `estimate_template` + `GET /api/organization/preview-pdf`.

### 4.3 Locations (`/settings/locations`) — MVP
MD §1.2 (single-/multi-branch; service-area maps deferred to V2 per user — right-card coverage UI removed).
- Branch table: Branch (name + code), Address, Time Zone, Manager, Staff count. Row-click loads the **Edit Branch** panel (name, street, city, state, time zone, phone, manager). "+ New Location".
- **New backend:** org-level `Location` model + CRUD (§5, §6.2). (Existing `ServiceLocation` is customer-scoped and unrelated.)

### 4.4 Users & Teams (`/settings/users`) — MVP
MD §2.1 + §2.2. Two tabs.
- **Users:** table (Name, Email, Role, Team, Status, Last Login, Edit) with status filter chips and "+ Invite User". "No login" staff badge supported (existing `has_login`). Backed by existing user endpoints.
- **Teams:** clickable team cards → members list (avatar, role, Remove, + Add Member). **Teams map to the existing `Department` model** (label "Teams" in UI). Team→location and team→members read from `Department.users`.

### 4.5 Roles & Permissions (`/settings/roles`) — MVP — **keystone**
MD §2.3 + §2.4 + §3. Data-driven over the existing CASL engine.
- **Roles list (left):** all roles shown in the prototype, with assigned-user counts. **Owner & Admin are full-access, non-reducible** (shown all-on so an org cannot accidentally lock itself out). In MVP **"Owner" is backed by the existing `ADMIN` enum value** (Owner = the org's primary administrator); a distinct `OWNER` enum value + billing/account-closure powers are a fast-follow. **Sales / Dispatcher / Technician are fully editable** — permission matrix **and** data scope. "+ New custom role" remains a **V2 placeholder** (arbitrary custom roles need a `User.role` enum→string migration).
- **Permissions tab:** matrix of **6 modules** (Customers, Leads, Estimates, Jobs, Invoices, Inventory) × **View/Create/Edit/Delete** toggles, plus a **Sensitive** section: **See financial data** · **Record & refund payments**. (Run payroll removed entirely — no payroll module.) Each toggle maps to catalog `(action, subject)` entries (§6.4).
- **Data Scope tab:** **all 6 entities** (Jobs, Customers, Leads, Estimates, Invoices, Inventory) × **Owned / Team / Location / All** — **all four chips ship for every editable role.** Maps to grant `conditions`: Owned=`{...:'{{userId}}'}`, Team=`{{teamId}}`, Location=`{{locationId}}`, All=no condition. This requires extending `substituteConditions` with `{{teamId}}`/`{{locationId}}` tokens (§6.4) — included in this implementation, not deferred.
- **General tab:** role name, type, description.
- **"Reset to default":** re-applies `DEFAULT_GRANTS` for that role (§6.3).

### 4.6 Login & Security (`/settings/security`) — MVP (scoped)
MD §4.1 only. Stripped per user.
- **Two-Factor Authentication:** Text Message (SMS) toggle + Email Verification toggle. Persist as org policy (§5). Actual enrollment/enforcement is **Supabase Auth-dependent** — see §7.
- **Change Password:** current / new / confirm → Supabase `auth.updateUser`. No SSO, no session/IP policy, no audit screen (all deferred).

---

## 5. Data Model Changes

**Already present (no change):** `Organization` (name, legal_name, address, email, phone, website, logo_url, brand_color, estimate_template + numbering fields), `User` (role, is_active, has_login, department_id, organization_id), `Department`, `AppSetting`, `RolePermission` (org/role/action/subject/conditions, unique `(org,role,action,subject)`), `Role` enum, `TimelineEvent` (polymorphic — reused for audit §8.6).

**New / changed:**
1. **`Organization` — add columns** (§4.1): `display_name`, `tax_id`, `business_type`, `industry`, `support_email`, `billing_email`, `timezone`, `currency`, `date_format`, `mailing_same_as_hq`, mailing address block, and security policy flags `mfa_sms_enabled` (bool, default false), `mfa_email_enabled` (bool, default false).
2. **`Location` — new model** (org-level branch): `id`, `organization_id`, `name`, `code`, `address_line1/2`, `city`, `state`, `postal_code`, `country`, `timezone`, `phone`, `manager_id` (→User, nullable), timestamps. `@@unique([organization_id, code])`, `@@index([organization_id])`. Add **`User.location_id` (nullable)** now — it is the source for the `{{locationId}}` data-scope token; `Department.id` is the source for `{{teamId}}` (Team = Department). Both are needed this round since Location/Team scope ships (§4.5).
3. **Numbering (no-regress, padding removed):** keep `*_next_number` (int) and `*_prefix`. The UI's Next-number field is a zero-padded string; on save, store `number_padding = length(string)` and `next_number = parseInt(string)`. The existing `allocateNumber` allocator already left-pads to `number_padding`, so display is preserved (`C00001`) without exposing a padding control. `*_first_issued_at` lock unchanged.
4. **No new model for roles** — `RolePermission` already holds per-org grants; we add endpoints, not schema.

All new tables/columns are **org-scoped** and follow §3.1 multi-tenancy. Migrations use `DIRECT_URL` (5432) per CLAUDE.md; never run `migrate deploy` from a worktree against staging (known gotcha).

---

## 6. New Backend Endpoints

All guarded by `canDo(...)` + `tenantWhere(req)`; all writes call `clearPermissionCache(org)` when they touch grants.

### 6.1 Company Profile / Branding / Security
- Extend existing `PATCH /api/organization` Zod schema with the new §5.1 fields (profile + `mfa_*` flags). No new route.
- Reuse `POST /api/organization/logo`, `GET /api/organization/preview-pdf`.
- Change password: frontend calls Supabase client directly (`auth.updateUser`), or a thin `POST /api/auth/change-password` wrapper — **choose in plan** (prefer direct Supabase to avoid handling raw passwords server-side).

### 6.2 Locations
- `GET /api/locations` — `canDo('read','Location')`
- `POST /api/locations` — `canDo('create','Location')` + Zod
- `PATCH /api/locations/:id` — `canDo('update','Location')` + Zod
- `DELETE /api/locations/:id` — `canDo('delete','Location')` (block/relink if users reference it)

### 6.3 Roles
- `GET /api/roles` — list enum roles + `{ assignedUserCount, type:'system' }`. `canDo('read','Role')`.
- `GET /api/roles/:role/permissions` — assemble UI view-model (matrix + sensitive + scope + general) from `PERMISSION_CATALOG` ⨯ `RolePermission` rows. ADMIN returns synthetic all-on/read-only. `canDo('read','Role')`.
- `PUT /api/roles/:role/permissions` — accept the view-model, translate to the target grant set, **diff against existing `RolePermission` rows** (insert new, delete removed, update changed conditions), reject edits to ADMIN. `canDo('update','Role')`. Then `clearPermissionCache(org)`.
- `POST /api/roles/:role/reset` — delete org rows for role, re-insert `DEFAULT_GRANTS.filter(role)`, clear cache. `canDo('update','Role')`.

### 6.4 Catalog ↔ UI mapping (the crux)
The UI shows a **simplified view-model**, not the 121 raw catalog entries. The mapping table (module/CRUD-cell → catalog `(action,subject)`; sensitive toggle → catalog entries; scope chip → grant `conditions`) is the single most important deliverable and **must be defined explicitly in the implementation plan**, derived from the real catalog:
- **CRUD cells:** `View→read`, `Create→create`, `Edit→update`, `Delete→delete` on subjects `Customer/Lead/Estimate/Job/Invoice/Inventory`.
- **Sensitive (two toggles only):** "See financial data" (cost/margin visibility — map to the catalog's financial-read entries) and "Record & refund payments" (`record_payment` + `refund`/`refund_deposit` on Invoice/Estimate). **No "Run payroll"** — removed.
- **Data scope:** chip → `conditions`. **Owned** = existing condition templates (e.g. `{ assigned_to: '{{userId}}' }`, `OWN_JOB_VIA_ESTIMATE`). **All** = `null`. **Team** = `{{teamId}}` (resolves to the user's `department_id`). **Location** = `{{locationId}}` (resolves to the user's `location_id`). **This requires extending `substituteConditions`** (today only `{{userId}}`) to support `{{teamId}}` and `{{locationId}}`, sourced from `req.user`. The middleware that builds `req.user` must include `department_id` and `location_id`. All four chips ship.

### 6.5 Catalog additions
Add subjects/entries to `PERMISSION_CATALOG` (and `Subject` type) so the settings module itself is guardable:
- `Location` (read/create/update/delete) and `Role` (read/update). ADMIN's `manage all` already covers them; add `read Location` to DISPATCHER defaults if branches should be visible to dispatch (confirm). These also drive §3.1 menu-item CASL filters.

---

## 7. External Dependencies & Honest Constraints
- **2FA / password:** Supabase Auth owns credentials and MFA enrollment. MVP toggles persist **org policy intent**; true enforcement (requiring MFA at login) depends on Supabase capabilities/config and may be partial. The spec ships the policy surface + change-password; full enforcement is tracked separately. *No overclaiming.*
- **Team/Location data scope:** ships this round — requires extending `substituteConditions` with `{{teamId}}`/`{{locationId}}` and ensuring `req.user` carries `department_id` + `location_id` (§6.4). Team = `Department`; Location = new `Location` model + `User.location_id`.
- **Distinct `OWNER` enum + arbitrary custom roles:** deferred (need `User.role` enum→string migration + owner-assignment logic). MVP shows "Owner" backed by `ADMIN`; "+ New custom role" is a placeholder.

---

## 8. Cross-Cutting Requirements
1. **Multi-tenancy:** every new query/mutation spreads `tenantWhere(req)`; new models carry `organization_id`.
2. **CASL guards everywhere:** controllers use `canDo`; UI hides/disables via `ability.can`. Replace the legacy `isAdmin` checks in `OrganizationSettingsPage` with CASL.
3. **TDD (backend):** per CLAUDE.md, write tests first — multi-tenant isolation tests for Locations & Roles endpoints; permission-matrix assembly tests; reset-to-default test; "ADMIN cannot be edited" test; org-profile extended-field validation tests.
4. **Frontend checks:** `npx tsc --noEmit`; component tests for the settings shell (menu nav, dirty-guard) and the data-driven Roles screen; an E2E that walks all six screens.
5. **Refactor in place:** decompose the monolithic `OrganizationSettingsPage` into `CompanyProfilePage` + `BrandingPage` + `LocationsPage` + the Users/Teams split; do not leave a parallel old page. Targeted, not speculative.
6. **Audit persistence (no screen):** on settings mutations (org profile change, role permission change, location change) write a `TimelineEvent`/audit row (actor, org, entity, before/after where cheap). Satisfies the MD's audit intent and the user's "we save it in DB" — **without** an audit-log screen.

---

## 9. MD Completeness Map (nothing silently dropped)

| MD area | Stage in MD | This module | Notes |
|---|---|---|---|
| §1.1 Company Profile | MVP | ✅ MVP (§4.1) | Customer Types intentionally removed |
| §1.2 Locations & Service Areas | MVP / V2 | ✅ branches MVP; service-area maps **V2** | coverage map removed per user |
| §1.3 Business Hours & Holidays | MVP | ⏸ **Deferred V2** | scheduling not yet wired; explicit gap |
| §1.4 Branding | MVP | ✅ MVP (§4.2) | typography + email templates removed |
| §2.1 Users | MVP | ✅ MVP (§4.4) | reuses existing endpoints |
| §2.2 Teams | MVP | ✅ MVP via `Department` | label "Teams" |
| §2.3 Roles & Permissions | MVP | ✅ MVP (§4.5) | keystone; custom roles V2 |
| §2.4 Permission Scope / Field Visibility | MVP / Enterprise | ✅ full data scope MVP (Owned/Team/Location/All); field-level **Enterprise** | all 4 scopes ship |
| §3 Permissions Model | MVP→Enterprise | ✅ feature+record(owned/all) MVP | grounded in CASL |
| §4.1 Auth & MFA | MVP | ✅ scoped (§4.6) | Supabase-dependent (§7) |
| §4.2 SSO/SCIM | Enterprise | ⏸ **Enterprise** | — |
| §4.3 Session/Device/IP | V2/Enterprise | ⏸ **Deferred** | — |
| §4.4 Audit Logs | V2 | ⏸ **No screen**; data persisted (§8.6) | user decision |
| §5 Billing & Subscription | MVP (MD) | ⏸ **Out of scope** | ServWave billing model TBD |
| §6 Integrations & API | MVP/V2 | ⏸ **Deferred** | Stripe partly in org already |
| Admin dashboard (§UX) | — | ⏸ **Deferred** | — |

---

## 10. Resolved Decisions (2026-06-03)
1. **"Owner" role:** keep all prototype roles; Owner & Admin are full-access/non-reducible. For MVP **Owner is backed by `ADMIN`** (no enum migration); distinct `OWNER` + billing powers = fast-follow. Sales/Dispatcher/Technician fully editable.
2. **Data scope:** **ship all four chips (Owned/Team/Location/All) for every editable role** — build `{{teamId}}`/`{{locationId}}` token support now (not deferred).
3. **"Run payroll":** **removed entirely** from the Sensitive section.
4. **Numbering:** lives in its **own "Numbering" tab on Company Profile**; the **padding control is removed** (next-number field carries its own width).
5. **Sidebar gear:** **retire** the existing "Settings & Admin" sidebar footer dropdown — entry now lives in the top-right user menu.
6. **Mailing address:** the "same as HQ" toggle, when off, **reveals a real separate mailing-address block**.

---

## 11. Success Criteria
- An admin reaches Settings from the top-right user menu and navigates all six screens within the persistent app shell.
- Company Profile, Branding, Locations, Users/Teams persist and reload correctly, org-scoped.
- The Roles screen shows **real, effective** permissions per role (defaults + overrides). Sales/Dispatcher/Technician edits persist as `RolePermission` rows; Owner/Admin stay full-access/non-reducible; "Reset to default" works; a changed role's new abilities take effect after cache invalidation. Team/Location data scope actually filters records (token substitution proven by tests).
- All new endpoints enforce tenant isolation + CASL (proven by tests).
- No regression: existing org-profile and numbering functionality still available (numbering now under the Numbering tab; numbers still issue zero-padded, e.g. `C00001`).
- Every MD area is either built or explicitly deferred per §9.
