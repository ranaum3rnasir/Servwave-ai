// n-search: the "New message" composer's phone search always missed because
// mapPhoneCustomer (comm-calls.controller.ts) only ever exposed phone numbers
// via contacts[].channels[] (channel_identities) — a table nothing writes.
// Real numbers live on customers.phone / secondary_phone / customer_phones[].
// This asserts the controller now surfaces those as a de-duped `phones[]`.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
});

describe('GET /api/communication/contacts — phones[] for the composer search (n-search)', () => {
  it('exposes a de-duped phones[] built from phone/secondary_phone/customer_phones[]', async () => {
    mockAuthAs('dispatcher');
    p.customer.findMany.mockResolvedValue([
      {
        id: 'cust-1',
        first_name: 'Pat',
        last_name: 'Lee',
        company_name: null,
        membership_tier: null,
        sla_profile: null,
        phone: '+12015550123',
        secondary_phone: null,
        contacts: [],
        service_locations: [],
        jobs: [],
        // customer_phones[] — the first entry duplicates the scalar `phone`.
        phones: [{ phone: '+12015550123' }, { phone: '+16095559999' }],
      },
    ]);

    const res = await request(app)
      .get('/api/communication/contacts')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.contacts).toHaveLength(1);
    expect(res.body.contacts[0].phones).toEqual(['+12015550123', '+16095559999']);
    expect(p.customer.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ include: expect.objectContaining({ phones: true }) }),
    );
  });

  it('filters out falsy entries (no phone / no secondary_phone on file)', async () => {
    mockAuthAs('dispatcher');
    p.customer.findMany.mockResolvedValue([
      {
        id: 'cust-2',
        first_name: 'No',
        last_name: 'Phone',
        company_name: null,
        membership_tier: null,
        sla_profile: null,
        phone: null,
        secondary_phone: null,
        contacts: [],
        service_locations: [],
        jobs: [],
        phones: [],
      },
    ]);

    const res = await request(app)
      .get('/api/communication/contacts')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.contacts[0].phones).toEqual([]);
  });
});

describe('GET /api/communication/contacts/:id — same phones[] shape', () => {
  it('includes phones: true and returns the de-duped phones[]', async () => {
    mockAuthAs('dispatcher');
    p.customer.findFirst.mockResolvedValue({
      id: 'cust-3',
      first_name: 'Sam',
      last_name: 'Rivera',
      company_name: null,
      membership_tier: null,
      sla_profile: null,
      phone: '+16095551234',
      secondary_phone: '+16095555678',
      contacts: [],
      service_locations: [],
      jobs: [],
      phones: [{ phone: '+16095551234' }],
    });

    const res = await request(app)
      .get('/api/communication/contacts/cust-3')
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.contact.phones).toEqual(['+16095551234', '+16095555678']);
    expect(p.customer.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ include: expect.objectContaining({ phones: true }) }),
    );
  });
});
