// Payments go-live slice 36 - the statement descriptor: derived from the org name when the account is created and
// readable back for display. It is NOT editable: the platform may not write it on a processor-controlled account
// (staging acceptance D2), so there is no edit route.
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { retrieveAccount } from '../lib/stripe';
import { toStatementDescriptor } from '../controllers/organization-stripe.controller';
import { mockAuthAs, authHeader, mockRoleSwitches } from './helpers';

const orgFindUnique = prisma.organization.findUnique as unknown as ReturnType<typeof vi.fn>;
const mockRetrieve = vi.mocked(retrieveAccount);

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  orgFindUnique.mockResolvedValue({ stripe_account_id: 'acct_desc_1', name: 'Harbor Locksmiths LLC' });
});

describe('the statement descriptor derivation used when the account is created', () => {
  it('derives from the org name without a character the processor refuses', () => {
    expect(toStatementDescriptor('Harbor\\Locks Café')).toBe('HarborLocks Caf');
  });
});

describe('the descriptor cannot be edited', () => {
  it.each(['admin', 'sales', 'dispatcher'] as const)('PATCH /api/organization/stripe/statement-descriptor has no route (%s)', async (who) => {
    mockAuthAs(who);
    mockRoleSwitches({ manage_payout_account: true });
    const res = await request(app).patch('/api/organization/stripe/statement-descriptor').set(authHeader(who)).send({ statement_descriptor: 'HARBOR LOCKS' });
    expect(res.status).toBe(404);
  });

  it('PUT and POST have no route either', async () => {
    expect((await request(app).put('/api/organization/stripe/statement-descriptor').set(authHeader('admin')).send({ statement_descriptor: 'HARBOR LOCKS' })).status).toBe(404);
    expect((await request(app).post('/api/organization/stripe/statement-descriptor').set(authHeader('admin')).send({ statement_descriptor: 'HARBOR LOCKS' })).status).toBe(404);
  });
});

describe('GET /api/organization/stripe/statement-descriptor', () => {
  it('reads the descriptor the account has now', async () => {
    mockRetrieve.mockResolvedValue({ settings: { payments: { statement_descriptor: 'HARBOR LOCKS' } } } as never);
    const res = await request(app).get('/api/organization/stripe/statement-descriptor').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ statement_descriptor: 'HARBOR LOCKS' });
    expect(mockRetrieve).toHaveBeenCalledWith('acct_desc_1');
  });

  it('falls back to the one derived from the org name when the account has none', async () => {
    mockRetrieve.mockResolvedValue({ settings: { payments: { statement_descriptor: null } } } as never);
    const res = await request(app).get('/api/organization/stripe/statement-descriptor').set(authHeader('admin'));
    expect(res.body).toEqual({ statement_descriptor: 'Harbor Locksmiths LLC' });
  });

  it('is 409 with no account, and 403 without the switch', async () => {
    orgFindUnique.mockResolvedValue({ stripe_account_id: null, name: 'X Co' });
    expect((await request(app).get('/api/organization/stripe/statement-descriptor').set(authHeader('admin'))).status).toBe(409);
    mockAuthAs('dispatcher');
    expect((await request(app).get('/api/organization/stripe/statement-descriptor').set(authHeader('dispatcher'))).status).toBe(403);
  });
});
