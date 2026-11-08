// S3.1 — GET /api/inventory/jobs exposes `customerId` so the Create PO dialog can send
// `customerId` alongside `jobId` when the operator links a job (PRD 3, "real ids").
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, CUSTOMER_FIXTURE } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const mockPrisma = prisma as unknown as {
  job: { findMany: ReturnType<typeof vi.fn> };
};

const JOB_ROW = {
  id: 'a1b2c3d4-0000-0000-0000-000000000003',
  job_number: 'J-1870',
  status: 'SCHEDULED',
  customer_id: CUSTOMER_FIXTURE.id,
  scope_notes: null,
  visits: [],
  customer: { company_name: 'Equinox Hudson Yards', first_name: null, last_name: null },
  service_location: { address_line1: '33 Hudson Yards', address_line2: null, city: 'New York', state: 'NY', zip: '10001' },
};

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
});

describe('GET /api/inventory/jobs — customerId on the InventoryJob shape (S3.1)', () => {
  it('emits customerId from job.customer_id', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([JOB_ROW]);
    const res = await request(app).get('/api/inventory/jobs').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.jobs).toHaveLength(1);
    expect(res.body.jobs[0]).toMatchObject({ id: JOB_ROW.id, jobNumber: 'J-1870', customerId: CUSTOMER_FIXTURE.id });
  });

  it('omits customerId when the job has no customer', async () => {
    mockAuthAs('admin');
    mockPrisma.job.findMany.mockResolvedValue([{ ...JOB_ROW, customer_id: null }]);
    const res = await request(app).get('/api/inventory/jobs').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.jobs[0]).not.toHaveProperty('customerId');
  });
});
