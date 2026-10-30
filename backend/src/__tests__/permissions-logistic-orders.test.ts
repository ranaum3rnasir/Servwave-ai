import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { isCatalogEntry } from '../lib/permissions/catalog';
import { defineAbilityFor } from '../lib/permissions/defineAbility';
import { compileSwitchGrants } from '../lib/permissions/switches/store';
import { presetSwitchSet } from '../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../lib/permissions/switches/validate';
import { scopeWhereFor } from '../lib/permissions/scopeWhereFor';

// Logistic Orders CASL wiring (LO-1, implementation-plan §1.3 / build-readiness §4).
//
// Posture under test:
//   ADMIN      — everything, via the `manage all` short-circuit (no rows anywhere).
//   SALES      — read / create / update / delete / submit, job-scoped (#2042, Ran 2026-09-10:
//                create/edit/delete their own logistic orders, never approves, never processes).
//   DISPATCHER — read / create / update / process / cancel, org-wide. Owns fulfilment.
//   TECHNICIAN — NOTHING in v1 (spec §12 rec 5, signed; re-add with the new tech app).
//   `approve`  — the Approve logistic orders switch (S01.9); absent from PERMISSION_CATALOG so no stored role grant
//                can hold it.

const SUBJECT = 'LogisticOrder';
const ROLES = ['ADMIN', 'DISPATCHER', 'SALES', 'TECHNICIAN'] as const;
// #2042 — the job-scoped condition on every SALES LogisticOrder verb, byte-identical to
// OWN_JOB_VIA_ESTIMATE nested one level under LogisticOrder's `job` relation.
const OWN_VIA_JOB = { job: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } } };

const grantsFor = (role: string) => DEFAULT_GRANTS.filter((g) => g.role === role);
const abilityFor = (role: string) => defineAbilityFor({ is_admin: role === 'ADMIN', id: 'user-1', role }, grantsFor(role));
const actionsFor = (role: string) =>
  DEFAULT_GRANTS.filter((g) => g.role === role && g.subject === SUBJECT)
    .map((g) => g.action)
    .sort();

describe('catalog — LogisticOrder subject', () => {
  for (const action of ['read', 'create', 'update', 'delete', 'submit', 'process', 'cancel']) {
    it(`has a catalog entry for ${action} ${SUBJECT}`, () => {
      expect(isCatalogEntry(action, SUBJECT)).toBe(true);
    });
  }

  it('does NOT expose approve as a catalog entry (capability-only, mirrors location_restricted)', () => {
    expect(isCatalogEntry('approve', SUBJECT)).toBe(false);
  });
});

// Editable record IDs (2026-08-19 plan, decision #7) - defense in depth, same shape as the
// `approve` catalog check above: 'renumber' is deliberately scoped to Customer/Lead/Estimate/Job/
// Invoice ONLY, so it must never become a catalog entry (and therefore never a role grant, see
// THE GATE note in catalog.ts) on any subject outside that set.
describe('catalog - renumber is scoped to exactly the 5 editable-record-id subjects', () => {
  for (const subject of ['Customer', 'Lead', 'Estimate', 'Job', 'Invoice']) {
    it(`has a catalog entry for renumber ${subject}`, () => {
      expect(isCatalogEntry('renumber', subject)).toBe(true);
    });
  }

  for (const subject of ['PurchaseOrder', 'LogisticOrder', 'Vendor', 'Inventory', 'User', 'Communication']) {
    it(`does NOT expose renumber on ${subject}`, () => {
      expect(isCatalogEntry('renumber', subject)).toBe(false);
    });
  }
});

