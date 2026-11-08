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
  link: string;
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
  link: string;
}

export interface ScoreboardEntry {
  user_id: string | null;
  name: string;
  revenue: number;
  jobs: number;
}

export interface LeadSource {
  source: string;
  label: string;
  lead_pct: number;
  revenue: number;
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
}

export interface ActivityEvent {
  id: string;
  event_type: string;
  description: string;
  created_at: string;
  creator_name: string | null;
  /**
   * The feed is org-wide and carries no entity filter, so an event can outlive the row it names
   * (a deleted task keeps its timeline as the audit trail). When true, `entity_label` is the
   * snapshot taken at delete time and is the only identity that row has left, and the event MUST
   * NOT be given anything to navigate to.
   */
  entity_deleted: boolean;
  /** Non-null exactly when `entity_deleted`; never empty. */
  entity_label: string | null;
}

export interface DashboardKpis {
  jobs_today: { total: number; scheduled: number; in_progress: number; completed: number; vs_yesterday: number };
  revenue_mtd: { invoiced: number; collected: number; target: number; pct_of_goal: number; vs_last_month_pct: number };
  ar: { total: number; current: number; over_30: number; over_60: number };
  leads_open: { count: number; unassigned: number };
  close_rate: { rate: number; won: number; lost: number; vs_last_period_pp: number };
  // net-new KPIs
  collected_today: { amount: number; jobs_done: number };
  recurring: { mrr: number; active_plans: number } | null; // null when Service Plans data unavailable
  avg_ticket: { amount: number; period_days: number };
  jobs_week: { completed: number; scheduled: number };
  deposits_awaiting: { amount: number; count: number };
}

export interface DashboardResponse {
  kpis: DashboardKpis;
  revenue_chart: RevenuePoint[];
  needs_attention: AttentionItem[];
  schedule_today: TechSchedule[];
  pipeline: PipelineStage[];
  tech_scoreboard: ScoreboardEntry[];
  dispatch_scoreboard: ScoreboardEntry[];
  lead_sources: LeadSource[];
  // catalog widget data
  jobs_by_status: StatusSlice[];
  revenue_by_job_type: JobTypeSlice[];
  coming_up: ComingUpJob[];
  activity: ActivityEvent[];
  generated_at: string;
}
