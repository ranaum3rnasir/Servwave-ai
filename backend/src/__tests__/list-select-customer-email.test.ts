/**
 * list-select-customer-email.test.ts — SRVW-243
 *
 * The schedule board builds its reschedule composer from the rows GET /api/jobs
 * and GET /api/leads already return. Both list selects carried the customer's
 * PHONE but not their EMAIL, so the composer could name the customer but not
 * show the address it was about to mail - which is precisely the "I can't see
 * where this is going" complaint the composer exists to answer.
 *
 * Asserted on the SELECT rather than the response body because the list handlers
 * are mocked at the Prisma boundary in this suite: what matters is that the
 * query asks for the column, which is the thing that was missing.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockPrisma.rolePermission.findMany.mockImplementation(
    (args: { where: { role: string } }) =>
      Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );
});

describe('list selects expose the customer email the composer needs', () => {
  it('GET /api/jobs asks for customer.email', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([]);
    mockPrisma.job.count.mockResolvedValue(0);

    await request(app).get('/api/jobs').set(authHeader('admin'));

    const select = mockPrisma.job.findMany.mock.calls[0][0].select;
    expect(select.customer.select.email).toBe(true);
  });

  it('GET /api/leads asks for customer.email', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([]);
    mockPrisma.lead.count.mockResolvedValue(0);

    await request(app).get('/api/leads').set(authHeader('admin'));

    const select = mockPrisma.lead.findMany.mock.calls[0][0].select;
    expect(select.customer.select.email).toBe(true);
  });
});
