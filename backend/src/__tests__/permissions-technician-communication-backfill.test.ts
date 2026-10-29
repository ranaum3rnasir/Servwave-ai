import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

// Pins the TECHNICIAN `read Communication` backfill (20260804210000) to
// defaultGrants.ts, the same way permissions-notification-backfill.test.ts pins
// 20260618000100. The canonical grant set is the code; the migration SQL must
// mirror it so orgs that already exist get the grant too.
//
// WHY THE GRANT EXISTS AT ALL: verified against the live staging DB before this
// slice, TECHNICIAN held `create Communication` in 9 orgs and `read
// Communication` in ZERO - so anchor-inherited visibility was inert for the one
// role it most exists for (a tech reading the conversation history on their own
// job). The grant is UNCONDITIONAL at the subject level, exactly like SALES's,
// because `Communication` is not a ScopeResource and a condition here would be
// inert; the row filter (lib/permissions/anchorVisibility.ts) is what provides
// the actual scope.
describe('TECHNICIAN read Communication grant', () => {
  it('is an UNCONDITIONAL subject-level grant in DEFAULT_GRANTS', () => {
    const grant = DEFAULT_GRANTS.find(
      (g) => g.role === 'TECHNICIAN' && g.action === 'read' && g.subject === 'Communication',
    );
    expect(grant).toBeDefined();
    // A condition here would be inert (Communication is not a ScopeResource) AND
    // misleading - it would read as if the grant carried the row scope.
    expect(grant!.conditions ?? null).toBeNull();
  });

  it('matches how SALES holds the same grant', () => {
    const sales = DEFAULT_GRANTS.find(
      (g) => g.role === 'SALES' && g.action === 'read' && g.subject === 'Communication',
    );
    const tech = DEFAULT_GRANTS.find(
      (g) => g.role === 'TECHNICIAN' && g.action === 'read' && g.subject === 'Communication',
    );
    expect(tech!.conditions ?? null).toEqual(sales!.conditions ?? null);
  });

  it('does NOT grant TECHNICIAN update or delete Communication', () => {
    const writes = DEFAULT_GRANTS.filter(
      (g) =>
        g.role === 'TECHNICIAN' &&
        g.subject === 'Communication' &&
        (g.action === 'update' || g.action === 'delete'),
    );
    expect(writes).toEqual([]);
  });
});

describe('technician communication grant backfill migration', () => {
  const MIGRATION = join(
    __dirname,
    '../../prisma/migrations/20260804210000_technician_communication_read_backfill/migration.sql',
  );
  const sql = readFileSync(MIGRATION, 'utf8');

  it('inserts across every org (FROM organizations)', () => {
    expect(sql).toMatch(/FROM organizations/i);
  });

  it('uses the idempotent ON CONFLICT DO NOTHING guard', () => {
    expect(sql).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING');
  });

  it('inserts exactly the TECHNICIAN read Communication row, condition-less', () => {
    expect(sql).toContain("'TECHNICIAN'");
    expect(sql).toContain("'read'");
    expect(sql).toContain("'Communication'");
    // NULL conditions - not a JSON literal. A conditioned row here would be a
    // different (and inert) grant from the one defaultGrants.ts declares.
    expect(sql).toMatch(/NULL/);
    expect(sql).not.toMatch(/\{\{userId\}\}/);
  });
});
