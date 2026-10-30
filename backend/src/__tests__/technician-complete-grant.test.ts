/**
 * Multi-visit S4, D15/D15a: technician `complete Job` becomes seed-time only. (Roles & Permissions S01.8 then moved
 * the grant onto the Complete jobs switch, off in the Technician preset: the stored row no longer decides, which
 * the second case below pins. The role reset case still holds: the reset keeps a row the platform stopped seeding.)
 *
 * The mechanism IS the absence of a migration. Role grants are per-org `role_permissions` rows
 * seeded from DEFAULT_GRANTS only at org creation, so removing the entry gives exactly
 * "on for existing orgs, off by default for new ones" with no data change. Nothing here asserts a
 * migration, deliberately.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { mockAuthAs, authHeader, JOB_FIXTURE, TEST_USERS, mockRoleSwitches } from './helpers';
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
    // The job-level complete writes its visit cancels, history, status move and review round in one transaction
    // (S06.1); the stub runs that callback against the same mocked client.
    mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) => fn(mockPrisma));
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

  // Roles & Permissions S01.8: the Complete jobs switch took the grant over, so a role_permissions row no
  // longer lets anyone complete a job, in an old org or a new one. The switch is the only source.
  it('no longer lets a technician in an EXISTING org complete on the stored row alone', async () => {
    mockAuthAs('technician');
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

    expect(res.status).toBe(403);
    expect(mockPrisma.job.update).not.toHaveBeenCalled();
  });

  it('lets a technician complete a job they are crew on once Complete jobs is switched on', async () => {
    mockAuthAs('technician');
    mockRoleSwitches({ complete_jobs: true });
    arrangeCrewedJob();

    const res = await request(app)
      .post(`/api/jobs/${JOB_FIXTURE.id}/complete`)
      .set(authHeader('technician'))
      .send({});

    expect(res.status).toBe(200);
    expect(mockPrisma.job.update.mock.calls[0][0].data.status).toBe('OFFICE_REVIEW');
  });
});
