# Organization Settings Module — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship the Organization Settings module (6 screens + settings shell) over ServWave's existing CASL engine, exposing per-org role/permission management, org-level Locations, an extended company profile, and login/security — fully multi-tenant, CASL-guarded, and TDD-backed.

**Architecture:** A nested `/settings/*` route under the existing `AppLayout` renders a `SettingsLayout` (settings menu + sub-bar + dirty-guard + `<Outlet/>`). Backend stays thin/multi-tenant: extend the org PATCH, add Locations CRUD and Roles read/write endpoints that translate a simplified UI view-model to/from `RolePermission` rows over the real `PERMISSION_CATALOG`. Data-scope (Owned/Team/Location/All) is delivered by extending the condition-substitution engine with `{{teamId}}`/`{{locationId}}` tokens and threading `department_id`/`location_id` onto `req.user`.

**Tech Stack:** Backend — Node 20, Express, TypeScript, Prisma, Vitest (mocked Prisma), `@casl/ability` + `@casl/prisma`. Frontend — React 18, Vite, Tailwind, shadcn/ui, TanStack Query, Zustand, React Hook Form + Zod, Playwright.

**Spec:** `md_files/specs/settings/2026-06-03-organization-settings-design.md` (APPROVED). Prototype: `.superpowers/brainstorm/44555-1780491647/content/prototype-v2.html` (visual source of truth — reference it for exact field layout/copy).

**Worktree / branch:** `../alpha_crm-worktrees/org-settings` on `feat/org-settings` (off `servwave`). `.env` → **staging** DB.

---

## ⚠️ Operating Constraints (read once, obey throughout)

1. **NEVER run `prisma migrate dev` / `prisma migrate deploy` from this worktree.** Local `.env` points at the **staging** Supabase DB; a migrate would mutate staging schema (documented incident). Schema changes ship as: edit `schema.prisma` → `npx prisma generate` (no DB connection) → author the migration SQL file via `prisma migrate diff` (no DB connection). Applying the migration to staging/prod is a **separate deploy step the user controls** — flagged at handoff.
2. **Backend tests are fully mocked Prisma** (`backend/src/__tests__/setup.ts`). No test touches a real DB. New tests follow the existing mock pattern (`mockAuthAs`, `authHeader`, `vi.fn().mockResolvedValue(...)`).
3. **No AI attribution in git.** Conventional commit lines only.
4. **TDD for all backend** (CLAUDE.md): failing test → minimal impl → green → commit.
5. **Multi-tenancy:** every new query/mutation spreads `tenantWhere(req)`; every new model carries `organization_id`.
6. **Commit frequently** at the granularity the steps specify. All work on `feat/org-settings`.

---

## Reconciliations (spec vs. real codebase — decided, not silent)

| Topic | Spec intent | Grounded decision in this plan |
|---|---|---|
| **"Owner" role** | Owner & Admin full-access, Owner backed by `ADMIN` | `Role` enum has no `OWNER`. `GET /api/roles` returns the 4 enum roles; **`ADMIN` is displayed as "Administrator (Owner)"** and is non-reducible. A distinct `OWNER` enum + billing powers = fast-follow. No fabricated backend role. |
| **Numbering padding** | Remove padding control; next-number field carries its own width | Keep the existing **global** `number_padding` column **unchanged and hidden**. Preview = `prefix + String(next).padStart(number_padding,'0')`; save sends `*_next_number` ints + prefixes via existing `PATCH /api/organization`. No numbering schema change. `padStart` already yields `C00001` and passes through `C3243265`. |
| **"See financial data"** sensitive toggle | "map to financial-read entries" | Map to **`read Report`** (the real financial/analytics subject). Documented; a finer cost/margin permission is a catalog fast-follow. |
| **Data scope on all 6 entities** | All 4 chips for every entity | `Lead`/`Job` (direct `assigned_to`), `Estimate` (via `lead`), `Invoice` (via `job`) support all 4 scopes. **`Customer`/`Inventory` have no ownership field** → chips render but Owned/Team/Location are **disabled with a tooltip**; only `All` is effective. The token engine still ships fully. |
| **Audit screen** | No screen; persist data | Write a `TimelineEvent` row on settings mutations (`entity_type='OrganizationSettings'`, `entity_id = org.id`, detail in `metadata`). No screen. |

---

## File Structure (created/modified)

**Backend — create:**
- `backend/src/lib/permissions/roleViewModel.ts` — pure mapping: UI view-model ⇄ grant set (the crux)
- `backend/src/controllers/location.controller.ts`
- `backend/src/routes/location.routes.ts`
- `backend/src/controllers/role.controller.ts`
- `backend/src/routes/role.routes.ts`
- `backend/src/lib/audit.ts` — `writeSettingsAudit()` helper
- `backend/src/__tests__/locations.test.ts`, `roles.test.ts`, `substitute-conditions.test.ts`, `role-view-model.test.ts`, `organization-profile.test.ts`

**Backend — modify:**
- `backend/prisma/schema.prisma` — Organization columns, new `Location` model, `User.location_id`
- `backend/src/lib/permissions/substituteConditions.ts` — context object + new tokens
- `backend/src/lib/permissions/defineAbility.ts` — thread dept/location
- `backend/src/lib/permissions/catalog.ts` — add `Location` + `Role` subjects & entries
- `backend/src/lib/permissions/defaultGrants.ts` — (optional) DISPATCHER `read Location`
- `backend/src/middleware/authenticate.ts` — select + carry `department_id`, `location_id`
- `backend/src/middleware/attachAbility.ts` — (no change needed; passes `req.user` through) — verify only
- `backend/src/types/express.d.ts` — req.user gains `department_id`, `location_id`
- `backend/src/controllers/organization.controller.ts` — extend `patchOrgSchema` + write new fields
- `backend/src/controllers/auth.controller.ts` — `me()` select dept/location for rule-building
- `backend/src/app.ts` — mount `/api/locations`, `/api/roles`

**Frontend — create:**
- `frontend/src/pages/settings/SettingsLayout.tsx`
- `frontend/src/pages/settings/CompanyProfilePage.tsx`
- `frontend/src/pages/settings/BrandingPage.tsx`
- `frontend/src/pages/settings/LocationsPage.tsx`
- `frontend/src/pages/settings/UsersTeamsPage.tsx`
- `frontend/src/pages/settings/RolesPage.tsx`
- `frontend/src/pages/settings/SecurityPage.tsx`
- `frontend/src/lib/api/locations.ts`, `roles.ts`
- `frontend/src/components/ui/alert-dialog.tsx` (shadcn add — dirty guard)
- `frontend/e2e/specs/settings.spec.ts`, `frontend/e2e/pages/settings.page.ts`

**Frontend — modify:**
- `frontend/src/lib/ability.ts` — add `Location`, `Role` to `AppSubject`
- `frontend/src/App.tsx` — nested `/settings/*` routes
- `frontend/src/components/layout/Header.tsx` — user menu items
- `frontend/src/components/layout/Sidebar.tsx` + `nav-config.ts` — retire gear dropdown
- `frontend/src/lib/api/organization.ts` — extend `Organization`/`OrgFormValues` types

---

# PHASE 0 — Schema foundation

### Task 0.1: Extend Prisma schema (Organization columns, Location model, User.location_id)

**Files:**
- Modify: `backend/prisma/schema.prisma`

- [ ] **Step 1: Add new Organization columns.** In `model Organization`, after the existing `default_inventory_location_id` line, add:

```prisma
  // Org Settings — extended company profile
  display_name             String?  @db.VarChar(200)
  tax_id                   String?  @db.VarChar(50)
  business_type            String?  @db.VarChar(50)
  industry                 Json     @default("[]")
  support_email            String?  @db.VarChar(200)
  billing_email            String?  @db.VarChar(200)
  timezone                 String?  @db.VarChar(64)
  currency                 String   @default("USD") @db.VarChar(3)
  date_format              String   @default("MM/DD/YYYY") @db.VarChar(20)
  mailing_same_as_hq       Boolean  @default(true)
  mailing_address_line1    String?  @db.VarChar(200)
  mailing_address_line2    String?  @db.VarChar(200)
  mailing_city             String?  @db.VarChar(100)
  mailing_state            String?  @db.VarChar(50)
  mailing_postal_code      String?  @db.VarChar(20)
  mailing_country          String?  @db.VarChar(2)
  mfa_sms_enabled          Boolean  @default(false)
  mfa_email_enabled        Boolean  @default(false)
```

Also add the back-relation (inside Organization, near the other relations): `locations  Location[]`

- [ ] **Step 2: Add `Location` model.** After the `Department` model add:

```prisma
model Location {
  id              String   @id @default(uuid()) @db.Uuid
  organization_id String   @db.Uuid
  name            String   @db.VarChar(120)
  code            String   @db.VarChar(20)
  address_line1   String?  @db.VarChar(200)
  address_line2   String?  @db.VarChar(200)
  city            String?  @db.VarChar(100)
  state           String?  @db.VarChar(50)
  postal_code     String?  @db.VarChar(20)
  country         String?  @default("US") @db.VarChar(2)
  timezone        String?  @db.VarChar(64)
  phone           String?  @db.VarChar(50)
  manager_id      String?  @db.Uuid
  created_at      DateTime @default(now())
  updated_at      DateTime @updatedAt

  organization    Organization @relation(fields: [organization_id], references: [id], onDelete: Cascade)
  manager         User?        @relation("LocationManager", fields: [manager_id], references: [id], onDelete: SetNull)
  members         User[]       @relation("UserLocation")

  @@unique([organization_id, code])
  @@index([organization_id])
  @@map("locations")
}
```

- [ ] **Step 3: Add `location_id` to User.** In `model User`, after `department_id` add:

```prisma
  location_id                 String?         @db.Uuid
```

and add the two relations inside User (after the `department` relation line):

```prisma
  location                    Location?       @relation("UserLocation", fields: [location_id], references: [id], onDelete: SetNull)
  managed_locations           Location[]      @relation("LocationManager")
```

and the index near User's other `@@index` lines: `@@index([location_id])`

- [ ] **Step 4: Validate + regenerate client (NO DB connection).**

Run (from `backend/`): `npx prisma validate && npx prisma generate`
Expected: "The schema at prisma/schema.prisma is valid" then "Generated Prisma Client".

- [ ] **Step 5: Author migration SQL without touching the DB.**

Run (from `backend/`):
```bash
mkdir -p prisma/migrations/20260603120000_org_settings
npx prisma migrate diff \
  --from-migrations prisma/migrations \
  --to-schema-datamodel prisma/schema.prisma \
  --script > prisma/migrations/20260603120000_org_settings/migration.sql
```
Open the generated `migration.sql` and confirm it only ADDs columns/table/index (no drops of existing data). It must NOT be applied here.

- [ ] **Step 6: Commit.**

```bash
git add backend/prisma/schema.prisma backend/prisma/migrations/20260603120000_org_settings
git commit -m "feat(settings): extend schema with org profile fields, Location model, User.location_id"
```

