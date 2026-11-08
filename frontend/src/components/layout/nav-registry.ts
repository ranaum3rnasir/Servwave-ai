import {
  CalendarDays, ClipboardList, Phone, Briefcase, Filter,
  FileText, Receipt, Repeat, Tag, Hourglass, BarChart3, LineChart, Truck, Boxes,
  MessagesSquare, Megaphone, PieChart, Trophy, TrendingUp, CircleDollarSign, Award,
  Package, ShoppingCart, MessageCircle, Mail, MessageSquare, User, Zap,
  type LucideIcon,
} from 'lucide-react';
import type { AppAction, AppSubject } from '@/lib/ability';

// Core-navigation glyphs come from the ServWave Icon Library board — see
// `@/lib/servwave-icons` (the canonical board → lucide mapping). Imported by
// concept name below so the sidebar stays 1:1 with the board.

/** A leaf row rendered inside an expandable group. */
export interface NavChild {
  key: string;
  label: string;
  icon: LucideIcon;
  href: string;
  action: AppAction;
  subject: AppSubject;
  /** Backend integration still pending — renders the amber "coming soon" badge. */
  comingSoon?: boolean;
  /**
   * Entitlement key for THIS child. A group's children no longer have to share
   * the parent's gate: Communication holds both `phone` and `email`, and an org
   * that bought only one must see only that one's rows. A child with no key
   * inherits nothing - it is simply ungated beyond the parent.
   */
  feature?: string;
  /**
   * Demo-only child. Real (non-demo) orgs see the row LOCKED (greyed,
   * non-clickable, "coming soon") rather than hidden, and its route is blocked
   * by <DemoOnlyRoute> - hiding a row whose route still resolves is not a gate,
   * it is just a row you cannot find. Mirrors NavDestination.demoOnly.
   */
  demoOnly?: boolean;
}

export interface NavDestination {
  key: string;
  label: string;
  icon: LucideIcon;
  href: string;
  action: AppAction;
  subject: AppSubject;
  /** Human-readable home shown in the Add-shortcut picker. */
  home: string;
  /**
   * Backend integration still pending. Flat rows render the amber clock badge;
   * groups stack a "Coming soon" caption under the label (ServWave treatment —
   * never a text pill, which steals label width in the 240px rail).
   */
  comingSoon?: boolean;
  /**
   * Demo-only feature. Real (non-demo) orgs see the row locked as "coming soon"
   * (greyed, non-clickable) and its route is blocked by <DemoOnlyRoute>; demo
   * orgs get the working page. Used for mock-only surfaces not yet backed by a
   * real API (e.g. Marketing). The gate reads `useIsDemoOrg()`.
   */
  demoOnly?: boolean;
  /**
   * Org ids that unlock a `demoOnly` destination even though they're not demo
   * orgs. Used by Communication to admit the Phase-0 phone pilot org
   * while keeping the module locked for every other real org.
   */
  demoOnlyUnlockOrgIds?: string[];
  /**
   * Entitlement key(s) - the row locks with a plan badge when the org holds
   * NONE of them. An array means OR: Communication is `['phone', 'email']`
   * because email left the `phone` master switch and either one alone is
   * enough to make the module worth showing.
   */
  feature?: string | string[];
  /**
   * When present, the destination renders as an expandable group in the
   * sidebar (click toggles open/closed — it does not navigate). Each child
   * carries its own CASL action/subject so role-gating still applies.
   */
  children?: NavChild[];
}

/**
 * True when a `demoOnly` destination is unlocked for this org via its allowlist
 * (`demoOnlyUnlockOrgIds`). Shared by the Sidebar lock and the Add-shortcut
 * picker so both compute the demo lock identically.
 *
 * Comm access moved to the `phone` entitlement, so `marketing` is the only
 * remaining `demoOnly` entry; its allowlist admits one real org (by id) to
 * the mock Marketing Analytics screen. Also called by DemoOnlyRoute, so the
 * nav lock and the route guard always agree - an org unlocked in one but not
 * the other would click a live row straight into a redirect.
 */
