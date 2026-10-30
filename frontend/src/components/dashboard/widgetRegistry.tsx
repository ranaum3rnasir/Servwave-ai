import { DollarSign, CircleDollarSign, Repeat, AlertTriangle, TrendingUp, Briefcase, Filter, Receipt, CalendarDays, CalendarRange, ClipboardCheck, Layers } from 'lucide-react';
import KpiCard from './widgets/KpiCard';
import SmartInsights from './widgets/SmartInsights';
import PipelineFunnel from './widgets/PipelineFunnel';
import NeedsAttention from './widgets/NeedsAttention';
import TodaySchedule from './widgets/TodaySchedule';
import RevenueChart from './widgets/RevenueChart';
import { RankedBarList, LeadSourcesWidget } from './widgets/Scoreboards';
import { JobsByStatus, RevenueByJobType, ComingUp, UnscheduledJobs, OfficeReviewQueue, MissingCrew, EstimatesToSend, MissingLeadOwner, RecentActivity, ComingSoon } from './widgets/Catalog';
import { money0 } from './widgets/_shared';
import { opener } from '@/lib/dashboard/opener';
import type { WidgetDef } from '@/lib/dashboard/layoutTypes';

const pill = (text: string, cls: string) => (
  <span className={`inline-block px-1.5 py-0.5 rounded-[4px] text-[11px] font-semibold ${cls}`}>{text}</span>
);

