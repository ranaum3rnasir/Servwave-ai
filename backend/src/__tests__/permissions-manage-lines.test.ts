/**
 * B5 — RBAC catalog + default grants: `manage_lines Invoice`
 *
 * Asserts:
 *  1. `Action` union accepts `'manage_lines'` (TypeScript compile gate via cast).
 *  2. PERMISSION_CATALOG has an entry for `manage_lines Invoice`.
 *  3. After seeding DEFAULT_GRANTS, DISPATCHER (unconditional) and SALES (own-via-lead)
 *     each resolve a `manage_lines Invoice` grant. TECHNICIAN does NOT by default — the
 *     strict-technician model (#253) makes it a per-user opt-in, never a role default.
 */
import { describe, it, expect } from 'vitest';
import { PERMISSION_CATALOG, type Action } from '../lib/permissions/catalog';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { defineAbilityFor } from '../lib/permissions/defineAbility';

// Type-level assertion: 'manage_lines' must be assignable to Action (compile gate).
const _typeCheck: Action = 'manage_lines';
void _typeCheck;

describe('B5 — manage_lines Invoice in catalog', () => {
  it('PERMISSION_CATALOG contains manage_lines Invoice entry', () => {
    const entry = PERMISSION_CATALOG.find(
      (e) => e.action === 'manage_lines' && e.subject === 'Invoice',
    );
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('Invoices');
  });
});

describe('B5 — DEFAULT_GRANTS: manage_lines Invoice grants per role', () => {
  function abilityFor(role: 'ADMIN' | 'DISPATCHER' | 'TECHNICIAN' | 'SALES') {
    const grants = DEFAULT_GRANTS.filter((g) => g.role === role);
    return defineAbilityFor({ id: 'test-user', role }, grants);
  }

  it('ADMIN can manage_lines Invoice (via manage all)', () => {
    // ADMIN gets manage all via defineAbilityFor — no explicit grant needed.
    expect(abilityFor('ADMIN').can('manage_lines', 'Invoice')).toBe(true);
  });

  it('DISPATCHER can manage_lines Invoice (unconditional)', () => {
    expect(abilityFor('DISPATCHER').can('manage_lines', 'Invoice')).toBe(true);
  });

  it('TECHNICIAN does NOT have manage_lines Invoice by default (strict model — per-user opt-in)', () => {
    // Phase B strict technician (#253): a technician is read-only by default; manage_lines is
    // granted per-user, never as a role default. (invoice-lines.test.ts covers the granted path.)
    expect(abilityFor('TECHNICIAN').can('manage_lines', 'Invoice')).toBe(false);
  });

  it('SALES can manage_lines Invoice (own-invoice-via-lead scoped grant)', () => {
    expect(abilityFor('SALES').can('manage_lines', 'Invoice')).toBe(true);
  });
});
