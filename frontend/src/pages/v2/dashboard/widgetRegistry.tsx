import { WIDGETS } from '@/components/dashboard/widgetRegistry';
import type { WidgetDef } from '@/lib/dashboard/layoutTypes';

import SmartInsights from './widgets/smartInsights';
import NeedsAttention from './widgets/needsAttention';
import TodaySchedule from './widgets/todaySchedule';
import RevenueChart from './widgets/revenueChart';
import PipelineFunnel from './widgets/pipelineFunnel';
import { RankedBarList, LeadSourcesWidget } from './widgets/scoreboards';
import { JobsByStatus, RevenueByJobType, ComingUp, UnscheduledJobs, OfficeReviewQueue, MissingCrew, EstimatesToSend, MissingLeadOwner, RecentActivity, ComingSoon } from './widgets/catalog';
import { opener } from '@/lib/dashboard/opener';

/**
 * v2 RENDER functions, keyed by the SAME widget id the legacy registry uses.
 *
 * Only `render` is listed here. Everything else about a widget - its id, title,
 * category, `defaultSize`, `defaultVisible` - is METADATA that the layout
 * system persists and the catalog drawer groups by, and it is read from the
 * legacy registry below rather than restated. That separation is the whole
 * point: an id is a localStorage key fragment, and a second hand-maintained
 * copy of these twenty-eight strings is exactly how a user's saved layout gets
 * silently wiped.
 *
 * An id absent from this map keeps its legacy render. That is how the ten
 * `kpi.*` widgets work today (each reads its own entry of the server's answer, `data[id]`): `KpiCard` has no kit equivalent (the kit's
 * `statCard` carries no meta line and no icon - see the ledger), so the tiles
 * are reused as they are rather than rebuilt at the cost of their second line.
 */
const V2_RENDER: Record<string, WidgetDef['render']> = {
  smart_insights: ({ data, navigate }) => <SmartInsights insights={data?.smart_insights} navigate={navigate} />,
  needs_attention: ({ data, navigate, isLoading }) => <NeedsAttention items={data?.needs_attention ?? []} navigate={navigate} isLoading={isLoading} />,
  schedule_today: ({ data, tile, navigate, isLoading }) => <TodaySchedule data={data?.schedule_today ?? []} calendarLink={tile?.link} navigate={navigate} isLoading={isLoading} />,
  // The goal line is the company's plan: the server sends a target in company mode only, and the chart draws none without it.
  revenue_chart: ({ data, tile, navigate, isLoading }) => <RevenueChart data={data?.revenue_chart?.months ?? []} target={data?.revenue_chart?.target} scopeLabel={tile?.label} onViewAll={opener(tile?.link, navigate)} isLoading={isLoading} />,
  pipeline: ({ data, tile, navigate, isLoading }) => <PipelineFunnel stages={data?.pipeline ?? []} navigate={navigate} scopeLabel={tile?.label} isLoading={isLoading} />,
  // Both boards open the page the server sent for the tile and DISCARD the clicked entry - there is no
  // per-user jobs view to send them to. Carried over exactly.
  tech_scoreboard: ({ data, tile, navigate, isLoading }) => <RankedBarList title="Tech Scoreboard" icon="🔧" entries={data?.tech_scoreboard ?? []} onRowClick={opener(tile?.link, navigate)} isLoading={isLoading} />,
  dispatch_scoreboard: ({ data, tile, navigate, isLoading }) => <RankedBarList title="Dispatch Scoreboard" icon="🎧" entries={data?.dispatch_scoreboard ?? []} onRowClick={opener(tile?.link, navigate)} isLoading={isLoading} />,
  lead_sources: ({ data, navigate, isLoading }) => <LeadSourcesWidget sources={data?.lead_sources ?? []} navigate={navigate} isLoading={isLoading} />,
  jobs_by_status: ({ data, tile, navigate, isLoading }) => <JobsByStatus slices={data?.jobs_by_status ?? []} onViewAll={opener(tile?.link, navigate)} isLoading={isLoading} />,
  revenue_by_job_type: ({ data, tile, navigate, isLoading }) => <RevenueByJobType slices={data?.revenue_by_job_type ?? []} onReport={opener(tile?.link, navigate)} isLoading={isLoading} />,
  coming_up: ({ data, tile, navigate, isLoading }) => <ComingUp jobs={data?.coming_up ?? []} onViewAll={opener(tile?.link, navigate)} navigate={navigate} isLoading={isLoading} />,
  unscheduled_jobs: ({ data, tile, navigate, isLoading }) => <UnscheduledJobs data={data?.unscheduled_jobs} onViewAll={opener(tile?.link, navigate)} navigate={navigate} isLoading={isLoading} />,
  office_review_queue: ({ data, tile, navigate, isLoading }) => <OfficeReviewQueue data={data?.office_review_queue} onViewAll={opener(tile?.link, navigate)} navigate={navigate} isLoading={isLoading} />,
  missing_crew: ({ data, tile, navigate, isLoading }) => <MissingCrew data={data?.missing_crew} onViewAll={opener(tile?.link, navigate)} navigate={navigate} isLoading={isLoading} />,
  estimates_to_send: ({ data, tile, navigate, isLoading }) => <EstimatesToSend data={data?.estimates_to_send} onViewAll={opener(tile?.link, navigate)} navigate={navigate} isLoading={isLoading} />,
  missing_lead_owner: ({ data, tile, navigate, isLoading }) => <MissingLeadOwner data={data?.missing_lead_owner} onViewAll={opener(tile?.link, navigate)} navigate={navigate} isLoading={isLoading} />,
  recent_activity: ({ data, isLoading }) => <RecentActivity events={data?.recent_activity ?? []} isLoading={isLoading} />,
  service_areas: () => <ComingSoon title="Service Areas" />,
  recent_calls: () => <ComingSoon title="Recent Calls" />,
};

/**
 * The registry the v2 page renders from: the legacy one with kit renders
 * swapped in.
 *
 * Derived, never forked. `WIDGETS` stays the single source of which widgets
 * exist and what they are called, so this map cannot drift from the one
 * `CatalogDrawer` lists and `DEFAULT_LAYOUT` orders, and a widget added or
 * retired there reaches this page with no edit here at all.
 */
export const V2_WIDGETS: Record<string, WidgetDef> = Object.fromEntries(
  Object.entries(WIDGETS).map(([id, def]) => {
    const render = V2_RENDER[id];
    return [id, render ? { ...def, render } : def];
  }),
);
