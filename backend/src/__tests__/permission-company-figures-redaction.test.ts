/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.16 - the company-figures redaction (M4), as pure functions.

   The redactors take the payload an endpoint has built and leave out the company-wide money in it. They are
   the one backstop every dashboard and report response passes through for a person without See company
   figures. The expected values below are written out by hand (what a person should and should not see), never
   computed from the same rule the code uses.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import {
  redactDashboardCompanyFigures,
  redactRevenueReport,
  redactPaymentFeesReport,
  redactEstimateConversionReport,
  redactArAgingReport,
  redactJobsReportCosts,
  redactActivityReportRevenue,
} from '../lib/permissions/companyFigures';

/** The keyed answer the dashboard endpoint builds (PRD 9): the eligible tiles, and each tile's data by its id. */
const dashboard = () => ({
  tiles: [
    { id: 'kpi.jobs_today', category: 'jobs', mode: 'scope', label: null },
    { id: 'kpi.revenue_mtd', category: 'invoices_and_payments', mode: 'own', label: 'Yours' },
    { id: 'kpi.recurring', category: 'company_figures', mode: 'company', label: null },
    { id: 'revenue_by_job_type', category: 'company_figures', mode: 'company', label: null },
    { id: 'smart_insights', category: 'company_figures', mode: 'company', label: null },
    { id: 'tech_scoreboard', category: 'jobs', mode: 'scope', label: null },
  ],
  data: {
    'kpi.jobs_today': { total: 4, scheduled: 2, in_progress: 1, completed: 1, vs_yesterday: 1 },
    'kpi.revenue_mtd': { invoiced: 900, collected: 700, collected_last_month: 600, vs_last_month_pct: 16, target: 55000, pct_of_goal: 13 },
    'kpi.recurring': { mrr: 1200, active_plans: 5 },
    revenue_chart: { months: [{ month: 'Oct', invoiced: 900, collected: 700, is_current: true }], target: 55000 },
    revenue_by_job_type: [{ label: 'Install', pct: 100, revenue: 9000 }],
    smart_insights: [{ id: 'top_source', text: 'Google = 60% of leads.' }],
    needs_attention: [
      { id: 'a', type: 'overdue_invoice', severity: 'danger', title: 'Invoice INV-1 overdue', meta: 'Acme · 5 days past due · $1,200', badge: '5d', link: '/invoices/a' },
    ],
    pipeline: [
      { key: 'leads', label: 'Leads', kind: 'count', value: 12, link: '/leads' },
      { key: 'paid', label: 'Paid', kind: 'amount', value: 70, link: '/invoices?status=paid' },
    ],
    tech_scoreboard: [{ user_id: 'u1', name: 'Tess Tech', revenue: 5000, jobs: 4 }],
    dispatch_scoreboard: [{ user_id: 'u2', name: 'Dee Dispatch', revenue: 8000, jobs: 6 }],
    lead_sources: [{ source: 'google', label: 'Google', lead_pct: 60, revenue: 4000 }],
    recent_activity: [
      { id: 'e1', event_type: 'PAYMENT_RECEIVED', description: 'Payment received via Cash', entity_type: 'INVOICE', entity_id: 'i1', entity_deleted: false, entity_label: null, created_at: '2026-10-10T10:00:00.000Z', creator_name: 'Ann Admin' },
      { id: 'e2', event_type: 'JOB_CREATED', description: 'Job J-1 created', entity_type: 'JOB', entity_id: 'j1', entity_deleted: false, entity_label: null, created_at: '2026-10-10T09:00:00.000Z', creator_name: null },
    ],
  } as Record<string, any>,
  generated_at: '2026-10-10T10:05:00.000Z',
});

describe('redactDashboardCompanyFigures', () => {
  it('takes out the Company figures tiles, from the tile list and from the data', () => {
    const out = redactDashboardCompanyFigures(dashboard());
    expect(out.tiles.map((t) => t.id)).toEqual(['kpi.jobs_today', 'kpi.revenue_mtd', 'tech_scoreboard']);
    for (const id of ['kpi.recurring', 'revenue_by_job_type', 'smart_insights']) expect(id in out.data, id).toBe(false);
  });

  it('leaves the money that is already the person\'s own, and takes only the company goal off it', () => {
    const out = redactDashboardCompanyFigures(dashboard());
    expect(out.data['kpi.revenue_mtd']).toEqual({ invoiced: 900, collected: 700, collected_last_month: 600, vs_last_month_pct: 16 });
    expect(out.data.revenue_chart).toEqual({ months: [{ month: 'Oct', invoiced: 900, collected: 700, is_current: true }] });
    expect(out.data.pipeline).toEqual(dashboard().data.pipeline);
  });

  it('keeps job counts on the scoreboards and drops their revenue', () => {
    const out = redactDashboardCompanyFigures(dashboard());
    expect(out.data.tech_scoreboard).toEqual([{ user_id: 'u1', name: 'Tess Tech', jobs: 4 }]);
    expect(out.data.dispatch_scoreboard).toEqual([{ user_id: 'u2', name: 'Dee Dispatch', jobs: 6 }]);
  });

  it('keeps the lead sources and their share and drops their revenue', () => {
    const out = redactDashboardCompanyFigures(dashboard());
    expect(out.data.lead_sources).toEqual([{ source: 'google', label: 'Google', lead_pct: 60 }]);
  });

  it('leaves the activity feed exactly as written (no text is scanned: an entry names no figure in its words) and drops no row, and leaves a record\'s own price alone', () => {
    const out = redactDashboardCompanyFigures(dashboard());
    expect(out.data.recent_activity.map((e: { description: string }) => e.description)).toEqual(['Payment received via Cash', 'Job J-1 created']);
    expect(out.data.recent_activity.map((e: { id: string }) => e.id)).toEqual(['e1', 'e2']);
    // An overdue invoice's amount is that invoice's price, shown to anyone who can open it (PRD 9, H2).
    expect(out.data.needs_attention[0].meta).toBe('Acme · 5 days past due · $1,200');
  });

  it('touches nothing else and does not change the payload it was given', () => {
    const before = dashboard();
    const input = dashboard();
    const out = redactDashboardCompanyFigures(input);
    expect(input).toEqual(before);
    expect(out.data['kpi.jobs_today']).toEqual(before.data['kpi.jobs_today']);
    expect(out.generated_at).toBe(before.generated_at);
  });
});

