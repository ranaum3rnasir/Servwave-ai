# Generalized Filter System Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking. Task headings are globally sequential integers (`### Task 1`, `### Task 2`, …) across all slices — required by the `task-brief` extraction script; the `## Slice N` headings above them are organizational only.

**Goal:** Replace every per-page, hard-coded filter with ONE metadata-driven filter system — a shared frontend `<FilterBar>` and a shared backend filter engine — so adding or renaming a column auto-updates the filter with the correct control and never requires editing filter code.

**Architecture:** A per-entity **field registry** (one object per entity, extending the existing TanStack column defs) is the single source of truth. The frontend `<FilterBar>` renders a two-pane popover by dispatching each registered facet on its `kind` (`multi` → searchable checkboxes, `range` → slider + From/To, `dateRange` → DateRangeField); identity fields are excluded from facets and routed to search. Filter state lives in the URL. The backend `applyFilters(engine)` reads the same registry to translate query params into a Prisma `where` that composes with `tenantWhere` + async `scopeWhereForReq` + `addOrFilter`, including count-across-relation ranges via a two-step `groupBy … having _count` → `id in/notIn`.

**Delivery shape — vertical slices, not phases:** each slice below (Leads, Jobs, Estimates, Invoices, Customers, Inventory, Cleanup) delivers one complete, working, independently-testable page end-to-end — its backend facets AND its frontend integration land together. **Slice 1 (Leads) is the reference slice**: because it's first, its tasks also build every piece of shared infrastructure (the filter engine's `multi`/`dateRange`/`countRange` kinds, `parseArrayParam`, and the entire `<FilterBar>` component family — slider, pane controls, chips, URL codec). Every later slice **reuses those files unchanged** and adds only the new engine `kind` or facet its own entity needs (e.g. Estimates is the first to need a plain numeric `range`; Inventory is the first with no server filtering at all). Never rebuild a shared file a later slice can import — if a task's brief tells you to create a file that already exists from an earlier slice, that's a signal to re-read the brief, not a green light to duplicate it.

**Tech Stack:** React 18 + TypeScript + TanStack Table + TanStack Query + Zustand; Node 20 + Express + Prisma 6 + Zod; Vitest (frontend) + Jest/Vitest backend tests.

## Global Constraints

- **Multi-tenancy:** every Prisma `where`/`count`/`groupBy`/`$queryRaw` must carry `tenantWhere(req)` (`organization_id`). Never build a query without it.
- **Row-scope safety:** base where is `{ ...tenantWhere(req), ...(await scopeWhereForReq(req, Subject)) }`; filters must NOT overwrite scope keys; relation filters AND-append; search injects ONLY via `addOrFilter` (`backend/src/lib/permissions/whereCompose.ts:24`) — never assign `where.OR`.
- **Design tokens:** no raw hex / raw Tailwind palette classes in components; use ServWave tokens (`frontend/src/design-system/tokens.css`). Light + dark both styled.
- **Numbers:** money shown comma-grouped via `formatCurrency`/`formatCurrencyWhole`.
- **No AI attribution** in any commit/PR text.
- **Branch flow:** cut a worktree off `origin/main` under `../alpha_crm-worktrees/`; PR against `staging` first; never `prisma migrate` from the worktree.
- **TDD:** backend isolation test before each controller/engine change; component test before each FilterBar behavior.
- **Sort-key allowlist:** a column's `id` used for sorting must stay in the backend `parseSortParams` allowlist.
- **Reuse over rebuild (vertical-slice discipline):** Tasks 10+ must import `filterEngine.ts`, `FilterBar.tsx`, `RangeSlider.tsx`, the pane controls, `types.ts`, `urlCodec.ts`, and `useFilterState.ts` from Slice 1 as-is. A later task may ADD a new `kind` branch to `filterEngine.ts`'s switch (e.g. Task 12 adds `range`) but must not duplicate or restructure what Slice 1 built.

---

## File Structure

### Backend (new + modified)
- Create `backend/src/lib/query/parseArrayParam.ts` — the single shared array-param parser (replaces 4 copies). **Task 1.**
- Create `backend/src/lib/query/filterEngine.ts` — `applyFilters(where, req, facets)` + `FacetDef` types + helper appliers (`equalsOrIn`, `relationSome`) + count-range helper. **Tasks 2, 3, 12 (incremental).**
- Create `backend/src/lib/query/registries/{lead,job,estimate,invoice,customer,inventoryItem}.filters.ts` — per-entity server facet registries. **Tasks 4, 10, 12, 14, 16, 18.**
- Modify each `backend/src/controllers/{lead,job,estimate,invoice,customer}.controller.ts` `build<X>ListWhere` to call the engine (delete bespoke param handling). **Tasks 4, 10, 12, 14, 16.**
- Modify `backend/src/controllers/inv-catalog.controller.ts` `listItems` — add pagination + engine-driven server filters (greenfield). **Task 18.**
- Modify `backend/src/lib/pagination.ts` sort allowlists as needed (per entity, inline in each entity's task).

### Frontend (new + modified)
- Create `frontend/src/lib/filters/types.ts` — `FacetConfig`, `FilterValue`, `FilterState` types. **Task 5.**
- Create `frontend/src/lib/filters/urlCodec.ts` — encode/decode `FilterState` ⇄ URLSearchParams. **Task 5.**
- Create `frontend/src/lib/filters/useFilterState.ts` — hook binding `FilterState` to the URL + producing `listParams`. **Task 5.**
- Create `frontend/src/components/filters/RangeSlider.tsx` — the dual-handle slider primitive (extracted from the approved mockup). **Task 6.**
- Create `frontend/src/components/filters/controls/{CheckboxFacet,RangeFacet,DateFacet}.tsx` — the three pane controls. **Task 7.**
- Create `frontend/src/components/filters/FilterBar.tsx` — the two-pane popover container (trigger + rail + pane + footer). **Task 8.**
- Create `frontend/src/components/filters/AppliedChips.tsx` — the chip strip (generic, registry-driven). **Task 8.**
- Create `frontend/src/lib/filters/registries/{leads,jobs,estimates,invoices,customers,inventory}.ts` — per-page facet configs. **Tasks 9, 11, 13, 15, 17, 19.**
- Modify `frontend/src/pages/{Leads,Jobs,Estimates,Invoices,Customers}Page.tsx` — replace bespoke filter state + `FilterPopover` composition with `<FilterBar registry={…} value={…} onChange={…}/>` + `useFilterState`. **Tasks 9, 11, 13, 15, 17.**
- Modify `frontend/src/pages/inventory/InventoryPage.tsx` — move from client-side `useInventoryFilters` to server-side list + `<FilterBar>`. **Task 19.**
- Delete (Task 20) `frontend/src/components/common/FilterPopover.tsx`, `components/inventory/FiltersPopover.tsx`, `components/inventory/useInventoryFilters.ts` once all pages migrated.

### Shared contract types (mirror on both sides)
`FacetKind = 'multi' | 'range' | 'dateRange'` on the frontend; the backend's `FacetDef` union adds `'countRange'` as a backend-only implementation detail of certain `range`-kind facets (from the FE's point of view a count facet is just a `range`). A facet's `param` names must match between the frontend registry and the backend registry — that's the wire contract.

---

## Interfaces (locked before any task)