export function isDemoDestUnlockedForOrg(
  dest: NavDestination,
  orgId: string | undefined,
): boolean {
  return !!orgId && (dest.demoOnlyUnlockOrgIds?.includes(orgId) ?? false);
}

/**
 * Everything a nav surface needs to decide what a given user may see.
 *
 * Both sidebars (legacy `Sidebar`, kit-based `V2AppLayout`) resolve the same
 * questions - is this row entitled, is it demo-locked, where does a GROUP
 * actually land - so the answers live here once. Two implementations of "which
 * child is reachable" drift the moment one gains a key the other has not heard
 * of, and the symptom is a nav row pointing at a route that bounces to
 * /upgrade.
 */
export interface NavAccess {
  /** CASL check, i.e. `ability.can`. */
  can: (action: AppAction, subject: AppSubject) => boolean;
  /** Resolved org entitlement keys (empty array when not yet known). */
  orgFeatures: string[];
  /** True once the entitlement payload has actually arrived. */
  entitlementsReady: boolean;
  isDemoOrg: boolean;
}

/**
 * Whether the org holds a row's entitlement. An array of keys is OR.
 *
 * FAILS OPEN before the payload lands (`entitlementsReady === false`) for the
 * same reason `useFeature` does: a cold cache must not grey out every module on
 * first paint. The real boundary is the backend 402.
 */
export function hasNavFeature(
  feature: string | string[] | undefined,
  access: NavAccess,
): boolean {
  if (feature === undefined) return true;
  const keys = Array.isArray(feature) ? feature : [feature];
  if (keys.length === 0) return true;
  if (!access.entitlementsReady) return true;
  return keys.some((key) => access.orgFeatures.includes(key));
}

/**
 * A child row is locked (visible but greyed and non-navigable) when it is
 * demo-only and this is a real org. Locked, never hidden - its route exists.
 */
export function isNavChildLocked(child: NavChild, access: NavAccess): boolean {
  return !!child.demoOnly && !access.isDemoOrg;
}

/**
 * The children of a group this user may SEE: CASL-permitted and entitled.
 *
 * Demo-locked children stay in the list on purpose - they render locked, which
 * is the whole point of `demoOnly` at child level. Unentitled children are
 * dropped outright: an org that never bought the module should not be told what
 * it is missing four separate times inside one group.
 */
export function visibleNavChildren(dest: NavDestination, access: NavAccess): NavChild[] {
  return (dest.children ?? []).filter(
    (child) => access.can(child.action, child.subject) && hasNavFeature(child.feature, access),
  );
}

/**
 * Where a destination actually lands.
 *
 * A group's own `href` is a fallback, not a truth: Communication is declared at
 * `/communication/phone`, which is a dead link for an org that bought email but
 * not phone. So a group resolves to its FIRST reachable child (CASL-permitted,
 * entitled, not demo-locked) and only falls back to its declared href when no
 * child qualifies.
 */
export function resolveNavHref(dest: NavDestination, access: NavAccess): string {
  if (!dest.children?.length) return dest.href;
  const reachable = visibleNavChildren(dest, access).find(
    (child) => !isNavChildLocked(child, access),
  );
  return reachable?.href ?? dest.href;
}