> **Handoff note (record in final summary):** migration `20260603120000_org_settings` is authored but UNAPPLIED. Apply to staging then prod via the normal deploy pipeline (DIRECT_URL, port 5432). Do not apply from a worktree.

---

# PHASE 1 — Permissions engine extensions (TDD)

### Task 1.1: Extend `substituteConditions` with `{{teamId}}` / `{{locationId}}`

**Files:**
- Modify: `backend/src/lib/permissions/substituteConditions.ts`
- Test: `backend/src/__tests__/substitute-conditions.test.ts`

- [ ] **Step 1: Write the failing test.**

```typescript
import { describe, it, expect } from 'vitest';
import { substituteConditions } from '../lib/permissions/substituteConditions';

const ctx = { userId: 'u1', teamId: 't1', locationId: 'l1' };

describe('substituteConditions', () => {
  it('substitutes userId (back-compat)', () => {
    expect(substituteConditions({ assigned_to: '{{userId}}' }, ctx))
      .toEqual({ assigned_to: 'u1' });
  });
  it('substitutes teamId and locationId in nested relations', () => {
    expect(substituteConditions({ assigned_user: { department_id: '{{teamId}}' } }, ctx))
      .toEqual({ assigned_user: { department_id: 't1' } });
    expect(substituteConditions({ assigned_user: { location_id: '{{locationId}}' } }, ctx))
      .toEqual({ assigned_user: { location_id: 'l1' } });
  });
  it('substitutes null when team/location absent', () => {
    expect(substituteConditions({ assigned_user: { department_id: '{{teamId}}' } }, { userId: 'u1', teamId: null, locationId: null }))
      .toEqual({ assigned_user: { department_id: null } });
  });
  it('returns undefined for null conditions', () => {
    expect(substituteConditions(null, ctx)).toBeUndefined();
  });
  it('throws on unknown token', () => {
    expect(() => substituteConditions({ x: '{{nope}}' }, ctx)).toThrow(/Unknown token/);
  });
});
```

- [ ] **Step 2: Run it — expect FAIL** (signature mismatch / new tokens unsupported).

Run (from `backend/`): `npx vitest run src/__tests__/substitute-conditions.test.ts`
Expected: FAIL.

- [ ] **Step 3: Implement.** Replace the file contents with:

```typescript
export interface SubstitutionContext {
  userId: string;
  teamId?: string | null;
  locationId?: string | null;
}

export function substituteConditions(
  conditions: Record<string, unknown> | null | undefined,
  ctx: SubstitutionContext,
): Record<string, unknown> | undefined {
  if (conditions == null) return undefined;
  return walk(conditions, ctx) as Record<string, unknown>;
}

function walk(value: unknown, ctx: SubstitutionContext): unknown {
  if (typeof value === 'string') {
    if (value === '{{userId}}') return ctx.userId;
    if (value === '{{teamId}}') return ctx.teamId ?? null;
    if (value === '{{locationId}}') return ctx.locationId ?? null;
    if (/\{\{[^}]+\}\}/.test(value)) throw new Error(`Unknown token in condition: ${value}`);
    return value;
  }
  if (Array.isArray(value)) return value.map((v) => walk(v, ctx));
  if (value !== null && typeof value === 'object') {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      out[k] = walk(v, ctx);
    }
    return out;
  }
  return value;
}
```

- [ ] **Step 4: Run it — expect PASS.** `npx vitest run src/__tests__/substitute-conditions.test.ts` → PASS.

- [ ] **Step 5: Commit.**

```bash
git add backend/src/lib/permissions/substituteConditions.ts backend/src/__tests__/substitute-conditions.test.ts
git commit -m "feat(permissions): support {{teamId}}/{{locationId}} tokens in condition substitution"
```

---

### Task 1.2: Thread `department_id`/`location_id` onto `req.user` and into `defineAbilityFor`

**Files:**
- Modify: `backend/src/types/express.d.ts`, `backend/src/middleware/authenticate.ts`, `backend/src/lib/permissions/defineAbility.ts`, `backend/src/controllers/auth.controller.ts`
- Test: `backend/src/__tests__/define-ability-scope.test.ts`

- [ ] **Step 1: Write the failing test.**

```typescript
import { describe, it, expect } from 'vitest';
import { defineAbilityFor } from '../lib/permissions/defineAbility';

describe('defineAbilityFor — team/location scope', () => {
  const user = { id: 'u1', role: 'SALES', department_id: 'team-9', location_id: 'loc-3' };

  it('bakes teamId into a relation condition', () => {
    const ability = defineAbilityFor(user, [
      { action: 'read', subject: 'Job', conditions: { assigned_user: { department_id: '{{teamId}}' } } },
    ]);
    const rule = ability.rules.find((r) => r.subject === 'Job');
    expect(rule?.conditions).toEqual({ assigned_user: { department_id: 'team-9' } });
  });

  it('bakes locationId into a relation condition', () => {
    const ability = defineAbilityFor(user, [
      { action: 'read', subject: 'Job', conditions: { assigned_user: { location_id: '{{locationId}}' } } },
    ]);
    const rule = ability.rules.find((r) => r.subject === 'Job');
    expect(rule?.conditions).toEqual({ assigned_user: { location_id: 'loc-3' } });
  });

  it('still substitutes userId when dept/location omitted', () => {
    const ability = defineAbilityFor({ id: 'u1', role: 'SALES' }, [
      { action: 'read', subject: 'Lead', conditions: { assigned_to: '{{userId}}' } },
    ]);
    const rule = ability.rules.find((r) => r.subject === 'Lead');
    expect(rule?.conditions).toEqual({ assigned_to: 'u1' });
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/__tests__/define-ability-scope.test.ts`.

- [ ] **Step 3a: Update `defineAbility.ts`.** Change the `user` param type and the substitution call:

```typescript
export function defineAbilityFor(
  user: { id: string; role: string; department_id?: string | null; location_id?: string | null },
  grants: Grant[],
): AppAbility {
  const { can, build } = new AbilityBuilder<AppAbility>(createPrismaAbility);

  if (user.role === 'ADMIN') {
    can('manage', 'all' as Subject);
  } else {
    for (const grant of grants) {
      const conds = substituteConditions(
        grant.conditions as Record<string, unknown> | null | undefined,
        { userId: user.id, teamId: user.department_id ?? null, locationId: user.location_id ?? null },
      );
      if (conds) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        can(grant.action as Action, grant.subject as Subject, conds as any);
      } else {
        can(grant.action as Action, grant.subject as Subject);
      }
    }
  }

  return build();
}
```

- [ ] **Step 3b: Update `express.d.ts`** req.user shape:

```typescript
      user?: {
        id: string;
        email: string;
        first_name: string;
        last_name: string;
        role: Role;
        organization_id: string;
        department_id?: string | null;
        location_id?: string | null;
      };
```

- [ ] **Step 3c: Update `authenticate.ts`** — extend the `CachedAuth.user` shape (add `department_id?: string|null; location_id?: string|null;`), add `department_id: true, location_id: true` to the `prisma.user.findUnique` select, and add both fields to the `authUser` object:

```typescript
    const authUser = {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      role: user.role,
      organization_id: user.organization_id,
      department_id: user.department_id,
      location_id: user.location_id,
    };
```

- [ ] **Step 3d: Update `auth.controller.ts` `me()`** so frontend rules carry scope. The handler uses `const user = req.user!;` and passes `user` to `defineAbilityFor` — `req.user` now includes dept/location, so **no code change is required** beyond confirming it compiles. (Verify `defineAbilityFor(user, grants)` still type-checks.)

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/__tests__/define-ability-scope.test.ts`.

- [ ] **Step 5: Regression — run the existing permissions suite.** `npx vitest run src/__tests__/permissions-parity.test.ts` → PASS (back-compat).

- [ ] **Step 6: Commit.**

```bash
git add backend/src/types/express.d.ts backend/src/middleware/authenticate.ts backend/src/lib/permissions/defineAbility.ts backend/src/__tests__/define-ability-scope.test.ts
git commit -m "feat(permissions): carry department_id/location_id on req.user and into ability scope"
```

---

### Task 1.3: Add `Location` + `Role` subjects to the catalog

**Files:**
- Modify: `backend/src/lib/permissions/catalog.ts`, `backend/src/lib/permissions/defaultGrants.ts`
- Test: `backend/src/__tests__/catalog-settings-subjects.test.ts`

- [ ] **Step 1: Write the failing test.**

```typescript
import { describe, it, expect } from 'vitest';
import { PERMISSION_CATALOG } from '../lib/permissions/catalog';
import { defineAbilityFor } from '../lib/permissions/defineAbility';

