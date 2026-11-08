/**
 * Scoped assignee pool, slice 1 — the `assign User` grant exists, is held by default, and is
 * visible in Roles. Plan: md_files/plans/permissions/2026-08-31-assignee-pool/, PRD:
 * upstream #1938.
 *
 * WHAT THIS SLICE SHIPS AND WHY IT IS ALONE. Permission plumbing AHEAD of the capability that
 * reads it: nothing calls `can('assign','User')` yet (slice 2 adds the crew/performer
 * validators). Precedent: 20260824180000_calendar_entry_dispatcher_grants_backfill and
 * 20260819230000_editable_record_ids_dispatcher_backfill both shipped their subject first.
 *
 * The reason it matters MORE here is the direction of the failure. Those two granted something
 * nobody had, so a missed org meant "capability absent until someone notices". This one describes
 * something DISPATCHER and TECHNICIAN can already do, and slice 2 makes the grant the thing that
 * permits it — so an org, or a role, the backfill misses is SILENTLY DEMOTED the day slice 2
 * lands, and the symptom is indistinguishable from the bug this plan sets out to fix.
 *
 * Modelled on permissions-calendar-entry-backfill.test.ts: pin the migration to DEFAULT_GRANTS
 * (the canonical grant set is the code), then drive the REAL production functions
 * (isCatalogEntry / viewModelToGrants / putRolePermissions / defineAbilityFor) rather than
 * asserting on a literal — see "THE GATE" in catalog.ts for why an isCatalogEntry-only assertion
 * is a placebo.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import { Prisma } from '@prisma/client';
import app from '../app';
import { prisma } from '../lib/prisma';
import { PERMISSION_CATALOG, isCatalogEntry } from '../lib/permissions/catalog';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { SENSITIVE, assembleRoleViewModel, viewModelToGrants } from '../lib/permissions/roleViewModel';
import { defineAbilityFor } from '../lib/permissions/defineAbility';
import { isManagedCapability, getManagedCapability } from '../lib/permissions/userCapabilities';
import { mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const PAIR = { action: 'assign', subject: 'User' } as const;

/**
 * Roles that may crew a job but may name ONLY THEMSELVES on it, so holding `assign Job` without
 * `assign User` is their intended shape rather than a demotion.
 *
 * SALES was added by Sales-Role QA row 020 (Ran's ruling, 2026-09-01): a rep first-books and crews
 * the job their own lead's estimate produced, but "they may not pull in anyone who is not already
 * on that lead". When slice 1 was written SALES held no `assign Job` at all and the comment in its
 * migration said SALES was "excluded by construction" - row 020 is what ended that, so the
 * exclusion is now stated here instead of being an accident of the grant table.
 */
const SELF_ONLY_CREW = new Set<string>(['SALES']);

describe('PERMISSION_CATALOG — the assign:User entry', () => {
  it('holds exactly one assign:User row, filed under Users', () => {
    const rows = PERMISSION_CATALOG.filter((e) => e.action === 'assign' && e.subject === 'User');
    expect(rows).toHaveLength(1);
    expect(rows[0].category).toBe('Users');
  });

  it('describes ONE capability spanning BOTH job crew and walkthrough performers', () => {
    const row = PERMISSION_CATALOG.find((e) => e.action === 'assign' && e.subject === 'User')!;
    // PERMISSION_CATALOG.description is not rendered anywhere - the Roles screen's own label is
    // asserted in settings-roles-v2-assign-others.test.tsx, and that is the user-visible one.
    // This guards the catalog as the place a DEVELOPER learns what the grant covers: one naming
    // only one surface reads as a walkthrough-only grant, and the next person needing the other
    // surface adds a SECOND grant rather than reusing this one.
    expect(row.description.toLowerCase()).toContain('crew');
    expect(row.description.toLowerCase()).toContain('walkthrough');
    expect(row.description.toLowerCase()).toContain('other than yourself');
  });

  it('isCatalogEntry recognizes it — without this putRolePermissions silently drops the grant', () => {
    expect(isCatalogEntry('assign', 'User')).toBe(true);
  });
});

