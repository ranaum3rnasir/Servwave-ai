import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

// Entity-redesign Phase 5 — the hand-authored, UNAPPLIED role_permissions catch-up.
// Pinned to defaultGrants.ts (mirrors how 20260602000000 is pinned by
// permissions-emanuel-modules.test.ts). This migration:
//   (a) DELETEs the folded refund_deposit + reactivate_deposit rows for every org, and
//   (b) INSERTs (ON CONFLICT DO NOTHING) every current non-admin defaultGrants row that
//       existing orgs may lack since the last backfill (e.g. DISPATCHER archive Customer).
describe('redesign_11 CASL backfill migration', () => {
  const MIGRATION = join(
    __dirname,
    '../../prisma/migrations/20260604040300_redesign_11_casl_backfill/migration.sql',
  );
  const sql = readFileSync(MIGRATION, 'utf8');

  it('DELETEs the folded refund_deposit + reactivate_deposit rows', () => {
    expect(sql).toMatch(/DELETE\s+FROM\s+role_permissions/i);
    expect(sql).toContain('refund_deposit');
    expect(sql).toContain('reactivate_deposit');
  });

  it('INSERTs the new DISPATCHER archive Customer grant across every org (FROM organizations + CROSS JOIN VALUES)', () => {
    expect(sql).toMatch(/FROM organizations/i);
    expect(sql).toMatch(/CROSS JOIN \(VALUES/i);
    expect(sql).toContain("('DISPATCHER','archive','Customer',NULL)");
  });

  it('uses the idempotent ON CONFLICT DO NOTHING guard', () => {
    expect(sql).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING');
  });

  // The dynamic "every non-admin defaultGrants row appears in the INSERT block" cross-check
  // was removed here: redesign_11 is a FROZEN, applied migration, but defaultGrants.ts now
  // carries the M2M crew condition shape (scheduler-assignment-redesign TG3), so a runtime
  // cross-check would falsely break against frozen SQL. The new-shape forward cross-check
  // lives in permissions-crew-backfill.test.ts (added in TG7, against the new supersede migration).
});
