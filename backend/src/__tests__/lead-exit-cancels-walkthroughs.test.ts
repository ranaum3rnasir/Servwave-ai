/**
 * A lead leaving the pipeline takes its booked walkthroughs with it.
 *
 * Mark-lost is the door that closes a lead, and it runs one shared step:
 * every LIVE walkthrough visit of the lead is cancelled, in the transaction that moves the status
 * (every live trip, not only the earliest, since a lead can hold several booked trips). Finished and
 * already-cancelled trips are history and are left alone. The visit table below is an in-memory
 * stand-in that honours the `where` the writer uses (organization, lead, id, status set), so the
 * assertions are about which rows changed.
 *
 * Closing a lead always asks why (walkthrough lead-statuses PRD D11), so the generic PATCH refuses a status of LOST
 * without a reason with a 400 and nothing written, and refuses CANCELLED outright, as a value no lead has any more (S05.17, S05.18). A PATCH to LOST that carries a reason is the same close as
 * Mark lost (S05.16): the same shared step cancels every live trip. The status menu itself opens the Mark Lost dialog
 * and closes the lead through the dedicated door.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import {
  mockAuthAs, authHeader, mockRoleGrantsWithout, mockRoleSwitches, mockScopedFindFirst, LEAD_FIXTURE, ALPHA_ORG_ID, ORG_B_ID, TEST_USERS,
} from './helpers';
import { prisma } from '../lib/prisma';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: vi.fn() }));

const mockPrisma = prisma as unknown as Record<string, any>;
const OTHER_LEAD = 'dd000000-0000-4000-8000-0000000000aa';

type VisitRow = { id: string; organization_id: string; lead_id: string; status: string; cancelled_reason: string | null };
let visits: VisitRow[];

const visit = (id: string, status: string, over: Partial<VisitRow> = {}): VisitRow => ({
  id: `dd000000-0000-4000-8000-0000000000${id}`, organization_id: ALPHA_ORG_ID, lead_id: LEAD_FIXTURE.id,
  status, cancelled_reason: null, ...over,
});

function hits(row: VisitRow, where: any): boolean {
  if (where.id !== undefined && row.id !== where.id) return false;
  if (where.organization_id !== undefined && row.organization_id !== where.organization_id) return false;
  if (where.lead_id !== undefined && row.lead_id !== where.lead_id) return false;
  if (where.status?.in && !where.status.in.includes(row.status)) return false;
  return true;
}

const statusOf = (id: string) => visits.find((v) => v.id.endsWith(id))!;

beforeEach(() => {
  vi.clearAllMocks();
  mockAuthAs('admin');
  visits = [
    visit('01', 'SCHEDULED'),
    visit('02', 'EN_ROUTE'),
    visit('03', 'COMPLETED'),
    visit('04', 'CANCELLED', { cancelled_reason: 'Customer asked' }),
    // Neighbours the write must never reach.
    visit('05', 'SCHEDULED', { lead_id: OTHER_LEAD }),
    visit('06', 'SCHEDULED', { organization_id: ORG_B_ID }),
  ];
  mockPrisma.$transaction.mockImplementation((fn: (tx: unknown) => Promise<unknown>) => fn(prisma));
  mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'ESTIMATED', organization_id: ALPHA_ORG_ID });
  mockPrisma.lead.update.mockResolvedValue({ ...LEAD_FIXTURE });
  mockPrisma.lead.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.timelineEvent.create.mockResolvedValue({});
  mockPrisma.visit.findMany.mockResolvedValue([]);
  mockPrisma.visit.findFirst.mockImplementation(async ({ where }: any) =>
    visits.find((v) => hits(v, where)) ?? null,
  );
  mockPrisma.visit.updateMany.mockImplementation(async ({ where, data }: any) => {
    const rows = visits.filter((v) => hits(v, where));
    for (const r of rows) Object.assign(r, data);
    return { count: rows.length };
  });
  mockPrisma.estimate.updateMany.mockResolvedValue({ count: 0 });
  mockPrisma.estimate.findMany.mockResolvedValue([]);
  mockPrisma.estimate.count.mockResolvedValue(0);
  mockPrisma.invoice.findMany.mockResolvedValue([]);
  mockPrisma.invoice.updateMany.mockResolvedValue({ count: 0 });
});

function expectLiveTripsCancelled(reason: string) {
  expect(statusOf('01')).toMatchObject({ status: 'CANCELLED', cancelled_reason: reason });
  expect(statusOf('02')).toMatchObject({ status: 'CANCELLED', cancelled_reason: reason });
  // History stays as it was.
  expect(statusOf('03')).toMatchObject({ status: 'COMPLETED', cancelled_reason: null });
  expect(statusOf('04')).toMatchObject({ status: 'CANCELLED', cancelled_reason: 'Customer asked' });
  // Another lead's and another organization's trips are untouched.
  expect(statusOf('05').status).toBe('SCHEDULED');
  expect(statusOf('06').status).toBe('SCHEDULED');
}

describe('the lead status menu (PATCH /api/leads/:id) does not close a lead without a reason', () => {
  const patchStatus = (status: string) =>
    request(app).patch(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin')).send({ status });

  const expectNothingWritten = () => {
    expect(visits.filter((v) => v.status === 'SCHEDULED' || v.status === 'EN_ROUTE')).toHaveLength(4);
    expect(mockPrisma.visit.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
    expect(mockPrisma.lead.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  };

  it('LOST with no reason is a 400, and the lead, its trips and its History are untouched', async () => {
    const res = await patchStatus('LOST');

    expect(res.status).toBe(400);
    expect(res.body).toEqual({ error: 'Please give a reason.' });
    expectNothingWritten();
  });

  it('CANCELLED is a 400 whatever comes with it, and the lead, its trips and its History are untouched', async () => {
    const res = await patchStatus('CANCELLED');

    expect(res.status).toBe(400);
    expect(typeof res.body.error).toBe('string');
    expectNothingWritten();
  });

  it('refuses the whole request, so the other fields in it are not saved either', async () => {
    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ status: 'LOST', notes: 'Went elsewhere' });

    expect(res.status).toBe(400);
    expectNothingWritten();
  });

  it('re-sending LOST on a lead that is already lost is refused the same way', async () => {
    mockPrisma.lead.findUnique.mockResolvedValue({ ...LEAD_FIXTURE, status: 'LOST', organization_id: ALPHA_ORG_ID });

    const res = await patchStatus('LOST');

    expect(res.status).toBe(400);
    expectNothingWritten();
  });

  it('any other status still changes through the PATCH and leaves the trips booked', async () => {
    const res = await patchStatus('CONTACTED');

    expect(res.status).toBe(200);
    expect(visits.filter((v) => v.status === 'CANCELLED')).toHaveLength(1);
  });
});

describe('a PATCH to LOST that carries a reason cancels every booked trip, as Mark lost does (S05.16)', () => {
  it('cancels the live trips and writes the reason and the lost date through the one status writer', async () => {
    const res = await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ status: 'LOST', lost_reason: 'Went elsewhere' });

    expect(res.status).toBe(200);
    expectLiveTripsCancelled('Lead marked as lost');
    const write = mockPrisma.lead.updateMany.mock.calls.find(([a]: any[]) => a.data?.status === 'LOST')?.[0];
    expect(write.data).toMatchObject({ status: 'LOST', lost_reason: 'Went elsewhere', lost_at: expect.any(Date) });
  });

  it('archives the open estimates', async () => {
    await request(app)
      .patch(`/api/leads/${LEAD_FIXTURE.id}`)
      .set(authHeader('admin'))
      .send({ status: 'LOST', lost_reason: 'Went elsewhere' });

    expect(mockPrisma.estimate.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'ARCHIVED', cancelled_reason: 'Lead marked as lost' }) }),
    );
  });

  it('refuses a blank reason, and a reason on any other status, writing nothing', async () => {
    const blank = await request(app).patch(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin')).send({ status: 'LOST', lost_reason: '   ' });
    const stray = await request(app).patch(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin')).send({ status: 'ESTIMATED', lost_reason: 'x' });

    expect(blank.status).toBe(400);
    expect(blank.body).toEqual({ error: 'Please give a reason.' });
    expect(stray.status).toBe(400);
    expect(mockPrisma.visit.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.lead.updateMany).not.toHaveBeenCalled();
  });
});

describe('the dedicated door cancels every booked trip, not only the earliest', () => {
  it('mark-lost', async () => {
    const res = await request(app)
      .post(`/api/leads/${LEAD_FIXTURE.id}/mark-lost`)
      .set(authHeader('admin'))
      .send({ lost_reason: 'Went elsewhere' });

    expect(res.status).toBe(200);
    expectLiveTripsCancelled('Lead marked as lost');
  });
});

/**
 * The status menu is not a way around the dedicated doors (security review of the fix pass).
 *
 * POST /mark-lost needs `mark_lost Lead` and POST /cancel needs `cancel Lead`, but the generic PATCH
 * needs only `update Lead`, and it now cancels the lead's booked trips as well. Neither verb is on
 * the Roles editor, so a role can hold `update Lead` without them (a technician-based custom role
 * given Leads Edit, or one whose defaults were trimmed). Such a role must be refused the same way
 * the dedicated door refuses it, and nothing may be written: not the status, not the trips.
 */
