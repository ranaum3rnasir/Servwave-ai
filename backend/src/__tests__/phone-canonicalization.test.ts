/**
 * #352 — Phone standardization: digits-only canonical storage.
 *
 * Every customer-phone write path (customer create/update incl. phones[],
 * lead new_customer, job new_customer) must persist the DIGITS-ONLY form
 * (leading US `1` stripped from an 11-digit value) no matter how the client
 * punctuated the input. Lead list search-by-phone must be digit-normalized
 * on BOTH the scalar Customer.phone and the phones[] relation (parity with
 * customer.controller / global search, #350/#460).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, CUSTOMER_FIXTURE, LEAD_FIXTURE, STANDALONE_JOB_FIXTURE } from './helpers';
import { formatPhoneDisplay } from '../lib/phone-format';

const mockPrisma = prisma as unknown as {
  customer: {
    findMany: ReturnType<typeof vi.fn>;
    findUnique: ReturnType<typeof vi.fn>;
    update: ReturnType<typeof vi.fn>;
  };
  lead: {
    findMany: ReturnType<typeof vi.fn>;
    count: ReturnType<typeof vi.fn>;
  };
  timelineEvent: { create: ReturnType<typeof vi.fn> };
  $transaction: ReturnType<typeof vi.fn>;
};

beforeEach(() => {
  vi.clearAllMocks();
  // Duplicate-customer guard runs prisma.customer.findMany before the create tx.
  mockPrisma.customer.findMany.mockResolvedValue([]);
  mockPrisma.timelineEvent.create.mockResolvedValue({});
});

// ─── POST /api/customers ──────────────────────────────

describe('POST /api/customers — digits-only canonical storage', () => {
  function mockCreateTx() {
    let createFn: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      createFn = vi.fn().mockResolvedValue({ id: 'new-id', service_locations: [] });
      return fn({ customer: { create: createFn } });
    });
    return () => createFn!.mock.calls[0][0];
  }

  it('persists phone, secondary_phone and phones[] as digits-only (leading 1 stripped)', async () => {
    mockAuthAs('admin');
    const createArgs = mockCreateTx();

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({
        first_name: 'Jane',
        phone: '(555) 111-2222',
        secondary_phone: '+1 555 999 8888',
        phones: [{ phone: '1 (555) 123-4567', label: 'Mobile' }],
      });

    expect(res.status).toBe(201);
    const { data } = createArgs();
    expect(data.phone).toBe('5551112222');
    expect(data.secondary_phone).toBe('5559998888');
    expect(data.phones.create[0].phone).toBe('5551234567');
  });

  it('normalizes a blank secondary_phone to null', async () => {
    mockAuthAs('admin');
    const createArgs = mockCreateTx();

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', phone: '5551112222', secondary_phone: '' });

    expect(res.status).toBe(201);
    expect(createArgs().data.secondary_phone).toBeNull();
  });

  it('400s a non-blank secondary_phone with fewer than 7 digits (deliberate tightening)', async () => {
    mockAuthAs('admin');
    mockCreateTx();

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', phone: '5551112222', secondary_phone: '(55) 5-5' });

    expect(res.status).toBe(400);
  });

  it('400s a primary phone with fewer than 7 digits even when padded with punctuation', async () => {
    mockAuthAs('admin');
    mockCreateTx();

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', phone: '(555) 12' });

    expect(res.status).toBe(400);
  });
});

// ─── PATCH /api/customers/:id ─────────────────────────

describe('PATCH /api/customers/:id — digits-only canonical storage', () => {
  it('persists formatted phone/secondary_phone/phones[] as digits-only', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE });

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({
        phone: '(555) 111-2222',
        secondary_phone: '1-555-999-8888',
        phones: [{ phone: '+1 (555) 123-4567' }],
      });

    expect(res.status).toBe(200);
    const { data } = mockPrisma.customer.update.mock.calls[0][0];
    expect(data.phone).toBe('5551112222');
    expect(data.secondary_phone).toBe('5559998888');
    expect(data.phones.create[0].phone).toBe('5551234567');
  });

  it('clears secondary_phone with a blank string (→ null)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.customer.update.mockResolvedValue({ ...CUSTOMER_FIXTURE });

    const res = await request(app)
      .patch(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ secondary_phone: '' });

    expect(res.status).toBe(200);
    expect(mockPrisma.customer.update.mock.calls[0][0].data.secondary_phone).toBeNull();
  });
});

// ─── POST /api/leads — inline new_customer ────────────

describe('POST /api/leads — new_customer phone canonicalization', () => {
  it('persists a formatted new_customer.phone as digits-only', async () => {
    mockAuthAs('admin');
    let customerCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      customerCreate = vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [{ id: 'new-primary-loc-id' }] });
      return fn({
        customer: { create: customerCreate },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(LEAD_FIXTURE) },
        // create() seeds a default REQUESTED Walkthrough row per new lead in the same
        // transaction (PR-B2) - unrelated to this test's phone-canonicalization concern, but
        // the tx mock must cover every call the handler makes or it 500s.
        visit: { create: vi.fn().mockResolvedValue({ id: 'new-walkthrough-id' }) },
      });
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        new_customer: {
          first_name: 'New',
          phone: '+1 (555) 111-2222',
          location: { address_line1: '100 Test Ave', city: 'Austin', state: 'TX', zip: '78701' },
        },
        service_request: 'Furnace repair',
      });

    expect(res.status).toBe(201);
    expect(customerCreate!.mock.calls[0][0].data.phone).toBe('5551112222');
  });

  it('persists a formatted new_customer.secondary_phone as digits-only', async () => {
    mockAuthAs('admin');
    let customerCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => {
      customerCreate = vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [{ id: 'new-primary-loc-id' }] });
      return fn({
        customer: { create: customerCreate },
        lead: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(LEAD_FIXTURE) },
        visit: { create: vi.fn().mockResolvedValue({ id: 'new-walkthrough-id' }) },
      });
    });

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({
        new_customer: {
          first_name: 'New',
          phone: '5551112222',
          secondary_phone: '+1 555 999 8888',
          location: { address_line1: '100 Test Ave', city: 'Austin', state: 'TX', zip: '78701' },
        },
        service_request: 'Furnace repair',
      });

    expect(res.status).toBe(201);
    expect(customerCreate!.mock.calls[0][0].data.secondary_phone).toBe('5559998888');
  });
});

// ─── POST /api/jobs — inline new_customer ─────────────

describe('POST /api/jobs — new_customer phone canonicalization', () => {
  it('persists a formatted new_customer.phone as digits-only', async () => {
    mockAuthAs('admin');
    let customerCreate: ReturnType<typeof vi.fn>;
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
      fn({
        customer: { create: (customerCreate = vi.fn().mockResolvedValue({ id: 'new-cust-id', service_locations: [{ id: 'new-primary-loc-id' }] })) },
        job: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue(STANDALONE_JOB_FIXTURE) },
        orgTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        stateTaxRate: { findFirst: vi.fn().mockResolvedValue(null) },
        timelineEvent: { create: vi.fn().mockResolvedValue({}) },
      }),
    );

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('admin'))
      .send({
        new_customer: {
          first_name: 'New',
          phone: '(555) 111-2222',
          location: { address_line1: '100 Test Ave', city: 'Austin', state: 'TX', zip: '78701' },
        },
        scope_notes: 'Furnace install',
      });

    expect(res.status).toBe(201);
    expect(customerCreate!.mock.calls[0][0].data.phone).toBe('5551112222');
  });
});

// ─── GET /api/leads?search= — normalized phone search ─

describe('GET /api/leads — digit-normalized phone search (scalar + phones[] relation)', () => {
  it('a formatted phone query matches a digits-only store on Customer.phone AND the phones[] relation', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads')
      .query({ search: '(555) 111-2222' })
      .set(authHeader('admin'));

    const where = mockPrisma.lead.findMany.mock.calls[0][0].where;
    const or = where.OR as Array<Record<string, any>>;
    expect(or).toBeDefined();
    // Scalar Customer.phone clause with the digits-only candidate.
    expect(or).toContainEqual({ customer: { phone: { contains: '5551112222' } } });
    // phones[] relation clause (CustomerPhone) with the digits-only candidate (#460 parity).
    expect(or).toContainEqual({ customer: { phones: { some: { phone: { contains: '5551112222' } } } } });
  });

  it('a digit-less search term adds no phone clauses', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app)
      .get('/api/leads')
      .query({ search: 'John' })
      .set(authHeader('admin'));

    const where = mockPrisma.lead.findMany.mock.calls[0][0].where;
    const or = where.OR as Array<Record<string, any>>;
    const phoneClauses = or.filter((c) => c.customer && (c.customer.phone || c.customer.phones));
    expect(phoneClauses).toHaveLength(0);
  });
});

// ─── lib/phone-format.ts — backend display formatter ──

describe('formatPhoneDisplay', () => {
  it('formats 10 digits as (xxx) xxx-xxxx', () => {
    expect(formatPhoneDisplay('5551234567')).toBe('(555) 123-4567');
  });

  it('formats 11 digits with leading 1 on the last 10', () => {
    expect(formatPhoneDisplay('15551234567')).toBe('(555) 123-4567');
  });

  it('passes non-phone-shaped values through unchanged (sentinels, junk)', () => {
    expect(formatPhoneDisplay('bg-import-phone:12345')).toBe('bg-import-phone:12345');
    expect(formatPhoneDisplay('N/A')).toBe('N/A');
    expect(formatPhoneDisplay('555-1234')).toBe('555-1234');
  });

  it('renders null/undefined as an empty string', () => {
    expect(formatPhoneDisplay(null)).toBe('');
    expect(formatPhoneDisplay(undefined)).toBe('');
  });
});
