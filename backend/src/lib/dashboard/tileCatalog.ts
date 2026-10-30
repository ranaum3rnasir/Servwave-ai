import { SCOPE_SWITCH_KEY, type BuiltInRole, type SwitchValue } from '../permissions/switches/catalog';
import { COMPLETED_THIS_MONTH_JOBS_QUERY, DRAFT_ESTIMATES_QUERY, NO_CREW_SCHEDULE_QUERY, NO_OWNER_LEADS_QUERY, clickTarget, type ClickTargetKey } from './clickTargets';
import type { LayoutEntry } from './layout';

/**
 * The dashboard's tile catalog (Roles & Permissions, PRD 9, M10).
 *
 * Every tile the home page can draw is held here, once, under the id a saved layout is keyed by. A tile belongs to
 * exactly one data-scope category, a category is unlocked by the switches the person already has, and the same
 * switches decide whether the tile's figures cover the person's own records or the whole company. No tile has a role
 * list and nothing here reads a role's name: a person's switch values are the only input.
 *
 * Eligibility, mode and label are pure functions of those values, so the endpoint, the layout store and the tests all
 * ask the same question.
 */

/**
 * The kinds of data a tile can read. `each_record` is the PRD's "each item its own category": a tile whose parts each
 * belong to a different category (Needs Attention, Recent Activity, the Revenue Pipeline) is unlocked by any one of
 * the switches behind its parts, and each part is then held to its own category.
 */
export const TILE_CATEGORIES = [
  'jobs',
  'leads',
  'estimates',
  'invoices_and_payments',
  'job_value',
  'company_figures',
  'office_review',
  'communication',
  'costs',
  'each_record',
] as const;
export type TileCategory = (typeof TILE_CATEGORIES)[number];

/**
 * The name the picker shows for each category (PRD 9: the picker groups tiles by these categories). Held here, next
 * to the categories, and sent with the answer, so the browser never keeps its own copy that could drift. `each_record`
 * is the tiles whose parts each follow their own View switch (Needs Attention, Recent Activity, the Revenue Pipeline).
 */
export const TILE_CATEGORY_LABELS: Record<TileCategory, string> = {
  jobs: 'Jobs',
  leads: 'Leads',
  estimates: 'Estimates',
  invoices_and_payments: 'Invoices and payments',
  job_value: 'Job value',
  company_figures: 'Company figures',
  office_review: 'Office review',
  communication: 'Communication',
  costs: 'Costs',
  each_record: 'Across your records',
};

/** The switches that unlock each category (all of them). `each_record` is unlocked per tile (`anyOf`). */
export const CATEGORY_UNLOCKED_BY: Record<TileCategory, readonly string[]> = {
  jobs: ['view_jobs'],
  leads: ['view_leads'],
  estimates: ['view_estimates'],
  invoices_and_payments: ['view_invoices'],
  job_value: ['view_jobs'],
  company_figures: ['see_company_figures'],
  office_review: ['office_review'],
  communication: ['access_communication'],
  costs: ['see_costs'],
  each_record: [],
};

/** Which Data Scope switches decide a tile's money: the Jobs and Leads scope for invoices and payments (P6), Jobs scope for job value. */
type MoneyKind = 'invoices' | 'jobs' | 'stages';

export interface TileDef {
  id: string;
  title: string;
  category: TileCategory;
  /** Switches that must also be on (all of them): the Company figures tiles read a View switch as well. */
  alsoNeeds?: readonly string[];
  /** `each_record` tiles: at least one of these must be on. */
  anyOf?: readonly string[];
  /** Set when the tile's figures are money that can be the person's own ("Yours"), not the company's. */
  money?: MoneyKind;
  /**
   * The page the tile as a whole leads to (PRD 9, "Where a tile links"); the person is sent it only if they may open
   * that page. A tile whose rows or stages each carry their own address (Needs Attention, the Revenue Pipeline, Smart
   * Insights, Top Lead Sources) names none here.
   */
  target?: ClickTargetKey;
  /** A filter on that page (`?status=UNSCHEDULED`): it travels with the address or not at all. */
  targetQuery?: string;
}

