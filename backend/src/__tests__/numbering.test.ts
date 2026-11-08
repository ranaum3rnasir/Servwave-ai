import { describe, it, expect, beforeEach, beforeAll, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { mockAuthAs, authHeader, ALPHA_ORG_ID, ORG_B_ID } from './helpers';

// Bypass the global numbering mock from setup.ts so these tests use the REAL allocator.
let allocateNumber: (typeof import('../lib/numbering'))['allocateNumber'];
beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/numbering')>('../lib/numbering');
  allocateNumber = real.allocateNumber;
});

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
});

describe('allocateNumber — atomic per-org allocator', () => {
  it('formats number with prefix and padding from org row', async () => {
    (prisma.$queryRaw as Mock).mockResolvedValue([{ next_value: 2, prefix: 'L', padding: 5 }]);
    const result = await allocateNumber(prisma, 'lead', ALPHA_ORG_ID);
    expect(result).toBe('L00001'); // next_value=2 means allocated=1
  });

  it('honors custom prefix and padding (e.g., BG-0001)', async () => {
    (prisma.$queryRaw as Mock).mockResolvedValue([{ next_value: 2, prefix: 'BG-', padding: 4 }]);
    const result = await allocateNumber(prisma, 'invoice', ORG_B_ID);
    expect(result).toBe('BG-0001');
  });

  it('Org A and Org B counters are independent (sequential allocations from each)', async () => {
    // 'lead' now supports custom numbers, so each allocateNumber call issues a second
    // $queryRaw probing whether a hand-typed number already occupies the candidate (see
    // numbering-editable-ids.test.ts). `taken: false` means "nothing collides", preserving
    // this test's original intent unchanged.
    (prisma.$queryRaw as Mock)
      .mockResolvedValueOnce([{ next_value: 43, prefix: 'L', padding: 5 }])   // Alpha self-heal (had 42)
      .mockResolvedValueOnce([{ taken: false }])                              // Alpha probe: L00042 is free
      .mockResolvedValueOnce([{ next_value: 2,  prefix: 'L', padding: 5 }])   // OrgB self-heal (had 1)
      .mockResolvedValueOnce([{ taken: false }]);                             // OrgB probe: L00001 is free

    const alphaResult = await allocateNumber(prisma, 'lead', ALPHA_ORG_ID);
    const orgBResult  = await allocateNumber(prisma, 'lead', ORG_B_ID);

    expect(alphaResult).toBe('L00042');
    expect(orgBResult).toBe('L00001');
  });

  it('throws when org not found', async () => {
    (prisma.$queryRaw as Mock).mockResolvedValue([]);
    await expect(allocateNumber(prisma, 'lead', '99999999-9999-9999-9999-999999999999')).rejects.toThrow(/not found/);
  });

  it('allocates sequential per-org customer numbers with prefix+padding', async () => {
    // 'customer' now supports custom numbers too — same probe second-call shape as above.
    (prisma.$queryRaw as Mock)
      .mockResolvedValueOnce([{ next_value: 2, prefix: 'C', padding: 5 }])
      .mockResolvedValueOnce([{ taken: false }])
      .mockResolvedValueOnce([{ next_value: 3, prefix: 'C', padding: 5 }])
      .mockResolvedValueOnce([{ taken: false }]);
    const a = await allocateNumber(prisma, 'customer', ALPHA_ORG_ID);
    const b = await allocateNumber(prisma, 'customer', ALPHA_ORG_ID);
    expect(a).toBe('C00001');
    expect(b).toBe('C00002');
  });
});

