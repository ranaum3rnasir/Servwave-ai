import type { SwitchValue } from '../permissions/switches/catalog';

/**
 * Where a dashboard tile, row or stage leads (Roles & Permissions, PRD 9, "Where a tile links").
 *
 * The server decides, per person, and sends the address or nothing: the page draws an element with no address but does
 * not make it clickable, and holds no address of its own. A page opens for a person on the switches that route's guard
 * asks for (a list page: its View and Show switches; a page that is not a record type: its Access switch), so each
 * target here lists exactly those, and a test reads them back from the routed guards so the two cannot drift.
 */
export const CLICK_TARGETS = {
  invoices_list: { path: '/invoices', needs: ['view_invoices', 'show_invoices_page'] },
  payments_report: { path: '/reports/payments', needs: ['access_reports'] },
  unpaid_report: { path: '/reports/unpaid-invoices', needs: ['access_reports'] },
  conversion_report: { path: '/reports/estimate-conversion', needs: ['access_reports'] },
  reports: { path: '/reports', needs: ['access_reports'] },
  estimates_list: { path: '/estimates', needs: ['view_estimates', 'show_estimates_page'] },
  service_plans_list: { path: '/service-plans', needs: ['view_service_plans', 'show_service_plans_page'] },
  schedule: { path: '/schedule', needs: ['access_schedule'] },
  jobs_list: { path: '/jobs', needs: ['view_jobs', 'show_jobs_page'] },
  leads_list: { path: '/leads', needs: ['view_leads', 'show_leads_page'] },
  payments_page: { path: '/payments', needs: ['view_payments', 'show_payments_page'] },
} as const satisfies Record<string, { path: string; needs: readonly string[] }>;

/** The Leads list filtered to "No owner" (the Owner filter's option; the Leads page reads the same address). */
export const NO_OWNER_LEADS_QUERY = '?assigned_to=NO_OWNER';

/**
 * The Jobs list filtered to "Completed this month": the finished jobs (Completed, Office review, Ready to close, Done) the
 * list's own named filter picks. The list reads it from the address, so the tile and the page it opens share one spelling.
 */
export const COMPLETED_THIS_MONTH_JOBS_QUERY = '?completed_this_month=true';

/** The Estimates list filtered to Draft (the list's Status filter reads `status` from the address). */
export const DRAFT_ESTIMATES_QUERY = '?status=DRAFT';

/**
 * The Schedule with its "No crew" filter on: the next 7 days, only the visits and walkthroughs nobody is on. The Schedule
 * page reads the same address (`frontend/src/lib/scheduleFilter.ts`); a test holds the two spellings together.
 */
export const NO_CREW_SCHEDULE_QUERY = '?filter=no_crew';

export type ClickTargetKey = keyof typeof CLICK_TARGETS;

type Values = Record<string, SwitchValue>;

/** May this person open that page? */
export function canOpen(key: ClickTargetKey, values: Values): boolean {
  return CLICK_TARGETS[key].needs.every((switchKey) => values[switchKey] === true);
}

/**
 * The address a person is sent to, or null when they may not open that page (the element is then not clickable).
 * `query` is a filter on the same page (`?source=referral`): it travels with the address or not at all.
 */
export function clickTarget(key: ClickTargetKey, values: Values, query = ''): string | null {
  return canOpen(key, values) ? `${CLICK_TARGETS[key].path}${query}` : null;
}

/** The list page each Revenue Pipeline stage leads to (the stage's own address, with its filter, is built with it). */
const PIPELINE_STAGE_TARGET: Record<string, ClickTargetKey> = {
  leads: 'leads_list',
  estimates: 'estimates_list',
  approved: 'estimates_list',
  deposit: 'estimates_list',
  job: 'jobs_list',
  invoiced: 'invoices_list',
  paid: 'invoices_list',
};

/** Revenue Pipeline stages with the address each leads to, kept only where the person may open that list page. */
export function linkPipelineStages<S extends { key: string; link: string | null }>(stages: S[], values: Values): Array<Omit<S, 'link'> & { link: string | null }> {
  return stages.map((stage) => {
    const target = PIPELINE_STAGE_TARGET[stage.key];
    return { ...stage, link: target && canOpen(target, values) ? stage.link : null };
  });
}

/** The list page each Smart Insights card leads to. */
const INSIGHT_TARGET: Record<string, ClickTargetKey> = {
  past_due_ar: 'invoices_list',
  top_source: 'leads_list',
  pipeline_nudge: 'estimates_list',
};

/** Smart Insights cards with the address of their list page, kept only where the person may open it. */
export function linkInsights<I extends { id: string; link: string | null }>(insights: I[], values: Values): Array<Omit<I, 'link'> & { link: string | null }> {
  return insights.map((insight) => {
    const target = INSIGHT_TARGET[insight.id];
    return { ...insight, link: target && canOpen(target, values) ? insight.link : null };
  });
}
