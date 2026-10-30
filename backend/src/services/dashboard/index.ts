import type { Request } from 'express';
import { categoriesOfTiles, eligibleTiles, type EligibleTile, type TileCategoryGroup } from '../../lib/dashboard/tileCatalog';
import { buildContext, type DashContext } from './context';
import { closeRate, comingUp, completedJobsValue, dispatchScoreboard, estimatesToSend, jobsByStatus, jobsThisMonth, jobsToday, jobsWeek, leadSources, missingCrew, missingLeadOwnerTile, officeReviewQueue, openLeads, techScoreboard, unscheduledJobs } from './workTiles';
import { avgTicket, collectedToday, depositsAwaiting, pipeline, recurring, revenueByJobType, revenueChart, revenueMtd, unpaidBalance } from './moneyTiles';
import { scheduleToday } from './schedule';
import { needsAttention } from './attention';
import { recentActivity } from './activity';
import { smartInsights } from './insights';
import { shownTileIds } from './layout';
import { runLoaders, type RunOptions } from './run';

/**
 * The per-person dashboard (Roles & Permissions, PRD 9): which tiles the person's switches make eligible, and each
 * eligible tile's data keyed by its id. A tile the person may not have is neither computed nor returned, and every
 * tile's figures come from the access resolver, so the answer is the person's own and never the company's.
 */

/** A tile's data loader, by tile id. The two placeholders ("coming soon") have no data. */
const LOADERS: Record<string, (ctx: DashContext) => Promise<unknown>> = {
  'kpi.jobs_today': jobsToday,
  'kpi.jobs_week': jobsWeek,
  'kpi.open_leads': openLeads,
  'kpi.close_rate': closeRate,
  'kpi.revenue_mtd': revenueMtd,
  'kpi.collected_today': collectedToday,
  'kpi.ar': unpaidBalance,
  'kpi.avg_ticket': avgTicket,
  'kpi.deposits': depositsAwaiting,
  'kpi.recurring': recurring,
  smart_insights: smartInsights,
  needs_attention: needsAttention,
  schedule_today: scheduleToday,
  revenue_chart: revenueChart,
  pipeline,
  tech_scoreboard: techScoreboard,
  dispatch_scoreboard: dispatchScoreboard,
  lead_sources: leadSources,
  jobs_by_status: jobsByStatus,
  revenue_by_job_type: revenueByJobType,
  coming_up: comingUp,
  unscheduled_jobs: unscheduledJobs,
  office_review_queue: officeReviewQueue,
  missing_crew: missingCrew,
  jobs_this_month: jobsThisMonth,
  completed_jobs_value: completedJobsValue,
  estimates_to_send: estimatesToSend,
  missing_lead_owner: missingLeadOwnerTile,
  recent_activity: recentActivity,
};

export interface DashboardAnswer {
  tiles: EligibleTile[];
  /** The categories those tiles belong to, in picker order, with the name to show: a category with no tile is not listed. */
  categories: TileCategoryGroup[];
  data: Record<string, unknown>;
  generated_at: string;
}

export interface DashboardRequest {
  /** Narrow to tiles asked for by id: both the list of tiles and the data are cut to them. */
  only?: readonly string[];
  /**
   * The home page's read: `tiles` and `categories` list everything the person is eligible for (the picker needs them, and
   * they cost no loader), but only the tiles their layout SHOWS are computed. A tile that is hidden, or eligible but never
   * added, is not computed at all.
   */
  shown?: boolean;
  run?: Partial<RunOptions>;
}

/** An id the person's switches do not allow is simply not returned. */
export async function buildDashboard(req: Request, { only, shown, run }: DashboardRequest = {}): Promise<DashboardAnswer> {
  const ctx = await buildContext(req);
  const eligible = eligibleTiles(ctx.values);
  const tiles = only ? eligible.filter((t) => only.includes(t.id)) : eligible;
  let computed: readonly string[] = tiles.map((t) => t.id);
  if (shown && !only) {
    const onPage = new Set(await shownTileIds(req.user!, ctx.values));
    computed = computed.filter((id) => onPage.has(id));
  }
  const data = await runLoaders(computed, LOADERS, ctx, run);
  return { tiles, categories: categoriesOfTiles(tiles), data, generated_at: ctx.b.now.toISOString() };
}
