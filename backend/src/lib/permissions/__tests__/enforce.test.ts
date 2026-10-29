import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request } from 'express';
import { can, scopeWhereForReq, canAccessRow } from '../enforce';
import { defineAbilityFor, type Grant } from '../defineAbility';
import { MATCH_NOTHING } from '../scopeWhereFor';
import { setCachedGrants, clearPermissionCache } from '../permissionCache';
import { prisma } from '../../prisma';

// Owner-scoped grants — the same shape a SALES/TECH role carries in prod.
const ownLeadUpdate: Grant = {
  action: 'update',
  subject: 'Lead',
  conditions: { lead_assignees: { some: { user_id: '{{userId}}' } } },
};
const ownLeadRead: Grant = {
  action: 'read',
  subject: 'Lead',
  conditions: { lead_assignees: { some: { user_id: '{{userId}}' } } },
};

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
    const req = reqWith([ownLeadRead]); // read-only, no update grant
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
  });

  it('ADMIN → no restriction ({}) without touching the DB', async () => {
    const where = await scopeWhereForReq(listReq('ADMIN'), 'Lead');
    expect(where).toEqual({});
    expect(prisma.rolePermission.findMany).not.toHaveBeenCalled();
  });

  it('uses cached grants (no DB read) — owner read grant → owner where-fragment', async () => {
    setCachedGrants(ORG, 'SALES', [ownLeadRead]);
    const where = await scopeWhereForReq(listReq('SALES'), 'Lead');
    expect(where).toEqual({ lead_assignees: { some: { user_id: 'u1' } } });
    expect(prisma.rolePermission.findMany).not.toHaveBeenCalled();
  });

  it('cache miss → falls back to rolePermission.findMany and scopes from those rows', async () => {
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([
      { action: 'read', subject: 'Job', conditions: { assignees: { some: { user_id: '{{userId}}' } } } },
    ]);
    const where = await scopeWhereForReq(listReq('TECHNICIAN'), 'Job');
    expect(where).toEqual({ assignees: { some: { user_id: 'u1' } } });
    expect(prisma.rolePermission.findMany).toHaveBeenCalledOnce();
  });

  it('FAIL-CLOSED: a non-ADMIN role with no read grant → MATCH_NOTHING (sees nothing)', async () => {
    const where = await scopeWhereForReq(listReq('SALES'), 'Invoice');
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

// The exact NESTED config Wave 2 broke: Estimate "Owned" scopes through the lead's
// to-many assignees — a to-one (lead) → to-many (lead_assignees) condition that the
// in-memory matcher throws on ("equals does not supports comparison of arrays…").
const estimateOwnedRead: Grant = {
  action: 'read',
  subject: 'Estimate',
  conditions: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } },
};
// The Team/Location config Wave 2 broke: scope through assignees → user → department.
const jobTeamRead: Grant = {
  action: 'read',
  subject: 'Job',
  conditions: { assignees: { some: { user: { department_id: '{{teamId}}' } } } },
};

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

describe('canAccessRow() — SQL per-instance ownership (nested-safe, grant-driven, fail-closed)', () => {
  beforeEach(() => {
    clearPermissionCache();
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockReset();
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue([]);
  });

  it('NESTED Estimate-Owned: resolves via the where-fragment without throwing; owned row → true', async () => {
    setCachedGrants(ORG, 'SALES', [estimateOwnedRead]);
    const delegate = fakeDelegate({ id: 'e1' });
    const result = await canAccessRow(rowReq('SALES'), 'Estimate', delegate, 'e1');
    expect(result).toBe(true);
    // Built the SQL where from id + tenant + the nested scope fragment — NOT the matcher.
    expect(delegate.findFirst).toHaveBeenCalledTimes(1);
    expect(delegate.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'e1',
        organization_id: ORG,
        lead: { lead_assignees: { some: { user_id: 'u1' } } },
      },
      select: { id: true },
    });
  });

  it('NESTED Estimate-Owned: un-owned row (findFirst → null under scope) → false', async () => {
    setCachedGrants(ORG, 'SALES', [estimateOwnedRead]);
    const delegate = fakeDelegate(null);
    expect(await canAccessRow(rowReq('SALES'), 'Estimate', delegate, 'e2')).toBe(false);
    expect(delegate.findFirst).toHaveBeenCalledTimes(1);
  });

  it('Team-scoped Job (assignees.some.user.department_id): builds nested where, never throws', async () => {
    setCachedGrants(ORG, 'DISPATCHER', [jobTeamRead]);
    const delegate = fakeDelegate({ id: 'j1' });
    const result = await canAccessRow(
      rowReq('DISPATCHER', { department_id: 'dept-9' }),
      'Job',
      delegate,
      'j1',
    );
    expect(result).toBe(true);
    expect(delegate.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'j1',
        organization_id: ORG,
        assignees: { some: { user: { department_id: 'dept-9' } } },
      },
      select: { id: true },
    });
  });

  it('ADMIN → true via fast-path: empty scope fragment, no query issued', async () => {
    const delegate = fakeDelegate({ id: 'i1' });
    const result = await canAccessRow(rowReq('ADMIN'), 'Invoice', delegate, 'i1');
    expect(result).toBe(true);
    expect(delegate.findFirst).not.toHaveBeenCalled();
    expect(prisma.rolePermission.findMany).not.toHaveBeenCalled();
  });

  it('FAIL-CLOSED: no read grant → MATCH_NOTHING (id:{in:[]}) → findFirst null → false', async () => {
    // SALES with no Invoice read grant — the P0 invoice hole: previously canAccessInvoice
    // returned true for privileged roles; here the absent grant denies.
    const delegate = fakeDelegate(null);
    const result = await canAccessRow(rowReq('SALES'), 'Invoice', delegate, 'i9');
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
