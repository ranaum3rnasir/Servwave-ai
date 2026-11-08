import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { MODULES, type RoleViewModel } from '../lib/permissions/roleViewModel';

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE ROLE-PERMISSION WRITE GATE — driven through the REAL handler.
//
// role.controller.ts putRolePermissions persists
//     viewModelToGrants(vm).filter((g) => isCatalogEntry(g.action, g.subject))
// The `.filter` is defence in depth: it makes "an action deliberately kept OUT of the catalog can
// never become a role grant" ENFORCED rather than merely emergent from the shape of ACTION_BY_CELL
// (which today simply has no `approve` / `location_restricted` cell to emit).
//
// A gate whose only protection is "the emitter cannot produce the bad value today" cannot be
// tested by asking the emitter what it produces — that assertion stays green after the gate is
// deleted. (An earlier version of this suite did exactly that, in permissions-logistic-orders.ts,
// via a locally-rebuilt `viewModelToGrants(...).filter(isCatalogEntry)` expression; deleting the
// production `.filter` left it 48/48 green.)
//
// So: mock the EMITTER to leak a non-catalog grant — simulating the future regression where
// ACTION_BY_CELL gains an `approve` cell — drive PUT /api/roles/:role/permissions, and assert on
// what the handler actually hands Prisma. Deleting the `.filter` makes these go red.
// ─────────────────────────────────────────────────────────────────────────────────────────────

// Mutable leak, read at CALL time. Empty at module-import time, so role.controller.ts's
// MANAGED_KEYS IIFE (which calls viewModelToGrants on a synthetic full matrix) is built from the
// REAL emitter and the delete-diff behaviour is unchanged.
const leak = vi.hoisted(() => ({
  grants: [] as { action: string; subject: string; conditions: Record<string, unknown> | null }[],
}));

vi.mock('../lib/permissions/roleViewModel', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/permissions/roleViewModel')>();
  return {
    ...actual,
    viewModelToGrants: (vm: RoleViewModel) => [...actual.viewModelToGrants(vm), ...leak.grants],
  };
});

const upsert = vi.fn();
const deleteMany = vi.fn();

// Every cell on, both sensitive bundles on: the maximal grant set a Roles-UI Save can request.
const maximalSaveBody = () => {
  const matrix: RoleViewModel['matrix'] = {};
  for (const m of MODULES) matrix[m.subject] = { read: true, create: true, update: true, delete: true };
  return {
    matrix,
    sensitive: { seeFinancials: true, managePayments: true },
    scope: {},
    general: { description: '' },
  };
};

// What the handler actually asked Prisma to persist.
const persisted = () =>
  upsert.mock.calls.map((c) => ({ action: c[0].create.action as string, subject: c[0].create.subject as string }));

const save = (role = 'DISPATCHER') =>
  request(app).put(`/api/roles/${role}/permissions`).set(authHeader('admin')).send(maximalSaveBody());

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  leak.grants = [];
  upsert.mockResolvedValue({});
  deleteMany.mockResolvedValue({ count: 0 });
  (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  (prisma.$transaction as never as ReturnType<typeof vi.fn>).mockImplementation((fn: (tx: unknown) => unknown) =>
    fn({ rolePermission: { deleteMany, upsert } }),
  );
  mockAuthAs('admin');
});

describe('PUT /api/roles/:role/permissions — what a maximal Save persists', () => {
  it('persists a non-empty grant set (guards every "never persists X" assertion below from vacuity)', async () => {
    const res = await save();
    expect(res.status).toBe(200);
    expect(persisted().length).toBeGreaterThan(0);
    expect(persisted()).toContainEqual({ action: 'read', subject: 'LogisticOrder' });
    // org-scoped, as the rest of the controller suite asserts
    expect(upsert.mock.calls[0][0].create.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('never persists approve or location_restricted on ANY subject', async () => {
    await save();
    expect(persisted().filter((g) => g.action === 'approve')).toEqual([]);
    expect(persisted().filter((g) => g.action === 'location_restricted')).toEqual([]);
  });

  it('persists LogisticOrder ONLY as read/create/update/delete', async () => {
    await save();
    const loActions = persisted()
      .filter((g) => g.subject === 'LogisticOrder')
      .map((g) => g.action)
      .sort();
    expect(loActions).toEqual(['create', 'delete', 'read', 'update']);
  });
});

// These are the mutation-sensitive ones: they fail if the `.filter(isCatalogEntry)` is removed.
describe('PUT /api/roles/:role/permissions — the catalog filter drops a leaked non-catalog grant', () => {
  const APPROVE = { action: 'approve', subject: 'LogisticOrder', conditions: null };
  const RESTRICTED = { action: 'location_restricted', subject: 'Inventory', conditions: null };

  it('the leak harness really does reach the handler (precondition for the assertions below)', async () => {
    leak.grants = [{ action: 'read', subject: 'LogisticOrder', conditions: null }];
    await save();
    // A catalog-legal leak IS persisted — proving the mock feeds putRolePermissions and that the
    // refusals below come from the catalog filter, not from a dud harness.
    expect(persisted()).toContainEqual({ action: 'read', subject: 'LogisticOrder' });
  });

  it('refuses to persist approve LogisticOrder even when the emitter produces it', async () => {
    leak.grants = [APPROVE];
    const res = await save();
    expect(res.status).toBe(200);
    expect(persisted().filter((g) => g.action === 'approve')).toEqual([]);
    expect(persisted().length).toBeGreaterThan(0); // the legitimate grants still landed
  });

  it('refuses to persist location_restricted Inventory even when the emitter produces it', async () => {
    leak.grants = [RESTRICTED];
    const res = await save();
    expect(res.status).toBe(200);
    expect(persisted().filter((g) => g.action === 'location_restricted')).toEqual([]);
  });

  it('drops the capability-only grants while keeping the catalog-legal ones in the same payload', async () => {
    leak.grants = [APPROVE, RESTRICTED];
    await save();
    const loActions = persisted()
      .filter((g) => g.subject === 'LogisticOrder')
      .map((g) => g.action)
      .sort();
    expect(loActions).toEqual(['create', 'delete', 'read', 'update']);
    expect(persisted().some((g) => g.subject === 'Inventory')).toBe(true); // Inventory CRUD survives
    expect(persisted().filter((g) => g.action === 'location_restricted')).toEqual([]);
  });

  it('the dropped grants are not smuggled in through the delete-diff either', async () => {
    leak.grants = [APPROVE, RESTRICTED];
    await save();
    for (const call of deleteMany.mock.calls) {
      const pairs = (call[0].where.OR ?? []) as { action: string; subject: string }[];
      expect(pairs.filter((p) => p.action === 'approve' || p.action === 'location_restricted')).toEqual([]);
    }
  });
});