describe('DEFAULT_GRANTS — who holds assign:User out of the box', () => {
  const rows = () => DEFAULT_GRANTS.filter((g) => g.action === 'assign' && g.subject === 'User');

  it('is held by exactly DISPATCHER and TECHNICIAN, both unconditional', () => {
    expect(rows()).toEqual([
      { role: 'DISPATCHER', action: 'assign', subject: 'User' },
      { role: 'TECHNICIAN', action: 'assign', subject: 'User' },
    ]);
  });

  it('SALES deliberately does NOT hold it — a rep is the performer on their own lead', () => {
    expect(rows().filter((g) => g.role === 'SALES')).toEqual([]);
  });

  it('ADMIN has no row and needs none (manage-all); DEFAULT_GRANTS cannot even express one', () => {
    expect(rows().filter((g) => (g as { role: string }).role === 'ADMIN')).toEqual([]);
  });

  /**
   * THE LOAD-BEARING ASSERTION IN THIS FILE, and the one that catches the failure the slice was
   * marked HITL for.
   *
   * `assign Job` is what lets a role put people on a job's crew today — DISPATCHER holds it
   * org-wide, TECHNICIAN holds it CREATED_BY_ME-scoped (technician-ownership spec, Part C: "they
   * can take people off the job"). From slice 2 onward, doing that ALSO requires `assign User`.
   *
   * So any role that holds the first and not the second is a role whose working capability this
   * plan quietly removes. Stated as an invariant rather than a role list, this stays true when
   * somebody adds a fifth role — which is exactly when a hand-written list stops being checked.
   */
  it('every role that can crew a job today also holds assign:User (no silent demotion)', () => {
    const canCrewAJob = new Set(
      DEFAULT_GRANTS.filter((g) => g.action === 'assign' && g.subject === 'Job').map((g) => g.role),
    );
    const canNameOthers = new Set(rows().map((g) => g.role));
    expect(canCrewAJob.size).toBeGreaterThan(0); // guard: not vacuous
    for (const role of canCrewAJob) {
      if (SELF_ONLY_CREW.has(role)) continue;
      expect(canNameOthers, `${role} can crew a job but would lose it at slice 2`).toContain(role);
    }
  });

  /**
   * The exception, asserted rather than merely skipped — otherwise SELF_ONLY_CREW is a hole anyone
   * could widen by adding a name to it. A self-only role must hold `assign Job` (or the exemption
   * is describing nothing) and must NOT hold `assign User` (or it is not self-only).
   */
  it('a self-only role holds assign:Job WITHOUT assign:User — that is the whole point', () => {
    const assignJob = new Set(DEFAULT_GRANTS.filter((g) => g.action === 'assign' && g.subject === 'Job').map((g) => g.role));
    const canNameOthers = new Set(rows().map((g) => g.role));
    for (const role of SELF_ONLY_CREW) {
      expect(assignJob, `${role} is exempted but cannot crew at all`).toContain(role);
      expect(canNameOthers, `${role} is exempted yet may name others`).not.toContain(role);
    }
  });

  it('assign:User is unconditional for every holder — User is not a ScopeResource', () => {
    // A condition here would be inert AND misleading: scopeWhereFor.ts's ScopeResource union is
    // Lead | Job | Estimate | Invoice | LogisticOrder. WHICH work a holder may re-crew is still
    // answered by that work's own grant (`assign Job` carries TECHNICIAN's CREATED_BY_ME scope).
    for (const g of rows()) expect((g as { conditions?: unknown }).conditions).toBeUndefined();
  });
});

