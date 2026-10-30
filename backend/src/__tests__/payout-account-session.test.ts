// Payments go-live slice 34 - the owner and viewer account sessions, minted server-side per request.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, mockRoleSwitches, authHeader, ALPHA_ORG_ID, ORG_B_ID } from './helpers';
import { createAccountSession } from '../lib/stripe';
import { enabledComponentsFor } from '../lib/account-session-surfaces';

const mockPrisma = prisma as unknown as {
  organization: { findUnique: ReturnType<typeof vi.fn> };
  termsAcceptance: { findFirst: ReturnType<typeof vi.fn> };
  auditLog: { create: ReturnType<typeof vi.fn> };
};
const mockCreateAccountSession = vi.mocked(createAccountSession);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  mockPrisma.auditLog.create.mockResolvedValue({});
  mockPrisma.termsAcceptance.findFirst.mockResolvedValue({ id: 'terms-1' });
  mockPrisma.organization.findUnique.mockResolvedValue({ stripe_account_id: 'acct_1' });
  mockCreateAccountSession.mockResolvedValue('cs_secret_abc');
});

describe('which embedded components each session surface enables', () => {
  it('owner enables exactly onboarding, account management and the notification banner', () => {
    expect(enabledComponentsFor('owner').sort()).toEqual(['account_management', 'account_onboarding', 'notification_banner']);
  });

  it('viewer enables exactly payments, payment details, the payouts list and details, documents and disputes', () => {
    expect(enabledComponentsFor('viewer').sort()).toEqual([
      'disputes_list', 'documents', 'payment_details', 'payment_disputes', 'payments', 'payout_details', 'payouts_list',
    ]);
  });

  it('never enables the balances or the full payouts component on either surface', () => {
    for (const surface of ['owner', 'viewer'] as const) {
      expect(enabledComponentsFor(surface)).not.toContain('balances');
      expect(enabledComponentsFor(surface)).not.toContain('payouts');
    }
  });
});

describe('POST /api/organization/stripe/account-session', () => {
  const post = (user: Parameters<typeof authHeader>[0], body: unknown) => {
    mockAuthAs(user);
    return request(app).post('/api/organization/stripe/account-session').set(authHeader(user)).send(body as object);
  };

  it('mints an owner session for an owner and returns only the client secret', async () => {
    const res = await post('admin', { surface: 'owner' });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ client_secret: 'cs_secret_abc' });
    expect(mockCreateAccountSession).toHaveBeenCalledWith('acct_1', 'owner');
  });

  it('mints a viewer session when the viewer surface is asked for', async () => {
    const res = await post('admin', { surface: 'viewer' });
    expect(res.status).toBe(200);
    expect(mockCreateAccountSession).toHaveBeenCalledWith('acct_1', 'viewer');
  });

  it('treats a request with no surface as the owner surface', async () => {
    await post('admin', {});
    expect(mockCreateAccountSession).toHaveBeenCalledWith('acct_1', 'owner');
  });

  it('refuses a surface it does not know', async () => {
    const res = await post('admin', { surface: 'balances' });
    expect(res.status).toBe(400);
    expect(mockCreateAccountSession).not.toHaveBeenCalled();
  });

  it.each(['sales', 'dispatcher', 'technician'] as const)('refuses the owner surface to a %s with 403 and mints nothing', async (user) => {
    const res = await post(user, { surface: 'owner' });
    expect(res.status).toBe(403);
    expect(mockCreateAccountSession).not.toHaveBeenCalled();
  });

  it.each(['sales', 'technician'] as const)('refuses the viewer surface to a %s too', async (user) => {
    const res = await post(user, { surface: 'viewer' });
    expect(res.status).toBe(403);
    expect(mockCreateAccountSession).not.toHaveBeenCalled();
  });

  it('lets a user holding View payments and payouts open the viewer surface but not the owner surface', async () => {
    mockAuthAs('sales');
    mockRoleSwitches({ view_payments: true });
    const viewer = await request(app).post('/api/organization/stripe/account-session').set(authHeader('sales')).send({ surface: 'viewer' });
    expect(viewer.status).toBe(200);
    expect(mockCreateAccountSession).toHaveBeenCalledWith('acct_1', 'viewer');
    mockCreateAccountSession.mockClear();
    const owner = await request(app).post('/api/organization/stripe/account-session').set(authHeader('sales')).send({ surface: 'owner' });
    expect(owner.status).toBe(403);
    expect(mockCreateAccountSession).not.toHaveBeenCalled();
  });

  it('does not let Manage payout account alone open the viewer surface: each surface has its own switch', async () => {
    mockAuthAs('sales');
    mockRoleSwitches({ manage_payout_account: true });
    const res = await request(app).post('/api/organization/stripe/account-session').set(authHeader('sales')).send({ surface: 'viewer' });
    expect(res.status).toBe(403);
    expect(mockCreateAccountSession).not.toHaveBeenCalled();
  });

  it('follows the Manage payout account switch, not the role name: a sales user holding it is let in', async () => {
    mockAuthAs('sales');
    mockRoleSwitches({ manage_payout_account: true });
    const res = await request(app).post('/api/organization/stripe/account-session').set(authHeader('sales')).send({ surface: 'owner' });
    expect(res.status).toBe(200);
    expect(mockCreateAccountSession).toHaveBeenCalledWith('acct_1', 'owner');
  });

  it('scopes the session to the caller\'s own organization', async () => {
    mockPrisma.organization.findUnique.mockImplementation(async (args: { where: { id: string } }) => ({
      stripe_account_id: args.where.id === ORG_B_ID ? 'acct_orgB' : 'acct_other',
    }));
    await post('orgB_admin', { surface: 'owner' });
    expect(mockPrisma.organization.findUnique).toHaveBeenCalledWith(expect.objectContaining({ where: { id: ORG_B_ID } }));
    expect(mockCreateAccountSession).toHaveBeenCalledWith('acct_orgB', 'owner');
    expect(ORG_B_ID).not.toBe(ALPHA_ORG_ID);
  });

  it('still asks for the terms before minting', async () => {
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue(null);
    const res = await post('admin', { surface: 'owner' });
    expect(res.status).toBe(403);
    expect(res.body).toMatchObject({ code: 'PAYMENTS_TERMS_ACCEPTANCE_REQUIRED' });
    expect(mockCreateAccountSession).not.toHaveBeenCalled();
  });
});

describe('GET /api/organization/stripe/status - terms_accepted', () => {
  const statusRow = {
    stripe_account_id: 'acct_1', stripe_charges_enabled: false, stripe_payouts_enabled: false,
    stripe_details_submitted: false, stripe_requirements_due: [], stripe_disabled_reason: null,
  };

  it('is true once the current payments terms are on file, so the page can go straight to the embedded components', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(statusRow);
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue({ id: 'terms-1' });
    const res = await request(app).get('/api/organization/stripe/status').set(authHeader('admin'));
    expect(res.body.terms_accepted).toBe(true);
  });

  it('is false until then, so the page shows the terms and asks for no session', async () => {
    mockPrisma.organization.findUnique.mockResolvedValue(statusRow);
    mockPrisma.termsAcceptance.findFirst.mockResolvedValue(null);
    const res = await request(app).get('/api/organization/stripe/status').set(authHeader('admin'));
    expect(res.body.terms_accepted).toBe(false);
    expect(mockCreateAccountSession).not.toHaveBeenCalled();
  });
});