/** Every tile, in the order the dashboard has always listed them. */
export const TILE_CATALOG: readonly TileDef[] = [
  { id: 'kpi.revenue_mtd', title: 'Monthly Revenue', category: 'invoices_and_payments', money: 'invoices', target: 'invoices_list' },
  { id: 'kpi.collected_today', title: 'Collected Today', category: 'invoices_and_payments', money: 'invoices', target: 'payments_report' },
  { id: 'kpi.recurring', title: 'Recurring (Plans)', category: 'company_figures', alsoNeeds: ['view_service_plans'], target: 'service_plans_list' },
  { id: 'kpi.ar', title: 'Unpaid Balance', category: 'invoices_and_payments', money: 'invoices', target: 'unpaid_report' },
  { id: 'kpi.close_rate', title: 'Close Rate', category: 'leads', target: 'conversion_report' },
  { id: 'kpi.jobs_today', title: 'Jobs Today', category: 'jobs', target: 'schedule' },
  { id: 'kpi.open_leads', title: 'Open Leads', category: 'leads', target: 'leads_list' },
  { id: 'kpi.avg_ticket', title: 'Avg Ticket', category: 'invoices_and_payments', money: 'invoices', target: 'reports' },
  { id: 'kpi.jobs_week', title: 'Jobs This Week', category: 'jobs', target: 'jobs_list' },
  { id: 'kpi.deposits', title: 'Deposits Awaiting', category: 'invoices_and_payments', money: 'invoices', target: 'estimates_list' },
  { id: 'smart_insights', title: 'Smart Insights', category: 'company_figures', alsoNeeds: ['view_leads', 'view_invoices'] },
  { id: 'needs_attention', title: 'Needs Attention', category: 'each_record', anyOf: ['view_jobs', 'view_leads', 'view_invoices'] },
  { id: 'schedule_today', title: "Today's Schedule", category: 'jobs', target: 'schedule' },
  { id: 'revenue_chart', title: 'Monthly Revenue', category: 'invoices_and_payments', money: 'invoices', target: 'invoices_list' },
  {
    id: 'pipeline', title: 'Revenue Pipeline', category: 'each_record', money: 'stages',
    anyOf: ['view_leads', 'view_estimates', 'view_jobs', 'view_invoices'],
  },
  { id: 'tech_scoreboard', title: 'Tech Scoreboard', category: 'jobs', target: 'jobs_list' },
  { id: 'dispatch_scoreboard', title: 'Dispatch Scoreboard', category: 'jobs', target: 'jobs_list' },
  { id: 'lead_sources', title: 'Top Lead Sources', category: 'leads' },
  { id: 'jobs_by_status', title: 'Jobs by Status', category: 'jobs', target: 'jobs_list' },
  { id: 'revenue_by_job_type', title: 'Revenue by Job Type', category: 'company_figures', alsoNeeds: ['view_jobs'], target: 'reports' },
  { id: 'coming_up', title: 'Coming Up', category: 'jobs', target: 'schedule' },
  { id: 'unscheduled_jobs', title: 'Unscheduled jobs', category: 'jobs', target: 'jobs_list', targetQuery: '?status=UNSCHEDULED' },
  { id: 'office_review_queue', title: 'Office review queue', category: 'office_review', target: 'jobs_list', targetQuery: '?in_office_review=true' },
  { id: 'missing_crew', title: 'Missing crew', category: 'jobs', target: 'schedule', targetQuery: NO_CREW_SCHEDULE_QUERY },
  { id: 'jobs_this_month', title: 'Jobs this month', category: 'jobs', target: 'jobs_list' },
  { id: 'completed_jobs_value', title: 'Completed jobs value', category: 'job_value', money: 'jobs', target: 'jobs_list', targetQuery: COMPLETED_THIS_MONTH_JOBS_QUERY },
  { id: 'estimates_to_send', title: 'Estimates still to send', category: 'estimates', target: 'estimates_list', targetQuery: DRAFT_ESTIMATES_QUERY },
  { id: 'missing_lead_owner', title: 'Missing lead owner', category: 'leads', target: 'leads_list', targetQuery: NO_OWNER_LEADS_QUERY },
  {
    id: 'recent_activity', title: 'Recent Activity', category: 'each_record',
    anyOf: ['view_jobs', 'view_leads', 'view_estimates', 'view_invoices', 'view_tasks'],
  },
  { id: 'service_areas', title: 'Service Areas', category: 'jobs' },
  { id: 'recent_calls', title: 'Recent Calls', category: 'communication' },
];

