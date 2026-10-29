/**
 * SRVW-54 - every phone field in the app is paired with an optional extension.
 *
 * `User.phone_ext` and `Customer.phone_ext` already had one; Vendor, VendorContact,
 * Branch, Location and Organization did not. These tests pin the write path for the
 * five that were missing: the extension reaches Prisma, and omitting it is still a
 * valid request (the column is optional everywhere).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  vendor: { create: ReturnType<typeof vi.fn> };
  branch: { create: ReturnType<typeof vi.fn>; updateMany: ReturnType<typeof vi.fn>; findFirst: ReturnType<typeof vi.fn> };
  location: { create: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

describe('Vendor extension (SRVW-54)', () => {
  it('persists contactPhoneExt and additional-contact phoneExt on create', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.create.mockResolvedValue({
      id: 'vnd_1',
      name: 'Acme',
      category: 'Locks',
      contact_phone: '5550101234',
      contact_phone_ext: '204',
      contacts: [],
    });

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({
        name: 'Acme',
        category: 'Locks',
        contactPhone: '(555) 010-1234',
        contactPhoneExt: '204',
        additionalContacts: [{ phone: '(555) 222-3333', phoneExt: '17' }],
      });

    expect(res.status).toBe(201);
    const createArgs = mockPrisma.vendor.create.mock.calls[0][0];
    expect(createArgs.data.contact_phone_ext).toBe('204');
    expect(createArgs.data.contacts.create[0].phone_ext).toBe('17');
  });

  it('emits contactPhoneExt on the vendor DTO', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.create.mockResolvedValue({
      id: 'vnd_2',
      name: 'Acme',
      category: 'Locks',
      contact_phone: '5550101234',
      contact_phone_ext: '204',
      contacts: [{ id: 'c1', name: 'Pat', phone: '5552223333', phone_ext: '17' }],
    });

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ name: 'Acme', category: 'Locks' });

    expect(res.status).toBe(201);
    expect(res.body.vendor.contactPhoneExt).toBe('204');
    expect(res.body.vendor.additionalContacts[0].phoneExt).toBe('17');
  });

  it('a vendor create with no extension is still valid', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.create.mockResolvedValue({
      id: 'vnd_3', name: 'Acme', category: 'Locks', contact_phone: null, contact_phone_ext: null, contacts: [],
    });

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({ name: 'Acme', category: 'Locks', contactPhone: '5550101234' });

    expect(res.status).toBe(201);
    expect(mockPrisma.vendor.create.mock.calls[0][0].data.contact_phone_ext).toBeNull();
  });
});

describe('Branch extension (SRVW-54)', () => {
  it('persists phoneExt on create', async () => {
    mockAuthAs('admin');
    mockPrisma.branch.create.mockResolvedValue({
      id: 'b0000000-0000-0000-0000-000000000001',
      name: 'Long Island Branch',
      phone: '5550101234',
      phone_ext: '12',
      organization_id: '00000000-0000-0000-0000-000000000001',
    });

    const res = await request(app)
      .post('/api/inventory/branches')
      .set(authHeader('admin'))
      .send({ name: 'Long Island Branch', phone: '5550101234', phoneExt: '12' });

    expect(res.status).toBe(201);
    expect(mockPrisma.branch.create.mock.calls[0][0].data.phone_ext).toBe('12');
    expect(res.body.branch.phoneExt).toBe('12');
  });

  it('persists phoneExt on update', async () => {
    mockAuthAs('admin');
    mockPrisma.branch.updateMany.mockResolvedValue({ count: 1 });
    mockPrisma.branch.findFirst.mockResolvedValue({
      id: 'b0000000-0000-0000-0000-000000000001', name: 'LI', phone: '5550101234', phone_ext: '99',
    });

    const res = await request(app)
      .patch('/api/inventory/branches/b0000000-0000-0000-0000-000000000001')
      .set(authHeader('admin'))
      .send({ phoneExt: '99' });

    expect(res.status).toBe(200);
    expect(mockPrisma.branch.updateMany.mock.calls[0][0].data.phone_ext).toBe('99');
  });
});

describe('Location extension (SRVW-54)', () => {
  it('persists phone_ext on create', async () => {
    mockAuthAs('admin');
    mockPrisma.location.create.mockResolvedValue({
      id: '11111111-1111-1111-1111-111111111111', name: 'Main', phone: '5550101234', phone_ext: '5',
    });

    const res = await request(app)
      .post('/api/locations')
      .set(authHeader('admin'))
      .send({ name: 'Main', phone: '5550101234', phone_ext: '5' });

    expect(res.status).toBe(201);
    expect(mockPrisma.location.create.mock.calls[0][0].data.phone_ext).toBe('5');
  });
});

describe("Organization extension (SRVW-54)", () => {
  it("persists phone_ext on PATCH /api/organization", async () => {
    mockAuthAs("admin");
    const update = vi.fn().mockImplementation((args: any) => Promise.resolve({ id: "00000000-0000-0000-0000-000000000001", ...args.data }));
    (prisma.$transaction as any).mockImplementation((fn: any) =>
      fn({
        $executeRaw: vi.fn().mockResolvedValue(1),
        organization: {
          findUnique: vi.fn().mockResolvedValue({ stripe_charges_enabled: false, accepted_payment_methods: [] }),
          update,
        },
      }),
    );

    const res = await request(app)
      .patch("/api/organization")
      .set(authHeader("admin"))
      .send({ phone_ext: "300" });

    expect(res.status).toBe(200);
    expect(update.mock.calls[0][0].data.phone_ext).toBe("300");
  });
});
