/**
 * The Roles editor must not be able to WIDEN a grant it cannot express.
 *
 * Found while landing PR 3 of the technician-ownership spec, and it is the sharpest edge in that
 * change. The Roles UI models row scope as a single four-way chip per subject - All / Owned / Team /
 * Location - and `viewModelToGrants` stamps the chosen chip's condition onto read, update AND delete
 * for that subject on every Save. That is lossless only while every persisted condition is one of
 * the four. PR 3 persists two that are not:
 *
 *   read Job    { OR: [ own-job, created-by-me ] }   - assigned OR created
 *   delete Job  { created_by_id }                    - creator only
 *
 * Left alone, `assembleRoleViewModel` matches neither against its chip table, reports the Jobs scope
 * as "All", and the next Save an admin performs for ANY unrelated reason - ticking a Vendors box -
 * posts that back and rewrites both rows to `conditions: null`. Every technician in the org would
 * then read, edit and DELETE every job in it. One click, no warning, nothing on screen that said so.
 *
 * Two independent fixes, both asserted here, because either alone leaves a hole:
 *   1. the chip must read "Owned" for the widened Job read, so the UI stops lying about the scope;
 *   2. a Save must PRESERVE any existing condition the editor cannot represent, so even a stale tab
 *      or a hand-rolled PUT cannot clobber it.
 *
 * Fix 2 is the load-bearing one: it is a property of the writer, so it holds for conditions that do
 * not exist yet as well as these two.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { Prisma } from '@prisma/client';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { assembleRoleViewModel, viewModelToGrants } from '../lib/permissions/roleViewModel';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

const OWN_JOB = { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } };
const CREATED_BY_ME = { created_by_id: '{{userId}}' };
const OWN_OR_CREATED = { OR: [OWN_JOB, CREATED_BY_ME] };

/** The technician grants exactly as PR 3 ships them. */
const TECHNICIAN_GRANTS = DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN').map(
  ({ action, subject, conditions }) => ({ action, subject, conditions: conditions ?? null }),
);

describe('the Jobs scope chip tells the truth about a creator-widened read', () => {
  it('reads "Owned" for assigned-OR-created, not "All"', () => {
    const vm = assembleRoleViewModel('TECHNICIAN', TECHNICIAN_GRANTS);
    expect(vm.scope.Job).toBe('Owned');
  });

  it('still reads "Owned" for the plain own-job shape (every other role, and pre-backfill orgs)', () => {
    const vm = assembleRoleViewModel('DISPATCHER', [
      { action: 'read', subject: 'Job', conditions: OWN_JOB },
    ]);
    expect(vm.scope.Job).toBe('Owned');
  });

  it('still reads "All" for a genuinely unconditioned read', () => {
    const vm = assembleRoleViewModel('DISPATCHER', [
      { action: 'read', subject: 'Job', conditions: null },
    ]);
    expect(vm.scope.Job).toBe('All');
  });
});

