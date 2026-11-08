import {
  // strategic-suite icons
  FileCheck,
  Trophy,
  Award,
  Filter,
  CalendarRange,
  PhoneIncoming,
  FileClock,
  BadgeCheck,
  ClipboardList,
  PieChart,
  TrendingUp,
  Building2,
  Hourglass,
  CircleDollarSign,
  Banknote,
  Receipt,
  Tag,
  UserCog,
  Gauge,
  CalendarDays,
  Truck,
  Wrench,
  RotateCcw,
  Timer,
  ShieldCheck,
  Megaphone,
  Phone,
  MousePointerClick,
  Mail,
  Star,
  Users,
  Share2,
  MapPin,
  // legacy entity-report icons
  Target,
  FileText,
  Briefcase,
  BarChart3,
  Boxes,
  Percent,
  Activity,
  // Main-tab (Workiz parity) icons
  Coins,
  Wallet,
  Clock,
  Globe,
  Store,
  ClipboardCheck,
  PackagePlus,
  CalendarCheck,
  Calculator,
  type LucideIcon,
} from 'lucide-react';
import type { AppSubject } from '@/lib/ability';

/**
 * Source of truth for the Reports landing grid (Servwave reports tab).
 *
 * Holds two layers, both surfaced under the same four category tabs:
 *  • The 33-report Servwave strategic suite (`code` like "S1"/"F4"/"M8"),
 *    defined in `docs/reporting/SERVWAVE_REPORT_CATALOG.md` and sequenced by
 *    `docs/reporting/REPORT_TRIAGE_DECISIONS.md` (June 3, 2026 owner triage).
 *  • The original entity reports (Leads, Jobs, Invoices, …) — no `code`,
 *    kept alongside the strategic suite.
 *
 * Each entry renders one card under its category tab. To wire a real report
 * later, build out the matching `/reports/:slug` route — no need to touch the
 * grid. `subject` gates the card via CASL (a user only sees reports they can
 * `read`). `deferred` reports (M8) render muted with a badge.
 */
export type ReportGroup = 'Sales' | 'Finance' | 'Operations' | 'Marketing';

/** Render order for the category tabs. */
export const reportGroupOrder: ReportGroup[] = ['Sales', 'Finance', 'Operations', 'Marketing'];

export interface ReportDef {
  /** Catalog code, e.g. "S1", "F4", "M8". Absent on the legacy entity reports. */
  code?: string;
  /** URL segment: /reports/<slug> */
  slug: string;
  label: string;
  icon: LucideIcon;
  /** Workflow grouping — drives which category tab the card sits under. */
  group: ReportGroup;
  /** CASL subject the user must be able to `read` to see this card. */
  subject: AppSubject;
  /** Deferred (not selected for build) — shown muted with a badge. M8 only. */
  deferred?: boolean;
  /**
   * True once the report is wired to a real DB-backed data path. Demo orgs see
   * every report (mock-first, for sales); real orgs ONLY see `live` ones — a
   * report with no real data path is hidden for them rather than showing
   * fabricated numbers. Flip to `true` as each report's backend lands.
   */
  live?: boolean;
  /** Show only on the Main landing tab — hidden from its category tab to avoid
   *  duplicating a report that already appears under Main. */
  mainOnly?: boolean;
  /**
   * The entitlement key (from frontend/src/lib/entitlements/catalog.ts
   * FEATURE_CATALOG) the org must hold to see this report. ANDed with `live` -
   * never a substitute for it.
   */
  feature?: string;
}

