import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, mockRoleGrantsWithout } from './helpers';
import { prisma } from '../lib/prisma';
import { generateEstimatePdf, generateInvoicePdf } from '../lib/pdf';
import { organizationScalarSelect, organizationCostSelect } from '../controllers/organization.controller';

vi.mock('../lib/pdf', () => ({
  generateEstimatePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
  generateInvoicePdf: vi.fn().mockResolvedValue(Buffer.from('%PDF-1.4 fake')),
}));

vi.mock('sharp', () => ({
  default: vi.fn().mockReturnValue({
    resize: vi.fn().mockReturnThis(),
    toBuffer: vi.fn().mockResolvedValue(Buffer.from('resized-image')),
  }),
}));

const MOCK_ORG = {
  id: '00000000-0000-0000-0000-000000000001',
  name: 'Harbor Locksmiths LLC',
  legal_name: null,
  address_line1: '100 Main Street',
  address_line2: null,
  city: 'Springfield',
  state: 'IL',
  postal_code: '62701',
  country: 'US',
  email: 'info@example.com',
  phone: null,
  website: null,
  logo_url: null,
  brand_color: '#E11D2E',
  estimate_template: 'alpha-classic',
  estimate_terms: 'Sample terms.',
  estimate_notes: '- Note A',
  estimate_payment_terms: '- 70%',
  invoice_terms: 'Sample invoice terms.',
  invoice_notes: '- Invoice note A',
  invoice_payment_terms: '- 70% due on acceptance',
  stripe_account_id: null,
  stripe_charges_enabled: false,
  accepted_payment_methods: ['EXTERNAL_CARD', 'BANK_TRANSFER', 'CHECK', 'CASH'],
  // numbering lock-after-first-issue fields (so the controller's locks don't
  // false-trip when a test PATCH body doesn't touch numbering).
  lead_first_issued_at: null,
  estimate_first_issued_at: null,
  job_first_issued_at: null,
  invoice_first_issued_at: null,
  customer_first_issued_at: null,
  lead_prefix: 'L',
  estimate_prefix: 'E',
  job_prefix: 'J',
  invoice_prefix: 'I',
  customer_prefix: 'C',
  number_padding: 5,
  created_at: new Date(),
  updated_at: new Date(),
};

describe('organizationScalarSelect — Stripe status fields', () => {
  it('includes all 5 Stripe status columns so GET /api/organization agrees with GET /api/organization/stripe/status', () => {
    expect(organizationScalarSelect).toMatchObject({
      stripe_account_id: true,
      stripe_charges_enabled: true,
      stripe_payouts_enabled: true,
      stripe_details_submitted: true,
      stripe_requirements_due: true,
      stripe_disabled_reason: true,
    });
  });
});

describe('GET /api/organization', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    (prisma.organization.findUnique as any).mockResolvedValue(MOCK_ORG);
  });

  it('returns org for any authenticated user', async () => {
    const res = await request(app)
      .get('/api/organization')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Harbor Locksmiths LLC');
    expect(res.body.brand_color).toBe('#E11D2E');
  });

  it('returns 401 when unauthenticated', async () => {
    const res = await request(app).get('/api/organization');
    expect(res.status).toBe(401);
  });

  it('returns 404 when no org exists', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue(null);

    const res = await request(app)
      .get('/api/organization')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Organization not configured');
  });
});

describe('PATCH /api/organization', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    (prisma.organization.findUnique as any).mockResolvedValue(MOCK_ORG);
    (prisma.organization as any).update = vi.fn().mockResolvedValue({
      ...MOCK_ORG,
      name: 'Updated Name',
    });
    // Controller now wraps in $transaction with row lock; passthrough for unit tests.
    (prisma.$transaction as any).mockImplementation((fn: any) => fn(prisma));
    (prisma.$executeRaw as any).mockResolvedValue(0);
  });

  it('updates fields for ADMIN', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(200);
    expect(res.body.name).toBe('Updated Name');
  });

  it('accepts invoice_terms/invoice_notes/invoice_payment_terms (separate from estimate copy)', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({
        invoice_terms: 'New invoice terms.',
        invoice_notes: '- New invoice note',
        invoice_payment_terms: '- Net 15',
      });

    expect(res.status).toBe(200);
    expect((prisma.organization.update as any).mock.calls[0][0]).toMatchObject({
      data: {
        invoice_terms: 'New invoice terms.',
        invoice_notes: '- New invoice note',
        invoice_payment_terms: '- Net 15',
      },
    });
  });

  it('returns 403 for SALES', async () => {
    mockAuthAs('sales');
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('sales'))
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(403);
  });

  it('returns 403 for DISPATCHER', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('dispatcher'))
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(403);
  });

  it('returns 403 for TECHNICIAN', async () => {
    mockAuthAs('technician');
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('technician'))
      .send({ name: 'Updated Name' });

    expect(res.status).toBe(403);
  });

  it('returns 400 for invalid brand_color (not #RRGGBB format)', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ brand_color: 'red' });

    expect(res.status).toBe(400);
  });

  it('returns 400 for invalid estimate_template (not known key)', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ estimate_template: 'unknown-template' });

    expect(res.status).toBe(400);
  });
});

