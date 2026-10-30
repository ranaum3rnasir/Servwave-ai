/**
 * Key routes: the ONE list every mobile slice uses.
 *
 * These are the 52 distinct page states of the 2026-10-01 audit sweep (55 swept paths minus the
 * three that only redirect: /dashboard, /inventory/approvals and a bare /estimates/new), plus the
 * overlays the audit opened on them, plus the states later slices added (marked where they are).
 * Record ids come from the throwaway org seeded by
 * mobile-setup.ts, so nothing here points at a real organisation.
 *
 * `id` is the stable key: it is what allowlist.json and MOBILE_GATE_ROUTES use. A state id with a
 * `~` is an overlay opened on top of the route before its id (`leads~filter` = the Filter popover
 * on /leads). Selecting `leads` in MOBILE_GATE_ROUTES selects its overlays too.
 */

import type { Page } from '@playwright/test';

export interface GateFixtures {
  organizationId: string;
  /** A draft automation (no steps, never enabled), so `/automations/:id` opens a real builder (slice 62). */
  automationId: string;
  /** A second technician, used only by the Lighthouse run so it never shares (or signs out) the gate's admin sessions. */
  lighthouseTechEmail: string;
  lighthouseTechPassword: string;
  /** The seeded technician (signature.spec.ts seeds its own estimates through them). */
  techId: string;
  leadId: string;
  customerId: string;
  jobId: string;
  estimateOpen: { id: string; token: string };
  estimateWon: { id: string; token: string };
  invoiceOpen: { id: string; token: string };
  invoicePaid: { id: string; token: string };
}

export type OverlayKind = 'drawer' | 'create' | 'search' | 'filter' | 'new' | 'calendarView' | 'visitDialog' | 'addItem' | 'declineDialog' | 'notifications' | 'more' | 'statusChoice' | 'entityPicker' | 'datePicker' | 'phoneChoice';

export interface GateState {
  id: string;
  /** Audit group, kept so a slice can find "its" routes the way the audit grouped them. */
  group: 'shell' | 'crm' | 'money' | 'field' | 'admin' | 'public';
  path: (f: GateFixtures) => string;
  /** Logged out, cold open (public pages, login). */
  anon?: boolean;
  overlay?: OverlayKind;
  /**
   * Slice 62: a route the full sweep adds (the audit's "not swept at runtime" list). It runs only
   * in the sweep (MOBILE_GATE_SWEEP=1) or when selected by id or `group:sweep`, so a slice's own
   * `npm run test:mobile` stays on the key routes.
   */
  sweepOnly?: boolean;
  /** Runs before the page opens: a read-only stub for a state the throwaway org cannot reach. */
  prepare?: (page: Page) => Promise<void>;
}

const route = (group: GateState['group'], id: string, path: GateState['path'], extra: Partial<GateState> = {}): GateState => ({ group, id, path, ...extra });
const fixed = (p: string) => () => p;
const pub = (kind: 'invoices' | 'estimates', r: { id: string; token: string }) => `/p/${kind}/${r.id}?token=${encodeURIComponent(r.token)}`;