```ts
// frontend/src/lib/filters/types.ts
export type FacetKind = 'multi' | 'range' | 'dateRange';

export interface FacetConfig {
  key: string;                 // stable id, also URL key
  label: string;               // rail label + chip prefix (reuse column header)
  icon: string;                // svg path d
  kind: FacetKind;
  // multi:
  options?: FacetOption[];     // static
  optionSource?: string;       // dynamic source id resolved by the page (users/org/etc.)
  // range:
  unit?: string;               // "estimates", "$"
  min?: number;                // domain floor (default 0)
  maxSource?: string;          // id the page resolves to a data-derived max
  money?: boolean;             // formats as currency
  // wire contract → backend param(s):
  param: string;               // multi: "status"; range: base → "min_total"/"max_total"; dateRange → "created_after"/"created_before"
}
export interface FacetOption { value: string; label: string; swatch?: string; }

export type FilterValue =
  | { kind: 'multi'; values: string[] }
  | { kind: 'range'; from: number | null; to: number | null }
  | { kind: 'dateRange'; from: string; to: string };   // 'YYYY-MM-DD'
export type FilterState = Record<string, FilterValue>;   // keyed by FacetConfig.key
```

```ts
// backend/src/lib/query/filterEngine.ts
export type FacetDef =
  | { key: string; kind: 'multi'; param: string; apply: MultiApply }
  | { key: string; kind: 'range'; minParam: string; maxParam: string; column: string }
  | { key: string; kind: 'dateRange'; afterParam: string; beforeParam: string; column: string }
  | { key: string; kind: 'countRange'; minParam: string; maxParam: string; countOn: CountSpec };

export interface CountSpec { model: string; groupField: string; }

// MultiApply is a (where, values: string[]) => void mutator that AND-appends safely.
export type MultiApply = (where: Record<string, any>, values: string[]) => void;

export async function applyFilters(
  where: Record<string, unknown>,
  req: Request,
  facets: FacetDef[],
  prisma?: PrismaClientLike,   // optional, added in Task 3; defaults to the real client, lets tests inject a test client
): Promise<void>;
```

**Incremental rollout of `FacetDef` kinds (do not implement ahead of schedule):** `multi` + `dateRange` land in Task 2. `countRange` lands in Task 3. `range` (plain numeric/money) lands in Task 12, when Estimates is the first entity that needs it. The full union above is the locked *contract* every task's code must type against, even before every branch is implemented — an unimplemented kind simply isn't in the `applyFilters` switch yet.

---

## Slice 1: Leads — reference integration (shared foundation + Leads page, end to end)

This is deliberately the largest slice: Leads is first, so its tasks build every piece of shared plumbing as well as delivering Leads' own working filter UI. Tasks 10 onward are pure delta on top of what this slice produces.

### Task 1: Hoist the shared `parseArrayParam`

**Files:**
- Create: `backend/src/lib/query/parseArrayParam.ts`
- Test: `backend/src/lib/query/parseArrayParam.test.ts`
- Modify: `backend/src/controllers/{lead,job,estimate,customer}.controller.ts` (remove local copies, import shared)
- Modify: `backend/src/controllers/invoice.controller.ts` (replace `.split(',')` for `status`)

**Interfaces:**
- Produces: `parseArrayParam(value: unknown): string[]`

- [ ] **Step 1: Write the failing test**
```ts
import { parseArrayParam } from './parseArrayParam';
describe('parseArrayParam', () => {
  it('returns [] for empty', () => expect(parseArrayParam(undefined)).toEqual([]));
  it('wraps a scalar', () => expect(parseArrayParam('NEW')).toEqual(['NEW']));
  it('passes arrays through, stringified + filtered', () =>
    expect(parseArrayParam(['NEW', '', 'WON'])).toEqual(['NEW', 'WON']));
  it('splits a comma string (invoice parity)', () =>
    expect(parseArrayParam('DRAFT,SENT')).toEqual(['DRAFT', 'SENT']));
});
```
- [ ] **Step 2: Run test to verify it fails** — `npm test --workspace=backend -- parseArrayParam` → FAIL (module not found).
- [ ] **Step 3: Write minimal implementation**
```ts
export function parseArrayParam(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) return value.map(String).filter(Boolean);
  const str = String(value);
  if (!str) return [];
  return str.includes(',') ? str.split(',').map(s => s.trim()).filter(Boolean) : [str];
}
```
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Replace the 4 local copies + invoice `.split(',')`** with `import { parseArrayParam } from '../lib/query/parseArrayParam';`; delete the inline defs at lead:346, customer:187, job:394, estimate:349; change invoice status to `parseArrayParam(req.query.status)`.
- [ ] **Step 6: Run each controller's list test** to confirm no behavior change → PASS.
- [ ] **Step 7: Commit** — `refactor(query): hoist shared parseArrayParam, normalize invoice status`.

### Task 2: Filter engine core (`multi` + `dateRange` + relation helpers)

**Files:**
- Create: `backend/src/lib/query/filterEngine.ts`
- Test: `backend/src/lib/query/filterEngine.test.ts`

**Interfaces:**
- Consumes: `parseArrayParam` (Task 1).
- Produces: `applyFilters(where, req, facets): Promise<void>`, `FacetDef` union (locked type above — only `multi`/`dateRange` branches implemented this task), `equalsOrIn(column): MultiApply`, `relationSome(relation, field): MultiApply`.

- [ ] **Step 1: Write the failing tests**
```ts
import { applyFilters, equalsOrIn, relationSome } from './filterEngine';

function reqWith(query: Record<string, unknown>) {
  return { query } as any;
}

const statusFacet = { key: 'status', kind: 'multi' as const, param: 'status', apply: equalsOrIn('status') };
const createdFacet = { key: 'created', kind: 'dateRange' as const, afterParam: 'created_after', beforeParam: 'created_before', column: 'created_at' };
const assigneeFacet = { key: 'assigned_to', kind: 'multi' as const, param: 'assigned_to', apply: relationSome('lead_assignees', 'user_id') };

describe('filterEngine: multi', () => {
  it('single value uses equals', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ status: 'NEW' }), [statusFacet]);
    expect(where.status).toBe('NEW');
  });
  it('many values use in', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ status: ['NEW', 'WON'] }), [statusFacet]);
    expect(where.status).toEqual({ in: ['NEW', 'WON'] });
  });
  it('relation helper nests under the relation key and AND-appends', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ assigned_to: ['u1', 'u2'] }), [assigneeFacet]);
    expect(where.lead_assignees).toEqual({ some: { user_id: { in: ['u1', 'u2'] } } });
  });
  it('missing param leaves where untouched', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({}), [statusFacet]);
    expect(where.status).toBeUndefined();
  });
});

describe('filterEngine: dateRange', () => {
  it('created_after/before -> gte/lte Date', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ created_after: '2026-01-01' }), [createdFacet]);
    expect((where.created_at as any).gte).toBeInstanceOf(Date);
  });
  it('only sets the bound that is present', async () => {
    const where: any = {};
    await applyFilters(where, reqWith({ created_before: '2026-02-01' }), [createdFacet]);
    expect(where.created_at).toEqual({ lte: new Date('2026-02-01') });
  });
});
```
- [ ] **Step 2: Run test to verify it fails** — module not found → FAIL.
- [ ] **Step 3: Write minimal implementation**
```ts
import { parseArrayParam } from './parseArrayParam';

export type MultiApply = (where: Record<string, any>, values: string[]) => void;

export function equalsOrIn(column: string): MultiApply {
  return (where, values) => {
    if (values.length === 0) return;
    where[column] = values.length === 1 ? values[0] : { in: values };
  };
}

export function relationSome(relation: string, field: string): MultiApply {
  return (where, values) => {
    if (values.length === 0) return;
    const filter = values.length === 1 ? values[0] : { in: values };
    where[relation] = {
      ...(where[relation] ?? {}),
      some: { ...(where[relation]?.some ?? {}), [field]: filter },
    };
  };
}

export interface CountSpec { model: string; groupField: string; }

export type FacetDef =
  | { key: string; kind: 'multi'; param: string; apply: MultiApply }
  | { key: string; kind: 'range'; minParam: string; maxParam: string; column: string }
  | { key: string; kind: 'dateRange'; afterParam: string; beforeParam: string; column: string }
  | { key: string; kind: 'countRange'; minParam: string; maxParam: string; countOn: CountSpec };

export async function applyFilters(
  where: Record<string, any>,
  req: { query: Record<string, unknown> },
  facets: FacetDef[],
): Promise<void> {
  for (const facet of facets) {
    if (facet.kind === 'multi') {
      facet.apply(where, parseArrayParam(req.query[facet.param]));
    } else if (facet.kind === 'dateRange') {
      const after = req.query[facet.afterParam];
      const before = req.query[facet.beforeParam];
      if (!after && !before) continue;
      const range: { gte?: Date; lte?: Date } = {};
      if (after) range.gte = new Date(String(after));
      if (before) range.lte = new Date(String(before));
      where[facet.column] = { ...(where[facet.column] ?? {}), ...range };
    }
    // 'range' lands in Task 12, 'countRange' lands in Task 3 — not yet implemented here.
  }
}
```
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `feat(query): generic filter engine (multi + dateRange)`.