describe('PATCH /api/organization — accepted_payment_methods (§4.5)', () => {
  const NON_STRIPE_ORG = { ...MOCK_ORG, stripe_account_id: null, stripe_charges_enabled: false,
    accepted_payment_methods: ['EXTERNAL_CARD', 'CHECK'] };
  const STRIPE_ORG = { ...MOCK_ORG, stripe_account_id: 'acct_test_123', stripe_charges_enabled: true,
    accepted_payment_methods: ['CARD', 'CHECK', 'BANK_TRANSFER'] };
  // Task 1.7 re-key regression fixture — mid-onboarding: the Connect account exists
  // (stripe_account_id is set) but Stripe has NOT yet enabled charges. The OLD heuristic
  // ("stripe_account_id is non-null") would wrongly treat this org as CARD-capable; the
  // re-keyed validator must still reject, because the account id existing is not proof
  // that charges actually work yet.
  const MID_ONBOARDING_ORG = { ...MOCK_ORG, stripe_account_id: 'acct_mid_onboarding', stripe_charges_enabled: false,
    accepted_payment_methods: ['EXTERNAL_CARD', 'CHECK'] };

  beforeEach(() => {
    mockAuthAs('admin');
    (prisma.$transaction as any).mockImplementation((fn: any) => fn(prisma));
    (prisma.$executeRaw as any).mockResolvedValue(0);
    (prisma.organization as any).update = vi.fn().mockImplementation(({ data }: any) =>
      Promise.resolve({ ...MOCK_ORG, ...data })
    );
  });

  it('persists accepted_payment_methods when valid (non-Stripe org)', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue(NON_STRIPE_ORG);

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ accepted_payment_methods: ['EXTERNAL_CARD', 'BANK_TRANSFER', 'CASH'] });

    expect(res.status).toBe(200);
    expect(res.body.accepted_payment_methods).toEqual(['EXTERNAL_CARD', 'BANK_TRANSFER', 'CASH']);
  });

  it('drops a client-sent CARD when Stripe charges are not enabled', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue(NON_STRIPE_ORG);

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ accepted_payment_methods: ['CARD', 'EXTERNAL_CARD'] });

    expect(res.status).toBe(200);
    expect(res.body.accepted_payment_methods).toEqual(['EXTERNAL_CARD']);
  });

  // Task 1.7 — a mid-onboarding org (Connect account created, so stripe_account_id is set)
  // must NOT get CARD before Stripe has actually enabled charges on that account. Keying off
  // "stripe_account_id is non-null" would be wrong: that is true from the moment onboarding
  // starts. The resolver keys off stripe_charges_enabled, so a client-sent CARD is dropped.
  it('drops a client-sent CARD when the account exists but charges are not yet enabled (mid-onboarding)', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue(MID_ONBOARDING_ORG);

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ accepted_payment_methods: ['CARD', 'EXTERNAL_CARD'] });

    expect(res.status).toBe(200);
    expect(res.body.accepted_payment_methods).toEqual(['EXTERNAL_CARD']);
  });

  // The bug this resolver replaces a 400 for: the Settings page renders NO CARD toggle, yet
  // PATCHes the whole array from the org snapshot it loaded. A snapshot fetched before
  // charges went live has no CARD in it, so an unrelated edit (here: turning Venmo on) used
  // to read as "disable Credit Card" and 400 a save the user never asked for. CARD is
  // server-owned — it is re-derived from stripe_charges_enabled and survives regardless.
  it('re-adds CARD when a stale client payload omits it (charges enabled)', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue(STRIPE_ORG);

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ accepted_payment_methods: ['CHECK', 'BANK_TRANSFER', 'VENMO'] });

    expect(res.status).toBe(200);
    expect(res.body.accepted_payment_methods).toEqual(['CHECK', 'BANK_TRANSFER', 'VENMO', 'CARD']);
  });

  it('keeps CARD exactly once when the client also sent it (charges enabled)', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue(STRIPE_ORG);

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ accepted_payment_methods: ['CARD', 'EXTERNAL_CARD', 'CHECK'] });

    expect(res.status).toBe(200);
    expect(res.body.accepted_payment_methods).toEqual(['EXTERNAL_CARD', 'CHECK', 'CARD']);
  });

  it('rejects unknown payment method strings at the Zod layer', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue(NON_STRIPE_ORG);

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ accepted_payment_methods: ['WIRE', 'CHECK'] });

    expect(res.status).toBe(400);
  });

  it('rejects duplicate entries at the Zod layer', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue(NON_STRIPE_ORG);

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ accepted_payment_methods: ['CHECK', 'CHECK'] });

    expect(res.status).toBe(400);
  });

  it('accepts an empty array', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue(NON_STRIPE_ORG);

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ accepted_payment_methods: [] });

    expect(res.status).toBe(200);
    expect(res.body.accepted_payment_methods).toEqual([]);
  });

  it('returns 403 for SALES role', async () => {
    mockAuthAs('sales');
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('sales'))
      .send({ accepted_payment_methods: ['EXTERNAL_CARD'] });

    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/organization — source_options and job_type_options', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    (prisma.$transaction as any).mockImplementation((fn: any) => fn(prisma));
    (prisma.$executeRaw as any).mockResolvedValue(0);
    (prisma.organization as any).findUnique = vi.fn().mockResolvedValue(MOCK_ORG);
    (prisma.organization as any).update = vi.fn().mockImplementation(({ data }: any) =>
      Promise.resolve({ ...MOCK_ORG, ...data })
    );
  });

  it('persists source_options and deduplicates case-insensitively', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ source_options: ['Google', 'Referral', 'google'] });

    expect(res.status).toBe(200);
    // Controller deduplicates; only unique values should be persisted
    const updateArgs = (prisma.organization.update as any).mock.calls[0][0];
    expect(updateArgs.data.source_options).toEqual(['Google', 'Referral']);
  });

  it('persists job_type_options', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ job_type_options: ['Cabinet Install', 'Repair'] });

    expect(res.status).toBe(200);
    expect(res.body.job_type_options).toEqual(['Cabinet Install', 'Repair']);
  });

  it('rejects an item longer than 50 chars', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ source_options: ['A'.repeat(51)] });

    expect(res.status).toBe(400);
  });

  it('rejects more than 100 items', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ source_options: Array.from({ length: 101 }, (_, i) => `Option ${i}`) });

    expect(res.status).toBe(400);
  });

  it('accepts exactly 100 items', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ job_type_options: Array.from({ length: 100 }, (_, i) => `Type ${i}`) });

    expect(res.status).toBe(200);
  });

  it('rejects empty-string items', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ source_options: [''] });

    expect(res.status).toBe(400);
  });

  it('accepts an empty array', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ source_options: [] });

    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/organization — billing_terms_options (entity-redesign §2)', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    (prisma.$transaction as any).mockImplementation((fn: any) => fn(prisma));
    (prisma.$executeRaw as any).mockResolvedValue(0);
    (prisma.organization as any).findUnique = vi.fn().mockResolvedValue(MOCK_ORG);
    (prisma.organization as any).update = vi.fn().mockImplementation(({ data }: any) =>
      Promise.resolve({ ...MOCK_ORG, ...data })
    );
  });

  it('persists billing_terms_options and dedupes case-insensitively', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ billing_terms_options: ['Net 30', 'Net 60', 'net 30'] });

    expect(res.status).toBe(200);
    const updateArgs = (prisma.organization.update as any).mock.calls[0][0];
    expect(updateArgs.data.billing_terms_options).toEqual(['Net 30', 'Net 60']);
  });

  it('rejects an item longer than 50 chars', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ billing_terms_options: ['A'.repeat(51)] });
    expect(res.status).toBe(400);
  });

  it('rejects more than 100 items', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ billing_terms_options: Array.from({ length: 101 }, (_, i) => `Term ${i}`) });
    expect(res.status).toBe(400);
  });

  it('strict() accepts the billing_terms_options key', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ billing_terms_options: ['Due on Receipt'] });
    expect(res.status).toBe(200);
  });
});

