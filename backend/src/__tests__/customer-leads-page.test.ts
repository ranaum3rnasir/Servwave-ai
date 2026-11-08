/**
 * Visits-and-task-categories slice 06 — the customer page's Leads tab pages through every lead of
 * the customer with GET /api/leads?customer_id=&page=&limit=.
 *
 * The list already paged; what paging a long-standing customer needs on top is a STABLE order.
 * `created_at` alone is not unique (an import or a bulk create stamps many leads with one instant),
 * and Postgres may return tied rows in any order on each query, so a row could sit on page 1 in one
 * request and on page 2 in the next: a duplicate on one page and a gap on the other. The id
 * tie-break fixes that for every sort the list accepts.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { TEST_USERS, mockAuthAs, authHeader } from './helpers';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { clearUserOverrideCache } from '../lib/permissions/userOverrideCache';

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as unknown as Record<string, any>;

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000006';

beforeEach(() => {
  vi.clearAllMocks();
  clearPermissionCache();
  clearUserOverrideCache();
  mockPrisma.lead.findMany.mockResolvedValue([]);
  mockPrisma.lead.count.mockResolvedValue(0);
});

describe('GET /api/leads?customer_id= — numbered pages of one customer\'s leads', () => {
  it('serves page 2 with the customer\'s total, newest first with the id as the tie-break', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.count.mockResolvedValue(41);

    const res = await request(app)
      .get('/api/leads')
      .query({ customer_id: CUSTOMER_ID, page: 2, limit: 20 })
      .set(authHeader('admin'));

    expect(res.status).toBe(200);
    expect(res.body.pagination).toEqual({ page: 2, limit: 20, total: 41, totalPages: 3 });
    const args = mockPrisma.lead.findMany.mock.calls[0][0];
    expect(args.skip).toBe(20);
    expect(args.take).toBe(20);
    expect(args.orderBy).toEqual([{ created_at: 'desc' }, { id: 'asc' }]);
    // The total counts the same rows the page is cut from.
    expect(mockPrisma.lead.count.mock.calls[0][0].where).toEqual(args.where);
    expect(JSON.stringify(args.where)).toContain(CUSTOMER_ID);
  });

  it('a client-chosen sort keeps the tie-break too (a status sort ties on almost every row)', async () => {
    mockAuthAs('admin');

    await request(app).get('/api/leads').query({ customer_id: CUSTOMER_ID, sortBy: 'status', sortDir: 'asc' }).set(authHeader('admin'));

    expect(mockPrisma.lead.findMany.mock.calls[0][0].orderBy).toEqual([{ status: 'asc' }, { id: 'asc' }]);
  });

  it('tenant and row scope hold on every page: a scoped role\'s page and total name its own org and itself', async () => {
    mockAuthAs('sales');

    await request(app).get('/api/leads').query({ customer_id: CUSTOMER_ID, page: 3, limit: 20 }).set(authHeader('sales'));

    const where = JSON.stringify(mockPrisma.lead.findMany.mock.calls[0][0].where);
    expect(where).toContain(TEST_USERS.sales.organization_id);
    expect(where).toContain(TEST_USERS.sales.id);
    expect(where).toContain(CUSTOMER_ID);
    expect(mockPrisma.lead.count.mock.calls[0][0].where).toEqual(mockPrisma.lead.findMany.mock.calls[0][0].where);
  });
});

describe('GET /api/leads — each lead carries the customer Leads tab\'s walkthrough, resolved on the server (slice 05 rule)', () => {
  /** A walkthrough row as leadListSelect returns it. */
  const trip = (id: string, visit_seq: number, status: string, iso: string | null, over: Record<string, unknown> = {}) => ({
    id, visit_seq, status,
    scheduled_at: iso ? new Date(iso) : null,
    scheduled_end: iso ? new Date(new Date(iso).getTime() + 3_600_000) : null,
    is_all_day: false,
    duration_minutes: 60, completed_at: null, notes: null, cancelled_at: null, cancelled_reason: null,
    cancelled_by: null, customer_email_sent_at: null, created_at: new Date('2020-01-01T00:00:00.000Z'), canceller: null,
    location_id: null, location: null, location_address_line1: null, location_address_line2: null,
    location_city: null, location_state: null, location_zip: null,
    assignees: [],
    ...over,
  });
  const leadRow = (id: string, visits: unknown[]) => ({
    id, lead_number: id.toUpperCase(), customer_id: CUSTOMER_ID, status: 'CONTACTED', service_request: 'Door', visits,
    estimates: [], lead_assignees: [], created_at: new Date('2020-01-01T00:00:00.000Z'),
  });

  it('serves `next_walkthrough`: the next upcoming trip, else the latest past one, never a cancelled one', async () => {
    mockAuthAs('admin');
    mockPrisma.lead.findMany.mockResolvedValue([
      // overdue live trip + a later upcoming one: the tab shows the upcoming one
      leadRow('l-up', [trip('w1', 1, 'SCHEDULED', '2020-03-01T14:00:00.000Z'), trip('w2', 2, 'SCHEDULED', '2099-03-01T14:00:00.000Z', { is_all_day: true })]),
      // every trip past: the latest one
      leadRow('l-past', [trip('w3', 1, 'COMPLETED', '2020-04-02T16:00:00.000Z'), trip('w4', 2, 'COMPLETED', '2020-05-06T17:00:00.000Z')]),
      // lost: its only trip was called off
      leadRow('l-lost', [trip('w5', 1, 'CANCELLED', '2099-06-01T16:00:00.000Z')]),
      // no trip
      leadRow('l-none', []),
    ]);
    mockPrisma.lead.count.mockResolvedValue(4);

    const res = await request(app).get('/api/leads').query({ customer_id: CUSTOMER_ID }).set(authHeader('admin'));

    expect(res.status).toBe(200);
    const byId = Object.fromEntries(res.body.leads.map((l: { id: string }) => [l.id, l]));
    expect(byId['l-up'].next_walkthrough).toEqual({
      visit_id: 'w2', scheduled_at: '2099-03-01T14:00:00.000Z', scheduled_end: '2099-03-01T15:00:00.000Z', is_all_day: true,
    });
    expect(byId['l-past'].next_walkthrough).toMatchObject({ visit_id: 'w4', scheduled_at: '2020-05-06T17:00:00.000Z' });
    expect(byId['l-lost'].next_walkthrough).toBeNull();
    expect(byId['l-none'].next_walkthrough).toBeNull();
    // The flat list fields keep their own rule (the leads list page's earliest live trip).
    expect(byId['l-up'].walkthrough_scheduled_at).toBe('2020-03-01T14:00:00.000Z');
  });
});