describe('PUT /api/roles/:role/permissions preserves a condition the editor cannot express', () => {
  let upsert: ReturnType<typeof vi.fn>;

  /** Save the role's own round-tripped view model - the no-op an admin performs constantly. */
  async function saveRoundTrip(existing: { action: string; subject: string; conditions: unknown }[]) {
    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
    const vm = assembleRoleViewModel('TECHNICIAN', existing as never);
    return request(app).put('/api/roles/TECHNICIAN/permissions').set(authHeader('admin')).send(vm);
  }

  /** The conditions the transaction was asked to write for one (action, subject). */
  function written(action: string, subject: string) {
    const call = upsert.mock.calls.find(
      ([args]) =>
        args.where.organization_id_role_action_subject.action === action &&
        args.where.organization_id_role_action_subject.subject === subject,
    );
    expect(call, `no upsert for ${action} ${subject}`).toBeDefined();
    return call![0].update.conditions;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    upsert = vi.fn().mockResolvedValue({});
    (prisma.$transaction as never as ReturnType<typeof vi.fn>).mockImplementation((fn: never) =>
      (fn as unknown as (tx: unknown) => unknown)({
        rolePermission: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), upsert },
      }),
    );
  });

  it('leaves the creator-widened read Job condition exactly as it found it', async () => {
    const res = await saveRoundTrip(TECHNICIAN_GRANTS);
    expect(res.status).toBe(200);
    expect(written('read', 'Job')).toEqual(OWN_OR_CREATED);
  });

  it('leaves the creator-only delete Job condition exactly as it found it', async () => {
    const res = await saveRoundTrip(TECHNICIAN_GRANTS);
    expect(res.status).toBe(200);
    // The chip says "Owned", so an unprotected Save would stamp OWN_JOB here and hand every
    // ASSIGNED technician the ability to delete the job.
    expect(written('delete', 'Job')).toEqual(CREATED_BY_ME);
  });

  // PRESERVATION MUST NOT BECOME UNREVOKABLE. Both role.controller.ts and roleViewModel.ts assert in
  // comments that unticking the box still deletes the row - the preservation only touches the UPSERT
  // path, never the toDelete pass. Nothing tested it, and if it ever leaked across, an admin would
  // silently lose the only way to take a creator-scoped grant away.
  it('still DELETES an unrepresentable-condition grant when the admin unticks the box', async () => {
    const deleteMany = vi.fn().mockResolvedValue({ count: 1 });
    (prisma.$transaction as never as ReturnType<typeof vi.fn>).mockImplementation((fn: never) =>
      (fn as unknown as (tx: unknown) => unknown)({ rolePermission: { deleteMany, upsert } }),
    );
    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(TECHNICIAN_GRANTS);

    const vm = assembleRoleViewModel('TECHNICIAN', TECHNICIAN_GRANTS as never);
    vm.matrix.Job = { ...vm.matrix.Job!, delete: false };  // the admin unticks Jobs > Delete
    const res = await request(app).put('/api/roles/TECHNICIAN/permissions').set(authHeader('admin')).send(vm);

    expect(res.status).toBe(200);
    const removed = deleteMany.mock.calls.flatMap(([args]) => args.where.OR ?? []);
    expect(removed).toContainEqual({ action: 'delete', subject: 'Job' });
    // ...and it is genuinely gone, not re-upserted by the preservation pass on the way out.
    const reWritten = upsert.mock.calls.some(
      ([args]) =>
        args.where.organization_id_role_action_subject.action === 'delete' &&
        args.where.organization_id_role_action_subject.subject === 'Job',
    );
    expect(reWritten).toBe(false);
  });

  it('still WRITES the chip condition onto a row whose existing condition IS representable', async () => {
    // The preservation must not become "never change anything" - narrowing a role's data scope in
    // the UI has to keep working. Same role, but with the stock own-job read a pre-backfill org has.
    const existing = TECHNICIAN_GRANTS.map((g) =>
      g.action === 'read' && g.subject === 'Job' ? { ...g, conditions: OWN_JOB } : g,
    );
    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(existing);
    const vm = assembleRoleViewModel('TECHNICIAN', existing as never);
    vm.scope.Job = 'All';
    const res = await request(app).put('/api/roles/TECHNICIAN/permissions').set(authHeader('admin')).send(vm);
    expect(res.status).toBe(200);
    // Prisma.JsonNull is how a null condition is written through the client.
    expect(written('read', 'Job')).toBe(Prisma.JsonNull);
  });
});

describe('viewModelToGrants is unchanged - the preservation lives in the writer', () => {
  // Stated as a test so nobody "fixes" this by teaching the emitter a fifth chip value. The emitter
  // can only ever speak the four the UI has; the writer is what knows about the rest.
  it('still emits the chip condition for Job, not the creator-widened one', () => {
    const grants = viewModelToGrants({
      role: 'TECHNICIAN',
      matrix: { Job: { read: true, create: false, update: true, delete: true } },
      sensitive: { seeFinancials: false, managePayments: false, viewReports: false },
      scope: { Job: 'Owned' },
      general: { description: '' },
    } as never);
    const read = grants.find((g) => g.action === 'read' && g.subject === 'Job');
    expect(read?.conditions).toEqual(OWN_JOB);
  });
});

