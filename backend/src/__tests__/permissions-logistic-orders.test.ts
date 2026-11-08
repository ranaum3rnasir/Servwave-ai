import { describe, it, expect } from 'vitest';
import { readFileSync, existsSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { isCatalogEntry } from '../lib/permissions/catalog';
import { defineAbilityFor } from '../lib/permissions/defineAbility';
import {
  USER_CAPABILITIES,
  isManagedCapability,
  isManagedCapabilityForRole,
  getManagedCapability,
  capabilityAllowsRole,
} from '../lib/permissions/userCapabilities';
import {
  MODULES,
  assembleRoleViewModel,
  viewModelToGrants,
  type RoleViewModel,
} from '../lib/permissions/roleViewModel';
import { overrideReadGrants } from '../lib/permissions/enforce';
import { scopeWhereFor } from '../lib/permissions/scopeWhereFor';

// Logistic Orders CASL wiring (LO-1, implementation-plan §1.3 / build-readiness §4).
//
// Posture under test:
//   ADMIN      — everything, via the `manage all` short-circuit (no rows anywhere).
//   SALES      — read / create / update / delete / submit, job-scoped (#2042, Ran 2026-09-10:
//                create/edit/delete their own logistic orders, never approves, never processes).
//   DISPATCHER — read / create / update / process / cancel, org-wide. Owns fulfilment.
//   TECHNICIAN — NOTHING in v1 (spec §12 rec 5, signed; re-add with the new tech app).
//   `approve`  — capability-ONLY: absent from PERMISSION_CATALOG so no role can ever hold it.

const SUBJECT = 'LogisticOrder';
const ROLES = ['ADMIN', 'DISPATCHER', 'SALES', 'TECHNICIAN'] as const;
// #2042 — the job-scoped condition on every SALES LogisticOrder verb, byte-identical to
// OWN_JOB_VIA_ESTIMATE nested one level under LogisticOrder's `job` relation.
const OWN_VIA_JOB = { job: { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } } };

const grantsFor = (role: string) => DEFAULT_GRANTS.filter((g) => g.role === role);
const abilityFor = (role: string, overrides: { action: string; subject: string; effect: 'allow' | 'deny' }[] = []) =>
  defineAbilityFor({ id: 'user-1', role }, grantsFor(role), overrides);
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

// ─────────────────────────────────────────────────────────────────────────────────────────────
// THE EMITTER half of the role-permission write path.
//
// putRolePermissions persists `viewModelToGrants(vm).filter(isCatalogEntry)` — TWO layers. The
// tests below cover only the FIRST: that the emitter (MODULES × ACTION_BY_CELL + the two SENSITIVE
// bundles) has no cell capable of producing a capability-only action. They do NOT cover the
// `.filter(isCatalogEntry)` gate, and must not be read as doing so — a previous revision of this
// block rebuilt that filter expression locally and called itself "THE REAL WRITE GATE", but since
// the assertion re-derived the expression instead of driving the handler, deleting the production
// filter left this file 48/48 green. Proven by mutation.
//
// The gate itself is covered in role-permissions-write-gate.test.ts, which drives
// PUT /api/roles/:role/permissions with a mocked emitter that leaks a non-catalog grant and
// asserts on what reaches Prisma. That file DOES go red when the filter is deleted.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('role-permission emitter — no cell can produce a capability-only action', () => {
  // Every cell on, both sensitive bundles on: the maximal grant set a Roles-UI Save can request.
  const fullyEnabledVm = (): RoleViewModel => {
    const matrix: RoleViewModel['matrix'] = {};
    for (const m of MODULES) matrix[m.subject] = { read: true, create: true, update: true, delete: true };
    return {
      role: 'DISPATCHER',
      matrix,
      sensitive: {
        seeFinancials: true, managePayments: true, viewReports: true, editRecordIds: true,
        logPastCommunications: true, accessCommunicationSection: true, assignOthers: true,
      },
      toggles: {
        dashboard: true, accountSettings: true, notifications: true, modifyDoneJobs: true, cancelJobs: true,
        enRouteJobs: true, arriveJobs: true, startJobs: true, completeJobs: true, rescheduleJobs: true,
      },
      scope: {},
      general: { description: '' },
    };
  };

  it('emits a non-empty grant set (guards against a vacuously-passing assertion below)', () => {
    expect(viewModelToGrants(fullyEnabledVm()).length).toBeGreaterThan(0);
  });

  it('a maximal Roles-UI Save can never emit approve on ANY subject', () => {
    expect(viewModelToGrants(fullyEnabledVm()).filter((g) => g.action === 'approve')).toEqual([]);
  });

  it('a maximal Roles-UI Save can never emit location_restricted on ANY subject', () => {
    expect(viewModelToGrants(fullyEnabledVm()).filter((g) => g.action === 'location_restricted')).toEqual([]);
  });

  it('emits LogisticOrder ONLY as read/create/update/delete (never approve/submit/process)', () => {
    const loActions = viewModelToGrants(fullyEnabledVm())
      .filter((g) => g.subject === SUBJECT)
      .map((g) => g.action)
      .sort();
    expect(loActions).toEqual(['create', 'delete', 'read', 'update']);
  });

  it('every grant a maximal Save emits is already a catalog entry (the filter is a no-op today)', () => {
    const emitted = viewModelToGrants(fullyEnabledVm());
    expect(emitted.filter((g) => !isCatalogEntry(g.action, g.subject))).toEqual([]);
  });
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

