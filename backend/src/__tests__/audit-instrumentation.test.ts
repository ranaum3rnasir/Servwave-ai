/**
 * audit-instrumentation.test.ts
 *
 * Focused, representative coverage that the logAudit() instrumentation actually
 * fires on a successful action across a spread of categories:
 *   - auth:    login.failed, login.succeeded
 *   - CRUD:    customer.created, customer.deleted
 *   - export:  customer.exported
 *
 * Strategy: hit the real Express route via supertest; prisma/supabase are mocked
 * (setup.ts). Assert prisma.auditLog.create was called with the expected action.
 * logAudit is invoked synchronously inside the handler (its prisma.auditLog.create
 * call runs before the first await suspends), so the spy is registered by the time
 * the response resolves — no flake.
 */

import { describe, it, expect, beforeAll, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import {
  TEST_USERS,
  ALPHA_ORG_ID,
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
} from './helpers';

// Keep the notification side-effect inert so we isolate the audit assertion.
vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

const mockPrisma = prisma as any;
const mockSupabase = supabaseAdmin as any;

const auditCreate = () => mockPrisma.auditLog.create as ReturnType<typeof vi.fn>;

/** Assert at least one auditLog.create call carried the given action (+ optional data fields). */
function expectAudited(action: string, data: Record<string, unknown> = {}) {
  expect(auditCreate()).toHaveBeenCalledWith(
    expect.objectContaining({
      data: expect.objectContaining({ action, ...data }),
    }),
  );
}

beforeAll(() => {
  process.env.MFA_TOKEN_ENC_KEY = 'test-mfa-enc-key-deterministic';
});

beforeEach(() => {
  vi.clearAllMocks();
});

// ─── Auth ───────────────────────────────────────────────────────────────────

describe('audit: auth', () => {
  const EMAIL = TEST_USERS.admin.email;

  it('login.failed — records a failed login, resolving org by email', async () => {
    mockSupabase.auth.signInWithPassword.mockResolvedValue({
      data: { user: null, session: null },
      error: { message: 'bad creds' },
    });
    // Best-effort org/actor resolution from the attempted email.
    mockPrisma.user.findFirst.mockResolvedValue({
      id: TEST_USERS.admin.id,
      email: EMAIL,
      organization_id: ALPHA_ORG_ID,
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: 'wrongpassword' });

    expect(res.status).toBe(401);
    expectAudited('login.failed', { org_id: ALPHA_ORG_ID, actor_email: EMAIL });
  });

  it('login.succeeded — records a successful (non-MFA) login', async () => {
    mockSupabase.auth.signInWithPassword.mockResolvedValue({
      data: {
        user: { id: TEST_USERS.admin.id, email: EMAIL },
        session: { access_token: 'a', refresh_token: 'r', expires_at: 1893456000 },
      },
      error: null,
    });
    mockPrisma.user.findUnique.mockImplementation((args: any) => {
      if (args.select && 'mfa_email_enrolled' in args.select) {
        return Promise.resolve({ mfa_email_enrolled: false, first_name: 'Test' });
      }
      return Promise.resolve({
        id: TEST_USERS.admin.id,
        email: EMAIL,
        first_name: 'Test',
        last_name: 'Admin',
        role: 'ADMIN',
        is_active: true,
        has_login: true,
        organization_id: ALPHA_ORG_ID,
        department_id: null,
        location_id: null,
        phone: null,
        phone_ext: null,
        organization: { is_demo: false },
      });
    });

    const res = await request(app)
      .post('/api/auth/login')
      .send({ email: EMAIL, password: 'correct-horse' });

    expect(res.status).toBe(200);
    expectAudited('login.succeeded', { org_id: ALPHA_ORG_ID, actor_id: TEST_USERS.admin.id });
  });
});

// ─── CRUD ───────────────────────────────────────────────────────────────────

describe('audit: customer CRUD', () => {
  it('customer.created — records a create with the new id', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([]); // duplicate guard: none
    mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => {
      const txMock = {
        customer: {
          create: vi.fn().mockResolvedValue({
            id: 'new-cust-id',
            first_name: 'Jane',
            last_name: 'Smith',
            email: 'jane@smith.com',
            phone: '5559876543',
            service_locations: [],
          }),
        },
      };
      return fn(txMock);
    });

    const res = await request(app)
      .post('/api/customers')
      .set(authHeader('admin'))
      .send({ first_name: 'Jane', last_name: 'Smith', email: 'jane@smith.com', phone: '5559876543' });

    expect(res.status).toBe(201);
    expectAudited('customer.created', { resource_type: 'Customer', resource_id: 'new-cust-id' });
  });

  it('customer.deleted — records a delete after the row is removed', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    mockPrisma.lead.count.mockResolvedValue(0);
    mockPrisma.job.count.mockResolvedValue(0);
    mockPrisma.customer.delete.mockResolvedValue(CUSTOMER_FIXTURE);

    const res = await request(app)
      .delete(`/api/customers/${CUSTOMER_FIXTURE.id}`)
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expectAudited('customer.deleted', { resource_type: 'Customer', resource_id: CUSTOMER_FIXTURE.id });
  });
});

// ─── Export ─────────────────────────────────────────────────────────────────

describe('audit: data export', () => {
  it('customer.exported — records an export (GET endpoint, intentionally audited)', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findMany.mockResolvedValue([CUSTOMER_FIXTURE]);

    const res = await request(app)
      .get('/api/customers/export')
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expectAudited('customer.exported', { resource_type: 'Customer' });
  });
});

// ─── Access denied (403) ──────────────────────────────────────────────────────

describe('audit: access denied', () => {
  it('access.denied — records a blocked request when a technician is forbidden', async () => {
    mockAuthAs('technician'); // technicians cannot read the Customer collection

    const res = await request(app)
      .get('/api/customers')
      .set(authHeader('technician'));

    expect(res.status).toBe(403);
    expectAudited('access.denied', {
      org_id: ALPHA_ORG_ID,
      actor_id: TEST_USERS.technician.id,
    });
  });
});