/**
 * #2042 — a NON-scope-subject can now carry a persisted condition too. `PurchaseOrder` and
 * `LogisticOrder` are MODULES subjects (matrix CRUD cells) but not SCOPE_ENTITIES, so
 * `isRepresentableScopeCondition`'s old early return said `true` for ANY condition on them - "not
 * a scope subject, so nothing to lose" - which was correct only while no such subject ever
 * carried one. #2042 makes it carry one (SALES's job-scoped `read PurchaseOrder`), so the old
 * early return would let an ordinary Save of the SALES role (ticking an unrelated box) silently
 * re-widen it to `conditions: null` - org-wide - the moment `viewModelToGrants` stamps its
 * always-null matrix-cell value back over it.
 */
describe('#2042 — a persisted condition on a non-scope-subject (PurchaseOrder) survives a Save', () => {
  const OWN_VIA_JOB = { job: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } } };

  /** The SALES grants exactly as #2042 ships them. */
  const SALES_GRANTS = DEFAULT_GRANTS.filter((g) => g.role === 'SALES').map(
    ({ action, subject, conditions }) => ({ action, subject, conditions: conditions ?? null }),
  );

  let upsert: ReturnType<typeof vi.fn>;

  function written(action: string, subject: string) {
    const call = upsert.mock.calls.find(
      ([args]) =>
        args.where.organization_id_role_action_subject.action === action &&
        args.where.organization_id_role_action_subject.subject === subject,
    );
    expect(call, `no upsert for ${action} ${subject}`).toBeDefined();
    return call![0].update.conditions;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    upsert = vi.fn().mockResolvedValue({});
    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(SALES_GRANTS);
    (prisma.$transaction as never as ReturnType<typeof vi.fn>).mockImplementation((fn: never) =>
      (fn as unknown as (tx: unknown) => unknown)({
        rolePermission: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), upsert },
      }),
    );
  });

  it('leaves the job-scoped read PurchaseOrder condition exactly as it found it', async () => {
    const vm = assembleRoleViewModel('SALES', SALES_GRANTS as never);
    const res = await request(app).put('/api/roles/SALES/permissions').set(authHeader('admin')).send(vm);
    expect(res.status).toBe(200);
    expect(written('read', 'PurchaseOrder')).toEqual(OWN_VIA_JOB);
  });

  it('leaves the unconditional read Vendor condition null (nothing to preserve, nothing to widen)', async () => {
    const vm = assembleRoleViewModel('SALES', SALES_GRANTS as never);
    const res = await request(app).put('/api/roles/SALES/permissions').set(authHeader('admin')).send(vm);
    expect(res.status).toBe(200);
    expect(written('read', 'Vendor')).toBe(Prisma.JsonNull);
  });

  it('leaves the job-scoped update/delete LogisticOrder conditions exactly as found', async () => {
    const vm = assembleRoleViewModel('SALES', SALES_GRANTS as never);
    const res = await request(app).put('/api/roles/SALES/permissions').set(authHeader('admin')).send(vm);
    expect(res.status).toBe(200);
    expect(written('update', 'LogisticOrder')).toEqual(OWN_VIA_JOB);
    expect(written('delete', 'LogisticOrder')).toEqual(OWN_VIA_JOB);
  });
});

/**
 * #2042 security fix round 1 (F3) — the preservation pass above (`isRepresentableScopeCondition`)
 * only fires when a row still EXISTS to preserve. Unticking a non-scope-subject box in the Roles
 * UI and saving legitimately DELETES the row (revocation must keep working); re-ticking it and
 * saving again finds no `current` row, so `viewModelToGrants`'s always-`null` value used to land
 * verbatim — the round trip un-scopes SALES to org-wide reads/writes with no UI control that can
 * put the scope back. `role.controller.ts`'s `!current` branch now seeds a brand-new row from the
 * role's own DEFAULT_GRANTS bundle instead, for subjects with no scope chip (PurchaseOrder,
 * LogisticOrder).
 */
