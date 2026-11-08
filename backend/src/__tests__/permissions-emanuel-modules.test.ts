import { describe, it, expect } from 'vitest';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { readFileSync } from 'fs';
import { join } from 'path';
import { defineAbilityFor } from '../lib/permissions/defineAbility';

describe('DEC7/D7 — TECHNICIAN has no Inventory/Communication module grants', () => {
  it('no TECHNICIAN Inventory grant exists', () => {
    const rows = DEFAULT_GRANTS.filter(
      (g) => g.role === 'TECHNICIAN' && g.subject === 'Inventory',
    );
    expect(rows).toHaveLength(0);
  });

  // Superseded TWICE, and DEC7/D7's original "no Communication for techs" no longer holds for
  // reads:
  //   - Task A0 (2026-07-16, ServWave phone master plan) made `create Communication` a
  //     role-agnostic baseline grant on every role (SALES/DISPATCHER/TECHNICIAN), so the `/phone`
  //     softphone surface works for whichever role an org opts into comms - gated by
  //     `useCanAccessCommunication()` (org-level) + this ability check (user-level), never a
  //     hardcoded role list.
  //   - Email slice 8a (2026-08-04) added `read Communication`, because communication visibility
  //     now INHERITS FROM THE ANCHOR ENTITY: a row on a job is visible to whoever can see that
  //     job. Without the read grant that rule was inert for the role it most exists for. The
  //     grant is subject-level; the row scope lives in lib/permissions/anchorVisibility.ts.
  // What still holds from DEC7/D7 is the WRITE side: no update/delete, so a technician cannot
  // reassign attributions or edit templates/automations.
  //
  // #2046 adds a THIRD grant, `access_inbox` - the Communication SECTION gate. Ran's ruling: a
  // role keeps the section only if it holds it TODAY, and TECHNICIAN does (via the `read` grant
  // above), so this is additive, not a widening.
  it('TECHNICIAN Communication grants are exactly `create` (Task A0) + `read` (slice 8a) + `access_inbox` (#2046)', () => {
    const rows = DEFAULT_GRANTS.filter(
      (g) => g.role === 'TECHNICIAN' && g.subject === 'Communication',
    );
    expect(rows).toEqual([
      { role: 'TECHNICIAN', action: 'create', subject: 'Communication' },
      { role: 'TECHNICIAN', action: 'read', subject: 'Communication' },
      { role: 'TECHNICIAN', action: 'access_inbox', subject: 'Communication' },
    ]);
  });

  // Phase B (technician redesign): on-site record_payment is no longer a TECHNICIAN role
  // DEFAULT. It became an opt-in per-user toggle (USER_CAPABILITIES `record_payment Invoice`,
  // own-scoped via the job). So the strict default carries ZERO record_payment grants — the
  // on-site flow is granted per-user, never baked into the role.
  it('TECHNICIAN on-site-payment is NOT a role default (now a per-user toggle)', () => {
    const rows = DEFAULT_GRANTS.filter(
      (g) =>
        g.role === 'TECHNICIAN' &&
        g.action === 'record_payment' &&
        g.subject === 'Invoice',
    );
    expect(rows).toHaveLength(0);
  });
});

