/**
 * #1472 slice 2 — SALES gains `create Customer` directly (019's designed row, Ran's call
 * 2026-09-02). Migration: 20260902120000_sales_create_customer_grant.
 *
 * Two things are pinned here, mirroring permissions-sales-job-assign-backfill.test.ts:
 *
 * 1. DEFAULT_GRANTS (seeds NEW orgs) and the backfill (repairs EXISTING ones) must agree, and say
 *    exactly one new thing — SALES gains `create` and nothing else on Customer.
 * 2. The migration's SQL is well-formed, idempotent, portable and derives from a SHAPE
 *    (`create Lead` + `read Customer`), never a hardcoded role name, because SRVW-138/139 custom
 *    roles write their own `key` into `role_permissions.role`.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { isCatalogEntry } from '../lib/permissions/catalog';

const salesCustomer = (action: string) =>
  DEFAULT_GRANTS.filter((g) => g.role === 'SALES' && g.subject === 'Customer' && g.action === action);

describe('DEFAULT_GRANTS — what SALES holds on Customer', () => {
  it('holds exactly create, read and update — and nothing else', () => {
    const actions = DEFAULT_GRANTS.filter((g) => g.role === 'SALES' && g.subject === 'Customer')
      .map((g) => g.action)
      .sort();
    expect(actions).toEqual(['create', 'read', 'update']);
  });

  it('the new create row is unconditional', () => {
    const rows = salesCustomer('create');
    expect(rows).toHaveLength(1);
    expect(rows[0].conditions).toBeFalsy();
  });

  it('the new pair is a catalog entry — without this putRolePermissions drops it on Save', () => {
    expect(isCatalogEntry('create', 'Customer')).toBe(true);
  });

  it('SALES holds no export, delete, archive, renumber, force_purge or anonymize on Customer', () => {
    for (const action of ['export', 'delete', 'archive', 'renumber', 'force_purge', 'anonymize']) {
      expect(salesCustomer(action), `SALES unexpectedly holds ${action} Customer`).toHaveLength(0);
    }
  });
});

describe('permissions-parity — create Customer is the only entry that changed', () => {
  it('DISPATCHER keeps exactly its existing seven Customer actions', () => {
    const actions = DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER' && g.subject === 'Customer')
      .map((g) => g.action)
      .sort();
    expect(actions).toEqual(['archive', 'create', 'delete', 'export', 'read', 'renumber', 'update'].sort());
  });

  it('TECHNICIAN holds zero Customer actions by default', () => {
    expect(DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN' && g.subject === 'Customer')).toHaveLength(0);
  });
});

describe('backfill migration — every existing org AND every custom role, idempotent', () => {
  const NAME = '20260902120000_sales_create_customer_grant';
  const sql = readFileSync(join(__dirname, '../../prisma/migrations', NAME, 'migration.sql'), 'utf8');
  // Strip comment lines first: this migration's header legitimately contains the word SALES (the
  // §5 measured sets), so it would otherwise trip the role-literal ban below.
  const code = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  it('exists as a migration folder', () => {
    // Presence only — `prisma migrate deploy` applies any folder absent from `_prisma_migrations`
    // regardless of where its timestamp sorts, so asserting on ordering is a time bomb.
    const root = join(__dirname, '../../prisma/migrations');
    expect(readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory())).toContain(NAME);
  });

  it('uses the idempotent ON CONFLICT DO NOTHING guard', () => {
    expect(code).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING');
  });

  it('contains no role-name literal — the gate is a shape, not a role name', () => {
    for (const role of ['SALES', 'DISPATCHER', 'TECHNICIAN', 'ADMIN']) {
      expect(code, `migration hardcodes ${role}`).not.toContain(`'${role}'`);
    }
  });

  it('derives its rows from create Lead + read Customer, not a role name', () => {
    expect(code).toMatch(/subject\s*=\s*'Lead'/);
    expect(code).toMatch(/action\s*=\s*'create'/);
    expect(code).toMatch(/subject\s*=\s*'Customer'/);
    expect(code).toMatch(/action\s*=\s*'read'/);
    expect(code).toMatch(/EXISTS\s*\(/i);
  });

  it('has no DELETE half', () => {
    expect(code).not.toMatch(/DELETE FROM role_permissions/i);
  });

  it('is portable — no Supabase-only objects', () => {
    expect(code).not.toMatch(/auth\./);
    expect(code).not.toMatch(/TO authenticated|TO anon|TO service_role/);
    expect(code).not.toMatch(/CREATE POLICY/i);
  });

  /**
   * Pins the SQL to the code, without reusing the row-020 precedent's regex verbatim (that regex
   * depends on the action literal sitting alone on a two-space-indented line immediately followed
   * by a comma — `permissions-sales-job-assign-backfill.test.ts:161`). This migration's SELECT list
   * is formatted one column per line (spec §2), so the action/subject pair sits on its own two
   * adjacent two-space-indented lines; match that shape directly rather than reusing the other
   * migration's regex.
   */
  it('the inserted action/subject pair equals the Customer verb DEFAULT_GRANTS newly gives SALES', () => {
    const insertMatch = code.match(/INSERT INTO role_permissions[\s\S]*?SELECT\n((?:\s+.+\n){4,})FROM/);
    expect(insertMatch, 'could not locate the INSERT ... SELECT block').not.toBeNull();
    const selectLines = insertMatch![1]
      .split('\n')
      .map((l) => l.trim())
      .filter((l) => l.length > 0)
      .map((l) => l.replace(/,$/, '').replace(/^'|'$/g, ''));
    // Columns are (id, organization_id, role, action, subject, conditions, created_at, updated_at).
    const [, , , action, subject] = selectLines;
    const fromDefaults = DEFAULT_GRANTS.filter((g) => g.role === 'SALES' && g.subject === 'Customer' && g.action !== 'read' && g.action !== 'update');
    expect(fromDefaults).toHaveLength(1);
    expect(action).toBe(fromDefaults[0].action);
    expect(subject).toBe(fromDefaults[0].subject);
  });
});
