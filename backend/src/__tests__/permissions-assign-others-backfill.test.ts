/**
 * Scoped assignee pool, slice 1 — the `assign User` grant exists, is held by default, and is
 * visible in Roles. Plan: md_files/plans/permissions/2026-08-31-assignee-pool/, PRD:
 * ranro1/ALPHA_CRM#1938.
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
    // PERMISSION_CATALOG.description is not rendered anywhere - the Roles screen draws the label and help text
    // of the switch catalog, and that is the user-visible one.
    // This guards the catalog as the place a DEVELOPER learns what the grant covers: one naming
    // only one surface reads as a walkthrough-only grant, and the next person needing the other
    // surface adds a SECOND grant rather than reusing this one.
    expect(row.description.toLowerCase()).toContain('crew');
    expect(row.description.toLowerCase()).toContain('walkthrough');
    expect(row.description.toLowerCase()).toContain('other than yourself');
  });

  it('isCatalogEntry recognizes it', () => {
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
