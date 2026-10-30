import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request } from 'express';
import { can, scopeWhereForReq, canAccessRow } from '../enforce';
import { defineAbilityFor, type Grant } from '../defineAbility';
import { MATCH_NOTHING } from '../scopeWhereFor';
import { clearPermissionCache } from '../permissionCache';
import { prisma } from '../../prisma';
import { clearAllSwitchCaches } from '../switches/cache';
import { attachedJobWhere } from '../../../__tests__/helpers';

// Owner-scoped grants — the same shape a SALES/TECH role carries in prod.
const ownLeadUpdate: Grant = {
  action: 'update',
  subject: 'Lead',
  conditions: { lead_assignees: { some: { user_id: '{{userId}}' } } },
};

// The switch catalog owns every scoped record's reach now, so a person's reach below comes from their switches (the
// built-in preset of their role plus the stored values these cases mock), through purchase orders: the orders on
// the jobs the person can open.
const roleSwitchFind = () => prisma.permissionRoleSwitch.findMany as ReturnType<typeof vi.fn>;
const userSwitchFind = () => prisma.permissionUserSwitch.findMany as ReturnType<typeof vi.fn>;
const withSwitches = (values: Record<string, boolean | string>) => {
  roleSwitchFind().mockResolvedValue(Object.entries(values).map(([switch_key, value]) => ({ switch_key, value })));
  clearAllSwitchCaches();
};
// What the Sales preset reaches: the jobs that come from a lead the person is an assignee of.
const salesJobReach = (userId: string) => ({ job: { estimate: { lead: { lead_assignees: { some: { user_id: userId } } } } } });

function reqWith(grants: Grant[], userId = 'u1'): Request {
  const ability = defineAbilityFor({ id: userId, role: 'SALES' }, grants);
  return { ability } as unknown as Request;
}

describe('can() enforcement helper', () => {
  const ownedRow = { id: 'l1', lead_assignees: [{ user_id: 'u1' }] };
  const otherRow = { id: 'l2', lead_assignees: [{ user_id: 'u2' }] };

  it('returns true when the ability permits the action on the owned instance', () => {
    const req = reqWith([ownLeadUpdate]);
    expect(can(req, 'update', 'Lead', ownedRow)).toBe(true);
  });

  it('returns false when the instance is owned by someone else (per-instance owner check)', () => {
    const req = reqWith([ownLeadUpdate]);
    expect(can(req, 'update', 'Lead', otherRow)).toBe(false);
  });

  it('returns false when the role has no grant for that action at all', () => {
    const req = reqWith([{ action: 'read', subject: 'Lead', conditions: ownLeadUpdate.conditions }]); // read-only, no update grant
    expect(can(req, 'update', 'Lead', ownedRow)).toBe(false);
  });

  it('ADMIN (manage all) passes on any instance', () => {
    const ability = defineAbilityFor({ id: 'admin', role: 'ADMIN' }, []);
    const req = { ability } as unknown as Request;
    expect(can(req, 'delete', 'Job', { id: 'j9', assignees: [] })).toBe(true);
  });

  it('fail-closed: a request with no ability attached denies', () => {
    const req = {} as unknown as Request;
    expect(can(req, 'update', 'Lead', ownedRow)).toBe(false);
  });
});

const ORG = 'org-1';
function listReq(role: string, userId = 'u1'): Request {
  return {
    user: { id: userId, role, organization_id: ORG, department_id: null, location_id: null },
  } as unknown as Request;
}

describe('scopeWhereForReq() — list-scope where fragment for controllers', () => {
  beforeEach(() => {
    clearPermissionCache();
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockReset();
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    roleSwitchFind().mockReset();
    userSwitchFind().mockReset();
    roleSwitchFind().mockResolvedValue([]);
    userSwitchFind().mockResolvedValue([]);
    clearAllSwitchCaches();
  });

  it('ADMIN → no restriction ({}) without touching the DB', async () => {
    const where = await scopeWhereForReq(listReq('ADMIN'), 'Lead');
    expect(where).toEqual({});
    expect(prisma.rolePermission.findMany).not.toHaveBeenCalled();
  });

  it('scopes from the person\'s switches alone — the switch-derived reach → owner where-fragment, no role-permission read', async () => {
    const where = await scopeWhereForReq(listReq('SALES'), 'PurchaseOrder');
    expect(where).toEqual(salesJobReach('u1'));
    expect(prisma.rolePermission.findMany).not.toHaveBeenCalled();
  });

  it('a stored switch value changes the reach, and still no role-permission read', async () => {
    withSwitches({ view_purchase_orders: true, jobs_scope: 'attached' });
    const where = await scopeWhereForReq(listReq('TECHNICIAN'), 'PurchaseOrder');
    expect(where).toEqual({ job: { OR: attachedJobWhere('u1') } });
    expect(prisma.rolePermission.findMany).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: a non-ADMIN role without View purchase orders → MATCH_NOTHING (sees nothing)', async () => {
    withSwitches({ view_purchase_orders: false });
    const where = await scopeWhereForReq(listReq('SALES'), 'PurchaseOrder');
    expect(where).toEqual(MATCH_NOTHING);
  });

  it('fail-closed: a request with no user → MATCH_NOTHING', async () => {
    const where = await scopeWhereForReq({} as unknown as Request, 'Lead');
    expect(where).toEqual(MATCH_NOTHING);
  });
});

// ─── canAccessRow() — SQL-based per-instance ownership for update/delete (#106b) ───
// The Wave 2 review found two holes from enforcing ownership through CASL's
// in-memory matcher: (P0) invoice canAccessInvoice() hardcoded ADMIN/DISPATCHER
// true and ignored the grant; (P1) req.ability.can() THROWS on NESTED
// to-one→to-many conditions (Estimate via lead.lead_assignees; Job/Lead Team via
// assignees.some.user.department_id). canAccessRow enforces visibility through the
// SAME scopeWhereForReq fragment — compiled to SQL, never the matcher.