describe('DEFAULT_GRANTS — LogisticOrder posture', () => {
  it('SALES holds exactly read/create/update/delete/submit, ALL job-scoped — and notably NOT approve or process', () => {
    expect(actionsFor('SALES')).toEqual(['create', 'delete', 'read', 'submit', 'update']);
    expect(actionsFor('SALES')).not.toContain('approve');
    expect(actionsFor('SALES')).not.toContain('process');
  });

  // #2042 — every SALES LogisticOrder verb carries the rep's-own-job condition; the condition on
  // `create` is load-bearing (createLogisticOrder reads it to validate the anchor), not inert.
  it('every SALES LogisticOrder grant is job-scoped to OWN_VIA_JOB', () => {
    const rows = DEFAULT_GRANTS.filter((g) => g.role === 'SALES' && g.subject === SUBJECT);
    expect(rows.length).toBe(5);
    for (const row of rows) expect(row.conditions).toEqual(OWN_VIA_JOB);
  });

  it('DISPATCHER holds exactly read/create/update/process/cancel — including process', () => {
    expect(actionsFor('DISPATCHER')).toEqual(['cancel', 'create', 'process', 'read', 'update']);
    expect(actionsFor('DISPATCHER')).toContain('process');
  });

  it('DISPATCHER does NOT hold submit (that is the requester verb)', () => {
    expect(actionsFor('DISPATCHER')).not.toContain('submit');
  });

  it('DISPATCHER holds LogisticOrder org-wide, unchanged by #2042', () => {
    const rows = DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER' && g.subject === SUBJECT);
    for (const row of rows) expect(row.conditions).toBeUndefined();
  });

  it('TECHNICIAN holds ZERO LogisticOrder rows in v1 (spec §12 rec 5, signed)', () => {
    expect(actionsFor('TECHNICIAN')).toEqual([]);
  });

  it('no role holds approve — it must never reach role_permissions', () => {
    const approvers = DEFAULT_GRANTS.filter((g) => g.subject === SUBJECT && g.action === 'approve');
    expect(approvers).toEqual([]);
  });
});