describe('POST /api/organization/logo', () => {
  // Real PNG magic bytes (89 50 4E 47 0D 0A 1A 0A) so the magic-byte content
  // sniff (F-35) sees a genuine image, not a header-spoofed placeholder.
  const PNG_BYTES = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  beforeEach(() => {
    mockAuthAs('admin');
    (prisma.organization.findUnique as any).mockResolvedValue(MOCK_ORG);
    (prisma.organization as any).update = vi.fn().mockResolvedValue({
      ...MOCK_ORG,
      logo_url: 'https://test.supabase.co/storage/v1/object/public/test/file.jpg',
    });
  });

  it('accepts PNG and returns logo_url for ADMIN', async () => {
    const res = await request(app)
      .post('/api/organization/logo')
      .set(authHeader('admin'))
      .attach('file', PNG_BYTES, { filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(200);
    expect(res.body.logo_url).toBeDefined();
  });

  it('returns 400 when no file is provided', async () => {
    const res = await request(app)
      .post('/api/organization/logo')
      .set(authHeader('admin'));

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('No file provided');
  });

  it('returns 400 for unsupported MIME type (text/plain)', async () => {
    const res = await request(app)
      .post('/api/organization/logo')
      .set(authHeader('admin'))
      .attach('file', Buffer.from('not an image'), { filename: 'file.txt', contentType: 'text/plain' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unsupported image type');
  });

  it('returns 400 for SVG logo — SVG dropped from allowlist (F-36)', async () => {
    const res = await request(app)
      .post('/api/organization/logo')
      .set(authHeader('admin'))
      .attach('file', Buffer.from('<svg onload="alert(1)"/>'), { filename: 'logo.svg', contentType: 'image/svg+xml' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('Unsupported image type');
  });

  it('returns 400 for a header-spoofed non-image declared image/png (F-35)', async () => {
    const res = await request(app)
      .post('/api/organization/logo')
      .set(authHeader('admin'))
      .attach('file', Buffer.from('<svg onload="alert(1)"/>'), { filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(400);
    expect(res.body.error).toBe('File content does not match its declared type');
  });

  // The 2MB multer cap is the ONLY size gate on this route - uploadLogo has no second
  // check behind it - so an oversized logo aborted the stream, fell through to app.ts's
  // blanket final middleware and came back 500 "Internal server error". This is also the
  // tightest cap in the app, which is why the MulterError handlers are per-route: a single
  // global one quoting the attachment surface's 25/50MB would tell an admin their 3MB logo
  // was acceptable in the same breath as refusing it.
  it('rejects a logo over 2MB with 413 naming the real 2MB cap, never a raw 500', async () => {
    const oversized = Buffer.alloc(2 * 1024 * 1024 + 1);
    PNG_BYTES.copy(oversized);

    const res = await request(app)
      .post('/api/organization/logo')
      .set(authHeader('admin'))
      .attach('file', oversized, { filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(413);
    expect(res.status).not.toBe(500);
    expect(res.body.error).toBeTypeOf('string');
    expect(res.body.error).not.toContain('Internal server error');
    expect(res.body.error).toContain('2MB');
    // No other surface's cap may leak into this route's message.
    expect(res.body.error).not.toContain('50MB');
    expect(res.body.error).not.toContain('25MB');
    expect(res.body.error).not.toContain('8MB');
  });

  it('returns 403 for non-admin (SALES)', async () => {
    mockAuthAs('sales');
    const res = await request(app)
      .post('/api/organization/logo')
      .set(authHeader('sales'))
      .attach('file', PNG_BYTES, { filename: 'logo.png', contentType: 'image/png' });

    expect(res.status).toBe(403);
  });
});

describe('PATCH /api/organization — customer numbering after first issue', () => {
  const LOCKED_ORG = { ...MOCK_ORG, customer_first_issued_at: new Date('2026-01-01T00:00:00Z') };

  beforeEach(() => {
    mockAuthAs('admin');
    (prisma.$transaction as any).mockImplementation((fn: any) => fn(prisma));
    (prisma.$executeRaw as any).mockResolvedValue(0);
    // Highest already-issued customer number = 50, for the collision guard.
    (prisma.$queryRaw as any).mockResolvedValue([{ max_num: 50 }]);
    (prisma.organization as any).update = vi.fn().mockImplementation(({ data }: any) =>
      Promise.resolve({ ...MOCK_ORG, ...data })
    );
  });

  it('allows changing customer_prefix after first customer was issued (applies to future numbers)', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue(LOCKED_ORG);

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ customer_prefix: 'CUST' });

    expect(res.status).toBe(200);
  });

  it('allows raising customer_next_number after first customer was issued (the next customer uses it)', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue(LOCKED_ORG);

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ customer_next_number: 999 }); // > current max (50)

    expect(res.status).toBe(200);
  });

  it('returns 400 when customer_next_number is not greater than the highest issued number', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue(LOCKED_ORG);

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ customer_next_number: 40 }); // <= current max (50) ⇒ would duplicate

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be lower than/i);
  });

  it('allows raising service_plan_next_number above the highest issued number', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue({ ...LOCKED_ORG, service_plan_prefix: 'SP' });

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ service_plan_next_number: 999 }); // > current max (50)

    expect(res.status).toBe(200);
  });

  it('returns 400 when service_plan_next_number is not greater than the highest issued number', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue({ ...LOCKED_ORG, service_plan_prefix: 'SP' });

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ service_plan_next_number: 40 }); // <= current max (50) ⇒ would duplicate

    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/cannot be lower than/i);
  });

  it('allows patching customer_prefix when no customer has been issued yet', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue(MOCK_ORG); // customer_first_issued_at: null

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ customer_prefix: 'CUST' });

    expect(res.status).toBe(200);
  });

  it('allows patching other fields when customer_first_issued_at is set', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue(LOCKED_ORG);

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ name: 'New Org Name' });

    expect(res.status).toBe(200);
  });
});