// A minimal fake of a Prisma model delegate: captures the `where` it is called with.
// Typed as the exact `findFirst` signature canAccessRow expects, intersected with the
// vitest Mock surface so the assertions (toHaveBeenCalledWith) stay ergonomic.
type FakeDelegate = {
  findFirst: ((args: { where: unknown; select: { id: true } }) => Promise<{ id: string } | null>) &
    ReturnType<typeof vi.fn>;
  // #2042: RowDelegate widened with `count` (canCreateOnAnchor's probe, R1) - unused by the
  // canAccessRow/canActOnRow cases below, but required to satisfy the shared type.
  count: ((args: unknown) => Promise<number>) & ReturnType<typeof vi.fn>;
};
function fakeDelegate(returns: { id: string } | null): FakeDelegate {
  return { findFirst: vi.fn().mockResolvedValue(returns), count: vi.fn() } as unknown as FakeDelegate;
}

// The exact NESTED config Wave 2 broke: a reach through the job's estimate's lead's to-many assignees — a
// to-one → to-one → to-many condition that the in-memory matcher throws on ("equals does not supports
// comparison of arrays…"). It is the Sales preset's reach (Through own leads).
// The Team config Wave 2 broke follows: scope through assignees → user → department.

function rowReq(role: string, opts: { userId?: string; department_id?: string | null } = {}): Request {
  return {
    user: {
      id: opts.userId ?? 'u1',
      role,
      organization_id: ORG,
      department_id: opts.department_id ?? null,
      location_id: null,
    },
  } as unknown as Request;
}

describe('canAccessRow() — SQL per-instance ownership (nested-safe, switch-driven, fail-closed)', () => {
  beforeEach(() => {
    clearPermissionCache();
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockReset();
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
    roleSwitchFind().mockReset();
    userSwitchFind().mockReset();
    roleSwitchFind().mockResolvedValue([]);
    userSwitchFind().mockResolvedValue([]);
    clearAllSwitchCaches();
  });

  it('NESTED PurchaseOrder-Owned: resolves via the where-fragment without throwing; owned row → true', async () => {
    const delegate = fakeDelegate({ id: 'e1' });
    const result = await canAccessRow(rowReq('SALES'), 'PurchaseOrder', delegate, 'e1');
    expect(result).toBe(true);
    // Built the SQL where from id + tenant + the nested scope fragment — NOT the matcher.
    expect(delegate.findFirst).toHaveBeenCalledTimes(1);
    expect(delegate.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'e1',
        organization_id: ORG,
        ...salesJobReach('u1'),
      },
      select: { id: true },
    });
  });

  it('NESTED PurchaseOrder-Owned: un-owned row (findFirst → null under scope) → false', async () => {
    const delegate = fakeDelegate(null);
    expect(await canAccessRow(rowReq('SALES'), 'PurchaseOrder', delegate, 'e2')).toBe(false);
    expect(delegate.findFirst).toHaveBeenCalledTimes(1);
  });

  it('Team-scoped PurchaseOrder (job crew, Sold By or Dispatcher in the person\'s department): builds nested where, never throws', async () => {
    withSwitches({ view_purchase_orders: true, jobs_scope: 'team' });
    const delegate = fakeDelegate({ id: 'i1' });
    const result = await canAccessRow(
      rowReq('DISPATCHER', { department_id: 'dept-9' }),
      'PurchaseOrder',
      delegate,
      'i1',
    );
    expect(result).toBe(true);
    expect(delegate.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'i1',
        organization_id: ORG,
        job: {
          OR: [
            { visits: { some: { assignees: { some: { user: { department_id: 'dept-9' } } } } } },
            { salesperson: { department_id: 'dept-9' } },
            { dispatcher: { department_id: 'dept-9' } },
          ],
        },
      },
      select: { id: true },
    });
  });

  it('ADMIN → true via fast-path: empty scope fragment, no query issued', async () => {
    const delegate = fakeDelegate({ id: 'i1' });
    const result = await canAccessRow(rowReq('ADMIN'), 'PurchaseOrder', delegate, 'i1');
    expect(result).toBe(true);
    expect(delegate.findFirst).not.toHaveBeenCalled();
    expect(prisma.rolePermission.findMany).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: no read grant → MATCH_NOTHING (id:{in:[]}) → findFirst null → false', async () => {
    // SALES without View purchase orders — the P0 hole: previously canAccessInvoice
    // returned true for privileged roles; here the absent grant denies.
    withSwitches({ view_purchase_orders: false });
    const delegate = fakeDelegate(null);
    const result = await canAccessRow(rowReq('SALES'), 'PurchaseOrder', delegate, 'i9');
    expect(result).toBe(false);
    // Still queries (MATCH_NOTHING is a real where the DB evaluates to empty).
    // The spread of MATCH_NOTHING (`{ id: { in: [] } }`) overwrites the literal id —
    // so the built where is the row's tenant + the never-matching id filter.
    expect(delegate.findFirst).toHaveBeenCalledTimes(1);
    expect(delegate.findFirst).toHaveBeenCalledWith({
      where: { organization_id: ORG, id: { in: [] } },
      select: { id: true },
    });
  });

  it('fail-closed: a request with no user → false, no query', async () => {
    const delegate = fakeDelegate({ id: 'x1' });
    expect(await canAccessRow({} as unknown as Request, 'Lead', delegate, 'x1')).toBe(false);
    expect(delegate.findFirst).not.toHaveBeenCalled();
  });
});