describe('Numbering settings — PATCH /api/organization', () => {
  // The controller now wraps lock+collision+update in a $transaction with a row-lock
  // (`SELECT ... FOR UPDATE`) to prevent TOCTOU against the concurrent allocator.
  // For mocked unit tests we passthrough: callback receives the same prisma mock.
  beforeEach(() => {
    (prisma.$transaction as Mock).mockImplementation((fn: any) => fn(prisma));
    (prisma.$executeRaw as Mock).mockResolvedValue(0);
  });

  it('rejects lead_next_number <= existing max (collision protection)', async () => {
    mockAuthAs('orgB_admin');
    (prisma.organization.findUnique as Mock).mockResolvedValue({
      lead_first_issued_at: new Date('2026-01-01'),
      estimate_first_issued_at: null, job_first_issued_at: null, invoice_first_issued_at: null,
      customer_first_issued_at: null,
      lead_prefix: 'L', estimate_prefix: 'E', job_prefix: 'J', invoice_prefix: 'I',
      customer_prefix: 'C',
      number_padding: 5,
    });
    (prisma.$queryRaw as Mock).mockResolvedValue([{ max_num: 50 }]);
    const res = await request(app).patch('/api/organization').set(authHeader('orgB_admin')).send({
      lead_next_number: 10,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be lower than/i);
  });

  it('rejects first_issued_at in inbound payload (strict schema blocks server-controlled fields)', async () => {
    mockAuthAs('orgB_admin');
    const res = await request(app).patch('/api/organization').set(authHeader('orgB_admin')).send({
      lead_first_issued_at: '2025-01-01',
    });
    expect(res.status).toBe(400);
  });

  it('allows prefix and padding changes even after documents are issued', async () => {
    mockAuthAs('orgB_admin');
    (prisma.organization.findUnique as Mock).mockResolvedValue({
      lead_first_issued_at: new Date('2026-01-01'),
      estimate_first_issued_at: new Date('2026-01-01'),
      job_first_issued_at: null, invoice_first_issued_at: null,
      customer_first_issued_at: null,
      lead_prefix: 'L', estimate_prefix: 'E', job_prefix: 'J', invoice_prefix: 'I',
      customer_prefix: 'C',
      number_padding: 5,
    });
    (prisma.organization.update as Mock).mockResolvedValue({});
    const res = await request(app).patch('/api/organization').set(authHeader('orgB_admin')).send({
      lead_prefix: 'BG-', number_padding: 6,
    });
    expect(res.status).toBe(200);
  });

  it('rejects prefixes with whitespace, control chars, or emoji', async () => {
    mockAuthAs('orgB_admin');
    const res = await request(app).patch('/api/organization').set(authHeader('orgB_admin')).send({
      lead_prefix: 'L\n',
    });
    expect(res.status).toBe(400);
  });
});

describe('Customer numbering settings — PATCH /api/organization', () => {
  const BASE_ORG = {
    lead_first_issued_at: null, estimate_first_issued_at: null,
    job_first_issued_at: null, invoice_first_issued_at: null,
    customer_first_issued_at: null,
    lead_prefix: 'L', estimate_prefix: 'E', job_prefix: 'J', invoice_prefix: 'I',
    customer_prefix: 'C',
    number_padding: 5,
    stripe_account_id: null,
    accepted_payment_methods: [],
  };

  beforeEach(() => {
    mockAuthAs('orgB_admin');
    (prisma.$transaction as Mock).mockImplementation((fn: any) => fn(prisma));
    (prisma.$executeRaw as Mock).mockResolvedValue(0);
    (prisma.organization.findUnique as Mock).mockResolvedValue(BASE_ORG);
    (prisma.organization.update as Mock).mockResolvedValue({ ...BASE_ORG });
  });

  it('accepts a valid customer_prefix matching PREFIX_REGEX', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('orgB_admin'))
      .send({ customer_prefix: 'CUS' });
    expect(res.status).toBe(200);
  });

  it('rejects customer_prefix that does not match PREFIX_REGEX (special chars)', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('orgB_admin'))
      .send({ customer_prefix: 'C#1' });
    expect(res.status).toBe(400);
  });

  it('rejects customer_prefix longer than 10 characters', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('orgB_admin'))
      .send({ customer_prefix: 'ABCDEFGHIJK' });
    expect(res.status).toBe(400);
  });

  it('accepts a valid customer_next_number when no customers exist (max=0)', async () => {
    (prisma.$queryRaw as Mock).mockResolvedValue([{ max_num: 0 }]);
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('orgB_admin'))
      .send({ customer_next_number: 1 });
    expect(res.status).toBe(200);
  });

  it('rejects customer_next_number <= existing max (collision protection)', async () => {
    (prisma.$queryRaw as Mock).mockResolvedValue([{ max_num: 50 }]);
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('orgB_admin'))
      .send({ customer_next_number: 10 });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be lower than/i);
  });

  it('rejects customer_first_issued_at in inbound payload (strict schema blocks it)', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('orgB_admin'))
      .send({ customer_first_issued_at: '2025-01-01' });
    expect(res.status).toBe(400);
  });
});
