/**
 * Multi-visit S8 (behaviours 7 and 16) - attachment ACCESS follows visit crew.
 *
 * These are authorization decisions, not rendering. attachment.controller.ts asks the database
 * "is this user on this record's crew" and 403s on no. S8 moves the crew relation for both
 * parents: a job's crew is reached through `job.visits[].assignees`, and a lead's through
 * `lead.visits[].assignees` once `visit_assignees.lead_id` is dropped. The S3 migration header
 * refused that drop and deferred it here for exactly this reason.
 *
 * Both `job.findUnique` and `lead.findUnique` are given HONOURING fakes that answer according to
 * the RELATION PATH the caller selected. A mockResolvedValue fixture comes back whatever path
 * was asked for, so a controller still selecting the dead relation would look green - which is
 * the whole failure mode this file exists to catch.
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
const OTHER_ID = TEST_USERS.dispatcher.id;
const JOB_ID = 'j0000000-0000-0000-0000-0000000000f1';
const LEAD_ID = 'e0000000-0000-0000-0000-0000000000f1';

/**
 * Answer a findUnique from the crew set, honouring which RELATION the select asked for.
 *
 * `visitCrew` is reachable only through `visits[].assignees`. Anything asking for the dead
 * job-level `assignees` relation, or the dead `lead.visit_assignees` back-relation, gets []
 * back - the honest answer for a database where that relation no longer holds the crew.
 */
function honouringRecord(visitCrew: string[][], extra: Record<string, unknown> = {}) {
  return async (args: any) => {
    const select = args?.select ?? {};
    const out: Record<string, unknown> = { id: args?.where?.id, ...extra };
    if (select.assignees) out.assignees = [];
    if (select.visit_assignees) out.visit_assignees = [];
    if (select.lead_assignees) out.lead_assignees = [];
    if (select.visits) {
      out.visits = visitCrew.map((crew) => ({
        assignees: crew.map((u) => ({ user_id: u })),
      }));
    }
    return out;
  };
}

describe('S8 behaviour 7 - job attachment access follows visit crew', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockPrisma.attachment.findMany.mockResolvedValue([]);
  });

  it('lets a technician crewed on visit 2 read the job attachments', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockImplementation(honouringRecord([[OTHER_ID], [TECH_ID]]));

    const res = await request(app).get(`/api/attachments/JOB/${JOB_ID}`).set(authHeader('technician'));
    expect(res.status).toBe(200);
  });

  it('refuses a technician on no visit of that job', async () => {
    mockAuthAs('technician');
    mockPrisma.job.findUnique.mockImplementation(honouringRecord([[OTHER_ID], [OTHER_ID]]));

    const res = await request(app).get(`/api/attachments/JOB/${JOB_ID}`).set(authHeader('technician'));
    expect(res.status).toBe(403);
  });
});

describe('S8 behaviour 16 - lead attachment access follows the lead visits path', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockPrisma.attachment.findMany.mockResolvedValue([]);
  });

  it('lets a SALES walkthrough performer on one of the lead visits read the attachments', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockImplementation(honouringRecord([[OTHER_ID], [SALES_ID]]));

    const res = await request(app).get(`/api/attachments/LEAD/${LEAD_ID}`).set(authHeader('sales'));
    expect(res.status).toBe(200);
  });

  it('refuses a SALES user on none of the lead visits and not a lead assignee', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockImplementation(honouringRecord([[OTHER_ID]]));

    const res = await request(app).get(`/api/attachments/LEAD/${LEAD_ID}`).set(authHeader('sales'));
    expect(res.status).toBe(403);
  });

  it('lets a TECHNICIAN performer on one of the lead visits read the attachments', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.findUnique.mockImplementation(honouringRecord([[TECH_ID]]));

    const res = await request(app).get(`/api/attachments/LEAD/${LEAD_ID}`).set(authHeader('technician'));
    expect(res.status).toBe(200);
  });

  it('refuses a TECHNICIAN on none of the lead visits', async () => {
    mockAuthAs('technician');
    mockPrisma.lead.findUnique.mockImplementation(honouringRecord([[OTHER_ID]]));

    const res = await request(app).get(`/api/attachments/LEAD/${LEAD_ID}`).set(authHeader('technician'));
    expect(res.status).toBe(403);
  });

  it('still lets a SALES lead assignee in, which is the other half of the same check', async () => {
    mockAuthAs('sales');
    mockPrisma.lead.findUnique.mockImplementation(async (args: any) => {
      const select = args?.select ?? {};
      return {
        id: args.where.id,
        ...(select.lead_assignees ? { lead_assignees: [{ user_id: SALES_ID }] } : {}),
        ...(select.visits ? { visits: [] } : {}),
        ...(select.visit_assignees ? { visit_assignees: [] } : {}),
      };
    });

    const res = await request(app).get(`/api/attachments/LEAD/${LEAD_ID}`).set(authHeader('sales'));
    expect(res.status).toBe(200);
  });
});

// Referenced so an unused-import lint never quietly removes the org constant this file's
// fixtures are scoped by in spirit.
void ALPHA_ORG_ID;