describe('PATCH /api/organization — deposit default (#61)', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    (prisma.$transaction as any).mockImplementation((fn: any) => fn(prisma));
    (prisma.$executeRaw as any).mockResolvedValue(0);
    (prisma.organization as any).findUnique = vi.fn().mockResolvedValue(MOCK_ORG);
    (prisma.organization as any).update = vi.fn().mockImplementation(({ data }: any) =>
      Promise.resolve({ ...MOCK_ORG, ...data })
    );
  });

  it('accepts FIXED deposit_default_type with a valid deposit_default_fixed_amount', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ deposit_default_type: 'FIXED', deposit_default_fixed_amount: 500 });

    expect(res.status).toBe(200);
    const updateArgs = (prisma.organization.update as any).mock.calls[0][0];
    expect(updateArgs.data.deposit_default_type).toBe('FIXED');
    expect(updateArgs.data.deposit_default_fixed_amount).toBe(500);
  });

  it('accepts PERCENTAGE deposit_default_type with a valid deposit_default_percentage', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 40 });

    expect(res.status).toBe(200);
    const updateArgs = (prisma.organization.update as any).mock.calls[0][0];
    expect(updateArgs.data.deposit_default_type).toBe('PERCENTAGE');
    expect(updateArgs.data.deposit_default_percentage).toBe(40);
  });

  // §A3a — org-level lock_on_send toggle for the estimate workspace redesign, default OFF.
  it('accepts lock_on_send toggle', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ lock_on_send: true });

    expect(res.status).toBe(200);
    const updateArgs = (prisma.organization.update as any).mock.calls[0][0];
    expect(updateArgs.data.lock_on_send).toBe(true);
  });

  it('returns 400 when deposit_default_percentage exceeds 100', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ deposit_default_percentage: 150 });

    expect(res.status).toBe(400);
  });

  it('returns 400 when deposit_default_fixed_amount is negative', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ deposit_default_fixed_amount: -1 });

    expect(res.status).toBe(400);
  });

  it('GET /api/organization surfaces the three deposit default fields', async () => {
    const orgWithDeposit = {
      ...MOCK_ORG,
      deposit_default_type: 'PERCENTAGE',
      deposit_default_percentage: 50,
      deposit_default_fixed_amount: 0,
    };
    (prisma.organization.findUnique as any).mockResolvedValue(orgWithDeposit);

    const res = await request(app)
      .get('/api/organization')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.deposit_default_type).toBe('PERCENTAGE');
    expect(res.body.deposit_default_percentage).toBe(50);
    expect(res.body.deposit_default_fixed_amount).toBe(0);
  });
});

