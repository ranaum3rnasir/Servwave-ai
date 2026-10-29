/**
 * Inventory P3 — TECHNICIAN `read PriceBook` role default + backfill (plan Phase 3).
 *
 * Pins the backfill migration to defaultGrants.ts the same way
 * permissions-task-grants-backfill.test.ts pins 20260618000000: the canonical grant set is the
 * code; the SQL must mirror it row-for-row so existing orgs' technicians can reach the catalog
 * picker feed (and /api/inventory/my-van, gated `read PriceBook`).
 *
 * Also asserts the behavioral consequences (QA-802 sweep slice): catalog search opens for a bare
 * tech WITH costs stripped (canSeePricing = read Invoice, which a bare tech lacks), while the
 * legacy Inventory-subject reads (/api/inventory/items, /movements) stay 403 — the grant must
 * never widen `Inventory`.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { mockAuthAs, authHeader, mockRoleGrantsWithout } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

describe('technician pricebook-read backfill migration', () => {
  const MIGRATION = join(
    __dirname,
    '../../prisma/migrations/20260717120000_technician_pricebook_read_backfill/migration.sql',
  );
  const sql = readFileSync(MIGRATION, 'utf8');

  it('inserts across every org (FROM organizations + CROSS JOIN VALUES)', () => {
    expect(sql).toMatch(/FROM organizations/i);
    expect(sql).toMatch(/CROSS JOIN \(VALUES/i);
  });

  it('uses the idempotent ON CONFLICT DO NOTHING guard', () => {
    expect(sql).toContain('ON CONFLICT (organization_id, role, action, subject) DO NOTHING');
  });

  it('mirrors defaultGrants: exactly ONE TECHNICIAN PriceBook grant — unconditional read', () => {
    const expected = DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN' && g.subject === 'PriceBook');
    expect(expected).toEqual([{ role: 'TECHNICIAN', action: 'read', subject: 'PriceBook' }]);
    for (const g of expected) {
      const row = `('${g.role}','${g.action}','${g.subject}',NULL)`;
      expect(sql, `missing migration row: ${row}`).toContain(row);
    }
  });

  it('grants ONLY the read row — no TECHNICIAN PriceBook write rows sneak in', () => {
    for (const action of ['create', 'update', 'delete']) {
      expect(sql).not.toContain(`('TECHNICIAN','${action}','PriceBook'`);
    }
  });
});

describe('behavioral slice — bare technician catalog access after the grant', () => {
  const mockPrisma = prisma as unknown as {
    priceBookItem: { findMany: ReturnType<typeof vi.fn>; count: ReturnType<typeof vi.fn> };
    stockMovement: { findMany: ReturnType<typeof vi.fn> };
  };

  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    clearUserOverrideCache();
    mockAuthAs('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['read', 'Pricing']);  // price-blind on purpose: read Pricing is a TECHNICIAN default since the ownership spec
  });

  it('GET /api/price-book/items/search → 200 with unit_cost/list_price ABSENT (stripItemCost path)', async () => {
    mockPrisma.priceBookItem.findMany.mockResolvedValue([
      {
        id: 'aaaaaaa2-0000-0000-0000-000000000002',
        name: '12ga Wire (ft)',
        description: null,
        image_url: null,
        type: 'MATERIAL',
        unit_cost: 2,
        unit_price: 4,
        taxable: true,
        category: null,
      },
    ]);

    const res = await request(app)
      .get('/api/price-book/items/search?q=wire')
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body.data).toHaveLength(1);
    expect(res.body.data[0].unit_cost).toBeUndefined();
    expect(res.body.data[0].list_price).toBeUndefined();
    expect(res.body.data[0].unit_price).toBe(4);
  });

  it('GET /api/inventory/items stays 403 — read Inventory is untouched by the PriceBook grant', async () => {
    const res = await request(app).get('/api/inventory/items').set(authHeader('technician'));
    expect(res.status).toBe(403);
  });

  it('GET /api/inventory/movements stays 403 (QA-802 negative)', async () => {
    const res = await request(app).get('/api/inventory/movements').set(authHeader('technician'));
    expect(res.status).toBe(403);
  });
});
