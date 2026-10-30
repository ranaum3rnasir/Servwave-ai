// Invented sample data for the redesigned home page, shaped like the approved
// mockup. Used only offline (VITE_DASHBOARD_USE_MOCK=true) and by tests.
import type { DashboardResponse, DashboardTileData, DashboardTileMeta } from './types';

// The answer is keyed by tile id, the way the server sends it. Every tile is offered ("company" mode, no label).
const tile = (id: string, category: DashboardTileMeta['category'], link: string | null = null): DashboardTileMeta => ({ id, category, mode: 'company', label: null, link });

const data: DashboardTileData = {
  'kpi.jobs_today': { total: 18, scheduled: 8, in_progress: 7, completed: 10, vs_yesterday: 2 },
  'kpi.revenue_mtd': { invoiced: 312000, collected: 277312, collected_last_month: 235000, target: 300000, pct_of_goal: 92, vs_last_month_pct: 18 },
  'kpi.ar': { total: 1454732, current: 731366, over_30: 311000, over_60: 412366 },
  'kpi.open_leads': { count: 28, no_owner: 6 },
  'kpi.close_rate': { rate: 44, won: 22, lost: 28, vs_last_period_pp: 3 },
  'kpi.collected_today': { amount: 30755, jobs_done: 10 },
  'kpi.recurring': { mrr: 48200, active_plans: 142 },
  'kpi.avg_ticket': { amount: 4850, period_days: 30 },
  'kpi.jobs_week': { completed: 64, scheduled: 71 },
  'kpi.deposits': { amount: 112000, count: 8 },
  smart_insights: [
    { id: 'past_due_ar', icon: '💰', tone: 'danger', text: '$723k past due. The 60+ bucket is your biggest cash lever.', cta_label: 'Review unpaid invoices', link: '/invoices', weight: 723366 },
  ],
  revenue_chart: { target: 300000, months: [
    { month: 'Jan', invoiced: 180000, collected: 152000, is_current: false },
    { month: 'Feb', invoiced: 240000, collected: 208000, is_current: false },
    { month: 'Mar', invoiced: 220000, collected: 200000, is_current: false },
    { month: 'Apr', invoiced: 288000, collected: 256000, is_current: false },
    { month: 'May', invoiced: 340000, collected: 312000, is_current: false },
    { month: 'Jun', invoiced: 312000, collected: 277312, is_current: true },
  ] },
  needs_attention: [
    { id: 'a1', type: 'overdue_invoice', severity: 'danger', title: '5 invoices overdue 60+ days', meta: 'Collections priority', badge: '$412k', link: '/invoices' },
    { id: 'a3', type: 'job_past_start', severity: 'warning', title: '3 visits with no crew', meta: 'Add a crew', badge: 'Today', link: '/schedule' },
    { id: 'a4', type: 'missing_lead_owner', severity: 'info', title: '6 leads with no owner', meta: 'Oldest: Sample Customer A · 5 days open', badge: '6', link: '/leads?assigned_to=NO_OWNER' },
  ],
  schedule_today: [
    { user_id: 'u-tech-a', first_name: 'Technician A', last_name: '', jobs: [
      { id: 'j1', link: '/jobs/j1', job_number: 'J04211', status: 'IN_PROGRESS', scope_notes: 'Commercial door repair', scheduled_start: '2026-06-08T13:00:00Z', scheduled_end: null, customer_name: 'Sample Site A', address: null },
      { id: 'j2', link: '/jobs/j2', job_number: 'J04212', status: 'SCHEDULED', scope_notes: 'Turnstile service', scheduled_start: '2026-06-08T15:30:00Z', scheduled_end: null, customer_name: 'Sample Site B', address: null },
    ] },
    { user_id: 'u-tech-b', first_name: 'Technician B', last_name: '', jobs: [
      { id: 'j3', link: '/jobs/j3', job_number: 'J04213', status: 'SCHEDULED', scope_notes: 'Troubleshooting', scheduled_start: '2026-06-08T14:00:00Z', scheduled_end: null, customer_name: 'Sample Site C', address: null },
    ] },
    { user_id: null, first_name: 'No crew', last_name: '', jobs: [
      { id: 'j4', link: '/jobs/j4', job_number: 'J04214', status: 'SCHEDULED', scope_notes: 'Emergency lockout', scheduled_start: '2026-06-08T18:00:00Z', scheduled_end: null, customer_name: 'Sample Site D', address: null },
    ] },
  ],
  pipeline: [
    { key: 'leads', label: 'Leads', kind: 'count', value: 184, link: '/leads' },
    { key: 'estimates', label: 'Estimates', kind: 'amount', value: 1200000, link: '/estimates' },
    { key: 'approved', label: 'Approved', kind: 'amount', value: 540000, link: '/estimates?status=approved' },
    { key: 'deposit', label: 'Deposit', kind: 'amount', value: 310000, link: '/estimates' },
    { key: 'job', label: 'Job completed', kind: 'amount', value: 290000, link: '/jobs' },
    { key: 'invoiced', label: 'Invoiced', kind: 'amount', value: 260000, link: '/invoices' },
    { key: 'paid', label: 'Paid', kind: 'amount', value: 222000, link: '/invoices?status=paid' },
  ],
  tech_scoreboard: [
    { user_id: 'u-tech-a', name: 'Technician A', revenue: 132024, jobs: 13 },
    { user_id: 'u-team-a', name: 'Team A', revenue: 41306, jobs: 1 },
    { user_id: 'u-tech-c', name: 'Technician C', revenue: 30540, jobs: 5 },
    { user_id: 'u-tech-d', name: 'Technician D', revenue: 27222, jobs: 8 },
  ],
  dispatch_scoreboard: [
    { user_id: 'u-tech-b', name: 'Technician B', revenue: 106894, jobs: 39 },
    { user_id: 'u-team-b', name: 'Team B', revenue: 84985, jobs: 25 },
    { user_id: 'u-tech-a', name: 'Technician A', revenue: 65914, jobs: 4 },
    { user_id: 'u-tech-e', name: 'Technician E', revenue: 32602, jobs: 4 },
  ],
  lead_sources: [
    { source: 'google', label: 'Google', lead_pct: 47.1, revenue: 131000, link: '/leads?source=google' },
    { source: 'partner', label: 'Partner referral', lead_pct: 28.6, revenue: 74000, link: '/leads?source=partner' },
    { source: 'account', label: 'Account', lead_pct: 20.0, revenue: 58000, link: '/leads?source=account' },
    { source: 'returning', label: 'Returning customer', lead_pct: 4.3, revenue: 19000, link: '/leads?source=returning' },
  ],
  jobs_by_status: [
    { key: 'submitted', label: 'Submitted', count: 416 },
    { key: 'pending', label: 'Pending', count: 11 },
    { key: 'in_progress', label: 'In progress', count: 7 },
    { key: 'done_pending', label: 'Done, pending approval', count: 26 },
  ],
  revenue_by_job_type: [
    { label: 'Commercial Door Repair', pct: 31.25, revenue: 162000 },
    { label: 'Troubleshooting', pct: 31.25, revenue: 98000 },
    { label: 'Turnstile', pct: 18.75, revenue: 71000 },
    { label: 'Access Control', pct: 18.75, revenue: 54000 },
  ],
  coming_up: [
    { id: 'cu1', link: '/jobs/cu1', in_label: 'in 15 hours', title: 'Sample Customer A', address: '100 Sample Street' },
    { id: 'cu2', link: '/jobs/cu2', in_label: 'in 15 hours', title: 'Sample Customer A', address: '200 Sample Street' },
    { id: 'cu3', link: '/jobs/cu3', in_label: 'in 16 hours', title: 'Sample Customer B', address: '300 Sample Street' },
    { id: 'cu4', link: '/jobs/cu4', in_label: 'in 18 hours', title: 'Sample Customer A', address: '400 Sample Street' },
  ],
  unscheduled_jobs: {
    count: 7,
    jobs: [
      { id: 'uj1', job_number: 'J04190', title: 'Sample Customer A', address: '100 Sample Street', age_days: 9, link: '/jobs/uj1' },
      { id: 'uj2', job_number: 'J04196', title: 'Sample Customer B', address: '300 Sample Street', age_days: 4, link: '/jobs/uj2' },
      { id: 'uj3', job_number: 'J04207', title: 'Sample Customer A', address: '200 Sample Street', age_days: 0, link: '/jobs/uj3' },
    ],
  },
  office_review_queue: {
    count: 4,
    jobs: [
      { id: 'rq1', job_number: 'J04174', title: 'Sample Customer A', address: '12 Sample St, Sampleton', age_days: 6, link: '/jobs/rq1?panel=review' },
      { id: 'rq2', job_number: 'J04181', title: 'Sample Customer B', address: '34 Example Ave, Sampleton', age_days: 2, link: '/jobs/rq2?panel=review' },
      { id: 'rq3', job_number: 'J04203', title: 'Sample Customer C', address: '56 Placeholder Rd, Sampleton', age_days: 0, link: '/jobs/rq3?panel=review' },
    ],
  },
  missing_crew: {
    count: 3,
    soonest: { id: 'mc1', kind: 'job', number: 'J04212', title: 'Sample Customer B', starts_at: new Date(Date.now() + 30 * 3_600_000).toISOString(), starts_label: 'Tomorrow 9:00 AM', until: '1d', link: '/jobs/mc1' },
  },
  jobs_this_month: { jobs: 14, finished: 17, still_to_do: 9 },
  completed_jobs_value: { jobs: 11, value: 18450 },
  estimates_to_send: {
    count: 9,
    estimates: [
      { id: 'es1', estimate_number: 'E01120', title: 'Sample Customer A', total: 4820, link: '/estimates/es1' },
      { id: 'es2', estimate_number: 'E01133', title: 'Sample Customer B', total: 1275.5, link: '/estimates/es2' },
      { id: 'es3', estimate_number: 'E01141', title: 'Sample Customer A', total: 360, link: '/estimates/es3' },
    ],
  },
  missing_lead_owner: {
    count: 6,
    oldest: { id: 'ml1', lead_number: 'L01874', title: 'Sample Customer A', age_days: 5, link: '/leads/ml1' },
  },
  recent_activity: [
    { id: 'e1', event_type: 'ESTIMATE_VIEWED', description: 'Client viewed estimate E04188', created_at: new Date(Date.now() - 18 * 60_000).toISOString(), creator_name: null, entity_deleted: false, entity_label: null },
    { id: 'e2', event_type: 'PAYMENT_RECEIVED', description: 'Payment of $1,450 collected', created_at: new Date(Date.now() - 42 * 60_000).toISOString(), creator_name: 'Technician B', entity_deleted: false, entity_label: null },
    { id: 'e3', event_type: 'JOB_COMPLETED', description: 'Job J04201 marked complete', created_at: new Date(Date.now() - 70 * 60_000).toISOString(), creator_name: 'Technician A', entity_deleted: false, entity_label: null },
    // A task's timeline outlives the task, so the feed's deleted-entity branch has a fixture here.
    { id: 'e4', event_type: 'DELETED', description: 'deleted the task', created_at: new Date(Date.now() - 95 * 60_000).toISOString(), creator_name: 'Technician B', entity_deleted: true, entity_label: 'T00042 · Inspect compressor' },
  ],
};

