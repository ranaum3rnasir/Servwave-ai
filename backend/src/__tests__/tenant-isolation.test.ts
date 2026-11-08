import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import {
  mockAuthAs, authHeader,
  ALPHA_ORG_ID, ORG_B_ID,
  CUSTOMER_FIXTURE, LEAD_FIXTURE, ESTIMATE_FIXTURE, JOB_FIXTURE, INVOICE_FIXTURE,
} from './helpers';

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  // Phase 4a: lead create now resolves a ServiceLocation from the legacy address.
  // Default the accretion mocks so the legacy-address create path doesn't throw.
  (prisma.serviceLocation.findFirst as Mock).mockResolvedValue(null);
  (prisma.serviceLocation.create as Mock).mockResolvedValue({ id: 'iso-loc-id' });
});

function expectOrgScoped(mockFn: Mock, orgId: string) {
  expect(mockFn).toHaveBeenCalledWith(
    expect.objectContaining({ where: expect.objectContaining({ organization_id: orgId }) })
  );
}
function expectCreateOrgScoped(mockFn: Mock, orgId: string) {
  expect(mockFn).toHaveBeenCalledWith(
    expect.objectContaining({ data: expect.objectContaining({ organization_id: orgId }) })
  );
}

// ── CUSTOMERS ───────────────────────────────────────────
describe('Tenant isolation — customers', () => {
  it('list scoped to org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.customer.findMany as Mock).mockResolvedValue([]);
    (prisma.customer.count as Mock).mockResolvedValue(0);
    await request(app).get('/api/customers').set(authHeader('orgB_admin'));
    expectOrgScoped(prisma.customer.findMany as Mock, ORG_B_ID);
  });
  it('get returns 404 cross-org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.customer.findUnique as Mock).mockResolvedValue(null);
    const res = await request(app).get(`/api/customers/${CUSTOMER_FIXTURE.id}`).set(authHeader('orgB_admin'));
    expect(res.status).toBe(404);
    expectOrgScoped(prisma.customer.findUnique as Mock, ORG_B_ID);
  });
  it('create assigns requesting org', async () => {
    mockAuthAs('orgB_admin');
    const txCreate = vi.fn().mockResolvedValue({ ...CUSTOMER_FIXTURE, organization_id: ORG_B_ID, extra_emails: [], service_locations: [] });
    (prisma.$transaction as Mock).mockImplementation((fn: any) => fn({ customer: { create: txCreate } }));
    await request(app).post('/api/customers').set(authHeader('orgB_admin')).send({
      first_name: 'Jane', last_name: 'Doe', email: 'jane@orgb.com', phone: '5559999999',
    });
    expectCreateOrgScoped(txCreate, ORG_B_ID);
  });
});

// ── LEADS ───────────────────────────────────────────────
describe('Tenant isolation — leads', () => {
  it('list scoped to org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.lead.findMany as Mock).mockResolvedValue([]);
    (prisma.lead.count as Mock).mockResolvedValue(0);
    await request(app).get('/api/leads').set(authHeader('orgB_admin'));
    expectOrgScoped(prisma.lead.findMany as Mock, ORG_B_ID);
  });
  it('get returns 404 cross-org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.lead.findUnique as Mock).mockResolvedValue(null);
    const res = await request(app).get(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('orgB_admin'));
    expect(res.status).toBe(404);
    expectOrgScoped(prisma.lead.findUnique as Mock, ORG_B_ID);
  });
  it('create assigns requesting org (existing customer path)', async () => {
    mockAuthAs('orgB_admin');
    (prisma.customer.findUnique as Mock).mockResolvedValue({ ...CUSTOMER_FIXTURE, organization_id: ORG_B_ID });
    (prisma.lead.findFirst as Mock).mockResolvedValue(null);   // generateLeadNumber lookup
    (prisma.lead.create as Mock).mockResolvedValue({ ...LEAD_FIXTURE, organization_id: ORG_B_ID });
    (prisma.$transaction as Mock).mockImplementation(async (cb: any) => cb(prisma));
    await request(app).post('/api/leads').set(authHeader('orgB_admin')).send({
      customer_id: CUSTOMER_FIXTURE.id, service_request: 'Test',
      service_address_line1: '1 Test St', service_city: 'Austin', service_state: 'TX', service_zip: '78701',
    });
    expectCreateOrgScoped(prisma.lead.create as Mock, ORG_B_ID);
  });
});

