/**
 * Job creator tracking (audit only) - spec Part A, PR 1.
 *
 * "Who created this job" has no answer today. These tests pin the three columns that give it one:
 * created_by_id (the acting user, or null), created_by_name (a snapshot that survives a permanent
 * user delete, since the FK is ON DELETE SET NULL) and created_by_source.
 *
 * NOTHING reads these for authorization here - that is PR 3. What is under test is purely that
 * every production creation path stamps the truth, and that a client cannot dictate it.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import { readFileSync } from 'fs';
import { join } from 'path';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  ALPHA_ORG_ID,
  CUSTOMER_FIXTURE,
  LOCATION_FIXTURE,
  ESTIMATE_APPROVED_FIXTURE,
} from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const CREATED_JOB = { id: 'j0000000-0000-0000-0000-0000000000aa', job_number: 'J00001', assignees: [] };

const ESTIMATE_FIXTURE = {
  id: ESTIMATE_APPROVED_FIXTURE.id,
  status: 'WON',
  estimate_number: 'E00003',
  lead_id: 'lead-1',
  lead: {
    customer_id: CUSTOMER_FIXTURE.id,
    service_location_id: LOCATION_FIXTURE.id,
    service_address_line1: '123 Main St',
    customer: { id: CUSTOMER_FIXTURE.id },
    lead_assignees: [{ user_id: TEST_USERS.dispatcher.id }],
  },
};

/** The `data` object handed to job.create inside the request's transaction. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
let capturedJobCreate: Record<string, any> | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  capturedJobCreate = null;

  mockPrisma.invoice.findFirst.mockResolvedValue(null);
  mockPrisma.job.findFirst.mockResolvedValue(null);
  mockPrisma.customer.findUnique.mockResolvedValue({ id: CUSTOMER_FIXTURE.id });
  mockPrisma.serviceLocation.findFirst.mockResolvedValue({ id: LOCATION_FIXTURE.id });
  mockPrisma.tagAssignment.findMany.mockResolvedValue([]);

  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => unknown) => {
    if (typeof fn !== 'function') return Promise.all(fn as unknown as Promise<unknown>[]);
    return fn({
      job: {
        create: vi.fn().mockImplementation((args: { data: Record<string, unknown> }) => {
          capturedJobCreate = args.data;
          return Promise.resolve(CREATED_JOB);
        }),
      },
      estimate: { update: vi.fn().mockResolvedValue({}) },
      estimateLineItem: { findMany: vi.fn().mockResolvedValue([]) },
      jobLineItem: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      jobAssignee: { createMany: vi.fn().mockResolvedValue({ count: 0 }) },
      planVisit: {
        count: vi.fn().mockResolvedValue(0),
        create: vi.fn().mockResolvedValue({ id: 'pv1', visit_number: 1 }),
      },
      // S8 (D6): scheduleVisit books a real job VISIT for the plan's trip.
      visit: {
        create: vi.fn().mockResolvedValue({ id: 'jv1', visit_seq: 1 }),
        aggregate: vi.fn().mockResolvedValue({ _max: { visit_seq: null } }),
      },
      visitAssignee: {
        findMany: vi.fn().mockResolvedValue([]),
        createMany: vi.fn().mockResolvedValue({ count: 0 }),
        deleteMany: vi.fn().mockResolvedValue({ count: 0 }),
      },
      timelineEvent: { create: vi.fn().mockResolvedValue({}) },
    });
  });
});

describe('POST /api/jobs - the acting user is recorded as the creator', () => {
  it('stamps source USER, the acting user id, and their name on a standalone job', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('dispatcher'))
      .send({ customer_id: CUSTOMER_FIXTURE.id, service_location_id: LOCATION_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(capturedJobCreate).toMatchObject({
      created_by_id: TEST_USERS.dispatcher.id,
      created_by_name: 'Test Dispatcher',
      created_by_source: 'USER',
    });
  });

  it('stamps the acting user on an estimate conversion, not the estimate author', async () => {
    mockAuthAs('dispatcher');
    mockPrisma.estimate.findUnique.mockResolvedValue(ESTIMATE_FIXTURE);

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('dispatcher'))
      .send({ estimate_id: ESTIMATE_APPROVED_FIXTURE.id });

    expect(res.status).toBe(201);
    expect(capturedJobCreate).toMatchObject({
      created_by_id: TEST_USERS.dispatcher.id,
      created_by_name: 'Test Dispatcher',
      created_by_source: 'USER',
    });
  });

  it('ignores creator fields supplied in the request body (immutable, unspoofable)', async () => {
    mockAuthAs('dispatcher');

    const res = await request(app)
      .post('/api/jobs')
      .set(authHeader('dispatcher'))
      .send({
        customer_id: CUSTOMER_FIXTURE.id,
        service_location_id: LOCATION_FIXTURE.id,
        created_by_id: TEST_USERS.admin.id,
        created_by_name: 'Somebody Else',
        created_by_source: 'SYSTEM',
      });

    expect(res.status).toBe(201);
    expect(capturedJobCreate).toMatchObject({
      created_by_id: TEST_USERS.dispatcher.id,
      created_by_name: 'Test Dispatcher',
      created_by_source: 'USER',
    });
  });
});

describe('POST /api/service-plans/:id/schedule-visit - an auto-generated visit job is SYSTEM', () => {
  it('stamps source SYSTEM with a null creator id, not the scheduling user', async () => {
    mockAuthAs('admin');
    mockPrisma.servicePlan.findFirst.mockResolvedValue({
      id: 'sp000000-0000-0000-0000-000000000001',
      service_plan_number: 'SP00001',
      organization_id: ALPHA_ORG_ID,
      customer_id: CUSTOMER_FIXTURE.id,
      service_location_id: LOCATION_FIXTURE.id,
      name: 'Annual monitoring',
      status: 'ACTIVE',
      visit_cadence: 'MONTHLY',
      start_date: new Date('2026-01-01T00:00:00.000Z'),
      end_date: new Date('2026-12-31T00:00:00.000Z'),
      contract_price: '1200.00',
      renewals_count: 0,
      line_items: [],
      material_lines: [],
      visits: [],
    });

    const res = await request(app)
      .post('/api/service-plans/sp000000-0000-0000-0000-000000000001/schedule-visit')
      .set(authHeader('admin'))
      .send({ scheduled_start: '2026-04-01T15:00:00.000Z' });

    expect(res.status).toBe(201);
    expect(capturedJobCreate).toMatchObject({
      created_by_id: null,
      created_by_source: 'SYSTEM',
    });
  });
});

describe('the jobs creator migration', () => {
  const sql = readFileSync(
    join(__dirname, '../../prisma/migrations/20260805120000_job_created_by/migration.sql'),
    'utf8',
  );

  it('leaves every job row that predates it reading back UNKNOWN', () => {
    // The only thing that can answer for pre-migration rows is the column default, so it must be
    // NOT NULL DEFAULT 'UNKNOWN' - a nullable or undefaulted column would read back null instead.
    expect(sql).toMatch(
      /ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "created_by_source" "CreatedBySource" NOT NULL DEFAULT 'UNKNOWN'/,
    );
  });

  it('adds the id and name columns idempotently', () => {
    expect(sql).toMatch(/ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "created_by_id" UUID/);
    expect(sql).toMatch(/ALTER TABLE "jobs" ADD COLUMN IF NOT EXISTS "created_by_name" TEXT/);
  });

  it('creates the CreatedBySource enum with all five values, idempotently', () => {
    expect(sql).toMatch(
      /CREATE TYPE "CreatedBySource" AS ENUM \('USER', 'CLIENT', 'SYSTEM', 'IMPORT', 'UNKNOWN'\)/,
    );
    expect(sql).toMatch(/EXCEPTION WHEN duplicate_object THEN NULL/);
  });

  it('links the creator with ON DELETE SET NULL so a permanent user delete cannot fail or cascade', () => {
    expect(sql).toMatch(/IF NOT EXISTS \(SELECT 1 FROM pg_constraint WHERE conname = 'jobs_created_by_id_fkey'\)/);
    expect(sql).toMatch(
      /FOREIGN KEY \("created_by_id"\) REFERENCES "users"\("id"\) ON DELETE SET NULL/,
    );
    // RESTRICT would make DELETE /api/users/:id/permanent fail for anyone who ever made a job.
    expect(sql).not.toMatch(/"created_by_id"\) REFERENCES "users"\("id"\) ON DELETE RESTRICT/);
  });

  it('is portable to vanilla Postgres - no Supabase-only roles or auth schema', () => {
    expect(sql).not.toMatch(/\bauth\./);
    expect(sql).not.toMatch(/TO (authenticated|anon|service_role)\b/);
  });
});