describe('CASL — ability resolution per role', () => {
  it('ADMIN short-circuits to manage-all and CAN do every LogisticOrder verb', () => {
    const admin = abilityFor('ADMIN');
    for (const action of ['read', 'create', 'update', 'delete', 'submit', 'approve', 'process', 'cancel']) {
      expect(admin.can(action as never, SUBJECT as never)).toBe(true);
    }
  });

  it('SALES CAN submit but CANNOT approve or process', () => {
    const sales = abilityFor('SALES');
    expect(sales.can('submit' as never, SUBJECT as never)).toBe(true);
    expect(sales.can('approve' as never, SUBJECT as never)).toBe(false);
    expect(sales.can('process' as never, SUBJECT as never)).toBe(false);
  });

  it('DISPATCHER CAN process and cancel but CANNOT approve', () => {
    const dispatcher = abilityFor('DISPATCHER');
    expect(dispatcher.can('process' as never, SUBJECT as never)).toBe(true);
    expect(dispatcher.can('cancel' as never, SUBJECT as never)).toBe(true);
    expect(dispatcher.can('approve' as never, SUBJECT as never)).toBe(false);
  });

  it('TECHNICIAN CANNOT even read a LogisticOrder', () => {
    expect(abilityFor('TECHNICIAN').can('read' as never, SUBJECT as never)).toBe(false);
  });

  it('no non-admin role can approve straight from DEFAULT_GRANTS', () => {
    for (const role of ROLES.filter((r) => r !== 'ADMIN')) {
      expect(abilityFor(role).can('approve' as never, SUBJECT as never)).toBe(false);
    }
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// The switch compiles to an `approve LogisticOrder` grant narrowed to the orders the person reaches. Without that
// narrowing an approver on a Technician base would read every logistic order in the company (the blow-out the old
// role list guarded against); with it, the reach is the person's own Jobs and Leads scope.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('Approve logistic orders — the switch reaches only the orders the holder can open', () => {
  const holder = (role: 'TECHNICIAN' | 'SALES' | 'DISPATCHER', values: Record<string, boolean | string> = {}) =>
    compileSwitchGrants({ ...presetSwitchSet(role), approve_logistic_orders: true, view_logistic_orders: true, ...values });
  const person = { id: 'p1', role: 'TECHNICIAN', is_admin: false };

  it('gives a Technician-based approver the approve grant, but a read scoped to their own jobs and leads, never org-wide', () => {
    const grants = holder('TECHNICIAN');
    expect(grants.some((g) => g.action === 'approve' && g.subject === SUBJECT)).toBe(true);
    const where = scopeWhereFor(person, SUBJECT, grants);
    expect(where).not.toEqual({}); // {} would be EVERY LogisticOrder in the company
    expect(where).not.toEqual({ id: { in: [] } });
    // The approve grant is bounded the same way, so approval cannot reach an order the holder cannot open.
    expect(scopeWhereFor(person, SUBJECT, grants, 'approve')).toEqual(where);
  });

  it('keeps a Sales-based approver on the kept Through own leads reach, plus the leads they can open', () => {
    const where = scopeWhereFor({ is_admin: false, id: 's1', role: 'SALES' }, SUBJECT, holder('SALES'));
    expect(JSON.stringify(where)).toContain('lead_assignees');
    expect(where).not.toEqual({});
  });

  it('gives a Dispatcher-based approver with Jobs and Leads scope All every order, unconditionally', () => {
    expect(scopeWhereFor({ is_admin: false, id: 'd1', role: 'DISPATCHER' }, SUBJECT, holder('DISPATCHER'))).toEqual({});
  });

  it('gives nothing to a person without View logistic orders: the Requires keeps approval off with it', () => {
    const set = { ...presetSwitchSet('ADMIN'), view_logistic_orders: false };
    expect(validateSwitchSet(set).some((v) => v.switchKey === 'approve_logistic_orders')).toBe(true);
  });
});

describe('seeding migration — 20260720120000_logistic_orders_foundations', () => {
  const migrationPath = join(
    __dirname,
    '../../prisma/migrations/20260720120000_logistic_orders_foundations/migration.sql',
  );
  const loadSql = () => readFileSync(migrationPath, 'utf8');

  it('seeds via an idempotent cross-join over organizations', () => {
    const sql = loadSql();
    expect(sql).toContain('INSERT INTO role_permissions');
    expect(sql).toContain('FROM organizations o');
    expect(sql).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING;');
  });

  it('contains exactly the LogisticOrder rows DEFAULT_GRANTS held on 2026-07-20 (a point-in-time seed)', () => {
    const sql = loadSql();
    const seeded = [...sql.matchAll(/\('(\w+)','(\w+)','LogisticOrder',NULL\)/g)]
      .map((m) => `${m[1]}:${m[2]}`)
      .sort();
    // DISPATCHER's rows are still condition-less and unchanged by #2042 — read live.
    // SALES's three rows are pinned literally, not derived from live DEFAULT_GRANTS: #2042
    // re-conditions all three (and adds update/delete) via a LATER migration
    // (20260911..._sales_purchasing_grants), so DEFAULT_GRANTS has since diverged from what THIS
    // migration seeded — deliberately, and not by editing this historical file.
    const expected = [
      ...DEFAULT_GRANTS.filter((g) => g.subject === SUBJECT && g.role === 'DISPATCHER').map(
        (g) => `${g.role}:${g.action}`,
      ),
      'SALES:create',
      'SALES:read',
      'SALES:submit',
    ].sort();
    expect(seeded).toEqual(expected);
  });

  it('seeds no other subject (scoped migration, not a full DEFAULT_GRANTS sweep)', () => {
    const sql = loadSql();
    const subjectsInValues = new Set(
      [...sql.matchAll(/^\s*\('\w+','\w+','(\w+)',/gm)].map((m) => m[1]),
    );
    expect([...subjectsInValues]).toEqual([SUBJECT]);
  });

  it('never seeds approve, and never seeds a TECHNICIAN row', () => {
    const sql = loadSql();
    expect(sql).not.toMatch(/'approve','LogisticOrder'/);
    expect(sql).not.toMatch(/\('TECHNICIAN','\w+','LogisticOrder'/);
  });
});
