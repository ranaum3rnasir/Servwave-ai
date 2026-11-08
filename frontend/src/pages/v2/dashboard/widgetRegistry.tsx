import { WIDGETS } from '@/components/dashboard/widgetRegistry';
import type { WidgetDef } from '@/lib/dashboard/layoutTypes';

import SmartInsights from './widgets/smartInsights';
import NeedsAttention from './widgets/needsAttention';
import TodaySchedule from './widgets/todaySchedule';
import RevenueChart from './widgets/revenueChart';
import PipelineFunnel from './widgets/pipelineFunnel';
import { RankedBarList, LeadSourcesWidget } from './widgets/scoreboards';
import { JobsByStatus, RevenueByJobType, ComingUp, RecentActivity, ComingSoon } from './widgets/catalog';
import { preferV2Path } from '../uiV2';

/**
 * v2 RENDER functions, keyed by the SAME widget id the legacy registry uses.
 *
 * Only `render` is listed here. Everything else about a widget - its id, title,
 * category, `defaultSize`, `defaultVisible` - is METADATA that the layout
 * system persists and the catalog drawer groups by, and it is read from the
 * legacy registry below rather than restated. That separation is the whole
 * point: an id is a localStorage key fragment, and a second hand-maintained
 * copy of these twenty-four strings is exactly how a user's saved layout gets
 * silently wiped.
 *
 * An id absent from this map keeps its legacy render. That is how the ten
 * `kpi.*` widgets work today: `KpiCard` has no kit equivalent (the kit's
 * `statCard` carries no meta line and no icon - see the ledger), so the tiles
 * are reused as they are rather than rebuilt at the cost of their second line.
 */
const V2_RENDER: Record<string, WidgetDef['render']> = {
  smart_insights: ({ data, navigate }) => <SmartInsights data={data} navigate={navigate} />,
  needs_attention: ({ data, navigate }) => <NeedsAttention items={data?.needs_attention ?? []} navigate={navigate} />,
  schedule_today: ({ data, navigate }) => <TodaySchedule data={data?.schedule_today ?? []} navigate={navigate} />,
  revenue_chart: ({ data }) => <RevenueChart data={data?.revenue_chart ?? []} target={data?.kpis?.revenue_mtd?.target ?? 0} />,
  pipeline: ({ data, navigate }) => <PipelineFunnel stages={data?.pipeline ?? []} navigate={navigate} />,
  // Both boards navigate to `/jobs` and DISCARD the clicked entry - there is no
  // per-user jobs view to send them to. Carried over exactly.
  tech_scoreboard: ({ data, navigate }) => <RankedBarList title="Tech Scoreboard" icon="🔧" entries={data?.tech_scoreboard ?? []} onRowClick={() => navigate(preferV2Path('/jobs'))} />,
  dispatch_scoreboard: ({ data, navigate }) => <RankedBarList title="Dispatch Scoreboard" icon="🎧" entries={data?.dispatch_scoreboard ?? []} onRowClick={() => navigate(preferV2Path('/jobs'))} />,
  lead_sources: ({ data, navigate }) => <LeadSourcesWidget sources={data?.lead_sources ?? []} navigate={navigate} />,
  jobs_by_status: ({ data, navigate }) => <JobsByStatus slices={data?.jobs_by_status ?? []} navigate={navigate} />,
  revenue_by_job_type: ({ data, navigate }) => <RevenueByJobType slices={data?.revenue_by_job_type ?? []} navigate={navigate} />,
  coming_up: ({ data, navigate }) => <ComingUp jobs={data?.coming_up ?? []} navigate={navigate} />,
  recent_activity: ({ data }) => <RecentActivity events={data?.activity ?? []} />,
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
