// Extended dashboard payload types. Single source of truth for the redesigned
// home page; re-exported through the data seam (lib/api/dashboard.ts).
// Pages/components must import from the seam, never from _mock directly.

export interface RevenuePoint {
  month: string;
  invoiced: number;
  collected: number;
  is_current: boolean;
}

export interface AttentionItem {
  id: string;
  type: string;
  severity: 'danger' | 'warning' | 'info';
  title: string;
  meta: string;
  badge: string;
  /** The server's address for the row, or null when the person may not open that page (drawn, not clickable). */
  link: string | null;
}

export interface ScheduleJob {
  id: string;
  job_number: string;
  status: string;
  scope_notes: string | null;
  scheduled_start: string | null;
  scheduled_end: string | null;
  customer_name: string;
  address: string | null;
  /** Discriminator for schedule entries; absent = job (mock seed compat). */
  entity?: 'job' | 'walkthrough';
  /** The record the entry opens: its job, or the lead a walkthrough belongs to (a record the person can open). */
  link: string;
}

export interface TechSchedule {
  user_id: string | null;
  first_name: string;
  last_name: string;
  jobs: ScheduleJob[];
  /** Signed URL to the tech's uploaded profile photo, or null for the initials tile. Optional —
   *  absent on the mock seed (2026-08-04 plan). */
  avatar_url?: string | null;
}

export interface PipelineStage {
  key: string;
  label: string;
  kind: 'count' | 'amount';
  value: number;
  /** The list page the stage leads to, sent only when the person may open it; null draws the stage without a click. */
  link: string | null;
}

export interface ScoreboardEntry {
  user_id: string | null;
  name: string;
  /** Left off the response for a person without See company figures; the board is then ranked by job count. */
  revenue?: number;
  jobs: number;
}

export interface LeadSource {
  source: string;
  label: string;
  lead_pct: number;
  /** Left off the response for a person without See company figures. */
  revenue?: number;
  /** The Leads list filtered to this source, sent only when the person may open the Leads list. */
  link: string | null;
}

export interface StatusSlice {
  key: string;
  label: string;
  count: number;
}

export interface JobTypeSlice {
  label: string;
  pct: number;
  revenue: number;
}

export interface ComingUpJob {
  id: string;
  in_label: string; // e.g. "in 15 hours"
  title: string;
  address: string;
  /** The job this row names (the job is one the person can open). */
  link: string;
}

/** A job waiting for a visit. The server sends the longest-waiting few and the count over everything in scope. */
export interface UnscheduledJob {
  id: string;
  job_number: string;
  /** The customer's name. */
  title: string;
  address: string;
  /** Whole days since the job was made. */
  age_days: number;
  /** The job this row names (a job the person can open). */
  link: string;
}

/** A draft estimate still to send. The server sends the longest-waiting few and the count over everything the person can open. */
export interface EstimateToSend {
  id: string;
  estimate_number: string;
  /** The customer's name. */
  title: string;
  /** The estimate's own total, in dollars: the record's price, shown to anyone who can open the estimate. */
  total: number;
  /** The estimate this row names (one the person can open). */
  link: string;
}

/** A job waiting for its office review. The server sends the longest-waiting few and the count over everything in reach. */
export interface ReviewQueueJob {
  id: string;
  job_number: string;
  /** The customer's name. */
  title: string;
  address: string;
  /** Whole days since the job was made. */
  age_days: number;
  /** The job this row names, opened with its review panel open (an address the server wrote). */
  link: string;
}

/** The booked visit that starts soonest with nobody on it, named by its job or lead. The server sends its address; the page holds none of its own. */
export interface MissingCrewVisit {
  /** The id of the job or lead the visit belongs to. */
  id: string;
  kind: 'job' | 'lead';
  /** The job number, or the lead number for a walkthrough. */
  number: string;
  /** The customer's name. */
  title: string;
  starts_at: string;
  /** When it starts on the company's clock ("Thu 9:00 AM"). */
  starts_label: string;
  /** How long until it starts ("3d", "5h"). */
  until: string;
  link: string;
}

/** The open lead that has had no Owner longest. The server sends its address; the page holds none of its own. */
export interface MissingOwnerLead {
  id: string;
  lead_number: string;
  /** The customer's name. */
  title: string;
  /** Whole days since the lead was made. */
  age_days: number;
  link: string;
}

export interface ActivityEvent {
  id: string;
  event_type: string;
  description: string;
  created_at: string;
  creator_name: string | null;
  /**
   * An event can outlive the row it names (a deleted task keeps its timeline as the audit trail). When
   * true, `entity_label` is the snapshot taken at delete time and is the only identity that row has
   * left, and the event MUST NOT be given anything to navigate to.
   */
  entity_deleted: boolean;
  /** Non-null exactly when `entity_deleted`; never empty. */
  entity_label: string | null;
}

