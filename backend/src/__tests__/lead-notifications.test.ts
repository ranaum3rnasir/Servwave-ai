/**
 * lead-notifications.test.ts
 *
 * TDD for Task 3.5: emit() hooks on lead lifecycle events.
 *
 * Verbs covered:
 *   1. lead.assigned          — assign(), new owner set on unowned lead
 *   2. lead.reassigned_away   — assign(), REPLACING an existing owner (both verbs fire)
 *   3. lead.unassigned_created — create(), lead created with no commission_owner_id
 *   4. lead.walkthrough_scheduled — scheduleWalkthrough(), after performer set + status update
 *
 * Strategy: vi.mock captures emit calls. Each test hits the real Express route
 * via supertest. Prisma is fully mocked (vi.mock in setup.ts).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import {
  TEST_USERS,
  mockAuthAs,
  authHeader,
  CUSTOMER_FIXTURE,
  LOCATION_FIXTURE,
  LEAD_FIXTURE,
  ALPHA_ORG_ID,
  withLeadStatusSync,
} from './helpers';
import { DEFAULT_GRANTS } from '../lib/permissions/defaultGrants';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

// ─── Spy on the notification emit function ───────────────────────────────────

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER mock is registered so we get the spy reference.
import { emit } from '../services/notifications/notificationService';
const mockEmit = emit as ReturnType<typeof vi.fn>;

// ─── Prisma typed surface ─────────────────────────────────────────────────────

const mockPrisma = prisma as any;

// ─── Additional fixtures ──────────────────────────────────────────────────────

const SALES_ID = TEST_USERS.sales.id;     // existing owner in LEAD_FIXTURE
const ADMIN_ID = TEST_USERS.admin.id;     // will be the NEW owner in reassign tests
const TECH_ID  = TEST_USERS.technician.id;

/** Lead with NO owner (for unassigned_created + assign-to-unowned tests). */
const UNOWNED_LEAD_FIXTURE = {
  ...LEAD_FIXTURE,
  commission_owner_id: null,
  commission_owner: null,
  lead_assignees: [],
};

// ─── Tx wire helpers ──────────────────────────────────────────────────────────

/** Wire the $transaction mock used by assign(). */
function wireAssignTx(updated: any) {
  const txLeadAssigneeDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const txLeadAssigneeCreate = vi.fn().mockResolvedValue({});
  const txLeadUpdate = vi.fn().mockResolvedValue(updated);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      leadAssignee: { deleteMany: txLeadAssigneeDeleteMany, create: txLeadAssigneeCreate },
      lead: { update: txLeadUpdate },
    }),
  );
  return { txLeadAssigneeDeleteMany, txLeadAssigneeCreate, txLeadUpdate };
}

/** Wire the $transaction mock used by scheduleWalkthrough(). */
function wireScheduleTx(updated: any) {
  const txFindMany = vi.fn().mockResolvedValue([]);
  const txCreateMany = vi.fn().mockResolvedValue({ count: 0 });
  const txDeleteMany = vi.fn().mockResolvedValue({ count: 0 });
  const txLeadUpdate = vi.fn().mockResolvedValue(updated);
  const txWalkthroughCreate = vi.fn().mockResolvedValue({ id: 'wt-new-1' });
  const txWalkthroughUpdate = vi.fn().mockResolvedValue({ id: 'wt-active-1' });
  const txTimelineCreate = vi.fn().mockResolvedValue({});
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn(withLeadStatusSync({
      visitAssignee: { findMany: txFindMany, createMany: txCreateMany, deleteMany: txDeleteMany },
      visit: { aggregate: mockPrisma.visit.aggregate, create: txWalkthroughCreate, update: txWalkthroughUpdate },
      lead: { update: txLeadUpdate, updateMany: vi.fn().mockResolvedValue({ count: 1 }) },
      timelineEvent: { create: txTimelineCreate },
    })),
  );
  return { txFindMany, txCreateMany, txDeleteMany, txLeadUpdate, txWalkthroughCreate, txWalkthroughUpdate, txTimelineCreate };
}

/** Wire the $transaction mock used by create() (existing-customer path). */
function wireCreateTx(created: any) {
  const txCustomerUpdate = vi.fn().mockResolvedValue({});
  const txLeadCreate = vi.fn().mockResolvedValue(created);
  mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
    fn({
      customer: { update: txCustomerUpdate },
      lead: { create: txLeadCreate },
      serviceLocation: {
        findFirst: vi.fn().mockResolvedValue({ id: LOCATION_FIXTURE.id }),
      },
      // Walkthrough-as-entity redesign, PR-B2: create() seeds a REQUESTED walkthrough row.
      visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
    }),
  );
  return { txCustomerUpdate, txLeadCreate };
}

