// Realistic seed data for the redesigned home page. Numbers mirror the approved
// mockup (and ALPHA's Workiz figures) so the offline scaffold feels real.
import type { DashboardResponse } from './types';

export const dashboardSeed: DashboardResponse = {
  kpis: {
    jobs_today: { total: 18, scheduled: 8, in_progress: 7, completed: 10, vs_yesterday: 2 },
    revenue_mtd: { invoiced: 312000, collected: 277312, target: 300000, pct_of_goal: 92, vs_last_month_pct: 18 },
    ar: { total: 1454732, current: 731366, over_30: 311000, over_60: 412366 },
    leads_open: { count: 28, unassigned: 6 },
    close_rate: { rate: 44, won: 22, lost: 28, vs_last_period_pp: 3 },
    collected_today: { amount: 30755, jobs_done: 10 },
    recurring: { mrr: 48200, active_plans: 142 },
    avg_ticket: { amount: 4850, period_days: 30 },
    jobs_week: { completed: 64, scheduled: 71 },
    deposits_awaiting: { amount: 112000, count: 8 },
  },
  revenue_chart: [
    { month: 'Jan', invoiced: 180000, collected: 152000, is_current: false },
    { month: 'Feb', invoiced: 240000, collected: 208000, is_current: false },
    { month: 'Mar', invoiced: 220000, collected: 200000, is_current: false },
    { month: 'Apr', invoiced: 288000, collected: 256000, is_current: false },
    { month: 'May', invoiced: 340000, collected: 312000, is_current: false },
    { month: 'Jun', invoiced: 312000, collected: 277312, is_current: true },
  ],
  needs_attention: [
    { id: 'a1', type: 'overdue_invoice', severity: 'danger', title: '5 invoices overdue 60+ days', meta: 'Collections priority', badge: '$412k', link: '/invoices' },
    { id: 'a3', type: 'job_past_start', severity: 'warning', title: '3 jobs today unassigned', meta: 'Assign a tech', badge: 'Today', link: '/schedule' },
    { id: 'a4', type: 'unassigned_leads', severity: 'info', title: '9 leads uncontacted >24h', meta: 'Speed-to-lead', badge: '9', link: '/leads' },
  ],
  schedule_today: [
    { user_id: 'u-rami', first_name: 'Rami', last_name: '', jobs: [
      { id: 'j1', job_number: 'J04211', status: 'IN_PROGRESS', scope_notes: 'Commercial door repair', scheduled_start: '2026-06-08T13:00:00Z', scheduled_end: null, customer_name: '518 Gregory Ave — Weehawken', address: null },
      { id: 'j2', job_number: 'J04212', status: 'SCHEDULED', scope_notes: 'Turnstile service', scheduled_start: '2026-06-08T15:30:00Z', scheduled_end: null, customer_name: '326 Prospect Ave — Hackensack', address: null },
    ] },
    { user_id: 'u-priya', first_name: 'Priya', last_name: '', jobs: [
      { id: 'j3', job_number: 'J04213', status: 'SCHEDULED', scope_notes: 'Troubleshooting', scheduled_start: '2026-06-08T14:00:00Z', scheduled_end: null, customer_name: '90 Dayton Ave — Passaic', address: null },
    ] },
    { user_id: null, first_name: 'Unassigned', last_name: '', jobs: [
      { id: 'j4', job_number: 'J04214', status: 'SCHEDULED', scope_notes: 'Emergency lockout', scheduled_start: '2026-06-08T18:00:00Z', scheduled_end: null, customer_name: '2170 University Ave — The Bronx', address: null },
    ] },
  ],
  pipeline: [
    { key: 'leads', label: 'Leads', kind: 'count', value: 184, link: '/leads' },
    { key: 'estimates', label: 'Estimates', kind: 'amount', value: 1200000, link: '/estimates' },
    { key: 'approved', label: 'Approved', kind: 'amount', value: 540000, link: '/estimates?status=approved' },
    { key: 'deposit', label: 'Deposit', kind: 'amount', value: 310000, link: '/estimates' },
    { key: 'job', label: 'Job done', kind: 'amount', value: 290000, link: '/jobs' },
    { key: 'invoiced', label: 'Invoiced', kind: 'amount', value: 260000, link: '/invoices' },
    { key: 'paid', label: 'Paid', kind: 'amount', value: 222000, link: '/invoices?status=paid' },
  ],
  tech_scoreboard: [
    { user_id: 'u-rami', name: 'Rami', revenue: 132024, jobs: 13 },
    { user_id: 'u-projects', name: 'Projects', revenue: 41306, jobs: 1 },
    { user_id: 'u-sagiv', name: 'Sagiv', revenue: 30540, jobs: 5 },
    { user_id: 'u-ohad', name: 'Ohad', revenue: 27222, jobs: 8 },
  ],
  dispatch_scoreboard: [
    { user_id: 'u-priya', name: 'Priya', revenue: 106894, jobs: 39 },
    { user_id: 'u-dispatch', name: 'Dispatch', revenue: 84985, jobs: 25 },
    { user_id: 'u-rami', name: 'Rami', revenue: 65914, jobs: 4 },
    { user_id: 'u-emanuel', name: 'Emanuel', revenue: 32602, jobs: 4 },
  ],
  lead_sources: [
    { source: 'google', label: 'Google', lead_pct: 47.1, revenue: 131000 },
    { source: 'lvd', label: 'LVD', lead_pct: 28.6, revenue: 74000 },
    { source: 'account', label: 'Account', lead_pct: 20.0, revenue: 58000 },
    { source: 'alpha-return', label: 'Returning customer', lead_pct: 4.3, revenue: 19000 },
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
    { id: 'cu1', in_label: 'in 15 hours', title: 'LVD', address: '518 Gregory Ave, Weehawken Township' },
    { id: 'cu2', in_label: 'in 15 hours', title: 'LVD', address: '326 Prospect Ave, Hackensack NJ' },
    { id: 'cu3', in_label: 'in 16 hours', title: 'Frank McClain', address: '90 Dayton Ave, Passaic NJ' },
    { id: 'cu4', in_label: 'in 18 hours', title: 'LVD', address: '2170 University Ave, The Bronx NY' },
  ],
  activity: [
    { id: 'e1', event_type: 'ESTIMATE_VIEWED', description: 'Client viewed estimate E04188', created_at: new Date(Date.now() - 18 * 60_000).toISOString(), creator_name: null, entity_deleted: false, entity_label: null },
    { id: 'e2', event_type: 'PAYMENT_RECEIVED', description: 'Payment of $1,450 collected', created_at: new Date(Date.now() - 42 * 60_000).toISOString(), creator_name: 'Priya', entity_deleted: false, entity_label: null },
    { id: 'e3', event_type: 'JOB_COMPLETED', description: 'Job J04201 marked complete', created_at: new Date(Date.now() - 70 * 60_000).toISOString(), creator_name: 'Rami', entity_deleted: false, entity_label: null },
    // A task's timeline outlives the task, so the feed's deleted-entity branch has a fixture here.
    { id: 'e4', event_type: 'DELETED', description: 'deleted the task', created_at: new Date(Date.now() - 95 * 60_000).toISOString(), creator_name: 'Priya', entity_deleted: true, entity_label: 'T00042 · Inspect compressor' },
  ],
  generated_at: new Date().toISOString(),
};