describe('catalog — settings subjects', () => {
  it('includes Location CRUD and Role read/update', () => {
    const has = (action: string, subject: string) =>
      PERMISSION_CATALOG.some((e) => e.action === action && e.subject === subject);
    expect(has('read', 'Location')).toBe(true);
    expect(has('create', 'Location')).toBe(true);
    expect(has('update', 'Location')).toBe(true);
    expect(has('delete', 'Location')).toBe(true);
    expect(has('read', 'Role')).toBe(true);
    expect(has('update', 'Role')).toBe(true);
  });
  it('ADMIN can manage Location and Role', () => {
    const ability = defineAbilityFor({ id: 'a', role: 'ADMIN' }, []);
    expect(ability.can('read', 'Location' as never)).toBe(true);
    expect(ability.can('update', 'Role' as never)).toBe(true);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/__tests__/catalog-settings-subjects.test.ts`.

- [ ] **Step 3a: Extend `Subject` union in `catalog.ts`** — add `'Location'` and `'Role'`:

```typescript
export type Subject =
  | 'Dashboard' | 'Customer' | 'Lead' | 'Estimate' | 'Job'
  | 'Invoice' | 'User' | 'Department' | 'PriceBook' | 'Tag'
  | 'Report' | 'Organization' | 'StateTaxRate' | 'AppSetting'
  | 'Attachment' | 'Walkthrough' | 'Inventory' | 'Communication'
  | 'Location' | 'Role' | 'all';
```

- [ ] **Step 3b: Add catalog entries** (append to the `PERMISSION_CATALOG` array, before the closing `]`):

```typescript
  { action: 'read',   subject: 'Location', description: 'View business locations/branches', category: 'Settings' },
  { action: 'create', subject: 'Location', description: 'Create locations',                  category: 'Settings' },
  { action: 'update', subject: 'Location', description: 'Edit locations',                     category: 'Settings' },
  { action: 'delete', subject: 'Location', description: 'Delete locations',                   category: 'Settings' },
  { action: 'read',   subject: 'Role',     description: 'View roles & permissions',           category: 'Settings' },
  { action: 'update', subject: 'Role',     description: 'Edit role permissions',              category: 'Settings' },
```

- [ ] **Step 3c: (optional, default ON) DISPATCHER may read Locations.** In `defaultGrants.ts`, add to the DISPATCHER block:

```typescript
{ role: 'DISPATCHER', action: 'read', subject: 'Location' },
```

> This makes the Locations settings item visible to Dispatchers. Roles management stays ADMIN-only (no `Role` grant for non-admins).

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/__tests__/catalog-settings-subjects.test.ts`.

- [ ] **Step 5: Commit.**

```bash
git add backend/src/lib/permissions/catalog.ts backend/src/lib/permissions/defaultGrants.ts backend/src/__tests__/catalog-settings-subjects.test.ts
git commit -m "feat(permissions): add Location and Role subjects to the catalog"
```

---

# PHASE 2 — Locations CRUD (TDD)

### Task 2.1: Location controller + Zod + routes

**Files:**
- Create: `backend/src/controllers/location.controller.ts`, `backend/src/routes/location.routes.ts`
- Modify: `backend/src/app.ts`
- Test: `backend/src/__tests__/locations.test.ts`

- [ ] **Step 1: Write the failing test** (isolation + CRUD, mirroring `tenant-isolation.test.ts` / `estimates.test.ts` patterns).

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ORG_B_ID } from './helpers';

const LOCATION_FIXTURE = {
  id: 'a0000000-0000-0000-0000-0000000000aa',
  organization_id: ALPHA_ORG_ID,
  name: 'Main Branch', code: 'MAIN',
  address_line1: '1 Main St', city: 'Austin', state: 'TX', postal_code: '78701',
  country: 'US', timezone: 'America/Chicago', phone: null, manager_id: null,
};

beforeEach(() => { vi.clearAllMocks(); });

describe('GET /api/locations', () => {
  it('lists scoped to org', async () => {
    mockAuthAs('admin');
    (prisma.location.findMany as any).mockResolvedValue([LOCATION_FIXTURE]);
    const res = await request(app).get('/api/locations').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body).toHaveLength(1);
    expect((prisma.location.findMany as any).mock.calls[0][0].where)
      .toMatchObject({ organization_id: ALPHA_ORG_ID });
  });
});

describe('POST /api/locations', () => {
  it('creates with requesting org', async () => {
    mockAuthAs('admin');
    (prisma.location.create as any).mockResolvedValue(LOCATION_FIXTURE);
    const res = await request(app).post('/api/locations').set(authHeader('admin'))
      .send({ name: 'Main Branch', code: 'MAIN', city: 'Austin', state: 'TX' });
    expect(res.status).toBe(201);
    expect((prisma.location.create as any).mock.calls[0][0].data)
      .toMatchObject({ organization_id: ALPHA_ORG_ID, name: 'Main Branch', code: 'MAIN' });
  });
  it('rejects missing name (400)', async () => {
    mockAuthAs('admin');
    const res = await request(app).post('/api/locations').set(authHeader('admin')).send({ code: 'X' });
    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/locations/:id', () => {
  it('updates only within org (updateMany guard)', async () => {
    mockAuthAs('admin');
    (prisma.location.updateMany as any).mockResolvedValue({ count: 1 });
    (prisma.location.findFirst as any).mockResolvedValue({ ...LOCATION_FIXTURE, name: 'Renamed' });
    const res = await request(app).patch(`/api/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('admin')).send({ name: 'Renamed' });
    expect(res.status).toBe(200);
    expect((prisma.location.updateMany as any).mock.calls[0][0].where)
      .toMatchObject({ id: LOCATION_FIXTURE.id, organization_id: ALPHA_ORG_ID });
  });
  it('404 when cross-org (count 0)', async () => {
    mockAuthAs('orgB_admin');
    (prisma.location.updateMany as any).mockResolvedValue({ count: 0 });
    const res = await request(app).patch(`/api/locations/${LOCATION_FIXTURE.id}`)
      .set(authHeader('orgB_admin')).send({ name: 'x' });
    expect(res.status).toBe(404);
    expect((prisma.location.updateMany as any).mock.calls[0][0].where)
      .toMatchObject({ organization_id: ORG_B_ID });
  });
});

describe('DELETE /api/locations/:id', () => {
  it('blocks delete when users reference it (409)', async () => {
    mockAuthAs('admin');
    (prisma.user.count as any).mockResolvedValue(2);
    const res = await request(app).delete(`/api/locations/${LOCATION_FIXTURE.id}`).set(authHeader('admin'));
    expect(res.status).toBe(409);
  });
  it('deletes within org when unreferenced', async () => {
    mockAuthAs('admin');
    (prisma.user.count as any).mockResolvedValue(0);
    (prisma.location.deleteMany as any).mockResolvedValue({ count: 1 });
    const res = await request(app).delete(`/api/locations/${LOCATION_FIXTURE.id}`).set(authHeader('admin'));
    expect(res.status).toBe(204);
    expect((prisma.location.deleteMany as any).mock.calls[0][0].where)
      .toMatchObject({ id: LOCATION_FIXTURE.id, organization_id: ALPHA_ORG_ID });
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (route 404s). `npx vitest run src/__tests__/locations.test.ts`.

- [ ] **Step 3a: Implement `location.controller.ts`.**

```typescript
import { Request, Response } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { logger } from '../lib/logger';
import { writeSettingsAudit } from '../lib/audit';

export const createLocationSchema = z.object({
  name: z.string().min(1).max(120),
  code: z.string().min(1).max(20),
  address_line1: z.string().max(200).optional(),
  address_line2: z.string().max(200).optional(),
  city: z.string().max(100).optional(),
  state: z.string().max(50).optional(),
  postal_code: z.string().max(20).optional(),
  country: z.string().length(2).optional(),
  timezone: z.string().max(64).optional(),
  phone: z.string().max(50).optional(),
  manager_id: z.string().uuid().nullable().optional(),
}).strict();

export const updateLocationSchema = createLocationSchema.partial();

export const listLocations = async (req: Request, res: Response) => {
  try {
    const locations = await prisma.location.findMany({
      where: { ...tenantWhere(req) },
      orderBy: { name: 'asc' },
      include: { manager: { select: { id: true, first_name: true, last_name: true } }, _count: { select: { members: true } } },
    });
    res.json(locations);
  } catch (err) {
    logger.error('listLocations error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const createLocation = async (req: Request, res: Response) => {
  try {
    const data = req.body as z.infer<typeof createLocationSchema>;
    const created = await prisma.location.create({ data: { ...data, ...tenantWhere(req) } });
    await writeSettingsAudit(req, 'location.created', { location_id: created.id, name: created.name });
    res.status(201).json(created);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'A location with that code already exists' });
      return;
    }
    logger.error('createLocation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const updateLocation = async (req: Request, res: Response) => {
  try {
    const data = req.body as z.infer<typeof updateLocationSchema>;
    const result = await prisma.location.updateMany({
      where: { id: req.params.id, ...tenantWhere(req) },
      data,
    });
    if (result.count === 0) { res.status(404).json({ error: 'Location not found' }); return; }
    const location = await prisma.location.findFirst({ where: { id: req.params.id, ...tenantWhere(req) } });
    await writeSettingsAudit(req, 'location.updated', { location_id: req.params.id });
    res.json(location);
  } catch (err: unknown) {
    if ((err as { code?: string }).code === 'P2002') {
      res.status(409).json({ error: 'A location with that code already exists' });
      return;
    }
    logger.error('updateLocation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const deleteLocation = async (req: Request, res: Response) => {
  try {
    const referencing = await prisma.user.count({ where: { location_id: req.params.id, ...tenantWhere(req) } });
    if (referencing > 0) {
      res.status(409).json({ error: `Cannot delete: ${referencing} user(s) are assigned to this location` });
      return;
    }
    const result = await prisma.location.deleteMany({ where: { id: req.params.id, ...tenantWhere(req) } });
    if (result.count === 0) { res.status(404).json({ error: 'Location not found' }); return; }
    await writeSettingsAudit(req, 'location.deleted', { location_id: req.params.id });
    res.status(204).send();
  } catch (err) {
    logger.error('deleteLocation error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
```

> `writeSettingsAudit` is created in Task 4.2. For this task to compile/run first, create the stub now (it is fully implemented in 4.2): add `backend/src/lib/audit.ts` with `export async function writeSettingsAudit() {}` and flesh it out in Task 4.2. (Tests here don't assert audit.)

- [ ] **Step 3b: Implement `location.routes.ts`.**

```typescript
import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import { validate } from '../middleware/validate';
import * as ctrl from '../controllers/location.controller';

const router = Router();
router.use(authenticate, attachAbility);
router.get('/', canDo('read', 'Location'), ctrl.listLocations);
router.post('/', canDo('create', 'Location'), validate(ctrl.createLocationSchema), ctrl.createLocation);
router.patch('/:id', canDo('update', 'Location'), validate(ctrl.updateLocationSchema), ctrl.updateLocation);
router.delete('/:id', canDo('delete', 'Location'), ctrl.deleteLocation);
export default router;
```

- [ ] **Step 3c: Mount in `app.ts`** — near the other `app.use('/api/...')` lines:

```typescript
import locationRoutes from './routes/location.routes';
// ...
app.use('/api/locations', locationRoutes);
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/__tests__/locations.test.ts`.

- [ ] **Step 5: Commit.**

```bash
git add backend/src/controllers/location.controller.ts backend/src/routes/location.routes.ts backend/src/app.ts backend/src/lib/audit.ts backend/src/__tests__/locations.test.ts
git commit -m "feat(settings): org-level Locations CRUD with tenant isolation + CASL"
```

---

# PHASE 3 — Roles endpoints + view-model (TDD) — **keystone**

### Task 3.1: `roleViewModel.ts` — pure mapping (UI view-model ⇄ grant set)

**Files:**
- Create: `backend/src/lib/permissions/roleViewModel.ts`
- Test: `backend/src/__tests__/role-view-model.test.ts`

The view-model is the single most important deliverable. Define it concretely:

```
MODULES (CRUD matrix): Customer, Lead, Estimate, Job, Invoice, Inventory
CRUD cells:           View→read, Create→create, Edit→update, Delete→delete
SENSITIVE toggles:
  - seeFinancials  → [ read Report ]
  - managePayments → [ record_payment Invoice, record_payment Estimate, refund Invoice, refund_deposit Estimate ]
DATA SCOPE entities:  Lead, Job, Estimate, Invoice  (Customer, Inventory = All-only)
SCOPE → conditions (on the `read` grant of that subject):
  All      → null
  Owned    → Lead:{assigned_to:'{{userId}}'}  Job:{assigned_to:'{{userId}}'}
             Estimate:{lead:{assigned_to:'{{userId}}'}}  Invoice:{job:{assigned_to:'{{userId}}'}}
  Team     → Lead:{assigned_user:{department_id:'{{teamId}}'}}  Job:{assigned_user:{department_id:'{{teamId}}'}}
             Estimate:{lead:{assigned_user:{department_id:'{{teamId}}'}}}  Invoice:{job:{assigned_user:{department_id:'{{teamId}}'}}}
  Location → same as Team with location_id:'{{locationId}}'
```

- [ ] **Step 1: Write the failing test.**

```typescript
import { describe, it, expect } from 'vitest';
import { assembleRoleViewModel, viewModelToGrants, MODULES, SCOPE_ENTITIES } from '../lib/permissions/roleViewModel';

describe('roleViewModel', () => {
  it('exposes 6 CRUD modules and 4 scope entities', () => {
    expect(MODULES.map((m) => m.subject)).toEqual(['Customer','Lead','Estimate','Job','Invoice','Inventory']);
    expect(SCOPE_ENTITIES.map((e) => e.subject)).toEqual(['Lead','Job','Estimate','Invoice']);
  });

  it('assembles matrix from grants', () => {
    const vm = assembleRoleViewModel('SALES', [
      { action: 'read', subject: 'Customer', conditions: null },
      { action: 'update', subject: 'Customer', conditions: null },
      { action: 'read', subject: 'Lead', conditions: { assigned_to: '{{userId}}' } },
    ]);
    expect(vm.matrix.Customer).toEqual({ read: true, create: false, update: true, delete: false });
    expect(vm.scope.Lead).toBe('Owned');
    expect(vm.scope.Job).toBe('All'); // no read Job grant → defaults All (not present means none, see note)
  });

  it('round-trips matrix + sensitive + scope to grants', () => {
    const vm = {
      role: 'SALES',
      matrix: { Customer: { read: true, create: false, update: false, delete: false } },
      sensitive: { seeFinancials: true, managePayments: false },
      scope: { Lead: 'Team' as const },
      general: { description: '' },
    };
    const grants = viewModelToGrants(vm);
    expect(grants).toContainEqual({ action: 'read', subject: 'Customer', conditions: null });
    expect(grants).toContainEqual({ action: 'read', subject: 'Report', conditions: null });
    expect(grants).toContainEqual({ action: 'read', subject: 'Lead', conditions: { assigned_user: { department_id: '{{teamId}}' } });
  });
});
```

> **Note on "none vs All":** A subject with NO `read` grant means the role cannot read it at all. The UI represents that as the View toggle being OFF. Scope only applies when `read` is ON. When `read` is ON with `conditions:null` → scope = `All`. When the View toggle is OFF, the scope selector is disabled. Encode this in `assembleRoleViewModel` (scope defaults to `'All'` only when a conditionless read grant exists; otherwise scope is `'All'` but greyed because read=false).

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/__tests__/role-view-model.test.ts`.

- [ ] **Step 3: Implement `roleViewModel.ts`.**

```typescript
import type { Grant } from './defineAbility';

export type ScopeValue = 'All' | 'Owned' | 'Team' | 'Location';
export type CrudCell = { read: boolean; create: boolean; update: boolean; delete: boolean };

export const MODULES = [
  { subject: 'Customer',  label: 'Customers' },
  { subject: 'Lead',      label: 'Leads' },
  { subject: 'Estimate',  label: 'Estimates' },
  { subject: 'Job',       label: 'Jobs' },
  { subject: 'Invoice',   label: 'Invoices' },
  { subject: 'Inventory', label: 'Inventory' },
] as const;

// Only these have an ownership chain → all four scope chips are real.
export const SCOPE_ENTITIES = [
  { subject: 'Lead',     label: 'Leads' },
  { subject: 'Job',      label: 'Jobs' },
  { subject: 'Estimate', label: 'Estimates' },
  { subject: 'Invoice',  label: 'Invoices' },
] as const;

const SENSITIVE = {
  seeFinancials:  [{ action: 'read', subject: 'Report' }],
  managePayments: [
    { action: 'record_payment', subject: 'Invoice' },
    { action: 'record_payment', subject: 'Estimate' },
    { action: 'refund', subject: 'Invoice' },
    { action: 'refund_deposit', subject: 'Estimate' },
  ],
} as const;

type ScopeConds = Record<ScopeValue, Record<string, unknown> | null>;
const SCOPE_CONDITIONS: Record<string, ScopeConds> = {
  Lead: {
    All: null,
    Owned:    { assigned_to: '{{userId}}' },
    Team:     { assigned_user: { department_id: '{{teamId}}' } },
    Location: { assigned_user: { location_id: '{{locationId}}' } },
  },
  Job: {
    All: null,
    Owned:    { assigned_to: '{{userId}}' },
    Team:     { assigned_user: { department_id: '{{teamId}}' } },
    Location: { assigned_user: { location_id: '{{locationId}}' } },
  },
  Estimate: {
    All: null,
    Owned:    { lead: { assigned_to: '{{userId}}' } },
    Team:     { lead: { assigned_user: { department_id: '{{teamId}}' } } },
    Location: { lead: { assigned_user: { location_id: '{{locationId}}' } } },
  },
  Invoice: {
    All: null,
    Owned:    { job: { assigned_to: '{{userId}}' } },
    Team:     { job: { assigned_user: { department_id: '{{teamId}}' } } },
    Location: { job: { assigned_user: { location_id: '{{locationId}}' } } },
  },
};

export interface RoleViewModel {
  role: string;
  matrix: Record<string, CrudCell>;
  sensitive: { seeFinancials: boolean; managePayments: boolean };
  scope: Record<string, ScopeValue>;
  general: { description: string };
}

const ACTION_BY_CELL = { read: 'read', create: 'create', update: 'update', delete: 'delete' } as const;

function stableStringify(o: unknown): string {
  if (o === null || typeof o !== 'object') return JSON.stringify(o);
  if (Array.isArray(o)) return `[${o.map(stableStringify).join(',')}]`;
  return `{${Object.keys(o as object).sort().map((k) => `${JSON.stringify(k)}:${stableStringify((o as Record<string, unknown>)[k])}`).join(',')}}`;
}

export function assembleRoleViewModel(role: string, grants: Grant[]): RoleViewModel {
  const has = (action: string, subject: string) =>
    grants.some((g) => g.action === action && g.subject === subject);

  const matrix: Record<string, CrudCell> = {};
  for (const m of MODULES) {
    matrix[m.subject] = {
      read: has('read', m.subject),
      create: has('create', m.subject),
      update: has('update', m.subject),
      delete: has('delete', m.subject),
    };
  }

  const scope: Record<string, ScopeValue> = {};
  for (const e of SCOPE_ENTITIES) {
    const readGrant = grants.find((g) => g.action === 'read' && g.subject === e.subject);
    scope[e.subject] = 'All';
    if (readGrant?.conditions) {
      const condStr = stableStringify(readGrant.conditions);
      for (const sv of ['Owned', 'Team', 'Location'] as ScopeValue[]) {
        if (stableStringify(SCOPE_CONDITIONS[e.subject][sv]) === condStr) { scope[e.subject] = sv; break; }
      }
    }
  }

  const sensitive = {
    seeFinancials: SENSITIVE.seeFinancials.every((s) => has(s.action, s.subject)),
    managePayments: SENSITIVE.managePayments.every((s) => has(s.action, s.subject)),
  };

  return { role, matrix, sensitive, scope, general: { description: '' } };
}

export function viewModelToGrants(vm: RoleViewModel): Grant[] {
  const grants: Grant[] = [];
  const scopeSubjects = new Set(SCOPE_ENTITIES.map((e) => e.subject));

  for (const m of MODULES) {
    const cell = vm.matrix[m.subject] ?? { read: false, create: false, update: false, delete: false };
    for (const key of ['read', 'create', 'update', 'delete'] as const) {
      if (!cell[key]) continue;
      const action = ACTION_BY_CELL[key];
      let conditions: Record<string, unknown> | null = null;
      if (action === 'read' && scopeSubjects.has(m.subject)) {
        const sv = vm.scope[m.subject] ?? 'All';
        conditions = SCOPE_CONDITIONS[m.subject][sv];
      }
      grants.push({ action, subject: m.subject, conditions });
    }
  }

  if (vm.sensitive.seeFinancials) for (const s of SENSITIVE.seeFinancials) grants.push({ action: s.action, subject: s.subject, conditions: null });
  if (vm.sensitive.managePayments) for (const s of SENSITIVE.managePayments) grants.push({ action: s.action, subject: s.subject, conditions: null });

  return grants;
}
```

- [ ] **Step 4: Fix the test typo if present** (`}` balance in the `toContainEqual` for Lead/Team) and run — expect PASS. `npx vitest run src/__tests__/role-view-model.test.ts`.

- [ ] **Step 5: Commit.**

```bash
git add backend/src/lib/permissions/roleViewModel.ts backend/src/__tests__/role-view-model.test.ts
git commit -m "feat(permissions): role view-model mapping (UI matrix/sensitive/scope <-> grants)"
```

---

### Task 3.2: Role controller + routes (list / get / put / reset)

**Files:**
- Create: `backend/src/controllers/role.controller.ts`, `backend/src/routes/role.routes.ts`
- Modify: `backend/src/app.ts`
- Test: `backend/src/__tests__/roles.test.ts`

- [ ] **Step 1: Write the failing test.**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ORG_B_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

beforeEach(() => { vi.clearAllMocks(); clearPermissionCache(); });

describe('GET /api/roles', () => {
  it('returns the 4 system roles with user counts, admin labelled Owner', async () => {
    mockAuthAs('admin');
    (prisma.user.groupBy as any).mockResolvedValue([
      { role: 'ADMIN', _count: { _all: 1 } }, { role: 'SALES', _count: { _all: 3 } },
    ]);
    const res = await request(app).get('/api/roles').set(authHeader('admin'));
    expect(res.status).toBe(200);
    const admin = res.body.find((r: any) => r.role === 'ADMIN');
    expect(admin).toMatchObject({ label: 'Administrator (Owner)', fullAccess: true, editable: false, userCount: 1 });
    expect(res.body.map((r: any) => r.role)).toEqual(['ADMIN','SALES','DISPATCHER','TECHNICIAN']);
  });
});

describe('GET /api/roles/:role/permissions', () => {
  it('assembles SALES view-model from RolePermission rows (org-scoped)', async () => {
    mockAuthAs('admin');
    (prisma.rolePermission.findMany as any).mockResolvedValue([
      { action: 'read', subject: 'Customer', conditions: null },
      { action: 'read', subject: 'Lead', conditions: { assigned_to: '{{userId}}' } },
    ]);
    const res = await request(app).get('/api/roles/SALES/permissions').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.matrix.Customer.read).toBe(true);
    expect(res.body.scope.Lead).toBe('Owned');
    expect((prisma.rolePermission.findMany as any).mock.calls[0][0].where)
      .toMatchObject({ organization_id: ALPHA_ORG_ID, role: 'SALES' });
  });
  it('ADMIN returns synthetic full-access, read-only', async () => {
    mockAuthAs('admin');
    const res = await request(app).get('/api/roles/ADMIN/permissions').set(authHeader('admin'));
    expect(res.body.matrix.Invoice).toEqual({ read: true, create: true, update: true, delete: true });
    expect(res.body.editable).toBe(false);
  });
});

describe('PUT /api/roles/:role/permissions', () => {
  it('diffs to upserts/deletes, clears cache, 200', async () => {
    mockAuthAs('admin');
    (prisma.rolePermission.findMany as any).mockResolvedValue([
      { action: 'read', subject: 'Customer', conditions: null }, // existing, kept
      { action: 'delete', subject: 'Customer', conditions: null }, // existing, removed
    ]);
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({
      rolePermission: {
        deleteMany: vi.fn().mockResolvedValue({ count: 1 }),
        upsert: vi.fn().mockResolvedValue({}),
      },
    }));
    const res = await request(app).put('/api/roles/SALES/permissions').set(authHeader('admin')).send({
      matrix: { Customer: { read: true, create: true, update: false, delete: false } },
      sensitive: { seeFinancials: false, managePayments: false },
      scope: {}, general: { description: '' },
    });
    expect(res.status).toBe(200);
  });
  it('rejects editing ADMIN (400)', async () => {
    mockAuthAs('admin');
    const res = await request(app).put('/api/roles/ADMIN/permissions').set(authHeader('admin'))
      .send({ matrix: {}, sensitive: { seeFinancials: false, managePayments: false }, scope: {}, general: { description: '' } });
    expect(res.status).toBe(400);
  });
});

describe('POST /api/roles/:role/reset', () => {
  it('re-applies DEFAULT_GRANTS for the role, org-scoped', async () => {
    mockAuthAs('admin');
    (prisma.$transaction as any).mockImplementation((fn: any) => fn({
      rolePermission: { deleteMany: vi.fn().mockResolvedValue({ count: 5 }), createMany: vi.fn().mockResolvedValue({ count: 42 }) },
    }));
    const res = await request(app).post('/api/roles/SALES/reset').set(authHeader('admin'));
    expect(res.status).toBe(200);
  });
});

describe('roles isolation', () => {
  it('non-admin (no Role grant) gets 403', async () => {
    mockAuthAs('sales');
    const res = await request(app).get('/api/roles').set(authHeader('sales'));
    expect(res.status).toBe(403);
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/__tests__/roles.test.ts`.

- [ ] **Step 3a: Implement `role.controller.ts`.**

```typescript
import { Request, Response } from 'express';
import { prisma } from '../lib/prisma';
import { tenantWhere } from '../lib/tenant';
import { logger } from '../lib/logger';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { assembleRoleViewModel, viewModelToGrants, MODULES, type RoleViewModel } from '../lib/permissions/roleViewModel';
import { writeSettingsAudit } from '../lib/audit';

const SYSTEM_ROLES = ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] as const;
const ROLE_META: Record<string, { label: string; fullAccess: boolean; editable: boolean }> = {
  ADMIN:      { label: 'Administrator (Owner)', fullAccess: true,  editable: false },
  SALES:      { label: 'Sales',                 fullAccess: false, editable: true  },
  DISPATCHER: { label: 'Dispatcher',            fullAccess: false, editable: true  },
  TECHNICIAN: { label: 'Technician',            fullAccess: false, editable: true  },
};

function adminViewModel(): RoleViewModel {
  const matrix: RoleViewModel['matrix'] = {};
  for (const m of MODULES) matrix[m.subject] = { read: true, create: true, update: true, delete: true };
  return { role: 'ADMIN', matrix, sensitive: { seeFinancials: true, managePayments: true }, scope: {}, general: { description: 'Full access (non-reducible)' } };
}

export const listRoles = async (req: Request, res: Response) => {
  try {
    const counts = await prisma.user.groupBy({ by: ['role'], where: { ...tenantWhere(req) }, _count: { _all: true } });
    const countByRole = new Map(counts.map((c) => [c.role, c._count._all]));
    res.json(SYSTEM_ROLES.map((role) => ({
      role, ...ROLE_META[role], userCount: countByRole.get(role) ?? 0, type: 'system',
    })));
  } catch (err) {
    logger.error('listRoles error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const getRolePermissions = async (req: Request, res: Response) => {
  try {
    const role = req.params.role;
    if (!SYSTEM_ROLES.includes(role as never)) { res.status(404).json({ error: 'Unknown role' }); return; }
    if (role === 'ADMIN') { res.json({ ...adminViewModel(), editable: false }); return; }
    const rows = await prisma.rolePermission.findMany({
      where: { ...tenantWhere(req), role }, select: { action: true, subject: true, conditions: true },
    });
    const vm = assembleRoleViewModel(role, rows.map((r) => ({ action: r.action, subject: r.subject, conditions: r.conditions as Record<string, unknown> | null })));
    res.json({ ...vm, editable: true });
  } catch (err) {
    logger.error('getRolePermissions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const putRolePermissions = async (req: Request, res: Response) => {
  try {
    const role = req.params.role;
    if (!SYSTEM_ROLES.includes(role as never)) { res.status(404).json({ error: 'Unknown role' }); return; }
    if (role === 'ADMIN') { res.status(400).json({ error: 'The Administrator role is full-access and cannot be edited' }); return; }

    const orgId = req.user!.organization_id;
    const vm = { ...(req.body as RoleViewModel), role };
    const desired = viewModelToGrants(vm);
    const desiredKey = (g: { action: string; subject: string }) => `${g.action}:${g.subject}`;
    const desiredByKey = new Map(desired.map((g) => [desiredKey(g), g]));

    const existing = await prisma.rolePermission.findMany({ where: { organization_id: orgId, role } });
    const existingKeys = new Set(existing.map(desiredKey));

    await prisma.$transaction(async (tx) => {
      // delete grants no longer desired
      const toDelete = existing.filter((e) => !desiredByKey.has(desiredKey(e)));
      if (toDelete.length) {
        await tx.rolePermission.deleteMany({
          where: { organization_id: orgId, role, OR: toDelete.map((d) => ({ action: d.action, subject: d.subject })) },
        });
      }
      // upsert desired (covers new + changed conditions)
      for (const g of desired) {
        await tx.rolePermission.upsert({
          where: { organization_id_role_action_subject: { organization_id: orgId, role, action: g.action, subject: g.subject } },
          create: { organization_id: orgId, role, action: g.action, subject: g.subject, conditions: g.conditions ?? undefined },
          update: { conditions: g.conditions ?? undefined },
        });
      }
    });

    clearPermissionCache(orgId);
    await writeSettingsAudit(req, 'role.permissions_updated', { role, grantCount: desired.length });
    res.json({ ok: true });
  } catch (err) {
    logger.error('putRolePermissions error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};

export const resetRole = async (req: Request, res: Response) => {
  try {
    const role = req.params.role;
    if (!SYSTEM_ROLES.includes(role as never) || role === 'ADMIN') { res.status(400).json({ error: 'Role cannot be reset' }); return; }
    const orgId = req.user!.organization_id;
    const defaults = DEFAULT_GRANTS.filter((g) => g.role === role)
      .map((g) => ({ organization_id: orgId, role, action: g.action, subject: g.subject, conditions: (g as { conditions?: unknown }).conditions ?? undefined }));
    await prisma.$transaction(async (tx) => {
      await tx.rolePermission.deleteMany({ where: { organization_id: orgId, role } });
      if (defaults.length) await tx.rolePermission.createMany({ data: defaults });
    });
    clearPermissionCache(orgId);
    await writeSettingsAudit(req, 'role.reset', { role });
    res.json({ ok: true });
  } catch (err) {
    logger.error('resetRole error:', err);
    res.status(500).json({ error: 'Internal server error' });
  }
};
```

- [ ] **Step 3b: Implement `role.routes.ts`.**

```typescript
import { Router } from 'express';
import { authenticate } from '../middleware/authenticate';
import { attachAbility } from '../middleware/attachAbility';
import { canDo } from '../middleware/canGuard';
import * as ctrl from '../controllers/role.controller';

const router = Router();
router.use(authenticate, attachAbility);
router.get('/', canDo('read', 'Role'), ctrl.listRoles);
router.get('/:role/permissions', canDo('read', 'Role'), ctrl.getRolePermissions);
router.put('/:role/permissions', canDo('update', 'Role'), ctrl.putRolePermissions);
router.post('/:role/reset', canDo('update', 'Role'), ctrl.resetRole);
export default router;
```

- [ ] **Step 3c: Mount in `app.ts`:** `import roleRoutes from './routes/role.routes';` and `app.use('/api/roles', roleRoutes);`

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/__tests__/roles.test.ts`.

- [ ] **Step 5: Commit.**

```bash
git add backend/src/controllers/role.controller.ts backend/src/routes/role.routes.ts backend/src/app.ts backend/src/__tests__/roles.test.ts
git commit -m "feat(settings): roles read/write endpoints over RolePermission with cache invalidation"
```

---

# PHASE 4 — Org profile extension + audit (TDD)

### Task 4.1: Extend `patchOrgSchema` + persist new profile/mailing/MFA fields

**Files:**
- Modify: `backend/src/controllers/organization.controller.ts`
- Test: `backend/src/__tests__/organization-profile.test.ts`

- [ ] **Step 1: Write the failing test.**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';

beforeEach(() => { vi.clearAllMocks(); });

function mockOrgTx(current: Record<string, unknown> = {}) {
  (prisma.$transaction as any).mockImplementation((fn: any) => fn({
    $executeRaw: vi.fn().mockResolvedValue(1),
    organization: {
      findUnique: vi.fn().mockResolvedValue({
        lead_first_issued_at: null, estimate_first_issued_at: null, job_first_issued_at: null,
        invoice_first_issued_at: null, customer_first_issued_at: null,
        lead_prefix: 'L', estimate_prefix: 'E', job_prefix: 'J', invoice_prefix: 'I', customer_prefix: 'C',
        number_padding: 5, stripe_account_id: null, accepted_payment_methods: [], ...current,
      }),
      update: vi.fn().mockImplementation((args: any) => Promise.resolve({ id: ALPHA_ORG_ID, ...args.data })),
    },
  }));
}

describe('PATCH /api/organization — profile fields', () => {
  it('accepts and persists new profile fields', async () => {
    mockAuthAs('admin'); mockOrgTx();
    const res = await request(app).patch('/api/organization').set(authHeader('admin')).send({
      display_name: 'Acme DBA', tax_id: '12-3456789', business_type: 'LLC',
      industry: ['HVAC', 'Plumbing'], support_email: 'support@acme.com',
      timezone: 'America/Chicago', currency: 'USD', date_format: 'MM/DD/YYYY',
      mfa_sms_enabled: true,
    });
    expect(res.status).toBe(200);
  });
  it('reveals mailing fields when mailing_same_as_hq=false', async () => {
    mockAuthAs('admin'); mockOrgTx();
    const res = await request(app).patch('/api/organization').set(authHeader('admin')).send({
      mailing_same_as_hq: false, mailing_address_line1: 'PO Box 9', mailing_city: 'Austin',
      mailing_state: 'TX', mailing_postal_code: '78701', mailing_country: 'US',
    });
    expect(res.status).toBe(200);
  });
  it('rejects unknown key (strict)', async () => {
    mockAuthAs('admin'); mockOrgTx();
    const res = await request(app).patch('/api/organization').set(authHeader('admin')).send({ nonsense: 1 });
    expect(res.status).toBe(400);
  });
  it('rejects bad support_email', async () => {
    mockAuthAs('admin'); mockOrgTx();
    const res = await request(app).patch('/api/organization').set(authHeader('admin')).send({ support_email: 'notanemail' });
    expect(res.status).toBe(400);
  });
});
```

- [ ] **Step 2: Run — expect FAIL** (strict schema rejects the new keys → 400 on the happy paths). `npx vitest run src/__tests__/organization-profile.test.ts`.

- [ ] **Step 3a: Extend `patchOrgSchema`** in `organization.controller.ts` — add these keys inside the `z.object({ ... })` (before `.strict()`):

```typescript
  display_name: z.string().max(200).optional(),
  tax_id: z.string().max(50).optional(),
  business_type: z.string().max(50).optional(),
  industry: z.array(z.string().trim().min(1).max(50)).max(50).optional(),
  support_email: z.string().email().max(200).optional().or(z.literal('')),
  billing_email: z.string().email().max(200).optional().or(z.literal('')),
  timezone: z.string().max(64).optional(),
  currency: z.string().length(3).optional(),
  date_format: z.string().max(20).optional(),
  mailing_same_as_hq: z.boolean().optional(),
  mailing_address_line1: z.string().max(200).optional(),
  mailing_address_line2: z.string().max(200).optional(),
  mailing_city: z.string().max(100).optional(),
  mailing_state: z.string().max(50).optional(),
  mailing_postal_code: z.string().max(20).optional(),
  mailing_country: z.string().length(2).optional(),
  mfa_sms_enabled: z.boolean().optional(),
  mfa_email_enabled: z.boolean().optional(),
```

- [ ] **Step 3b: Persist them.** Find where `updateOrganization` builds the `tx.organization.update({ data })` (after the numbering/option-dedup block, ~line 243+). The handler currently writes `body` fields through. Confirm the final `update` spreads the validated body (the existing code already maps known fields). If it uses an explicit field list, append the new fields; if it spreads `body`, the new fields flow through automatically. Ensure `industry` (Json) is passed as-is. Re-read lines 243–end before editing to follow the existing write style exactly.

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/__tests__/organization-profile.test.ts`.

- [ ] **Step 5: Regression** — run the existing org test (numbering non-regress): `npx vitest run src/__tests__/organization.test.ts` (or the file that covers org PATCH numbering) → PASS.

- [ ] **Step 6: Commit.**

```bash
git add backend/src/controllers/organization.controller.ts backend/src/__tests__/organization-profile.test.ts
git commit -m "feat(settings): extend org PATCH with profile, mailing, and MFA-policy fields"
```

---

### Task 4.2: Audit helper

**Files:**
- Modify: `backend/src/lib/audit.ts` (replace the Task-2.1 stub)
- Test: `backend/src/__tests__/audit.test.ts`

- [ ] **Step 1: Write the failing test.**

```typescript
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { writeSettingsAudit } from '../lib/audit';
import { ALPHA_ORG_ID, TEST_USERS } from './helpers';

beforeEach(() => { vi.clearAllMocks(); });

describe('writeSettingsAudit', () => {
  it('writes an org-scoped TimelineEvent and never throws on failure', async () => {
    (prisma.timelineEvent.create as any).mockResolvedValue({});
    const req: any = { user: { ...TEST_USERS.admin, organization_id: ALPHA_ORG_ID } };
    await writeSettingsAudit(req, 'role.reset', { role: 'SALES' });
    const arg = (prisma.timelineEvent.create as any).mock.calls[0][0].data;
    expect(arg).toMatchObject({
      organization_id: ALPHA_ORG_ID, entity_type: 'OrganizationSettings',
      entity_id: ALPHA_ORG_ID, event_type: 'role.reset', created_by: TEST_USERS.admin.id,
    });
    expect(arg.metadata).toMatchObject({ role: 'SALES' });
  });
  it('swallows errors (audit is best-effort)', async () => {
    (prisma.timelineEvent.create as any).mockRejectedValue(new Error('db down'));
    const req: any = { user: { ...TEST_USERS.admin, organization_id: ALPHA_ORG_ID } };
    await expect(writeSettingsAudit(req, 'x', {})).resolves.toBeUndefined();
  });
});
```

- [ ] **Step 2: Run — expect FAIL.** `npx vitest run src/__tests__/audit.test.ts`.

- [ ] **Step 3: Implement `audit.ts`.**

```typescript
import { Request } from 'express';
import { prisma } from './prisma';
import { logger } from './logger';

export async function writeSettingsAudit(
  req: Request,
  eventType: string,
  metadata: Record<string, unknown>,
): Promise<void> {
  try {
    const orgId = req.user!.organization_id;
    await prisma.timelineEvent.create({
      data: {
        organization_id: orgId,
        entity_type: 'OrganizationSettings',
        entity_id: orgId,
        event_type: eventType,
        description: `Settings change: ${eventType}`,
        metadata: metadata as object,
        created_by: req.user!.id,
      },
    });
  } catch (err) {
    logger.error('writeSettingsAudit failed (non-fatal):', err);
  }
}
```

- [ ] **Step 4: Run — expect PASS.** `npx vitest run src/__tests__/audit.test.ts`.

- [ ] **Step 5: Run the full backend suite** to confirm nothing regressed: `npm test --workspace=backend` → all green.

- [ ] **Step 6: Commit.**

```bash
git add backend/src/lib/audit.ts backend/src/__tests__/audit.test.ts
git commit -m "feat(settings): best-effort settings audit via TimelineEvent"
```

---

# PHASE 5 — Frontend foundation

### Task 5.1: Add `Location`/`Role` to frontend `AppSubject`

**Files:** Modify `frontend/src/lib/ability.ts`

- [ ] **Step 1:** Add `'Location'` and `'Role'` to the `AppSubject` union (mirror backend):

```typescript
export type AppSubject =
  | 'Dashboard' | 'Customer' | 'Lead' | 'Estimate' | 'Job'
  | 'Invoice' | 'User' | 'Department' | 'PriceBook' | 'Tag'
  | 'Report' | 'Organization' | 'StateTaxRate' | 'AppSetting'
  | 'Attachment' | 'Walkthrough' | 'Inventory' | 'Communication'
  | 'Location' | 'Role' | 'all';
```

- [ ] **Step 2: Type-check.** From `frontend/`: `npx tsc --noEmit` → no new errors.
- [ ] **Step 3: Commit.** `git add frontend/src/lib/ability.ts && git commit -m "feat(settings): add Location/Role subjects to frontend ability"`

---

### Task 5.2: `SettingsLayout` + nested `/settings/*` routes

**Files:**
- Create: `frontend/src/pages/settings/SettingsLayout.tsx`
- Modify: `frontend/src/App.tsx`
- Add shadcn AlertDialog: `frontend/src/components/ui/alert-dialog.tsx`

- [ ] **Step 1: Add the AlertDialog primitive** (dirty-guard). If `npx shadcn@latest add alert-dialog` is unavailable offline, create `frontend/src/components/ui/alert-dialog.tsx` from the standard shadcn Radix `@radix-ui/react-alert-dialog` wrapper (check `package.json` for the dep; if missing, `npm i @radix-ui/react-alert-dialog -w frontend`). Match the existing `dialog.tsx` styling conventions in this repo.

- [ ] **Step 2: Implement `SettingsLayout.tsx`.** Renders the settings menu (CASL-filtered) + sub-bar (breadcrumb + Discard/Save/✕) + `<Outlet/>`. The active page registers its form controls via an outlet context so the sub-bar can drive Save/Discard.

```tsx
import { NavLink, Outlet, useNavigate, useLocation } from 'react-router-dom';
import { useState, useCallback, createContext, useContext } from 'react';
import { useAppAbility } from '@/contexts/AbilityContext';
import { Button } from '@/components/ui/button';
import { X } from 'lucide-react';
import {
  AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent,
  AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import type { AppAction, AppSubject } from '@/lib/ability';

interface SettingsCtx {
  registerSaver: (fns: { save: () => Promise<void> | void; discard: () => void; isDirty: boolean }) => void;
}
const Ctx = createContext<SettingsCtx>({ registerSaver: () => {} });
export const useSettingsBar = () => useContext(Ctx);

const NAV: { to: string; label: string; group: string; action: AppAction; subject: AppSubject }[] = [
  { to: 'company',   label: 'Company Profile',     group: 'ORGANIZATION',    action: 'read', subject: 'Organization' },
  { to: 'branding',  label: 'Branding & Templates', group: 'ORGANIZATION',    action: 'read', subject: 'Organization' },
  { to: 'locations', label: 'Locations',            group: 'ORGANIZATION',    action: 'read', subject: 'Location' },
  { to: 'users',     label: 'Users & Teams',        group: 'PEOPLE & ACCESS', action: 'read', subject: 'User' },
  { to: 'roles',     label: 'Roles & Permissions',  group: 'PEOPLE & ACCESS', action: 'read', subject: 'Role' },
  { to: 'security',  label: 'Login & Security',     group: 'PEOPLE & ACCESS', action: 'read', subject: 'Organization' },
];

export default function SettingsLayout() {
  const ability = useAppAbility();
  const navigate = useNavigate();
  const location = useLocation();
  const [saver, setSaver] = useState<{ save: () => Promise<void> | void; discard: () => void; isDirty: boolean }>({ save: () => {}, discard: () => {}, isDirty: false });
  const [pendingLeave, setPendingLeave] = useState<null | (() => void)>(null);

  const registerSaver = useCallback((fns: typeof saver) => setSaver(fns), []);
  const visible = NAV.filter((n) => ability.can(n.action, n.subject));
  const groups = Array.from(new Set(visible.map((n) => n.group)));
  const current = visible.find((n) => location.pathname.includes(`/settings/${n.to}`));

  const guardedNav = (to: string) => {
    if (saver.isDirty) setPendingLeave(() => () => navigate(to));
    else navigate(to);
  };

  return (
    <Ctx.Provider value={{ registerSaver }}>
      <div className="flex gap-6">
        <nav className="w-56 shrink-0 space-y-6">
          {groups.map((g) => (
            <div key={g}>
              <p className="px-3 mb-1 text-xs font-semibold uppercase tracking-wide text-text-secondary">{g}</p>
              {visible.filter((n) => n.group === g).map((n) => (
                <NavLink key={n.to} to={n.to}
                  onClick={(e) => { if (saver.isDirty) { e.preventDefault(); guardedNav(`/settings/${n.to}`); } }}
                  className={({ isActive }) => `block rounded-lg px-3 py-2 text-sm font-medium transition-colors ${isActive ? 'bg-primary-subtle text-primary' : 'text-text-secondary hover:bg-background-light'}`}>
                  {n.label}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        <div className="flex-1 min-w-0">
          <div className="flex items-center justify-between mb-4 border-b border-border pb-3">
            <p className="text-sm text-text-secondary">Settings <span className="mx-1">›</span> <span className="text-text-primary font-medium">{current?.label}</span></p>
            <div className="flex items-center gap-2">
              <Button variant="ghost" size="sm" disabled={!saver.isDirty} onClick={() => saver.discard()}>Discard</Button>
              <Button size="sm" disabled={!saver.isDirty} onClick={() => saver.save()}>Save Changes</Button>
              <Button variant="ghost" size="icon" onClick={() => guardedNav('/dashboard')}><X className="h-4 w-4" /></Button>
            </div>
          </div>
          <Outlet />
        </div>
      </div>

      <AlertDialog open={!!pendingLeave} onOpenChange={(o) => !o && setPendingLeave(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Discard unsaved changes?</AlertDialogTitle>
            <AlertDialogDescription>You have unsaved changes that will be lost.</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel onClick={() => setPendingLeave(null)}>Keep editing</AlertDialogCancel>
            <AlertDialogAction onClick={() => { saver.discard(); const go = pendingLeave; setPendingLeave(null); go?.(); }}>Discard</AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </Ctx.Provider>
  );
}
```

- [ ] **Step 3: Wire routes in `App.tsx`.** Replace the single `/settings/organization` admin route with the nested block (keep it under the existing `AppLayout`; do NOT wrap in the ADMIN-only `ProtectedRoute` — menu items are CASL-filtered per item so Dispatchers can reach Locations). Import the new pages (lazy is fine, follow existing import style):

```tsx
<Route path="/settings" element={<SettingsLayout />}>
  <Route index element={<Navigate to="company" replace />} />
  <Route path="company" element={<CompanyProfilePage />} />
  <Route path="branding" element={<BrandingPage />} />
  <Route path="locations" element={<LocationsPage />} />
  <Route path="users" element={<UsersTeamsPage />} />
  <Route path="roles" element={<RolesPage />} />
  <Route path="security" element={<SecurityPage />} />
</Route>
```

Add `import { Navigate } from 'react-router-dom';` if not present. Keep the old `OrganizationSettingsPage` import until Task 7.1 removes it.

- [ ] **Step 4: Type-check** (`frontend/`: `npx tsc --noEmit`) — will fail until the 6 page components exist; create thin placeholders returning `<div/>` now so the app compiles, to be filled in Phase 6. Each placeholder must call `useSettingsBar()` no-op safe.

- [ ] **Step 5: Commit.** `git commit -m "feat(settings): nested settings shell (SettingsLayout) + routes + dirty guard"`

---

### Task 5.3: Header user menu + retire Sidebar gear

**Files:** Modify `frontend/src/components/layout/Header.tsx`, `frontend/src/components/layout/Sidebar.tsx`, `frontend/src/components/layout/nav-config.ts`

- [ ] **Step 1: Add menu items to the Header dropdown.** In `Header.tsx`, in the `DropdownMenuContent` (after the label/separator, before/around the Sign Out item), add:

```tsx
<DropdownMenuItem onClick={() => navigate('/settings/security')} className="gap-2 cursor-pointer">
  <UserIcon className="mr-2 h-4 w-4" /> My Profile
</DropdownMenuItem>
<DropdownMenuItem onClick={() => navigate('/settings/company')} className="gap-2 cursor-pointer">
  <SettingsIcon className="mr-2 h-4 w-4" /> Settings
</DropdownMenuItem>
<DropdownMenuSeparator />
```

Add imports: `import { User as UserIcon, Settings as SettingsIcon } from 'lucide-react';` and `useNavigate` from `react-router-dom` (if not already used). Keep the existing Sign Out item.

- [ ] **Step 2: Retire the Sidebar gear dropdown.** In `Sidebar.tsx`, remove the `visibleAdmin` footer dropdown block (lines ~275–313) — the settings entry now lives in the Header. Keep the `Users` management reachable via the Settings → Users & Teams screen. Remove now-unused `adminItems`/`visibleAdmin` references and the `SettingsIcon` import if it becomes unused (run tsc to confirm). In `nav-config.ts`, remove the `adminItems` export (or leave it unused but delete its consumers) — prefer deleting to avoid dead code.

- [ ] **Step 3: Type-check + manual smoke.** `npx tsc --noEmit`. Then `npm run dev:frontend` + `npm run dev:backend`, log in, click the top-right name → Settings → confirm the shell renders with the menu.

- [ ] **Step 4: Commit.** `git commit -m "feat(settings): promote Settings to header user menu; retire sidebar gear dropdown"`

---

### Task 5.4: Data hooks — locations, roles; extend Organization type

**Files:**
- Create: `frontend/src/lib/api/locations.ts`, `frontend/src/lib/api/roles.ts`
- Modify: `frontend/src/lib/api/organization.ts`

- [ ] **Step 1: `locations.ts`** (mirror `organization.ts` hook style):

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';

export interface Location {
  id: string; name: string; code: string;
  address_line1: string | null; address_line2: string | null;
  city: string | null; state: string | null; postal_code: string | null;
  country: string | null; timezone: string | null; phone: string | null;
  manager_id: string | null;
  manager?: { id: string; first_name: string; last_name: string } | null;
  _count?: { members: number };
}
export type LocationInput = Omit<Location, 'id' | 'manager' | '_count'>;

export function useLocations() {
  return useQuery<Location[]>({ queryKey: ['locations'], queryFn: () => api.get('/api/locations').then((r) => r.data) });
}
export function useCreateLocation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (d: Partial<LocationInput>) => api.post('/api/locations', d).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['locations'] }) });
}
export function useUpdateLocation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ id, ...d }: { id: string } & Partial<LocationInput>) => api.patch(`/api/locations/${id}`, d).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['locations'] }) });
}
export function useDeleteLocation() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (id: string) => api.delete(`/api/locations/${id}`).then((r) => r.data),
    onSuccess: () => qc.invalidateQueries({ queryKey: ['locations'] }) });
}
```

- [ ] **Step 2: `roles.ts`.**

```typescript
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import api from '@/lib/axios';

export interface RoleSummary { role: string; label: string; fullAccess: boolean; editable: boolean; userCount: number; type: string; }
export type ScopeValue = 'All' | 'Owned' | 'Team' | 'Location';
export interface RoleViewModel {
  role: string; editable: boolean;
  matrix: Record<string, { read: boolean; create: boolean; update: boolean; delete: boolean }>;
  sensitive: { seeFinancials: boolean; managePayments: boolean };
  scope: Record<string, ScopeValue>;
  general: { description: string };
}

export function useRoles() {
  return useQuery<RoleSummary[]>({ queryKey: ['roles'], queryFn: () => api.get('/api/roles').then((r) => r.data) });
}
export function useRolePermissions(role: string) {
  return useQuery<RoleViewModel>({ queryKey: ['roles', role, 'permissions'], queryFn: () => api.get(`/api/roles/${role}/permissions`).then((r) => r.data), enabled: !!role });
}
export function useUpdateRolePermissions() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: ({ role, vm }: { role: string; vm: Omit<RoleViewModel, 'editable'> }) => api.put(`/api/roles/${role}/permissions`, vm).then((r) => r.data),
    onSuccess: (_d, v) => qc.invalidateQueries({ queryKey: ['roles', v.role] }) });
}
export function useResetRole() {
  const qc = useQueryClient();
  return useMutation({ mutationFn: (role: string) => api.post(`/api/roles/${role}/reset`).then((r) => r.data),
    onSuccess: (_d, role) => qc.invalidateQueries({ queryKey: ['roles', role] }) });
}
```

- [ ] **Step 3: Extend `Organization` + `OrgFormValues`** in `organization.ts` — add the new fields to the interface (all optional/nullable): `display_name`, `tax_id`, `business_type`, `industry: string[]`, `support_email`, `billing_email`, `timezone`, `currency`, `date_format`, `mailing_same_as_hq: boolean`, `mailing_address_line1..country`, `customer_prefix`, `customer_next_number`, `mfa_sms_enabled`, `mfa_email_enabled`. (Mirror the existing nullable string pattern.)

- [ ] **Step 4: Type-check.** `npx tsc --noEmit`.
- [ ] **Step 5: Commit.** `git commit -m "feat(settings): frontend data hooks for locations & roles; extend org type"`

---

# PHASE 6 — Frontend screens

> For each page: build the form with React Hook Form + Zod (mirror `LeadFormPage.tsx`), read/write via the Phase-5 hooks, and **register save/discard/isDirty with `useSettingsBar()`** so the sub-bar drives them. Use the prototype (`prototype-v2.html`) for exact field grouping, labels, and copy. Use servwave indigo tokens only.

### Task 6.1: CompanyProfilePage (Profile + Numbering tabs)

**Files:** `frontend/src/pages/settings/CompanyProfilePage.tsx`

- [ ] **Step 1:** Build with shadcn `Tabs` (`profile`, `numbering`). Profile tab: Identity hero, General & Legal, Contact, Localization, Addresses with a `mailing_same_as_hq` shadcn `Switch` that conditionally renders the mailing block (`{!sameAsHq && <MailingBlock/>}`). Numbering tab: a 5-row table (Customers/Leads/Estimates/Jobs/Invoices) each with Prefix input + Next-number input + live preview computed as:

```tsx
const preview = (prefix: string, next: number | string, padding: number) =>
  `${prefix}${String(parseInt(String(next) || '0', 10)).padStart(padding, '0')}`;
```

(`padding` = `org.number_padding ?? 5`, not user-editable). Load defaults from `useOrganization()`; submit via `useUpdateOrganization()` sending only changed fields (RHF `formState.dirtyFields`). Register `{ save: form.handleSubmit(onSubmit), discard: () => form.reset(), isDirty: form.formState.isDirty }` with `useSettingsBar()` in an effect.

- [ ] **Step 2:** Type-check + manual: edit a field → sub-bar Save enables → Save → reload persists. Numbering preview shows `C00001`; typing `3243265` shows `C3243265`.
- [ ] **Step 3: Commit.** `git commit -m "feat(settings): Company Profile screen (Profile + Numbering tabs)"`

### Task 6.2: BrandingPage (Identity + Documents tabs)

**Files:** `frontend/src/pages/settings/BrandingPage.tsx`

- [ ] **Step 1:** Tabs `identity` (logo upload via `useUploadLogo()`, brand color hex input + palette swatches) and `documents` (template selector Alpha Classic / CRM Default backed by `estimate_template`, with the **Live Preview stacked directly below** using `GET /api/organization/preview-pdf` in an `<iframe>`/`<object>`; Invoice/Estimate toggle). Register saver.
- [ ] **Step 2:** Type-check + manual smoke.
- [ ] **Step 3: Commit.** `git commit -m "feat(settings): Branding & Templates screen"`

### Task 6.3: LocationsPage

**Files:** `frontend/src/pages/settings/LocationsPage.tsx`

- [ ] **Step 1:** shadcn `Table` of locations (`useLocations()`): Branch (name + code), Address, Time Zone, Manager (resolve via `useUsers({assignable:true})`), Staff count (`_count.members`). Row click opens an Edit panel (shadcn `Sheet` or inline card) with create/update via `useCreateLocation()`/`useUpdateLocation()`; "+ New Location" button; delete via `useDeleteLocation()` with a confirm AlertDialog (surface the 409 "users assigned" message). This page manages its own save (per-row), so register `isDirty:false` with the sub-bar (sub-bar Save stays disabled here).
- [ ] **Step 2:** Type-check + manual: create/edit/delete a location.
- [ ] **Step 3: Commit.** `git commit -m "feat(settings): Locations screen (branch table + editor)"`

### Task 6.4: UsersTeamsPage

**Files:** `frontend/src/pages/settings/UsersTeamsPage.tsx`

- [ ] **Step 1:** Tabs `users` and `teams`. Users: reuse existing user hooks (`useUsers`, `useCreateStaff`/create, `useUpdateUser`, `useDeactivateUser`) — table (Name, Email, Role, Team, Status, Last Login, Edit) + status filter chips + "+ Invite User" + "No login" badge (`has_login`). Teams: clickable `Department` cards (`useDepartments`) → members list; "+ Add Member" assigns `department_id` on a user; "Remove" nulls it. (Reuse whatever Users/Departments management already exists in `OrganizationSettingsPage`/`UsersPage` — lift those sections here rather than rewriting.)
- [ ] **Step 2:** Type-check + manual smoke.
- [ ] **Step 3: Commit.** `git commit -m "feat(settings): Users & Teams screen"`

### Task 6.5: RolesPage (data-driven) — keystone

**Files:** `frontend/src/pages/settings/RolesPage.tsx`

- [ ] **Step 1:** Left: roles list from `useRoles()` (label + userCount; ADMIN shows a "Full access" lock badge, `editable:false`). Right: when a role is selected, `useRolePermissions(role)` drives three tabs:
  - **Permissions:** 6×4 matrix of shadcn `Switch`es (`matrix[subject][read|create|update|delete]`), disabled when `!vm.editable`. Sensitive section: two switches (`seeFinancials`, `managePayments`).
  - **Data Scope:** for `Lead/Job/Estimate/Invoice` a 4-way segmented control (Owned/Team/Location/All), enabled only when that subject's `read` is on. For `Customer/Inventory`, render the same control but with Owned/Team/Location **disabled** + tooltip "No record-ownership field yet — applies at All". (Customer/Inventory are not in `vm.scope`; show All selected, disabled.)
  - **General:** role name (read-only for system roles), type, description.
  Local edit state seeded from the query; "Reset to default" calls `useResetRole()`. Register saver: `save` → `useUpdateRolePermissions().mutateAsync({ role, vm })` (strip `editable`), `isDirty` from local-vs-loaded diff.
- [ ] **Step 2:** Type-check + manual: edit SALES (e.g. turn on Create Customer, set Lead scope=Team) → Save → reload shows persisted; backend `RolePermission` rows updated; ADMIN selected → all switches on + disabled, Save hidden/disabled. Reset works.
- [ ] **Step 3: Commit.** `git commit -m "feat(settings): Roles & Permissions screen over CASL engine"`

### Task 6.6: SecurityPage

**Files:** `frontend/src/pages/settings/SecurityPage.tsx`

- [ ] **Step 1:** Two-Factor section: SMS + Email switches bound to `mfa_sms_enabled`/`mfa_email_enabled` via `useUpdateOrganization()` (persist org policy). Change Password: current/new/confirm form → `supabase.auth.updateUser({ password })` (import the frontend `supabase` client from `@/lib/supabase`); show success/error. Add the honest helper text from the spec §7 ("2FA enrollment depends on your login provider"). Register saver for the MFA toggles; password change saves on its own button.
- [ ] **Step 2:** Type-check + manual smoke.
- [ ] **Step 3: Commit.** `git commit -m "feat(settings): Login & Security screen (MFA policy + change password)"`

---

# PHASE 7 — Cleanup / decompose the monolith

### Task 7.1: Retire `OrganizationSettingsPage`, repoint old route, CASL-ize

**Files:** Modify `frontend/src/App.tsx`; delete/retire `frontend/src/pages/OrganizationSettingsPage.tsx`

- [ ] **Step 1:** Remove the old `/settings/organization` route + its `OrganizationSettingsPage` import. Add a redirect `/settings/organization → /settings/company` for any bookmarks. Confirm no other component imports `OrganizationSettingsPage`; if a piece of functionality (e.g. payment methods, source/job-type options, deposit %) lived only there and is NOT yet rehomed in a new screen, move it into the most appropriate new screen (Company Profile or Branding) — do not drop it. Grep first: `grep -rn "OrganizationSettingsPage\|/settings/organization" frontend/src`.
- [ ] **Step 2:** Replace any lingering `user?.role === 'ADMIN'` gates in the new screens with `ability.can('update','Organization')` (etc.).
- [ ] **Step 3: Type-check.** `npx tsc --noEmit` clean.
- [ ] **Step 4: Commit.** `git commit -m "refactor(settings): retire monolithic OrganizationSettingsPage; CASL-gate screens"`

---

# PHASE 8 — Verification

### Task 8.1: E2E — walk all six screens

**Files:** Create `frontend/e2e/pages/settings.page.ts`, `frontend/e2e/specs/settings.spec.ts`

- [ ] **Step 1:** Page object extends `BasePage`; `goto(screen)` → `page.goto('/settings/<screen>')`. Spec (admin storage state): open Settings from the header menu; assert each of the six menu items is visible; navigate each route and assert a known heading/field renders; on Company Profile edit a field, Save, reload, assert persisted; on Roles select SALES, toggle a permission, Save, assert success toast. Follow the `leads-list.spec.ts` pattern.
- [ ] **Step 2:** Run (from `frontend/`, both dev servers up): `npx playwright test --config=e2e/playwright.config.ts e2e/specs/settings.spec.ts` → PASS.
- [ ] **Step 3: Commit.** `git commit -m "test(settings): e2e walkthrough of all six settings screens"`

### Task 8.2: Full-suite gate + summary

- [ ] **Step 1: Backend:** `npm test --workspace=backend` → all green (record count).
- [ ] **Step 2: Frontend types:** from `frontend/`: `npx tsc --noEmit` → clean.
- [ ] **Step 3: Backend types:** from `backend/`: `npx tsc --noEmit` → clean.
- [ ] **Step 4:** Update the spec's §11 success criteria checklist (tick each) and write the handoff note: **migration `20260603120000_org_settings` is UNAPPLIED — deploy it to staging→prod via the normal pipeline before these features work against a real DB.**
- [ ] **Step 5: Final commit.** `git commit -m "chore(settings): verification pass + handoff notes"`

---

## Self-Review (against the spec)

- **§4.1 Company Profile (Profile+Numbering, mailing reveal, no padding):** Task 6.1 ✓; backend 4.1 ✓; numbering non-regress documented ✓.
- **§4.2 Branding (Identity + Documents stacked):** Task 6.2 ✓.
- **§4.3 Locations (new model + CRUD):** Tasks 0.1, 2.1, 6.3 ✓.
- **§4.4 Users & Teams:** Task 6.4 ✓ (reuses existing endpoints).
- **§4.5 Roles & Permissions (keystone; all roles editable except Owner/Admin; all 4 scope chips; payroll removed):** Tasks 3.1, 3.2, 6.5 ✓. Owner-backed-by-ADMIN reconciled ✓; Customer/Inventory scope honesty reconciled ✓; "Run payroll" absent ✓.
- **§4.6 Login & Security (MFA policy + change password):** Task 6.6 ✓; Supabase-dependence surfaced ✓.
- **§5 Data model (org columns, Location, User.location_id, numbering no-regress):** Task 0.1 ✓.
- **§6 Endpoints (org PATCH extend, Locations CRUD, Roles r/w, catalog mapping, scope tokens):** Tasks 1.x, 2.x, 3.x, 4.1 ✓.
- **§6.5 catalog Location/Role subjects:** Task 1.3 ✓ (frontend mirror 5.1).
- **§8 cross-cutting (multitenancy, CASL, TDD, audit, refactor-in-place):** isolation tests in 2.1/3.2; audit 4.2; decompose 7.1 ✓.
- **§9 completeness:** deferrals (business hours, SSO, audit screen, billing, integrations, custom roles, field-level visibility) remain out of scope by design — not implemented, consistent with spec.
- **Placeholder scan:** no TODO/TBD; every code step carries real code. The Task-3.1 test has a deliberately-noted bracket-typo step (3.1 Step 4) to fix before green.
- **Type consistency:** `RoleViewModel` shape identical across `roleViewModel.ts`, `role.controller.ts`, frontend `roles.ts`; `substituteConditions(conditions, ctx)` signature consistent across `defineAbility.ts` + tests; `writeSettingsAudit(req, eventType, metadata)` consistent across `audit.ts`, `location.controller.ts`, `role.controller.ts`.

---

## Implementation Status & Handoff (2026-06-03)

**Built on `feat/org-settings` (worktree `../alpha_crm-worktrees/org-settings`, off `servwave`). 14 commits.**

Verification gates (all green):
- Backend: **1416 vitest tests pass** (3 skipped); `tsc --noEmit` clean.
- Frontend: `tsc --noEmit` clean; **production `vite build` succeeds**.
- E2E spec written (`frontend/e2e/specs/settings.spec.ts`) — run against a live stack (both dev servers + admin storage state); not executed in the worktree (needs live Supabase auth).

### ⚠️ Action required before these features work against a real DB
Migration **`backend/prisma/migrations/20260603120000_org_settings/`** is **authored but UNAPPLIED** (worktree `.env` points at staging; we never run `migrate` from a worktree). Apply via the normal deploy pipeline (`DIRECT_URL`, port 5432) to staging → prod. Until applied, the new Organization columns / `Location` table / `User.location_id` don't exist in the DB and the Locations/profile/scope features will error at runtime.

### Decision taken in Phase 7 (legacy page kept — surfaced, not silent)
The new module's six screens deliberately do **not** cover everything the legacy `OrganizationSettingsPage` hosts: **Accepted Payment Methods, Default Deposit %, Estimate Document Copy (T&C/notes/payment terms), and Source / Job-Type option lists** (all outside the approved §4.1–4.6 scope). Rather than delete the monolith (which would silently drop those features) or balloon scope, the legacy page is **kept reachable** at `/settings/organization` via an **"Advanced → Documents, Payments & Lists"** bridge link in the new settings menu (CASL-gated on `update Organization`).
**Recommended follow-up:** migrate those four sections into dedicated Estimates/Payments settings screens, then retire `OrganizationSettingsPage`.

### Other follow-ups
- Distinct `OWNER` enum + billing/account-closure powers (MVP backs "Owner" with `ADMIN`).
- Arbitrary custom roles ("+ New custom role" is a placeholder) — needs `User.role` enum→string migration.
- 2FA toggles persist org policy; true enforcement depends on Supabase Auth config.
