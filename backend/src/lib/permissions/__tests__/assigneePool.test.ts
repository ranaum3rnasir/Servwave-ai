import { describe, it, expect } from 'vitest';
import type { Request } from 'express';
import {
  resolveAssigneePool,
  resolveAssigneePoolForRequest,
  isAssigneeSetPermitted,
  type AssigneePool,
} from '../assigneePool';
import { defineAbilityFor, type Grant, type PermissionOverride } from '../defineAbility';

// Scoped assignee pool, slice 2 — the resolver's unit suite.
//
// Every case drives the REAL `defineAbilityFor`. A hand-written ability literal would pass
// against a resolver that read a role name, which is exactly the defect these tests exist to
// catch: the whole claim of this module is that custom roles and per-user overrides fall out
// of asking the ability, and only the real builder can demonstrate that.

const ASSIGN_USER: Grant = { action: 'assign', subject: 'User' };
const ASSIGN_TASK: Grant = { action: 'assign', subject: 'Task' };
// A grant that has nothing to do with naming people — a role holding only this must still be
// self-only, or the resolver is answering "has any grant at all".
const READ_LEAD: Grant = { action: 'read', subject: 'Lead' };

function abilityFor(
  user: { id: string; role: string; custom_role_id?: string | null },
  grants: Grant[] = [],
  overrides: PermissionOverride[] = [],
) {
  return defineAbilityFor(user, grants, overrides);
}

describe('resolveAssigneePool — the grant, not the role', () => {
  it('a grant holder (DISPATCHER default) resolves to org scope', () => {
    const ability = abilityFor({ id: 'disp-1', role: 'DISPATCHER' }, [ASSIGN_USER]);
    expect(resolveAssigneePool(ability, 'disp-1', 'jobCrew')).toEqual({ scope: 'org' });
    expect(resolveAssigneePool(ability, 'disp-1', 'walkthroughPerformer')).toEqual({ scope: 'org' });
  });

  it('a non-holder (SALES) resolves to self-only carrying THEIR id', () => {
    const ability = abilityFor({ id: 'sales-7', role: 'SALES' }, [READ_LEAD]);
    // The id is the assertion: a self-only pool keyed on the wrong person is worse than no pool.
    expect(resolveAssigneePool(ability, 'sales-7', 'walkthroughPerformer')).toEqual({
      scope: 'self',
      userId: 'sales-7',
    });
    expect(resolveAssigneePool(ability, 'sales-7', 'jobCrew')).toEqual({
      scope: 'self',
      userId: 'sales-7',
    });
  });

  it('ADMIN resolves to org without holding an explicit grant row (manage-all short-circuit)', () => {
    const ability = abilityFor({ id: 'admin-1', role: 'ADMIN' }, []);
    expect(resolveAssigneePool(ability, 'admin-1', 'jobCrew')).toEqual({ scope: 'org' });
    expect(resolveAssigneePool(ability, 'admin-1', 'walkthroughPerformer')).toEqual({ scope: 'org' });
    expect(resolveAssigneePool(ability, 'admin-1', 'task')).toEqual({ scope: 'org' });
  });

  it('a CUSTOM ROLE holding the grant resolves to org (base role SALES, which holds nothing)', () => {
    // The custom-role bridge: `role` stays the BASE role and the custom role's rows arrive
    // resolved in `grants`. A resolver that read `.role` would answer self-only here.
    const ability = abilityFor(
      { id: 'mgr-1', role: 'SALES', custom_role_id: 'cr-sales-manager' },
      [READ_LEAD, ASSIGN_USER],
    );
    expect(resolveAssigneePool(ability, 'mgr-1', 'walkthroughPerformer')).toEqual({ scope: 'org' });
  });

  it('a per-user ALLOW override resolves to org, with no role grant behind it', () => {
    const ability = abilityFor({ id: 'sales-9', role: 'SALES' }, [READ_LEAD], [
      { action: 'assign', subject: 'User', effect: 'allow' },
    ]);
    expect(resolveAssigneePool(ability, 'sales-9', 'jobCrew')).toEqual({ scope: 'org' });
  });

  it('a per-user DENY override resolves to self-only even though the role grants it', () => {
    const ability = abilityFor({ id: 'disp-2', role: 'DISPATCHER' }, [ASSIGN_USER], [
      { action: 'assign', subject: 'User', effect: 'deny' },
    ]);
    expect(resolveAssigneePool(ability, 'disp-2', 'jobCrew')).toEqual({
      scope: 'self',
      userId: 'disp-2',
    });
  });

  it('fail-closed: no ability attached resolves to self-only', () => {
    expect(resolveAssigneePool(undefined, 'u-1', 'jobCrew')).toEqual({ scope: 'self', userId: 'u-1' });
  });
});