describe('#2042 security fix round 1 (F3) — untick + Save + retick + Save restores the scoped condition', () => {
  const OWN_VIA_JOB = { job: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } } };

  const SALES_GRANTS = DEFAULT_GRANTS.filter((g) => g.role === 'SALES').map(
    ({ action, subject, conditions }) => ({ action, subject, conditions: conditions ?? null }),
  );
  // The four rows the untick step removes: PurchaseOrder>View and LogisticOrder>Create/Edit/Delete.
  const REMOVED = [
    { action: 'read', subject: 'PurchaseOrder' },
    { action: 'create', subject: 'LogisticOrder' },
    { action: 'update', subject: 'LogisticOrder' },
    { action: 'delete', subject: 'LogisticOrder' },
  ];
  const AFTER_UNTICK = SALES_GRANTS.filter(
    (g) => !REMOVED.some((r) => r.action === g.action && r.subject === g.subject),
  );

  let upsert: ReturnType<typeof vi.fn>;
  let deleteMany: ReturnType<typeof vi.fn>;

  function written(action: string, subject: string) {
    const call = upsert.mock.calls.find(
      ([args]) =>
        args.where.organization_id_role_action_subject.action === action &&
        args.where.organization_id_role_action_subject.subject === subject,
    );
    expect(call, `no upsert for ${action} ${subject}`).toBeDefined();
    return call![0].update.conditions;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    upsert = vi.fn().mockResolvedValue({});
    deleteMany = vi.fn().mockResolvedValue({ count: REMOVED.length });
    (prisma.$transaction as never as ReturnType<typeof vi.fn>).mockImplementation((fn: never) =>
      (fn as unknown as (tx: unknown) => unknown)({ rolePermission: { deleteMany, upsert } }),
    );
  });

  it('SALES: the four unticked rows are deleted, then restored job-scoped on retick — not left null', async () => {
    // Step 1 — untick: PurchaseOrder>View off, LogisticOrder>Create/Edit/Delete off.
    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(SALES_GRANTS);
    const untickVm = assembleRoleViewModel('SALES', SALES_GRANTS as never);
    untickVm.matrix.PurchaseOrder = { ...untickVm.matrix.PurchaseOrder!, read: false };
    untickVm.matrix.LogisticOrder = {
      ...untickVm.matrix.LogisticOrder!,
      create: false, update: false, delete: false,
    };
    const untickRes = await request(app).put('/api/roles/SALES/permissions').set(authHeader('admin')).send(untickVm);
    expect(untickRes.status).toBe(200);
    const removed = deleteMany.mock.calls.flatMap(([args]) => args.where.OR ?? []);
    for (const r of REMOVED) expect(removed).toContainEqual(r);

    // Step 2 — retick, from the state Step 1 actually left behind (the four rows are GONE, so
    // `existingByKey` misses them on this Save — the exact trigger the finding names).
    vi.clearAllMocks();
    upsert = vi.fn().mockResolvedValue({});
    deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    (prisma.$transaction as never as ReturnType<typeof vi.fn>).mockImplementation((fn: never) =>
      (fn as unknown as (tx: unknown) => unknown)({ rolePermission: { deleteMany, upsert } }),
    );
    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(AFTER_UNTICK);
    const retickVm = assembleRoleViewModel('SALES', AFTER_UNTICK as never);
    retickVm.matrix.PurchaseOrder = { ...retickVm.matrix.PurchaseOrder!, read: true };
    retickVm.matrix.LogisticOrder = {
      ...retickVm.matrix.LogisticOrder!,
      create: true, update: true, delete: true,
    };
    const retickRes = await request(app).put('/api/roles/SALES/permissions').set(authHeader('admin')).send(retickVm);
    expect(retickRes.status).toBe(200);

    expect(written('read', 'PurchaseOrder')).toEqual(OWN_VIA_JOB);
    expect(written('create', 'LogisticOrder')).toEqual(OWN_VIA_JOB);
    expect(written('update', 'LogisticOrder')).toEqual(OWN_VIA_JOB);
    expect(written('delete', 'LogisticOrder')).toEqual(OWN_VIA_JOB);
  });

  it("DISPATCHER: the same untick/retick round trip keeps its unconditional defaults unchanged", async () => {
    const DISPATCHER_GRANTS = DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER').map(
      ({ action, subject, conditions }) => ({ action, subject, conditions: conditions ?? null }),
    );
    const AFTER_UNTICK_DISPATCHER = DISPATCHER_GRANTS.filter(
      (g) => !(g.action === 'create' && g.subject === 'LogisticOrder'),
    );

    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(DISPATCHER_GRANTS);
    const untickVm = assembleRoleViewModel('DISPATCHER', DISPATCHER_GRANTS as never);
    untickVm.matrix.LogisticOrder = { ...untickVm.matrix.LogisticOrder!, create: false };
    await request(app).put('/api/roles/DISPATCHER/permissions').set(authHeader('admin')).send(untickVm);

    vi.clearAllMocks();
    upsert = vi.fn().mockResolvedValue({});
    deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    (prisma.$transaction as never as ReturnType<typeof vi.fn>).mockImplementation((fn: never) =>
      (fn as unknown as (tx: unknown) => unknown)({ rolePermission: { deleteMany, upsert } }),
    );
    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(AFTER_UNTICK_DISPATCHER);
    const retickVm = assembleRoleViewModel('DISPATCHER', AFTER_UNTICK_DISPATCHER as never);
    retickVm.matrix.LogisticOrder = { ...retickVm.matrix.LogisticOrder!, create: true };
    const res = await request(app).put('/api/roles/DISPATCHER/permissions').set(authHeader('admin')).send(retickVm);

    expect(res.status).toBe(200);
    expect(written('create', 'LogisticOrder')).toBe(Prisma.JsonNull);
  });

  it('ADMIN: the role stays full-access and un-editable — the seeding branch is unreachable for it', async () => {
    const res = await request(app).put('/api/roles/ADMIN/permissions').set(authHeader('admin')).send({});
    expect(res.status).toBe(400);
  });
});

