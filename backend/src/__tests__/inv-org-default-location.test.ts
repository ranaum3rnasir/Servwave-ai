import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, INVENTORY_LOCATION_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  organization: { findUnique: ReturnType<typeof vi.fn>; update: ReturnType<typeof vi.fn> };
  inventoryLocation: { findFirst: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
  $executeRaw: ReturnType<typeof vi.fn>;
};

beforeEach(() => { vi.clearAllMocks(); clearPermissionCache(); });

describe('PATCH /api/organization — default_inventory_location_id (DEC3)', () => {
  it('accepts + writes a default location that exists in the org', async () => {
    mockAuthAs('admin');
    mockPrisma.$executeRaw.mockResolvedValue(1);
    mockPrisma.organization.findUnique.mockResolvedValue({
      lead_first_issued_at: null, estimate_first_issued_at: null, job_first_issued_at: null,
      invoice_first_issued_at: null, customer_first_issued_at: null,
      lead_prefix: 'L', estimate_prefix: 'E', job_prefix: 'J', invoice_prefix: 'I', customer_prefix: 'C',
      number_padding: 5, stripe_account_id: null, accepted_payment_methods: [],
    });
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(INVENTORY_LOCATION_FIXTURE);
    mockPrisma.organization.update.mockResolvedValue({ id: ALPHA_ORG_ID, default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).patch('/api/organization').set(authHeader('admin'))
      .send({ default_inventory_location_id: INVENTORY_LOCATION_FIXTURE.id });
    expect(res.status).toBe(200);
    expect(mockPrisma.organization.update.mock.calls[0][0].data.default_inventory_location_id).toBe(INVENTORY_LOCATION_FIXTURE.id);
  });

  it('rejects a default location from another org (400)', async () => {
    mockAuthAs('admin');
    mockPrisma.$executeRaw.mockResolvedValue(1);
    mockPrisma.organization.findUnique.mockResolvedValue({
      lead_first_issued_at: null, estimate_first_issued_at: null, job_first_issued_at: null,
      invoice_first_issued_at: null, customer_first_issued_at: null,
      lead_prefix: 'L', estimate_prefix: 'E', job_prefix: 'J', invoice_prefix: 'I', customer_prefix: 'C',
      number_padding: 5, stripe_account_id: null, accepted_payment_methods: [],
    });
    mockPrisma.inventoryLocation.findFirst.mockResolvedValue(null); // not in org
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).patch('/api/organization').set(authHeader('admin'))
      .send({ default_inventory_location_id: '99999999-9999-9999-9999-999999999999' });
    expect(res.status).toBe(400);
    expect(mockPrisma.organization.update).not.toHaveBeenCalled();
  });
});

describe('PATCH /api/organization — block_negative_stock (P1 D7)', () => {
  it('accepts + writes the org negative-stock policy toggle', async () => {
    mockAuthAs('admin');
    mockPrisma.$executeRaw.mockResolvedValue(1);
    mockPrisma.organization.findUnique.mockResolvedValue({
      lead_first_issued_at: null, estimate_first_issued_at: null, job_first_issued_at: null,
      invoice_first_issued_at: null, customer_first_issued_at: null,
      lead_prefix: 'L', estimate_prefix: 'E', job_prefix: 'J', invoice_prefix: 'I', customer_prefix: 'C',
      number_padding: 5, stripe_account_id: null, accepted_payment_methods: [],
    });
    mockPrisma.organization.update.mockResolvedValue({ id: ALPHA_ORG_ID, block_negative_stock: true });
    mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
    const res = await request(app).patch('/api/organization').set(authHeader('admin'))
      .send({ block_negative_stock: true });
    expect(res.status).toBe(200);
    expect(mockPrisma.organization.update.mock.calls[0][0].data.block_negative_stock).toBe(true);
  });
});