describe('report redactors', () => {
  it('revenue: the whole report is company money, so no series and no totals come back', () => {
    const out = redactRevenueReport({
      series: [{ month: '2026-09', label: 'Sep 26', completed: 10, invoiced: 20, collected: 30 }],
      totals: { completed: 10, invoiced: 20, collected: 30, collectionRate: 150, outstanding: -10 },
    });
    expect(out).toEqual({ series: [] });
  });

  it('payment fees: the window and the counts stay, every dollar sum goes', () => {
    const out = redactPaymentFeesReport({
      from: '2026-01-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z',
      gross: 1, charged: 2, stripeFees: 3, platformFees: 4, net: 5, reconciledCount: 6, serviceFees: 7, serviceFeeCount: 8, tips: 9, tipCount: 10,
    });
    expect(out).toEqual({ from: '2026-01-01T00:00:00.000Z', to: '2026-10-01T00:00:00.000Z', reconciledCount: 6, serviceFeeCount: 8, tipCount: 10 });
  });

  it('estimate conversion: counts, rates and dates stay; every value, total and average ticket goes at any depth', () => {
    const out = redactEstimateConversionReport({
      filters: { anchor: 'sent', repId: 'all' },
      summary: { buckets: { WON: { count: 2, value: 900 } }, totalCount: 5, totalValue: 4000, sentEverCount: 4, sentEverValue: 3500, won: { count: 2, value: 900 }, conversion: { rate: 50, num: 2, denom: 4 } },
      context: { avgTicketWon: 450, avgTicketLost: 100, medianDaysToDecision: 3, medianHoursRequestToSent: 5 },
      byRep: [{ repId: 'r1', repName: 'Rae', sentCount: 4, sentValue: 3500, wonCount: 2, wonValue: 900, lostValue: 200, openValue: 100, conversionPct: 50, avgTicketWon: 450 }],
      byMonth: [{ month: '2026-10', label: 'Oct', sentValue: 3500, wonValue: 900, conversionPct: 50, partial: true }],
      aging: { '0-7': { count: 1, value: 300 } },
      options: { reps: [{ id: 'r1', name: 'Rae' }], sources: ['google'], jobTypes: [] },
    });
    expect(out).toEqual({
      filters: { anchor: 'sent', repId: 'all' },
      summary: { buckets: { WON: { count: 2 } }, totalCount: 5, sentEverCount: 4, won: { count: 2 }, conversion: { rate: 50, num: 2, denom: 4 } },
      context: { medianDaysToDecision: 3, medianHoursRequestToSent: 5 },
      byRep: [{ repId: 'r1', repName: 'Rae', sentCount: 4, wonCount: 2, conversionPct: 50 }],
      byMonth: [{ month: '2026-10', label: 'Oct', conversionPct: 50, partial: true }],
      aging: { '0-7': { count: 1 } },
      options: { reps: [{ id: 'r1', name: 'Rae' }], sources: ['google'], jobTypes: [] },
    });
  });

  it('unpaid invoices: the per-customer balances stay (they are the invoices), the company-wide sales window and DSO go', () => {
    const accounts = [{ id: 'c1', customer: 'Acme', type: 'Commercial', invoices: [{ number: 'INV-1', daysLate: 4, balance: 100 }] }];
    const out = redactArAgingReport({ accounts, dso: 41, salesInWindow: 90000, salesWindowDays: 90 });
    expect(out).toEqual({ accounts, salesWindowDays: 90 });
  });

  it('jobs report: the margin and cost keys of every row go, the prices stay', () => {
    const row = { jobNumber: 41, client: 'Acme', billed: 1080, paid: 0, subtotal: 1000, tax: 80, tip: 5, itemCost: 0, laborCost: 0, cardExpenses: 0, techExpenses: 0, profit: 920 };
    expect(redactJobsReportCosts([row, { ...row, jobNumber: 42 }])).toEqual([
      { jobNumber: 41, client: 'Acme', billed: 1080, paid: 0, subtotal: 1000, tax: 80, tip: 5 },
      { jobNumber: 42, client: 'Acme', billed: 1080, paid: 0, subtotal: 1000, tax: 80, tip: 5 },
    ]);
  });

  it('activity report: revenue touched and last period\'s go from every person, the action counts stay', () => {
    const user = { id: 'u1', name: 'Pat', revenueTouched: 0, prevRevenueTouched: 0, conversions: 0, actions: 7, breakdown: [{ label: 'lead.created', count: 7 }] };
    expect(redactActivityReportRevenue([user])).toEqual([{ id: 'u1', name: 'Pat', conversions: 0, actions: 7, breakdown: [{ label: 'lead.created', count: 7 }] }]);
  });
});