/**
 * #2042 security round 2 (B) — the round-1 seed above looks the bundle up by the row's `role`
 * COLUMN, which for a custom role holds its OWN key ('sales-senior'), never 'SALES'. So the rescue
 * never fired for a role CLONED from SALES, although `createRole` seeds such a role from
 * `DEFAULT_GRANTS.filter(g => g.role === base_role)` and the #2042 migration conditioned its rows
 * by SHAPE (deliberately, so a SALES-derived custom role is covered). Untick → Save → retick →
 * Save therefore widened exactly the grants the migration had just scoped. The seed now resolves
 * the custom role's `base_role` — the same field `createRole` and `resetRole` read — and seeds
 * from THAT role's bundle.
 */
describe('#2042 security round 2 (B) — a SALES-derived CUSTOM role is seeded from its base role', () => {
  const OWN_VIA_JOB = { job: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } } };
  const CUSTOM_KEY = 'sales-senior';

  const bundle = (role: string) =>
    DEFAULT_GRANTS.filter((g) => g.role === role).map(({ action, subject, conditions }) => ({
      action,
      subject,
      conditions: conditions ?? null,
    }));

  const REMOVED = [
    { action: 'read', subject: 'PurchaseOrder' },
    { action: 'create', subject: 'LogisticOrder' },
    { action: 'update', subject: 'LogisticOrder' },
    { action: 'delete', subject: 'LogisticOrder' },
  ];

  let upsert: ReturnType<typeof vi.fn>;
  let deleteMany: ReturnType<typeof vi.fn>;

  function wireTx() {
    upsert = vi.fn().mockResolvedValue({});
    deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    (prisma.$transaction as never as ReturnType<typeof vi.fn>).mockImplementation((fn: never) =>
      (fn as unknown as (tx: unknown) => unknown)({ rolePermission: { deleteMany, upsert } }),
    );
  }

  function written(action: string, subject: string) {
    const call = upsert.mock.calls.find(
      ([args]) =>
        args.where.organization_id_role_action_subject.action === action &&
        args.where.organization_id_role_action_subject.subject === subject,
    );
    expect(call, `no upsert for ${action} ${subject}`).toBeDefined();
    return call![0].update.conditions;
  }

  /** The custom_roles row `resolveCustomRole` reads — keyed on the custom key, carrying base_role. */
  function wireCustomRole(baseRole: string | null) {
    (prisma.customRole.findFirst as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'cr-1',
      organization_id: '00000000-0000-0000-0000-000000000001',
      key: CUSTOM_KEY,
      label: 'Senior Sales',
      description: '',
      base_role: baseRole,
      archived_at: null,
    });
  }

  /** untick the four non-scope-subject boxes, Save; then retick from the state that Save left. */
  async function untickThenRetick(baseGrants: { action: string; subject: string; conditions: unknown }[]) {
    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(baseGrants);
    const untickVm = assembleRoleViewModel(CUSTOM_KEY, baseGrants as never);
    untickVm.matrix.PurchaseOrder = { ...untickVm.matrix.PurchaseOrder!, read: false };
    untickVm.matrix.LogisticOrder = {
      ...untickVm.matrix.LogisticOrder!,
      create: false, update: false, delete: false,
    };
    const untick = await request(app)
      .put(`/api/roles/${CUSTOM_KEY}/permissions`)
      .set(authHeader('admin'))
      .send(untickVm);
    expect(untick.status).toBe(200);

    const after = baseGrants.filter(
      (g) => !REMOVED.some((r) => r.action === g.action && r.subject === g.subject),
    );
    wireTx();
    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(after);
    const retickVm = assembleRoleViewModel(CUSTOM_KEY, after as never);
    retickVm.matrix.PurchaseOrder = { ...retickVm.matrix.PurchaseOrder!, read: true };
    retickVm.matrix.LogisticOrder = {
      ...retickVm.matrix.LogisticOrder!,
      create: true, update: true, delete: true,
    };
    const retick = await request(app)
      .put(`/api/roles/${CUSTOM_KEY}/permissions`)
      .set(authHeader('admin'))
      .send(retickVm);
    expect(retick.status).toBe(200);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    wireTx();
  });

  it('base_role SALES: the round trip restores OWN_VIA_JOB on all four rows, not null', async () => {
    wireCustomRole('SALES');
    await untickThenRetick(bundle('SALES'));

    expect(written('read', 'PurchaseOrder')).toEqual(OWN_VIA_JOB);
    expect(written('create', 'LogisticOrder')).toEqual(OWN_VIA_JOB);
    expect(written('update', 'LogisticOrder')).toEqual(OWN_VIA_JOB);
    expect(written('delete', 'LogisticOrder')).toEqual(OWN_VIA_JOB);
  });

  it('base_role DISPATCHER: the same round trip keeps its unconditional defaults', async () => {
    wireCustomRole('DISPATCHER');
    await untickThenRetick(bundle('DISPATCHER'));

    expect(written('read', 'PurchaseOrder')).toBe(Prisma.JsonNull);
    expect(written('create', 'LogisticOrder')).toBe(Prisma.JsonNull);
    expect(written('update', 'LogisticOrder')).toBe(Prisma.JsonNull);
  });

  // DOCUMENTED RESIDUAL. `base_role` is NOT NULL in the schema (custom_roles.base_role is the Role
  // enum), so the only base with no DEFAULT_GRANTS bundle is ADMIN — an ADMIN-derived custom role
  // is seeded from `buildFullGrantSet()` at creation and is meant to be full-access-minus-what-the
  // -admin-subtracts, so an unconditional brand-new row is the CORRECT answer for it, not a leak.
  // The `null` arm is defence for a row that somehow carries no base at all.
  it('base_role ADMIN (no bundle to seed from): the brand-new row stays unconditional, as designed', async () => {
    wireCustomRole('ADMIN');
    await untickThenRetick(bundle('SALES'));

    expect(written('read', 'PurchaseOrder')).toBe(Prisma.JsonNull);
    expect(written('create', 'LogisticOrder')).toBe(Prisma.JsonNull);
  });

  it('no base_role at all: the brand-new row keeps conditions null (fail-open is the pre-existing shape)', async () => {
    wireCustomRole(null);
    await untickThenRetick(bundle('SALES'));

    expect(written('read', 'PurchaseOrder')).toBe(Prisma.JsonNull);
  });
});

