import { describe, it, expect } from 'vitest';
import { defineAbilityFor } from '../defineAbility';
import { DEFAULT_GRANTS } from '../defaultGrants';

// The phone module (softphone/`/phone` tab) is role-agnostic: every role must be able to
// `create Communication` by default so the feature works for whoever an org grants comm
// access to via `useCanAccessCommunication()` (org-level gate), without per-role grant lists
// drifting out of sync as new roles are added.
const NON_ADMIN_ROLES = ['SALES', 'DISPATCHER', 'TECHNICIAN'] as const;

describe('DEFAULT_GRANTS — create Communication baseline', () => {
  it.each(NON_ADMIN_ROLES)('%s can create Communication', (role) => {
    const grants = DEFAULT_GRANTS.filter((g) => g.role === role);
    const ability = defineAbilityFor({ id: 'u1', role }, grants);
    expect(ability.can('create', 'Communication')).toBe(true);
  });

  it('ADMIN (superuser manage-all) can create Communication', () => {
    const ability = defineAbilityFor({ id: 'a1', role: 'ADMIN' }, []);
    expect(ability.can('create', 'Communication')).toBe(true);
  });

  it('the grant is unconditional for every role (not scoped to own rows)', () => {
    for (const role of NON_ADMIN_ROLES) {
      const grant = DEFAULT_GRANTS.find(
        (g) => g.role === role && g.action === 'create' && g.subject === 'Communication',
      );
      expect(grant).toBeTruthy();
      expect(grant?.conditions).toBeFalsy();
    }
  });
});
