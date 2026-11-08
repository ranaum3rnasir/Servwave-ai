import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { sendEstimateEmail } from '../lib/email';
import { mockAuthAs, authHeader, ESTIMATE_FIXTURE, ALPHA_ORG_ID } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// '../lib/email' is globally mocked in setup.ts (Step 1 made its default {status:'sent'});
// grab the same mock instance the controller sees and override it per test — same
// pattern as backend/src/__tests__/users.test.ts's mockSendInvite.
const mockPrisma = prisma as any;
const mockSend = sendEstimateEmail as Mock;
const ESTIMATE_ID = ESTIMATE_FIXTURE.id;

// A DRAFT estimate with a customer that HAS an email, no deposit required.
const DRAFT = {
  id: ESTIMATE_ID,
  status: 'DRAFT',
  estimate_number: ESTIMATE_FIXTURE.estimate_number,
  total_amount: 1000,
  public_token: null,
  send_config: null,
  organization_id: ALPHA_ORG_ID,
  // SERV10X-61 §5.6 - send() now refuses a zero-line-item estimate; a sendable fixture needs _count.
  _count: { line_items: 2 },
  lead: { id: ESTIMATE_FIXTURE.lead_id, status: 'NEW', customer: { id: 'cust-1', first_name: 'Jane', last_name: 'Doe', company_name: null, email: 'jane@example.com' } },
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.rolePermission.findMany.mockImplementation((a: any) =>
    Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === a.where.role)));
  mockPrisma.estimate.findUnique.mockResolvedValue(DRAFT);
  mockPrisma.estimate.findFirst.mockResolvedValue({ id: ESTIMATE_ID });
  mockPrisma.organization.findUnique.mockResolvedValue({
    id: ALPHA_ORG_ID, name: 'Org', logo_url: null, brand_color: '#000',
    estimate_terms: 'T', estimate_notes: 'N', estimate_payment_terms: 'P',
    deposit_default_type: 'PERCENTAGE', deposit_default_percentage: 50, deposit_default_fixed_amount: null,
  });
  // PREP is a plain update (no $transaction) — Step 4 mocks it directly.
  mockPrisma.estimate.update.mockResolvedValue({});
  // COMMIT is the only $transaction call in the whole handler after this task.
  mockPrisma.$transaction.mockImplementation(async (fn: any) => fn({
    estimate: { update: vi.fn().mockResolvedValue({ ...DRAFT, status: 'SENT', public_token: 'tok', invoices: [], send_config: null, lead: DRAFT.lead }), findUnique: vi.fn().mockResolvedValue(null) },
    estimateSendConfig: { upsert: vi.fn().mockResolvedValue({}) },
    invoice: { findFirst: vi.fn().mockResolvedValue(null), create: vi.fn().mockResolvedValue({}), update: vi.fn().mockResolvedValue({}) },
    timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    lead: { update: vi.fn().mockResolvedValue({}) },
  }));
});

function send() {
  return request(app).post(`/api/estimates/${ESTIMATE_ID}/send`).set(authHeader('admin'))
    .send({ deposit_required: false, payment_methods: [], message_body: 'hi' });
}

describe('estimate send reliability', () => {
  it('returns 502, does NOT call $transaction (no commit), when the email fails', async () => {
    mockSend.mockResolvedValue({ status: 'failed', error: 'domain not verified' });
    const res = await send();
    expect(res.status).toBe(502);
    expect(res.body.error).toMatch(/not.*(sent|emailed)/i);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 422 and never calls the sender when the customer has no email', async () => {
    mockPrisma.estimate.findUnique.mockResolvedValue({ ...DRAFT, lead: { ...DRAFT.lead, customer: { ...DRAFT.lead.customer, email: null } } });
    const res = await send();
    expect(res.status).toBe(422);
    expect(mockSend).not.toHaveBeenCalled();
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns 200 and calls $transaction exactly once (commits SENT) when the email is sent', async () => {
    mockSend.mockResolvedValue({ status: 'sent' });
    const res = await send();
    expect(res.status).toBe(200);
    expect(mockSend).toHaveBeenCalledTimes(1);
    expect(mockPrisma.$transaction).toHaveBeenCalledTimes(1);
  });

  it('returns 409, does NOT call $transaction, when org email sending is disabled', async () => {
    mockSend.mockResolvedValue({ status: 'skipped', reason: 'org_disabled' });
    const res = await send();
    expect(res.status).toBe(409);
    expect(res.body.error).toMatch(/disabled/i);
    expect(mockPrisma.$transaction).not.toHaveBeenCalled();
  });
});