describe('backfill migration — every existing org AND every custom role, idempotent', () => {
  const DIR = join(__dirname, '../../prisma/migrations/20260831120000_assign_others_grant_backfill');
  const sql = readFileSync(join(DIR, 'migration.sql'), 'utf8');

  it('writes assign:User into role_permissions', () => {
    expect(sql).toMatch(/INSERT INTO role_permissions/i);
    expect(sql).toContain("'assign'");
    expect(sql).toContain("'User'");
  });

  it('uses the idempotent ON CONFLICT DO NOTHING guard', () => {
    expect(sql).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING');
  });

  /**
   * The gate is a GRANT, not a role name — and that is not stylistic.
   *
   * SRVW-138/139 custom roles write their `key` into role_permissions.role
   * (20260806120000_custom_roles), and a custom role cloned from DISPATCHER holds a full copy of
   * its grants under that key. A hardcoded `role IN ('DISPATCHER','TECHNICIAN')` would miss every
   * one of them, and their holders would lose crew assignment at slice 2 with nothing in the diff
   * to show for it. Deriving from `assign Job` covers them without enumerating anything.
   */
  it('derives its rows from `assign Job` rather than hardcoding role names', () => {
    expect(sql).toMatch(/rp\.action\s*=\s*'assign'/i);
    expect(sql).toMatch(/rp\.subject\s*=\s*'Job'/i);
    expect(sql).toMatch(/rp\.role/); // the role comes FROM the matched row
    // No literal system-role name may appear in an executable line: that is the custom-role hole.
    const code = sql
      .split('\n')
      .filter((l) => !l.trim().startsWith('--'))
      .join('\n');
    for (const role of ['DISPATCHER', 'TECHNICIAN', 'SALES', 'ADMIN']) {
      expect(code, `migration hardcodes ${role}`).not.toContain(`'${role}'`);
    }
  });

  it('writes the grant unconditionally (NULL conditions), not a copy of assign:Job\'s scope', () => {
    expect(sql).toMatch(/NULL::jsonb/i);
  });

  /**
   * Pins the SQL to the code. The migration grants exactly the roles that hold `assign Job`;
   * DEFAULT_GRANTS (which seeds NEW orgs) must agree, or new and existing orgs diverge — the
   * classic shape of a permission bug that never reproduces on the developer's own org.
   */
  it('agrees with DEFAULT_GRANTS about who ends up holding it', () => {
    const fromDefaults = DEFAULT_GRANTS.filter((g) => g.action === 'assign' && g.subject === 'User')
      .map((g) => g.role)
      .sort();
    // Was a plain equality until Sales-Role QA row 020 (2026-09-01) gave SALES `assign Job`. The
    // migration below still derives its rows from `assign Job`, so on a FRESH database it would
    // now also match SALES - and the timestamps are what stop it: 20260831120000 replays while
    // SALES still holds no `assign Job`, and 20260901120000 adds that verb afterwards. The
    // subtraction here states that dependency instead of letting the equality quietly rot.
    const wouldMatch = DEFAULT_GRANTS.filter((g) => g.action === 'assign' && g.subject === 'Job')
      .map((g) => g.role)
      .filter((role) => !SELF_ONLY_CREW.has(role))
      .sort();
    expect(fromDefaults).toEqual(wouldMatch);
  });

  it('exists as a migration folder', () => {
    // Presence only, deliberately. An earlier draft asserted this sorted LAST in the tree, which
    // is both wrong and a time bomb: `prisma migrate deploy` applies any folder absent from
    // `_prisma_migrations` regardless of where its timestamp sorts, and the assertion would have
    // turned a PERMISSIONS suite red on the next unrelated PR that added a migration.
    const root = join(__dirname, '../../prisma/migrations');
    const names = readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory());
    expect(names).toContain('20260831120000_assign_others_grant_backfill');
  });
});

