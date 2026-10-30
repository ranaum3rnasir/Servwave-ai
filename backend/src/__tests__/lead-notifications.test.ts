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
 * Verbs 3 and 4 go through M6's two-lane chain (S06.26): the route only QUEUES the alert for after its response, so this file
 * checks what the route asks for (verb, lead, actor, performers); who is told is permission-lead-estimate-alerts-db.test.ts.
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

// The lead alerts that go through the chain: the route queues them, so the queue call is what a route test sees.
vi.mock('../services/notifications/leadEstimateAlerts', () => ({
  queueLeadAlert: vi.fn(),
  alertLead: vi.fn().mockResolvedValue(undefined),
}));

// Import AFTER mock is registered so we get the spy reference.
import { emit } from '../services/notifications/notificationService';
import { queueLeadAlert } from '../services/notifications/leadEstimateAlerts';
const mockEmit = emit as ReturnType<typeof vi.fn>;
const mockLeadAlert = queueLeadAlert as ReturnType<typeof vi.fn>;
/** The queued lead alerts of one verb, as the routes asked for them. */
const leadAlertsOf = (verb: string) => mockLeadAlert.mock.calls.map((c: any[]) => c[0]).filter((a: any) => a.verb === verb);

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

  it('queues lead.unassigned_created when lead is created without an owner', async () => {
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

    const queued = leadAlertsOf('lead.unassigned_created');
    expect(queued).toHaveLength(1);
    expect(queued[0]).toEqual({
      verb: 'lead.unassigned_created', organizationId: ALPHA_ORG_ID, actorId: TEST_USERS.admin.id, leadId: UNOWNED_LEAD_FIXTURE.id,
    });
    // The route sends nothing itself: no role list is asked, no alert is written inside the request.
    expect(mockEmit.mock.calls.filter((c: any[]) => c[0].verb === 'lead.unassigned_created')).toHaveLength(0);
  });

  it('still queues it when the new lead has a Dispatcher and walkthrough performers but no owner', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findUnique.mockResolvedValue(CUSTOMER_FIXTURE);
    const createdLead = {
      ...UNOWNED_LEAD_FIXTURE,
      dispatcher_id: TECH_ID,
      dispatcher: { id: TECH_ID, first_name: 'Dee', last_name: 'Spatch', email: 'dee@example.test' },
      lead_assignees: [{ user_id: TECH_ID, user: { id: TECH_ID, first_name: 'Tec', last_name: 'Hnician' } }],
    };
    wireCreateTx(createdLead);
    mockPrisma.lead.findUnique.mockResolvedValue(createdLead);
    (prisma.tagAssignment as any) && ((prisma.tagAssignment.findMany as any).mockResolvedValue([]));
    (prisma.tag as any) && ((prisma.tag.findMany as any).mockResolvedValue([]));

    const res = await request(app)
      .post('/api/leads')
      .set(authHeader('admin'))
      .send(BASE_BODY);

    expect(res.status).toBe(201);
    const calls = leadAlertsOf('lead.unassigned_created');
    expect(calls).toHaveLength(1);
    expect(calls[0].leadId).toBe(UNOWNED_LEAD_FIXTURE.id);
  });

  it('queues it for a lead created together with a new customer when it has no owner, and not when it has one', async () => {
    mockAuthAs('admin');
    mockPrisma.customer.findFirst.mockResolvedValue(null);
    (prisma.tagAssignment as any) && ((prisma.tagAssignment.findMany as any).mockResolvedValue([]));
    (prisma.tag as any) && ((prisma.tag.findMany as any).mockResolvedValue([]));
    const wireNewCustomerTx = (created: any) =>
      mockPrisma.$transaction.mockImplementation(async (fn: (tx: unknown) => Promise<unknown>) =>
        fn({
          customer: { create: vi.fn().mockResolvedValue({ id: CUSTOMER_FIXTURE.id, service_locations: [] }) },
          lead: { create: vi.fn().mockResolvedValue(created) },
          timelineEvent: { create: vi.fn().mockResolvedValue({}) },
          visit: { aggregate: mockPrisma.visit.aggregate, create: vi.fn().mockResolvedValue({ id: 'wt-fixture-id' }) },
        }),
      );
    const body = {
      new_customer: { first_name: 'New', last_name: 'Person', phone: '6095550142' },
      service_request: 'AC not cooling',
    };

    wireNewCustomerTx(UNOWNED_LEAD_FIXTURE);
    mockPrisma.lead.findUnique.mockResolvedValue(UNOWNED_LEAD_FIXTURE);
    let res = await request(app).post('/api/leads').set(authHeader('admin')).send(body);
    expect(res.status).toBe(201);
    expect(leadAlertsOf('lead.unassigned_created')).toHaveLength(1);

    mockLeadAlert.mockClear();
    const owned = { ...LEAD_FIXTURE, commission_owner_id: SALES_ID };
    wireNewCustomerTx(owned);
    mockPrisma.lead.findUnique.mockResolvedValue(owned);
    res = await request(app).post('/api/leads').set(authHeader('admin')).send({ ...body, assigned_to: SALES_ID });
    expect(res.status).toBe(201);
    expect(leadAlertsOf('lead.unassigned_created')).toHaveLength(0);
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

    expect(leadAlertsOf('lead.unassigned_created')).toHaveLength(0);
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

  it('queues lead.walkthrough_scheduled with the people booked on it', async () => {
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

    const queued = leadAlertsOf('lead.walkthrough_scheduled');
    expect(queued).toEqual([{
      verb: 'lead.walkthrough_scheduled', organizationId: ALPHA_ORG_ID, actorId: TEST_USERS.admin.id, leadId: LEAD_FIXTURE.id, performerIds: PERFORMER_IDS,
    }]);
    expect(mockEmit.mock.calls.filter((c: any[]) => c[0].verb === 'lead.walkthrough_scheduled')).toHaveLength(0);
  });
});