export type TileMode = 'company' | 'scope' | 'own';
export type TileLabel = 'Yours' | 'Your team';
export type SwitchValues = Record<string, SwitchValue>;

export interface EligibleTile {
  id: string;
  category: TileCategory;
  mode: TileMode;
  label: TileLabel | null;
  /** Where clicking the tile leads, or null when the person may not open that page (the tile is then not clickable). */
  link: string | null;
}

const on = (values: SwitchValues, key: string) => values[key] === true;

/** Is the person's set of switches enough to have this tile at all? */
export function isTileEligible(tile: TileDef, values: SwitchValues): boolean {
  // P11: a tile of money is a sum of prices, so it takes the class of what it sums and needs See prices.
  if (tile.money && !on(values, 'see_prices')) return false;
  if (!CATEGORY_UNLOCKED_BY[tile.category].every((key) => on(values, key))) return false;
  if (tile.anyOf && !tile.anyOf.some((key) => on(values, key))) return false;
  return (tile.alsoNeeds ?? []).every((key) => on(values, key));
}

/** The Data Scope switch behind each View switch, for the tiles whose parts read several kinds of record. */
const SCOPE_OF_VIEW: Record<string, string | undefined> = {
  view_jobs: SCOPE_SWITCH_KEY.Job,
  view_leads: SCOPE_SWITCH_KEY.Lead,
};

/** The scopes an estimate or invoice follows (P6), and the View switches of those two kinds. */
const DOCUMENT_SCOPE_KEYS = [SCOPE_SWITCH_KEY.Job, SCOPE_SWITCH_KEY.Lead];
const DOCUMENT_VIEWS = ['view_estimates', 'view_invoices'];

/** The scope switches whose value decides how wide a count tile reaches. */
function countScopeKeys(tile: TileDef, values: SwitchValues): string[] {
  switch (tile.category) {
    case 'jobs':
    case 'job_value':
    case 'office_review':
      return [SCOPE_SWITCH_KEY.Job];
    case 'leads': return [SCOPE_SWITCH_KEY.Lead];
    // Estimates and invoices follow the Jobs and Leads scope (P6).
    case 'estimates':
    case 'invoices_and_payments': return DOCUMENT_SCOPE_KEYS;
    case 'communication': return ['communication_scope'];
    case 'each_record':
      return (tile.anyOf ?? []).filter((v) => on(values, v)).flatMap((v) => (DOCUMENT_VIEWS.includes(v) ? DOCUMENT_SCOPE_KEYS : SCOPE_OF_VIEW[v] ? [SCOPE_OF_VIEW[v]!] : []));
    default: return [];
  }
}

/** A scope value narrower than "everything" labels a figure by who it covers. */
function labelForScopes(scopes: SwitchValue[]): TileLabel {
  if (scopes.some((s) => s === 'team')) return 'Your team';
  return 'Yours';
}

/**
 * The mode and label of an eligible tile (PRD 9, the mode table).
 *  - A money tile without See company figures is the person's own money, "Yours", whatever the scope.
 *  - With it, the tile's scope decides: All is the company (no label); Team is that scope, labelled so;
 *    Attached and Through own leads are the person's records, "Yours".
 *  - A count tile follows its Data Scope and carries no label. A Company figures tile is the whole company.
 */
export function tileModeAndLabel(tile: TileDef, values: SwitchValues): { mode: TileMode; label: TileLabel | null } {
  if (tile.category === 'company_figures') return { mode: 'company', label: null };
  if (tile.money) {
    if (!on(values, 'see_company_figures')) return { mode: 'own', label: 'Yours' };
    const keys = tile.money === 'invoices'
      ? DOCUMENT_SCOPE_KEYS
      : tile.money === 'jobs'
        ? [SCOPE_SWITCH_KEY.Job]
        : countScopeKeys(tile, values);
    const scopes = keys.map((k) => values[k]!);
    if (scopes.every((s) => s === 'all')) return { mode: 'company', label: null };
    return { mode: 'scope', label: labelForScopes(scopes) };
  }
  const scopes = countScopeKeys(tile, values).map((k) => values[k]!);
  const wide = scopes.every((s) => s === 'all');
  return { mode: wide ? 'company' : 'scope', label: null };
}

