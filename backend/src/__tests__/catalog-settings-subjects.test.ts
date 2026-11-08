import { describe, it, expect } from 'vitest';
import { PERMISSION_CATALOG } from '../lib/permissions/catalog';
import { defineAbilityFor } from '../lib/permissions/defineAbility';

describe('catalog — settings subjects', () => {
  it('includes Location CRUD and Role read/update', () => {
    const has = (action: string, subject: string) =>
      PERMISSION_CATALOG.some((e) => e.action === action && e.subject === subject);
    expect(has('read', 'Location')).toBe(true);
    expect(has('create', 'Location')).toBe(true);
    expect(has('update', 'Location')).toBe(true);
    expect(has('delete', 'Location')).toBe(true);
    expect(has('read', 'Role')).toBe(true);
    expect(has('update', 'Role')).toBe(true);
  });
  it('ADMIN can manage Location and Role', () => {
    const ability = defineAbilityFor({ id: 'a', role: 'ADMIN' }, []);
    expect(ability.can('read', 'Location' as never)).toBe(true);
    expect(ability.can('update', 'Role' as never)).toBe(true);
  });
});