const PAGES: GateState[] = [
  // shell / navigation
  route('shell', 'home', fixed('/')),
  route('shell', 'reports', fixed('/reports')),
  route('shell', 'report-unpaid-invoices', fixed('/reports/unpaid-invoices')),
  // Added by slice 30 (reports readable on a phone): a live report with charts and a long title.
  route('shell', 'report-revenue', fixed('/reports/revenue')),
  route('shell', 'marketing', fixed('/marketing')),
  // CRM lists
  route('crm', 'leads', fixed('/leads')),
  route('crm', 'lead-detail', (f) => `/leads/${f.leadId}`),
  route('crm', 'lead-new', fixed('/leads/new')),
  route('crm', 'customers', fixed('/customers')),
  route('crm', 'customer-detail', (f) => `/customers/${f.customerId}`),
  route('crm', 'customer-new', fixed('/customers/new')),
  route('crm', 'customer-statement', (f) => `/customers/${f.customerId}/statement`),
  route('crm', 'tasks', fixed('/tasks')),
  // money
  route('money', 'estimates', fixed('/estimates')),
  route('money', 'estimate-detail', (f) => `/estimates/${f.estimateOpen.id}`),
  route('money', 'invoices', fixed('/invoices')),
  route('money', 'invoice-detail', (f) => `/invoices/${f.invoiceOpen.id}`),
  route('money', 'invoice-new', fixed('/invoices/new')),
  // Payments go-live P5: the Payments page (tiles, period picker, tab strip).
  route('money', 'payments', fixed('/payments')),
  // field
  route('field', 'jobs', fixed('/jobs')),
  route('field', 'job-detail', (f) => `/jobs/${f.jobId}`),
  route('field', 'job-new', fixed('/jobs/new')),
  route('field', 'schedule', fixed('/schedule')),
  route('field', 'comm-inbox', fixed('/communication/inbox')),
  route('field', 'comm-text', fixed('/communication/text')),
  route('field', 'comm-phone', fixed('/communication/phone')),
  // Slice 71: the pop-out phone page (outside the app shell), a key route now so a slice's own run covers it.
  route('field', 'phone-tab', fixed('/phone')),
  route('field', 'comm-whatsapp', fixed('/communication/whatsapp')),
  // admin
  route('admin', 'inventory', fixed('/inventory')),
  route('admin', 'inventory-staging', fixed('/inventory/staging')),
  route('admin', 'inventory-assets', fixed('/inventory/assets')),
  route('admin', 'inventory-low-stock', fixed('/inventory/low-stock')),
  route('admin', 'inventory-activity', fixed('/inventory/activity')),
  route('admin', 'inventory-logistic-orders', fixed('/inventory/logistic-orders')),
  route('admin', 'inventory-price-book', fixed('/inventory/price-book')),
  route('admin', 'inventory-purchase-orders', fixed('/inventory/purchase-orders')),
  route('admin', 'inventory-vendors', fixed('/inventory/vendors')),
  route('admin', 'service-plans', fixed('/service-plans')),
  route('admin', 'automations', fixed('/automations')),
  route('admin', 'automation-new', fixed('/automations/new')),
  route('admin', 'settings', fixed('/settings')),
  route('admin', 'settings-company', fixed('/settings/company')),
  route('admin', 'settings-users', fixed('/settings/users')),
  route('admin', 'settings-roles', fixed('/settings/roles')),
  route('admin', 'settings-phone-numbers', fixed('/settings/phone-numbers')),
  route('admin', 'settings-schedule-colors', fixed('/settings/schedule-colors')),
  route('admin', 'settings-tax-rates', fixed('/settings/tax-rates')),
  // Added by slice 17 (wide admin tables): the Locations table was not on the audit sweep.
  route('admin', 'settings-locations', fixed('/settings/locations')),
  route('admin', 'settings-profile', fixed('/settings/profile')),
  // Added by slice 48 (reorder by tap): the settings lists that were drag-only.
  route('admin', 'settings-decline-reasons', fixed('/settings/decline-reasons')),
  route('admin', 'settings-job-sub-statuses', fixed('/settings/job-sub-statuses')),
  route('admin', 'settings-payments', fixed('/settings/payments')),
  // The status badge's other tints. The throwaway org's own state is not stable: it carries a
  // fake connected account, and the nightly account-status refresh on staging (07:30 UTC) fails
  // closed for it, moving the badge from "Active" to "Under review" in the middle of a long run.
  // The page must read at AA in every state, so each tint is measured on its own, stubbed.
  route('admin', 'settings-payments-under-review', fixed('/settings/payments'), { prepare: stubStripeStatus({ charges: false }) }),
  route('admin', 'settings-payments-paused', fixed('/settings/payments'), { prepare: stubStripeStatus({ charges: false, disabledReason: 'requirements.past_due' }) }),
  // public and auth (cold open, logged out)
  route('public', 'login', fixed('/login'), { anon: true }),
  route('public', 'accept-invite', fixed('/accept-invite'), { anon: true }),
  route('public', 'public-invoice-open', (f) => pub('invoices', f.invoiceOpen), { anon: true }),
  route('public', 'public-invoice-paid', (f) => pub('invoices', f.invoicePaid), { anon: true }),
  route('public', 'public-estimate-open', (f) => pub('estimates', f.estimateOpen), { anon: true }),
  route('public', 'public-estimate-won', (f) => pub('estimates', f.estimateWon), { anon: true }),
  route('public', 'upgrade', fixed('/upgrade')),
];