// The regression guard for the "custom role silently loses task assignment" trap. It is only a
// guard if it runs BOTH ways: one grant must never answer for the other's purpose.
describe('resolveAssigneePool — purposes read their OWN grant', () => {
  it('`assign Task` alone: task is org, crew and performers are self-only', () => {
    const ability = abilityFor({ id: 'u-task', role: 'SALES' }, [ASSIGN_TASK]);
    expect(resolveAssigneePool(ability, 'u-task', 'task')).toEqual({ scope: 'org' });
    expect(resolveAssigneePool(ability, 'u-task', 'jobCrew')).toEqual({
      scope: 'self',
      userId: 'u-task',
    });
    expect(resolveAssigneePool(ability, 'u-task', 'walkthroughPerformer')).toEqual({
      scope: 'self',
      userId: 'u-task',
    });
  });

  it('`assign User` alone: crew and performers are org, task is STILL self-only', () => {
    const ability = abilityFor({ id: 'u-crew', role: 'TECHNICIAN' }, [ASSIGN_USER]);
    expect(resolveAssigneePool(ability, 'u-crew', 'jobCrew')).toEqual({ scope: 'org' });
    expect(resolveAssigneePool(ability, 'u-crew', 'walkthroughPerformer')).toEqual({ scope: 'org' });
    expect(resolveAssigneePool(ability, 'u-crew', 'task')).toEqual({
      scope: 'self',
      userId: 'u-crew',
    });
  });
});

describe('resolveAssigneePoolForRequest — the Express wrapper', () => {
  it('reads the ability and the id off the request', () => {
    const req = {
      ability: abilityFor({ id: 'sales-3', role: 'SALES' }, [READ_LEAD]),
      user: { id: 'sales-3', role: 'SALES' },
    } as unknown as Request;
    expect(resolveAssigneePoolForRequest(req, 'walkthroughPerformer')).toEqual({
      scope: 'self',
      userId: 'sales-3',
    });
  });

  it('fail-closed: an un-hydrated request is self-only and names nobody', () => {
    const pool = resolveAssigneePoolForRequest({} as unknown as Request, 'jobCrew');
    expect(pool.scope).toBe('self');
    expect(isAssigneeSetPermitted(pool, ['anyone'])).toBe(false);
  });
});

describe('isAssigneeSetPermitted', () => {
  const selfOnly: AssigneePool = { scope: 'self', userId: 'me' };
  const org: AssigneePool = { scope: 'org' };

  it('an EMPTY set is permitted under both scopes (Ran: no minimum-length rule at the API)', () => {
    expect(isAssigneeSetPermitted(selfOnly, [])).toBe(true);
    expect(isAssigneeSetPermitted(org, [])).toBe(true);
  });

  it('naming only yourself is permitted under both scopes', () => {
    expect(isAssigneeSetPermitted(selfOnly, ['me'])).toBe(true);
    expect(isAssigneeSetPermitted(org, ['me'])).toBe(true);
  });

  it('a self-only requester naming a colleague is refused', () => {
    expect(isAssigneeSetPermitted(selfOnly, ['colleague'])).toBe(false);
  });

  it('a self-only requester naming themselves PLUS a colleague is refused', () => {
    expect(isAssigneeSetPermitted(selfOnly, ['me', 'colleague'])).toBe(false);
  });

  it('an org-scoped requester may name anyone, themselves included or not', () => {
    expect(isAssigneeSetPermitted(org, ['colleague', 'someone-else'])).toBe(true);
  });
});