describe('GET /api/organization/preview-pdf', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    (prisma.organization.findUnique as any).mockResolvedValue(MOCK_ORG);
  });

  it('returns PDF with application/pdf content-type for ADMIN', async () => {
    const res = await request(app)
      .get('/api/organization/preview-pdf')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });

  it('returns 401 unauthenticated', async () => {
    const res = await request(app).get('/api/organization/preview-pdf');
    expect(res.status).toBe(401);
  });

  it('allows read-level roles (SALES) to preview — page is reachable at read', async () => {
    // #110: the Branding page renders at `read Organization`; the preview guard
    // must match, not require `update`, or read-only users get a silent 403.
    mockAuthAs('sales');
    const res = await request(app)
      .get('/api/organization/preview-pdf')
      .set(authHeader('sales'));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
  });

  it('returns 404 when no org configured', async () => {
    (prisma.organization.findUnique as any).mockResolvedValue(null);

    const res = await request(app)
      .get('/api/organization/preview-pdf')
      .set(authHeader('admin'));

    expect(res.status).toBe(404);
    expect(res.body.error).toBe('Organization not configured');
  });

  it('previews a not-yet-saved brand color from the ?color query param', async () => {
    const res = await request(app)
      .get('/api/organization/preview-pdf?color=%23123ABC')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    // the org passed to the renderer carries the previewed color, not the saved one
    expect((generateEstimatePdf as any).mock.calls.at(-1)[1]).toMatchObject({ brand_color: '#123ABC' });
  });

  it('ignores an invalid ?color and falls back to the saved brand color', async () => {
    const res = await request(app)
      .get('/api/organization/preview-pdf?color=notacolor')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect((generateEstimatePdf as any).mock.calls.at(-1)[1]).toMatchObject({ brand_color: MOCK_ORG.brand_color });
  });

  // Mocks aren't cleared between tests in this file, so assert on the DELTA from each
  // function's own call count rather than toHaveBeenCalled() (always true once any earlier
  // test in this describe block has called it).
  it('defaults to the estimate document when ?doc is omitted', async () => {
    const estimateCallsBefore = (generateEstimatePdf as any).mock.calls.length;
    const invoiceCallsBefore = (generateInvoicePdf as any).mock.calls.length;

    const res = await request(app)
      .get('/api/organization/preview-pdf')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect((generateEstimatePdf as any).mock.calls.length).toBe(estimateCallsBefore + 1);
    expect((generateInvoicePdf as any).mock.calls.length).toBe(invoiceCallsBefore);
  });

  it('renders the invoice document when ?doc=invoice', async () => {
    const estimateCallsBefore = (generateEstimatePdf as any).mock.calls.length;
    const invoiceCallsBefore = (generateInvoicePdf as any).mock.calls.length;

    const res = await request(app)
      .get('/api/organization/preview-pdf?doc=invoice')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toMatch(/application\/pdf/);
    expect((generateInvoicePdf as any).mock.calls.length).toBe(invoiceCallsBefore + 1);
    expect((generateEstimatePdf as any).mock.calls.length).toBe(estimateCallsBefore);
  });

  it('falls back to the estimate document for an invalid ?doc value', async () => {
    const estimateCallsBefore = (generateEstimatePdf as any).mock.calls.length;
    const invoiceCallsBefore = (generateInvoicePdf as any).mock.calls.length;

    const res = await request(app)
      .get('/api/organization/preview-pdf?doc=bogus')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect((generateEstimatePdf as any).mock.calls.length).toBe(estimateCallsBefore + 1);
    expect((generateInvoicePdf as any).mock.calls.length).toBe(invoiceCallsBefore);
  });
});

