import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  vendor: { create: ReturnType<typeof vi.fn> };
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

// #511: vendor phone columns feed CTM's matchByPhone digit-match, so the
// upsert schema must normalize contactPhone / additionalContacts[].phone to
// digits-only regardless of how the (now-masked) frontend inputs send them.
describe('POST /api/inventory/vendors — phone normalization (#511)', () => {
  it('stores contactPhone and additional-contact phone as digits-only', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.create.mockResolvedValue({
      id: 'vnd_1',
      name: 'Acme',
      category: 'Locks',
      payment_terms: '',
      lead_time_days: 0,
      transmit_method: 'email',
      contact_phone: '5550101234',
      contacts: [],
    });

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({
        name: 'Acme',
        category: 'Locks',
        contactPhone: '(555) 010-1234',
        additionalContacts: [{ phone: '(555) 222-3333' }],
      });

    expect(res.status).toBe(201);
    const createArgs = mockPrisma.vendor.create.mock.calls[0][0];
    expect(createArgs.data.contact_phone).toBe('5550101234');
    expect(createArgs.data.contacts.create[0].phone).toBe('5552223333');
  });

  it('strips a leading country-code 1 from an 11-digit contactPhone', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.create.mockResolvedValue({
      id: 'vnd_2',
      name: 'Acme',
      category: 'Locks',
      payment_terms: '',
      lead_time_days: 0,
      transmit_method: 'email',
      contact_phone: '5550101234',
      contacts: [],
    });

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({
        name: 'Acme',
        category: 'Locks',
        contactPhone: '1 (555) 010-1234',
      });

    expect(res.status).toBe(201);
    const createArgs = mockPrisma.vendor.create.mock.calls[0][0];
    expect(createArgs.data.contact_phone).toBe('5550101234');
  });

  it('clears a blank contactPhone to null', async () => {
    mockAuthAs('admin');
    mockPrisma.vendor.create.mockResolvedValue({
      id: 'vnd_3',
      name: 'Acme',
      category: 'Locks',
      payment_terms: '',
      lead_time_days: 0,
      transmit_method: 'email',
      contact_phone: null,
      contacts: [],
    });

    const res = await request(app)
      .post('/api/inventory/vendors')
      .set(authHeader('admin'))
      .send({
        name: 'Acme',
        category: 'Locks',
        contactPhone: '',
      });

    expect(res.status).toBe(201);
    const createArgs = mockPrisma.vendor.create.mock.calls[0][0];
    expect(createArgs.data.contact_phone).toBeNull();
  });
});
