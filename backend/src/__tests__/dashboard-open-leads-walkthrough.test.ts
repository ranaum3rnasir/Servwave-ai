/**
 * Walkthrough lead statuses, slice 01 - the dashboard counts a lead with a walkthrough booked or
 * done as an OPEN lead.
 *
 * The open-lead KPI asks the database for the leads whose status is in the controller's open set, counted by status.
 * The `lead.groupBy` mock below honours that `status.in`, over one lead per status, so the count the
 * response carries tells which statuses the controller asked for. Won, Lost and Cancelled are
 * closed and never count.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { mockAuthAs, authHeader } from './helpers';

const ALL_STATUSES = [
  'NEW',
  'CONTACTED',
  'WALKTHROUGH_SCHEDULED',
  'WALKTHROUGH_COMPLETED',
  'ESTIMATED',
  'WON',
  'LOST',
  'CANCELLED',
];

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
});

/** A grouped count with one lead in each status the query's `status.in` asks for. */
const oneLeadPerAskedStatus = (args: any) => {
  const statuses: string[] | undefined = args?.where?.status?.in;
  return Promise.resolve(
    (statuses ?? []).filter((s) => ALL_STATUSES.includes(s)).map((s) => ({ status: s, _count: { _all: 1 } })),
  );
};

describe('GET /api/dashboard - open leads include the walkthrough statuses', () => {
  it('counts one lead in every open status, and none of the closed ones', async () => {
    mockAuthAs('orgB_admin');

    (prisma.job.groupBy as Mock).mockResolvedValue([]);
    (prisma.job.count as Mock).mockResolvedValue(0);
    (prisma.invoice.aggregate as Mock).mockResolvedValue({ _sum: {}, _avg: {}, _count: { _all: 0 } });
    (prisma.estimate.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.job.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.payment.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.appSetting.findUnique as Mock).mockResolvedValue(null);
    (prisma.lead.count as Mock).mockResolvedValue(0);
    (prisma.lead.findMany as Mock).mockResolvedValue([]);
    (prisma.estimate.findMany as Mock).mockResolvedValue([]);
    (prisma.job.findMany as Mock).mockResolvedValue([]);
    (prisma.servicePlan.findMany as Mock).mockResolvedValue([]);
    (prisma.user.findMany as Mock).mockResolvedValue([]);
    (prisma.timelineEvent.findMany as Mock).mockResolvedValue([]);
    (prisma.invoice.findMany as Mock).mockResolvedValue([]);
    (prisma.$queryRaw as Mock).mockResolvedValue([]);

    // One lead per status that the query's `status.in` names.
    (prisma.lead.groupBy as Mock).mockImplementation(oneLeadPerAskedStatus);

    const res = await request(app).get('/api/dashboard').set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    expect(res.body.data['kpi.open_leads']).toEqual({ count: 5, no_owner: 0 });
  });

  it('the open-lead count, the no-owner count and the oldest-without-an-owner lookup ask for the same open set', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.groupBy as Mock).mockResolvedValue([]);
    (prisma.job.count as Mock).mockResolvedValue(0);
    (prisma.invoice.aggregate as Mock).mockResolvedValue({ _sum: {}, _avg: {}, _count: { _all: 0 } });
    (prisma.estimate.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.job.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.payment.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.appSetting.findUnique as Mock).mockResolvedValue(null);
    (prisma.lead.findMany as Mock).mockResolvedValue([]);
    (prisma.lead.groupBy as Mock).mockImplementation(oneLeadPerAskedStatus);
    // A lead with no Owner exists, so the no-owner count is above zero and the lookup of the oldest runs.
    (prisma.lead.count as Mock).mockResolvedValue(2);
    (prisma.lead.findFirst as Mock).mockResolvedValue(null);
    (prisma.estimate.findMany as Mock).mockResolvedValue([]);
    (prisma.job.findMany as Mock).mockResolvedValue([]);
    (prisma.servicePlan.findMany as Mock).mockResolvedValue([]);
    (prisma.user.findMany as Mock).mockResolvedValue([]);
    (prisma.timelineEvent.findMany as Mock).mockResolvedValue([]);
    (prisma.invoice.findMany as Mock).mockResolvedValue([]);
    (prisma.$queryRaw as Mock).mockResolvedValue([]);

    const res = await request(app).get('/api/dashboard').set(authHeader('orgB_admin'));
    expect(res.status).toBe(200);

    // Close Rate also groups leads by status (Won and Lost): the open set is the one that names an open status.
    const statusSets = [
      ...(prisma.lead.groupBy as Mock).mock.calls.map((c) => c[0]?.where),
      ...(prisma.lead.findMany as Mock).mock.calls.map((c) => c[0]?.where),
      ...(prisma.lead.findFirst as Mock).mock.calls.map((c) => c[0]?.where),
      ...(prisma.lead.count as Mock).mock.calls.map((c) => c[0]?.where),
    ]
      // The no-owner test composes its open set under AND, beside the person's row scope.
      .flatMap((w) => [w, ...(Array.isArray(w?.AND) ? w.AND : [])])
      .filter((w) => w?.status?.in?.includes('NEW'))
      .map((w) => w.status.in as string[]);

    expect(statusSets.length).toBeGreaterThanOrEqual(3);
    for (const set of statusSets) {
      expect(set).toEqual(['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED']);
    }
  });
});