### Task 3: Filter engine `countRange` (count-across-relation ranges)

**Files:**
- Modify: `backend/src/lib/query/filterEngine.ts` (add `applyCountRange`, wire the `countRange` branch)
- Test: `backend/src/lib/query/filterEngine.count.test.ts` (integration test against a seeded tenant + Prisma test client)

**Interfaces:**
- Consumes: `tenantWhere` (`backend/src/lib/tenant.ts`).
- Produces: `countRange` facet handling that AND-appends `{ id: { in|notIn } }` into `where`.

- [ ] **Step 1: Write failing integration test** — seed an org with three Leads, each owning 0, 2, and 5 Estimates respectively; assert:
  - `min_estimates=1&max_estimates=3` → only the 2-estimate lead.
  - `min_estimates=1` (no max) → the 2- and 5-estimate leads.
  - `max_estimates=0` → only the 0-estimate lead (zero-inclusive).
```ts
const countFacet = {
  key: 'estimates', kind: 'countRange' as const,
  minParam: 'min_estimates', maxParam: 'max_estimates',
  countOn: { model: 'estimate', groupField: 'lead_id' },
};

it('countRange: min+max narrows to the exact bucket', async () => {
  const where: any = { organization_id: org.id };
  await applyFilters(where, reqWithOrg(org, { min_estimates: '1', max_estimates: '3' }), [countFacet]);
  const rows = await prisma.lead.findMany({ where });
  expect(rows.map(r => r.id)).toEqual([twoEstimateLead.id]);
});

it('countRange: max=0 keeps zero-count rows', async () => {
  const where: any = { organization_id: org.id };
  await applyFilters(where, reqWithOrg(org, { max_estimates: '0' }), [countFacet]);
  const rows = await prisma.lead.findMany({ where });
  expect(rows.map(r => r.id)).toEqual([zeroEstimateLead.id]);
});
```
- [ ] **Step 2: Run test to verify it fails** — FAIL (`countRange` branch is a no-op).
- [ ] **Step 3: Implement `applyCountRange` and wire it into the switch**
```ts
import { tenantWhere } from '../tenant';

async function applyCountRange(
  where: Record<string, any>,
  req: { query: Record<string, unknown>; user?: { organization_id: string } },
  facet: Extract<FacetDef, { kind: 'countRange' }>,
  prisma: PrismaClientLike,
): Promise<void> {
  const minRaw = req.query[facet.minParam];
  const maxRaw = req.query[facet.maxParam];
  const min = minRaw != null ? Number(minRaw) : undefined;
  const max = maxRaw != null ? Number(maxRaw) : undefined;
  if (min === undefined && max === undefined) return;

  const { model, groupField } = facet.countOn;
  const tenantScope = tenantWhere(req as any);

  let includeIds: string[] | null = null;
  if (min !== undefined) {
    const groups = await (prisma as any)[model].groupBy({
      by: [groupField],
      where: tenantScope,
      _count: { _all: true },
      having: { [groupField]: { _count: { gte: min } } },
    });
    includeIds = groups.map((g: any) => g[groupField]);
  }

  let excludeIds: string[] | null = null;
  if (max !== undefined) {
    const overMax = await (prisma as any)[model].groupBy({
      by: [groupField],
      where: tenantScope,
      _count: { _all: true },
      having: { [groupField]: { _count: { gt: max } } },
    });
    excludeIds = overMax.map((g: any) => g[groupField]);
  }

  const mergeIdFilter = (idFilter: { in?: string[]; notIn?: string[] }) => {
    if (where.AND) {
      (where.AND as unknown[]).push({ id: idFilter });
    } else if (where.id) {
      where.AND = [{ id: where.id }, { id: idFilter }];
      delete where.id;
    } else {
      where.id = idFilter;
    }
  };

  if (includeIds && excludeIds) {
    mergeIdFilter({ in: includeIds });
    mergeIdFilter({ notIn: excludeIds });
  } else if (includeIds) {
    mergeIdFilter({ in: includeIds });
  } else if (excludeIds) {
    mergeIdFilter({ notIn: excludeIds });
  }
}
```
Wire it into `applyFilters`'s loop: `else if (facet.kind === 'countRange') { await applyCountRange(where, req, facet, prisma); }` — `applyFilters` must accept an injected `prisma` (default import from `../../lib/prisma`) so the test can pass a test client.
- [ ] **Step 4: Run test to verify it passes** — PASS.
- [ ] **Step 5: Commit** — `feat(query): count-across-relation range filtering`.

### Task 4: Leads server — registry + wire controller

**Files:**
- Create: `backend/src/lib/query/registries/lead.filters.ts`
- Modify: `backend/src/controllers/lead.controller.ts` `buildLeadListWhere` (~line 557) — replace the hand-rolled `status`/`job_type`/`ad_source`/`walkthrough_status`/`assigned_to`/`created_after`/`created_before` blocks with one `await applyFilters(...)` call; **do not touch** the search `addOrFilter` call, `scopeWhereForReq`, or any other non-facet logic.
- Test: extend `backend/src/controllers/lead.controller.test.ts` (or the equivalent list test file) with new multi-select + count-range assertions.

**Interfaces:**
- Consumes: `applyFilters`, `equalsOrIn`, `relationSome` (Tasks 2–3).
- Produces: `leadFacets: FacetDef[]` — the wire contract Task 9's frontend registry must match on `param` names.

