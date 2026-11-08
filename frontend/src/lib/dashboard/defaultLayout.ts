import type { DashboardLayout } from './layoutTypes';

// The approved Approach-A order. Each primary KPI is its own widget so it can be
// reordered individually (e.g. move Close Rate first, Jobs Today last).
export const DEFAULT_LAYOUT: DashboardLayout = [
  { id: 'kpi.revenue_mtd', visible: true },
  { id: 'kpi.collected_today', visible: true },
  { id: 'kpi.recurring', visible: true },
  { id: 'kpi.ar', visible: true },
  { id: 'kpi.close_rate', visible: true },
  { id: 'kpi.jobs_today', visible: true },
  { id: 'kpi.open_leads', visible: true },
  { id: 'kpi.avg_ticket', visible: true },
  { id: 'kpi.jobs_week', visible: true },
  { id: 'kpi.deposits', visible: true },
  { id: 'smart_insights', visible: true },
  { id: 'needs_attention', visible: true },
  { id: 'schedule_today', visible: true },
  { id: 'revenue_chart', visible: true },
  { id: 'pipeline', visible: true },
  { id: 'tech_scoreboard', visible: true },
  { id: 'dispatch_scoreboard', visible: true },
  { id: 'lead_sources', visible: true },
  { id: 'revenue_by_job_type', visible: true },
];
