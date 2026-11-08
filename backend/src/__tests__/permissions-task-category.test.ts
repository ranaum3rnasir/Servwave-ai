/**
 * Task categories (visits-and-task-categories slice 08) - the `TaskCategory` permission subject.
 *
 * Every role reads; create, update and delete fall to admins alone (the Tag rename/delete
 * precedent: no default grant for any other role, ADMIN via manage-all). Pins the backfill
 * migration to DEFAULT_GRANTS and drives the real ability builder, modelled on
 * permissions-calendar-entry-backfill.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PERMISSION_CATALOG, isCatalogEntry } from '../lib/permissions/catalog';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { defineAbilityFor } from '../lib/permissions/defineAbility';

const ROLES = ['SALES', 'DISPATCHER', 'TECHNICIAN'] as const;

describe('PERMISSION_CATALOG - TaskCategory', () => {
  it('holds read/create/update/delete, under Tasks', () => {
    const rows = PERMISSION_CATALOG.filter((e) => e.subject === 'TaskCategory');
    expect(rows.map((r) => r.action).sort()).toEqual(['create', 'delete', 'read', 'update']);
    for (const r of rows) expect(r.category).toBe('Tasks');
    for (const a of ['read', 'create', 'update', 'delete']) expect(isCatalogEntry(a, 'TaskCategory')).toBe(true);
  });
});

describe('DEFAULT_GRANTS - TaskCategory', () => {
  it('every non-admin role reads, unconditionally, and holds nothing else', () => {
    const rows = DEFAULT_GRANTS.filter((g) => g.subject === 'TaskCategory');
    expect(rows).toHaveLength(ROLES.length);
    for (const role of ROLES) {
      expect(rows).toContainEqual({ role, action: 'read', subject: 'TaskCategory' });
    }
  });
});

describe('defineAbilityFor - TaskCategory', () => {
  it('a non-admin reads but cannot create, update or delete', () => {
    for (const role of ROLES) {
      const grants = DEFAULT_GRANTS.filter((g) => g.role === role);
      const ability = defineAbilityFor({ id: 'u', role }, grants);
      expect(ability.can('read', 'TaskCategory'), role).toBe(true);
      expect(ability.can('create', 'TaskCategory'), role).toBe(false);
      expect(ability.can('update', 'TaskCategory'), role).toBe(false);
      expect(ability.can('delete', 'TaskCategory'), role).toBe(false);
    }
  });

  it('ADMIN reaches all four through manage-all', () => {
    const ability = defineAbilityFor({ id: 'a', role: 'ADMIN' }, []);
    for (const a of ['read', 'create', 'update', 'delete'] as const) expect(ability.can(a, 'TaskCategory')).toBe(true);
  });
});

describe('backfill in 20260928080000_task_categories', () => {
  const sql = readFileSync(
    join(__dirname, '../../prisma/migrations/20260928080000_task_categories/migration.sql'),
    'utf8',
  );

  it('inserts every TaskCategory default grant for every org, idempotently', () => {
    expect(sql).toMatch(/INSERT INTO role_permissions[\s\S]*FROM organizations o[\s\S]*CROSS JOIN \(VALUES/);
    expect(sql).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING');
    for (const g of DEFAULT_GRANTS.filter((x) => x.subject === 'TaskCategory')) {
      expect(sql).toContain(`('${g.role}','${g.action}','${g.subject}',NULL)`);
    }
  });

  it('also grants read, unconditionally, to every other non-admin role that already reads tasks (custom roles)', () => {
    expect(sql).toMatch(
      /INSERT INTO role_permissions[\s\S]*'read', 'TaskCategory', NULL[\s\S]*SELECT DISTINCT organization_id, role\s+FROM role_permissions\s+WHERE action = 'read' AND subject = 'Task' AND role <> 'ADMIN'[\s\S]*ON CONFLICT \(organization_id, role, action, subject\) DO NOTHING;/,
    );
  });

  it('turns on the tenant bypass, transaction-local, before anything else, so a non-BYPASSRLS owner still writes the rows', () => {
    const statements = sql
      .split('\n')
      .filter((l) => !l.trimStart().startsWith('--'))
      .join('\n')
      .split(';')
      .map((s) => s.trim())
      .filter(Boolean);
    expect(statements[0]).toBe("SELECT set_config('app.bypass_rls', 'on', true)");
    expect(statements[1]).toBe("SET LOCAL lock_timeout = '5s'");
  });

  it('grants no create/update/delete to anyone', () => {
    for (const role of [...ROLES, 'ADMIN']) {
      for (const action of ['create', 'update', 'delete']) {
        expect(sql).not.toContain(`('${role}','${action}','TaskCategory'`);
      }
    }
  });
});