// ── ESTIMATES ───────────────────────────────────────────
describe('Tenant isolation — estimates', () => {
  it('list scoped to org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.estimate.findMany as Mock).mockResolvedValue([]);
    (prisma.estimate.count as Mock).mockResolvedValue(0);
    await request(app).get('/api/estimates').set(authHeader('orgB_admin'));
    expectOrgScoped(prisma.estimate.findMany as Mock, ORG_B_ID);
  });
  it('get returns 404 cross-org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.estimate.findUnique as Mock).mockResolvedValue(null);
    const res = await request(app).get(`/api/estimates/${ESTIMATE_FIXTURE.id}`).set(authHeader('orgB_admin'));
    expect(res.status).toBe(404);
    expectOrgScoped(prisma.estimate.findUnique as Mock, ORG_B_ID);
  });
  it('create scoped to org (lead lookup must be org-scoped)', async () => {
    mockAuthAs('orgB_admin');
    (prisma.lead.findUnique as Mock).mockResolvedValue(null);  // cross-org lead → 404
    await request(app).post('/api/estimates').set(authHeader('orgB_admin')).send({
      lead_id: LEAD_FIXTURE.id,
      line_items: [{ description: 'Test', quantity: 1, unit_price: 100, is_taxable: true, item_type: 'SERVICE' }],
    });
    expectOrgScoped(prisma.lead.findUnique as Mock, ORG_B_ID);
  });
  it('action endpoint (send) returns 404 cross-org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.estimate.findUnique as Mock).mockResolvedValue(null);
    const res = await request(app).post(`/api/estimates/${ESTIMATE_FIXTURE.id}/send`).set(authHeader('orgB_admin')).send({
      deposit_required: false, payment_methods: ['CASH'],
    });
    expect([403, 404]).toContain(res.status);
    expectOrgScoped(prisma.estimate.findUnique as Mock, ORG_B_ID);
  });
});

