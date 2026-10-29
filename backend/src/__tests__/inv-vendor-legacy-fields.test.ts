import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// S1.2 (Purchasing Audit Verdict, PR 1): ServWave never sends a PO, so a
// vendor's payment terms, default lead time and PO transmit method are gone
// from the contract. The upsert must keep ACCEPTING the four legacy keys
// (an older client must never 400) while ignoring them, the create path must
// write NONE of the legacy columns (PR 2 made them nullable), and the DTO must
// not emit any of the four - even when the row still carries values.

const mockPrisma = prisma as unknown as {
  vendor: {
    create: ReturnType<typeof vi.fn>;
    findFirst: ReturnType<typeof vi.fn>;
    findMany: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  vendorContact: { deleteMany: ReturnType<typeof vi.fn>; createMany: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

const RETIRED_KEYS = ['paymentTerms', 'leadTimeDays', 'transmitMethod', 'transmitMethods'];
const RETIRED_COLUMNS = ['payment_terms', 'lead_time_days', 'transmit_method', 'transmit_methods'];

const VENDOR_ID = 'e2000000-0000-0000-0000-000000000012';

// A row as the database still returns it: the legacy columns are populated.
const ROW = {
  id: VENDOR_ID,
  name: 'S12 Vendor',
  category: 'Plumbing wholesale',
  payment_terms: 'Net 30',
  lead_time_days: 5,
  transmit_method: 'edi',
  transmit_methods: ['edi', 'phone'],
  status: 'active',
  contacts: [],
  organization_id: ALPHA_ORG_ID,
};

const LEGACY_BODY = {
  paymentTerms: 'Net 30',
  leadTimeDays: 5,
  transmitMethod: 'edi',
  transmitMethods: ['edi'],
};

function expectNoRetiredKeys(vendor: Record<string, unknown>) {
  for (const key of RETIRED_KEYS) expect(vendor).not.toHaveProperty(key);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn(mockPrisma));
});

describe('POST /api/inventory/vendors - create with the retired fields (S1.2)', () => {
  it('accepts a legacy payload carrying all four keys and the 201 body has none of them', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.create.mockResolvedValue(ROW);

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ name: 'S12 Vendor', category: 'Plumbing wholesale', ...LEGACY_BODY });

    expect(res.status).toBe(201);
    expect(res.body.vendor).toMatchObject({ id: VENDOR_ID, name: 'S12 Vendor', category: 'Plumbing wholesale' });
    expectNoRetiredKeys(res.body.vendor);
  });

  it("writes the NOT NULL columns' database defaults, never the client's values", async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.create.mockResolvedValue(ROW);

    await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ name: 'S12 Vendor', category: 'Plumbing wholesale', ...LEGACY_BODY });

    const data = mockPrisma.vendor.create.mock.calls[0][0].data;
    // PR 2: the three columns are nullable, so the create writes none of them.
    for (const col of RETIRED_COLUMNS) expect(data).not.toHaveProperty(col);
  });

  it('creates from {name, category} alone', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.create.mockResolvedValue({ ...ROW, payment_terms: '', lead_time_days: 0, transmit_method: 'email', transmit_methods: null });

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ name: 'S12 Vendor', category: 'Plumbing wholesale' });

    expect(res.status).toBe(201);
    expectNoRetiredKeys(res.body.vendor);
  });

  it('does not 400 on retired keys of the wrong shape either - they are dropped, not validated', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.create.mockResolvedValue(ROW);

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ name: 'S12 Vendor', category: 'Plumbing wholesale', transmitMethod: 'carrier-pigeon', leadTimeDays: 'soon' });

    expect(res.status).toBe(201);
    const data = mockPrisma.vendor.create.mock.calls[0][0].data;
    expect(data).not.toHaveProperty('transmit_method');
    expect(data).not.toHaveProperty('lead_time_days');
  });
});

describe('POST /api/inventory/vendors - update with the retired fields (S1.2)', () => {
  it('ignores the four keys on update: no legacy column reaches the write, the rest of the patch does', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findFirst.mockResolvedValue(ROW);
    mockPrisma.vendor.update.mockResolvedValue(ROW);

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ id: VENDOR_ID, website: 'https://s12.example', ...LEGACY_BODY, transmitMethods: ['edi', 'phone'] });

    expect(res.status).toBe(200);
    const data = mockPrisma.vendor.update.mock.calls[0][0].data;
    expect(data).toEqual({ website: 'https://s12.example' });
    for (const col of RETIRED_COLUMNS) expect(data).not.toHaveProperty(col);
    expectNoRetiredKeys(res.body.vendor);
  });
});

describe('GET /api/inventory/vendors - DTO shape (S1.2)', () => {
  it('omits the retired fields from the list even when the rows still carry them', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findMany.mockResolvedValue([ROW, { ...ROW, id: 'e2000000-0000-0000-0000-000000000013', name: 'S12 Other' }]);

    const res = await request(app).get('/api/inventory/vendors').set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.vendors).toHaveLength(2);
    for (const v of res.body.vendors) {
      expect(v).toMatchObject({ category: 'Plumbing wholesale' });
      expectNoRetiredKeys(v);
    }
  });

  it('omits them from GET /vendors/:id as well', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.findFirst.mockResolvedValue(ROW);

    const res = await request(app).get(`/api/inventory/vendors/${VENDOR_ID}`).set(authHeader('admin'));

    expect(res.status).toBe(200);
    expectNoRetiredKeys(res.body.vendor);
  });
});