// R1 (2026-07-21) — every authenticated role (Sales/Dispatcher/Technician, not just Admin) can
// call GET /api/organization, so a bare findUnique with no `select` ships the WHOLE Organization
// row to everyone. R3 then added `labor_rate`/`overhead_mode`/`overhead_value` as plain columns on
// this same model, merged into the select ONLY for a requester who can see pricing (`read
// Invoice`) — ADMIN always can, so its select below is the scalar select PLUS the cost select (see
// the R3 describe block below for the non-privileged-viewer case). These tests pin the explicit
// select in place so a future bare findUnique/update can't silently reopen the leak.
describe('GET/PATCH /api/organization — cost-leak guard (R1)', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    (prisma.organization.findUnique as any).mockResolvedValue(MOCK_ORG);
    (prisma.$transaction as any).mockImplementation((fn: any) => fn(prisma));
    (prisma.$executeRaw as any).mockResolvedValue(0);
    (prisma.organization as any).update = vi.fn().mockImplementation(({ data }: any) =>
      Promise.resolve({ ...MOCK_ORG, ...data })
    );
  });

  it('GET passes an explicit select to findUnique, not a bare unrestricted query', async () => {
    const res = await request(app)
      .get('/api/organization')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    const call = (prisma.organization.findUnique as any).mock.calls[0][0];
    expect(call.select).toBeDefined();
    expect(call.select).toEqual({ ...organizationScalarSelect, ...organizationCostSelect });
  });

  it('PATCH passes an explicit select to the persisted update, not a bare unrestricted query', async () => {
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ name: 'Renamed Co' });

    expect(res.status).toBe(200);
    const call = (prisma.organization.update as any).mock.calls[0][0];
    expect(call.select).toBeDefined();
    expect(call.select).toEqual({ ...organizationScalarSelect, ...organizationCostSelect });
  });

  it('the shared scalar select allowlist itself never includes the staff-only cost/margin fields', () => {
    // labor_rate/overhead_mode/overhead_value are R3's Organization columns, kept in the SEPARATE
    // organizationCostSelect (merged in only for canSeePricing) — this test fails loudly if a
    // future edit folds them into the base scalar select everyone gets by default.
    expect(organizationScalarSelect).not.toHaveProperty('labor_rate');
    expect(organizationScalarSelect).not.toHaveProperty('overhead_mode');
    expect(organizationScalarSelect).not.toHaveProperty('overhead_value');
  });
});