export const reportCatalog: ReportDef[] = [
  // ── Sales ─────────────────────────────────────────────────────────────────
  // Strategic suite (S1–S9)
  { code: 'S1', slug: 'estimate-conversion', label: 'Estimate / Quote Conversion', icon: FileCheck, group: 'Sales', subject: 'Estimate', live: true },
  { code: 'S2', slug: 'rep-leaderboard', label: 'Salesperson Leaderboard', icon: Trophy, group: 'Sales', subject: 'Report' },
  { code: 'S3', slug: 'tech-performance', label: 'Technician Performance Board', icon: Award, group: 'Sales', subject: 'Report' },
  { code: 'S4', slug: 'pipeline', label: 'Pipeline by Stage', icon: Filter, group: 'Sales', subject: 'Report' },
  { code: 'S5', slug: 'sales-mom', label: 'Month-over-Month Sales', icon: CalendarRange, group: 'Sales', subject: 'Report' },
  { code: 'S6', slug: 'call-booking', label: 'Call Booking / CSR Performance', icon: PhoneIncoming, group: 'Sales', subject: 'Communication' },
  { code: 'S7', slug: 'unsold-estimates', label: 'Unsold Estimate Follow-Up', icon: FileClock, group: 'Sales', subject: 'Estimate' },
  { code: 'S8', slug: 'membership-sales', label: 'Membership & Agreement Sales', icon: BadgeCheck, group: 'Sales', subject: 'Report' },
  { code: 'S9', slug: 'weekly-rep-diagnostic', label: 'Weekly Rep Diagnostic', icon: ClipboardList, group: 'Sales', subject: 'Report' },
  // Entity reports
  { slug: 'leads', label: 'Leads', icon: Target, group: 'Sales', subject: 'Lead', mainOnly: true },
  { slug: 'estimates', label: 'Estimates', icon: FileText, group: 'Sales', subject: 'Estimate', mainOnly: true, live: true },
  { slug: 'customers', label: 'Customers', icon: Users, group: 'Sales', subject: 'Customer' },
  { slug: 'sales', label: 'Sales', icon: TrendingUp, group: 'Sales', subject: 'Report', mainOnly: true },
  { slug: 'commissions', label: 'Commissions', icon: Calculator, group: 'Sales', subject: 'Report', mainOnly: true },

  // ── Finance ───────────────────────────────────────────────────────────────
  // Strategic suite (F1–F8)
  { code: 'F1', slug: 'job-profitability', label: 'Job Profitability / Costing', icon: PieChart, group: 'Finance', subject: 'Report' },
  { code: 'F2', slug: 'revenue', label: 'Revenue — Completed vs Invoiced vs Collected', icon: TrendingUp, group: 'Finance', subject: 'Report', live: true },
  { code: 'F3', slug: 'pnl-by-business-unit', label: 'P&L by Business Unit', icon: Building2, group: 'Finance', subject: 'Report' },
  { code: 'F4', slug: 'unpaid-invoices', label: 'Unpaid Invoices & Collections', icon: Hourglass, group: 'Finance', subject: 'Invoice', live: true },
  { code: 'F5', slug: 'payments', label: 'Payments Collected & Method Mix', icon: CircleDollarSign, group: 'Finance', subject: 'Invoice', live: true },
  { code: 'F6', slug: 'cash-flow-forecast', label: 'Cash Flow Forecast', icon: Banknote, group: 'Finance', subject: 'Invoice' },
  { code: 'F7', slug: 'average-ticket', label: 'Average Ticket Trends', icon: Receipt, group: 'Finance', subject: 'Report' },
  { code: 'F8', slug: 'pricebook-integrity', label: 'Pricebook Margin Integrity', icon: Tag, group: 'Finance', subject: 'PriceBook' },
  // Entity reports
  { slug: 'invoices', label: 'Invoices', icon: Receipt, group: 'Finance', subject: 'Invoice', mainOnly: true, live: true },
  { slug: 'tax', label: 'Tax', icon: Percent, group: 'Finance', subject: 'Invoice' },
  { slug: 'tips', label: 'Tips', icon: Coins, group: 'Finance', subject: 'Report' },
  { slug: 'expenses', label: 'Expenses', icon: Wallet, group: 'Finance', subject: 'Report', mainOnly: true },
  { slug: 'franchise', label: 'Franchise Report', icon: Store, group: 'Finance', subject: 'Report' },

  // ── Operations ────────────────────────────────────────────────────────────
  // Strategic suite (O1–O8)
  { code: 'O1', slug: 'tech-scorecard', label: 'Technician Scorecard', icon: UserCog, group: 'Operations', subject: 'Report' },
  { code: 'O2', slug: 'billable-efficiency', label: 'Billable Efficiency / Utilization', icon: Gauge, group: 'Operations', subject: 'Report' },
  { code: 'O3', slug: 'schedule-capacity', label: 'Schedule Capacity & Booked-Out', icon: CalendarDays, group: 'Operations', subject: 'Job' },
  { code: 'O4', slug: 'travel-time', label: 'Travel Time & On-Time Arrival', icon: Truck, group: 'Operations', subject: 'Job' },
  { code: 'O5', slug: 'first-time-fix', label: 'First-Time Fix & Completion Rate', icon: Wrench, group: 'Operations', subject: 'Job' },
  { code: 'O6', slug: 'callback-recall', label: 'Callback / Recall Rate', icon: RotateCcw, group: 'Operations', subject: 'Job' },
  { code: 'O7', slug: 'duration-variance', label: 'Estimated vs Actual Duration', icon: Timer, group: 'Operations', subject: 'Job' },
  { code: 'O8', slug: 'service-agreement-health', label: 'Service Agreement Health', icon: ShieldCheck, group: 'Operations', subject: 'Report' },
  { slug: 'communication-tracking', label: 'Communication Tracking & QA', icon: Phone, group: 'Operations', subject: 'Communication' },
  // Entity reports
  { slug: 'jobs', label: 'Jobs', icon: Briefcase, group: 'Operations', subject: 'Job', mainOnly: true, live: true },
  { slug: 'job-statistics', label: 'Job Statistics', icon: BarChart3, group: 'Operations', subject: 'Job', mainOnly: true },
  { slug: 'schedule', label: 'Schedule', icon: CalendarDays, group: 'Operations', subject: 'Job' },
  { slug: 'fleet', label: 'Fleet', icon: Truck, group: 'Operations', subject: 'Job' },
  { slug: 'inventory-usage', label: 'Inventory Usage', icon: Boxes, group: 'Operations', subject: 'Inventory', live: true, feature: 'inventory' },
  { slug: 'items-and-services', label: 'Items & Services', icon: Tag, group: 'Operations', subject: 'Inventory', mainOnly: true },
  { slug: 'activity', label: 'Activity', icon: Activity, group: 'Operations', subject: 'Report', mainOnly: true, live: true },
  { slug: 'staff-performance', label: 'Staff Performance', icon: UserCog, group: 'Operations', subject: 'User' },
  { slug: 'timesheets', label: 'Timesheets', icon: Clock, group: 'Operations', subject: 'Report', mainOnly: true, live: true },
  { slug: 'tasks', label: 'Tasks', icon: ClipboardCheck, group: 'Operations', subject: 'Report', mainOnly: true },
  { slug: 'equipment', label: 'Equipment', icon: PackagePlus, group: 'Operations', subject: 'Inventory' },
  { slug: 'service-plans', label: 'Service Plans', icon: CalendarCheck, group: 'Operations', subject: 'Report', mainOnly: true },

  // ── Marketing ─────────────────────────────────────────────────────────────
  // Strategic suite (M1–M8)
  { code: 'M1', slug: 'campaign-roi', label: 'Campaign ROI Scorecard', icon: Megaphone, group: 'Marketing', subject: 'Report' },
  { code: 'M2', slug: 'call-tracking', label: 'Call Tracking by Source', icon: Phone, group: 'Marketing', subject: 'Communication' },
  { code: 'M3', slug: 'paid-ads-revenue', label: 'Paid Ads → Revenue (closed-loop)', icon: MousePointerClick, group: 'Marketing', subject: 'Report' },
  { code: 'M4', slug: 'email-sms-revenue', label: 'Email / SMS Campaign Revenue', icon: Mail, group: 'Marketing', subject: 'Communication' },
  { code: 'M5', slug: 'reviews', label: 'Reviews & Reputation', icon: Star, group: 'Marketing', subject: 'Report' },
  { code: 'M6', slug: 'cac-ltv', label: 'CAC / LTV / New-vs-Repeat', icon: Users, group: 'Marketing', subject: 'Report' },
  { code: 'M7', slug: 'referrals', label: 'Referral Performance', icon: Share2, group: 'Marketing', subject: 'Report' },
  { code: 'M8', slug: 'geo-heatmap', label: 'Geographic Revenue Heatmap', icon: MapPin, group: 'Marketing', subject: 'Report', deferred: true },
  // Entity reports
  { slug: 'call-tracking-summary', label: 'Call Tracking', icon: Phone, group: 'Marketing', subject: 'Communication', mainOnly: true },
  { slug: 'marketing', label: 'Marketing', icon: Megaphone, group: 'Marketing', subject: 'Report' },
  { slug: 'website-requests', label: 'Website Requests', icon: Globe, group: 'Marketing', subject: 'Report' },
];

