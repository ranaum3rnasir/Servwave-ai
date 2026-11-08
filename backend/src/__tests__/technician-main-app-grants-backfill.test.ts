/**
 * Spec A (retire the technician view) — main-app grants backfill migration.
 *
 * Pins the backfill migration to defaultGrants.ts, mirroring
 * permissions-technician-pricebook-backfill.test.ts: the canonical grant set is the code, the
 * SQL must mirror it row-for-row so existing orgs' technicians receive the same grants a
 * freshly-created org gets automatically.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

describe('technician main-app grants backfill migration', () => {
  const MIGRATION = join(
    __dirname,
    '../../prisma/migrations/20260721000000_technician_main_app_grants/migration.sql',
  );
  const sql = readFileSync(MIGRATION, 'utf8');

  it('inserts across every org (FROM organizations + CROSS JOIN VALUES)', () => {
    expect(sql).toMatch(/FROM organizations/i);
    expect(sql).toMatch(/CROSS JOIN \(VALUES/i);
  });

  it('uses the idempotent ON CONFLICT DO NOTHING guard', () => {
    expect(sql).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING');
  });

  it('carries the historical own-job shape, which S8 repoints rather than rewrites', () => {
    const OWN_JOB_JSON = '{"assignees":{"some":{"user_id":"{{userId}}"}}}';
    // The MIGRATION still carries all four rows and always will - it is history, and the orgs it
    // backfilled keep `complete Job`. But multi-visit S4 (D15) stopped SEEDING complete Job for new
    // orgs, so only the surviving three are still mirrored in DEFAULT_GRANTS.
    for (const action of ['update', 'start', 'arrive', 'complete']) {
      const row = `('TECHNICIAN','${action}','Job','${OWN_JOB_JSON}')`;
      expect(sql, `missing migration row: ${row}`).toContain(row);
    }
    // Multi-visit S8 (D6) moved OWN_JOB onto the visits path. This migration is HISTORY and its
    // text stays byte-identical - rewriting shipped SQL would falsify the ledger. What repairs the
    // rows it wrote is S8's own guarded UPDATE, matched on exactly the literal above; that pairing
    // is pinned in schema-visit-teardown-shape.test.ts. Here we only assert that DEFAULT_GRANTS
    // has moved on, so the two cannot silently drift back into agreement on the dead path.
    for (const action of ['update', 'start', 'arrive']) {
      const grant = DEFAULT_GRANTS.find((g) => g.role === 'TECHNICIAN' && g.action === action && g.subject === 'Job');
      expect(grant, `defaultGrants.ts is missing TECHNICIAN ${action} Job`).toBeDefined();
      expect((grant as { conditions?: unknown }).conditions).toEqual({
        visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } },
      });
    }
  });

  it('mirrors defaultGrants: read User is unconditional', () => {
    const grant = DEFAULT_GRANTS.find((g) => g.role === 'TECHNICIAN' && g.action === 'read' && g.subject === 'User');
    expect(grant, 'defaultGrants.ts is missing TECHNICIAN read User').toBeDefined();
    expect((grant as { conditions?: unknown }).conditions).toBeUndefined();
    expect(sql).toContain("('TECHNICIAN','read','User',NULL)");
  });

  it('does NOT re-insert the PriceBook row — that migration already shipped', () => {
    expect(sql).not.toContain("'PriceBook'");
  });
});
