import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Request } from 'express';
import { abilityForUser, scopeWhereForReq, scopeWhereForUser, type PermissionUser } from '../enforce';
import { clearPermissionCache } from '../permissionCache';
import { clearUserOverrideCache } from '../userOverrideCache';
import { prisma } from '../../prisma';

/**
 * The contract `attachAbility` used to spell out inline and now delegates to `abilityForUser`.
 *
 * Every authenticated request in the app builds its ability here, so each rule below is pinned
 * against the extraction silently relaxing it: the unrestricted-ADMIN short-circuit with NO DB
 * read, the ADMIN-DERIVED custom role that must NOT short-circuit, the grant lookup keyed on the
 * CUSTOM role, the per-org-per-role cache, the per-user override layer, and the loud failure when
 * `custom_role_id` is set but the relation was never selected.
 */

const roleFind = () => prisma.rolePermission.findMany as ReturnType<typeof vi.fn>;
const overrideFind = () => prisma.userPermissionOverride.findMany as ReturnType<typeof vi.fn>;

const ORG = 'org-1';

beforeEach(() => {
  clearPermissionCache();
  clearUserOverrideCache();
  roleFind().mockReset();
  roleFind().mockResolvedValue([]);
  overrideFind().mockReset();
  overrideFind().mockResolvedValue([]);
});

describe('abilityForUser - the ability attachAbility attaches', () => {
  const admin: PermissionUser = { id: 'u-admin', role: 'ADMIN', organization_id: ORG };

  it('an unrestricted ADMIN is manage-all and costs NO database read', async () => {
    const ability = await abilityForUser(admin);
    expect(ability.can('delete', 'Job')).toBe(true);
    expect(roleFind()).not.toHaveBeenCalled();
    expect(overrideFind()).not.toHaveBeenCalled();
  });

  it('an ADMIN-DERIVED custom role does NOT short-circuit: it loads and applies its grants', async () => {
    roleFind().mockResolvedValue([{ action: 'read', subject: 'Job', conditions: null }]);
    const ability = await abilityForUser({
      id: 'u2', role: 'ADMIN', organization_id: ORG,
      custom_role_id: 'cr1', custom_role: { key: 'ops-lead' },
    });
    expect(ability.can('read', 'Job')).toBe(true);
    expect(ability.can('delete', 'Job')).toBe(false); // not manage-all
    expect(roleFind()).toHaveBeenCalledTimes(1);
    expect(roleFind().mock.calls[0][0].where).toEqual({ organization_id: ORG, role: 'ops-lead' });
  });

  it('looks grants up under the BASE role when there is no custom role', async () => {
    await abilityForUser({ id: 'u3', role: 'TECHNICIAN', organization_id: ORG });
    expect(roleFind().mock.calls[0][0].where).toEqual({ organization_id: ORG, role: 'TECHNICIAN' });
  });

  it('caches per org+role: a second build issues no second grant read', async () => {
    await abilityForUser({ id: 'u3', role: 'SALES', organization_id: ORG });
    await abilityForUser({ id: 'u4', role: 'SALES', organization_id: ORG });
    expect(roleFind()).toHaveBeenCalledTimes(1);
    // Overrides are per-USER and must NOT ride the role cache.
    expect(overrideFind()).toHaveBeenCalledTimes(2);
  });

  it('layers per-user overrides on top of the role grant', async () => {
    roleFind().mockResolvedValue([{ action: 'read', subject: 'Job', conditions: null }]);
    overrideFind().mockResolvedValue([{ action: 'read', subject: 'Job', effect: 'deny' }]);
    const ability = await abilityForUser({ id: 'u5', role: 'SALES', organization_id: ORG });
    expect(ability.can('read', 'Job')).toBe(false);
  });

  // The loud failure is the point: falling back to the base role would silently OVER-grant
  // whenever the custom role is narrower. attachAbility turns this rejection into a 500.
  it('rejects when custom_role_id is set but the relation was not loaded', async () => {
    await expect(
      abilityForUser({ id: 'u6', role: 'SALES', organization_id: ORG, custom_role_id: 'cr9' }),
    ).rejects.toThrow(/custom_role relation was not loaded/);
    expect(roleFind()).not.toHaveBeenCalled();
  });
});

describe('scopeWhereForUser / scopeWhereForReq agree', () => {
  const user: PermissionUser = {
    id: 'u1', role: 'SALES', organization_id: ORG, department_id: null, location_id: null,
  };

  it('the request wrapper returns exactly what the user-level form returns', async () => {
    roleFind().mockResolvedValue([
      { action: 'read', subject: 'Job', conditions: { assignees: { some: { user_id: '{{userId}}' } } } },
    ]);
    const viaReq = await scopeWhereForReq({ user } as unknown as Request, 'Job');
    const viaUser = await scopeWhereForUser(user, 'Job');
    expect(viaReq).toEqual(viaUser);
    expect(viaUser).toEqual({ assignees: { some: { user_id: 'u1' } } });
  });

  it('an unrestricted ADMIN is unscoped through both entry points', async () => {
    const admin: PermissionUser = { id: 'a', role: 'ADMIN', organization_id: ORG };
    expect(await scopeWhereForUser(admin, 'Job')).toEqual({});
    expect(await scopeWhereForReq({ user: admin } as unknown as Request, 'Job')).toEqual({});
    expect(roleFind()).not.toHaveBeenCalled();
  });

  it('no read grant fails closed through both entry points', async () => {
    expect(await scopeWhereForUser(user, 'Job')).toEqual({ id: { in: [] } });
    expect(await scopeWhereForReq({ user } as unknown as Request, 'Job')).toEqual({ id: { in: [] } });
  });

  it('no user at all fails closed', async () => {
    expect(await scopeWhereForReq({} as unknown as Request, 'Job')).toEqual({ id: { in: [] } });
  });
});
