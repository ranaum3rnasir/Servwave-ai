/**
 * Multi-visit S8 (behaviours 7 and 16) - attachment ACCESS follows visit crew.
 *
 * These are authorization decisions, not rendering. attachment.controller.ts asks the access resolver (the same
 * `canAccessRow` rule that opens the job or lead itself, S01.11) "can this user open this record", and 403s on
 * no. For a technician or a sales rep that rule is the person's Attached scope: a job's crew is reached through
 * `job.visits[].assignees`, a lead's through `lead.visits[].assignees` or its assignees. The relation paths are
 * proven against a real database in permission-data-scope-db.test.ts; here the resolver is given an HONOURING
 * fake that answers a `findFirst` only when the scope fragment it was handed names the caller, so a controller
 * that stopped asking the resolver (or asked for nobody) would look refused, never green.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, TEST_USERS, ALPHA_ORG_ID } from './helpers';
import { prisma } from '../lib/prisma';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as Record<string, any>;

const TECH_ID = TEST_USERS.technician.id;
const SALES_ID = TEST_USERS.sales.id;
const JOB_ID = 'j0000000-0000-0000-0000-0000000000f1';
const LEAD_ID = 'e0000000-0000-0000-0000-0000000000f1';

/** A `findFirst` that finds the record only when the scope in its `where` names this person. */
function resolverFor(userId: string | null) {
  return async (args: any) => (userId && JSON.stringify(args?.where ?? {}).includes(userId) ? { id: args.where.id } : null);
}

describe('S8 behaviour 7 - job attachment access follows the access resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockPrisma.attachment.findMany.mockResolvedValue([]);
    mockPrisma.job.findUnique.mockImplementation(async (args: any) => ({ id: args.where.id }));
  });

  it('lets a technician the job\'s scope reaches read the job attachments', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findFirst.mockImplementation(resolverFor(TECH_ID));

    const res = await request(app).get(`/api/attachments/JOB/${JOB_ID}`).set(authHeader('technician'));
    expect(res.status).toBe(200);
  });

  it('refuses a technician the job\'s scope does not reach', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findFirst.mockImplementation(resolverFor(null));

    const res = await request(app).get(`/api/attachments/JOB/${JOB_ID}`).set(authHeader('technician'));
    expect(res.status).toBe(403);
  });
});

describe('S8 behaviour 16 - lead attachment access follows the access resolver', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockPrisma.attachment.findMany.mockResolvedValue([]);
    mockPrisma.lead.findUnique.mockImplementation(async (args: any) => ({ id: args.where.id }));
  });

  it('lets a SALES user the lead\'s scope reaches read the attachments', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findFirst.mockImplementation(resolverFor(SALES_ID));

    const res = await request(app).get(`/api/attachments/LEAD/${LEAD_ID}`).set(authHeader('sales'));
    expect(res.status).toBe(200);
  });

  it('refuses a SALES user the lead\'s scope does not reach', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findFirst.mockImplementation(resolverFor(null));

    const res = await request(app).get(`/api/attachments/LEAD/${LEAD_ID}`).set(authHeader('sales'));
    expect(res.status).toBe(403);
  });

  it('lets a TECHNICIAN the lead\'s scope reaches read the attachments', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.findFirst.mockImplementation(resolverFor(TECH_ID));

    const res = await request(app).get(`/api/attachments/LEAD/${LEAD_ID}`).set(authHeader('technician'));
    expect(res.status).toBe(200);
  });

  it('refuses a TECHNICIAN the lead\'s scope does not reach', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.findFirst.mockImplementation(resolverFor(null));

    const res = await request(app).get(`/api/attachments/LEAD/${LEAD_ID}`).set(authHeader('technician'));
    expect(res.status).toBe(403);
  });
});

// Referenced so an unused-import lint never quietly removes the org constant this file's
// fixtures are scoped by in spirit.
void ALPHA_ORG_ID;
