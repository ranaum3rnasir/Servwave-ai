/**
 * #2046 — the Communication SECTION gate, `access_inbox Communication`. Separate from the
 * per-record `read Communication` tab: a NEW action on the EXISTING subject, same shape as the
 * `log_past` precedent (catalog.ts:44-52). Prior art: permissions-manual-communication-log.test.ts,
 * permissions-assign-others-backfill.test.ts (the AC10 stale-tab guard below is modelled line for
 * line on that file's `saveWithoutTheKey` pattern).
 *
 * TWO THINGS ARE PINNED HERE, and the second is the one that would rot silently.
 *
 * 1. The grant itself: DEFAULT_GRANTS (which seeds NEW orgs) and the migration (which backfills
 *    EXISTING ones) must derive the SAME set, or new and existing orgs diverge.
 *
 * 2. The migration's SHAPE: derived from (a) holding `read Communication` and (b) the role's own
 *    `read Job` row NOT being the exact OWN_JOB_VIA_ESTIMATE predicate — never a role name, so a
 *    custom role cloned from DISPATCHER or SALES is covered by construction (schema.prisma:
 *    role_permissions.role has no custom_role_id column).
 */
import { describe, it, expect, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { PERMISSION_CATALOG, isCatalogEntry } from '../lib/permissions/catalog';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { assembleRoleViewModel, viewModelToGrants, type RoleViewModel } from '../lib/permissions/roleViewModel';
import { defineAbilityFor } from '../lib/permissions/defineAbility';
import { mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const ACTION = 'access_inbox';
const SUBJECT = 'Communication';
const OWN_JOB_VIA_ESTIMATE = { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } };

// ─── The catalog entry ──────────────────────────────────────────────────────────────────────

describe('PERMISSION_CATALOG — the access_inbox:Communication entry', () => {
  it('holds exactly one access_inbox:Communication row, filed under Communication', () => {
    const rows = PERMISSION_CATALOG.filter((e) => e.action === ACTION && e.subject === SUBJECT);
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('Communication');
  });

  it('the description names no vendor and implies no vendor dashboard (CLAUDE.md)', () => {
    const row = PERMISSION_CATALOG.find((e) => e.action === ACTION && e.subject === SUBJECT)!;
    const lower = row.description.toLowerCase();
    for (const banned of ['calltrackingmetrics', 'ctm', 'supabase', 'render']) {
      expect(lower).not.toContain(banned);
    }
  });

  it('isCatalogEntry recognizes it — without this putRolePermissions silently drops the grant', () => {
    expect(isCatalogEntry(ACTION, SUBJECT)).toBe(true);
  });
});

// ─── DEFAULT_GRANTS posture ─────────────────────────────────────────────────────────────────

describe('DEFAULT_GRANTS — who holds access_inbox:Communication out of the box', () => {
  const rows = () => DEFAULT_GRANTS.filter((g) => g.action === ACTION && g.subject === SUBJECT);

  it('is held by exactly DISPATCHER and TECHNICIAN, both unconditional', () => {
    expect(rows()).toEqual([
      { role: 'DISPATCHER', action: ACTION, subject: SUBJECT },
      { role: 'TECHNICIAN', action: ACTION, subject: SUBJECT },
    ]);
  });

  it('SALES does not hold it — Ran\'s decision keeps the section closed for SALES', () => {
    expect(rows().filter((g) => g.role === 'SALES')).toEqual([]);
  });

  it('ADMIN has no row and needs none (manage-all); DEFAULT_GRANTS cannot even express one', () => {
    expect(rows().filter((g) => (g as { role: string }).role === 'ADMIN')).toEqual([]);
  });

  it('every role holding the section gate still holds read Communication (never one without the other)', () => {
    const holdsSection = new Set(rows().map((g) => g.role));
    const holdsRead = new Set(
      DEFAULT_GRANTS.filter((g) => g.action === 'read' && g.subject === SUBJECT).map((g) => g.role),
    );
    for (const role of holdsSection) expect(holdsRead.has(role)).toBe(true);
  });

  it('every non-admin role still holds read/create Communication (unnarrowed by this fix)', () => {
    for (const role of ['SALES', 'DISPATCHER', 'TECHNICIAN']) {
      const reads = DEFAULT_GRANTS.filter((g) => g.role === role && g.action === 'read' && g.subject === SUBJECT);
      expect(reads.length).toBeGreaterThan(0);
    }
  });
});

// ─── The catalog entry driven THROUGH viewModelToGrants + assembleRoleViewModel ────────────
// A bare "is it in PERMISSION_CATALOG" assertion is a placebo (catalog.ts's own comment says so);
// the invariant is driven through the same emitter/assembler putRolePermissions actually uses.

describe('the sensitive bundle persists and un-persists the capability', () => {
  function baselineVm(overrides: Partial<RoleViewModel['sensitive']> = {}): RoleViewModel {
    return {
      role: 'DISPATCHER',
      matrix: { Communication: { read: true, create: true, update: false, delete: false } },
      sensitive: {
        seeFinancials: false,
        managePayments: false,
        viewReports: false,
        editRecordIds: false,
        logPastCommunications: false,
        accessCommunicationSection: false,
        assignOthers: false,
        ...overrides,
      },
      toggles: {} as RoleViewModel['toggles'],
      scope: {},
      general: { description: '' },
    };
  }

  it('ticking it emits access_inbox Communication, org-wide (conditions: null)', () => {
    const emitted = viewModelToGrants(baselineVm({ accessCommunicationSection: true }));
    expect(emitted).toContainEqual({ action: ACTION, subject: SUBJECT, conditions: null });
  });

  it('leaving it unticked emits nothing of the kind', () => {
    expect(viewModelToGrants(baselineVm()).filter((g) => g.action === ACTION)).toEqual([]);
  });

  it('assembles ON from stored rows that carry the grant', () => {
    const stored = [{ action: ACTION, subject: SUBJECT, conditions: null }];
    expect(assembleRoleViewModel('DISPATCHER', stored).sensitive.accessCommunicationSection).toBe(true);
  });

  it('assembles OFF from stored rows that do not', () => {
    const stored = [{ action: 'read', subject: SUBJECT, conditions: null }];
    expect(assembleRoleViewModel('DISPATCHER', stored).sensitive.accessCommunicationSection).toBe(false);
  });

  for (const on of [true, false]) {
    it(`survives a full save-then-reload with the switch ${on ? 'on' : 'off'}`, () => {
      const vm = baselineVm({ accessCommunicationSection: on });
      const reloaded = assembleRoleViewModel(vm.role, viewModelToGrants(vm));
      expect(reloaded.sensitive.accessCommunicationSection).toBe(on);
    });
  }

  it('emits access_inbox on Communication and on NO other subject', () => {
    const subjects = viewModelToGrants(baselineVm({ accessCommunicationSection: true }))
      .filter((g) => g.action === ACTION)
      .map((g) => g.subject);
    expect(subjects).toEqual([SUBJECT]);
  });

  it('leaves the CRUD matrix\'s read/create Communication grants exactly as the matrix set them', () => {
    const off = viewModelToGrants(baselineVm({ accessCommunicationSection: false }));
    const on = viewModelToGrants(baselineVm({ accessCommunicationSection: true }));
    const crud = (gs: ReturnType<typeof viewModelToGrants>) =>
      gs.filter((g) => g.subject === SUBJECT && g.action !== ACTION);
    expect(crud(off)).toEqual(crud(on));
  });
});

// ─── The PUT round trip — AC10's guard ─────────────────────────────────────────────────────
// Modelled on permissions-assign-others-backfill.test.ts's saveWithoutTheKey pattern: the two
// cases that stop the Roles editor from silently un-shipping a migration-written row.

describe('PUT /api/roles/:role/permissions — the section switch round-trips (#2046 AC10)', () => {
  const save = (accessCommunicationSection: boolean, stored: Array<Record<string, unknown>> = []) => {
    mockAuthAs('admin');
    (prisma.rolePermission.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(stored);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const upsert = vi.fn().mockResolvedValue({});
    (prisma.$transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation((fn: never) =>
      (fn as unknown as (tx: unknown) => unknown)({ rolePermission: { deleteMany, upsert } }),
    );
    return {
      deleteMany,
      upsert,
      res: request(app)
        .put('/api/roles/DISPATCHER/permissions')
        .set(authHeader('admin'))
        .send({
          matrix: {},
          sensitive: {
            seeFinancials: false, managePayments: false, viewReports: false,
            editRecordIds: false, logPastCommunications: false, accessCommunicationSection,
          },
          toggles: {},
          scope: {},
          general: { description: '' },
        }),
    };
  };

  it('accessCommunicationSection:true persists access_inbox:Communication with a JSON-null condition', async () => {
    const { upsert, res } = save(true);
    expect((await res).status).toBe(200);
    const calls = upsert.mock.calls.filter((c) => c[0].create.subject === SUBJECT && c[0].create.action === ACTION);
    expect(calls).toHaveLength(1);
  });

  it('an explicit false DELETES a pre-existing grant — the pair is inside MANAGED_KEYS (R4)', async () => {
    // If access_inbox:Communication were outside MANAGED_KEYS (role.controller.ts's
    // buildFullGrantSet literal missing the key), the Save would PRESERVE it instead — the switch
    // would read ON again after reload, and revoking would be impossible from the UI.
    const { deleteMany, res } = save(false, [{ action: ACTION, subject: SUBJECT, conditions: null }]);
    expect((await res).status).toBe(200);
    const deleted = deleteMany.mock.calls.flatMap((c) => c[0]?.where?.OR ?? []);
    expect(deleted).toContainEqual(expect.objectContaining({ action: ACTION, subject: SUBJECT }));
  });

  // ─── the stale-tab hole (R4 / role.controller.ts's frozenAbsent) ─────────────────────────
  // Frontend and backend deploy independently, so a Roles tab loaded BEFORE the frontend deploy
  // holds no `accessCommunicationSection` key while the migration has ALREADY written the grant
  // onto every existing org. Absence must be read as "I do not know about this switch", never as
  // "turn it off" — otherwise an admin ticking an unrelated Vendors box during that window
  // silently demotes DISPATCHER/TECHNICIAN out of the section they already had.
  const saveWithoutTheKey = (stored: Array<Record<string, unknown>> = []) => {
    mockAuthAs('admin');
    (prisma.rolePermission.findMany as unknown as ReturnType<typeof vi.fn>).mockResolvedValue(stored);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const upsert = vi.fn().mockResolvedValue({});
    (prisma.$transaction as unknown as ReturnType<typeof vi.fn>).mockImplementation((fn: never) =>
      (fn as unknown as (tx: unknown) => unknown)({ rolePermission: { deleteMany, upsert } }),
    );
    return {
      deleteMany,
      upsert,
      res: request(app)
        .put('/api/roles/DISPATCHER/permissions')
        .set(authHeader('admin'))
        .send({
          matrix: {},
          // A pre-deploy tab's body: post-SRVW-140 (carries viewReports, so the legacy freeze does
          // not fire) but with no `accessCommunicationSection` key at all.
          sensitive: { seeFinancials: false, managePayments: false, viewReports: false, editRecordIds: false, logPastCommunications: false },
          toggles: {},
          scope: {},
          general: { description: '' },
        }),
    };
  };

  it('a body that OMITS accessCommunicationSection leaves a backfilled grant alone', async () => {
    const { deleteMany, res } = saveWithoutTheKey([{ action: ACTION, subject: SUBJECT, conditions: null }]);
    expect((await res).status).toBe(200);
    const deleted = deleteMany.mock.calls.flatMap((c) => c[0]?.where?.OR ?? []);
    expect(deleted).not.toContainEqual(expect.objectContaining({ action: ACTION, subject: SUBJECT }));
  });

  it('omitting the key does not GRANT it either — the freeze only refuses deletions', async () => {
    const { upsert, res } = saveWithoutTheKey([]);
    expect((await res).status).toBe(200);
    expect(upsert.mock.calls.filter((c) => c[0].create.subject === SUBJECT && c[0].create.action === ACTION)).toEqual([]);
  });

  it('an explicit false still revokes — the freeze must not make the switch one-way', async () => {
    const { deleteMany, res } = save(false, [{ action: ACTION, subject: SUBJECT, conditions: null }]);
    expect((await res).status).toBe(200);
    const deleted = deleteMany.mock.calls.flatMap((c) => c[0]?.where?.OR ?? []);
    expect(deleted).toContainEqual(expect.objectContaining({ action: ACTION, subject: SUBJECT }));
  });
});

// ─── defineAbilityFor — real ability build, not a literal ──────────────────────────────────

describe('defineAbilityFor — real ability build', () => {
  const grantsFor = (role: string) => DEFAULT_GRANTS.filter((g) => g.role === role);

  it('ADMIN reaches it via manage-all, with no explicit row', () => {
    expect(defineAbilityFor({ id: 'u1', role: 'ADMIN' }, []).can(ACTION, SUBJECT)).toBe(true);
  });

  it('DISPATCHER and TECHNICIAN hold it from DEFAULT_GRANTS alone', () => {
    expect(defineAbilityFor({ id: 'u2', role: 'DISPATCHER' }, grantsFor('DISPATCHER')).can(ACTION, SUBJECT)).toBe(true);
    expect(defineAbilityFor({ id: 'u3', role: 'TECHNICIAN' }, grantsFor('TECHNICIAN')).can(ACTION, SUBJECT)).toBe(true);
  });

  it('SALES does not', () => {
    expect(defineAbilityFor({ id: 'u4', role: 'SALES' }, grantsFor('SALES')).can(ACTION, SUBJECT)).toBe(false);
  });

  it('SALES still holds read Communication — the record tab is unaffected', () => {
    expect(defineAbilityFor({ id: 'u5', role: 'SALES' }, grantsFor('SALES')).can('read', SUBJECT)).toBe(true);
  });
});

// ─── The migration — shape, never a role name ───────────────────────────────────────────────

describe('backfill migration — derived by shape, idempotent (#2046)', () => {
  const NAME = '20260911180000_communication_section_gate';
  const migrationRoot = join(__dirname, '../../prisma/migrations');
  const migrationDir = join(migrationRoot, NAME);
  const sql = readFileSync(join(migrationDir, 'migration.sql'), 'utf8');
  const code = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  it('exists as a migration folder, sorted after #2042\'s (20260911120000)', () => {
    const dirs = readdirSync(migrationRoot).filter((n) => statSync(join(migrationRoot, n)).isDirectory());
    expect(dirs).toContain(NAME);
    expect(NAME > '20260911120000_sales_purchasing_grants').toBe(true);
  });

  it('derives its rows from read Communication + the role\'s own read Job shape, not a role name', () => {
    expect(code).toMatch(/subject\s*=\s*'Communication'/);
    expect(code).toMatch(/action\s*=\s*'read'/);
    expect(code).toMatch(/rp\.role/);
    for (const role of ['DISPATCHER', 'TECHNICIAN', 'SALES', 'ADMIN']) {
      expect(code, `migration hardcodes ${role}`).not.toContain(`'${role}'`);
    }
  });

  // migration-review finding 2: the two checks above cannot see the OUTER `rp.action = 'read'`
  // filter being deleted, because the NOT-EXISTS subquery's `j.action = 'read'` still matches the
  // same loose regex. Pin the OUTER clause specifically (whitespace-insensitive, so reformatting
  // the SQL does not break the pin) — deleting it would grant access_inbox to every pair holding
  // ANY Communication row, including create-only ones that must stay excluded.
  it('the outer SELECT filters on read Communication specifically (not just the NOT-EXISTS subquery)', () => {
    const flat = code.replace(/\s+/g, '');
    expect(flat).toContain("FROMrole_permissionsrpWHERErp.subject='Communication'ANDrp.action='read'");
  });

  it('the exclusion predicate is an EXACT equality on OWN_JOB_VIA_ESTIMATE, never a LIKE proxy (#2042 R6)', () => {
    const normalised = code.replace(/\s+/g, '');
    expect(normalised).toContain(JSON.stringify(OWN_JOB_VIA_ESTIMATE).replace(/\s+/g, ''));
    expect(code).not.toMatch(/LIKE/i);
    expect(code).toMatch(/NOT EXISTS/i);
  });

  it('INSERT-only — no DELETE half (nothing is being revoked)', () => {
    expect(code).toMatch(/INSERT INTO role_permissions/i);
    expect(code).not.toMatch(/DELETE FROM role_permissions/i);
  });

  it('writes access_inbox on Communication with a NULL condition, id/timestamps supplied explicitly', () => {
    expect(code).toContain("'access_inbox'");
    expect(code).toContain("'Communication'");
    expect(code).toContain('gen_random_uuid()');
    expect(code).toMatch(/NOW\(\)/);
  });

  it('uses ON CONFLICT ... DO UPDATE, never DO NOTHING (an over-grant must not survive a re-run)', () => {
    expect(code).toContain('ON CONFLICT (organization_id, role, action, subject) DO UPDATE SET');
    expect(code).not.toMatch(/DO NOTHING/i);
    expect(code).toMatch(/conditions\s*=\s*NULL/);
  });

  it('never names a real org or customer, only organization_id (CLAUDE.md / R9)', () => {
    for (const banned of ['Northwind Services', 'Lakeside Cabinets', 'Brightline Services', 'Riverbend Septic', 'Summit Moving']) {
      expect(sql, `migration names a real org: ${banned}`).not.toContain(banned);
    }
  });

  it('portable: no Supabase-only objects', () => {
    expect(sql).not.toMatch(/auth\.\w+\(/);
    expect(sql).not.toMatch(/TO authenticated|TO anon|TO service_role/);
    expect(sql).not.toMatch(/CREATE POLICY/i);
  });

  it('header states the RLS hazard and the recipes/migration-check.sh evidence path', () => {
    expect(sql).toMatch(/FORCE ROW LEVEL SECURITY/);
    expect(sql).toContain('migration-check.sh');
  });

  it('header states the ratified expected counts, prod 13 / staging 22 (R9)', () => {
    expect(sql).toMatch(/prod[^\n]*13/i);
    expect(sql).toMatch(/staging[^\n]*22/i);
  });

  it('header states the #2042 interplay — order-independent, no shared target row (R8)', () => {
    expect(sql).toContain('20260911120000_sales_purchasing_grants');
  });
});