export const WIDGETS: Record<string, WidgetDef> = {
  // The server decides which tiles a person has and sends each one's data keyed by its id; a tile's render reads
  // `data[id]`. The page draws only tiles the server sent, so a render never has to guess whether a tile is allowed.
  // ── Primary KPIs ──
  'kpi.revenue_mtd': {
    id: 'kpi.revenue_mtd', title: 'Monthly Revenue', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, tile, navigate, isLoading }) => {
      const d = data?.['kpi.revenue_mtd'];
      return (
        <KpiCard icon={<DollarSign className="h-5 w-5 text-sage-700" />} iconBg="bg-sage-50"
          label="Monthly Revenue" scopeLabel={tile?.label} value={money0(d?.collected ?? 0)}
          delta={{ value: d?.vs_last_month_pct ?? 0, good: (d?.vs_last_month_pct ?? 0) >= 0, suffix: '%' }}
          // The goal is the company's plan: the server sends it in company mode only.
          meta={d?.target !== undefined ? `${d.pct_of_goal ?? 0}% of ${money0(d.target)} goal` : `${money0(d?.invoiced ?? 0)} invoiced`}
          empty={d && d.collected === 0 && d.invoiced === 0 ? 'No payments or invoices this month' : undefined}
          onClick={opener(tile?.link, navigate)} loading={isLoading} />
      );
    },
  },
  'kpi.collected_today': {
    id: 'kpi.collected_today', title: 'Collected Today', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, tile, navigate, isLoading }) => {
      const d = data?.['kpi.collected_today'];
      return (
        <KpiCard icon={<CircleDollarSign className="h-5 w-5 text-sage-700" />} iconBg="bg-sage-50"
          label="Collected Today" scopeLabel={tile?.label} value={money0(d?.amount ?? 0)}
          // The jobs count belongs to the Jobs category: the server leaves it off for a person who may not view jobs.
          meta={d?.jobs_done !== undefined ? `${d.jobs_done} ${d.jobs_done === 1 ? 'job' : 'jobs'} completed` : undefined}
          empty={d && d.amount === 0 && !d.jobs_done ? 'No payments today' : undefined}
          onClick={opener(tile?.link, navigate)} loading={isLoading} />
      );
    },
  },
  'kpi.recurring': {
    id: 'kpi.recurring', title: 'Recurring (Plans)', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, tile, navigate, isLoading }) => {
      const r = data?.['kpi.recurring'];
      // No active plans is a plain line, not a missing tile: the person put it on their page, so it says why it is empty.
      return (
        <KpiCard icon={<Repeat className="h-5 w-5 text-sage-700" />} iconBg="bg-sage-50"
          label="Recurring (Plans)" value={`${money0(r?.mrr ?? 0)}/mo`} valueClass="text-sage-700"
          meta={`${r?.active_plans ?? 0} active ${r?.active_plans === 1 ? 'plan' : 'plans'}`} empty={!r && data !== undefined ? 'No active plans' : undefined}
          onClick={opener(tile?.link, navigate)} loading={isLoading} />
      );
    },
  },
  'kpi.ar': {
    id: 'kpi.ar', title: 'Unpaid Balance', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, tile, navigate, isLoading }) => {
      const ar = data?.['kpi.ar'];
      const pastDue = (ar?.over_30 ?? 0) + (ar?.over_60 ?? 0);
      return (
        <KpiCard icon={<AlertTriangle className="h-5 w-5 text-warning" />} iconBg="bg-warning/10"
          label="Unpaid Balance" scopeLabel={tile?.label} value={money0(ar?.total ?? 0)} valueClass="text-warning"
          meta={pastDue > 0 ? pill(`${money0(pastDue)} past due`, 'bg-danger-surface text-danger-text') : undefined}
          empty={ar && ar.total === 0 ? 'Nothing unpaid' : undefined}
          onClick={opener(tile?.link, navigate)} loading={isLoading} />
      );
    },
  },
  'kpi.close_rate': {
    id: 'kpi.close_rate', title: 'Close Rate', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, tile, navigate, isLoading }) => {
      const d = data?.['kpi.close_rate'];
      return (
        <KpiCard icon={<TrendingUp className="h-5 w-5 text-sage-700" />} iconBg="bg-sage-50"
          label="Close Rate" value={`${d?.rate ?? 0}%`}
          delta={{ value: d?.vs_last_period_pp ?? 0, good: (d?.vs_last_period_pp ?? 0) >= 0, suffix: 'pp' }}
          meta={`${d?.won ?? 0} won · ${d?.lost ?? 0} lost · 30d`}
          empty={d && d.won === 0 && d.lost === 0 ? 'No closed leads in the last 30 days' : undefined}
          onClick={opener(tile?.link, navigate)} loading={isLoading} />
      );
    },
  },
  'kpi.jobs_today': {
    id: 'kpi.jobs_today', title: 'Jobs Today', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, tile, navigate, isLoading }) => {
      const d = data?.['kpi.jobs_today'];
      return (
        <KpiCard icon={<Briefcase className="h-5 w-5 text-primary" />} iconBg="bg-primary-subtle"
          label="Jobs Today" value={String(d?.total ?? 0)}
          delta={{ value: d?.vs_yesterday ?? 0, good: (d?.vs_yesterday ?? 0) >= 0 }}
          meta={`${d?.scheduled ?? 0} scheduled · ${d?.completed ?? 0} completed`}
          empty={d && d.total === 0 ? 'No jobs today' : undefined}
          onClick={opener(tile?.link, navigate)} loading={isLoading} />
      );
    },
  },
  // ── Secondary KPIs ──
  'kpi.open_leads': {
    id: 'kpi.open_leads', title: 'Open Leads', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, tile, navigate, isLoading }) => {
      const d = data?.['kpi.open_leads'];
      return (
        <KpiCard icon={<Filter className="h-5 w-5 text-primary" />} iconBg="bg-primary-subtle"
          label="Open Leads" value={String(d?.count ?? 0)}
          meta={`${d?.no_owner ?? 0} with no owner`} empty={d && d.count === 0 ? 'No open leads' : undefined}
          onClick={opener(tile?.link, navigate)} loading={isLoading} />
      );
    },
  },
  'kpi.avg_ticket': {
    id: 'kpi.avg_ticket', title: 'Avg Ticket', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, tile, navigate, isLoading }) => {
      const d = data?.['kpi.avg_ticket'];
      return (
        <KpiCard icon={<Receipt className="h-5 w-5 text-text-secondary" />} iconBg="bg-border-soft"
          label="Avg Ticket" scopeLabel={tile?.label} value={money0(d?.amount ?? 0)}
          meta={`completed jobs · ${d?.period_days ?? 30}d`} empty={d && d.amount === 0 ? `No paid invoices in the last ${d.period_days ?? 30} days` : undefined}
          onClick={opener(tile?.link, navigate)} loading={isLoading} />
      );
    },
  },
  'kpi.jobs_week': {
    id: 'kpi.jobs_week', title: 'Jobs This Week', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, tile, navigate, isLoading }) => {
      const d = data?.['kpi.jobs_week'];
      return (
        <KpiCard icon={<CalendarDays className="h-5 w-5 text-primary" />} iconBg="bg-primary-subtle"
          label="Jobs This Week" value={String(d?.completed ?? 0)}
          meta={`of ${d?.scheduled ?? 0} scheduled`} empty={d && d.scheduled === 0 && d.completed === 0 ? 'No jobs this week' : undefined}
          onClick={opener(tile?.link, navigate)} loading={isLoading} />
      );
    },
  },
  'kpi.deposits': {
    id: 'kpi.deposits', title: 'Deposits Awaiting', defaultSize: 'kpi', defaultVisible: true,
    render: ({ data, tile, navigate, isLoading }) => {
      const d = data?.['kpi.deposits'];
      return (
        <KpiCard icon={<Layers className="h-5 w-5 text-warning" />} iconBg="bg-warning/10"
          label="Deposits Awaiting" scopeLabel={tile?.label} value={money0(d?.amount ?? 0)} valueClass="text-warning"
          meta={`${d?.count ?? 0} requested, unpaid`} empty={d && d.count === 0 ? 'No deposits awaiting' : undefined}
          onClick={opener(tile?.link, navigate)} loading={isLoading} />
      );
    },
  },
  // ── Bands ──
  smart_insights: {
    id: 'smart_insights', title: 'Smart Insights', defaultSize: 'full', defaultVisible: true,
    render: ({ data, navigate }) => <SmartInsights insights={data?.smart_insights} navigate={navigate} />,
  },
  needs_attention: {
    id: 'needs_attention', title: 'Needs Attention', defaultSize: 'half', defaultVisible: true,
    render: ({ data, navigate }) => <NeedsAttention items={data?.needs_attention ?? []} navigate={navigate} />,
  },
  schedule_today: {
    id: 'schedule_today', title: "Today's Schedule", defaultSize: 'half', defaultVisible: true,
    render: ({ data, tile, navigate }) => <TodaySchedule data={data?.schedule_today ?? []} calendarLink={tile?.link} navigate={navigate} />,
  },
  revenue_chart: {
    id: 'revenue_chart', title: 'Monthly Revenue', defaultSize: 'half', defaultVisible: true,
    render: ({ data }) => <RevenueChart data={data?.revenue_chart?.months ?? []} target={data?.revenue_chart?.target ?? 0} />,
  },
  pipeline: {
    id: 'pipeline', title: 'Revenue Pipeline', defaultSize: 'half', defaultVisible: true,
    render: ({ data, navigate }) => <PipelineFunnel stages={data?.pipeline ?? []} navigate={navigate} />,
  },
  tech_scoreboard: {
    id: 'tech_scoreboard', title: 'Tech Scoreboard', defaultSize: 'third', defaultVisible: true,
    render: ({ data, tile, navigate }) => <RankedBarList title="Tech Scoreboard" icon="🔧" entries={data?.tech_scoreboard ?? []} onRowClick={() => tile?.link && navigate(tile.link)} />,
  },
  dispatch_scoreboard: {
    id: 'dispatch_scoreboard', title: 'Dispatch Scoreboard', defaultSize: 'third', defaultVisible: true,
    render: ({ data, tile, navigate }) => <RankedBarList title="Dispatch Scoreboard" icon="🎧" entries={data?.dispatch_scoreboard ?? []} onRowClick={() => tile?.link && navigate(tile.link)} />,
  },
  lead_sources: {
    id: 'lead_sources', title: 'Top Lead Sources', defaultSize: 'third', defaultVisible: true,
    render: ({ data, navigate }) => <LeadSourcesWidget sources={data?.lead_sources ?? []} navigate={navigate} />,
  },
  // ── Catalog (hidden by default; added from the drawer) ──
  jobs_by_status: {
    id: 'jobs_by_status', title: 'Jobs by Status', defaultSize: 'third', defaultVisible: false,
    render: ({ data, tile, navigate }) => <JobsByStatus slices={data?.jobs_by_status ?? []} link={tile?.link} navigate={navigate} />,
  },
  revenue_by_job_type: {
    id: 'revenue_by_job_type', title: 'Revenue by Job Type', defaultSize: 'third', defaultVisible: true,
    render: ({ data, tile, navigate }) => <RevenueByJobType slices={data?.revenue_by_job_type ?? []} link={tile?.link} navigate={navigate} />,
  },
  coming_up: {
    id: 'coming_up', title: 'Coming Up', defaultSize: 'third', defaultVisible: false,
    render: ({ data, tile, navigate }) => <ComingUp jobs={data?.coming_up ?? []} link={tile?.link} navigate={navigate} />,
  },
  unscheduled_jobs: {
    id: 'unscheduled_jobs', title: 'Unscheduled jobs', defaultSize: 'third', defaultVisible: false,
    render: ({ data, tile, navigate }) => <UnscheduledJobs data={data?.unscheduled_jobs} link={tile?.link} navigate={navigate} />,
  },
  office_review_queue: {
    id: 'office_review_queue', title: 'Office review queue', defaultSize: 'third', defaultVisible: false,
    render: ({ data, tile, navigate }) => <OfficeReviewQueue data={data?.office_review_queue} link={tile?.link} navigate={navigate} />,
  },
  missing_crew: {
    id: 'missing_crew', title: 'Missing crew', defaultSize: 'third', defaultVisible: false,
    render: ({ data, tile, navigate }) => <MissingCrew data={data?.missing_crew} link={tile?.link} navigate={navigate} />,
  },
  jobs_this_month: {
    id: 'jobs_this_month', title: 'Jobs this month', defaultSize: 'kpi', defaultVisible: false,
    render: ({ data, tile, navigate, isLoading }) => {
      const d = data?.jobs_this_month;
      // Visits are "finished" and "still to do"; "completed" and "done" name a whole job, which a finished visit never completes.
      return (
        <KpiCard icon={<CalendarRange className="h-5 w-5 text-primary" />} iconBg="bg-primary-subtle"
          label="Jobs this month" scopeLabel={tile?.label} value={String(d?.jobs ?? 0)}
          meta={`${d?.finished ?? 0} finished · ${d?.still_to_do ?? 0} still to do`}
          empty={d && d.jobs === 0 ? 'No jobs this month' : undefined}
          onClick={opener(tile?.link, navigate)} loading={isLoading} />
      );
    },
  },
  completed_jobs_value: {
    id: 'completed_jobs_value', title: 'Completed jobs value', defaultSize: 'kpi', defaultVisible: false,
    render: ({ data, tile, navigate, isLoading }) => {
      const d = data?.completed_jobs_value;
      // A job is "completed" as a whole; the label the server sends says whose jobs these are ("Yours", or none for the company's).
      return (
        <KpiCard icon={<ClipboardCheck className="h-5 w-5 text-sage-700" />} iconBg="bg-sage-50"
          label="Completed jobs value" scopeLabel={tile?.label} value={money0(d?.value ?? 0)}
          meta={`${d?.jobs ?? 0} ${d?.jobs === 1 ? 'job' : 'jobs'}`}
          empty={d && d.jobs === 0 ? 'No jobs completed this month' : undefined}
          onClick={opener(tile?.link, navigate)} loading={isLoading} />
      );
    },
  },
  estimates_to_send: {
    id: 'estimates_to_send', title: 'Estimates still to send', defaultSize: 'third', defaultVisible: false,
    render: ({ data, tile, navigate }) => <EstimatesToSend data={data?.estimates_to_send} link={tile?.link} navigate={navigate} />,
  },
  missing_lead_owner: {
    id: 'missing_lead_owner', title: 'Missing lead owner', defaultSize: 'third', defaultVisible: false,
    render: ({ data, tile, navigate }) => <MissingLeadOwner data={data?.missing_lead_owner} link={tile?.link} navigate={navigate} />,
  },
  recent_activity: {
    id: 'recent_activity', title: 'Recent Activity', defaultSize: 'third', defaultVisible: false,
    render: ({ data }) => <RecentActivity events={data?.recent_activity ?? []} />,
  },
  service_areas: {
    id: 'service_areas', title: 'Service Areas', defaultSize: 'third', defaultVisible: false,
    render: () => <ComingSoon title="Service Areas" />,
  },
  recent_calls: {
    id: 'recent_calls', title: 'Recent Calls', defaultSize: 'third', defaultVisible: false,
    render: () => <ComingSoon title="Recent Calls" />,
  },
};