// R3 (2026-07-21) — cost model (D2/D8). labor_rate/overhead_mode/overhead_value now exist as real
// Organization columns, merged into the select ONLY for a requester who can see pricing
// (canSeePricing = read Invoice). TECHNICIAN can read Organization by default but has no Invoice
// grant, so it's the real, reachable "reads the org but can't see cost" case (no override hack
// needed) — unlike the Estimate write-guard, which every default updater already passes.
describe('GET/PATCH /api/organization — cost model fields (R3)', () => {
  beforeEach(() => {
    (prisma.organization.findUnique as any).mockResolvedValue({
      ...MOCK_ORG,
      labor_rate: 75,
      overhead_mode: 'PERCENTAGE',
      overhead_value: 15,
    });
  });

  it('GET includes labor_rate/overhead_mode/overhead_value for ADMIN (can see pricing)', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .get('/api/organization')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.labor_rate).toBe(75);
    expect(res.body.overhead_mode).toBe('PERCENTAGE');
    expect(res.body.overhead_value).toBe(15);
    const call = (prisma.organization.findUnique as any).mock.calls.at(-1)[0];
    expect(call.select).toEqual({ ...organizationScalarSelect, ...organizationCostSelect });
  });

  it('GET requests only organizationScalarSelect for TECHNICIAN (cannot see pricing)', async () => {
    mockAuthAs('technician');
    mockRoleGrantsWithout('TECHNICIAN', ['read', 'Pricing']);  // price-blind on purpose: read Pricing is a TECHNICIAN default since the ownership spec
    // Mirrors real Prisma projection: a select without the cost keys returns a row without them.
    (prisma.organization.findUnique as any).mockResolvedValue({ ...MOCK_ORG });

    const res = await request(app)
      .get('/api/organization')
      .set(authHeader('technician'));

    expect(res.status).toBe(200);
    expect(res.body).not.toHaveProperty('labor_rate');
    expect(res.body).not.toHaveProperty('overhead_mode');
    expect(res.body).not.toHaveProperty('overhead_value');
    const call = (prisma.organization.findUnique as any).mock.calls.at(-1)[0];
    expect(call.select).toEqual(organizationScalarSelect);
  });

  it('PATCH persists labor_rate/overhead_mode/overhead_value for ADMIN', async () => {
    mockAuthAs('admin');
    (prisma.$transaction as any).mockImplementation((fn: any) => fn(prisma));
    (prisma.$executeRaw as any).mockResolvedValue(0);
    (prisma.organization as any).update = vi.fn().mockImplementation(({ data }: any) =>
      Promise.resolve({ ...MOCK_ORG, ...data, labor_rate: 90, overhead_mode: 'FIXED', overhead_value: 250 })
    );

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ labor_rate: 90, overhead_mode: 'FIXED', overhead_value: 250 });

    expect(res.status).toBe(200);
    const call = (prisma.organization.update as any).mock.calls[0][0];
    expect(call.data.labor_rate).toBe(90);
    expect(call.data.overhead_mode).toBe('FIXED');
    expect(call.data.overhead_value).toBe(250);
    expect(call.select).toEqual({ ...organizationScalarSelect, ...organizationCostSelect });
  });

  it('returns 400 when overhead_value is negative', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ overhead_value: -5 });

    expect(res.status).toBe(400);
  });

  it('returns 400 for an invalid overhead_mode', async () => {
    mockAuthAs('admin');

    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ overhead_mode: 'BOGUS' });

    expect(res.status).toBe(400);
  });
});