/**
 * The "Main" landing tab — mirrors Workiz's first reports tab.
 * Order matches Workiz exactly. `label` is the Workiz wording shown ON THE CARD;
 * each report's own page still uses its canonical catalog label (above).
 */
export const mainReports: { slug: string; label: string }[] = [
  { slug: 'jobs', label: 'Jobs' },
  { slug: 'sales', label: 'Sales' },
  { slug: 'job-statistics', label: 'Job Statistics' },
  { slug: 'leads', label: 'Leads Report' },
  { slug: 'payments', label: 'Payments' },
  { slug: 'expenses', label: 'Expenses' },
  { slug: 'activity', label: 'Activity' },
  { slug: 'estimates', label: 'Estimates' },
  { slug: 'invoices', label: 'Invoices' },
  { slug: 'unpaid-invoices', label: 'Aging invoices' },
  { slug: 'timesheets', label: 'Timesheets' },
  { slug: 'items-and-services', label: 'Items and services' },
  { slug: 'call-tracking-summary', label: 'Call Tracking' },
  { slug: 'tasks', label: 'Tasks' },
  { slug: 'service-plans', label: 'Service Plans' },
  { slug: 'commissions', label: 'Commissions (Legacy)' },
];

/**
 * Slugs this catalog used to publish, and what they are called now.
 *
 * A report's slug IS its URL (`/reports/:slug`), so renaming one breaks every
 * bookmark, saved link and pasted URL that pointed at the old name. Renames are
 * therefore recorded here rather than simply applied, and `ReportRoute` redirects
 * the old slug to the new one instead of showing the "no such report" stub.
 *
 * `ar-aging` -> `unpaid-invoices`: "AR" is accountant's jargon that the peer
 * products deliberately avoid in their own UIs, and this catalog is user-facing
 * copy. The backend route (`GET /api/reports/ar-aging`) is untouched - it is an
 * internal contract, not something a contractor reads.
 */
