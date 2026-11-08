/**
 * comm-blocked-numbers.test.ts - the blocked-callers CRUD contract (SRVW-98).
 *
 * The Blocked callers tab now persists through these routes instead of mutating
 * React state, so the server is the only arbiter of what a blocked number IS:
 * it must store ONE canonical form (E.164 via normalizeNAPhone) and reject a
 * re-block of the same number in any spelling. Supertest through
 * authenticate -> requireFeature('phone') -> attachAbility -> canDo -> validate,
 * following ctm-rbac-403.test.ts's harness.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, TEST_USERS } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const ROW = {
  id: 'b1000000-0000-0000-0000-000000000001',
  number: '+13475550188',
  name: null,
  reason: 'spam',
  note: null,
  blocked_at: new Date('2026-08-01T10:00:00Z'),
  blocked_by: 'Test Admin',
  blocked_by_id: TEST_USERS.admin.id,
  organization_id: TEST_USERS.admin.organization_id,
};

beforeEach(() => {
  // Call history must not leak across cases: the "create is NOT called" cases
  // would otherwise see the earlier happy-path create.
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  p.blockedNumber.findMany.mockResolvedValue([]);
  p.blockedNumber.create.mockResolvedValue(ROW);
  p.blockedNumber.deleteMany.mockResolvedValue({ count: 1 });
});

describe('POST /api/communication/blocked', () => {
  it('stores the number in canonical E.164 form', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/communication/blocked')
      .set(authHeader('admin'))
      .send({ number: '(347) 555-0188', reason: 'spam' });

    expect(res.status).toBe(201);
    expect(p.blockedNumber.create).toHaveBeenCalledTimes(1);
    const data = p.blockedNumber.create.mock.calls[0][0].data;
    expect(data.number).toBe('+13475550188');
    expect(data.organization_id).toBe(TEST_USERS.admin.organization_id);
  });

  it.each(['+13475550188', '347-555-0188', '3475550188'])(
    '409s a duplicate submitted as %s',
    async (spelling) => {
      mockAuthAs('admin');
      // The stored row is in the legacy display form the two live staging rows use.
      p.blockedNumber.findMany.mockResolvedValue([{ id: ROW.id, number: '(347) 555-0188' }]);

      const res = await request(app)
        .post('/api/communication/blocked')
        .set(authHeader('admin'))
        .send({ number: spelling, reason: 'spam' });

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('ALREADY_BLOCKED');
      expect(p.blockedNumber.create).not.toHaveBeenCalled();
    },
  );

  it('scopes the duplicate lookup to the caller organization', async () => {
    mockAuthAs('admin');
    await request(app)
      .post('/api/communication/blocked')
      .set(authHeader('admin'))
      .send({ number: '(347) 555-0188', reason: 'spam' });

    expect(p.blockedNumber.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organization_id: TEST_USERS.admin.organization_id }),
      }),
    );
  });

  it('400s anything that is not a 10 or 11 digit North-American number', async () => {
    mockAuthAs('admin');

    const garbage = await request(app)
      .post('/api/communication/blocked')
      .set(authHeader('admin'))
      .send({ number: 'not a phone', reason: 'spam' });
    expect(garbage.status).toBe(400);

    // A bare 7-digit local number carries no area code, so it could never be
    // compared against an E.164 inbound caller. Storing it would create a
    // durable row that de-dupes nothing and suppresses nothing.
    const sevenDigit = await request(app)
      .post('/api/communication/blocked')
      .set(authHeader('admin'))
      .send({ number: '555-0188', reason: 'spam' });
    expect(sevenDigit.status).toBe(400);

    expect(p.blockedNumber.create).not.toHaveBeenCalled();
  });
});

describe('POST /api/communication/blocked/unblock', () => {
  it('deletes with an org-scoped filter', async () => {
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/communication/blocked/unblock')
      .set(authHeader('admin'))
      .send({ id: ROW.id });

    expect(res.status).toBe(200);
    expect(p.blockedNumber.deleteMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: ROW.id,
        organization_id: TEST_USERS.admin.organization_id,
      }),
    });
  });

  it('404s an id that belongs to another organization', async () => {
    mockAuthAs('orgB_admin');
    p.blockedNumber.deleteMany.mockResolvedValue({ count: 0 });

    const res = await request(app)
      .post('/api/communication/blocked/unblock')
      .set(authHeader('orgB_admin'))
      .send({ id: ROW.id });

    expect(res.status).toBe(404);
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