// Ran: "the account ID cannot be exposed". GET/PATCH /api/organization reach
// every role's browser, so the phone account id never leaves the server. The
// page reads `phone_connected`. The old `ctm_account_id` key stays for one
// ship as a bare true/null, so a frontend still on the old bundle (a stale
// service worker) that does Boolean(ctm_account_id) keeps working.
describe('GET/PATCH /api/organization - the phone account id never leaves the server', () => {
  const ACCOUNT_ID = '111111';

  beforeEach(() => {
    mockAuthAs('admin');
    (prisma.$transaction as any).mockImplementation((fn: any) => fn(prisma));
    (prisma.$executeRaw as any).mockResolvedValue(0);
  });

  const connected = (ctm_account_id: string | null) => ({ ...MOCK_ORG, ctm_account_id, ctm_sms_ready: true });

  async function get(ctm_account_id: string | null) {
    (prisma.organization.findUnique as any).mockResolvedValue(connected(ctm_account_id));
    return request(app).get('/api/organization').set(authHeader('admin'));
  }

  async function patch(ctm_account_id: string | null) {
    (prisma.organization.findUnique as any).mockResolvedValue(connected(ctm_account_id));
    (prisma.organization as any).update = vi.fn().mockImplementation(({ data }: any) =>
      Promise.resolve({ ...connected(ctm_account_id), ...data }),
    );
    return request(app).patch('/api/organization').set(authHeader('admin')).send({ name: 'Renamed Co' });
  }

  it.each([
    ['GET', get],
    ['PATCH', patch],
  ] as const)('%s of a connected org says phone_connected: true and carries no account id', async (_m, call) => {
    const res = await call(ACCOUNT_ID);

    expect(res.status).toBe(200);
    expect(res.body.phone_connected).toBe(true);
    expect(JSON.stringify(res.body)).not.toContain(ACCOUNT_ID);
    // The old key, for one ship: truthy for an old bundle, never the id.
    expect(res.body.ctm_account_id).toBe(true);
  });

  it.each([
    ['GET', get],
    ['PATCH', patch],
  ] as const)('%s of an org with no phone account says phone_connected: false', async (_m, call) => {
    const res = await call(null);

    expect(res.status).toBe(200);
    expect(res.body.phone_connected).toBe(false);
    expect(res.body.ctm_account_id).toBeNull();
  });
});

// The texting-approval flag reaches the browser under ServWave's own name,
// `sms_ready`. `ctm_sms_ready` stays one release with the same value so a
// browser still on an old bundle keeps gating the composer correctly.
describe('GET/PATCH /api/organization - the texting flag travels under a neutral key', () => {
  beforeEach(() => {
    mockAuthAs('admin');
    (prisma.$transaction as any).mockImplementation((fn: any) => fn(prisma));
    (prisma.$executeRaw as any).mockResolvedValue(0);
  });

  const org = (ctm_sms_ready: boolean) => ({ ...MOCK_ORG, ctm_account_id: '111111', ctm_sms_ready });

  async function get(ready: boolean) {
    (prisma.organization.findUnique as any).mockResolvedValue(org(ready));
    return request(app).get('/api/organization').set(authHeader('admin'));
  }

  async function patch(ready: boolean) {
    (prisma.organization.findUnique as any).mockResolvedValue(org(ready));
    (prisma.organization as any).update = vi.fn().mockImplementation(({ data }: any) =>
      Promise.resolve({ ...org(ready), ...data }),
    );
    return request(app).patch('/api/organization').set(authHeader('admin')).send({ name: 'Renamed Co' });
  }

  it.each([
    ['GET', get],
    ['PATCH', patch],
  ] as const)('%s sends sms_ready, mirrored by the deprecated ctm_sms_ready', async (_m, call) => {
    for (const ready of [true, false]) {
      const res = await call(ready);
      expect(res.status).toBe(200);
      expect(res.body.sms_ready).toBe(ready);
      // TODO(phone-api-neutral-names): drop with the alias.
      expect(res.body.ctm_sms_ready).toBe(ready);
    }
  });
});