export const RENAMED_REPORT_SLUGS: Readonly<Record<string, string>> = {
  'ar-aging': 'unpaid-invoices',
};

export function findReport(slug: string | undefined): ReportDef | undefined {
  return reportCatalog.find((r) => r.slug === slug);
}

/**
 * Org-level visibility, three axes:
 *  1. demo orgs see every report (mock-first, for sales) - short-circuits before
 *     the entitlement axis so a future lower-plan demo org keeps the walkthrough;
 *  2. entitlement - a declared `feature` the org's plan lacks hides the report,
 *     even if it is `live`;
 *  3. `live` - real orgs only see reports with a real DB-backed data path.
 * This is ANDed with the CASL `read` subject check at each call site (see
 * `isReportVisible` below). Fails closed - an unknown report is never shown.
 * `hasFeature` is REQUIRED, not optional-defaulting-true, so no future call
 * site can silently skip the entitlement axis.
 */
export function canShowReport(
  report: ReportDef | undefined,
  isDemoOrg: boolean,
  hasFeature: (key: string) => boolean,
): boolean {
  if (!report) return false;
  if (isDemoOrg) return true;
  if (report.feature && !hasFeature(report.feature)) return false;
  return !!report.live;
}

export interface ReportVisibilityCtx {
  canRead: (subject: AppSubject) => boolean;
  isDemoOrg: boolean;
  hasFeature: (key: string) => boolean;
}

/**
 * The one per-card visibility decision both ReportsPage call sites (the
 * category-tab grid and the Main-tab curated list) share - CASL `read` ANDed
 * with `canShowReport`'s org-level axes.
 */
export function isReportVisible(
  report: ReportDef | undefined,
  ctx: ReportVisibilityCtx,
): report is ReportDef {
  if (!report) return false;
  return ctx.canRead(report.subject) && canShowReport(report, ctx.isDemoOrg, ctx.hasFeature);
}