/**
 * #2041 R8 — a Roles-page Save preserves SALES's row-scoped `read`/`update Customer` (OWN_CUSTOMER).
 * `Customer` is NOT in `roleViewModel.ts`'s `SCOPE_ENTITIES` (R2, deliberately — see that file and
 * spec.md's amendment), so `isRepresentableScopeCondition` treats OWN_CUSTOMER exactly the way it
 * already treats PurchaseOrder/LogisticOrder's job-scoped conditions above: unrepresentable by the
 * chip UI, therefore preserved verbatim by `putRolePermissions`'s existing-row branch. Same
 * mechanism, same file, same test shape — pinned separately because Customer is the subject this
 * issue is actually about.
 */
describe('#2041 R8 — a persisted OWN_CUSTOMER condition on read/update Customer survives a Save', () => {
  const OWN_CUSTOMER = {
    OR: [
      { leads: { some: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
      { jobs: { some: { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } } } },
      { created_by_id: '{{userId}}' },
    ],
  };

  const SALES_GRANTS = DEFAULT_GRANTS.filter((g) => g.role === 'SALES').map(
    ({ action, subject, conditions }) => ({ action, subject, conditions: conditions ?? null }),
  );

  let upsert: ReturnType<typeof vi.fn>;

  function written(action: string, subject: string) {
    const call = upsert.mock.calls.find(
      ([args]) =>
        args.where.organization_id_role_action_subject.action === action &&
        args.where.organization_id_role_action_subject.subject === subject,
    );
    expect(call, `no upsert for ${action} ${subject}`).toBeDefined();
    return call![0].update.conditions;
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    upsert = vi.fn().mockResolvedValue({});
    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(SALES_GRANTS);
    (prisma.$transaction as never as ReturnType<typeof vi.fn>).mockImplementation((fn: never) =>
      (fn as unknown as (tx: unknown) => unknown)({
        rolePermission: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }), upsert },
      }),
    );
  });

  it('an ordinary round-trip Save (e.g. ticking an unrelated box) leaves OWN_CUSTOMER on read/update Customer untouched', async () => {
    const vm = assembleRoleViewModel('SALES', SALES_GRANTS as never);
    // No `scope.Customer` key exists to submit (R2) — the view model round-trips as-is, the same
    // "tick a Vendors box for an unrelated reason" Save this whole file's header describes.
    const res = await request(app).put('/api/roles/SALES/permissions').set(authHeader('admin')).send(vm);
    expect(res.status).toBe(200);
    expect(written('read', 'Customer')).toEqual(OWN_CUSTOMER);
    expect(written('update', 'Customer')).toEqual(OWN_CUSTOMER);
  });

  it('create Customer stays unconditional (nothing to preserve, nothing to widen)', async () => {
    const vm = assembleRoleViewModel('SALES', SALES_GRANTS as never);
    const res = await request(app).put('/api/roles/SALES/permissions').set(authHeader('admin')).send(vm);
    expect(res.status).toBe(200);
    expect(written('create', 'Customer')).toBe(Prisma.JsonNull);
  });
});