// ── JOBS ────────────────────────────────────────────────
describe('Tenant isolation — jobs', () => {
  it('list scoped to org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.findMany as Mock).mockResolvedValue([]);
    (prisma.job.count as Mock).mockResolvedValue(0);
    await request(app).get('/api/jobs').set(authHeader('orgB_admin'));
    expectOrgScoped(prisma.job.findMany as Mock, ORG_B_ID);
  });
  it('get returns 404 cross-org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.findUnique as Mock).mockResolvedValue(null);
    const res = await request(app).get(`/api/jobs/${JOB_FIXTURE.id}`).set(authHeader('orgB_admin'));
    expect(res.status).toBe(404);
    expectOrgScoped(prisma.job.findUnique as Mock, ORG_B_ID);
  });
  it('action endpoint (assign) returns 404 cross-org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.findUnique as Mock).mockResolvedValue(null);
    const res = await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/assign`).set(authHeader('orgB_admin')).send({ assignee_ids: ['00000000-0000-0000-0000-000000000004'] });
    expect([403, 404]).toContain(res.status);
    expectOrgScoped(prisma.job.findUnique as Mock, ORG_B_ID);
  });
  it('action endpoint (complete) returns 404 cross-org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.findUnique as Mock).mockResolvedValue(null);
    const res = await request(app).post(`/api/jobs/${JOB_FIXTURE.id}/complete`).set(authHeader('orgB_admin')).send({});
    expect([403, 404]).toContain(res.status);
    expectOrgScoped(prisma.job.findUnique as Mock, ORG_B_ID);
  });
});

// ── INVOICES ────────────────────────────────────────────
describe('Tenant isolation — invoices', () => {
  it('list scoped to org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.invoice.findMany as Mock).mockResolvedValue([]);
    (prisma.invoice.count as Mock).mockResolvedValue(0);
    await request(app).get('/api/invoices').set(authHeader('orgB_admin'));
    expectOrgScoped(prisma.invoice.findMany as Mock, ORG_B_ID);
  });
  it('get returns 404 cross-org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.invoice.findUnique as Mock).mockResolvedValue(null);
    const res = await request(app).get(`/api/invoices/${INVOICE_FIXTURE.id}`).set(authHeader('orgB_admin'));
    expect(res.status).toBe(404);
    expectOrgScoped(prisma.invoice.findUnique as Mock, ORG_B_ID);
  });
  it('recordPayment returns 404 cross-org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.invoice.findUnique as Mock).mockResolvedValue(null);
    const res = await request(app).post(`/api/invoices/${INVOICE_FIXTURE.id}/payments`).set(authHeader('orgB_admin')).send({ amount: 100, method: 'CASH' });
    expect([403, 404]).toContain(res.status);
    expectOrgScoped(prisma.invoice.findUnique as Mock, ORG_B_ID);
  });
});

// ── USERS ───────────────────────────────────────────────
describe('Tenant isolation — users', () => {
  it('list scoped to org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.user.findMany as Mock).mockResolvedValue([]);
    await request(app).get('/api/users').set(authHeader('orgB_admin'));
    expectOrgScoped(prisma.user.findMany as Mock, ORG_B_ID);
  });
});

// ── ATTACHMENTS ─────────────────────────────────────────
describe('Tenant isolation — attachments', () => {
  it('listAttachments rejects cross-org parent (403/404)', async () => {
    mockAuthAs('orgB_admin');
    (prisma.lead.findUnique as Mock).mockResolvedValue(null);
    const res = await request(app).get(`/api/attachments/LEAD/${LEAD_FIXTURE.id}`).set(authHeader('orgB_admin'));
    expect([403, 404]).toContain(res.status);
    expectOrgScoped(prisma.lead.findUnique as Mock, ORG_B_ID);
  });
});

// ── SEARCH ──────────────────────────────────────────────
describe('Tenant isolation — search', () => {
  it('all entity queries include organization_id', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.findMany as Mock).mockResolvedValue([]);
    (prisma.customer.findMany as Mock).mockResolvedValue([]);
    (prisma.lead.findMany as Mock).mockResolvedValue([]);
    (prisma.estimate.findMany as Mock).mockResolvedValue([]);
    (prisma.invoice.findMany as Mock).mockResolvedValue([]);
    await request(app).get('/api/search?q=test').set(authHeader('orgB_admin'));
    expectOrgScoped(prisma.job.findMany as Mock, ORG_B_ID);
    expectOrgScoped(prisma.customer.findMany as Mock, ORG_B_ID);
    expectOrgScoped(prisma.lead.findMany as Mock, ORG_B_ID);
    expectOrgScoped(prisma.estimate.findMany as Mock, ORG_B_ID);
    expectOrgScoped(prisma.invoice.findMany as Mock, ORG_B_ID);
  });
});

// ── DASHBOARD ───────────────────────────────────────────
describe('Tenant isolation — dashboard', () => {
  it('jobs today groupBy is scoped to org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.groupBy as Mock).mockResolvedValue([]);
    (prisma.job.count as Mock).mockResolvedValue(0);
    (prisma.invoice.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.payment.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.appSetting.findUnique as Mock).mockResolvedValue(null);
    (prisma.invoice.findMany as Mock).mockResolvedValue([]);
    (prisma.lead.findMany as Mock).mockResolvedValue([]);
    (prisma.lead.groupBy as Mock).mockResolvedValue([]);
    (prisma.lead.count as Mock).mockResolvedValue(0);
    (prisma.estimate.findMany as Mock).mockResolvedValue([]);
    (prisma.job.findMany as Mock).mockResolvedValue([]);
    (prisma.timelineEvent.findMany as Mock).mockResolvedValue([]);
    (prisma.$queryRaw as Mock).mockResolvedValue([]);
    await request(app).get('/api/dashboard').set(authHeader('orgB_admin'));
    expectOrgScoped(prisma.job.groupBy as Mock, ORG_B_ID);
  });
});

// ── TIMELINE EVENTS ─────────────────────────────────────
describe('Tenant isolation — timeline events', () => {
  it('dashboard activity feed scoped to org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.groupBy as Mock).mockResolvedValue([]);
    (prisma.job.count as Mock).mockResolvedValue(0);
    (prisma.invoice.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.payment.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.appSetting.findUnique as Mock).mockResolvedValue(null);
    (prisma.invoice.findMany as Mock).mockResolvedValue([]);
    (prisma.lead.findMany as Mock).mockResolvedValue([]);
    (prisma.lead.groupBy as Mock).mockResolvedValue([]);
    (prisma.lead.count as Mock).mockResolvedValue(0);
    (prisma.estimate.findMany as Mock).mockResolvedValue([]);
    (prisma.job.findMany as Mock).mockResolvedValue([]);
    (prisma.timelineEvent.findMany as Mock).mockResolvedValue([]);
    (prisma.$queryRaw as Mock).mockResolvedValue([]);
    await request(app).get('/api/dashboard').set(authHeader('orgB_admin'));
    expectOrgScoped(prisma.timelineEvent.findMany as Mock, ORG_B_ID);
  });
  it('job timeline list rejected when parent job is cross-org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.findUnique as Mock).mockResolvedValue(null);
    const res = await request(app).get(`/api/jobs/${JOB_FIXTURE.id}/timeline`).set(authHeader('orgB_admin'));
    expect([403, 404]).toContain(res.status);
    expectOrgScoped(prisma.job.findUnique as Mock, ORG_B_ID);
  });
});

// ── APP SETTINGS ────────────────────────────────────────
describe('Tenant isolation — app settings', () => {
  it('GET /api/settings/:key uses composite key with requesting org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.appSetting.findUnique as Mock).mockResolvedValue(null);
    await request(app).get('/api/settings/company_name').set(authHeader('orgB_admin'));
    expect(prisma.appSetting.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organization_id_key: expect.objectContaining({ organization_id: ORG_B_ID, key: 'company_name' }),
        }),
      }),
    );
  });
  it('PATCH /api/settings/:key upserts under requesting org', async () => {
    mockAuthAs('orgB_admin');
    (prisma.appSetting.upsert as Mock).mockResolvedValue({ organization_id: ORG_B_ID, key: 'company_name', value: 'Lakeside', updated_at: new Date() });
    await request(app).patch('/api/settings/company_name').set(authHeader('orgB_admin')).send({ value: 'Lakeside' });
    expect(prisma.appSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organization_id_key: expect.objectContaining({ organization_id: ORG_B_ID, key: 'company_name' }),
        }),
        create: expect.objectContaining({ organization_id: ORG_B_ID, key: 'company_name' }),
      }),
    );
  });

  // Bug #7 — the owner-controlled `require_walkthrough_before_send` flag round-trips
  // through the generic settings surface (no special-casing needed; AppSetting CASL subject).
  it('require_walkthrough_before_send round-trips through GET/PATCH /api/settings/:key', async () => {
    mockAuthAs('orgB_admin');
    (prisma.appSetting.findUnique as Mock).mockResolvedValue({
      organization_id: ORG_B_ID, key: 'require_walkthrough_before_send', value: 'true', updated_at: new Date(),
    });
    const getRes = await request(app)
      .get('/api/settings/require_walkthrough_before_send')
      .set(authHeader('orgB_admin'));
    expect(getRes.status).toBe(200);
    expect(getRes.body.data.value).toBe('true');
    expect(prisma.appSetting.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organization_id_key: expect.objectContaining({ organization_id: ORG_B_ID, key: 'require_walkthrough_before_send' }),
        }),
      }),
    );

    (prisma.appSetting.upsert as Mock).mockResolvedValue({
      organization_id: ORG_B_ID, key: 'require_walkthrough_before_send', value: 'false', updated_at: new Date(),
    });
    const patchRes = await request(app)
      .patch('/api/settings/require_walkthrough_before_send')
      .set(authHeader('orgB_admin'))
      .send({ value: 'false' });
    expect(patchRes.status).toBe(200);
    expect(patchRes.body.data.value).toBe('false');
    expect(prisma.appSetting.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          organization_id_key: expect.objectContaining({ organization_id: ORG_B_ID, key: 'require_walkthrough_before_send' }),
        }),
        create: expect.objectContaining({ organization_id: ORG_B_ID, key: 'require_walkthrough_before_send', value: 'false' }),
      }),
    );
  });
});

// ── SMOKE: same-org access still works ──────────────────
describe('Tenant isolation — same-org access unbroken', () => {
  it('Org A admin can still retrieve own customer', async () => {
    mockAuthAs('admin');
    (prisma.customer.findUnique as Mock).mockResolvedValue({
      ...CUSTOMER_FIXTURE, organization_id: ALPHA_ORG_ID, extra_emails: [],
    });
    // customer.getById also calls $queryRaw for financial/estimate/deposit summaries
    (prisma.$queryRaw as Mock).mockResolvedValue([]);
    const res = await request(app).get(`/api/customers/${CUSTOMER_FIXTURE.id}`).set(authHeader('admin'));
    expect(res.status).toBe(200);
    expectOrgScoped(prisma.customer.findUnique as Mock, ALPHA_ORG_ID);
  });
});
