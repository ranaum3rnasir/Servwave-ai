/**
 * Scheduling-notifications slice 10 (user stories 24/25): the default TECHNICIAN role gains
 * `en_route Job` on their own job, matching the start and arrive rows, and a migration backfills
 * it for every existing org's TECHNICIAN role.
 *
 * Same pinning discipline as permissions-technician-estimate-read-backfill.test.ts: the condition
 * literal is DERIVED from DEFAULT_GRANTS and looked for verbatim in the SQL, so the grant table and
 * the migration cannot drift without turning this file red.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { subject } from '@casl/ability';
import app from '../app';
import { mockAuthAs, authHeader } from './helpers';
import { prisma } from '../lib/prisma';
import { defineAbilityFor } from '../lib/permissions/defineAbility';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

const TECH_ID = 'tech-1';

/** The abilities a technician in a FRESH org holds: exactly what DEFAULT_GRANTS seeds. */
function freshOrgTechAbility() {
  return defineAbilityFor(
    { id: TECH_ID, role: 'TECHNICIAN' },
    DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN'),
  );
}

// S8 (D6): OWN_JOB reaches crew through the job's trips.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ownJob = subject('Job', { visits: [{ assignees: [{ user_id: TECH_ID }] }] }) as any;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const otherJob = subject('Job', { visits: [{ assignees: [{ user_id: 'someone-else' }] }] }) as any;

describe("a fresh org's TECHNICIAN role holds on-the-way scoped to own job", () => {
  it('may mark their own job on the way', () => {
    expect(freshOrgTechAbility().can('en_route', ownJob)).toBe(true);
  });

  it("may not mark another crew's job on the way", () => {
    expect(freshOrgTechAbility().can('en_route', otherJob)).toBe(false);
  });

  it('holds it exactly as it holds start and arrive (one row, one scope)', () => {
    const rowFor = (action: string) =>
      DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN' && g.action === action && g.subject === 'Job');
    expect(rowFor('en_route')).toHaveLength(1);
    expect(rowFor('en_route')[0]!.conditions).toEqual(rowFor('start')[0]!.conditions);
    expect(rowFor('en_route')[0]!.conditions).toEqual(rowFor('arrive')[0]!.conditions);
  });
});

describe('GET /api/roles/TECHNICIAN/permissions - the roles editor shows the toggle on for a new org', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    // The org's live rows, exactly as a FRESH org is seeded from DEFAULT_GRANTS. The editor
    // derives its toggles from the rows, so this is the admin's view of user story 25 on day one.
    (prisma.rolePermission.findMany as ReturnType<typeof vi.fn>).mockResolvedValue(
      DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN'),
    );
  });

  it('renders enRouteJobs on, alongside arrive and start', async () => {
    const res = await request(app).get('/api/roles/TECHNICIAN/permissions').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.toggles.enRouteJobs).toBe(true);
    expect(res.body.toggles.arriveJobs).toBe(true);
    expect(res.body.toggles.startJobs).toBe(true);
  });
});

const MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20260913150000_technician_en_route_grant_backfill/migration.sql',
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

describe('technician en-route backfill - it writes what DEFAULT_GRANTS says', () => {
  it('writes the exact en_route Job condition from the grant table', () => {
    expect(sql()).toContain(`${conditionLiteralFor('en_route', 'Job')}'::jsonb`);
  });

  it('writes the en_route Job row for the built-in TECHNICIAN role', () => {
    const [stmt] = statements();
    expect(stmt).toContain("'TECHNICIAN'");
    expect(stmt).toContain("'en_route'");
    expect(stmt).toContain("'Job'");
  });
});

describe("technician en-route backfill - it reaches every existing org's TECHNICIAN role and nothing else", () => {
  it('cross-joins every organization, not a derived subset of role_permissions', () => {
    expect(bareSql()).toMatch(/FROM organizations o/);
  });

  it('never names a custom role: the only role literal is TECHNICIAN', () => {
    const roleLiterals = bareSql().match(/'(SALES|DISPATCHER|TECHNICIAN|ADMIN)'/g) ?? [];
    expect(roleLiterals).toEqual(["'TECHNICIAN'"]);
    expect(bareSql()).not.toMatch(/rp\.role|\.role\s*=/);
  });
});

describe('technician en-route backfill - it inserts only where absent, so a wider row is never narrowed', () => {
  it('is a single INSERT guarded by ON CONFLICT DO NOTHING on the role/action/subject unique', () => {
    expect(statements()).toHaveLength(1);
    expect(sql().split('INSERT INTO role_permissions').length - 1).toBe(1);
    expect(sql().split('ON CONFLICT (organization_id, role, action, subject) DO NOTHING').length - 1).toBe(1);
  });

  it('never updates or deletes an existing row (no DO UPDATE, no UPDATE, no DELETE)', () => {
    expect(bareSql()).not.toMatch(/DO UPDATE/i);
    expect(bareSql()).not.toMatch(/^\s*UPDATE\b/im);
    expect(bareSql()).not.toMatch(/^\s*DELETE\b/im);
  });

  it('supplies the app-side defaults raw SQL has to fill in itself (id, updated_at)', () => {
    expect(sql()).toContain('gen_random_uuid()');
    expect(sql()).toMatch(/NOW\(\)/);
  });
});

describe('technician en-route backfill - portability', () => {
  it('uses nothing hosted-database-only (CI runs it on vanilla postgres:16)', () => {
    expect(bareSql()).not.toMatch(/\bauth\./);
    expect(bareSql()).not.toMatch(/\b(authenticated|anon|service_role)\b/);
    expect(bareSql()).not.toMatch(/CREATE POLICY/i);
  });
});