- [ ] **Step 1: Write the failing controller test** — two techs assigned to different leads; assert `assigned_to=<userA>&assigned_to=<userB>` (repeated query key, as Express parses it into an array) returns leads assigned to either. Separately, seed leads with 0/2/5 estimates and assert `min_estimates=1&max_estimates=3` narrows to the 2-estimate lead (same pattern as Task 3's integration test, now through the live endpoint).
- [ ] **Step 2: Run** — `npm test --workspace=backend -- lead.controller` → FAIL.
- [ ] **Step 3: Write `lead.filters.ts`**
```ts
import { equalsOrIn, relationSome, FacetDef } from '../filterEngine';

export const leadFacets: FacetDef[] = [
  { key: 'status', kind: 'multi', param: 'status', apply: equalsOrIn('status') },
  { key: 'job_type', kind: 'multi', param: 'job_type', apply: equalsOrIn('job_type') },
  { key: 'ad_source', kind: 'multi', param: 'ad_source', apply: equalsOrIn('ad_source') },
  { key: 'walkthrough_status', kind: 'multi', param: 'walkthrough_status', apply: equalsOrIn('walkthrough_status') },
  {
    key: 'assigned_to', kind: 'multi', param: 'assigned_to',
    apply: (where, values) => {
      if (values.length === 0) return;
      if (values.includes('UNASSIGNED')) { where.lead_assignees = { none: {} }; return; }
      relationSome('lead_assignees', 'user_id')(where, values);
    },
  },
  { key: 'created', kind: 'dateRange', afterParam: 'created_after', beforeParam: 'created_before', column: 'created_at' },
  { key: 'estimates', kind: 'countRange', minParam: 'min_estimates', maxParam: 'max_estimates', countOn: { model: 'estimate', groupField: 'lead_id' } },
];
```
Before wiring the controller, re-read `buildLeadListWhere` (lead.controller.ts:557-673) to confirm the exact current column/enum names (`job_type` vs `type`, whether `ad_source` is the live column name) — the registry above must match the live schema, not this plan's guess; correct the `param`/column strings here if the controller uses different names.
- [ ] **Step 4: Wire the controller** — in `buildLeadListWhere`, delete the hand-rolled blocks for the facets above and replace with:
```ts
await applyFilters(where, req, leadFacets);
```
placed after the base `{ ...tenantWhere(req), ...scopeWhere }` is assembled and before the search `addOrFilter` call.
- [ ] **Step 5: Run** — PASS.
- [ ] **Step 6: Commit** — `feat(leads): drive list filters via shared engine`.

### Task 5: Filter types + URL codec + `useFilterState`

**Files:**
- Create: `frontend/src/lib/filters/types.ts` (the `FacetConfig`/`FilterState` types from the Interfaces section above)
- Create: `frontend/src/lib/filters/urlCodec.ts`
- Create: `frontend/src/lib/filters/useFilterState.ts`
- Test: `frontend/src/lib/filters/urlCodec.test.ts`

**Interfaces:**
- Produces: `encodeFilters(state): URLSearchParams`, `decodeFilters(params, registry): FilterState`, `useFilterState(registry): { value, setValue, listParams }`.

- [ ] **Step 1: Write the failing codec tests**
```ts
import { encodeFilters, decodeFilters } from './urlCodec';
import type { FacetConfig, FilterState } from './types';

const registry: FacetConfig[] = [
  { key: 'status', label: 'Status', icon: 'M0 0', kind: 'multi', param: 'status' },
  { key: 'estimates', label: '# of Estimates', icon: 'M0 0', kind: 'range', unit: 'estimates', min: 0, param: 'estimates' },
  { key: 'created', label: 'Created', icon: 'M0 0', kind: 'dateRange', param: 'created' },
];

it('encodes multi as a comma-joined param', () => {
  const state: FilterState = { status: { kind: 'multi', values: ['NEW', 'WON'] } };
  expect(encodeFilters(state, registry).get('status')).toBe('NEW,WON');
});

it('encodes an open-ended range with only the min bound', () => {
  const state: FilterState = { estimates: { kind: 'range', from: 3, to: null } };
  const params = encodeFilters(state, registry);
  expect(params.get('estimates_min')).toBe('3');
  expect(params.has('estimates_max')).toBe(false);
});

it('encodes dateRange using the facet param name', () => {
  const state: FilterState = { created: { kind: 'dateRange', from: '2026-01-01', to: '' } };
  expect(encodeFilters(state, registry).get('created_after')).toBe('2026-01-01');
});

it('decodes ignoring unknown keys and coercing per registry', () => {
  const params = new URLSearchParams('status=NEW,WON&estimates_min=1&unknown=x');
  const state = decodeFilters(params, registry);
  expect(state.status).toEqual({ kind: 'multi', values: ['NEW', 'WON'] });
  expect(state.estimates).toEqual({ kind: 'range', from: 1, to: null });
  expect(state.unknown).toBeUndefined();
});
```
- [ ] **Step 2: Run** — `npm test --workspace=frontend -- urlCodec` → FAIL.
- [ ] **Step 3: Implement**
```ts
// urlCodec.ts
import type { FacetConfig, FilterState, FilterValue } from './types';

export function encodeFilters(state: FilterState, registry: FacetConfig[]): URLSearchParams {
  const params = new URLSearchParams();
  for (const facet of registry) {
    const value = state[facet.key];
    if (!value) continue;
    if (value.kind === 'multi' && value.values.length > 0) {
      params.set(facet.param, value.values.join(','));
    } else if (value.kind === 'range') {
      if (value.from != null) params.set(`${facet.param}_min`, String(value.from));
      if (value.to != null) params.set(`${facet.param}_max`, String(value.to));
    } else if (value.kind === 'dateRange') {
      if (value.from) params.set(`${facet.param}_after`, value.from);
      if (value.to) params.set(`${facet.param}_before`, value.to);
    }
  }
  return params;
}

export function decodeFilters(params: URLSearchParams, registry: FacetConfig[]): FilterState {
  const state: FilterState = {};
  for (const facet of registry) {
    if (facet.kind === 'multi') {
      const raw = params.get(facet.param);
      if (raw) state[facet.key] = { kind: 'multi', values: raw.split(',').filter(Boolean) };
    } else if (facet.kind === 'range') {
      const min = params.get(`${facet.param}_min`);
      const max = params.get(`${facet.param}_max`);
      if (min != null || max != null) {
        state[facet.key] = { kind: 'range', from: min != null ? Number(min) : null, to: max != null ? Number(max) : null };
      }
    } else if (facet.kind === 'dateRange') {
      const from = params.get(`${facet.param}_after`);
      const to = params.get(`${facet.param}_before`);
      if (from || to) state[facet.key] = { kind: 'dateRange', from: from ?? '', to: to ?? '' };
    }
  }
  return state;
}
```
- [ ] **Step 4: Run** — PASS.
- [ ] **Step 5: Write `useFilterState.ts`**
```ts
import { useMemo, useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { FacetConfig, FilterState } from './types';
import { encodeFilters, decodeFilters } from './urlCodec';

export function useFilterState(registry: FacetConfig[]) {
  const [searchParams, setSearchParams] = useSearchParams();
  const value = useMemo(() => decodeFilters(searchParams, registry), [searchParams, registry]);

  const setValue = useCallback((next: FilterState) => {
    const encoded = encodeFilters(next, registry);
    // preserve non-filter params (page, sort, etc.) already on the URL
    const merged = new URLSearchParams(searchParams);
    for (const facet of registry) {
      merged.delete(facet.param);
      merged.delete(`${facet.param}_min`);
      merged.delete(`${facet.param}_max`);
      merged.delete(`${facet.param}_after`);
      merged.delete(`${facet.param}_before`);
    }
    encoded.forEach((v, k) => merged.set(k, v));
    setSearchParams(merged, { replace: true });
  }, [registry, searchParams, setSearchParams]);

  const listParams = useMemo(() => Object.fromEntries(encodeFilters(value, registry)), [value, registry]);

  return { value, setValue, listParams };
}
```
- [ ] **Step 6: Commit** — `feat(filters): FilterState types, URL codec, useFilterState`.

### Task 6: `RangeSlider` primitive

**Files:**
- Create: `frontend/src/components/filters/RangeSlider.tsx`
- Test: `frontend/src/components/filters/RangeSlider.test.tsx`

**Interfaces:**
- Produces: `<RangeSlider min max value={{from,to}} onChange />` (dual-handle, filled track). Port the approved mockup's slider from `filter-redesign.html` (two overlaid `<input type=range>`, filled segment between thumbs, in-place DOM update on drag for smoothness).

- [ ] **Step 1: Write the failing tests** — renders two range inputs; dragging the min thumb above the current max clamps it to max (and vice versa); `onChange` fires with the resulting `{from, to}`; when `to === max`, the value is treated as open-ended (`to: null`) on the next `onChange` (mirrors the mockup's "N+" behavior).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement** using ServWave tokens for the track/fill colors (`var(--primary)` fill, `var(--border)` track), two `<input type="range">` layered via `position:absolute`, and an in-place style update (`style.background = ...`) on `onInput` rather than a full re-render, so dragging stays smooth.
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `feat(filters): dual-handle RangeSlider`.

### Task 7: The three pane controls

**Files:**
- Create: `frontend/src/components/filters/controls/CheckboxFacet.tsx` (searchable list, per-value count, swatch, Select all/Deselect all, per-section Clear)
- Create: `frontend/src/components/filters/controls/RangeFacet.tsx` (wraps `RangeSlider` + From/To number fields + open-ended hint; money-formats via `formatCurrency` when `facet.money`)
- Create: `frontend/src/components/filters/controls/DateFacet.tsx` (wraps the existing `common/DateRangeField.tsx`)
- Tests for each.

**Interfaces:**
- Consumes: `RangeSlider` (Task 6), `FacetConfig`/`FilterValue` (Task 5), existing `common/DateRangeField.tsx`.
- Produces: each control's props are `{ facet: FacetConfig, value: FilterValue | undefined, onChange: (v: FilterValue) => void, options?: FacetOption[] }` (options passed in by `FilterBar` after resolving `optionSource`).

- [ ] **Step 1..N (TDD each):** `CheckboxFacet` filters the option list as the user types in its search box (only shown when `options.length > 6`, per the locked design); toggling a value updates `value.values`; "Clear <label>" (visible only when non-empty) empties only this facet, not others. `RangeFacet` renders `RangeSlider` plus two number inputs; leaving "To" blank yields `{ to: null }` and the applied-chip label is `"N+"`; a `money` facet formats the number fields' display via `formatCurrency` but stores raw numbers in state. `DateFacet` proxies `{from,to}` straight to `DateRangeField`'s existing props. Commit `feat(filters): checkbox/range/date pane controls`.

### Task 8: `FilterBar` + `AppliedChips`

**Files:**
- Create: `frontend/src/components/filters/FilterBar.tsx`
- Create: `frontend/src/components/filters/AppliedChips.tsx`
- Test: `frontend/src/components/filters/FilterBar.test.tsx`

**Interfaces:**
- Consumes: the three controls (Task 7), `FacetConfig[]`, `FilterState` (Task 5).
- Produces:
```tsx
<FilterBar
  registry={facets: FacetConfig[]}
  value={FilterState}
  onChange={(next: FilterState) => void}
  resolveOptions={(sourceId: string) => FacetOption[]}
  resolveMax={(sourceId: string) => number}
/>
<AppliedChips registry={FacetConfig[]} value={FilterState} onChange={(next: FilterState) => void} />
```

- [ ] **Step 1..N (TDD):** `FilterBar` renders one left-rail row per registered facet (icon + label + active-count badge), clicking a row swaps the right pane to that facet's control (dispatched by `kind`: `multi`→`CheckboxFacet`, `range`→`RangeFacet`, `dateRange`→`DateFacet`); dynamic `options`/`max` are resolved via `resolveOptions(facet.optionSource)` / `resolveMax(facet.maxSource)` before being passed to the control; global "Clear all" empties every facet in one call to `onChange({})`; the footer reads "N selected across M filters"; identity fields never appear because they are simply absent from `registry` (no special-case code needed — this is the mechanism that satisfies the "never hard-code filterable columns" mandate). `AppliedChips` renders one chip per non-empty facet value (multi: one chip per value or a "+N more"; range: `"3-8"`/`"3+"`/`"up to 8"`; dateRange: `"Jan 1 – Feb 1"`), each chip individually removable. Commit `feat(filters): FilterBar two-pane container + AppliedChips`.

### Task 9: Leads frontend — registry + page integration

**Files:**
- Create: `frontend/src/lib/filters/registries/leads.ts`
- Modify: `frontend/src/pages/LeadsPage.tsx` (or wherever the Leads list page lives — confirm exact path first) — replace bespoke filter `useState` + `FilterPopover` composition with `useFilterState(leadsRegistry)` + `<FilterBar>` + `<AppliedChips>`.
- Test: a page-level test asserting URL + request-param wiring.

**Interfaces:**
- Consumes: `FilterBar`/`AppliedChips` (Task 8), `useFilterState` (Task 5).
- Produces: `leadsRegistry: FacetConfig[]` whose `param` values match `leadFacets` from Task 4 exactly (the wire contract).

- [ ] **Step 1: Write `leads.ts` registry** — one `FacetConfig` per Task 4 facet: Status (multi, static `LEAD_STATUSES` options), Source (multi, `optionSource: 'org.sourceOptions'`), Type (multi, `optionSource: 'org.jobTypeOptions'`), Assigned To (multi, `optionSource: 'assignableUsers'`, must include an `UNASSIGNED` option), Walkthrough (multi, static `WALKTHROUGH_FILTERS`), **# of Estimates** (range, `unit: 'estimates'`, `min: 0`, `maxSource: 'leads.maxEstimates'`, `param: 'estimates'`), Created (dateRange, `param: 'created'`).
- [ ] **Step 2: Write the failing page test** — setting the Status multi-select and the # of Estimates range updates both the URL query string and the params passed to the leads list query.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Wire the page** — swap in `useFilterState`, render `<FilterBar>`/`<AppliedChips>`, feed `listParams` into the existing react-query call, delete the old bespoke chip/clear-all code.
- [ ] **Step 5: Preserve the KPI-tile → preset wiring** — the dashboard tiles must call `setValue(presetState)` where `presetState` is a `FilterState` built from the tile's semantics (e.g. the "Won this month" tile sets `{status: {kind:'multi', values:['WON']}, created: {kind:'dateRange', from: startOfMonth, to: today}}`); verify the page's `activeKpi` highlight logic still derives correctly from `FilterState` rather than the old ad-hoc filter shape.
- [ ] **Step 6: Run** → PASS.
- [ ] **Step 7: Manually verify in the dev server** — open Leads, exercise each facet, confirm the URL updates and chips/clear behave per the locked design, in both light and dark mode.
- [ ] **Step 8: Commit** — `feat(leads): adopt generalized FilterBar + URL state`.

---

## Slice 2: Jobs

### Task 10: Jobs server — registry + wire controller

No new engine `kind` is needed here — Jobs' facets are all `multi` (including two relation-based ones) and `dateRange`, both already built in Task 2.

**Files:**
- Create: `backend/src/lib/query/registries/job.filters.ts`
- Modify: `backend/src/controllers/job.controller.ts` `buildJobListWhere` (~line 518-560) — replace the hand-rolled `assigned_to`/`department_id` block with facets; keep the Needs-invoice toggle and every other non-facet block untouched.
- Test: extend the Jobs list controller test.

**Interfaces:**
- Consumes: `applyFilters`, `equalsOrIn`, `relationSome` (Task 2).
- Produces: `jobFacets: FacetDef[]`.

- [ ] **Step 1: Write the failing test** — assert `department_id=<d1>&department_id=<d2>` (multi-select departments) returns jobs whose assignee belongs to either department, AND still composes correctly when `assigned_to` is also set (both must AND-merge into the same `where.assignees.some`, per the current code's comment at job.controller.ts:551-560 about not clobbering a role-scoped `where.assignees`).
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Write `job.filters.ts`** — Department needs a custom applier because the real relation path is two levels deep (`assignees.some.user.department_id`, confirmed at job.controller.ts:555), one level deeper than the generic `relationSome` helper handles:
```ts
import { equalsOrIn, relationSome, FacetDef } from '../filterEngine';

export const jobFacets: FacetDef[] = [
  { key: 'status', kind: 'multi', param: 'status', apply: equalsOrIn('status') },
  { key: 'assigned_to', kind: 'multi', param: 'assigned_to', apply: relationSome('assignees', 'user_id') },
  {
    key: 'department_id', kind: 'multi', param: 'department_id',
    apply: (where, values) => {
      if (values.length === 0) return;
      const filter = values.length === 1 ? values[0] : { in: values };
      where.assignees = {
        ...(where.assignees ?? {}),
        some: {
          ...(where.assignees?.some ?? {}),
          user: { ...(where.assignees?.some?.user ?? {}), department_id: filter },
        },
      };
    },
  },
  { key: 'customer_id', kind: 'multi', param: 'customer_id', apply: equalsOrIn('customer_id') },
  { key: 'scheduled', kind: 'dateRange', afterParam: 'scheduled_after', beforeParam: 'scheduled_before', column: 'scheduled_date' },
  { key: 'created', kind: 'dateRange', afterParam: 'created_after', beforeParam: 'created_before', column: 'created_at' },
];
```
Note: the comments at job.controller.ts:1313/1431 about `assignees.some.user.department_id` making `can()` throw refer to unrelated RBAC permission-condition code, not `buildJobListWhere` — do not touch that code in this task.
- [ ] **Step 4: Wire the controller** — replace the hand-rolled `assignedTo`/`departmentId` block (job.controller.ts:521-560) with `await applyFilters(where, req, jobFacets);`, keeping the surrounding AND-merge-with-role-scope logic intact (the facet appliers already merge correctly since they read `where.assignees` before overwriting, matching the existing merge behavior).
- [ ] **Step 5: Run** → PASS.
- [ ] **Step 6: Commit** — `feat(jobs): drive list filters via shared engine`.

### Task 11: Jobs frontend — registry + page integration

**Files:**
- Create: `frontend/src/lib/filters/registries/jobs.ts`
- Modify: the Jobs list page — same recipe as Task 9: swap bespoke filter state for `useFilterState(jobsRegistry)` + `<FilterBar>`/`<AppliedChips>`; keep the Needs-invoice toggle as a small standalone control outside the registry (it isn't a facet).
- Test: page-level URL/request-param wiring test, mirroring Task 9's.

**Interfaces:**
- Produces: `jobsRegistry: FacetConfig[]` matching `jobFacets` (Task 10) `param` names exactly: Status (multi), Assigned To (multi, `optionSource:'assignableUsers'`), Department (multi, `optionSource:'departments'`), Customer (multi, `optionSource:'recentCustomers'` or similar — confirm the page's existing customer-picker data source and reuse it), Scheduled (dateRange), Created (dateRange).

- [ ] **Step 1: Write the registry.** **Step 2: Write the failing page test.** **Step 3: Run → FAIL.** **Step 4: Wire the page, preserving the Needs-invoice toggle.** **Step 5: Run → PASS.** **Step 6: Manually verify in the dev server** (facets + toggle + dark mode). **Step 7: Commit** — `feat(jobs): adopt generalized FilterBar + URL state`.

---

## Slice 3: Estimates

### Task 12: Filter engine `range` kind + Estimates server — registry + wire controller

This is the first entity needing a plain numeric/money range (not a count-across-relation), so this task both extends the shared engine and delivers Estimates in one deliverable — the two are inseparable (Estimates wiring cannot be tested until `range` exists).

**Files:**
- Modify: `backend/src/lib/query/filterEngine.ts` (add the `range` branch)
- Modify: `backend/src/lib/query/filterEngine.test.ts` (add range coverage)
- Create: `backend/src/lib/query/registries/estimate.filters.ts`
- Modify: `backend/src/controllers/estimate.controller.ts` `buildEstimateListWhere` (~line 562) — replace hand-rolled `created_by`/`lead_id`/`deposit_status`/`customer_id`/`min_total`/`max_total` blocks with facets.
- Test: extend the Estimates list controller test.

**Interfaces:**
- Produces: the `range` branch of `applyFilters`; `estimateFacets: FacetDef[]`.

- [ ] **Step 1: Write the failing engine test**
```ts
const totalFacet = { key: 'total', kind: 'range' as const, minParam: 'min_total', maxParam: 'max_total', column: 'total_amount' };

it('range: min_total/max_total -> gte/lte on the mapped column', async () => {
  const where: any = {};
  await applyFilters(where, reqWith({ min_total: '100', max_total: '500' }), [totalFacet]);
  expect(where.total_amount).toEqual({ gte: 100, lte: 500 });
});
it('range: blank max is open-ended', async () => {
  const where: any = {};
  await applyFilters(where, reqWith({ min_total: '100' }), [totalFacet]);
  expect(where.total_amount).toEqual({ gte: 100 });
});
```
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Implement the `range` branch** in `applyFilters`'s loop:
```ts
} else if (facet.kind === 'range') {
  const minRaw = req.query[facet.minParam];
  const maxRaw = req.query[facet.maxParam];
  const min = minRaw != null ? Number(minRaw) : NaN;
  const max = maxRaw != null ? Number(maxRaw) : NaN;
  if (Number.isNaN(min) && Number.isNaN(max)) continue;
  const range: { gte?: number; lte?: number } = {};
  if (!Number.isNaN(min)) range.gte = min;
  if (!Number.isNaN(max)) range.lte = max;
  where[facet.column] = { ...(where[facet.column] ?? {}), ...range };
}
```
- [ ] **Step 4: Run** → PASS. **Step 5: Commit** — `feat(query): plain numeric/money range kind`.
- [ ] **Step 6: Write the failing Estimates controller test** — `created_by` multi (two sales reps), `deposit_status` multi, `min_total`/`max_total` narrowing.
- [ ] **Step 7: Run** → FAIL.
- [ ] **Step 8: Write `estimate.filters.ts`**
```ts
import { equalsOrIn, FacetDef } from '../filterEngine';

export const estimateFacets: FacetDef[] = [
  { key: 'status', kind: 'multi', param: 'status', apply: equalsOrIn('status') },
  { key: 'created_by', kind: 'multi', param: 'created_by', apply: equalsOrIn('created_by') },
  { key: 'deposit_status', kind: 'multi', param: 'deposit_status', apply: equalsOrIn('deposit_status') },
  { key: 'customer_id', kind: 'multi', param: 'customer_id', apply: equalsOrIn('customer_id') },
  { key: 'total', kind: 'range', minParam: 'min_total', maxParam: 'max_total', column: 'total_amount' },
  { key: 'created', kind: 'dateRange', afterParam: 'created_after', beforeParam: 'created_before', column: 'created_at' },
];
```
Confirm the live column/enum names against `buildEstimateListWhere` (estimate.controller.ts:562+) before finalizing — `deposit_status` in particular was audited as "mapped" (may need a custom applier if it isn't a direct scalar column); adjust if so.
- [ ] **Step 9: Wire the controller**, keeping `lead_id` as a facet too (audited as needing scalar→array) and preserving search/scope logic untouched.
- [ ] **Step 10: Run** → PASS. **Step 11: Commit** — `feat(estimates): drive list filters via shared engine`.

### Task 13: Estimates frontend — registry + page integration

**Files:**
- Create: `frontend/src/lib/filters/registries/estimates.ts`
- Modify: the Estimates list page (same recipe as Task 9/11).
- Test: page-level URL/request-param wiring test.

**Interfaces:**
- Produces: `estimatesRegistry: FacetConfig[]` matching `estimateFacets` (Task 12): Status (multi), Created By (multi, `optionSource:'assignableUsers'`), Deposit (multi), Total (range, `money: true`, `maxSource:'estimates.maxTotal'`), Customer (multi), Created (dateRange).

- [ ] Same 7-step recipe as Task 9 (registry → failing test → wire page → verify → commit `feat(estimates): adopt generalized FilterBar + URL state`). The Total facet is the first `RangeFacet` usage with `money: true` in production — visually confirm currency formatting via `formatCurrency` in the dev server.

---

## Slice 4: Invoices

### Task 14: Invoices server — registry + wire controller

Reuses `range` (Task 12) for both Total and the new Balance facet; no new engine kind. `status` is already array-capable as of Task 1's `.split(',')` replacement.

**Files:**
- Create: `backend/src/lib/query/registries/invoice.filters.ts`
- Modify: `backend/src/controllers/invoice.controller.ts` `buildInvoiceListWhere` (~line 811) — replace hand-rolled blocks with facets; **add** the new `amount_due` range (closes the audited gap: invoices had a Total range but no Balance range); keep the Overdue toggle untouched.
- Test: extend the Invoices list controller test with a `min_balance`/`max_balance` case.

**Interfaces:**
- Produces: `invoiceFacets: FacetDef[]`.

- [ ] **Step 1: Write the failing test** — seed invoices with different `amount_due`; assert `min_balance=100&max_balance=500` narrows correctly, and `status=DRAFT,SENT` (array form, matching every other entity now) still works.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Write `invoice.filters.ts`**
```ts
import { equalsOrIn, FacetDef } from '../filterEngine';

export const invoiceFacets: FacetDef[] = [
  { key: 'status', kind: 'multi', param: 'status', apply: equalsOrIn('status') },
  { key: 'customer_id', kind: 'multi', param: 'customer_id', apply: equalsOrIn('customer_id') },
  { key: 'total', kind: 'range', minParam: 'min_total', maxParam: 'max_total', column: 'total_amount' },
  { key: 'balance', kind: 'range', minParam: 'min_balance', maxParam: 'max_balance', column: 'amount_due' },
  { key: 'created', kind: 'dateRange', afterParam: 'created_after', beforeParam: 'created_before', column: 'created_at' },
  { key: 'due', kind: 'dateRange', afterParam: 'due_after', beforeParam: 'due_before', column: 'due_date' },
];
```
- [ ] **Step 4: Wire the controller**, keeping the Overdue (`overdue=true`) toggle as-is (it isn't a facet — it's a computed predicate, not user-driven range/multi).
- [ ] **Step 5: Run** → PASS. **Step 6: Commit** — `feat(invoices): drive list filters via shared engine, add balance range`.

### Task 15: Invoices frontend — registry + page integration

**Files:**
- Create: `frontend/src/lib/filters/registries/invoices.ts`
- Modify: the Invoices list page (same recipe).
- Test: page-level wiring test.

**Interfaces:**
- Produces: `invoicesRegistry: FacetConfig[]`: Status (multi), Total (range, money), **Balance** (range, money — new), Customer (multi), Created (dateRange), Due (dateRange); keep Overdue toggle.

- [ ] Same 7-step recipe as Task 9/13, confirming the previously comma-string `status` param now round-trips correctly as an array through the new codec. Commit `feat(invoices): adopt generalized FilterBar + URL state`.

---

## Slice 5: Customers

### Task 16: Customers server — registry + wire controller

Reuses `countRange` (Task 3) across **two different relations** on the same model (`leads` and `jobs`) — this is the test that the `countOn: {model, groupField}` design is genuinely generic, not Leads-specific.

**Files:**
- Create: `backend/src/lib/query/registries/customer.filters.ts`
- Modify: `backend/src/controllers/customer.controller.ts` `buildCustomerListWhere` (~line 297-357) — replace hand-rolled `ad_source`/`state`/`payment_type`/`tax_exempt` blocks with facets, **add** `min_leads`/`max_leads` and `min_jobs`/`max_jobs` countRange facets (new); **keep** `has_leads`/`has_jobs`/`open_leads`/`active_jobs`/`include_archived` exactly as they are today (lines 352-357) — those are tri-state existence toggles, not ranges, and are out of this plan's scope.
- Test: extend the Customers list controller test with `min_jobs`/`max_jobs` and `min_leads`/`max_leads` cases.

**Interfaces:**
- Produces: `customerFacets: FacetDef[]`.

- [ ] **Step 1: Write the failing test** — seed customers with 0/2/5 jobs and 0/3 leads (independently); assert `min_jobs=1&max_jobs=3` and `min_leads=1` each narrow correctly and don't interfere with each other.
- [ ] **Step 2: Run** → FAIL.
- [ ] **Step 3: Write `customer.filters.ts`** — `tax_exempt` becomes a 2-option checkbox facet (`'true'`/`'false'` string values mapped to the boolean column, matching the audited existing `taxExempt === 'true'`/`'false'` string-compare pattern at customer.controller.ts:349-350):
```ts
import { equalsOrIn, FacetDef } from '../filterEngine';

export const customerFacets: FacetDef[] = [
  { key: 'ad_source', kind: 'multi', param: 'ad_source', apply: equalsOrIn('ad_source') },
  { key: 'state', kind: 'multi', param: 'state', apply: equalsOrIn('state') },
  { key: 'payment_type', kind: 'multi', param: 'payment_type', apply: equalsOrIn('payment_type') },
  {
    key: 'tax_exempt', kind: 'multi', param: 'tax_exempt',
    apply: (where, values) => {
      if (values.length !== 1) return; // both or neither selected = no filter
      where.tax_exempt = values[0] === 'true';
    },
  },
  { key: 'leads', kind: 'countRange', minParam: 'min_leads', maxParam: 'max_leads', countOn: { model: 'lead', groupField: 'customer_id' } },
  { key: 'jobs', kind: 'countRange', minParam: 'min_jobs', maxParam: 'max_jobs', countOn: { model: 'job', groupField: 'customer_id' } },
  { key: 'created', kind: 'dateRange', afterParam: 'created_after', beforeParam: 'created_before', column: 'created_at' },
];
```
- [ ] **Step 4: Wire the controller**, keeping the existing `has_leads`/`has_jobs`/`open_leads`/`active_jobs`/`include_archived` blocks (customer.controller.ts:352-357) completely untouched — they compose alongside `applyFilters`'s output in the same `where`, not through it.
- [ ] **Step 5: Run** → PASS. **Step 6: Commit** — `feat(customers): drive list filters via shared engine, add leads/jobs count ranges`.

### Task 17: Customers frontend — registry + page integration

**Files:**
- Create: `frontend/src/lib/filters/registries/customers.ts`
- Modify: the Customers list page (same recipe).
- Test: page-level wiring test.

**Interfaces:**
- Produces: `customersRegistry: FacetConfig[]`: Source (multi), Payment Type (multi), Tax Exempt (multi, 2 static options), **# of Leads** (range), **# of Jobs** (range), State (multi), Created (dateRange); keep the existing Show-archived toggle and KPI-flag wiring exactly as-is.

- [ ] Same 7-step recipe as Task 9. Commit `feat(customers): adopt generalized FilterBar + URL state`.

---

## Slice 6: Inventory

Inventory has **no server-side filtering today** (100% client-side via `useInventoryFilters`) and doesn't use `DataTable`. This slice gives it real server-side filtering for the first time — the biggest single lift in the plan.

### Task 18: Inventory server — pagination + engine-driven filters (greenfield)

**Files:**
- Modify: `backend/src/controllers/inv-catalog.controller.ts` `listItems` (~line 163) — add `parsePagination`/`parseSortParams` (currently absent) and `applyFilters` with a new registry.
- Create: `backend/src/lib/query/registries/inventoryItem.filters.ts`
- Test: a new `inv-catalog.controller.test.ts` list-endpoint test (create if it doesn't exist).

**Interfaces:**
- Produces: `inventoryItemFacets: FacetDef[]`. The `stockStates` facet is **derived** (computed from on-hand stock vs. reorder thresholds for the active location, not a stored column) — implement it as a dedicated post-query filter, not a `FacetDef`: after the paginated Prisma query returns, compute each item's stock state the same way the current client-side `useInventoryFilters` does (read that hook before writing this, to match its exact thresholds), and if `req.query.stock_state` is present, filter the page's rows by membership. Document this as a known limitation of moving a derived facet server-side (see Step 4) rather than silently mismatching pagination counts.

- [ ] **Step 1: Read `frontend/src/components/inventory/useInventoryFilters.ts`** to extract the exact current stock-state thresholds/logic (do not guess these — they must match exactly, or items will appear to change state when the same data moves from client to server filtering).
- [ ] **Step 2: Write the failing test** — `kind=<X>&vendor=<Y>` narrows results server-side; pagination metadata (`buildPaginationMeta`) reflects the filtered count, not the unfiltered total.
- [ ] **Step 3: Run** → FAIL.
- [ ] **Step 4: Write `inventoryItem.filters.ts`** (Kind, Trade, Vendor, Category — all `multi`; Flags serialized/hazmat as boolean-style `multi` mirroring Task 16's `tax_exempt` pattern) and wire `listItems` to call `parsePagination`/`parseSortParams`/`applyFilters`, then apply the derived `stock_state` post-filter from Step 1 before paginating (paginate AFTER the derived filter, not before, so counts stay correct — this may mean fetching a wider unpaginated set when `stock_state` is present and paginating in-memory; note this tradeoff in the PR description per Task 21).
- [ ] **Step 5: Run** → PASS. **Step 6: Commit** — `feat(inventory): server-side pagination + engine-driven filters`.

### Task 19: InventoryPage frontend — adopt FilterBar (client → server migration)

**Files:**
- Create: `frontend/src/lib/filters/registries/inventory.ts`
- Modify: `frontend/src/pages/inventory/InventoryPage.tsx` — remove the client-side `useInventoryFilters` call, add a react-query list call against the now-filtered `listItems` endpoint (Task 18), feed it `useFilterState(inventoryRegistry).listParams`, move `search` to the server `search` param, render `<FilterBar>`/`<AppliedChips>`.
- Test: page-level test confirming facet changes drive the server request (not client-side array filtering).

**Interfaces:**
- Produces: `inventoryRegistry: FacetConfig[]` matching Task 18's facets, plus a `stock_state` facet (`kind: 'multi'`, static options) wired to the same `param: 'stock_state'` the backend's derived post-filter reads.

- [ ] **Step 1: Write the registry.** **Step 2: Write the failing page test.** **Step 3: Run → FAIL.** **Step 4: Wire the page**, keeping the stats tiles working (recompute them from the server response's counts, or add a lightweight `/stats` call if the tiles need totals independent of the current filter — confirm which behavior the current tiles have before changing it). **Step 5: Run → PASS.** **Step 6: Manually verify in the dev server** — this is the page most likely to regress silently since it changes from client to server filtering; check that item counts and stock-state badges match what the old client-side page showed for the same data. **Step 7: Commit** — `feat(inventory): server-side filtering via FilterBar`.

---

## Slice 7: Cleanup + release

### Task 20: Remove dead filter code + update legacy filter tests

**Files:**
- Delete: `frontend/src/components/common/FilterPopover.tsx`, `frontend/src/components/inventory/FiltersPopover.tsx`, `frontend/src/components/inventory/useInventoryFilters.ts`.
- Delete (only if fully superseded — verify no remaining import first): `common/AmountRange.tsx`, `common/DateRangeFilter.tsx` (keep `common/DateRangeField.tsx` — Task 7's `DateFacet` wraps it, it is not superseded).
- Modify: `__tests__/customers-filter-no-state.test.tsx`, `filter-popover-viewport.test.tsx` (or wherever they now live) to target `<FilterBar>` instead of the deleted `FilterPopover`.

- [ ] **Step 1:** Grep the frontend for any remaining import of each file slated for deletion; if none, delete. If any remain, fix that call site first (it means an earlier slice's task missed a spot).
- [ ] **Step 2:** Update the two legacy filter tests to exercise `<FilterBar>`'s equivalent behavior instead of asserting against the deleted component.
- [ ] **Step 3:** Run the full frontend + backend test suites; run `npx tsc --noEmit` in `frontend/`.
- [ ] **Step 4: Commit** — `refactor(filters): remove superseded per-page filter code`.

### Task 21: Manual verify all 6 pages + open PR

- [ ] **Step 1:** Start the dev server; for each of Leads, Jobs, Estimates, Invoices, Customers, Inventory: open each facet, confirm the correct control renders (checkboxes/range/date), confirm the URL updates and is shareable (reload the URL and confirm filters persist), confirm chips + per-section Clear + global Clear all all work, confirm both light and dark mode render correctly per ServWave tokens.
- [ ] **Step 2:** Confirm the Leads KPI-tile presets (Task 9) and the Customers KPI-flag wiring (Task 17) still work.
- [ ] **Step 3:** Open ONE PR against `staging` titled `feat(filters): generalized metadata-driven filter system`, body listing all 6 pages, the shared engine, URL state, and the new Inventory server-side migration + Invoice balance range as notable additions; no AI attribution, per the Global Constraints.

---

## Self-Review notes
- **Spec coverage:** two-pane ✓ (Task 8), checkboxes-only ✓ (Task 7 CheckboxFacet), numeric ranges + open-ended ✓ (Tasks 6-7), per-section + global clear ✓ (Tasks 7-8), metadata-driven registries ✓ (one per entity, Tasks 4/10/12/14/16/18), shared backend engine ✓ (Tasks 2/3/12), count ranges ✓ (Tasks 3, applied to 3 distinct relations across Tasks 4/16), URL state ✓ (Task 5), all 6 pages incl. Inventory ✓ (Slices 1-6), identity-fields-to-search ✓ (mechanism: registries simply omit them).
- **Vertical-slice discipline check:** each slice after Slice 1 adds strictly less than Slice 1 — Jobs (Task 10-11) adds zero new engine code, Estimates (Task 12-13) adds one new engine kind, Invoices (14-15) adds zero, Customers (16-17) adds zero (reuses countRange across a second relation), Inventory (18-19) is the outlier requiring real new backend work because it started with none. This ordering is intentional: the reference slice (Leads) is expensive, every following slice should get cheaper except where the entity itself demands new capability.
- **Open verification during build:** exact per-controller column/enum names for facets this plan named by best audit knowledge (`job_type` vs `type`, `deposit_status` mapping, `ad_source`/`state` column names) — each task's steps explicitly say to confirm against the live controller before finalizing the registry, per the "never hallucinate" project rule. Inventory's derived `stock_state` predicate (Task 18) is the highest-risk item — its thresholds must be read from the existing client hook, not reinvented.
- **Risks:** big diff even sliced vertically (mitigate: commit per task, one task reviewer gate per task per subagent-driven-development); count-range perf on large orgs (index `organization_id` + FK, already covered by Task 3's design; re-validate under Task 16's dual-relation case); URL schema is a compat surface (keep keys minimal/stable — locked in Task 5); Inventory's paginate-after-derived-filter tradeoff (Task 18 Step 4) should be flagged explicitly in the final PR description, not left implicit.
