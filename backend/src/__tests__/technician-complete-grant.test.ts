/**
 * Multi-visit S4, D15/D15a: technician `complete Job` becomes seed-time only.
 *
 * The mechanism IS the absence of a migration. Role grants are per-org `role_permissions` rows
 * seeded from DEFAULT_GRANTS only at org creation, so removing the entry gives exactly
 * "on for existing orgs, off by default for new ones" with no data change. Nothing here asserts a
 * migration, deliberately.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, JOB_FIXTURE, TEST_USERS } from './helpers';
import { prisma } from '../lib/prisma';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as Record<string, any>;

const OWN_JOB = { visits: { some: { assignees: { some: { user_id: '{{userId}}' } } } } };

/** A technician crewed on the job under test. */
function arrangeCrewedJob() {
  mockPrisma.job.findUnique.mockResolvedValue({
    ...JOB_FIXTURE,
    status: 'IN_PROGRESS',
    started_at: new Date('2026-09-05T13:04:00Z'),
    job_number: 'J00001',
    source_plan_id: null,
    visits: [{ assignees: [{ user_id: TEST_USERS.technician.id }] }],
  });
  mockPrisma.job.findFirst.mockResolvedValue({ id: JOB_FIXTURE.id });
  mockPrisma.job.update.mockResolvedValue(JOB_FIXTURE);
}

describe('technician complete Job is seed-time only (D15)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
  });

  it('refuses a technician in a NEW org, seeded from the current defaults', async () => {
    mockAuthAs('technician');
    arrangeCrewedJob();

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('technician'))
      .send({});

    expect(res.status).toBe(403);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('still lets a technician in an EXISTING org complete, because that org holds the row', async () => {
    mockAuthAs('technician');
    // An org provisioned before this change: its role_permissions table still carries the grant,
    // and nothing removed it. This is the whole "on for existing" half of D15.
    mockPrisma.rolePermission.findMany.mockResolvedValue([
      ...DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN'),
      { role: 'TECHNICIAN', action: 'complete', subject: 'Job', conditions: OWN_JOB },
    ]);
    clearPermissionCache();
    arrangeCrewedJob();

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('technician'))
      .send({});

    expect(res.status).toBe(200);
    expect(mockPrisma.job.update.mock.calls[0][0].data.status).toBe('COMPLETED');
  });
});

describe('POST /api/roles/TECHNICIAN/reset does not strip a grant the platform stopped seeding (D15a)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    clearPermissionCache();
    mockAuthAs('admin');
    mockPrisma.$transaction.mockImplementation(async (fn: any) =>
      fn({
        rolePermission: {
          deleteMany: mockPrisma.rolePermission.deleteMany,
          createMany: mockPrisma.rolePermission.createMany,
        },
      }),
    );
    mockPrisma.rolePermission.deleteMany.mockResolvedValue({ count: 0 });
    mockPrisma.rolePermission.createMany.mockResolvedValue({ count: 0 });
  });

  it('keeps complete Job when the org already carries it', async () => {
    // The org's live rows, as reset() finds them.
    mockPrisma.rolePermission.findMany.mockResolvedValue([
      ...DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN'),
      { role: 'TECHNICIAN', action: 'complete', subject: 'Job', conditions: OWN_JOB },
    ]);

    const res = await request(app)
      .post('/api/roles/TECHNICIAN/reset')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    const written = mockPrisma.rolePermission.createMany.mock.calls[0][0].data as {
      action: string;
      subject: string;
    }[];
    // Reset rebuilds purely from DEFAULT_GRANTS, so without a preserve list it would silently take
    // an existing org's technicians off a capability they have been using - the opposite of what
    // D15 promises them.
    expect(written).toContainEqual(
      expect.objectContaining({ role: 'TECHNICIAN', action: 'complete', subject: 'Job' }),
    );
  });

  it('does not invent the grant for an org that never had it', async () => {
    mockPrisma.rolePermission.findMany.mockResolvedValue(
      DEFAULT_GRANTS.filter((g) => g.role === 'TECHNICIAN'),
    );

    const res = await request(app)
      .post('/api/roles/TECHNICIAN/reset')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    const written = mockPrisma.rolePermission.createMany.mock.calls[0][0].data as {
      action: string;
      subject: string;
    }[];
    // Preserve means preserve, not re-seed: a new org stays off.
    expect(written).not.toContainEqual(
      expect.objectContaining({ action: 'complete', subject: 'Job' }),
    );
  });
});