describe('approve capability — the per-user override is the ONLY way in', () => {
  it('is a managed capability, org-wide (no ownCondition) with impliesRead', () => {
    expect(isManagedCapability('approve', SUBJECT)).toBe(true);
    const cap = getManagedCapability('approve', SUBJECT)!;
    expect(cap.ownCondition).toBeUndefined(); // org-wide → unconditional `can`
    expect(cap.impliesRead).toBe(true); // approver must see the pending queue
  });

  it('a SALES user WITH the allow override CAN approve, while a plain SALES user CANNOT', () => {
    const plain = abilityFor('SALES');
    const granted = abilityFor('SALES', [{ action: 'approve', subject: SUBJECT, effect: 'allow' }]);

    expect(plain.can('approve' as never, SUBJECT as never)).toBe(false);
    expect(granted.can('approve' as never, SUBJECT as never)).toBe(true);
  });

  it('the override does not leak into other verbs (still no process for that SALES user)', () => {
    const granted = abilityFor('SALES', [{ action: 'approve', subject: SUBJECT, effect: 'allow' }]);
    expect(granted.can('process' as never, SUBJECT as never)).toBe(false);
  });

  it('a deny override revokes approve even when previously allowed', () => {
    const denied = abilityFor('SALES', [
      { action: 'approve', subject: SUBJECT, effect: 'allow' },
      { action: 'approve', subject: SUBJECT, effect: 'deny' },
    ]);
    expect(denied.can('approve' as never, SUBJECT as never)).toBe(false);
  });

  it('ships NO dormant process capability — it lands in LO-3 with the route it gates', () => {
    // A dormant capability is latent authority: nothing reads it today, it duplicates
    // DISPATCHER's `process` role default, and for a TECHNICIAN it would silently confer
    // stock-deducting power the moment LO-3 mounts its route.
    expect(getManagedCapability('process', SUBJECT)).toBeUndefined();
    expect(isManagedCapability('process', SUBJECT)).toBe(false);
  });

  it('exposes exactly one LogisticOrder capability (approve)', () => {
    const caps = USER_CAPABILITIES.filter((c) => c.subject === SUBJECT).map((c) => c.action).sort();
    expect(caps).toEqual(['approve']);
  });
});

