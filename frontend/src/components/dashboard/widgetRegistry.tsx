import { DollarSign, CircleDollarSign, Repeat, AlertTriangle, TrendingUp, Briefcase, Filter, Receipt, CalendarDays, Layers } from 'lucide-react';
import KpiCard from './widgets/KpiCard';
import SmartInsights from './widgets/SmartInsights';
import PipelineFunnel from './widgets/PipelineFunnel';
import NeedsAttention from './widgets/NeedsAttention';
import TodaySchedule from './widgets/TodaySchedule';
import RevenueChart from './widgets/RevenueChart';
import { RankedBarList, LeadSourcesWidget } from './widgets/Scoreboards';
import { JobsByStatus, RevenueByJobType, ComingUp, RecentActivity, ComingSoon } from './widgets/Catalog';
import { money0 } from './widgets/_shared';
import type { WidgetDef } from '@/lib/dashboard/layoutTypes';

const pill = (text: string, cls: string) => (
  <span className={`inline-block px-1.5 py-0.5 rounded-[4px] text-[11px] font-semibold ${cls}`}>{text}</span>
);

export const WIDGETS: Record<string, WidgetDef> = {
  // ── Primary KPIs ──
  'kpi.revenue_mtd': {
    id: 'kpi.revenue_mtd', title: 'Monthly Revenue', category: 'KPI', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, navigate }) => (
      <KpiCard icon={<DollarSign className="h-5 w-5 text-sage-700" />} iconBg="bg-sage-50"
        label="Monthly Revenue" value={money0(data?.kpis?.revenue_mtd?.collected ?? 0)}
        delta={{ value: data?.kpis?.revenue_mtd?.vs_last_month_pct ?? 0, good: (data?.kpis?.revenue_mtd?.vs_last_month_pct ?? 0) >= 0, suffix: '%' }}
        meta={`${data?.kpis?.revenue_mtd?.pct_of_goal ?? 0}% of ${money0(data?.kpis?.revenue_mtd?.target ?? 0)} goal`}
        onClick={() => navigate('/invoices')} />
    ),
  },
  'kpi.collected_today': {
    id: 'kpi.collected_today', title: 'Collected Today', category: 'KPI', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, navigate }) => (
      <KpiCard icon={<CircleDollarSign className="h-5 w-5 text-sage-700" />} iconBg="bg-sage-50"
        label="Collected Today" value={money0(data?.kpis?.collected_today?.amount ?? 0)}
        meta={`${data?.kpis?.collected_today?.jobs_done ?? 0} jobs done`} onClick={() => navigate('/reports/payments')} />
    ),
  },
  'kpi.recurring': {
    id: 'kpi.recurring', title: 'Recurring (Plans)', category: 'KPI', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, navigate }) => {
      const r = data?.kpis?.recurring;
      if (!r) return null; // degrade when Service Plans data unavailable
      return (
        <KpiCard icon={<Repeat className="h-5 w-5 text-sage-700" />} iconBg="bg-sage-50"
          label="Recurring (Plans)" value={`${money0(r.mrr)}/mo`} valueClass="text-sage-700"
          meta={`${r.active_plans} active plans`} onClick={() => navigate('/service-plans')} />
      );
    },
  },
  'kpi.ar': {
    id: 'kpi.ar', title: 'Unpaid Balance', category: 'KPI', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, navigate }) => {
      const pastDue = (data?.kpis?.ar?.over_30 ?? 0) + (data?.kpis?.ar?.over_60 ?? 0);
      return (
        <KpiCard icon={<AlertTriangle className="h-5 w-5 text-warning" />} iconBg="bg-warning/10"
          label="Unpaid Balance" value={money0(data?.kpis?.ar?.total ?? 0)} valueClass="text-warning"
          meta={pastDue > 0 ? pill(`${money0(pastDue)} past due`, 'bg-danger/10 text-danger') : undefined}
          onClick={() => navigate('/reports/unpaid-invoices')} />
      );
    },
  },
  'kpi.close_rate': {
    id: 'kpi.close_rate', title: 'Close Rate', category: 'KPI', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, navigate }) => (
      <KpiCard icon={<TrendingUp className="h-5 w-5 text-sage-700" />} iconBg="bg-sage-50"
        label="Close Rate" value={`${data?.kpis?.close_rate?.rate ?? 0}%`}
        delta={{ value: data?.kpis?.close_rate?.vs_last_period_pp ?? 0, good: (data?.kpis?.close_rate?.vs_last_period_pp ?? 0) >= 0, suffix: 'pp' }}
        meta={`${data?.kpis?.close_rate?.won ?? 0} won · ${data?.kpis?.close_rate?.lost ?? 0} lost · 30d`}
        onClick={() => navigate('/reports/estimate-conversion')} />
    ),
  },
  'kpi.jobs_today': {
    id: 'kpi.jobs_today', title: 'Jobs Today', category: 'KPI', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, navigate }) => (
      <KpiCard icon={<Briefcase className="h-5 w-5 text-primary" />} iconBg="bg-primary-subtle"
        label="Jobs Today" value={String(data?.kpis?.jobs_today?.total ?? 0)}
        delta={{ value: data?.kpis?.jobs_today?.vs_yesterday ?? 0, good: (data?.kpis?.jobs_today?.vs_yesterday ?? 0) >= 0 }}
        meta={`${data?.kpis?.jobs_today?.scheduled ?? 0} scheduled · ${data?.kpis?.jobs_today?.completed ?? 0} completed`}
        onClick={() => navigate('/schedule')} />
    ),
  },
  // ── Secondary KPIs ──
  'kpi.open_leads': {
    id: 'kpi.open_leads', title: 'Open Leads', category: 'KPI', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, navigate }) => (
      <KpiCard icon={<Filter className="h-5 w-5 text-primary" />} iconBg="bg-primary-subtle"
        label="Open Leads" value={String(data?.kpis?.leads_open?.count ?? 0)}
        meta={`${data?.kpis?.leads_open?.unassigned ?? 0} unassigned`} onClick={() => navigate('/leads')} />
    ),
  },
  'kpi.avg_ticket': {
    id: 'kpi.avg_ticket', title: 'Avg Ticket', category: 'KPI', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, navigate }) => (
      <KpiCard icon={<Receipt className="h-5 w-5 text-text-secondary" />} iconBg="bg-border-soft"
        label="Avg Ticket" value={money0(data?.kpis?.avg_ticket?.amount ?? 0)}
        meta={`completed jobs · ${data?.kpis?.avg_ticket?.period_days ?? 30}d`} onClick={() => navigate('/reports')} />
    ),
  },
  'kpi.jobs_week': {
    id: 'kpi.jobs_week', title: 'Jobs This Week', category: 'KPI', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, navigate }) => (
      <KpiCard icon={<CalendarDays className="h-5 w-5 text-primary" />} iconBg="bg-primary-subtle"
        label="Jobs This Week" value={String(data?.kpis?.jobs_week?.completed ?? 0)}
        meta={`of ${data?.kpis?.jobs_week?.scheduled ?? 0} scheduled`} onClick={() => navigate('/jobs')} />
    ),
  },
  'kpi.deposits': {
    id: 'kpi.deposits', title: 'Deposits Awaiting', category: 'KPI', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, navigate }) => (
      <KpiCard icon={<Layers className="h-5 w-5 text-warning" />} iconBg="bg-warning/10"
        label="Deposits Awaiting" value={money0(data?.kpis?.deposits_awaiting?.amount ?? 0)} valueClass="text-warning"
        meta={`${data?.kpis?.deposits_awaiting?.count ?? 0} requested, unpaid`} onClick={() => navigate('/estimates')} />
    ),
  },
  // ── Bands ──
  smart_insights: {
    id: 'smart_insights', title: 'Smart Insights', category: 'Sales', defaultSize: 'full', defaultVisible: true,
    render: ({ data, navigate }) => <SmartInsights data={data} navigate={navigate} />,
  },
  needs_attention: {
    id: 'needs_attention', title: 'Needs Attention', category: 'Operations', defaultSize: 'half', defaultVisible: true,
    render: ({ data, navigate }) => <NeedsAttention items={data?.needs_attention ?? []} navigate={navigate} />,
  },
  schedule_today: {
    id: 'schedule_today', title: "Today's Schedule", category: 'Operations', defaultSize: 'half', defaultVisible: true,
    render: ({ data, navigate }) => <TodaySchedule data={data?.schedule_today ?? []} navigate={navigate} />,
  },
  revenue_chart: {
    id: 'revenue_chart', title: 'Monthly Revenue', category: 'Financial', defaultSize: 'half', defaultVisible: true,
    render: ({ data }) => <RevenueChart data={data?.revenue_chart ?? []} target={data?.kpis?.revenue_mtd?.target ?? 0} />,
  },
  pipeline: {
    id: 'pipeline', title: 'Revenue Pipeline', category: 'Pipeline', defaultSize: 'half', defaultVisible: true,
    render: ({ data, navigate }) => <PipelineFunnel stages={data?.pipeline ?? []} navigate={navigate} />,
  },
  tech_scoreboard: {
    id: 'tech_scoreboard', title: 'Tech Scoreboard', category: 'Team', defaultSize: 'third', defaultVisible: true,
    render: ({ data, navigate }) => <RankedBarList title="Tech Scoreboard" icon="🔧" entries={data?.tech_scoreboard ?? []} onRowClick={() => navigate('/jobs')} />,
  },
  dispatch_scoreboard: {
    id: 'dispatch_scoreboard', title: 'Dispatch Scoreboard', category: 'Team', defaultSize: 'third', defaultVisible: true,
    render: ({ data, navigate }) => <RankedBarList title="Dispatch Scoreboard" icon="🎧" entries={data?.dispatch_scoreboard ?? []} onRowClick={() => navigate('/jobs')} />,
  },
  lead_sources: {
    id: 'lead_sources', title: 'Top Lead Sources', category: 'Sales', defaultSize: 'third', defaultVisible: true,
    render: ({ data, navigate }) => <LeadSourcesWidget sources={data?.lead_sources ?? []} navigate={navigate} />,
  },
  // ── Catalog (hidden by default; added from the drawer) ──
  jobs_by_status: {
    id: 'jobs_by_status', title: 'Jobs by Status', category: 'Operations', defaultSize: 'third', defaultVisible: false,
    render: ({ data, navigate }) => <JobsByStatus slices={data?.jobs_by_status ?? []} navigate={navigate} />,
  },
  revenue_by_job_type: {
    id: 'revenue_by_job_type', title: 'Revenue by Job Type', category: 'Sales', defaultSize: 'third', defaultVisible: true,
    render: ({ data, navigate }) => <RevenueByJobType slices={data?.revenue_by_job_type ?? []} navigate={navigate} />,
  },
  coming_up: {
    id: 'coming_up', title: 'Coming Up', category: 'Operations', defaultSize: 'third', defaultVisible: false,
    render: ({ data, navigate }) => <ComingUp jobs={data?.coming_up ?? []} navigate={navigate} />,
  },
  recent_activity: {
    id: 'recent_activity', title: 'Recent Activity', category: 'Operations', defaultSize: 'third', defaultVisible: false,
    render: ({ data }) => <RecentActivity events={data?.activity ?? []} />,
  },
  service_areas: {
    id: 'service_areas', title: 'Service Areas', category: 'Operations', defaultSize: 'third', defaultVisible: false,
    render: () => <ComingSoon title="Service Areas" />,
  },
  recent_calls: {
    id: 'recent_calls', title: 'Recent Calls', category: 'Operations', defaultSize: 'third', defaultVisible: false,
    render: () => <ComingSoon title="Recent Calls" />,
  },
};