/**
 * #2041 R8 — the SAME preservation for a SALES-DERIVED custom role, via the untick+Save+retick+Save
 * round trip (#2042 round 2 (B)'s "seeded from the base role" mechanism, `custom_roles.base_role`).
 */
describe('#2041 R8 — a SALES-derived CUSTOM role restores OWN_CUSTOMER on untick + retick', () => {
  const OWN_CUSTOMER = {
    OR: [
      { leads: { some: { lead_assignees: { some: { user_id: '{{userId}}' } } } } },
      { jobs: { some: { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } } } },
      { created_by_id: '{{userId}}' },
    ],
  };
  const CUSTOM_KEY = 'sales-junior';

  const bundle = (role: string) =>
    DEFAULT_GRANTS.filter((g) => g.role === role).map(({ action, subject, conditions }) => ({
      action,
      subject,
      conditions: conditions ?? null,
    }));

  let upsert: ReturnType<typeof vi.fn>;
  let deleteMany: ReturnType<typeof vi.fn>;

  function wireTx() {
    upsert = vi.fn().mockResolvedValue({});
    deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    (prisma.$transaction as never as ReturnType<typeof vi.fn>).mockImplementation((fn: never) =>
      (fn as unknown as (tx: unknown) => unknown)({ rolePermission: { deleteMany, upsert } }),
    );
  }

  function written(action: string, subject: string) {
    const call = upsert.mock.calls.find(
      ([args]) =>
        args.where.organization_id_role_action_subject.action === action &&
        args.where.organization_id_role_action_subject.subject === subject,
    );
    expect(call, `no upsert for ${action} ${subject}`).toBeDefined();
    return call![0].update.conditions;
  }

  function wireCustomRole(baseRole: string | null) {
    (prisma.customRole.findFirst as never as ReturnType<typeof vi.fn>).mockResolvedValue({
      id: 'cr-2',
      organization_id: '00000000-0000-0000-0000-000000000001',
      key: CUSTOM_KEY,
      label: 'Junior Sales',
      description: '',
      base_role: baseRole,
      archived_at: null,
    });
  }

  /** untick Customer > Read, Save; then retick from the state that Save left, Save again. */
  async function untickThenRetick(baseGrants: { action: string; subject: string; conditions: unknown }[]) {
    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(baseGrants);
    const untickVm = assembleRoleViewModel(CUSTOM_KEY, baseGrants as never);
    untickVm.matrix.Customer = { ...untickVm.matrix.Customer!, read: false };
    const untick = await request(app)
      .put(`/api/roles/${CUSTOM_KEY}/permissions`)
      .set(authHeader('admin'))
      .send(untickVm);
    expect(untick.status).toBe(200);

    const after = baseGrants.filter((g) => !(g.action === 'read' && g.subject === 'Customer'));
    wireTx();
    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(after);
    const retickVm = assembleRoleViewModel(CUSTOM_KEY, after as never);
    retickVm.matrix.Customer = { ...retickVm.matrix.Customer!, read: true };
    const retick = await request(app)
      .put(`/api/roles/${CUSTOM_KEY}/permissions`)
      .set(authHeader('admin'))
      .send(retickVm);
    expect(retick.status).toBe(200);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    mockAuthAs('admin');
    wireTx();
  });

  it('base_role SALES: the round trip restores OWN_CUSTOMER, not null', async () => {
    wireCustomRole('SALES');
    await untickThenRetick(bundle('SALES'));

    expect(written('read', 'Customer')).toEqual(OWN_CUSTOMER);
  });

  it('base_role DISPATCHER: the same round trip keeps the unconditional default', async () => {
    wireCustomRole('DISPATCHER');
    await untickThenRetick(bundle('DISPATCHER'));

    expect(written('read', 'Customer')).toBe(Prisma.JsonNull);
  });
});
