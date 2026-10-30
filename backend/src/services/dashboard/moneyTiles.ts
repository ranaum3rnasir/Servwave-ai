import type { Prisma } from '@prisma/client';
import { prisma } from '../../lib/prisma';
import { COUNTED_PAYMENT_WHERE } from '../../lib/payment-ledger';
import { arOutstandingWhere } from '../../lib/ar';
import { orgDayDiff } from '../../lib/orgDayRange';
import { ESTIMATE_STATUS } from '../../constants/estimateStatus';
import { COMPLETED_OR_LATER_JOB_STATUSES } from '../../lib/job-status-order';
import { linkPipelineStages } from '../../lib/dashboard/clickTargets';
import { buildPipeline, buildRecurring, buildRevenueByJobType } from '../dashboard-metrics';
import { withScope, type DashContext, type Where } from './context';

/**
 * The tiles about money (PRD 9). A figure is summed over `ctx.money(...)`: with See company figures the records the
 * tile's scope reaches (the whole company under scope All), without it the person's own set ("Yours"), whatever their
 * Data Scope. The company's plan and mix (the revenue goal, recurring plan income, revenue by job type) are not
 * built for a person without it.
 */

const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** Deposit invoices are unearned until applied (#496): every revenue figure leaves them out. */
const NOT_DEPOSIT = { kind: { not: 'DEPOSIT' } } satisfies Prisma.InvoiceWhereInput;

/** The company's monthly revenue goal. Read only for a tile in company mode, which is the only place it shows. */
const revenueTarget = (ctx: DashContext) =>
  ctx.memo('revenueTarget', async () => {
    const setting = await prisma.appSetting.findUnique({
      where: { organization_id_key: { organization_id: ctx.orgWhere.organization_id, key: 'revenue_target_monthly' } },
    });
    return setting ? Number(setting.value) : 55000;
  });

/** Invoiced this month (deposit invoices and voided ones left out), over the invoices the figure covers. */
const invoicedMtd = (ctx: DashContext) =>
  ctx.memo('invoicedMtd', async () => {
    const inv = await ctx.money('Invoice');
    const agg = await prisma.invoice.aggregate({
      where: withScope<Prisma.InvoiceWhereInput>({ ...ctx.orgWhere, ...NOT_DEPOSIT, created_at: { gte: ctx.b.monthStart }, status: { not: 'VOIDED' } }, inv),
      _sum: { total_amount: true },
    });
    return Number(agg._sum.total_amount ?? 0);
  });

/**
 * Payments collected in a window, over the invoices the figure covers. Voided payments and DEPOSIT-invoice payments
 * are left out: an applied deposit is counted once, via its DEPOSIT-CREDIT payment on the STANDARD invoice (the same
 * semantics as the revenue report).
 */
async function collected(ctx: DashContext, paidAt: { gte: Date; lte?: Date }): Promise<number> {
  const inv = await ctx.money('Invoice');
  const agg = await prisma.payment.aggregate({
    where: { paid_at: paidAt, ...COUNTED_PAYMENT_WHERE, invoice: withScope<Prisma.InvoiceWhereInput>({ ...ctx.orgWhere, ...NOT_DEPOSIT }, inv) },
    _sum: { amount: true },
  });
  return Number(agg._sum.amount ?? 0);
}
const collectedMtd = (ctx: DashContext) => ctx.memo('collectedMtd', () => collected(ctx, { gte: ctx.b.monthStart }));

export async function revenueMtd(ctx: DashContext) {
  const { b } = ctx;
  const company = ctx.modeOf('kpi.revenue_mtd') === 'company';
  const [invoiced, collectedNow, lastMonth, target] = await Promise.all([
    invoicedMtd(ctx),
    collectedMtd(ctx),
    collected(ctx, { gte: b.lastMonthStart, lte: b.lastMonthEnd }),
    company ? revenueTarget(ctx) : Promise.resolve(null),
  ]);
  const out: Record<string, number> = {
    invoiced,
    collected: collectedNow,
    collected_last_month: lastMonth,
    vs_last_month_pct: lastMonth > 0 ? Math.round(((collectedNow - lastMonth) / lastMonth) * 100) : 0,
  };
  // The goal and its percentage are the company's plan: they show in company mode only.
  if (target !== null) {
    out.target = target;
    out.pct_of_goal = target > 0 ? Math.round((collectedNow / target) * 100) : 0;
  }
  return out;
}

export async function collectedToday(ctx: DashContext) {
  const { b } = ctx;
  const amount = await collected(ctx, { gte: b.todayStart, lte: b.todayEnd });
  const out: { amount: number; jobs_done?: number } = { amount };
  // The jobs completed today belong to the Jobs category: they are left out, not sent blank, without View jobs.
  if (ctx.has('view_jobs')) {
    const jobScope = await ctx.scope('Job');
    out.jobs_done = await prisma.job.count({
      where: withScope<Prisma.JobWhereInput>(
        { ...ctx.orgWhere, status: { in: [...COMPLETED_OR_LATER_JOB_STATUSES] }, completed_at: { gte: b.todayStart, lte: b.todayEnd } },
        jobScope,
      ),
    });
  }
  return out;
}

/** Unpaid balance and its age buckets. Aging is classified on the org clock, the same rule as the AR Aging report. */
export async function unpaidBalance(ctx: DashContext) {
  return arBuckets(await openInvoices(ctx, await ctx.money('Invoice')), ctx.b.now, ctx.timeZone);
}

/** The unpaid invoices a figure covers (amount and due date). Unpaid Balance and Smart Insights share one read when both cover the company. */
export function openInvoices(ctx: DashContext, scope: Where) {
  return ctx.memo(`openInvoices:${JSON.stringify(scope)}`, () =>
    prisma.invoice.findMany({
      where: withScope<Prisma.InvoiceWhereInput>({ ...ctx.orgWhere, ...arOutstandingWhere }, scope),
      select: { amount_due: true, due_date: true },
    }),
  );
}

/** The unpaid balance split by age, on the org's calendar. Exported for Smart Insights, which asks the same question. */
export function arBuckets(open: { amount_due: unknown; due_date: Date | null }[], now: Date, timeZone: string) {
  let current = 0;
  let over30 = 0;
  let over60 = 0;
  for (const invoice of open) {
    const amt = Number(invoice.amount_due);
    if (!invoice.due_date) {
      current += amt;
      continue;
    }
    // `daysPastDue <= 0` is the same "not yet overdue" rule as `orgTodayStart`.
    const daysPastDue = orgDayDiff(invoice.due_date, now, timeZone);
    if (daysPastDue <= 0) current += amt;
    else if (daysPastDue < 60) over30 += amt;
    else over60 += amt;
  }
  return { total: current + over30 + over60, current, over_30: over30, over_60: over60 };
}

export async function avgTicket(ctx: DashContext) {
  const inv = await ctx.money('Invoice');
  const agg = await prisma.invoice.aggregate({
    where: withScope<Prisma.InvoiceWhereInput>({ ...ctx.orgWhere, ...NOT_DEPOSIT, status: 'PAID', updated_at: { gte: ctx.b.thirtyDaysAgo } }, inv),
    _avg: { total_amount: true },
  });
  return { amount: Math.round(Number(agg._avg.total_amount ?? 0)), period_days: 30 };
}

export async function depositsAwaiting(ctx: DashContext) {
  const inv = await ctx.money('Invoice');
  const agg = await prisma.invoice.aggregate({
    where: withScope<Prisma.InvoiceWhereInput>({ ...ctx.orgWhere, kind: 'DEPOSIT', status: { in: ['SENT', 'PARTIAL'] } }, inv),
    _sum: { amount_due: true },
    _count: { _all: true },
  });
  return { amount: Number(agg._sum.amount_due ?? 0), count: agg._count._all };
}

/** Collected and invoiced per month. A scope narrower than the company is summed row by row; the company in SQL. */
export async function revenueChart(ctx: DashContext) {
  const { b } = ctx;
  const inv = await ctx.money('Invoice');
  const months: Array<{ month: string; invoiced: number; collected: number; is_current: boolean }> = [];
  for (let i = 0; i < b.monthCount; i++) {
    const d = new Date(b.now.getFullYear(), b.now.getMonth() - b.monthCount + 1 + i, 1);
    months.push({
      month: MONTH_NAMES[d.getMonth()]!,
      invoiced: 0,
      collected: 0,
      is_current: d.getFullYear() === b.now.getFullYear() && d.getMonth() === b.now.getMonth(),
    });
  }
  const slot = (d: Date) => (d.getFullYear() - b.chartPeriodStart.getFullYear()) * 12 + (d.getMonth() - b.chartPeriodStart.getMonth());
  const put = (d: Date, key: 'collected' | 'invoiced', amount: number, add: boolean) => {
    const idx = slot(d);
    if (idx >= 0 && idx < months.length) months[idx]![key] = add ? months[idx]![key] + amount : amount;
  };

  if (Object.keys(inv).length === 0) {
    // The whole company: one grouped query each (joined to invoices for the org filter). Exclude voided payments and
    // DEPOSIT-invoice payments, matching the KPI queries.
    const org = ctx.orgWhere.organization_id;
    const [paymentRows, invoiceRows] = await Promise.all([
      prisma.$queryRaw<Array<{ month: Date; collected: string | null }>>`
        SELECT DATE_TRUNC('month', p.paid_at) AS month, SUM(p.amount) AS collected
        FROM payments p
        JOIN invoices i ON p.invoice_id = i.id
        WHERE p.paid_at >= ${b.chartPeriodStart}
          AND p.voided_at IS NULL
          AND p.state = 'SUCCEEDED'
          AND i.kind != 'DEPOSIT'
          AND i.organization_id = ${org}::uuid
        GROUP BY 1
        ORDER BY 1
      `,
      prisma.$queryRaw<Array<{ month: Date; invoiced: string | null }>>`
        SELECT DATE_TRUNC('month', created_at) AS month, SUM(total_amount) AS invoiced
        FROM invoices
        WHERE created_at >= ${b.chartPeriodStart}
          AND status != 'VOIDED'
          AND kind != 'DEPOSIT'
          AND organization_id = ${org}::uuid
        GROUP BY 1
        ORDER BY 1
      `,
    ]);
    for (const row of paymentRows) put(new Date(row.month), 'collected', Number(row.collected ?? 0), false);
    for (const row of invoiceRows) put(new Date(row.month), 'invoiced', Number(row.invoiced ?? 0), false);
  } else {
    const [payments, invoices] = await Promise.all([
      prisma.payment.findMany({
        where: { paid_at: { gte: b.chartPeriodStart }, ...COUNTED_PAYMENT_WHERE, invoice: withScope<Prisma.InvoiceWhereInput>({ ...ctx.orgWhere, ...NOT_DEPOSIT }, inv) },
        select: { paid_at: true, amount: true },
      }),
      prisma.invoice.findMany({
        where: withScope<Prisma.InvoiceWhereInput>({ ...ctx.orgWhere, ...NOT_DEPOSIT, created_at: { gte: b.chartPeriodStart }, status: { not: 'VOIDED' } }, inv),
        select: { created_at: true, total_amount: true },
      }),
    ]);
    for (const p of payments) if (p.paid_at) put(p.paid_at, 'collected', Number(p.amount), true);
    for (const i of invoices) put(i.created_at, 'invoiced', Number(i.total_amount), true);
  }

  const out: { months: typeof months; target?: number } = { months };
  if (ctx.modeOf('revenue_chart') === 'company') out.target = await revenueTarget(ctx);
  return out;
}

/**
 * Lead -> Estimate -> Approved -> Deposit -> Job -> Invoiced -> Paid. Each stage is its own category: it is built only
 * for a person who holds that record's View switch, over that record's scope (or "Yours" without company figures).
 */
export async function pipeline(ctx: DashContext) {
  const { b, orgWhere } = ctx;
  const shown = new Set<string>();
  const input = { leads: 0, estimatesAmount: 0, approvedAmount: 0, depositAmount: 0, jobAmount: 0, invoicedAmount: 0, paidAmount: 0 };
  const work: Promise<void>[] = [];

  if (ctx.has('view_leads')) {
    shown.add('leads');
    work.push((async () => {
      input.leads = await prisma.lead.count({ where: withScope<Prisma.LeadWhereInput>({ ...orgWhere, created_at: { gte: b.monthStart } }, await ctx.scope('Lead')) });
    })());
  }
  if (ctx.has('view_estimates')) {
    shown.add('estimates').add('approved');
    work.push((async () => {
      const est = await ctx.money('Estimate');
      const [issued, approved] = await Promise.all([
        prisma.estimate.aggregate({
          where: withScope<Prisma.EstimateWhereInput>({ ...orgWhere, created_at: { gte: b.monthStart }, status: { notIn: ['DRAFT', ESTIMATE_STATUS.ARCHIVED] } }, est),
          _sum: { total_amount: true },
        }),
        prisma.estimate.aggregate({
          where: withScope<Prisma.EstimateWhereInput>({ ...orgWhere, status: ESTIMATE_STATUS.WON, approved_at: { gte: b.monthStart } }, est),
          _sum: { total_amount: true },
        }),
      ]);
      input.estimatesAmount = Number(issued._sum.total_amount ?? 0);
      input.approvedAmount = Number(approved._sum.total_amount ?? 0);
    })());
  }
  if (ctx.has('view_invoices')) {
    shown.add('deposit').add('invoiced').add('paid');
    work.push((async () => {
      const inv = await ctx.money('Invoice');
      const [deposit, invoiced, paid] = await Promise.all([
        prisma.invoice.aggregate({
          where: withScope<Prisma.InvoiceWhereInput>({ ...orgWhere, kind: 'DEPOSIT', created_at: { gte: b.monthStart } }, inv),
          _sum: { total_amount: true },
        }),
        invoicedMtd(ctx),
        collectedMtd(ctx),
      ]);
      input.depositAmount = Number(deposit._sum.total_amount ?? 0);
      input.invoicedAmount = invoiced;
      input.paidAmount = paid;
    })());
  }
  if (ctx.has('view_jobs')) {
    shown.add('job');
    work.push((async () => {
      const jobs = await ctx.money('Job');
      const agg = await prisma.job.aggregate({
        where: withScope<Prisma.JobWhereInput>({ ...orgWhere, status: { in: [...COMPLETED_OR_LATER_JOB_STATUSES] }, completed_at: { gte: b.monthStart } }, jobs),
        _sum: { amount_invoiced: true },
      });
      input.jobAmount = Number(agg._sum.amount_invoiced ?? 0);
    })());
  }
  await Promise.all(work);
  return linkPipelineStages(buildPipeline(input).filter((stage) => shown.has(stage.key)), ctx.values);
}

/** Recurring plan income: the company's, so only a person with company figures gets it. */
export async function recurring(ctx: DashContext) {
  const plans = await prisma.servicePlan.findMany({
    where: { ...ctx.orgWhere, status: 'ACTIVE' },
    select: { contract_price: true, start_date: true, end_date: true },
  });
  // MRR = contract_price normalized to a monthly figure over the plan's term.
  const MONTH_MS = 30 * 86_400_000;
  let mrr = 0;
  for (const p of plans) {
    // Open-ended plans (no end date) have no finite term to normalize against: they count as active but add no
    // term-based MRR until a cadence-based model lands.
    if (p.end_date === null) continue;
    const termMs = p.end_date.getTime() - p.start_date.getTime();
    const months = termMs > 0 ? termMs / MONTH_MS : 1;
    mrr += Number(p.contract_price) / Math.max(months, 1);
  }
  return buildRecurring({ active_plans: plans.length, mrr });
}

/** Revenue per job type: the company's mix, so only a person with company figures gets it. */
export async function revenueByJobType(ctx: DashContext) {
  const jobs = await prisma.job.findMany({
    where: { ...ctx.orgWhere, status: { in: [...COMPLETED_OR_LATER_JOB_STATUSES] }, estimate_id: { not: null } },
    select: { amount_invoiced: true, estimate: { select: { job_type: true } } },
  });
  const byType = new Map<string, number>();
  for (const j of jobs) {
    const jt = j.estimate?.job_type;
    if (jt) byType.set(jt, (byType.get(jt) ?? 0) + Number(j.amount_invoiced ?? 0));
  }
  return buildRevenueByJobType([...byType.entries()].map(([job_type, revenue]) => ({ job_type, revenue })));
}