// ─── Lifecycle ────────────────────────────────────────────────────────────────

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();

  // attachAbility middleware
  mockPrisma.rolePermission.findMany.mockImplementation(
    (args: { where: { organization_id: string; role: string } }) =>
      Promise.resolve(DEFAULT_GRANTS.filter((g) => g.role === args.where.role)),
  );

  // Common defaults for create() path
  (prisma.customer.findMany as any).mockResolvedValue([]);
  (prisma.estimate.updateMany as any).mockResolvedValue({ count: 0 });
  (prisma.estimate.findMany as any).mockResolvedValue([]);
  (prisma.estimate.count as any).mockResolvedValue(0);
  (prisma.payment.count as any).mockResolvedValue(0);
  (prisma.invoice.findMany as any).mockResolvedValue([]);
  (prisma.invoice.updateMany as any).mockResolvedValue({ count: 0 });
  (prisma.serviceLocation.findFirst as any).mockResolvedValue(null);
  (prisma.serviceLocation.create as any).mockResolvedValue({ id: 'new-loc-id' });
  (prisma.timelineEvent.create as any).mockResolvedValue({});
  (prisma.lead.delete as any).mockResolvedValue({});

  // Performer validation helpers used by scheduleWalkthrough
  (prisma.user.findUnique as any).mockImplementation(
    (args: { where: { id: string } }) => {
      const match = Object.values(TEST_USERS).find((u) => u.id === args.where.id);
      return Promise.resolve(match || null);
    },
  );
  (prisma.job.findMany as any).mockResolvedValue([]);
  mockPrisma.lead.findMany.mockResolvedValue([]);
  (prisma.appSetting as any) && ((prisma.appSetting.findUnique as any).mockResolvedValue(null));
  // Walkthrough-as-entity redesign, PR-B2: default to "no active/scheduled visit" so tests
  // that don't exercise a specific visit state don't need to know findActiveWalkthrough exists.
  mockPrisma.visit.findFirst.mockResolvedValue(null);
  mockPrisma.visit.findMany.mockResolvedValue([]);
});

// ─── assign() → lead.assigned (new owner, no previous owner) ─────────────────

describe('POST /api/leads/:id/assign — lead.assigned', () => {
  it('emits lead.assigned when assigning to an unowned lead (no previous owner)', async () => {
    mockAuthAs('admin');
    // Lead has no owner
    mockPrisma.lead.findUnique.mockResolvedValue(UNOWNED_LEAD_FIXTURE);
    wireAssignTx({ ...UNOWNED_LEAD_FIXTURE, commission_owner_id: SALES_ID });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assigned_to: SALES_ID });

    expect(res.status).toBe(200);

    // Should emit lead.assigned
    const assignedCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'lead.assigned',
    );
    expect(assignedCall).toBeDefined();
    const args = assignedCall![0];
    expect(args.entity.commission_owner_id).toBe(SALES_ID);
    expect(args.object.type).toBe('LEAD');
    expect(args.object.id).toBe(LEAD_FIXTURE.id);
    expect(args.object.label).toBe(LEAD_FIXTURE.lead_number);
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);

    // Should NOT emit lead.reassigned_away (no previous owner)
    const reassignedCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'lead.reassigned_away',
    );
    expect(reassignedCall).toBeUndefined();
  });
});

// ─── assign() → lead.assigned + lead.reassigned_away (owner replaced) ─────────

