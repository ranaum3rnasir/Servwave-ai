import { describe, it, expect } from 'vitest';
import { defineAbilityFor } from '../defineAbility';
import { scopeWhereFor, MATCH_NOTHING } from '../scopeWhereFor';

// SRVW-138 phase one - the five fail-safe superuser sites.
//
// A plain ADMIN keeps its `manage all` / unscoped short-circuit. An ADMIN-DERIVED custom
// role ("full access minus payroll") must NOT short-circuit: it carries a seeded explicit
// grant set that the admin subtracts from, and short-circuiting would silently ignore
// every subtraction and hand back full access.
//
// Getting these wrong fails in one of two directions, so both are asserted at every site:
// too tight locks admins out, too loose over-grants.

const ADMIN = { id: 'u1', role: 'ADMIN', custom_role_id: null };
const ADMIN_DERIVED = { id: 'u2', role: 'ADMIN', custom_role_id: 'cr-1' };

describe('defineAbility - ADMIN short-circuit', () => {
  it('a plain ADMIN gets manage all, ignoring grants', () => {
    const ability = defineAbilityFor(ADMIN, []);
    expect(ability.can('manage', 'all')).toBe(true);
    expect(ability.can('delete', 'Invoice')).toBe(true);
  });

  it('an ADMIN-derived custom role resolves through its grants, NOT manage all', () => {
    const ability = defineAbilityFor(ADMIN_DERIVED, [
      { action: 'read', subject: 'Invoice', conditions: null },
    ]);
    expect(ability.can('manage', 'all')).toBe(false);
    expect(ability.can('read', 'Invoice')).toBe(true);
    // the subtraction actually holds
    expect(ability.can('delete', 'Invoice')).toBe(false);
  });

  it('an ADMIN-derived custom role with no grants can do nothing', () => {
    const ability = defineAbilityFor(ADMIN_DERIVED, []);
    expect(ability.can('read', 'Invoice')).toBe(false);
  });
});

describe('scopeWhereFor - ADMIN short-circuit', () => {
  it('a plain ADMIN is unscoped', () => {
    expect(scopeWhereFor(ADMIN, 'Job', [])).toEqual({});
  });

  it('an ADMIN-derived custom role is scoped by its grants', () => {
    // no read grant -> fail closed, exactly like any other non-admin
    expect(scopeWhereFor(ADMIN_DERIVED, 'Job', [])).toEqual(MATCH_NOTHING);
  });

  it('an ADMIN-derived custom role with an unconditional read widens to org-wide', () => {
    expect(
      scopeWhereFor(ADMIN_DERIVED, 'Job', [{ action: 'read', subject: 'Job', conditions: null }]),
    ).toEqual({});
  });

  it('an ADMIN-derived custom role honours a row-scope condition', () => {
    const scoped = scopeWhereFor(ADMIN_DERIVED, 'Job', [
      { action: 'read', subject: 'Job', conditions: { assignees: { some: { user_id: '{{userId}}' } } } },
    ]);
    expect(scoped).toEqual({ assignees: { some: { user_id: 'u2' } } });
  });
});
