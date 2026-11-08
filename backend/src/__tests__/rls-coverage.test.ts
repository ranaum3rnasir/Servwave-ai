import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { PrismaClient } from '@prisma/client';

/**
 * COVERAGE RATCHET for the tenant RLS backstop.
 *
 * rls-isolation.test.ts proves the tenant_isolation policy SHAPE is sound, but
 * it builds its own synthetic table to do it - so a real table that ships with
 * no policy at all passes that suite untouched. That is not hypothetical: it is
 * exactly how custom_field_definitions shipped unprotected in SRVW-114 slice 1,
 * and how automation_rules, automation_runs, job_line_items and org_tax_rates
 * reached prod with relrowsecurity=false (issue #1276).
 *
 * The root cause is that 20260703000100_tenant_rls ENUMERATES its tables by
 * hand and nothing ever compares that list against the real schema. This suite
 * is that comparison: it reads pg_class/pg_policies on the freshly-migrated
 * database and fails when any org-scoped table lacks the backstop. A new table
 * with an organization_id column now cannot merge without either a policy or a
 * deliberate, documented entry in GLOBAL_BY_DESIGN below.
 *
 * Runs in the `Database (migrations + RLS)` CI job against the migrated-but-
 * unseeded throwaway Postgres, and skips locally when TEST_DATABASE_URL is
 * unset. Read-only - no DDL, so unlike its sibling suites it cannot race on the
 * shared cluster's system catalog.
 */
const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

/**
 * The canonical tenant_isolation predicate, as Postgres normalizes it back out
 * of pg_policies (fully parenthesized, with ::text/::uuid casts made explicit).
 * Compared verbatim so a table cannot pass with a policy that is merely NAMED
 * tenant_isolation while guarding on something weaker.
 */
const CANONICAL_PREDICATE =
  "((current_setting('app.bypass_rls'::text, true) = 'on'::text) OR " +
  "(organization_id = (NULLIF(current_setting('app.current_org_id'::text, true), ''::text))::uuid))";

/**
 * Tables that carry an organization_id column but are GLOBAL by design, and
 * must NOT get tenant_isolation. Adding a name here is a deliberate security
 * decision - justify it in a comment.
 *
 * - email_suppressions: a hard bounce or spam complaint is a property of the
 *   ADDRESS, not of the org that happened to trigger it. The suppression gate
 *   (lib/email-suppression.ts) reads by {address, category} with no org filter,
 *   and the table's unique key is likewise ([address, category]) across all
 *   orgs; organization_id is nullable provenance, not a tenancy scope. Under
 *   tenant_isolation the gate would stop seeing another org's suppression rows
 *   and would happily re-send to an address that already hard-bounced, which
 *   is a deliverability hazard, not an isolation win. Note this table does not
 *   exist yet on this branch - it ships with the unmerged email slice 4 - so
 *   this entry is pre-emptive and currently matches nothing.
 */
const GLOBAL_BY_DESIGN = new Set<string>(['email_suppressions']);

type TableRow = {
  table_name: string;
  rls_on: boolean;
  forced: boolean;
  policy_names: string | null;
  qual: string | null;
  with_check: string | null;
  api_grants: bigint | number;
};

suite('RLS coverage over every org-scoped table', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  let orgScoped: TableRow[] = [];

  beforeAll(async () => {
    orgScoped = (await prisma.$queryRawUnsafe(`
      SELECT c.relname                                   AS table_name,
             c.relrowsecurity                            AS rls_on,
             c.relforcerowsecurity                       AS forced,
             pol.policy_names,
             pol.qual,
             pol.with_check,
             (SELECT count(*) FROM information_schema.role_table_grants g
               WHERE g.table_schema = 'public'
                 AND g.table_name = c.relname
                 AND g.grantee IN ('anon', 'authenticated'))  AS api_grants
      FROM pg_class c
      JOIN pg_namespace n ON n.oid = c.relnamespace
      LEFT JOIN LATERAL (
        SELECT string_agg(p.policyname, ',' ORDER BY p.policyname) AS policy_names,
               max(p.qual)       FILTER (WHERE p.policyname = 'tenant_isolation') AS qual,
               max(p.with_check) FILTER (WHERE p.policyname = 'tenant_isolation') AS with_check
        FROM pg_policies p
        WHERE p.schemaname = 'public' AND p.tablename = c.relname
      ) pol ON TRUE
      WHERE n.nspname = 'public'
        AND c.relkind = 'r'
        AND EXISTS (
          SELECT 1 FROM information_schema.columns col
          WHERE col.table_schema = 'public'
            AND col.table_name = c.relname
            AND col.column_name = 'organization_id'
        )
      ORDER BY c.relname
    `)) as TableRow[];
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('finds the org-scoped tables at all (guards against a silently empty sweep)', () => {
    // If the catalog query ever breaks, every assertion below would vacuously
    // pass over an empty list. The real schema has ~100 of these.
    expect(orgScoped.length).toBeGreaterThan(50);
  });

  it('sweeps vendor_categories (Purchasing Audit Verdict PR 2 ships the table + policy together)', () => {
    // Pinned by name so the new table cannot slip past the ratchet if the sweep's
    // organization_id predicate ever changes shape.
    expect(orgScoped.map((t) => t.table_name)).toContain('vendor_categories');
  });

  it('every org-scoped table has RLS enabled AND forced', () => {
    const offenders = orgScoped
      .filter((t) => !GLOBAL_BY_DESIGN.has(t.table_name))
      .filter((t) => !t.rls_on || !t.forced)
      .map((t) => `${t.table_name} (enabled=${t.rls_on}, forced=${t.forced})`);
    expect(offenders, 'org-scoped tables missing the RLS backstop').toEqual([]);
  });

  it('every org-scoped table carries the canonical tenant_isolation policy', () => {
    const offenders = orgScoped
      .filter((t) => !GLOBAL_BY_DESIGN.has(t.table_name))
      .filter(
        (t) =>
          !(t.policy_names ?? '').split(',').includes('tenant_isolation') ||
          t.qual !== CANONICAL_PREDICATE ||
          t.with_check !== CANONICAL_PREDICATE,
      )
      .map((t) => `${t.table_name} (policies=${t.policy_names ?? 'none'})`);
    expect(offenders, 'org-scoped tables without the canonical tenant_isolation predicate').toEqual([]);
  });

  it('no org-scoped table is reachable by the anon or authenticated API roles', () => {
    const offenders = orgScoped.filter((t) => Number(t.api_grants) > 0).map((t) => t.table_name);
    expect(offenders, 'org-scoped tables granted to PostgREST roles').toEqual([]);
  });

  it('every GLOBAL_BY_DESIGN exemption is still earning its place', () => {
    // A table that has since been given tenant_isolation should be removed from
    // the exemption list, so the list cannot quietly hide a regression later.
    const stale = orgScoped
      .filter((t) => GLOBAL_BY_DESIGN.has(t.table_name))
      .filter((t) => (t.policy_names ?? '').split(',').includes('tenant_isolation'))
      .map((t) => t.table_name);
    expect(stale, 'exempted tables that now have tenant_isolation - drop them from GLOBAL_BY_DESIGN').toEqual([]);
  });
});
