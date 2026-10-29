import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { PERMISSION_CATALOG, isCatalogEntry } from '../lib/permissions/catalog';
import { defineAbilityFor } from '../lib/permissions/defineAbility';

// Subject split (inventory P0, plan D11): PurchaseOrder + Vendor split out of the coarse
// Inventory CASL subject. New-org defaults: ADMIN (code-level manage all) + DISPATCHER full
// CRUD on both. TECHNICIAN holds nothing on either. #2042 (Ran, 2026-09-10): SALES reads the
// whole purchasing module and writes nothing in it — `read PurchaseOrder` job-scoped (a PO with
// no job is invisible), `read Vendor` unconditional (reference data, org-wide). Existing orgs
// are grandfathered by the derivation migration pinned below (PurchaseOrder/Vendor subject
// split) and by 20260911_sales_purchasing_grants (the SALES read rows, #2042).

const SPLIT_SUBJECTS = ['PurchaseOrder', 'Vendor'] as const;
const CRUD = ['read', 'create', 'update', 'delete'] as const;
// The job-scoped condition #2042 puts on SALES `read PurchaseOrder` — byte-identical to
// OWN_JOB_VIA_ESTIMATE, nested one level under PurchaseOrder's `job` relation.
const OWN_VIA_JOB = { job: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } } };

describe('catalog — Purchasing subjects', () => {
  for (const subject of SPLIT_SUBJECTS) {
    for (const action of CRUD) {
      it(`has a catalog entry for ${action} ${subject}`, () => {
        expect(isCatalogEntry(action, subject)).toBe(true);
      });
    }
  }

  it('read Inventory description no longer claims vendors/POs', () => {
    const entry = PERMISSION_CATALOG.find(
      (e) => e.action === 'read' && e.subject === 'Inventory',
    );
    expect(entry).toBeDefined();
    expect(entry!.description).not.toMatch(/vendor/i);
    expect(entry!.description).not.toMatch(/\bPOs?\b/);
  });
});

describe('DEFAULT_GRANTS — Purchasing split posture', () => {
  for (const subject of SPLIT_SUBJECTS) {
    it(`DISPATCHER holds exactly the 4 condition-less CRUD rows on ${subject}`, () => {
      const rows = DEFAULT_GRANTS.filter(
        (g) => g.role === 'DISPATCHER' && g.subject === subject,
      );
      expect(rows.map((r) => r.action).sort()).toEqual([...CRUD].sort());
      for (const row of rows) expect(row.conditions).toBeUndefined();
    });

    it(`TECHNICIAN holds zero rows on ${subject} (unchanged by #2042)`, () => {
      const rows = DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN' && g.subject === subject);
      expect(rows).toHaveLength(0);
    });
  }

  it('SALES holds zero PurchaseOrder rows EXCEPT a job-scoped `read` (#2042 — no write row)', () => {
    const rows = DEFAULT_GRANTS.filter((g) => g.role === 'SALES' && g.subject === 'PurchaseOrder');
    expect(rows.map((r) => r.action)).toEqual(['read']);
    expect(rows[0].conditions).toEqual(OWN_VIA_JOB);
  });

  it('SALES holds zero Vendor rows EXCEPT an unconditional `read` (#2042 — reference data, no write row)', () => {
    const rows = DEFAULT_GRANTS.filter((g) => g.role === 'SALES' && g.subject === 'Vendor');
    expect(rows.map((r) => r.action)).toEqual(['read']);
    expect(rows[0].conditions ?? null).toBeNull();
  });
});

const ROLES = ['ADMIN', 'DISPATCHER', 'SALES', 'TECHNICIAN'] as const;

describe('CASL parity — PurchaseOrder + Vendor abilities', () => {
  for (const subject of SPLIT_SUBJECTS) {
    for (const action of CRUD) {
      for (const role of ROLES) {
        // #2042: SALES gained `read` on both subjects (job-scoped on PurchaseOrder, unconditional
        // on Vendor). CASL's class-level `can` (no instance passed) ignores field-level
        // conditions, so a scoped read still resolves true here — enforcement of the condition is
        // the controller's scopeWhereForReq, exercised in inv-po.test.ts / repro-2042.test.ts.
        const shouldAllow =
          role === 'ADMIN' || role === 'DISPATCHER' || (role === 'SALES' && action === 'read');
        it(`${role} ${shouldAllow ? 'CAN' : 'CANNOT'} ${action} ${subject}`, () => {
          const grants = DEFAULT_GRANTS.filter((g) => g.role === role);
          const ability = defineAbilityFor({ id: 'test-user-id', role }, grants);
          expect(ability.can(action as any, subject as any)).toBe(shouldAllow);
        });
      }
    }
  }
});

describe('derivation migration — 20260717040000_split_inventory_purchasing_subjects', () => {
  const migrationPath = join(
    __dirname,
    '../../prisma/migrations/20260717040000_split_inventory_purchasing_subjects/migration.sql',
  );
  const loadSql = () => readFileSync(migrationPath, 'utf8');

  it('DERIVES the new subjects from existing Inventory rows (not a defaults cross-join)', () => {
    const sql = loadSql();
    expect(sql).toContain('FROM role_permissions');
    expect(sql).toContain("subject = 'Inventory'");
    expect(sql).toContain("('PurchaseOrder'), ('Vendor')");
    expect(sql).toContain('NOT EXISTS');
  });

  it('also derives per-user overrides so a manual Inventory deny keeps denying', () => {
    expect(loadSql()).toContain('user_permission_overrides');
  });

  it('does NOT re-grant via a DEFAULT_GRANTS-style role-tuple cross-join', () => {
    // A cross-join of role tuples (the emanuel-backfill shape) would re-grant PO/Vendor to
    // orgs whose admins deliberately removed dispatcher Inventory access. Derivation only.
    const sql = loadSql();
    expect(sql).not.toContain("('DISPATCHER','read','PurchaseOrder'");
    expect(sql).not.toContain("('DISPATCHER','read','Vendor'");
    expect(sql).not.toContain('FROM organizations');
  });
});