describe('the status menu needs the same verb as the dedicated door', () => {
  const expectNothingWritten = () => {
    expect(visits.filter((v) => v.status === 'SCHEDULED' || v.status === 'EN_ROUTE')).toHaveLength(4);
    expect(mockPrisma.visit.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.lead.update).not.toHaveBeenCalled();
    expect(mockPrisma.lead.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
  };
  const patch = (body: Record<string, unknown>, who: 'dispatcher' | 'sales' = 'dispatcher') =>
    request(app).patch(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader(who)).send(body);

  beforeEach(() => clearPermissionCache());
  afterEach(() => clearPermissionCache());

  describe('a role that may edit leads but not mark them lost', () => {
    beforeEach(() => {
      mockAuthAs('dispatcher');
      mockRoleGrantsWithout('DISPATCHER', ['mark_lost', 'Lead']);
    });

    it('is refused LOST, and every booked trip stays booked', async () => {
      const res = await patch({ status: 'LOST' });

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Insufficient permissions' });
      expectNothingWritten();
    });

    it('is refused the whole request, so the other fields in it are not saved either', async () => {
      const res = await patch({ status: 'LOST', notes: 'Went elsewhere' });

      expect(res.status).toBe(403);
      expectNothingWritten();
    });

    it('is refused CANCELLED too: a lead closes one way, as Lost', async () => {
      const res = await patch({ status: 'CANCELLED' });

      expect(res.status).toBe(400);
      expect(typeof res.body.error).toBe('string');
      expectNothingWritten();
    });

    it('can still edit the lead when the status is not part of the request', async () => {
      const res = await patch({ notes: 'Called back, wants a quote' });

      expect(res.status).toBe(200);
      expect(mockPrisma.lead.update).toHaveBeenCalled();
      expect(statusOf('01').status).toBe('SCHEDULED');
    });

    it('can still move the lead to a status outside the dedicated doors', async () => {
      const res = await patch({ status: 'CONTACTED' });

      expect(res.status).toBe(200);
    });
  });

  describe('a verb held only on the leads the user is attached to', () => {
    beforeEach(() => {
      mockAuthAs('dispatcher');
      // Leads scope Attached: Mark leads lost reaches only leads the person is on.
      mockRoleSwitches({ leads_scope: 'attached' });
    });

    it('is refused LOST on a lead that is not theirs', async () => {
      mockScopedFindFirst(mockPrisma.lead.findFirst, { ...LEAD_FIXTURE, organization_id: ALPHA_ORG_ID });

      const res = await patch({ status: 'LOST' });

      expect(res.status).toBe(404);
      expectNothingWritten();
    });

    it('is past the permission check for LOST on a lead that is theirs, and asked for a reason instead', async () => {
      mockScopedFindFirst(mockPrisma.lead.findFirst, {
        ...LEAD_FIXTURE, organization_id: ALPHA_ORG_ID, lead_assignees: [{ user_id: TEST_USERS.dispatcher.id }],
      });

      const res = await patch({ status: 'LOST' });

      expect(res.status).toBe(400);
      expectNothingWritten();
    });
  });

  describe('the default roles are unchanged', () => {
    it('a dispatcher holds Mark leads lost, so it is asked for a reason rather than refused', async () => {
      mockAuthAs('dispatcher');

      expect((await patch({ status: 'LOST' })).status).toBe(400);
      expectNothingWritten();
    });

    it('an admin holds Mark leads lost, so it is asked for a reason rather than refused', async () => {
      mockAuthAs('admin');
      const send = (status: string) =>
        request(app).patch(`/api/leads/${LEAD_FIXTURE.id}`).set(authHeader('admin')).send({ status });

      expect((await send('LOST')).status).toBe(400);
      expectNothingWritten();
    });

    it('sales is refused the status change on its own lead: Change lead status by hand is off in its preset', async () => {
      mockAuthAs('sales');
      mockScopedFindFirst(mockPrisma.lead.findFirst, { ...LEAD_FIXTURE, organization_id: ALPHA_ORG_ID });

      const res = await patch({ status: 'LOST' }, 'sales');

      expect(res.status).toBe(403);
      expect(res.body).toEqual({ error: 'Insufficient permissions' });
      // Refused before anything is written: neither the status nor the trips move.
      expect(statusOf('01').status).toBe('SCHEDULED');
      expect(mockPrisma.visit.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.lead.updateMany).not.toHaveBeenCalled();
      expect(mockPrisma.timelineEvent.create).not.toHaveBeenCalled();
    });
  });
});
