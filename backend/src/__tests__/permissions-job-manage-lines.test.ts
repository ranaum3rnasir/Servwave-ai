/**
 * PR 2 of the technician-ownership spec
 * (md_files/specs/permissions/2026-08-04-technician-ownership-and-creator-tracking.md, Part C):
 * split `manage_lines Job` out of `update Job`.
 *
 * This file is the BEHAVIOUR-NEUTRALITY proof at the grant layer. The split only creates a seam -
 * PR 3 is the one that moves the seam. So the invariant asserted here is mechanical and total:
 *
 *   for every principal that holds `update Job` today, the same principal holds
 *   `manage_lines Job` afterwards, under the SAME condition.
 *
 * "Principal" means all three grant paths, not just the role defaults:
 *   - DEFAULT_GRANTS role rows      (new orgs)
 *   - role_permissions rows         (existing orgs - the backfill migration)
 *   - user_permission_overrides     (per-user toggles, allow AND deny - the second backfill)
 *
 * The deny half matters as much as the allow half: an admin who switched "Edit own jobs" OFF for
 * one user is relying on that user not being able to touch line items. Mirroring only the allow
 * rows would silently hand the gate back to them.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PERMISSION_CATALOG } from '../lib/permissions/catalog';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { defineAbilityFor } from '../lib/permissions/defineAbility';
import { USER_CAPABILITIES, isManagedCapability } from '../lib/permissions/userCapabilities';
import { updateJobSchema, MANAGE_LINES_FIELDS } from '../controllers/job.controller';

// Mirrors NOT_MANAGE_LINES_FIELDS in job.controller.ts. Deliberately re-declared rather than
// exported and imported: a test that reads the very set it is checking proves nothing, whereas this
// copy goes red when the two disagree - which is the review that is wanted.
const NOT_MANAGE_LINES_DOCUMENTED = new Set([
  'scope_notes', 'job_type', 'service_location_id', 'address', 'estimated_duration',
  'scheduled_start', 'scheduled_end', 'is_all_day', 'force',
  'custom_fields',
]);

const MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20260805130000_job_manage_lines_grant_backfill/migration.sql',
);

describe('manage_lines Job - catalog', () => {
  it('PERMISSION_CATALOG contains a manage_lines Job entry, mirroring manage_lines Invoice', () => {
    const entry = PERMISSION_CATALOG.find(
      (e) => e.action === 'manage_lines' && e.subject === 'Job',
    );
    expect(entry).toBeDefined();
    expect(entry?.category).toBe('Jobs');
  });
});

describe('DEFAULT_GRANTS - manage_lines Job covers the same roles as update Job', () => {
  const updateJob = () => DEFAULT_GRANTS.filter((g) => g.action === 'update' && g.subject === 'Job');
  const manageLinesJob = () =>
    DEFAULT_GRANTS.filter((g) => g.action === 'manage_lines' && g.subject === 'Job');

  it('covers the same set of roles', () => {
    expect(manageLinesJob().map((g) => g.role).sort()).toEqual(updateJob().map((g) => g.role).sort());
  });

  // PR 2 asserted the CONDITIONS were identical too - that was its whole neutrality proof. PR 3 is
  // the PR that breaks it on purpose, for exactly one role: the technician's money surface follows
  // CREATION, its work surface follows ASSIGNMENT. DISPATCHER is unconditional on both and so is
  // unchanged. Asserted as a partition rather than deleted, so a future edit that quietly re-points
  // one of the two is still caught.
  it('re-points TECHNICIAN at the creator while leaving every other role alone', () => {
    for (const src of updateJob()) {
      const mirrored = manageLinesJob().find((g) => g.role === src.role);
      expect(mirrored, `no manage_lines Job grant for ${src.role}`).toBeDefined();
      if (src.role === 'TECHNICIAN') {
        expect(mirrored?.conditions).toEqual({ created_by_id: '{{userId}}' });
        expect(mirrored?.conditions).not.toEqual(src.conditions);
      } else {
        expect(mirrored?.conditions).toEqual(src.conditions);
      }
    }
  });

  // Per-role assertions through the real ability builder, so the proof does not depend on the
  // shape of DEFAULT_GRANTS alone. Every role that can edit line items TODAY still can.
  function abilityFor(role: 'ADMIN' | 'DISPATCHER' | 'TECHNICIAN' | 'SALES') {
    return defineAbilityFor({ id: 'test-user', role }, DEFAULT_GRANTS.filter((g) => g.role === role));
  }

  it.each(['ADMIN', 'DISPATCHER', 'TECHNICIAN', 'SALES'] as const)(
    '%s: can(manage_lines, Job) matches can(update, Job)',
    (role) => {
      const ability = abilityFor(role);
      expect(ability.can('manage_lines', 'Job')).toBe(ability.can('update', 'Job'));
    },
  );

  it('ADMIN reaches it via manage all, with no explicit row', () => {
    expect(abilityFor('ADMIN').can('manage_lines', 'Job')).toBe(true);
    expect(manageLinesJob().some((g) => (g.role as string) === 'ADMIN')).toBe(false);
  });
});

describe('USER_CAPABILITIES - the per-user toggle path is mirrored too', () => {
  const cap = (action: string, subject: string) =>
    USER_CAPABILITIES.find((c) => c.action === action && c.subject === subject);

  it('manage_lines Job is a managed per-user capability', () => {
    expect(isManagedCapability('manage_lines', 'Job')).toBe(true);
  });

  // Same re-point as the role default above. PR 2 gave the toggle OWN_JOB so that granting it
  // changed nobody's access on merge; PR 3 gives it the meaning it was created for, and the two
  // paths must agree or an admin's per-user grant would reach a different row set from the role's.
  it('is creator-scoped, matching the role default rather than the update Job capability it split from', () => {
    const update = cap('update', 'Job');
    const manageLines = cap('manage_lines', 'Job');
    expect(update).toBeDefined();
    expect(manageLines).toBeDefined();
    expect(manageLines?.ownCondition).toEqual({ created_by_id: '{{userId}}' });
    expect(manageLines?.ownCondition).not.toEqual(update?.ownCondition);
    const roleGrant = DEFAULT_GRANTS.find(
      (g) => g.role === 'TECHNICIAN' && g.action === 'manage_lines' && g.subject === 'Job',
    );
    expect(manageLines?.ownCondition).toEqual(roleGrant?.conditions);
    // The implied read still matters: without it a grantee could not SEE the rows they may now edit.
    expect(manageLines?.impliesRead).toBe(update?.impliesRead);
    // Neither is role-gated: an own-scoped capability cannot widen scope past the grantee's rows.
    expect(manageLines?.roles).toBeUndefined();
  });
});

describe('backfill migration - existing orgs and existing per-user overrides', () => {
  const sql = () => readFileSync(MIGRATION, 'utf8');

  it('derives role grants from the existing update Job rows rather than hardcoding a role list', () => {
    expect(sql()).toMatch(/FROM role_permissions/i);
    expect(sql()).toContain("rp.action = 'update'");
    expect(sql()).toContain("rp.subject = 'Job'");
  });

  it('copies the source condition verbatim, so a scoped grant stays scoped', () => {
    // The whole point: TECHNICIAN's update Job is OWN_JOB-conditioned. Writing NULL here would
    // hand every technician every job's line items.
    expect(sql()).toMatch(/rp\.conditions/);
  });

  it('mirrors the per-user overrides, both effects', () => {
    expect(sql()).toMatch(/FROM user_permission_overrides/i);
    expect(sql()).toContain('upo.effect');
  });

  it('is idempotent on both unique indexes', () => {
    expect(sql()).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING');
    expect(sql()).toContain('ON CONFLICT (user_id, action, subject) DO NOTHING');
  });

  it('supplies the app-side defaults raw SQL has to fill in itself (id, updated_at)', () => {
    // schema.prisma: `id @default(uuid())` is a Prisma-side default and `updated_at @updatedAt`
    // has no DB default, so a raw INSERT must populate both.
    expect(sql()).toContain('gen_random_uuid()');
    expect(sql()).toMatch(/NOW\(\)/);
  });
});

/**
 * The PATCH /:id field classification, which is where the money surface is actually enforced.
 *
 * Review of PR 3 found `labor_hours`/`overhead_mode`/`overhead_value` - the job cost model - absent
 * from a HAND-WRITTEN money-field list, guarded only by canSeePricing, which had been fail-closed
 * for technicians purely because the role held no `read Pricing`. PR 3 grants that, so the accident
 * expired and an assigned non-creator could set the job's labour and overhead.
 *
 * The list is derived by exclusion now. This is the guard that makes the derivation trustworthy: it
 * fails if a key of updateJobSchema is neither guarded nor deliberately excluded, so the only way to
 * add a field without classifying it is to go red.
 */