describe('roleViewModel — the Roles screen switch', () => {
  it('SENSITIVE.assignOthers writes assign:User and nothing else', () => {
    expect(SENSITIVE.assignOthers).toEqual([{ action: 'assign', subject: 'User' }]);
  });

  it('assembles TRUE from a stored grant and FALSE from its absence', () => {
    expect(assembleRoleViewModel('DISPATCHER', [{ ...PAIR, conditions: null }]).sensitive.assignOthers).toBe(true);
    expect(assembleRoleViewModel('SALES', []).sensitive.assignOthers).toBe(false);
  });

  it('emits exactly one unconditional grant when on, and none when off', () => {
    const vm = (assignOthers: boolean) => ({
      role: 'DISPATCHER',
      matrix: {},
      sensitive: { seeFinancials: false, managePayments: false, viewReports: false, editRecordIds: false, assignOthers },
      toggles: {} as never,
      scope: {},
      general: { description: '' },
    });
    const on = viewModelToGrants(vm(true) as never).filter((g) => g.subject === 'User');
    expect(on).toEqual([{ action: 'assign', subject: 'User', conditions: null }]);
    expect(viewModelToGrants(vm(false) as never).filter((g) => g.action === 'assign')).toEqual([]);
  });
});

describe('PUT /api/roles/:role/permissions — the switch round-trips through the REAL gate', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
  });

  const save = (assignOthers: boolean, stored: Array<Record<string, unknown>> = []) => {
    mockAuthAs('admin');
    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(stored);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const upsert = vi.fn().mockResolvedValue({});
    (prisma.$transaction as never as ReturnType<typeof vi.fn>).mockImplementation((fn: never) =>
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
          sensitive: { seeFinancials: false, managePayments: false, viewReports: false, editRecordIds: false, assignOthers },
          toggles: {},
          scope: {},
          general: { description: '' },
        }),
    };
  };

  it('assignOthers:true persists assign:User with a JSON-null condition', async () => {
    const { upsert, res } = save(true);
    expect((await res).status).toBe(200);
    const calls = upsert.mock.calls.filter((c) => c[0].create.subject === 'User' && c[0].create.action === 'assign');
    expect(calls).toHaveLength(1);
    // role.controller writes an absent condition as Prisma.JsonNull (the JSON-column sentinel),
    // never a bare JS null.
    expect(calls[0][0].create.conditions).toEqual(Prisma.JsonNull);
  });

  it('assignOthers:false persists no assign:User grant', async () => {
    const { upsert, res } = save(false);
    expect((await res).status).toBe(200);
    expect(upsert.mock.calls.filter((c) => c[0].create.subject === 'User')).toEqual([]);
  });

  it('turning it off DELETES a pre-existing grant — the pair is inside MANAGED_KEYS', async () => {
    // If assign:User were outside MANAGED_KEYS the Save would PRESERVE it, the switch would read
    // ON again after a reload, and revoking would be impossible from the UI.
    const { deleteMany, res } = save(false, [{ action: 'assign', subject: 'User', conditions: null }]);
    expect((await res).status).toBe(200);
    const deleted = deleteMany.mock.calls.flatMap((c) => c[0]?.where?.OR ?? []);
    expect(deleted).toContainEqual(expect.objectContaining({ action: 'assign', subject: 'User' }));
  });

  // ─── the stale-tab hole, and the reason this slice is HITL ────────────────────────────────
  // Frontend (Vercel) and backend (Render) deploy independently, so between them there is a real
  // window in which an admin's open Roles tab has no `assignOthers` key while the migration has
  // ALREADY written the grant. Absence is otherwise read as OFF, and MANAGED_KEYS then deletes
  // the only copy of a row nothing re-creates. That is the silent demotion the whole slice exists
  // to prevent, arriving through the editor instead of through the backfill.
  const saveWithoutTheKey = (stored: Array<Record<string, unknown>> = []) => {
    mockAuthAs('admin');
    (prisma.rolePermission.findMany as never as ReturnType<typeof vi.fn>).mockResolvedValue(stored);
    const deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const upsert = vi.fn().mockResolvedValue({});
    (prisma.$transaction as never as ReturnType<typeof vi.fn>).mockImplementation((fn: never) =>
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
          // A PRE-DEPLOY tab's body: post-SRVW-140 (it carries viewReports, so the legacy freeze
          // does NOT fire) but with no `assignOthers` key at all.
          sensitive: { seeFinancials: false, managePayments: false, viewReports: false, editRecordIds: false },
          toggles: {},
          scope: {},
          general: { description: '' },
        }),
    };
  };

  it('a body that OMITS assignOthers leaves a backfilled grant alone', async () => {
    const { deleteMany, res } = saveWithoutTheKey([{ action: 'assign', subject: 'User', conditions: null }]);
    expect((await res).status).toBe(200);
    const deleted = deleteMany.mock.calls.flatMap((c) => c[0]?.where?.OR ?? []);
    expect(deleted).not.toContainEqual(expect.objectContaining({ action: 'assign', subject: 'User' }));
  });

  it('omitting the key does not GRANT it either — the freeze only refuses deletions', async () => {
    const { upsert, res } = saveWithoutTheKey([]);
    expect((await res).status).toBe(200);
    expect(upsert.mock.calls.filter((c) => c[0].create.subject === 'User' && c[0].create.action === 'assign')).toEqual([]);
  });

  it('an explicit false still revokes — the freeze must not make the switch one-way', async () => {
    const { deleteMany, res } = save(false, [{ action: 'assign', subject: 'User', conditions: null }]);
    expect((await res).status).toBe(200);
    const deleted = deleteMany.mock.calls.flatMap((c) => c[0]?.where?.OR ?? []);
    expect(deleted).toContainEqual(expect.objectContaining({ action: 'assign', subject: 'User' }));
  });
});

