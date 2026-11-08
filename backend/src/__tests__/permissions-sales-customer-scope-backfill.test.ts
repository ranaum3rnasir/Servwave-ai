/**
 * #2041 — SALES row-scoped Customer read/update (Ran's decision, 2026-09-10, QA 019). Migration:
 * 20260915120000_sales_customer_row_scope.
 *
 * TWO THINGS ARE PINNED HERE, and the second is the one that would rot silently.
 *
 * 1. The grant itself: DEFAULT_GRANTS (which seeds NEW orgs) and the migration (which backfills
 *    EXISTING ones) must agree, or new and existing orgs diverge — the classic permission bug
 *    that never reproduces on the developer's own org.
 *
 * 2. The migration's SHAPE: derived from the role's own `read Lead` row (never a role name), an
 *    EXPLICIT UPDATE (never `ON CONFLICT DO NOTHING`) over subject='Customer' AND action IN
 *    ('read','update'), with a post-condition that fails the apply on any row left unconditional
 *    or holding a DIFFERENT object (not merely NULL) — R7's stronger predicate.
 *
 * Modelled on permissions-sales-purchasing-backfill.test.ts / permissions-sales-job-assign-backfill.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { isCatalogEntry } from '../lib/permissions/catalog';

const OWN_LEAD = { lead_assignees: { some: { user_id: '{{userId}}' } } };
const OWN_JOB = { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } };
const CREATED_BY_ME = { created_by_id: '{{userId}}' };
const OWN_CUSTOMER = {
  OR: [
    { leads: { some: OWN_LEAD } },
    { jobs: { some: OWN_JOB } },
    CREATED_BY_ME,
  ],
};

const salesGrants = (subject: string) => DEFAULT_GRANTS.filter((g) => g.role === 'SALES' && g.subject === subject);

describe('DEFAULT_GRANTS — what SALES holds on Customer (#2041)', () => {
  it('read/update Customer carry OWN_CUSTOMER; create stays unconditional', () => {
    const rows = salesGrants('Customer');
    expect(rows.map((r) => r.action).sort()).toEqual(['create', 'read', 'update']);
    const create = rows.find((r) => r.action === 'create')!;
    const read = rows.find((r) => r.action === 'read')!;
    const update = rows.find((r) => r.action === 'update')!;
    expect(create.conditions ?? null).toBeNull();
    expect(read.conditions).toEqual(OWN_CUSTOMER);
    expect(update.conditions).toEqual(OWN_CUSTOMER);
  });

  it('OWN_CUSTOMER is composed from the SAME shapes OWN_LEAD/OWN_JOB use elsewhere — never a hand-written duplicate', () => {
    // read Lead / read Job carry the SAME relation shapes one hop up (Customer -> leads -> ... /
    // Customer -> jobs -> ...), so a change to either upstream fragment cannot silently drift
    // from what this grant composes.
    const readLead = DEFAULT_GRANTS.find((g) => g.role === 'SALES' && g.action === 'read' && g.subject === 'Lead')!;
    expect(readLead.conditions).toEqual(OWN_LEAD);
    const readJob = DEFAULT_GRANTS.find((g) => g.role === 'SALES' && g.action === 'read' && g.subject === 'Job');
    // SALES's read Job is OWN_JOB_VIA_ESTIMATE, a DIFFERENT shape (job -> estimate -> lead ->
    // lead_assignees) than OWN_JOB (job -> visits -> assignees) — OWN_CUSTOMER's `jobs` arm is
    // built from OWN_JOB verbatim (the visit-assignee shape), not from SALES's own read-Job
    // condition; this assertion documents that they are deliberately different fragments.
    expect(readJob?.conditions).not.toEqual(OWN_JOB);
  });

  it('the three rows are catalog entries — without this putRolePermissions drops them', () => {
    for (const g of salesGrants('Customer')) {
      expect(isCatalogEntry(g.action, g.subject), `${g.action} ${g.subject} is not a catalog entry`).toBe(true);
    }
  });

  it('ADMIN/DISPATCHER/TECHNICIAN are unaffected — DISPATCHER stays unconditional, TECHNICIAN has no Customer rows', () => {
    const dispatcher = DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER' && g.subject === 'Customer');
    for (const g of dispatcher) {
      if (g.action === 'read' || g.action === 'update') {
        expect(g.conditions ?? null, `DISPATCHER ${g.action} Customer must stay unconditional`).toBeNull();
      }
    }
    const technician = DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN' && g.subject === 'Customer');
    expect(technician).toEqual([]);
  });
});

describe('backfill migration — every existing org AND every custom role, idempotent', () => {
  const NAME = '20260915120000_sales_customer_row_scope';
  const migrationRoot = join(__dirname, '../../prisma/migrations');
  const sql = readFileSync(join(migrationRoot, NAME, 'migration.sql'), 'utf8');
  const code = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  it('exists as a migration folder', () => {
    expect(readdirSync(migrationRoot).filter((n) => statSync(join(migrationRoot, n)).isDirectory())).toContain(NAME);
  });

  it('derives its rows from the OWN_LEAD read-Lead row, not a role name', () => {
    expect(code).toContain(JSON.stringify(OWN_LEAD).replace(/,/g, ', ').replace(/:/g, ': '));
    expect(code).toMatch(/src\.role|target\.role/);
    for (const role of ['DISPATCHER', 'TECHNICIAN', 'SALES', 'ADMIN']) {
      expect(code, `migration hardcodes ${role}`).not.toContain(`'${role}'`);
    }
  });

  it('is an EXPLICIT UPDATE over read/update Customer, never ON CONFLICT DO NOTHING and never touching create', () => {
    expect(code).toMatch(/UPDATE role_permissions/i);
    expect(code).toContain("target.subject = 'Customer'");
    expect(code).toContain("target.action IN ('read', 'update')");
    expect(code).not.toMatch(/ON CONFLICT/i);
    // No `target.conditions` filter on the UPDATE's WHERE — SQL NULL, the JSON text 'null', and
    // any other object are all replaced alike (irrespective of the current value).
    const updateBlock = code.slice(code.indexOf('UPDATE role_permissions'), code.indexOf('DO $$'));
    expect(updateBlock).not.toMatch(/target\.conditions\s*(=|IS|IS DISTINCT)/);
  });

  it('the condition text is byte-equal (jsonb-normalised) to defaultGrants.ts\'s OWN_CUSTOMER', () => {
    const jsonNeedle = JSON.stringify(OWN_CUSTOMER);
    const normalised = code.replace(/\s+/g, '');
    // Appears at least twice — once in the UPDATE's SET, once in the post-condition's predicate.
    const occurrences = normalised.split(jsonNeedle.replace(/\s+/g, '')).length - 1;
    expect(occurrences).toBeGreaterThanOrEqual(2);
  });

  it('the post-condition RAISEs on ANY difference (IS DISTINCT FROM), not only NULL/jsonb-null — R7', () => {
    expect(code).toMatch(/RAISE EXCEPTION/);
    expect(code).toMatch(/IS DISTINCT FROM/);
    // The weaker predicate the spec body's first draft used (R7 called out as insufficient).
    expect(code).not.toMatch(/jsonb_typeof\(rp\.conditions\)\s*=\s*'null'/);
  });

  it('never names a real org, only organization_id values (R5 / CLAUDE.md)', () => {
    const bannedNames = [
      'Northwind Services', 'Lakeside Cabinets', 'Brightline Services', 'Riverbend Septic', 'Summit Moving', 'Servwave Demo',
    ];
    for (const name of bannedNames) {
      expect(sql, `migration header names a real org: ${name}`).not.toContain(name);
    }
  });

  it('portable: no Supabase-only objects', () => {
    expect(sql).not.toMatch(/auth\.\w+\(/);
    expect(sql).not.toMatch(/TO authenticated|TO anon|TO service_role/);
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });

  it('header states the post-condition is NOT the RLS guard (#2042 lesson)', () => {
    expect(sql).toMatch(/NOT THE RLS GUARD|NOT the RLS guard/i);
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/);
  });

  it('grants exactly the conditioned rows DEFAULT_GRANTS gives SALES on read/update Customer', () => {
    const fromDefaults = salesGrants('Customer')
      .filter((g) => g.action === 'read' || g.action === 'update')
      .map((g) => g.action)
      .sort();
    expect(fromDefaults).toEqual(['read', 'update']);
  });
});