describe('backfill migration matches defaultGrants for Inventory/Communication', () => {
  const MIGRATION = join(
    __dirname,
    '../../prisma/migrations/20260602000000_backfill_emanuel_module_grants/migration.sql',
  );
  const sql = readFileSync(MIGRATION, 'utf8');
  const MODULE_SUBJECTS = ['Inventory', 'Communication'];

  it('contains a VALUES row for every SALES/DISPATCHER module grant in defaultGrants', () => {
    // Task A0 (2026-07-16, ServWave phone master plan) added a role-agnostic `create Communication`
    // baseline grant to every role, including SALES — a grant this June-vintage migration predates
    // and never claims to cover. It's backfilled to existing orgs via the role-permissions
    // drift-sync mechanism (backend/src/scripts/check-role-permission-drift.ts), not this migration.
    const isTaskA0Baseline = (g: { role: string; action: string; subject: string }) =>
      g.action === 'create' && g.subject === 'Communication';
    // #2046 added a THIRD Communication grant to DISPATCHER (and TECHNICIAN, out of MODULE_SUBJECTS'
    // scope here), `access_inbox` — the Communication SECTION gate, backfilled to existing orgs by
    // its own migration (20260911180000_communication_section_gate), not this June-vintage one.
    // Same treatment as isTaskA0Baseline above: exclude the new action, never bump the count.
    const is2046SectionGate = (g: { action: string; subject: string }) =>
      g.action === 'access_inbox' && g.subject === 'Communication';
    const expected = DEFAULT_GRANTS.filter(
      (g) =>
        MODULE_SUBJECTS.includes(g.subject) &&
        (g.role === 'SALES' || g.role === 'DISPATCHER') &&
        !(g.role === 'SALES' && isTaskA0Baseline(g)) &&
        !is2046SectionGate(g),
    );
    expect(expected.length).toBe(10); // 2 SALES read + 8 DISPATCHER CRUD (unchanged)
    for (const g of expected) {
      const row = `('${g.role}','${g.action}','${g.subject}',NULL)`;
      expect(sql, `missing migration row: ${row}`).toContain(row);
    }
  });

  it('contains NO TECHNICIAN module rows (DEC7/D7)', () => {
    expect(sql).not.toMatch(/\('TECHNICIAN','[a-z_]+','(Inventory|Communication)'/);
  });

  it('uses the idempotent ON CONFLICT DO NOTHING guard', () => {
    expect(sql).toContain(
      'ON CONFLICT (organization_id, role, action, subject) DO NOTHING',
    );
  });
});

// Expected ability for the two new desktop modules, per role (post-DEC7/D7).
// ADMIN = manage all (code-level). SALES = read-only. DISPATCHER = full CRUD.
// TECHNICIAN = nothing (DEC7/D7: module grants dropped; the desktop app excludes techs) —
// EXCEPT `create Communication`, which Task A0 (2026-07-16, ServWave phone master plan) made a
// role-agnostic baseline grant on every role so the `/phone` softphone surface is gated purely by
// `useCanAccessCommunication()` (org-level) + this ability check (user-level), never a role list.
const MODULE_MATRIX: { action: string; subject: string; allowedRoles: string[] }[] = [
  { action: 'read',   subject: 'Inventory',     allowedRoles: ['ADMIN', 'DISPATCHER', 'SALES'] },
  { action: 'create', subject: 'Inventory',     allowedRoles: ['ADMIN', 'DISPATCHER'] },
  { action: 'update', subject: 'Inventory',     allowedRoles: ['ADMIN', 'DISPATCHER'] },
  { action: 'delete', subject: 'Inventory',     allowedRoles: ['ADMIN', 'DISPATCHER'] },
  // TECHNICIAN joined `read Communication` in email slice 8a - see the note on the
  // TECHNICIAN-grants test above. The subject-level ability is org-wide for every role here;
  // WHICH rows come back is the anchor-inherited row filter's job, not CASL's.
  { action: 'read',   subject: 'Communication', allowedRoles: ['ADMIN', 'DISPATCHER', 'SALES', 'TECHNICIAN'] },
  { action: 'create', subject: 'Communication', allowedRoles: ['ADMIN', 'DISPATCHER', 'SALES', 'TECHNICIAN'] },
  { action: 'update', subject: 'Communication', allowedRoles: ['ADMIN', 'DISPATCHER'] },
  { action: 'delete', subject: 'Communication', allowedRoles: ['ADMIN', 'DISPATCHER'] },
  // #2046 — the Communication SECTION gate (org-wide inbox, call log, phone settings), separate
  // from the `read` row above (the per-record tab). Ran's ruling: a role keeps the section only
  // if it holds it today — DISPATCHER and TECHNICIAN do; SALES does not and must not gain it.
  { action: 'access_inbox', subject: 'Communication', allowedRoles: ['ADMIN', 'DISPATCHER', 'TECHNICIAN'] },
  // Purchasing split (inventory P0, D11): PurchaseOrder + Vendor carved out of the coarse
  // Inventory subject. New-org defaults were dispatcher/admin-only for both reads and writes.
  // #2042 (Ran, 2026-09-10) reopens READ to SALES: `read PurchaseOrder` job-scoped, `read Vendor`
  // unconditional — CASL's class-level `can` (no instance) ignores field conditions, so SALES
  // reads true here; enforcement of the PurchaseOrder job-scope is the controller's
  // scopeWhereForReq (repro-2042.test.ts / inv-po.test.ts). SALES still holds NO write row on
  // either subject.
  { action: 'read',   subject: 'PurchaseOrder', allowedRoles: ['ADMIN', 'DISPATCHER', 'SALES'] },
  { action: 'create', subject: 'PurchaseOrder', allowedRoles: ['ADMIN', 'DISPATCHER'] },
  { action: 'update', subject: 'PurchaseOrder', allowedRoles: ['ADMIN', 'DISPATCHER'] },
  { action: 'delete', subject: 'PurchaseOrder', allowedRoles: ['ADMIN', 'DISPATCHER'] },
  { action: 'read',   subject: 'Vendor',        allowedRoles: ['ADMIN', 'DISPATCHER', 'SALES'] },
  { action: 'create', subject: 'Vendor',        allowedRoles: ['ADMIN', 'DISPATCHER'] },
  { action: 'update', subject: 'Vendor',        allowedRoles: ['ADMIN', 'DISPATCHER'] },
  { action: 'delete', subject: 'Vendor',        allowedRoles: ['ADMIN', 'DISPATCHER'] },
];

const ROLES = ['ADMIN', 'DISPATCHER', 'SALES', 'TECHNICIAN'] as const;

describe('CASL parity — Inventory + Communication + Purchasing subjects', () => {
  for (const route of MODULE_MATRIX) {
    for (const role of ROLES) {
      const shouldAllow = route.allowedRoles.includes(role);
      it(`${role} ${shouldAllow ? 'CAN' : 'CANNOT'} ${route.action} ${route.subject}`, () => {
        const grants = DEFAULT_GRANTS.filter((g) => g.role === role);
        const ability = defineAbilityFor({ id: 'test-user-id', role }, grants);
        expect(ability.can(route.action as any, route.subject as any)).toBe(shouldAllow);
      });
    }
  }
});

// Phase B (technician redesign): record_payment is no longer a TECHNICIAN role default — it is
// an opt-in per-user toggle. With the strict default (no override), the ability must NOT grant
// record_payment Invoice. (This also confirms dropping the Inventory/Communication module grants
// did not accidentally re-add it.) The granted-path positive (own-scoped record_payment) lives
// in the phaseB-controllers-invoice / user-override test files.
describe('CASL — TECHNICIAN on-site payment is NOT a default ability (Phase B)', () => {
  it('TECHNICIAN CANNOT record_payment Invoice by default (per-user toggle now)', () => {
    const grants = DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN');
    const ability = defineAbilityFor({ id: 'test-user-id', role: 'TECHNICIAN' }, grants);
    expect(ability.can('record_payment' as any, 'Invoice' as any)).toBe(false);
  });
});