/** The kinds of data a tile reads; the server sends the one each tile belongs to. */
export type DashboardTileCategory =
  | 'jobs' | 'leads' | 'estimates' | 'invoices_and_payments' | 'job_value' | 'company_figures'
  | 'office_review' | 'communication' | 'costs' | 'each_record';

/**
 * One tile the person's switches make eligible. `mode` says whose records the figures cover (the company's, the
 * person's scope, or only the person's own) and `label` is the word to show next to a money tile's title when the
 * figure is not the whole company's.
 */
export interface DashboardTileMeta {
  id: string;
  category: DashboardTileCategory;
  mode: 'company' | 'scope' | 'own';
  label: 'Yours' | 'Your team' | 'Your location' | null;
  /**
   * Where clicking the tile leads, sent only when the person may open that page; null draws the tile without a click.
   * The page holds no address of its own.
   */
  link: string | null;
}

/** A category the person has at least one tile in, with the name to show for it in the picker (sent by the server). */
export interface DashboardTileCategoryGroup {
  id: DashboardTileCategory;
  label: string;
}

export interface Insight {
  id: string;
  icon: string;
  tone: 'danger' | 'info' | 'success';
  text: string;
  cta_label: string;
  /** The card's list page, sent only when the person may open it; null draws the card without a click. */
  link: string | null;
  weight: number;
}

/**
 * Each eligible tile's data, keyed by the tile's id. A tile the person may not have is not in the answer at all, and a
 * part of a tile that belongs to another category (the revenue column, the revenue goal) is left off, never sent blank.
 */
export interface DashboardTileData {
  'kpi.jobs_today'?: { total: number; scheduled: number; in_progress: number; completed: number; vs_yesterday: number };
  'kpi.revenue_mtd'?: {
    invoiced: number;
    collected: number;
    collected_last_month: number;
    vs_last_month_pct: number;
    /** The company's goal: only in company mode. */
    target?: number;
    pct_of_goal?: number;
  };
  'kpi.ar'?: { total: number; current: number; over_30: number; over_60: number };
  'kpi.open_leads'?: { count: number; no_owner: number };
  'kpi.close_rate'?: { rate: number; won: number; lost: number; vs_last_period_pp: number };
  /** `jobs_done` belongs to the Jobs category and is left off for a person who may not view jobs. */
  'kpi.collected_today'?: { amount: number; jobs_done?: number };
  /** null when there are no active plans. */
  'kpi.recurring'?: { mrr: number; active_plans: number } | null;
  'kpi.avg_ticket'?: { amount: number; period_days: number };
  'kpi.jobs_week'?: { completed: number; scheduled: number };
  'kpi.deposits'?: { amount: number; count: number };
  smart_insights?: Insight[];
  needs_attention?: AttentionItem[];
  schedule_today?: TechSchedule[];
  revenue_chart?: { months: RevenuePoint[]; target?: number };
  pipeline?: PipelineStage[];
  tech_scoreboard?: ScoreboardEntry[];
  dispatch_scoreboard?: ScoreboardEntry[];
  lead_sources?: LeadSource[];
  jobs_by_status?: StatusSlice[];
  revenue_by_job_type?: JobTypeSlice[];
  coming_up?: ComingUpJob[];
  unscheduled_jobs?: { count: number; jobs: UnscheduledJob[] };
  office_review_queue?: { count: number; jobs: ReviewQueueJob[] };
  missing_crew?: { count: number; soonest: MissingCrewVisit | null };
  /** The jobs with a visit this month, and those visits split into finished and still to do (a cancelled visit is neither). */
  jobs_this_month?: { jobs: number; finished: number; still_to_do: number };
  /** What was invoiced on the jobs that reached Completed this month, and how many jobs they are. */
  completed_jobs_value?: { jobs: number; value: number };
  /** The draft estimates the person can open, and the oldest few of them. */
  estimates_to_send?: { count: number; estimates: EstimateToSend[] };
  missing_lead_owner?: { count: number; oldest: MissingOwnerLead | null };
  recent_activity?: ActivityEvent[];
}

export interface DashboardResponse {
  /** The tiles the person's switches make eligible. Empty for a person whose switches unlock none. */
  tiles: DashboardTileMeta[];
  /** The categories those tiles belong to, in the order the picker lists them. A category with no tile is not here. */
  categories: DashboardTileCategoryGroup[];
  data: DashboardTileData;
  generated_at: string;
}