/** The overlays the audit opened, as their own states. */
const OVERLAYS: Array<[string, OverlayKind]> = [
  ['home', 'drawer'],
  ['home', 'create'],
  ['home', 'search'],
  // Slice 13: the top bar's own surfaces. The notifications panel (a bottom sheet on phones, a
  // popover wide) and the phone overflow menu holding Text messages, Inbox, the dialer, Help and
  // the account actions (no such menu wide: the actions are inline there).
  ['home', 'notifications'],
  ['home', 'more'],
  ['leads', 'filter'],
  ['leads', 'new'],
  ['customers', 'filter'],
  ['customers', 'new'],
  ['tasks', 'filter'],
  ['tasks', 'new'],
  ['estimates', 'filter'],
  ['estimates', 'new'],
  ['invoices', 'filter'],
  ['invoices', 'new'],
  ['jobs', 'filter'],
  ['jobs', 'new'],
  ['inventory', 'filter'],
  ['inventory', 'new'],
  ['service-plans', 'new'],
  ['schedule', 'calendarView'],
  // Slice 20: the job's visit dialog (one-off address open) and Add Item's new-item form.
  ['job-detail', 'visitDialog'],
  ['job-detail', 'addItem'],
  // Slice 28: the public estimate's decline dialog (the reason picker and the comment box).
  ['public-estimate-open', 'declineDialog'],
  // Slice 44: a short choice (the lead's status: a bottom sheet below md, a menu from md up) and a
  // searchable picker (New Task's linked record: full-screen below md, a popover from md up).
  ['lead-detail', 'statusChoice'],
  ['tasks', 'entityPicker'],
  // Slice 45: New Task's due-date calendar (a bottom sheet with 40 px days below md, the popover from md up).
  ['tasks', 'datePicker'],
  // Slice 50: tapping a customer's number offers Call or Text (a bottom sheet below md, a menu from
  // md up). Nothing is dialled.
  ['customer-detail', 'phoneChoice'],
];

export const KEY_STATES: GateState[] = [
  ...PAGES,
  ...OVERLAYS.map(([base, overlay]) => {
    const page = PAGES.find((p) => p.id === base);
    if (!page) throw new Error(`overlay on unknown route ${base}`);
    return { ...page, id: `${base}~${overlay}`, overlay };
  }),
];

export const PAGE_COUNT = PAGES.length;

/**
 * The audit's "not swept at runtime" list (02-current-state-audit.md section 7), as sweep-only
 * states (slice 62). Every path is a real route in `pages/v2/routes/`; the ids keep the key
 * routes' naming. The technician job-completion flow is not a page state: technician-flow.spec.ts.
 */
const sweep = (group: GateState['group'], id: string, p: GateState['path'], extra: Partial<GateState> = {}): GateState => ({ group, id, path: p, sweepOnly: true, ...extra });

/** The 21 report pages the key routes do not open (`reports`, `report-revenue` and `report-unpaid-invoices` are key routes). */
export const SWEEP_REPORT_SLUGS = [
  'activity', 'estimate-conversion', 'jobs', 'leads', 'sales', 'job-statistics', 'tech-performance',
  'weekly-rep-diagnostic', 'job-profitability', 'campaign-roi', 'communication-tracking', 'expenses',
  'inventory-usage', 'invoices', 'items-and-services', 'call-tracking-summary', 'commissions',
  'timesheets', 'estimates', 'payments', 'service-plans',
] as const;

/** A valid invite for the accept-invite form; nothing is accepted (the gate never submits it). */
const stubInvite = async (page: Page) => {
  await page.route('**/api/auth/invite', (route) =>
    route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify({ email: 'invitee@example.test', first_name: 'Gate', phone: null, phone_ext: null }) }));
};

