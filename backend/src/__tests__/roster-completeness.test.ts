import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as any;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  mockAuthAs('admin');
  mockPrisma.rolePermission.findMany.mockImplementation((a: any) =>
    Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === a.where.role)));
  mockPrisma.user.findMany.mockResolvedValue([]);
});

// The roster moved off `GET /api/users?include_referenced_in=…` and onto its own route when the
// picker stopped being gated on `read User` (scoped assignee pool, slice 3). Same union, same
// where-clause, a route a SALES user can actually reach — and `purpose` is now required, so these
// send one. `admin` holds the pool through manage-all, which is what keeps the union org-wide here.
describe('GET /api/users/assignable?include_referenced_in=jobs', () => {
  // NOTE: prisma is MOCKED here, so this asserts the SHAPE of the where-clause and nothing
  // more — it cannot tell a live relation from a dead one. That is exactly how the previous
  // `job_crew_memberships` clause shipped CI-green and 500ed on every real request after the
  // multi-visit S8 teardown dropped job_assignees. The guard that actually catches a dead
  // relation name is `tsc -b`, because the controller types the clause as Prisma.UserWhereInput.
  it('ORs referenced job crew (the visit-derived union) into the roster where-clause', async () => {
    await request(app)
      .get('/api/users/assignable?purpose=jobCrew&include_referenced_in=jobs')
      .set(authHeader('admin'));
    const where = mockPrisma.user.findMany.mock.calls[0][0].where;
    // Job crew is no longer a direct join: it is every visit assignment whose visit hangs off
    // a Job. Asserting the nested shape keeps a regression to a job-level relation visible.
    expect(where.OR).toEqual(expect.arrayContaining([
      expect.objectContaining({
        visit_assignments: { some: { visit: { job_id: { not: null } } } },
      }),
    ]));
    // and it must NOT reach walkthrough-only crew, whose visits hang off a Lead
    expect(JSON.stringify(where)).not.toContain('job_crew_memberships');
    // still tenant-scoped
    expect(where.organization_id ?? where.AND).toBeDefined();
  });
});

describe('GET /api/users/assignable?include_referenced_in=leads', () => {
  it('ORs referenced lead owners + crew into the roster where-clause', async () => {
    await request(app)
      .get('/api/users/assignable?purpose=walkthroughPerformer&include_referenced_in=leads')
      .set(authHeader('admin'));
    const where = mockPrisma.user.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(expect.arrayContaining([
      expect.objectContaining({ lead_crew_memberships: { some: {} } }),
      expect.objectContaining({ commission_owned_leads: { some: {} } }),
      // The direct joins alone miss a walkthrough performer, whose only tie to the lead has
      // been a visit assignment since S1. Silent gap, not a 500 - see the controller comment.
      expect.objectContaining({
        visit_assignments: { some: { visit: { lead_id: { not: null } } } },
      }),
    ]));
    // the leads arm must not reach job crew, whose visits hang off a Job
    expect(JSON.stringify(where)).not.toContain('job_id');
  });
});

describe('GET /api/estimates/creators', () => {
  it('unions active ADMIN/SALES with distinct actual creators (any role/status)', async () => {
    await request(app).get('/api/estimates/creators').set(authHeader('admin'));
    const where = mockPrisma.user.findMany.mock.calls[0][0].where;
    expect(where.OR).toEqual(expect.arrayContaining([
      expect.objectContaining({ is_active: true, role: { in: ['ADMIN', 'SALES'] } }),
      expect.objectContaining({ created_estimates: { some: {} } }),
    ]));
  });
});
