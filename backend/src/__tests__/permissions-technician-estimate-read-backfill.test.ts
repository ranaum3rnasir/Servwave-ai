/**
 * Follow-up to 20260805150000_technician_creator_control_grants, found in live QA the same day: that
 * migration granted TECHNICIAN `create Estimate` on existing orgs but no `read Estimate`, so a
 * technician's own standalone estimate was invisible to its own creator. This backfill writes the
 * matching `read Estimate` row for the orgs 20260805150000 already reached.
 *
 * Same pinning discipline as permissions-technician-creator-backfill.test.ts: every condition
 * literal is DERIVED from DEFAULT_GRANTS and looked for verbatim in the SQL, so the grant table and
 * the migration cannot drift without turning this file red.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

const MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20260805160000_technician_estimate_read_backfill/migration.sql',
);
const sql = () => readFileSync(MIGRATION, 'utf8');

const bareSql = () =>
  sql()
    .split('\n')
    .filter((l) => !l.trimStart().startsWith('--'))
    .join('\n');

const statements = () =>
  bareSql()
    .split(';')
    .map((s) => s.trim())
    .filter(Boolean);

function conditionLiteralFor(action: string, subject: string): string {
  const grant = DEFAULT_GRANTS.find(
    (g) => g.role === 'TECHNICIAN' && g.action === action && g.subject === subject,
  );
  expect(grant, `DEFAULT_GRANTS has no TECHNICIAN ${action} ${subject}`).toBeDefined();
  return JSON.stringify(grant!.conditions);
}

// The condition 20260805150000's own statement 4 leaves on TECHNICIAN read Job - assigned OR
// created. Gating on THIS (not the older stock own-job shape) is what scopes this backfill to
// exactly the orgs 20260805150000 already reached: an org it skipped (no TECHNICIAN read Job row,
// or one an admin had already re-scoped) never got widened to this shape, so it is skipped here
// too, with zero org ids hardcoded. Neon Services is excluded this way, not by name.
const WIDENED_OWN_OR_CREATED_JOB =
  '{"OR":[{"assignees":{"some":{"user_id":"{{userId}}"}}},{"created_by_id":"{{userId}}"}]}';

describe('technician estimate-read backfill - it writes what DEFAULT_GRANTS says', () => {
  it('writes the exact read Estimate condition from the grant table', () => {
    expect(sql()).toContain(`${conditionLiteralFor('read', 'Estimate')}'::jsonb`);
  });
});

describe('technician estimate-read backfill - it only reaches orgs 20260805150000 already widened', () => {
  it('gates its statement on the widened (assigned-OR-created) read Job condition', () => {
    const stmts = statements();
    expect(stmts).toHaveLength(1);
    expect(stmts[0]).toContain(WIDENED_OWN_OR_CREATED_JOB);
  });

  it('never targets role_permissions by a hardcoded role list alone', () => {
    expect(sql()).toMatch(/FROM role_permissions rp/);
    expect(sql()).toContain("rp.role = 'TECHNICIAN'");
  });
});

describe('technician estimate-read backfill - it is safe to run twice', () => {
  it('guards the INSERT on the role/action/subject unique', () => {
    expect(sql().split('INSERT INTO role_permissions').length - 1).toBe(1);
    expect(sql().split('ON CONFLICT (organization_id, role, action, subject) DO NOTHING').length - 1).toBe(1);
  });

  it('supplies the app-side defaults raw SQL has to fill in itself (id, updated_at)', () => {
    expect(sql()).toContain('gen_random_uuid()');
    expect(sql()).toMatch(/NOW\(\)/);
  });
});

describe('technician estimate-read backfill - portability', () => {
  it('uses nothing Supabase-only (CI runs it on vanilla postgres:16)', () => {
    expect(bareSql()).not.toMatch(/\bauth\./);
    expect(bareSql()).not.toMatch(/\b(authenticated|anon|service_role)\b/);
    expect(bareSql()).not.toMatch(/CREATE POLICY/i);
  });
});
