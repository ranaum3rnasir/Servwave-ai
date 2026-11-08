/**
 * Sales-Role QA row 020 — a salesperson may first-book and crew the job their OWN lead's estimate
 * produced. Ran's ruling, 2026-09-01. Migration: 20260901120000_sales_scoped_job_assign.
 *
 * TWO THINGS ARE PINNED HERE, and the second is the one that would rot silently.
 *
 * 1. The grant itself: DEFAULT_GRANTS (which seeds NEW orgs) and the backfill (which repairs
 *    EXISTING ones) must agree, or new and existing orgs diverge — the classic permission bug that
 *    never reproduces on the developer's own org.
 *
 * 2. The CORRECTION half. Read-only pre-flight on 2026-09-01 found Northwind Services holding
 *    SALES `create`/`update`/`delete` on Job, all UNCONDITIONAL, none of them in defaultGrants.ts —
 *    one Roles-editor save on 2026-08-12. A plain ON CONFLICT DO NOTHING would have let that
 *    `update` row win the conflict and survive, so the migration would report success while leaving
 *    a production org's salespeople with org-wide job update. The drift test at the bottom is what
 *    catches the NEXT hand-edit instead of finding it by accident months later.
 *
 * Modelled on permissions-assign-others-backfill.test.ts (slice 1).
 */