// ─────────────────────────────────────────────────────────────────────────────────────────────
// `approve LogisticOrder` is ORG-WIDE (no ownCondition) with impliesRead. Chain if ungated:
//   defineAbility no-conditions branch → bare can('read','LogisticOrder')
//   → enforce.overrideReadGrants pushes a grant with conditions undefined
//   → scopeWhereFor's "any unconditional read widens to org-wide" → {} = EVERY LO in the org.
// So handing it to a TECHNICIAN would give them every LO in the org, including jobs they are not
// assigned to — contradicting the signed "no technician LO surface in v1" decision (spec §12
// rec 5; defaultGrants.ts declines a tech read grant on exactly those grounds) and the
// userCapabilities file contract ("per-user grants are FIXED own-scoped").
// The `roles` allow-list is what prevents it, enforced at all four layers.
// ─────────────────────────────────────────────────────────────────────────────────────────────
describe('approve capability — role allow-list (no TECHNICIAN scope blow-out)', () => {
  const cap = () => getManagedCapability('approve', SUBJECT)!;
  const techGrants = DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN');
  const tech = { id: 'tech-1', role: 'TECHNICIAN' };
  const allowApprove = [{ action: 'approve', subject: SUBJECT, effect: 'allow' as const }];

  it('declares SALES + DISPATCHER only', () => {
    expect(cap().roles).toEqual(['SALES', 'DISPATCHER']);
    expect(capabilityAllowsRole(cap(), 'SALES')).toBe(true);
    expect(capabilityAllowsRole(cap(), 'DISPATCHER')).toBe(true);
    expect(capabilityAllowsRole(cap(), 'TECHNICIAN')).toBe(false);
  });

  it('an unrestricted capability stays open to every role (no regression for the existing set)', () => {
    const createLead = getManagedCapability('create', 'Lead')!;
    expect(createLead.roles).toBeUndefined();
    expect(capabilityAllowsRole(createLead, 'TECHNICIAN')).toBe(true);
    // location_restricted is TECHNICIAN-targeted and must stay ungated.
    expect(capabilityAllowsRole(getManagedCapability('location_restricted', 'Inventory')!, 'TECHNICIAN')).toBe(true);
  });

  // (i) SQL scope — the finding's actual exploit path.
  it('a TECHNICIAN with an approve allow-override does NOT get org-wide LO read scope', () => {
    const grants = [...techGrants, ...overrideReadGrants(allowApprove, 'TECHNICIAN')];
    const where = scopeWhereFor(tech, SUBJECT, grants);
    expect(where).not.toEqual({}); // {} would be EVERY LogisticOrder in the org
    expect(where).toEqual({ id: { in: [] } }); // no LO read grant at all → fail-closed
    expect(overrideReadGrants(allowApprove, 'TECHNICIAN')).toEqual([]);
  });

  // #2042 security fix round 1 (F2) — the approve capability has no ownCondition of its own
  // (approval is org-wide authority), so the synthesized read used to be unconditional
  // regardless of the role's own read scope. That was correct while SALES held an unconditional
  // `read LogisticOrder` default, but #2042 (slice 2) re-conditioned it to OWN_VIA_JOB, so the
  // override must now inherit THAT condition instead of widening it back to org-wide.
  it("a SALES user with the same override inherits their OWN job-scoped LO read, not org-wide", () => {
    const salesGrants = DEFAULT_GRANTS.filter((g) => g.role === 'SALES');
    const synthesized = overrideReadGrants(allowApprove, 'SALES', salesGrants);
    const ownViaJob = salesGrants.find((g) => g.action === 'read' && g.subject === SUBJECT)!.conditions;
    expect(ownViaJob).toBeTruthy(); // sanity: SALES's own read LO grant IS conditioned
    expect(synthesized).toEqual([{ action: 'read', subject: SUBJECT, conditions: ownViaJob }]);
    const where = scopeWhereFor({ id: 's1', role: 'SALES' }, SUBJECT, [...salesGrants, ...synthesized]);
    expect(where).not.toEqual({}); // {} would be EVERY LogisticOrder in the org
    expect(where).toEqual({
      job: { estimate: { lead: { lead_assignees: { some: { user_id: 's1' } } } } },
    });
  });

  it('a DISPATCHER user with the same override keeps the org-wide read the capability intends (unconditional default, unchanged)', () => {
    const dispatcherGrants = DEFAULT_GRANTS.filter((g) => g.role === 'DISPATCHER');
    const synthesized = overrideReadGrants(allowApprove, 'DISPATCHER', dispatcherGrants);
    expect(synthesized).toEqual([{ action: 'read', subject: SUBJECT, conditions: undefined }]);
    expect(
      scopeWhereFor({ id: 'd1', role: 'DISPATCHER' }, SUBJECT, [...dispatcherGrants, ...synthesized]),
    ).toEqual({});
  });

  // CASL side of the same override.
  it('a TECHNICIAN with the allow-override can neither approve nor read a LogisticOrder', () => {
    const ability = defineAbilityFor(tech, techGrants, allowApprove);
    expect(ability.can('approve' as never, SUBJECT as never)).toBe(false);
    expect(ability.can('read' as never, SUBJECT as never)).toBe(false);
  });

  it('the same override on SALES still works (the gate is role-specific, not a blanket block)', () => {
    const ability = defineAbilityFor({ id: 's1', role: 'SALES' }, grantsFor('SALES'), allowApprove);
    expect(ability.can('approve' as never, SUBJECT as never)).toBe(true);
  });

  // (ii)/(iii) endpoint predicates — asserted end-to-end in
  // user-permissions-endpoints-logistic-orders.test.ts.
  it('isManagedCapabilityForRole refuses approve for TECHNICIAN but allows it for SALES/DISPATCHER', () => {
    expect(isManagedCapabilityForRole('approve', SUBJECT, 'TECHNICIAN')).toBe(false);
    expect(isManagedCapabilityForRole('approve', SUBJECT, 'SALES')).toBe(true);
    expect(isManagedCapabilityForRole('approve', SUBJECT, 'DISPATCHER')).toBe(true);
    // Still a managed capability in the abstract — the role is what disqualifies it.
    expect(isManagedCapability('approve', SUBJECT)).toBe(true);
  });
});