/** The tiles a person's switches make eligible, in catalog order, each with its category, mode and label. */
export function eligibleTiles(values: SwitchValues): EligibleTile[] {
  return TILE_CATALOG.filter((tile) => isTileEligible(tile, values)).map((tile) => ({
    id: tile.id,
    category: tile.category,
    ...tileModeAndLabel(tile, values),
    link: tile.target ? clickTarget(tile.target, values, tile.targetQuery) : null,
  }));
}

/** The tiles that are a sum of prices (P11): a person without See prices is not offered any of them. */
export const MONEY_TILE_IDS: readonly string[] = TILE_CATALOG.filter((t) => t.money).map((t) => t.id);

export function findTile(id: string): TileDef | undefined {
  return TILE_CATALOG.find((t) => t.id === id);
}

export interface TileCategoryGroup {
  id: TileCategory;
  label: string;
}

/** The categories that have a tile among these, in the category order above, each with the name the picker shows. */
export function categoriesOfTiles(tiles: readonly EligibleTile[]): TileCategoryGroup[] {
  return TILE_CATEGORIES.filter((id) => tiles.some((t) => t.category === id)).map((id) => ({ id, label: TILE_CATEGORY_LABELS[id] }));
}

/**
 * The starting layout of each built-in preset (PRD 9, "Default layouts"): the ids of the tiles it opens with, in order.
 * Fixed data, kept here beside the tiles it names; an admin cannot edit it in this build. Each is made only of tiles
 * that preset's switch values unlock (a test holds every one to that), and holds only the tiles that exist so far:
 * a tile built later joins the presets it belongs to in its own slice.
 *
 *  - Admin: today's factory layout, then the tiles built since (Unscheduled jobs, Office review queue).
 *  - Dispatcher: runs the day from one page.
 *  - Technician: no invoices-and-payments tile, because View invoices is off in that preset; Jobs this month, the person's own month, the value of the jobs they completed in it, then their leads and the estimates still to send.
 *  - Sales: the person's own leads, close rate, estimates still to send and pipeline; money is marked "Yours" by the tile's mode, not here.
 *
 * Technician and Sales are complete (S09.18): each is the PRD's list in the PRD's order. The order is only where a person with no
 * saved layout starts: a person who has one is given a default tile they lack at the end, once (`withNewDefaultTiles`).
 */
const PRESET_DEFAULT_TILES: Record<BuiltInRole, readonly string[]> = {
  ADMIN: [
    'kpi.revenue_mtd', 'kpi.collected_today', 'kpi.recurring', 'kpi.ar', 'kpi.close_rate', 'kpi.jobs_today', 'kpi.open_leads',
    'kpi.avg_ticket', 'kpi.jobs_week', 'kpi.deposits', 'smart_insights', 'needs_attention', 'schedule_today', 'revenue_chart',
    'pipeline', 'tech_scoreboard', 'dispatch_scoreboard', 'lead_sources', 'revenue_by_job_type', 'unscheduled_jobs', 'office_review_queue',
  ],
  DISPATCHER: [
    'kpi.jobs_today', 'kpi.open_leads', 'kpi.jobs_week', 'unscheduled_jobs', 'office_review_queue', 'missing_crew', 'missing_lead_owner', 'schedule_today', 'needs_attention',
    'tech_scoreboard', 'dispatch_scoreboard', 'lead_sources',
  ],
  TECHNICIAN: ['jobs_this_month', 'completed_jobs_value', 'kpi.close_rate', 'kpi.open_leads', 'estimates_to_send'],
  SALES: ['kpi.open_leads', 'kpi.close_rate', 'estimates_to_send', 'kpi.revenue_mtd', 'pipeline', 'coming_up'],
};

/**
 * The default layout for a built-in preset, every tile shown at its own size and time range. `null` is a role made
 * from blank, which has no preset and starts empty. A fresh copy each call, so a caller can change what it gets.
 */
export function defaultLayoutOf(preset: BuiltInRole | null): LayoutEntry[] {
  return (preset ? PRESET_DEFAULT_TILES[preset] : []).map((id) => ({ id, visible: true }));
}