describe('POST /api/leads/:id/assign — lead.reassigned_away', () => {
  it('emits BOTH lead.assigned (new owner) AND lead.reassigned_away (old owner) on reassignment', async () => {
    mockAuthAs('admin');
    // Lead currently owned by SALES — reassigning to ADMIN
    mockPrisma.lead.findUnique.mockResolvedValue({
      ...LEAD_FIXTURE,
      commission_owner_id: SALES_ID,
    });
    wireAssignTx({ ...LEAD_FIXTURE, commission_owner_id: ADMIN_ID });

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/assign`)
      .set(authHeader('admin'))
      .send({ assigned_to: ADMIN_ID });

    expect(res.status).toBe(200);

    // lead.assigned → new owner
    const assignedCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'lead.assigned',
    );
    expect(assignedCall).toBeDefined();
    expect(assignedCall![0].entity.commission_owner_id).toBe(ADMIN_ID);

    // lead.reassigned_away → old owner
    const reassignedCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'lead.reassigned_away',
    );
    expect(reassignedCall).toBeDefined();
    expect(reassignedCall![0].entity.previous_owner_id).toBe(SALES_ID);
    expect(reassignedCall![0].object.id).toBe(LEAD_FIXTURE.id);
    expect(reassignedCall![0].organizationId).toBe(ALPHA_ORG_ID);
  });
});

// ─── create() → lead.unassigned_created (no owner) ────────────────────────────

describe('POST /api/leads — lead.unassigned_created', () => {
  const BASE_BODY = {
    customer_id: CUSTOMER_FIXTURE.id,
    service_request: 'AC not cooling',
  };

  it('emits lead.unassigned_created when lead is created without an owner', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    const createdLead = { ...UNOWNED_LEAD_FIXTURE };
    wireCreateTx(createdLead);
    mockPrisma.lead.findUnique.mockResolvedValue(createdLead);
    (prisma.tagAssignment as any) && ((prisma.tagAssignment.findMany as any).mockResolvedValue([]));
    (prisma.tag as any) && ((prisma.tag.findMany as any).mockResolvedValue([]));

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send(BASE_BODY);

    expect(res.status).toBe(201);

    const unassignedCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'lead.unassigned_created',
    );
    expect(unassignedCall).toBeDefined();
    const args = unassignedCall![0];
    expect(args.object.type).toBe('LEAD');
    expect(args.object.id).toBe(UNOWNED_LEAD_FIXTURE.id);
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
  });

  it('does NOT emit lead.unassigned_created when lead is created WITH an owner', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    const createdLead = { ...LEAD_FIXTURE, commission_owner_id: SALES_ID };
    wireCreateTx(createdLead);
    mockPrisma.lead.findUnique.mockResolvedValue(createdLead);
    (prisma.tagAssignment as any) && ((prisma.tagAssignment.findMany as any).mockResolvedValue([]));
    (prisma.tag as any) && ((prisma.tag.findMany as any).mockResolvedValue([]));

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send({ ...BASE_BODY, assigned_to: SALES_ID });

    expect(res.status).toBe(201);

    const unassignedCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'lead.unassigned_created',
    );
    expect(unassignedCall).toBeUndefined();
  });
});

// ─── scheduleWalkthrough() → lead.walkthrough_scheduled ───────────────────────

describe('POST /api/leads/:id/walkthrough/schedule — lead.walkthrough_scheduled', () => {
  const PERFORMER_IDS = [TECH_ID];

  const SCHEDULE_BODY = {
    walkthrough_scheduled_at: '2026-08-01T09:00:00Z',
    performer_ids: PERFORMER_IDS,
    walkthrough_duration_minutes: 60,
  };

  // Lead row the Automation Center's context loader reads (findFirst) to build the
  // merge context for walkthrough events.
  const emailCtxRow = {
    lead_number: LEAD_FIXTURE.lead_number,
    organization_id: ALPHA_ORG_ID,
    service_address_line1: '123 Main St',
    service_city: 'Austin',
    service_state: 'TX',
    service_zip: '78701',
    customer: { first_name: 'John', last_name: 'Doe', email: 'john@doe.com', company_name: null },
    commission_owner: { first_name: 'Test', last_name: 'Sales', email: 'sales@test.com' },
    visit_assignees: [{ user: { first_name: 'Test', last_name: 'Tech', email: 'tech@test.com' } }],
    organization: { timezone: null },
  };

  it('emits lead.walkthrough_scheduled with performer_ids and commission_owner_id', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findUnique.mockResolvedValue({
      ...LEAD_FIXTURE,
      status: 'CONTACTED',
      commission_owner_id: SALES_ID,
      visit_assignees: [],
    });
    mockPrisma.lead.findFirst.mockResolvedValue(emailCtxRow);
    wireScheduleTx({ ...LEAD_FIXTURE, status: 'CONTACTED' });
    (prisma.timelineEvent.create as any).mockResolvedValue({});

    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/walkthrough/schedule`)
      .set(authHeader('admin'))
      .send(SCHEDULE_BODY);

    expect(res.status).toBe(200);

    const walkthroughCall = mockEmit.mock.calls.find(
      (c: any[]) => c[0].verb === 'lead.walkthrough_scheduled',
    );
    expect(walkthroughCall).toBeDefined();
    const args = walkthroughCall![0];
    expect(args.object.type).toBe('LEAD');
    expect(args.object.id).toBe(LEAD_FIXTURE.id);
    expect(args.object.label).toBe(LEAD_FIXTURE.lead_number);
    expect(args.organizationId).toBe(ALPHA_ORG_ID);
    expect(args.actorId).toBe(TEST_USERS.admin.id);
    expect(args.entity.performer_ids).toEqual(PERFORMER_IDS);
    expect(args.entity.commission_owner_id).toBe(SALES_ID);
  });
});
