import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

describe('DISPATCHER read User grant (board roster fix)', () => {
  it('DEFAULT_GRANTS includes DISPATCHER read User (covers new-org seed + role reset)', () => {
    const has = DEFAULT_GRANTS.some(
      (g) => g.role === 'DISPATCHER' && g.action === 'read' && g.subject === 'User',
    );
    expect(has).toBe(true);
  });

  it('the grant is unconditional (the dispatcher sees the whole roster, not own-scoped)', () => {
    const g = DEFAULT_GRANTS.find(
      (x) => x.role === 'DISPATCHER' && x.action === 'read' && x.subject === 'User',
    );
    expect(g).toBeDefined();
    expect(g!.conditions).toBeUndefined();
  });

  it('a backfill migration writes the grant for every existing org, idempotently', () => {
    const sql = readFileSync(
      join(__dirname, '../../prisma/migrations/20260611130000_dispatcher_read_user_grant/migration.sql'),
      'utf8',
    );
    expect(sql).toContain("('DISPATCHER','read','User',NULL)");
    expect(sql).toMatch(/FROM organizations o/);
    expect(sql).toMatch(/ON CONFLICT \(organization_id, role, action, subject\) DO NOTHING/);
  });
});