export const dashboardSeed: DashboardResponse = {
  tiles: [
    tile('kpi.jobs_today', 'jobs', '/schedule'), tile('kpi.revenue_mtd', 'invoices_and_payments', '/invoices'), tile('kpi.ar', 'invoices_and_payments', '/reports/unpaid-invoices'),
    tile('kpi.open_leads', 'leads', '/leads'), tile('kpi.close_rate', 'leads', '/reports/estimate-conversion'), tile('kpi.collected_today', 'invoices_and_payments', '/reports/payments'),
    tile('kpi.recurring', 'company_figures', '/service-plans'), tile('kpi.avg_ticket', 'invoices_and_payments', '/reports'), tile('kpi.jobs_week', 'jobs', '/jobs'),
    tile('kpi.deposits', 'invoices_and_payments', '/estimates'), tile('smart_insights', 'company_figures'), tile('needs_attention', 'each_record'),
    tile('schedule_today', 'jobs', '/schedule'), tile('revenue_chart', 'invoices_and_payments', '/invoices'), tile('pipeline', 'each_record'),
    tile('tech_scoreboard', 'jobs', '/jobs'), tile('dispatch_scoreboard', 'jobs', '/jobs'), tile('lead_sources', 'leads'), tile('jobs_by_status', 'jobs', '/jobs'),
    tile('revenue_by_job_type', 'company_figures', '/reports'), tile('coming_up', 'jobs', '/schedule'), tile('unscheduled_jobs', 'jobs', '/jobs?status=UNSCHEDULED'),
    tile('office_review_queue', 'office_review', '/jobs?in_office_review=true'),
    tile('missing_crew', 'jobs', '/schedule?filter=no_crew'),
    tile('jobs_this_month', 'jobs', '/jobs'),
    tile('completed_jobs_value', 'job_value', '/jobs?completed_this_month=true'),
    tile('estimates_to_send', 'estimates', '/estimates?status=DRAFT'),
    tile('missing_lead_owner', 'leads', '/leads?assigned_to=NO_OWNER'),
    tile('recent_activity', 'each_record'),
    tile('service_areas', 'jobs'), tile('recent_calls', 'communication'),
  ],
  // The category names are the server's (backend/src/lib/dashboard/tileCatalog.ts); a backend test pins this list to them.
  categories: [
    { id: 'jobs', label: 'Jobs' },
    { id: 'leads', label: 'Leads' },
    { id: 'estimates', label: 'Estimates' },
    { id: 'invoices_and_payments', label: 'Invoices and payments' },
    { id: 'company_figures', label: 'Company figures' },
    { id: 'office_review', label: 'Office review' },
    { id: 'communication', label: 'Communication' },
    { id: 'each_record', label: 'Across your records' },
  ],
  data,
  generated_at: new Date().toISOString(),
};