/**
 * A read-only stub of the payments status for a state the throwaway org cannot hold steadily.
 * Only the status read is answered; nothing is written (the gate never presses the card's button).
 */
function stubStripeStatus(o: { charges: boolean; disabledReason?: string }) {
  return async (page: Page) => {
    await page.route('**/api/organization/stripe/status', (route) =>
      route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          stripe_account_id: 'acct_gate_stub',
          stripe_charges_enabled: o.charges,
          stripe_payouts_enabled: false,
          stripe_details_submitted: true,
          stripe_requirements_due: [],
          stripe_disabled_reason: o.disabledReason ?? null,
          collected_awaiting_payout: 0,
        }),
      }));
  };
}

export const SWEEP_STATES: GateState[] = [
  // The three reorderable settings lists (decline reasons, job sub-statuses, payments)
  // became key routes with slice 48, so the sweep covers them through KEY_STATES.
  sweep('crm', 'lead-edit', (f) => `/leads/${f.leadId}/edit`),
  sweep('crm', 'customer-edit', (f) => `/customers/${f.customerId}/edit`),
  sweep('money', 'estimate-version', (f) => `/estimates/${f.estimateOpen.id}/versions/1`),
  sweep('field', 'job-statement', (f) => `/jobs/${f.jobId}/statement`),
  sweep('admin', 'automation-detail', (f) => `/automations/${f.automationId}`),
  sweep('field', 'comm-phone-numbers', fixed('/communication/phone/numbers')),
  sweep('field', 'comm-text-settings', fixed('/communication/text/settings')),
  sweep('admin', 'settings-branding', fixed('/settings/branding')),
  sweep('admin', 'settings-email-sender', fixed('/settings/email-sender')),
  sweep('admin', 'settings-inventory', fixed('/settings/inventory')),
  sweep('admin', 'settings-phone-sms', fixed('/settings/phone-sms')),
  sweep('admin', 'settings-security', fixed('/settings/security')),
  ...SWEEP_REPORT_SLUGS.map((slug) => sweep('shell', `report-${slug}`, fixed(`/reports/${slug}`))),
  // The invite page's form state (the audit saw only its invalid-link state), logged out.
  sweep('public', 'accept-invite-form', fixed('/accept-invite?token=gate-invite'), { anon: true, prepare: stubInvite }),
  sweep('public', 'not-authorized', fixed('/not-authorized')),
];

/** Every state the sweep runs: the key routes, their overlays and the sweep-only routes. */
export const ALL_STATES: GateState[] = [...KEY_STATES, ...SWEEP_STATES];

/** True in the full sweep (`npm run test:mobile:sweep`), which adds the sweep-only routes and devices. */
export const isSweep = () => process.env.MOBILE_GATE_SWEEP === '1';

/**
 * MOBILE_GATE_ROUTES selects states: comma-separated ids, a route id also selecting its overlays,
 * `group:<name>` selecting an audit group (`group:sweep` the sweep-only routes), and a trailing `*`
 * as a prefix match (`settings*`, `inventory*`). Empty or unset = every key state, plus the
 * sweep-only routes in the full sweep.
 */
export function selectStates(spec = process.env.MOBILE_GATE_ROUTES ?? '', sweep = isSweep()): GateState[] {
  const parts = spec.split(',').map((s) => s.trim()).filter(Boolean);
  if (parts.length === 0) return sweep ? ALL_STATES : KEY_STATES;
  const picked = ALL_STATES.filter((s) =>
    parts.some((p) => {
      if (p === 'group:sweep') return !!s.sweepOnly;
      if (p.startsWith('group:')) return s.group === p.slice(6);
      if (p.endsWith('*')) return s.id.startsWith(p.slice(0, -1));
      return s.id === p || s.id.startsWith(`${p}~`);
    }),
  );
  const unknown = parts.filter((p) => !p.startsWith('group:') && !p.endsWith('*') && !ALL_STATES.some((s) => s.id === p || s.id.startsWith(`${p}~`)));
  if (unknown.length) throw new Error(`MOBILE_GATE_ROUTES: unknown state id(s): ${unknown.join(', ')}. See frontend/e2e/mobile/routes.ts`);
  return picked;
}