// SRVW-101 fail-closed coverage for the generic `!cap` branch lives in
// define-ability-unmanaged-overrides.test.ts. This block keeps only what is LogisticOrder-
// specific: `process` is the concrete cataloged-but-unmanaged pair that motivated the fix, and
// the role allow-list (approve) must stay unaffected by it.
describe('per-user overrides - UNMANAGED (action, subject) rows fail CLOSED, except the two grandfathered pairs', () => {
  const tech = { id: 'tech-1', role: 'TECHNICIAN' };

  it('process LogisticOrder is cataloged but NOT a managed capability (why the branch is reached)', () => {
    expect(getManagedCapability('process', SUBJECT)).toBeUndefined();
    // Catalog membership is therefore NOT a usable gate here — it would let this row straight through.
    expect(isCatalogEntry('process', SUBJECT)).toBe(true);
  });

  it('the role allow-list still holds for MANAGED capabilities (approve is unaffected)', () => {
    const ability = defineAbilityFor(tech, grantsFor('TECHNICIAN'), [
      { action: 'approve', subject: SUBJECT, effect: 'allow' },
    ]);
    expect(ability.can('approve' as never, SUBJECT as never)).toBe(false);
  });
});

describe('role matrix view model — LogisticOrder module', () => {
  it('exposes LogisticOrder as a CRUD module', () => {
    expect(MODULES.map((m) => m.subject)).toContain(SUBJECT);
    expect(MODULES.find((m) => m.subject === SUBJECT)!.label).toBe('Logistic Orders');
  });

  it('assembles the CRUD cells from DEFAULT_GRANTS (DISPATCHER: read/create/update, no delete)', () => {
    const vm = assembleRoleViewModel('DISPATCHER', grantsFor('DISPATCHER'));
    expect(vm.matrix[SUBJECT]).toEqual({ read: true, create: true, update: true, delete: false });
  });

  // #2042 — SALES gained update/delete on their own logistic orders; the matrix cell is a bare
  // CRUD boolean (job-scoping is invisible on this cell, same as PurchaseOrder's read cell).
  it('assembles SALES cells as full CRUD (job-scoped, #2042)', () => {
    const vm = assembleRoleViewModel('SALES', grantsFor('SALES'));
    expect(vm.matrix[SUBJECT]).toEqual({ read: true, create: true, update: true, delete: true });
  });

  it('does NOT add LogisticOrder to the scope chips (no SCOPE_CONDITIONS entry → would throw)', () => {
    // assembleRoleViewModel indexes SCOPE_CONDITIONS[subject][scopeValue] for every SCOPE_ENTITY;
    // a scope entity without a matching SCOPE_CONDITIONS key TypeErrors on every roles-page load.
    const vm = assembleRoleViewModel('DISPATCHER', grantsFor('DISPATCHER'));
    expect(vm.scope[SUBJECT]).toBeUndefined();
  });
});

// The Roles page keeps its own hand-maintained MODULES array with no import from the backend.
// If it drifts, role.controller.ts's MANAGED_KEYS still manages the LogisticOrder CRUD keys while
// the page posts a view model with no LogisticOrder matrix cell — viewModelToGrants falls back to
// all-false and a Save DELETES all four grants. That is silent data loss, hence this parity test.
describe('frontend RolesPage MODULES parity', () => {
  const rolesPagePath = join(__dirname, '../../../frontend/src/pages/settings/RolesPage.tsx');

  it('the RolesPage source is where we expect it (guards against a silent skip)', () => {
    expect(existsSync(rolesPagePath)).toBe(true);
  });

  it('renders every backend MODULES subject, in the same order', () => {
    const src = readFileSync(rolesPagePath, 'utf8');
    const block = src.slice(src.indexOf('const MODULES'), src.indexOf('const CRUD'));
    const rendered = [...block.matchAll(/\['([A-Za-z]+)',\s*'[^']*'\]/g)].map((m) => m[1]);
    expect(rendered).toEqual(MODULES.map((m) => m.subject));
  });

  // SRVW-139 - extends the subject-only check above with the label text, so a row added on one
  // side with the right subject but a copy-pasted/mismatched label still fails loudly instead of
  // rendering a module under the wrong name.
  it('renders every backend MODULES label, matching the label text', () => {
    const src = readFileSync(rolesPagePath, 'utf8');
    const block = src.slice(src.indexOf('const MODULES'), src.indexOf('const CRUD'));
    const rendered = [...block.matchAll(/\['([A-Za-z]+)',\s*'([^']*)'\]/g)].map((m) => [m[1], m[2]]);
    expect(rendered).toEqual(MODULES.map((m) => [m.subject, m.label]));
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
