import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request } from 'express';
import { abilityForUser, scopeWhereForReq, scopeWhereForUser, type PermissionUser } from '../enforce';
import { clearPermissionCache } from '../permissionCache';
import { clearAllSwitchCaches } from '../switches/cache';
import { prisma } from '../../prisma';

/**
 * The contract `attachAbility` delegates to `abilityForUser`.
 *
 * Every authenticated request in the app builds its ability here, so each rule below is pinned
 * against it silently relaxing: the Admin box short-circuit with NO DB read, the ADMIN-DERIVED custom role that
 * must NOT short-circuit (it is an ordinary switch set), the switch lookup keyed on the CUSTOM role, the fixed reads
 * every signed-in person holds, the per-person cache,
 * and the loud failure when `custom_role_id` is set but the relation was never selected.
 */

const roleSwitchFind = () => prisma.permissionRoleSwitch.findMany as ReturnType<typeof vi.fn>;
const userSwitchFind = () => prisma.permissionUserSwitch.findMany as ReturnType<typeof vi.fn>;
const userFind = () => prisma.user.findUnique as ReturnType<typeof vi.fn>;

const ORG = 'org-1';

beforeEach(() => {
  clearPermissionCache();
  // No stored switch values: every switch comes from the built-in preset of the person's role.
  roleSwitchFind().mockReset();
  roleSwitchFind().mockResolvedValue([]);
  userSwitchFind().mockReset();
  userSwitchFind().mockResolvedValue([]);
  userFind().mockReset();
  clearAllSwitchCaches();
});

describe('abilityForUser - the ability attachAbility attaches', () => {
  const admin: PermissionUser = { id: 'u-admin', role: 'ADMIN', is_admin: true, organization_id: ORG };

  it('the Admin box is manage-all and costs NO database read', async () => {
    const ability = await abilityForUser(admin);
    expect(ability.can('delete', 'Job')).toBe(true);
    expect(roleSwitchFind()).not.toHaveBeenCalled();
    expect(userSwitchFind()).not.toHaveBeenCalled();
  });

  it('an ADMIN-DERIVED custom role does NOT short-circuit: it is an ordinary switch set, looked up under its own key', async () => {
    // The Admin preset has Delete customers on; this role has it switched off.
    roleSwitchFind().mockResolvedValue([{ switch_key: 'delete_customers', value: false }]);
    const ability = await abilityForUser({ is_admin: false,
      id: 'u2', role: 'ADMIN', organization_id: ORG,
      custom_role_id: 'cr1', custom_role: { key: 'ops-lead' },
    });
    expect(ability.can('delete', 'Customer')).toBe(false);
    expect(ability.can('update', 'Customer')).toBe(true); // everything else still on, from the Admin preset
    expect(roleSwitchFind().mock.calls[0][0].where).toEqual({ organization_id: ORG, role_key: 'ops-lead' });
  });

  it('every signed-in person holds the fixed reads, whatever their switches say', async () => {
    roleSwitchFind().mockResolvedValue([{ switch_key: 'view_customers', value: false }]);
    const ability = await abilityForUser({ is_admin: false, id: 'u3', role: 'TECHNICIAN', organization_id: ORG });
    expect(ability.can('read', 'Tag')).toBe(true);
    expect(ability.can('read', 'Notification')).toBe(true);
    expect(ability.can('read', 'Organization')).toBe(true);
    // ...and nothing beyond them that no switch carries.
    expect(ability.can('update', 'Organization')).toBe(false);
  });

  it('caches a person\'s resolved switches: a second build issues no second switch read', async () => {
    userFind().mockResolvedValue({ role: 'SALES', based_on_role_key: null, custom_role_id: null, custom_role: null });
    await abilityForUser({ is_admin: false, id: 'u5', role: 'SALES', organization_id: ORG });
    await abilityForUser({ is_admin: false, id: 'u5', role: 'SALES', organization_id: ORG });
    expect(roleSwitchFind()).toHaveBeenCalledTimes(1);
    expect(userSwitchFind()).toHaveBeenCalledTimes(1);
  });

  // The loud failure is the point: falling back to the base role would silently OVER-grant
  // whenever the custom role is narrower. attachAbility turns this rejection into a 500.
  it('rejects when custom_role_id is set but the relation was not loaded', async () => {
    await expect(
      abilityForUser({ is_admin: false, id: 'u6', role: 'SALES', organization_id: ORG, custom_role_id: 'cr9' }),
    ).rejects.toThrow(/custom_role relation was not loaded/);
  });
});

describe('scopeWhereForUser / scopeWhereForReq agree', () => {
  const user: PermissionUser = {
    id: 'u1', role: 'SALES', is_admin: false, organization_id: ORG, department_id: null, location_id: null,
  };

  it('the request wrapper returns exactly what the user-level form returns', async () => {
    // The Sales preset reaches the purchase orders of the jobs that come from a lead the person is an assignee of.
    const viaReq = await scopeWhereForReq({ user } as unknown as Request, 'PurchaseOrder');
    const viaUser = await scopeWhereForUser(user, 'PurchaseOrder');
    expect(viaReq).toEqual(viaUser);
    expect(viaUser).toEqual({ job: { estimate: { lead: { lead_assignees: { some: { user_id: 'u1' } } } } } });
  });

  it('an unrestricted ADMIN is unscoped through both entry points', async () => {
    const admin: PermissionUser = { id: 'a', role: 'ADMIN', is_admin: true, organization_id: ORG };
    expect(await scopeWhereForUser(admin, 'Job')).toEqual({});
    expect(await scopeWhereForReq({ user: admin } as unknown as Request, 'Job')).toEqual({});
  });

  it('no read grant fails closed through both entry points', async () => {
    // View purchase orders is the switch that stands for the read grant.
    roleSwitchFind().mockResolvedValue([{ switch_key: 'view_purchase_orders', value: false }]);
    expect(await scopeWhereForUser(user, 'PurchaseOrder')).toEqual({ id: { in: [] } });
    expect(await scopeWhereForReq({ user } as unknown as Request, 'PurchaseOrder')).toEqual({ id: { in: [] } });
  });

  it('no user at all fails closed', async () => {
    expect(await scopeWhereForReq({} as unknown as Request, 'Job')).toEqual({ id: { in: [] } });
  });
});