import { describe, it, expect } from 'vitest';
import { readFileSync, readdirSync, statSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { isCatalogEntry } from '../lib/permissions/catalog';

const OWN_JOB_VIA_ESTIMATE = { estimate: { lead: { lead_assignees: { some: { user_id: '{{userId}}' } } } } };

const salesJob = (action: string) =>
  DEFAULT_GRANTS.filter((g) => g.role === 'SALES' && g.subject === 'Job' && g.action === action);

describe('DEFAULT_GRANTS — what SALES holds on Job', () => {
  it('holds exactly read and assign — and nothing else', () => {
    const actions = DEFAULT_GRANTS.filter((g) => g.role === 'SALES' && g.subject === 'Job')
      .map((g) => g.action)
      .sort();
    expect(actions).toEqual(['assign', 'read']);
  });

  it('scopes both to OWN_JOB_VIA_ESTIMATE — the new verb can never out-scope the read', () => {
    for (const action of ['read', 'assign']) {
      const rows = salesJob(action);
      expect(rows, `SALES ${action} Job missing`).toHaveLength(1);
      expect(rows[0].conditions, `SALES ${action} Job is not row-scoped`).toEqual(OWN_JOB_VIA_ESTIMATE);
    }
  });

  /**
   * `update Job` is the omission that matters, and it is load-bearing rather than an oversight.
   * `manage_lines Job` is pinned to mirror `update Job` role-for-role AND condition-for-condition
   * (PR 2 of the technician-ownership spec, permissions-job-manage-lines.test.ts). So granting
   * SALES `update Job` silently grants them the job's LINE ITEMS - money - and POST /:id/notes
   * rides the same gate. `assign` alone delivers the booking capability, because POST /:id/assign
   * first-books the schedule and sets the crew in one call.
   */
  it('gaining assign did NOT drag manage_lines Job along with it', () => {
    expect(DEFAULT_GRANTS.filter((g) => g.role === 'SALES' && g.subject === 'Job' && g.action === 'manage_lines')).toHaveLength(0);
  });

  /**
   * The boundary of what was decided. First-booking runs through POST /:id/assign under
   * `assign Job`; MOVING an existing booking runs through PATCH /:id's changesSchedule check and
   * the /visits routes, both gated `reschedule Job`. Granting it here would widen the ruling
   * without anyone deciding to.
   */
  it('does NOT hold reschedule, update, create or delete on Job', () => {
    for (const action of ['reschedule', 'update', 'create', 'delete']) {
      expect(salesJob(action), `SALES unexpectedly holds ${action} Job`).toHaveLength(0);
    }
  });

  /**
   * WHICH jobs vs WHOSE names. `assign Job` says which jobs a rep may crew; `assign User`
   * (slice 1) says whether they may name anybody but themselves. SALES holding the first and not
   * the second IS Ran's ruling, expressed as two composing grants. If a later change hands SALES
   * `assign User`, this row silently becomes "a rep may put any colleague on their own job".
   */
  it('does NOT hold assign:User — a rep may name only themselves', () => {
    expect(DEFAULT_GRANTS.filter((g) => g.role === 'SALES' && g.action === 'assign' && g.subject === 'User')).toHaveLength(0);
  });

  it('the new pair is a catalog entry — without this putRolePermissions drops it', () => {
    expect(isCatalogEntry('assign', 'Job')).toBe(true);
  });

  /**
   * THE SLICE-1 INTERACTION, pinned because it is the one way this row could widen by accident.
   *
   * Slice 1's backfill (20260831120000) DERIVES `assign User` from `assign Job` - at the time it
   * was written, SALES held no `assign Job`, so "excluded by construction" was true. This change
   * gives SALES `assign Job`, so that sentence stops being true and the two sets stop being equal.
   *
   * On a fresh DB the timestamps save us (20260831120000 runs before 20260901120000, while SALES
   * still has no `assign Job`). What this asserts is the thing ordering CANNOT protect: that nobody
   * later "repairs" the inequality by handing SALES `assign User`, which would turn "a rep may put
   * themselves on their own job" into "a rep may put any colleague on their own job".
   */
  it('assign:User holders are a strict SUBSET of assign:Job holders, with SALES the exception', () => {
    const holders = (action: string, subject: string) =>
      new Set(DEFAULT_GRANTS.filter((g) => g.action === action && g.subject === subject).map((g) => g.role));
    const assignUser = holders('assign', 'User');
    const assignJob = holders('assign', 'Job');
    for (const role of assignUser) {
      expect(assignJob.has(role), `${role} holds assign:User without assign:Job`).toBe(true);
    }
    expect(assignJob.has('SALES')).toBe(true);
    expect(assignUser.has('SALES'), 'SALES gained assign:User - a rep may now name colleagues').toBe(false);
  });
});

describe('backfill migration — every existing org AND every custom role, idempotent', () => {
  const NAME = '20260901120000_sales_scoped_job_assign';
  const sql = readFileSync(join(__dirname, '../../prisma/migrations', NAME, 'migration.sql'), 'utf8');
  const code = sql
    .split('\n')
    .filter((l) => !l.trim().startsWith('--'))
    .join('\n');

  it('exists as a migration folder', () => {
    // Presence only — `prisma migrate deploy` applies any folder absent from `_prisma_migrations`
    // regardless of where its timestamp sorts, so asserting on ordering is a time bomb.
    const root = join(__dirname, '../../prisma/migrations');
    expect(readdirSync(root).filter((n) => statSync(join(root, n)).isDirectory())).toContain(NAME);
  });

  it('uses the idempotent ON CONFLICT DO NOTHING guard', () => {
    expect(code).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING');
  });

  /**
   * The gate is a SHAPE, not a role name. SRVW-138/139 custom roles write their `key` into
   * role_permissions.role, so a role cloned from SALES is invisible to a hardcoded 'SALES'.
   */
  it('derives its rows from the OWN_JOB_VIA_ESTIMATE read row, not a role name', () => {
    expect(code).toContain(JSON.stringify(OWN_JOB_VIA_ESTIMATE).replace(/,/g, ', ').replace(/:/g, ': '));
    expect(code).toMatch(/rp\.role/);
    for (const role of ['DISPATCHER', 'TECHNICIAN', 'SALES', 'ADMIN']) {
      expect(code, `migration hardcodes ${role}`).not.toContain(`'${role}'`);
    }
  });

  it('copies the read row\'s own condition rather than writing NULL', () => {
    // A NULL here would hand SALES every job in the org — the exact over-grant part 2 removes.
    expect(code).not.toMatch(/NULL::jsonb/i);
    expect(code).toMatch(/rp\.conditions/);
  });

  it('removes the create/update/delete over-grant from the same derived set', () => {
    expect(code).toMatch(/DELETE FROM role_permissions/i);
    expect(code).toMatch(/IN \('create', 'update', 'delete'\)/i);
  });

  /**
   * Pins the SQL to the code. The migration grants exactly the non-read verbs DEFAULT_GRANTS gives
   * SALES on Job; if a later change adds one to the defaults without adding it here, new and
   * existing orgs diverge - the classic permission bug that never reproduces on your own org.
   */
  it('grants exactly the verbs DEFAULT_GRANTS gives SALES on Job', () => {
    const fromDefaults = DEFAULT_GRANTS
      .filter((g) => g.role === 'SALES' && g.subject === 'Job' && g.action !== 'read')
      .map((g) => g.action)
      .sort();
    const inserted = [...code.matchAll(/INSERT INTO role_permissions[\s\S]*?SELECT[\s\S]*?\n  '([a-z_]+)',/g)]
      .map((m) => m[1])
      .sort();
    expect(inserted).toEqual(fromDefaults);
  });
});

/**
 * DRIFT GUARD. Ran's call, 2026-09-01, after the Northwind Services over-grant was found by accident
 * during an unrelated pre-flight. Any Job verb SALES ends up holding must be declared in
 * DEFAULT_GRANTS and must be row-scoped; a hand-edit in the Roles editor that adds an
 * unconditional one is a red test rather than a discovery six months later.
 *
 * This asserts the CODE's intent. It cannot see a production row — that is what the migration's
 * part 2 and the post-deploy per-org count are for.
 */
describe('drift guard — SALES may hold no unscoped Job grant', () => {
  it('the migration revokes every Job verb the defaults do NOT grant SALES', () => {
    const NAME = '20260901120000_sales_scoped_job_assign';
    const sql = readFileSync(join(__dirname, '../../prisma/migrations', NAME, 'migration.sql'), 'utf8');
    const revoked = new Set((sql.match(/IN \((?:'[a-z]+',? ?)+\)/) ?? [''])[0].match(/'([a-z]+)'/g)?.map((s) => s.replace(/'/g, '')) ?? []);
    const granted = new Set(DEFAULT_GRANTS.filter((g) => g.role === 'SALES' && g.subject === 'Job').map((g) => g.action));
    // Anything Northwind Services was found holding must be either granted by the defaults or revoked here.
    for (const found of ['create', 'update', 'delete']) {
      expect(granted.has(found) || revoked.has(found), `${found} Job is neither granted nor revoked`).toBe(true);
    }
  });

  it('every SALES Job grant in the defaults carries a condition', () => {
    const unscoped = DEFAULT_GRANTS
      .filter((g) => g.role === 'SALES' && g.subject === 'Job')
      .filter((g) => !g.conditions);
    expect(unscoped, 'a SALES Job grant lost its row scope').toEqual([]);
  });

  it('no SALES grant anywhere is an unconditional write on a row-scoped subject', () => {
    const ROW_SCOPED = ['Job', 'Lead', 'Estimate', 'Invoice'];
    const WRITES = ['create', 'update', 'delete', 'assign'];
    const offenders = DEFAULT_GRANTS.filter(
      (g) => g.role === 'SALES' && ROW_SCOPED.includes(g.subject) && WRITES.includes(g.action) && !g.conditions,
    );
    // Documented exceptions: SALES creates leads and estimates unscoped (there is no row to scope
    // a creation against), and holds estimate-lifecycle verbs unscoped by an earlier ruling.
    const allowed = new Set(['create:Lead', 'create:Estimate', 'update:Estimate', 'delete:Estimate']);
    expect(offenders.map((g) => `${g.action}:${g.subject}`).filter((k) => !allowed.has(k))).toEqual([]);
  });
});
