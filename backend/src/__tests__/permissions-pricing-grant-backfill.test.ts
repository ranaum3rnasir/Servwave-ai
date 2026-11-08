/**
 * SRVW-140 - `read Pricing` backfill migration.
 *
 * Pins 20260803120000_pricing_read_grant_backfill to defaultGrants.ts the same way
 * permissions-technician-pricebook-backfill.test.ts pins 20260717120000: the canonical grant set
 * is the code, and the SQL must preserve existing behaviour on deploy.
 *
 * The derivation is deliberately FROM role_permissions itself rather than a hardcoded VALUES
 * list: every (organization_id, role) that holds `read Invoice` today can see costs today, so
 * giving exactly that set `read Pricing` means nobody loses visibility when canSeePricing is
 * repointed. TECHNICIAN holds no `read Invoice` anywhere, so it receives nothing.
 */
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';

const MIGRATION = join(
  __dirname,
  '../../prisma/migrations/20260803120000_pricing_read_grant_backfill/migration.sql',
);

describe('pricing-grant backfill migration', () => {
  const sql = () => readFileSync(MIGRATION, 'utf8');

  it('derives the new grant from the existing read Invoice rows', () => {
    expect(sql()).toMatch(/FROM role_permissions/i);
    expect(sql()).toContain("subject = 'Invoice'");
    expect(sql()).toContain("'read', 'Pricing'");
  });

  it('is idempotent via the (organization_id, role, action, subject) unique index', () => {
    expect(sql()).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING');
  });

  it('supplies the app-side defaults raw SQL has to fill in itself (id, updated_at)', () => {
    // schema.prisma: `id @default(uuid())` is a PRISMA-side default and `updated_at @updatedAt`
    // has no DB default, so neither column is populated for a raw INSERT.
    expect(sql()).toContain('gen_random_uuid()');
    expect(sql()).toMatch(/NOW\(\)/);
  });
});

describe('DEFAULT_GRANTS - read Pricing role split', () => {
  const pricingRows = () => DEFAULT_GRANTS.filter((g) => g.action === 'read' && g.subject === 'Pricing');

  it('grants read Pricing to every non-admin role, one row each', () => {
    expect(pricingRows().map((g) => g.role).sort()).toEqual(['DISPATCHER', 'SALES', 'TECHNICIAN']);
  });

  // TECHNICIAN joined SALES/DISPATCHER in the technician-ownership spec, Part C (PR 3). Until then
  // a bare technician was deliberately price-blind and this file asserted the empty set. The switch
  // is still the only writer, so an admin can take it back off for the role; what changed is where
  // "Reset to default" lands. Price-blindness itself is unchanged and still exercised - the
  // price-blind suites now build that principal explicitly instead of getting it for free.
  it('gives TECHNICIAN exactly one row, so the switch reads ON after a Reset to default', () => {
    expect(pricingRows().filter((g) => g.role === 'TECHNICIAN')).toHaveLength(1);
  });

  it('the new rows are condition-less (cost visibility is not row-scoped)', () => {
    for (const row of pricingRows()) {
      expect((row as { conditions?: unknown }).conditions).toBeUndefined();
    }
  });
});
