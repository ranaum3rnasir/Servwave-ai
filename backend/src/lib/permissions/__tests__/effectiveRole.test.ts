import { describe, it, expect } from 'vitest';
import {
  grantRoleKey,
  isSuperUser,
  isReservedRoleKey,
  slugifyRoleKey,
  SYSTEM_ROLE_NAMES,
} from '../effectiveRole';

// SRVW-138 phase one. The whole custom-role bridge is two rules:
//   grant/cache lookup key = custom_role.key ?? role     (new)
//   every existing role branch = role, the BASE role     (unchanged)
// These tests pin both, plus the fail-closed behaviour when the relation is missing.

describe('grantRoleKey', () => {
  it('returns the base role for a user with no custom role', () => {
    expect(grantRoleKey({ role: 'SALES', custom_role_id: null, custom_role: null })).toBe('SALES');
  });

  it('returns the custom role key when one is assigned', () => {
    expect(
      grantRoleKey({
        role: 'SALES',
        custom_role_id: 'cr-1',
        custom_role: { key: 'office-manager' },
      }),
    ).toBe('office-manager');
  });

  // The dangerous case: custom_role_id is set but the relation was not selected.
  // Falling back to the base role would hand the user the BASE role's full grant
  // set - a silent over-grant whenever the custom role is narrower. Throw instead;
  // attachAbility's catch turns it into a 500, which is loud and denies access.
  it('throws when custom_role_id is set but the relation was not loaded', () => {
    expect(() => grantRoleKey({ role: 'SALES', custom_role_id: 'cr-1' })).toThrow(
      /custom_role relation/i,
    );
  });
});

describe('isSuperUser', () => {
  it('is true for a plain ADMIN', () => {
    expect(isSuperUser({ role: 'ADMIN', custom_role_id: null })).toBe(true);
  });

  // The reason the helper exists: an ADMIN-derived custom role must NOT hit the
  // `manage all` short-circuit, or its subtracted grants would be ignored entirely.
  it('is false for an ADMIN-derived custom role', () => {
    expect(isSuperUser({ role: 'ADMIN', custom_role_id: 'cr-1' })).toBe(false);
  });

  it('is false for every non-admin base role', () => {
    for (const role of ['SALES', 'DISPATCHER', 'TECHNICIAN']) {
      expect(isSuperUser({ role, custom_role_id: null })).toBe(false);
    }
  });
});

describe('isReservedRoleKey', () => {
  // Custom keys share the role_permissions.role column with system roles, so a
  // collision would silently merge a custom role's grants into a system role's.
  it('rejects the four system role names', () => {
    for (const name of SYSTEM_ROLE_NAMES) expect(isReservedRoleKey(name)).toBe(true);
  });

  it('rejects them case-insensitively, since keys are slugged lowercase', () => {
    expect(isReservedRoleKey('admin')).toBe(true);
    expect(isReservedRoleKey('Technician')).toBe(true);
  });

  it('allows an ordinary custom key', () => {
    expect(isReservedRoleKey('office-manager')).toBe(false);
  });
});

describe('slugifyRoleKey', () => {
  it('lowercases and hyphenates a label', () => {
    expect(slugifyRoleKey('Office Manager')).toBe('office-manager');
  });

  it('strips punctuation and collapses separators', () => {
    expect(slugifyRoleKey('  Senior   Tech / Lead!  ')).toBe('senior-tech-lead');
  });

  it('throws when a label slugs to nothing', () => {
    expect(() => slugifyRoleKey('!!!')).toThrow(/label/i);
  });
});
