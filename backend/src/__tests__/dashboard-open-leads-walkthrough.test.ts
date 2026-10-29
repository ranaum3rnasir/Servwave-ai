/**
 * Walkthrough lead statuses, slice 01 - the dashboard counts a lead with a walkthrough booked or
 * done as an OPEN lead.
 *
 * The open-lead KPI asks the database for leads whose status is in the controller's open set. The
 * `lead.findMany` mock below honours that `status.in`, over one lead per status, so the count the
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
    (prisma.lead.groupBy as Mock).mockResolvedValue([]);
    (prisma.lead.count as Mock).mockResolvedValue(0);
    (prisma.estimate.findMany as Mock).mockResolvedValue([]);
    (prisma.job.findMany as Mock).mockResolvedValue([]);
    (prisma.servicePlan.findMany as Mock).mockResolvedValue([]);
    (prisma.user.findMany as Mock).mockResolvedValue([]);
    (prisma.timelineEvent.findMany as Mock).mockResolvedValue([]);
    (prisma.invoice.findMany as Mock).mockResolvedValue([]);
    (prisma.$queryRaw as Mock).mockResolvedValue([]);

    // One unassigned lead per status. Only the open-leads query selects the assignee ids and
    // filters on `status.in`, so that is the one shape answered with rows.
    (prisma.lead.findMany as Mock).mockImplementation((args: any) => {
      const statuses: string[] | undefined = args?.where?.status?.in;
      if (!statuses || !args?.select?.lead_assignees) return Promise.resolve([]);
      return Promise.resolve(
        ALL_STATUSES.filter((s) => statuses.includes(s)).map((s) => ({ id: `lead-${s}`, lead_assignees: [] })),
      );
    });

    const res = await request(app).get('/api/dashboard').set(authHeader('orgB_admin'));

    expect(res.status).toBe(200);
    expect(res.body.kpis.leads_open).toEqual({ count: 5, unassigned: 5 });
  });

  it('the unassigned-lead count and oldest-unassigned lookups ask for the same open set', async () => {
    mockAuthAs('orgB_admin');
    (prisma.job.groupBy as Mock).mockResolvedValue([]);
    (prisma.job.count as Mock).mockResolvedValue(0);
    (prisma.invoice.aggregate as Mock).mockResolvedValue({ _sum: {}, _avg: {}, _count: { _all: 0 } });
    (prisma.estimate.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.job.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.payment.aggregate as Mock).mockResolvedValue({ _sum: {} });
    (prisma.appSetting.findUnique as Mock).mockResolvedValue(null);
    (prisma.lead.findMany as Mock).mockResolvedValue([]);
    (prisma.lead.groupBy as Mock).mockResolvedValue([]);
    (prisma.lead.count as Mock).mockResolvedValue(0);
    (prisma.estimate.findMany as Mock).mockResolvedValue([]);
    (prisma.job.findMany as Mock).mockResolvedValue([]);
    (prisma.servicePlan.findMany as Mock).mockResolvedValue([]);
    (prisma.user.findMany as Mock).mockResolvedValue([]);
    (prisma.timelineEvent.findMany as Mock).mockResolvedValue([]);
    (prisma.invoice.findMany as Mock).mockResolvedValue([]);
    (prisma.$queryRaw as Mock).mockResolvedValue([]);

    const res = await request(app).get('/api/dashboard').set(authHeader('orgB_admin'));
    expect(res.status).toBe(200);

    const statusSets = [
      ...(prisma.lead.findMany as Mock).mock.calls.map((c) => c[0]?.where),
      ...(prisma.lead.count as Mock).mock.calls.map((c) => c[0]?.where),
    ]
      .filter((w) => w?.status?.in)
      .map((w) => w.status.in as string[]);

    expect(statusSets.length).toBeGreaterThanOrEqual(3);
    for (const set of statusSets) {
      expect(set).toEqual(['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED']);
    }
  });
});
