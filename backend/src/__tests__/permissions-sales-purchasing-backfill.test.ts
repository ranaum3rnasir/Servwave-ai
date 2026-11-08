/**
 * #2042 — SALES purchasing grants (Ran's decision, 2026-09-10, QA row 023). Migration:
 * 20260911120000_sales_purchasing_grants.
 *
 * TWO THINGS ARE PINNED HERE, and the second is the one that would rot silently.
 *
 * 1. The grant itself: DEFAULT_GRANTS (which seeds NEW orgs) and the migration (which backfills
 *    EXISTING ones) must agree, or new and existing orgs diverge — the classic permission bug
 *    that never reproduces on the developer's own org.
 *
 * 2. The migration's SHAPE: derived from the role's own `read Job` row (never a role name), the
 *    DELETE half removes the exact drifted population (all PurchaseOrder/Vendor actions, the five
 *    named LogisticOrder actions), the INSERT half writes exactly the seven rows with
 *    `ON CONFLICT ... DO UPDATE` (never `DO NOTHING` — an over-grant must not survive a re-run).
 *
 * Modelled on permissions-sales-job-assign-backfill.test.ts.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { isCatalogEntry } from '../lib/permissions/catalog';

const OWN_JOB_VIA_ESTIMATE = { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } };
const OWN_VIA_JOB = { job: OWN_JOB_VIA_ESTIMATE };

const salesGrants = (subject: string) => DEFAULT_GRANTS.filter((g) => g.role === 'SALES' && g.subject === subject);

describe('DEFAULT_GRANTS — what SALES holds on PurchaseOrder/Vendor/LogisticOrder (#2042)', () => {
  it('holds exactly read PurchaseOrder, job-scoped — no write row', () => {
    const rows = salesGrants('PurchaseOrder');
    expect(rows.map((r) => r.action)).toEqual(['read']);
    expect(rows[0].conditions).toEqual(OWN_VIA_JOB);
  });

  it('holds exactly read Vendor, UNCONDITIONAL — reference data, org-wide, no write row', () => {
    const rows = salesGrants('Vendor');
    expect(rows.map((r) => r.action)).toEqual(['read']);
    expect(rows[0].conditions ?? null).toBeNull();
  });

  it('holds exactly the five job-scoped LogisticOrder verbs — never approve/process/cancel', () => {
    const rows = salesGrants('LogisticOrder');
    expect(rows.map((r) => r.action).sort()).toEqual(['create', 'delete', 'read', 'submit', 'update']);
    for (const row of rows) expect(row.conditions).toEqual(OWN_VIA_JOB);
  });

  it('the seven rows are catalog entries — without this putRolePermissions drops them', () => {
    for (const g of [...salesGrants('PurchaseOrder'), ...salesGrants('Vendor'), ...salesGrants('LogisticOrder')]) {
      expect(isCatalogEntry(g.action, g.subject), `${g.action} ${g.subject} is not a catalog entry`).toBe(true);
    }
  });
});

describe('backfill migration — every existing org AND every custom role, idempotent', () => {
  const NAME = '20260911120000_sales_purchasing_grants';
  const migrationRoot = join(__dirname, '../../prisma/migrations');
  const sql = readFileSync(join(migrationRoot, NAME, 'migration.sql'), 'utf8');
  const code = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  it('exists as a migration folder', () => {
    expect(readdirSync(migrationRoot).filter((n) => statSync(join(migrationRoot, n)).isDirectory())).toContain(NAME);
  });

  it('derives its rows from the OWN_JOB_VIA_ESTIMATE read row, not a role name', () => {
    expect(code).toContain(JSON.stringify(OWN_JOB_VIA_ESTIMATE).replace(/,/g, ', ').replace(/:/g, ': '));
    expect(code).toMatch(/rp\.role/);
    for (const role of ['DISPATCHER', 'TECHNICIAN', 'SALES', 'ADMIN']) {
      expect(code, `migration hardcodes ${role}`).not.toContain(`'${role}'`);
    }
  });

  it('DELETE half removes every action on PurchaseOrder/Vendor, irrespective of conditions', () => {
    expect(code).toMatch(/DELETE FROM role_permissions/i);
    expect(code).toContain("target.subject IN ('PurchaseOrder', 'Vendor')");
    // No `target.conditions` filter — SQL NULL, the JSON text 'null', and any object are caught alike.
    expect(code).not.toMatch(/target\.conditions/);
  });

  it('DELETE half removes exactly the five named LogisticOrder actions, never approve/process/cancel', () => {
    expect(code).toMatch(/target\.subject = 'LogisticOrder'/);
    expect(code).toContain("target.action IN ('read', 'create', 'update', 'delete', 'submit')");
    for (const excluded of ['approve', 'process', 'cancel']) {
      expect(code.match(/target\.action IN \([^)]*\)/)?.[0] ?? '').not.toContain(`'${excluded}'`);
    }
  });

  // Scoped to the INSERT half's own VALUES tuples — the DELETE half's `action IN (...)` list also
  // contains quoted-string pairs and would otherwise pollute a naive whole-file regex match.
  const valuesBlock = code.slice(code.indexOf('CROSS JOIN (VALUES'), code.indexOf(') AS v(action, subject, conditions)'));
  const insertedPairs = () => [...valuesBlock.matchAll(/\('(\w+)',\s*'(\w+)',/g)].map((m) => `${m[1]}:${m[2]}`);

  it('INSERT half writes exactly seven rows with gen_random_uuid()/NOW()/NOW() supplied explicitly', () => {
    expect(code).toMatch(/INSERT INTO role_permissions/i);
    expect(code).toContain('gen_random_uuid()');
    expect(insertedPairs().sort()).toEqual(
      [
        'read:PurchaseOrder',
        'read:Vendor',
        'read:LogisticOrder',
        'create:LogisticOrder',
        'update:LogisticOrder',
        'delete:LogisticOrder',
        'submit:LogisticOrder',
      ].sort(),
    );
  });

  it('the condition text is byte-equal (jsonb-normalised) to defaultGrants.ts\'s OWN_VIA_JOB', () => {
    const jsonNeedle = JSON.stringify(OWN_VIA_JOB);
    // The literal appears verbatim in the VALUES list (modulo whitespace after `:`/`,`).
    const normalised = code.replace(/\s+/g, '');
    expect(normalised).toContain(jsonNeedle.replace(/\s+/g, ''));
  });

  it('uses ON CONFLICT ... DO UPDATE, never DO NOTHING (an over-grant must not survive a re-run)', () => {
    expect(code).toContain('ON CONFLICT (organization_id, role, action, subject) DO UPDATE SET');
    expect(code).not.toMatch(/DO NOTHING/i);
  });

  it('never names a real org, only organization_id values (R5 / CLAUDE.md)', () => {
    // The five real org names the pre-flight evidence recorded must never appear here.
    const bannedNames = [
      'Northwind Services',
      'Lakeside Cabinets',
      'Brightline Services',
      'Riverbend Septic',
      'Summit Moving',
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

  it('grants exactly the verbs DEFAULT_GRANTS gives SALES on these three subjects', () => {
    const fromDefaults = [
      ...salesGrants('PurchaseOrder'),
      ...salesGrants('Vendor'),
      ...salesGrants('LogisticOrder'),
    ]
      .map((g) => `${g.action}:${g.subject}`)
      .sort();
    expect(insertedPairs().sort()).toEqual(fromDefaults);
  });
});