export const NAV_REGISTRY: NavDestination[] = [
  { key: 'dashboard',     label: 'Dashboard',      icon: BarChart3,       href: '/',                     action: 'read',   subject: 'Dashboard',     home: 'Page' },
  { key: 'schedule',      label: 'Schedule',       icon: CalendarDays,    href: '/schedule',             action: 'read',   subject: 'Job',           home: 'Page' },
  { key: 'tasks',         label: 'Tasks',          icon: ClipboardList,   href: '/tasks',                action: 'read',   subject: 'Task',          home: 'Page' },
  { key: 'leads',         label: 'Leads',          icon: Filter,          href: '/leads',                action: 'read',   subject: 'Lead',          home: 'Page', feature: 'leads' },
  { key: 'jobs',          label: 'Jobs',           icon: Briefcase,       href: '/jobs',                 action: 'read',   subject: 'Job',           home: 'Page' },
  { key: 'clients',       label: 'Customers',      icon: User,            href: '/customers',            action: 'read',   subject: 'Customer',      home: 'Page' },
  { key: 'estimates',     label: 'Estimates',      icon: FileText,        href: '/estimates',            action: 'read',   subject: 'Estimate',      home: 'Page' },
  { key: 'invoices',      label: 'Invoices',       icon: Receipt,         href: '/invoices',             action: 'read',   subject: 'Invoice',       home: 'Page' },
  { key: 'service-plans', label: 'Service Plans',  icon: Repeat,          href: '/service-plans',        action: 'read',   subject: 'ServicePlan',   home: 'Page', feature: 'service_plans' },
  // Automation Center — icon per the ServWave board mapping (automation → Zap in servwave-icons).
  { key: 'automations',   label: 'Automations',    icon: Zap,             href: '/automations',          action: 'read',   subject: 'Automation',    home: 'Page', feature: 'automations' },
  // feature: 'inventory' - /inventory/price-book is inside <RequireFeature feature="inventory">
  // in App.tsx and PriceBookPage reads the Scale-gated /api/inventory/* catalog hooks. Without
  // this key the row rendered unlocked on Starter/Pro and bounced to /upgrade on click; it now
  // locks with a plan badge like every other gated module.
  { key: 'pricebook',     label: 'Price Book',     icon: Tag,             href: '/inventory/price-book', action: 'read',   subject: 'Inventory',     home: 'Inventory', feature: 'inventory' },
  { key: 'billing',       label: 'Billing',        icon: Hourglass,       href: '/reports/unpaid-invoices', action: 'read', subject: 'Report', home: 'Reports · Unpaid Invoices' },
  { key: 'reports',       label: 'Reports',        icon: LineChart,       href: '/reports',              action: 'read',   subject: 'Report',        home: 'Page' },
  { key: 'inventory',     label: 'Inventory',      icon: Boxes,           href: '/inventory',            action: 'read',   subject: 'Inventory',     home: 'Page', feature: 'inventory',
    children: [
      { key: 'inv-stock',      label: 'Stock',           icon: Package,      href: '/inventory',                action: 'read', subject: 'Inventory' },
      { key: 'inv-pricebook',  label: 'Price Book',      icon: Tag,          href: '/inventory/price-book',     action: 'read', subject: 'Inventory' },
      { key: 'inv-pos',        label: 'Purchase Orders', icon: ShoppingCart, href: '/inventory/purchase-orders', action: 'read', subject: 'PurchaseOrder' },
      { key: 'inv-vendors',    label: 'Vendors',         icon: Truck,        href: '/inventory/vendors',        action: 'read', subject: 'Vendor' },
      // Children are not DEFAULT_LAYOUT_KEYS entries → no layout-version bump.
    ] },
  // Communication is TWO entitlements, not one. The CTM phone system (calls,
  // SMS, WhatsApp) stays behind `phone` (Pro+); email is its own `email` key
  // (every plan). The GROUP shows when the org holds either, and each child
  // carries its own key, so a Starter org with Communication dark still sees
  // the group with Email in it and nothing else. `href` below is only the
  // fallback - the landing target is resolved per user by resolveNavHref().
  // #2046 - `action` is `access_inbox`, not `read`: this group is the org-wide
  // Communication SECTION (sidebar + /communication/* pages), a different
  // surface from the per-record Communication tab on a lead/job/customer,
  // which keeps working on `read Communication` alone.
  { key: 'communication', label: 'Communication',  icon: MessagesSquare,  href: '/communication/phone',  action: 'access_inbox',   subject: 'Communication', home: 'Page', comingSoon: false, feature: ['phone', 'email'],
    children: [
      { key: 'comm-phone',    label: 'Phone',    icon: Phone,         href: '/communication/phone',         action: 'access_inbox', subject: 'Communication', comingSoon: false, feature: 'phone' },
      // demoOnly: WhatsApp has no connected Business account for a real org (the
      // page says so and the send 409s), so the row locks instead of promising a
      // channel that cannot send. Route blocked by <DemoOnlyRoute> to match.
      { key: 'comm-whatsapp', label: 'WhatsApp', icon: MessageCircle, href: '/communication/whatsapp',      action: 'access_inbox', subject: 'Communication', comingSoon: true,  feature: 'phone', demoOnly: true },
      // comingSoon STAYS until the inbox is correct for shared use - it is a
      // badge, not a gate (nothing but HomeRoute's landing pick reads it).
      { key: 'comm-email',    label: 'Email',    icon: Mail,          href: '/communication/inbox',         action: 'access_inbox', subject: 'Communication', comingSoon: true,  feature: 'email' },
      { key: 'comm-text',     label: 'Text',     icon: MessageSquare, href: '/communication/text',          action: 'access_inbox', subject: 'Communication', comingSoon: false, feature: 'phone' },
    ] },
  // Marketing is a mock-only screen (no /api/marketing). One real org is
  // allowlisted by id so the screen can be presented to them; every other org keeps
  // the row locked. Same org id in staging and prod. Remove the allowlist once a
  // real backend lands and the `demoOnly` flag comes off.
  { key: 'marketing',     label: 'Marketing',      icon: Megaphone,       href: '/marketing',            action: 'read',   subject: 'Report',        home: 'Page', demoOnly: true,
    demoOnlyUnlockOrgIds: ['11111111-2222-4333-8444-555555555555'] },
  // Extra reports — pinnable via Add-shortcut, not in the default sidebar:
  { key: 'rpt-job-profit', label: 'Job Profitability',       icon: PieChart,   href: '/reports/job-profitability', action: 'read', subject: 'Report',  home: 'Reports · Finance' },
  { key: 'rpt-rep-board',  label: 'Salesperson Leaderboard', icon: Trophy,     href: '/reports/rep-leaderboard',   action: 'read', subject: 'Report',  home: 'Reports · Sales' },
  { key: 'rpt-revenue',    label: 'Revenue',                 icon: TrendingUp, href: '/reports/revenue',           action: 'read', subject: 'Report',  home: 'Reports · Finance' },
  { key: 'rpt-payments',   label: 'Payments Collected',      icon: CircleDollarSign, href: '/reports/payments',    action: 'read', subject: 'Report',  home: 'Reports · Finance' },
  { key: 'rpt-tech-perf',  label: 'Technician Performance',  icon: Award,      href: '/reports/tech-performance',  action: 'read', subject: 'Report',  home: 'Reports · Sales' },
];

/** Flat default order ("Option C") — keys present on a fresh sidebar. */
export const DEFAULT_LAYOUT_KEYS: string[] = [
  'dashboard', 'schedule', 'tasks', 'leads', 'jobs', 'clients',
  'estimates', 'invoices', 'service-plans', 'automations', 'pricebook', 'billing', 'reports',
  'inventory', 'communication', 'marketing',
];

/**
 * Layout schema version. Bump whenever a NEW nav item should reach EXISTING users who already
 * have a persisted layout (a fresh user always gets DEFAULT_LAYOUT_KEYS). On load, any addition
 * with `version` greater than the user's stored layout version is appended once — so a newly
 * released default appears without clobbering their order or re-adding items they removed.
 */
export const CURRENT_LAYOUT_VERSION = 3;
export const LAYOUT_ADDITIONS: { version: number; key: string }[] = [
  { version: 2, key: 'service-plans' },
  { version: 3, key: 'automations' },
];

const BY_KEY = new Map(NAV_REGISTRY.map((d) => [d.key, d]));

export function getDestination(key: string): NavDestination | undefined {
  return BY_KEY.get(key);
}