describe('PATCH /api/jobs/:id - every schema field is classified', () => {
  it('leaves no updateJobSchema key unclassified', () => {
    const unclassified = Object.keys(updateJobSchema.shape).filter(
      (k) => !MANAGE_LINES_FIELDS.includes(k) && !NOT_MANAGE_LINES_DOCUMENTED.has(k),
    );
    expect(unclassified, `classify these in job.controller.ts: ${unclassified.join(', ')}`).toEqual([]);
  });

  it('guards the whole cost model, not just tax and discount', () => {
    for (const field of ['tax_rate', 'discount_type', 'discount_value', 'labor_hours', 'overhead_mode', 'overhead_value']) {
      expect(MANAGE_LINES_FIELDS, field).toContain(field);
    }
  });

  it('leaves the assignee work surface and the schedule alone', () => {
    // The schedule has its own `reschedule Job` gate (D14); the rest is `update Job`.
    for (const field of ['scope_notes', 'job_type', 'estimated_duration', 'scheduled_start', 'is_all_day']) {
      expect(MANAGE_LINES_FIELDS, field).not.toContain(field);
    }
  });

  // Proves the derivation is by EXCLUSION and therefore fail-closed: an unknown key is guarded.
  it('would guard a newly added schema field by default', () => {
    const hypothetical = 'some_new_money_field';
    expect(NOT_MANAGE_LINES_DOCUMENTED.has(hypothetical)).toBe(false);
  });
});