describe('defineAbilityFor — real ability build, not a literal', () => {
  const grantsFor = (role: string) =>
    DEFAULT_GRANTS.filter((g) => g.role === role && g.action === 'assign' && g.subject === 'User');

  it('ADMIN reaches it via manage-all, with no explicit row', () => {
    expect(defineAbilityFor({ id: 'u1', role: 'ADMIN' }, []).can('assign', 'User')).toBe(true);
  });

  it('DISPATCHER and TECHNICIAN hold it from DEFAULT_GRANTS alone', () => {
    expect(defineAbilityFor({ id: 'u2', role: 'DISPATCHER' }, grantsFor('DISPATCHER')).can('assign', 'User')).toBe(true);
    expect(defineAbilityFor({ id: 'u3', role: 'TECHNICIAN' }, grantsFor('TECHNICIAN')).can('assign', 'User')).toBe(true);
  });

  it('SALES does not', () => {
    expect(defineAbilityFor({ id: 'u4', role: 'SALES' }, grantsFor('SALES')).can('assign', 'User')).toBe(false);
  });

  it('a per-user ALLOW override grants it to one salesperson, unconditionally', () => {
    const ability = defineAbilityFor({ id: 'u5', role: 'SALES' }, [], [{ ...PAIR, effect: 'allow' }]);
    expect(ability.can('assign', 'User')).toBe(true);
    // No ownCondition on the capability -> the emitted rule must be UNCONDITIONAL. Asserted on the
    // real rule rather than assumed: an own-scoped rule here would silently never match.
    expect(ability.rules.find((r) => r.action === 'assign' && r.subject === 'User')?.conditions).toBeUndefined();
  });

  it('a per-user DENY override takes it away from one dispatcher', () => {
    const ability = defineAbilityFor(
      { id: 'u6', role: 'DISPATCHER' },
      grantsFor('DISPATCHER'),
      [{ ...PAIR, effect: 'deny' }],
    );
    expect(ability.can('assign', 'User')).toBe(false);
  });
});

describe('userCapabilities — the per-user override is managed', () => {
  it('assign:User is a managed capability (the PUT endpoint 400s on an unmanaged pair)', () => {
    expect(isManagedCapability('assign', 'User')).toBe(true);
  });

  it('carries no ownCondition and no impliesRead', () => {
    const cap = getManagedCapability('assign', 'User')!;
    expect(cap.ownCondition).toBeUndefined();
    // The paired read would be `read User` — the org directory. That is a separate decision, made
    // per role, and not one to make as a side effect of this switch.
    expect(cap.impliesRead).toBeUndefined();
  });
});
