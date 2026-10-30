import type { Action, Subject } from '../catalog';
import { ALL_PAYMENT_METHODS } from '../../payment-methods';

/**
 * M1 - the switch catalog (Roles & Permissions, PRD 1).
 *
 * Every capability a role or a person can hold is a named switch, held here as data. One entry drives
 * the Roles page, a person's Permissions page and the server check; no screen or controller keeps
 * its own list. The four built-in roles are only presets: a value per switch that a role or a person
 * starts from. Nothing in the product checks a role's name to decide what a switch allows.
 *
 * This is NOT `lib/permissions/catalog.ts`, which lists the (action, subject) pairs the ability layer
 * knows. A switch compiles INTO those pairs (`grants`), so the ability layer stays the one thing the
 * routes ask.
 *
 * `key` is stable and never reused. A switch added later states its four preset values here, and a
 * person who has no stored value for it takes the value of the role they are based on.
 */

/** The four built-in roles, each a preset of switch values. */
export const BUILT_IN_ROLES = ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] as const;
export type BuiltInRole = (typeof BUILT_IN_ROLES)[number];

/**
 * A switch's value: on/off, the chosen option of a choice switch (a Data Scope), or a list switch's value, which is
 * either the marker "All accepted methods" (a string) or a fixed subset of the switch's options (a list).
 */
export type SwitchValue = boolean | string | string[];

/**
 * A list switch's "everything the company accepts" value. Stored as this marker, never expanded into the methods the
 * company accepts today, so a method it accepts later is allowed with no edit to any role or person.
 */
export const ALL_ACCEPTED_METHODS = 'all_accepted';

/** Two switch values are the same value (lists by their members, in order). */
export function sameSwitchValue(a: SwitchValue | undefined, b: SwitchValue | undefined): boolean {
  if (Array.isArray(a) && Array.isArray(b)) return a.length === b.length && a.every((x, i) => x === b[i]);
  return a === b;
}

/** The records a Data Scope switch narrows. */
export type ScopedSubject = 'Lead' | 'Job' | 'Estimate' | 'Invoice';

/** One (action, subject) pair a switch compiles into while it is on. */
export interface GrantSpec {
  action: Action;
  subject: Subject;
  /**
   * Set when the grant acts on records, so it reaches only the records the person's Data Scope for
   * that subject reaches. Left out for a create (no record exists yet) and for grants that are not
   * about a record. A customer, a purchase order and a logistic order have no scope of their own: each
   * is reached through the records it hangs off (M3, "Modules with no scope switch"):
   *  - 'Customer': the customers of the leads and jobs the person reaches;
   *  - 'PurchaseOrder': orders on jobs the person can open (an order with no job needs Jobs scope All);
   *  - 'LogisticOrder': orders on jobs and leads the person can open (one on neither needs Jobs scope All);
   *  - 'LogisticOrderOnJob': the same, but only through a job: a new order is made on a job the person can open.
   */
  scoped?: ScopedSubject | 'Customer' | 'PurchaseOrder' | 'LogisticOrder' | 'LogisticOrderOnJob';
}

export interface SwitchEntry {
  /** Stable key, never reused. */
  key: string;
  /** The group the switch sits in on the Permissions page. */
  module: string;
  label: string;
  /** What the switch allows, written once and shown wherever the switch is. No vendor names. */
  helpText: string;
  kind: 'toggle' | 'choice' | 'list';
  /** A choice switch: the options a screen offers, in the order it shows them. */
  choices?: string[];
  /** A list switch: the members a fixed subset may hold, in the order a screen shows them. */
  listOptions?: string[];
  /** A choice switch: values that may be stored and are honoured but are never offered as a choice. */
  keptValues?: string[];
  /** A kept value's plain name and meaning, for a screen that shows it read-only beside the real choices. */
  keptValueHelp?: Record<string, { label: string; meaning: string }>;
  /** Keys of the switches this one needs on. An empty list means it stands on its own. */
  requires: string[];
  /** Switches of which at least one must be on ("View jobs or View leads"). */
  requiresAny?: string[];
  /** The ability-layer grants the switch stands for while it is on. Empty while its check belongs to a later slice. */
  grants: GrantSpec[];
  /**
   * Names of the server checks that enforce the switch. The route-level enforcement table has a row
   * for each, so a check listed here with no row there fails its suite.
   */
  serverChecks: string[];
  /**
   * Why the switch has no server check here: the slice or PRD that builds it. A switch with neither
   * `serverChecks` nor a `pending` note fails its suite, so nothing is left unaccounted for.
   */
  pending?: string;
  /** The value a role (and a custom role made from it) starts with, per built-in role. */
  presets: Record<BuiltInRole, SwitchValue>;
}

/** The selectable Data Scope choices, shared by every scope switch. */
const SCOPE_CHOICES = ['attached', 'team', 'all'];

/**
 * The kept scope value. Stored on Jobs only, so Sales keeps the reach it has
 * today; never offered as a choice and never accepted from a write that does not already hold it.
 */
export const THROUGH_OWN_LEADS = 'through_own_leads';
const throughOwnLeads = (records: string) => ({
  [THROUGH_OWN_LEADS]: {
    label: 'Through own leads',
    meaning: `${records} that come from a lead you are the Owner of. This is how Sales worked before.`,
  },
});

type Presets = Record<BuiltInRole, SwitchValue>;
const presets = (admin: SwitchValue, sales: SwitchValue, dispatcher: SwitchValue, technician: SwitchValue): Presets => ({
  ADMIN: admin, SALES: sales, DISPATCHER: dispatcher, TECHNICIAN: technician,
});

/**
 * A Data Scope switch key per record kind that has a scope of its own; the compile path reads the person's value from it.
 * Estimates and invoices have none (P6): who reaches them follows the Jobs and Leads scope.
 */
export const SCOPE_SWITCH_KEY: Record<'Lead' | 'Job', string> = {
  Lead: 'leads_scope', Job: 'jobs_scope',
};

type Draft = Omit<SwitchEntry, 'kind' | 'requires' | 'grants' | 'serverChecks'> &
  Partial<Pick<SwitchEntry, 'kind' | 'requires' | 'grants' | 'serverChecks'>>;
const entry = (d: Draft): SwitchEntry => ({
  kind: 'toggle', requires: [], grants: [], serverChecks: [], ...d,
});

export const SWITCH_CATALOG: readonly SwitchEntry[] = [
  entry({
    key: 'apply_discounts',
    module: 'Estimates',
    label: 'Apply discounts',
    helpText: 'Set or change a discount on an estimate, an invoice or a job.',
    grants: [
      { action: 'apply_discount', subject: 'Estimate' },
      { action: 'apply_discount', subject: 'Invoice' },
      { action: 'apply_discount', subject: 'Job' },
    ],
    serverChecks: [
      'estimate-create-discount',
      'estimate-update-discount',
      'estimate-line-add-discount',
      'estimate-line-update-discount',
      'invoice-line-add-discount',
      'invoice-line-update-discount',
      'invoice-billing-discount',
      'job-discount-write',
    ],
    presets: presets(true, true, false, false),
  }),

  // ─── Data scope ──────────────────────────────────────────────────────────────────────────────
  entry({
    key: 'leads_scope',
    module: 'Data Scope',
    label: 'Leads scope',
    helpText:
      'Which leads list and open: Attached (a lead you are the Owner or Dispatcher of, or on the walkthrough crew of), ' +
      'Team or All.',
    kind: 'choice',
    choices: SCOPE_CHOICES,
    pending: 'Not a check of its own: it sets which leads every Leads switch reaches.',
    presets: presets('all', 'attached', 'all', 'attached'),
  }),
  entry({
    key: 'jobs_scope',
    module: 'Data Scope',
    label: 'Jobs scope',
    helpText:
      'Which jobs list and open: Attached (a job you are on the crew of for any visit, past or upcoming, or are its Sold By or Dispatcher), ' +
      'Team or All.',
    kind: 'choice',
    choices: SCOPE_CHOICES,
    // Sales keeps the reach it has today until an admin changes it. The value is never offered as a choice.
    keptValues: [THROUGH_OWN_LEADS],
    keptValueHelp: throughOwnLeads('Jobs'),
    pending: 'Not a check of its own: it sets which jobs every Jobs switch reaches.',
    presets: presets('all', THROUGH_OWN_LEADS, 'all', 'attached'),
  }),
  entry({
    key: 'see_prices',
    module: 'Money',
    label: 'See prices',
    helpText:
      'See what things sell for: line prices, subtotals, totals, tax, discounts, balances, deposits and payment amounts on ' +
      'estimates, invoices, jobs and payments, the price book\'s sell price, and the customer balances built from them. ' +
      'Without it these are left out of every list, page, export and document. It is also what creating or editing an ' +
      'estimate or invoice and recording a payment stand on.',
    grants: [{ action: 'read', subject: 'Prices' }],
    // Each name is a response that carries a price, with a row in the route-level suite proving the price is left
    // out (the key is gone, never zero) while the record's other fields stay.
    serverChecks: [
      'estimate-list-prices',
      'estimate-detail-prices',
      'estimate-export-prices',
      'estimate-pdf-prices',
      'invoice-list-prices',
      'invoice-detail-prices',
      'invoice-export-prices',
      'invoice-pdf-prices',
      'job-detail-prices',
      'job-line-prices',
      'job-money-panel-prices',
      'job-history-prices',
      'payments-page-summary-prices',
      'payments-page-list-prices',
      'payments-page-detail-prices',
      'payments-page-export-prices',
      'payments-page-payouts-prices',
      'customer-detail-prices',
      'customer-summary-prices',
      'customer-statement-prices',
      'price-book-list-prices',
      'price-book-detail-prices',
      'stock-item-list-prices',
      'stock-item-detail-prices',
      'search-prices',
      'lead-detail-prices',
      'record-history-amounts',
      'report-row-prices',
      'dashboard-money-tiles',
    ],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'see_costs',
    module: 'Money',
    label: 'See costs',
    helpText:
      'See what things cost the company: item and line cost, markup and margin, job cost, labor rate and overhead, price book and stock cost, ' +
      'purchase order amounts, stock value and vendor account numbers. Prices are a separate switch (See prices), which this needs.',
    requires: ['see_prices'],
    // The grant keeps the subject it has always had ('Pricing'): every cost check in the controllers reads it, and renaming
    // the subject would touch each of them for no change in behaviour. The class is costs; 'Prices' is the price class.
    grants: [{ action: 'read', subject: 'Pricing' }],
    // Each name is a response that carries a cost, with a row in the route-level suite proving the cost is left
    // out (the key is gone, never zero) while the prices on the same response stay.
    serverChecks: [
      'estimate-cost',
      'invoice-cost',
      'job-cost',
      'job-line-cost',
      'organization-cost-model',
      'price-book-cost',
      'price-book-list-cost',
      'stock-item-cost',
      'stock-item-list-cost',
      'stock-movement-cost',
      'purchase-order-cost',
      'job-stage-cost',
      'vendor-account-number',
    ],
    presets: presets(true, true, false, false),
  }),
  entry({
    key: 'see_company_figures',
    module: 'Money',
    label: 'See company figures',
    helpText:
      'See company-wide money: revenue and collected-payment tiles and charts on the dashboard, revenue on the scoreboards, ' +
      'and the totals on reports. Job counts stay on the scoreboards without it. The activity feed reads the same for everyone. Needs See prices.',
    requires: ['see_prices'],
    grants: [{ action: 'read', subject: 'CompanyFigures' }],
    // Each name is a place the server leaves company money out (the key is gone, never zero), with a row in the
    // route-level suite proving it while the counts and the per-record prices beside it stay. `dashboard-activity-unchanged`
    // is the one place that is proven NOT to change: the activity feed names no figure in its words (M16), so it reads
    // the same with or without this switch.
    serverChecks: [
      'dashboard-company-figures',
      'dashboard-scoreboard-revenue',
      'dashboard-activity-unchanged',
      'report-revenue-totals',
      'report-payment-fees-totals',
      'report-estimate-conversion-totals',
      'report-unpaid-invoices-totals',
      'call-revenue',
      'agent-revenue',
    ],
    presets: presets(true, false, false, false),
  }),

  // ─── Customers ───────────────────────────────────────────────────────────────────────────────
  entry({
    key: 'view_customers',
    module: 'Customers',
    label: 'View customers',
    helpText:
      'Open customer pages (list and detail) and find customers in top search. Customer data that comes with a job or lead ' +
      'is part of that record, and the customer pickers in the new lead and new job forms do not need it.',
    grants: [{ action: 'read', subject: 'Customer', scoped: 'Customer' }],
    serverChecks: ['customer-list', 'customer-detail'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'create_customers',
    module: 'Customers',
    label: 'Create customers',
    helpText:
      'The standalone New Customer only. Not the new customer inside the lead and job forms (Create leads, Create jobs), ' +
      'and not the service plan builder\'s quick customer create (Create service plans).',
    requires: ['view_customers', 'edit_customers'],
    grants: [{ action: 'create', subject: 'Customer' }],
    serverChecks: ['customer-create'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'edit_customers',
    module: 'Customers',
    label: 'Edit customers',
    helpText: 'Change a customer record directly: details, locations and notes, on a customer within reach.',
    requires: ['view_customers'],
    grants: [{ action: 'update', subject: 'Customer', scoped: 'Customer' }],
    serverChecks: ['customer-update'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'delete_customers',
    module: 'Customers',
    label: 'Delete customers',
    helpText: 'Delete a customer within reach.',
    requires: ['view_customers'],
    grants: [{ action: 'delete', subject: 'Customer', scoped: 'Customer' }],
    serverChecks: ['customer-delete'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'export_customers',
    module: 'Customers',
    label: 'Export customers',
    helpText: 'Download the customer list, limited to the customers within reach.',
    requires: ['view_customers'],
    grants: [{ action: 'export', subject: 'Customer', scoped: 'Customer' }],
    serverChecks: ['customer-export'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'archive_customers',
    module: 'Customers',
    label: 'Archive customers',
    helpText: 'Archive and restore customers and their locations, within reach.',
    requires: ['view_customers'],
    grants: [{ action: 'archive', subject: 'Customer', scoped: 'Customer' }],
    serverChecks: ['customer-archive'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'edit_customer_record_ids',
    module: 'Customers',
    label: 'Edit record ID numbers (customers)',
    helpText: 'Change a customer\'s number, within reach.',
    requires: ['view_customers'],
    grants: [{ action: 'renumber', subject: 'Customer', scoped: 'Customer' }],
    serverChecks: ['customer-renumber'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'change_customer_created_date',
    module: 'Customers',
    label: 'Change customer created date',
    helpText: 'Backdate a customer\'s created date when editing the customer.',
    requires: ['edit_customers'],
    grants: [{ action: 'change_created_date', subject: 'Customer', scoped: 'Customer' }],
    serverChecks: ['customer-created-date'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'copy_customer_phone',
    module: 'Customers',
    label: 'Copy customer phone',
    helpText:
      'Select, copy and tap a customer\'s phone number. Off: the digits show but cannot be selected, copied or tapped, ' +
      'and the person dials by hand. Where the company has the phone service, tapping a phone always opens the in-app dialer.',
    pending: 'PRD 5 builds the customer surfaces that follow it; display only, the server never checks it.',
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'copy_customer_email',
    module: 'Customers',
    label: 'Copy customer email',
    helpText:
      'Select, copy and tap a customer\'s email (a tap opens the person\'s own mail app). Off: the address shows but cannot be ' +
      'selected, copied or tapped.',
    pending: 'PRD 5 builds the customer surfaces that follow it; display only, the server never checks it.',
    presets: presets(true, true, true, true),
  }),

  // ─── Leads ───────────────────────────────────────────────────────────────────────────────────
  entry({
    key: 'view_leads',
    module: 'Leads',
    label: 'View leads',
    helpText: 'Open leads within Leads scope. Without it no lead page opens and the list is empty.',
    grants: [{ action: 'read', subject: 'Lead', scoped: 'Lead' }],
    serverChecks: ['lead-list', 'lead-detail'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'create_leads',
    module: 'Leads',
    label: 'Create leads',
    helpText: 'Create a lead, with a new or existing customer.',
    requires: ['view_leads', 'edit_leads'],
    grants: [{ action: 'create', subject: 'Lead' }],
    serverChecks: ['lead-create'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'edit_leads',
    module: 'Leads',
    label: 'Edit leads',
    helpText: 'Edit leads in scope: details and tags, and every customer detail on the lead for that lead only.',
    requires: ['view_leads'],
    // The lead update route also gates a lead's tags; its notes follow Add notes (S01.11).
    grants: [{ action: 'update', subject: 'Lead', scoped: 'Lead' }],
    serverChecks: ['lead-update', 'lead-tag-add', 'lead-tag-remove', 'lead-contact-entry-add', 'lead-contact-entry-change', 'lead-contact-entry-correct', 'lead-contact-entry-remove', 'lead-contact-name-change'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'change_lead_status_by_hand',
    module: 'Leads',
    label: 'Change lead status by hand',
    helpText:
      "Set a lead's status from the lead's status menu. A status the lead's data contradicts shows locked, with the reason, " +
      'and is refused. Moving a lead to Lost also needs Mark leads lost. Walkthrough Scheduled and Walkthrough Completed ' +
      'also move by themselves as walkthroughs are booked and finished; those moves never need this switch.',
    requires: ['edit_leads'],
    grants: [{ action: 'change_status', subject: 'Lead', scoped: 'Lead' }],
    serverChecks: ['lead-status-change'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'delete_leads',
    module: 'Leads',
    label: 'Delete leads',
    helpText: 'Delete a lead.',
    requires: ['view_leads'],
    grants: [{ action: 'delete', subject: 'Lead', scoped: 'Lead' }],
    serverChecks: ['lead-delete'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'export_leads',
    module: 'Leads',
    label: 'Export leads',
    helpText: 'Download the lead list.',
    requires: ['view_leads'],
    grants: [{ action: 'export', subject: 'Lead', scoped: 'Lead' }],
    serverChecks: ['lead-export'],
    presets: presets(true, true, false, false),
  }),
  entry({
    key: 'assign_people_to_leads',
    module: 'Leads',
    label: 'Assign people to leads',
    helpText:
      'Choose every people field on a lead: its Owner and its Dispatcher, when the lead is created and when it is reassigned. ' +
      'Without it, the new-lead form pre-fills the person creating the lead as the Owner and that stands. A walkthrough\'s crew is ' +
      'not part of it: that stays with Create leads and Book walkthroughs. When a new lead has no Owner, holders are alerted ' +
      'to assign one.',
    requires: ['view_leads'],
    grants: [{ action: 'assign', subject: 'Lead', scoped: 'Lead' }],
    serverChecks: ['lead-reassign', 'lead-set-dispatcher', 'lead-create-owner'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'log_contact_attempts',
    module: 'Leads',
    label: 'Log contact attempts',
    helpText: 'Record a contact attempt on a lead.',
    requires: ['view_leads'],
    grants: [{ action: 'contact', subject: 'Lead', scoped: 'Lead' }],
    serverChecks: ['lead-contact'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'mark_leads_lost',
    module: 'Leads',
    label: 'Mark leads lost',
    helpText:
      'Close a lead as Lost, with a required typed reason. Lost is the only way a lead closes other than Won: ' +
      'there is no Cancelled lead status.',
    requires: ['view_leads'],
    grants: [{ action: 'mark_lost', subject: 'Lead', scoped: 'Lead' }],
    serverChecks: ['lead-mark-lost'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'reopen_leads',
    module: 'Leads',
    label: 'Reopen leads',
    helpText:
      'Reopen a closed lead, Won or Lost, with a required reason. The lead goes back to the status it had before it ' +
      'closed, or the furthest status its data supports.',
    requires: ['view_leads'],
    grants: [{ action: 'reopen', subject: 'Lead', scoped: 'Lead' }],
    serverChecks: ['lead-reopen'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'book_walkthroughs',
    module: 'Leads',
    label: 'Book walkthroughs',
    helpText: 'Book, move or cancel a single walkthrough after the lead is created.',
    requires: ['view_leads'],
    grants: [{ action: 'schedule_walkthrough', subject: 'Lead', scoped: 'Lead' }],
    serverChecks: ['lead-walkthrough-schedule'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'perform_walkthroughs',
    module: 'Leads',
    label: 'Perform walkthroughs',
    helpText: 'Start, note and finish a walkthrough they are crew on.',
    requires: ['view_leads'],
    grants: [{ action: 'perform_walkthrough', subject: 'Lead', scoped: 'Lead' }],
    serverChecks: ['lead-walkthrough-perform'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'edit_lead_record_ids',
    module: 'Leads',
    label: 'Edit record ID numbers (leads)',
    helpText: 'Change a lead\'s number.',
    requires: ['view_leads'],
    grants: [{ action: 'renumber', subject: 'Lead', scoped: 'Lead' }],
    serverChecks: ['lead-renumber'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'alert_every_lead',
    module: 'Leads',
    label: 'Alert me about every lead',
    helpText: 'Get a copy of every lead alert, on top of the normal recipients, for leads they can open.',
    requires: ['view_leads'],
    pending: 'Not a check of its own: the alert chain (alertChain.ts) reads it to add a copy of every alert of its area for its holders.',
    presets: presets(true, false, false, false),
  }),

  // ─── Jobs and visits ─────────────────────────────────────────────────────────────────────────
  entry({
    key: 'view_jobs',
    module: 'Jobs',
    label: 'View jobs',
    helpText: 'Open jobs within Jobs scope. Without it no job page opens and the list is empty.',
    grants: [{ action: 'read', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-list', 'job-detail'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'create_jobs',
    module: 'Jobs',
    label: 'Create jobs',
    helpText: 'Create a job, with a new or existing customer, or convert a lead to a job.',
    requires: ['view_jobs', 'edit_jobs'],
    grants: [{ action: 'create', subject: 'Job' }],
    serverChecks: ['job-create'],
    presets: presets(true, false, true, true),
  }),
  entry({
    key: 'edit_jobs',
    module: 'Jobs',
    label: 'Edit jobs',
    helpText: 'Change job details: service type, job type, description, address, tags and sub-status.',
    requires: ['view_jobs'],
    // The job update route also gates a job's tags and sub-status; its notes follow Add notes (S01.11).
    grants: [{ action: 'update', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-update', 'job-sub-status', 'job-tag-add', 'job-tag-remove', 'job-contact-entry-add', 'job-contact-entry-change', 'job-contact-entry-correct', 'job-contact-entry-remove', 'job-contact-name-change'],
    presets: presets(true, false, true, true),
  }),
  entry({
    key: 'delete_jobs',
    module: 'Jobs',
    label: 'Delete jobs',
    helpText: 'Delete a job.',
    requires: ['view_jobs'],
    grants: [{ action: 'delete', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-delete'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'export_jobs',
    module: 'Jobs',
    label: 'Export jobs',
    helpText: 'Download the job list.',
    requires: ['view_jobs'],
    grants: [{ action: 'export', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-export'],
    presets: presets(true, true, false, false),
  }),
  entry({
    key: 'edit_job_and_lead_contact_details',
    module: 'Jobs',
    label: 'Edit job and lead contact details',
    helpText:
      'Add or change a job-only or lead-only phone or email with the pencil icon next to it, on a job or lead they can ' +
      'open. The change applies only to that job or lead, never to the customer record.',
    requiresAny: ['view_jobs', 'view_leads'],
    // The same four endpoints sit under a lead (S05.13), where Edit leads is the other switch that lets a person in.
    grants: [
      { action: 'edit_contact_details', subject: 'Job', scoped: 'Job' },
      { action: 'edit_contact_details', subject: 'Lead', scoped: 'Lead' },
    ],
    serverChecks: [
      'job-contact-entry-add', 'job-contact-entry-change', 'job-contact-entry-correct', 'job-contact-entry-remove',
      'lead-contact-entry-add', 'lead-contact-entry-change', 'lead-contact-entry-correct', 'lead-contact-entry-remove',
    ],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'assign_work_to_others',
    module: 'Jobs',
    label: 'Assign work to other people',
    helpText: 'Name someone other than themselves in a crew or walkthrough list.',
    requires: ['view_jobs'],
    grants: [{ action: 'assign', subject: 'User' }],
    serverChecks: ['crew-other-person'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'schedule_visits',
    module: 'Jobs',
    label: 'Schedule visits',
    helpText: 'Add, move or cancel a visit after the job is created.',
    requires: ['view_jobs'],
    grants: [{ action: 'reschedule', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-visit-create'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'mark_on_my_way',
    module: 'Jobs',
    label: 'Mark on my way',
    helpText: '"On my way" on their own visits.',
    requires: ['view_jobs'],
    grants: [{ action: 'en_route', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-en-route'],
    presets: presets(true, false, true, true),
  }),
  entry({
    key: 'mark_arrived',
    module: 'Jobs',
    label: 'Mark arrived',
    helpText: '"Arrived" on their own visits.',
    requires: ['view_jobs'],
    grants: [{ action: 'arrive', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-arrive'],
    presets: presets(true, false, true, true),
  }),
  entry({
    key: 'assign_people_to_jobs',
    module: 'Jobs',
    label: 'Assign people to jobs',
    helpText:
      "Choose every people field on a job: put people on or take them off a visit's crew, and set the job's Dispatcher " +
      'and Sold By. Without it, the new-job form pre-fills the person creating the job and that stands. When a job has no ' +
      'Dispatcher, holders are alerted to schedule it.',
    requires: ['view_jobs'],
    grants: [
      { action: 'assign', subject: 'Job', scoped: 'Job' },
      { action: 'unassign', subject: 'Job', scoped: 'Job' },
    ],
    serverChecks: ['job-assign', 'job-unassign', 'job-set-dispatcher', 'job-set-sold-by', 'job-bulk-assign'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'start_and_finish_visits',
    module: 'Jobs',
    label: 'Start and finish visits',
    helpText:
      '"Start" on their own visits, and "Finish visit" on their own visit, which finishes it for the whole crew. ' +
      "Finishing a visit, even the job's last open one, never changes the job's status or starts the lock.",
    requires: ['view_jobs'],
    grants: [{ action: 'start', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-start', 'visit-start', 'visit-finish'],
    presets: presets(true, false, true, true),
  }),
  entry({
    key: 'update_any_visit_status',
    module: 'Jobs',
    label: "Update any visit's status",
    helpText:
      'The status steps (On my way, Arrived, Start, Finish visit) on visits and jobs they are not crew on. ' +
      "None of them changes the job's status.",
    requires: ['view_jobs'],
    grants: [{ action: 'update_any_visit_status', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-status-step-any-visit'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'complete_jobs',
    module: 'Jobs',
    label: 'Complete jobs',
    helpText:
      'Mark any job they can open Completed, meaning the whole job. It is the only action that starts the office review and ' +
      'the lock, and no crew membership is needed. If the job still has open visits, a confirmation lists them and offers to cancel them ' +
      'and complete the job.',
    requires: ['view_jobs'],
    grants: [{ action: 'complete', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-complete'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'duplicate_jobs',
    module: 'Jobs',
    label: 'Duplicate jobs',
    helpText: 'Duplicate a job they can open into a new job.',
    requires: ['view_jobs', 'create_jobs'],
    grants: [{ action: 'duplicate', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-duplicate'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'edit_job_line_items',
    module: 'Jobs',
    label: 'Edit job line items',
    helpText:
      "Add, change and remove a job's lines and scopes, on any job they can open, until it is Completed (a locked job " +
      'needs Change locked jobs too, or Office review while the job is in Office review). The switch alone decides: ' +
      "there is no exception for the job's creator or its Sold By.",
    requires: ['view_jobs'],
    grants: [{ action: 'manage_lines', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-line-write'],
    presets: presets(true, false, true, true),
  }),
  entry({
    key: 'office_review',
    module: 'Jobs',
    label: 'Office review',
    helpText:
      'See and work a job\'s office review (panel, customer decisions, checks) and finish it, moving the job to Ready to close. ' +
      'When a completed job has no Dispatcher, holders are alerted to review it.',
    requires: ['view_jobs'],
    grants: [{ action: 'office_review', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-office-review'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'close_jobs',
    module: 'Jobs',
    label: 'Close jobs',
    helpText: 'Move a job from Ready to close to Done. Holders are alerted when a job becomes Ready to close.',
    requires: ['view_jobs'],
    grants: [{ action: 'close', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-mark-done'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'close_jobs_with_money_owed',
    module: 'Jobs',
    label: 'Close jobs with money owed',
    helpText: 'Mark a job Done while money is still owed.',
    requires: ['view_jobs'],
    grants: [{ action: 'close_with_money_owed', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-mark-done-money-owed'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'cancel_jobs',
    module: 'Jobs',
    label: 'Cancel jobs',
    helpText:
      'Cancel a job, with a required reason picked from the company\'s job cancel-reasons list. A job is never Lost: ' +
      '"lost" is a lead word.',
    requires: ['view_jobs'],
    grants: [{ action: 'cancel', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-cancel', 'job-cancel-bulk'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'reopen_done_jobs',
    module: 'Jobs',
    label: 'Reopen Done jobs',
    helpText:
      'Reopen a job that is Done or cancelled: it goes back to In Progress and the lock lifts. Reopen is the only way ' +
      'out of Done and Cancelled.',
    requires: ['view_jobs'],
    grants: [{ action: 'reopen', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-reopen'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'change_locked_jobs',
    module: 'Jobs',
    label: 'Change locked jobs',
    helpText:
      'Change anything about a locked job (Completed or later, or Cancelled): details, people, existing visits, line ' +
      'items, discounts, files and notes. It never adds a new visit to a locked job.',
    requires: ['view_jobs'],
    grants: [{ action: 'change_locked', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-locked-change'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'edit_job_record_ids',
    module: 'Jobs',
    label: 'Edit record ID numbers (jobs)',
    helpText: 'Change a job\'s number.',
    requires: ['view_jobs'],
    grants: [{ action: 'renumber', subject: 'Job', scoped: 'Job' }],
    serverChecks: ['job-renumber'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'alert_every_job',
    module: 'Jobs',
    label: 'Alert me about every job',
    helpText: 'Get a copy of every job alert, on top of the normal recipients, for jobs they can open.',
    requires: ['view_jobs'],
    pending: 'Not a check of its own: the alert chain (alertChain.ts) reads it to add a copy of every alert of its area for its holders.',
    presets: presets(true, false, false, false),
  }),

  // ─── Estimates ───────────────────────────────────────────────────────────────────────────────
  entry({
    key: 'view_estimates',
    module: 'Estimates',
    label: 'View estimates',
    helpText: 'Open the estimates on the leads and jobs within your Leads scope and Jobs scope, and the ones you made for a customer alone. Without it no estimate page opens and the list is empty.',
    grants: [{ action: 'read', subject: 'Estimate', scoped: 'Estimate' }],
    serverChecks: ['estimate-list', 'estimate-detail'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'create_estimates',
    module: 'Estimates',
    label: 'Create estimates',
    helpText: 'Create an estimate on a lead or job they can open, or duplicate an estimate.',
    requires: ['view_estimates', 'edit_estimates', 'see_prices'],
    grants: [
      { action: 'create', subject: 'Estimate' },
      { action: 'duplicate', subject: 'Estimate', scoped: 'Estimate' },
    ],
    serverChecks: ['estimate-create', 'estimate-duplicate'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'standalone_estimates',
    module: 'Estimates',
    label: 'Standalone estimates',
    helpText: 'Create and send an estimate for a customer with no lead or job.',
    requires: ['create_estimates'],
    grants: [{ action: 'create_standalone', subject: 'Estimate' }],
    serverChecks: ['estimate-create-standalone', 'estimate-duplicate-standalone'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'edit_estimates',
    module: 'Estimates',
    label: 'Edit estimates',
    helpText:
      'Edit, send, resend, recall, cancel and archive estimates in scope.',
    requires: ['view_estimates', 'see_prices'],
    // One grant (update) gates an estimate's details, lines, notes and tags (Add notes covers jobs and leads only). Who made an
    // estimate opens nothing by itself (P7): this switch and the estimate being in scope are the whole test.
    grants: [
      { action: 'update', subject: 'Estimate', scoped: 'Estimate' },
      { action: 'send', subject: 'Estimate', scoped: 'Estimate' },
      { action: 'cancel', subject: 'Estimate', scoped: 'Estimate' },
      { action: 'revise', subject: 'Estimate', scoped: 'Estimate' },
    ],
    serverChecks: ['estimate-update', 'estimate-send', 'estimate-cancel', 'estimate-revise'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'delete_estimates',
    module: 'Estimates',
    label: 'Delete estimates',
    helpText: 'Delete estimates in scope.',
    requires: ['view_estimates'],
    grants: [{ action: 'delete', subject: 'Estimate', scoped: 'Estimate' }],
    serverChecks: ['estimate-delete'],
    presets: presets(true, true, false, false),
  }),
  entry({
    key: 'export_estimates',
    module: 'Estimates',
    label: 'Export estimates',
    helpText: 'Download the estimate list.',
    requires: ['view_estimates'],
    grants: [{ action: 'export', subject: 'Estimate', scoped: 'Estimate' }],
    serverChecks: ['estimate-export'],
    presets: presets(true, true, false, false),
  }),
  entry({
    key: 'approve_estimates',
    module: 'Estimates',
    label: 'Approve estimates',
    helpText: 'Approve an estimate for the customer (a verbal or off-platform yes), on an estimate they can open.',
    requires: ['view_estimates'],
    grants: [{ action: 'approve', subject: 'Estimate', scoped: 'Estimate' }],
    serverChecks: ['estimate-approve'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'decline_estimates',
    module: 'Estimates',
    label: 'Decline estimates',
    helpText: 'Decline an estimate for the customer, on an estimate they can open.',
    requires: ['view_estimates'],
    grants: [{ action: 'decline', subject: 'Estimate', scoped: 'Estimate' }],
    serverChecks: ['estimate-decline'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'waive_deposits',
    module: 'Estimates',
    label: 'Waive deposits',
    helpText: 'Waive an estimate\'s deposit, on an estimate they can open.',
    requires: ['view_estimates'],
    grants: [{ action: 'waive_deposit', subject: 'Estimate', scoped: 'Estimate' }],
    serverChecks: ['estimate-waive-deposit'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'edit_estimate_record_ids',
    module: 'Estimates',
    label: 'Edit record ID numbers (estimates)',
    helpText: 'Change an estimate\'s number.',
    requires: ['view_estimates'],
    grants: [{ action: 'renumber', subject: 'Estimate', scoped: 'Estimate' }],
    serverChecks: ['estimate-renumber'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'alert_every_estimate',
    module: 'Estimates',
    label: 'Alert me about every estimate',
    helpText: 'Get a copy of every estimate alert, on top of the normal recipients, for estimates they can open.',
    requires: ['view_estimates'],
    pending: 'Not a check of its own: the alert chain (alertChain.ts) reads it to add a copy of every alert of its area for its holders.',
    presets: presets(true, false, false, false),
  }),

  // ─── Invoices ────────────────────────────────────────────────────────────────────────────────
  entry({
    key: 'view_invoices',
    module: 'Invoices',
    label: 'View invoices',
    helpText: 'Open the invoices on the jobs within your Jobs scope, and the ones you made for a customer alone. Without it no invoice page opens and the list is empty.',
    grants: [{ action: 'read', subject: 'Invoice', scoped: 'Invoice' }],
    serverChecks: ['invoice-list', 'invoice-detail'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'create_invoices',
    module: 'Invoices',
    label: 'Create invoices',
    helpText: 'Create an invoice from a job they can open, and copy an estimate to an invoice.',
    requires: ['view_invoices', 'edit_invoices', 'see_prices'],
    grants: [{ action: 'create', subject: 'Invoice' }],
    serverChecks: ['invoice-create', 'invoice-create-from-job-items', 'estimate-copy-to-invoice'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'standalone_invoices',
    module: 'Invoices',
    label: 'Standalone invoices',
    helpText: 'Create and send an invoice for a customer with no job (the standalone New invoice).',
    requires: ['create_invoices'],
    grants: [{ action: 'create_standalone', subject: 'Invoice' }],
    serverChecks: ['invoice-create-standalone'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'edit_invoices',
    module: 'Invoices',
    label: 'Edit invoices',
    helpText:
      'Edit, send and resend invoices in scope.',
    requires: ['view_invoices', 'see_prices'],
    grants: [
      { action: 'update', subject: 'Invoice', scoped: 'Invoice' },
      { action: 'send', subject: 'Invoice', scoped: 'Invoice' },
    ],
    serverChecks: ['invoice-update', 'invoice-send'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'delete_invoices',
    module: 'Invoices',
    label: 'Delete invoices',
    helpText:
      'Delete draft invoices in scope.',
    requires: ['view_invoices'],
    grants: [{ action: 'delete', subject: 'Invoice', scoped: 'Invoice' }],
    serverChecks: ['invoice-delete'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'view_payments',
    module: 'Invoices',
    label: 'View payments and payouts',
    helpText:
      'Open the ServWave Payments area: card and bank payments, payouts, tax documents, and answer disputes. ' +
      'Refunds and payout-account changes follow their own switches.',
    grants: [{ action: 'view_payments', subject: 'Organization' }],
    serverChecks: [
      'payments-viewer-session',
      'payments-page-summary',
      'payments-page-list',
      'payments-page-detail',
      'payments-page-export',
      'payments-page-payouts',
      'payments-page-payout-detail',
      'payments-page-payout-payments',
      'payments-page-attention-summary',
      'payments-page-attention-list',
      'dispute-evidence-read',
    ],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'export_invoices',
    module: 'Invoices',
    label: 'Export invoices',
    helpText: 'Download the invoice list.',
    requires: ['view_invoices'],
    grants: [{ action: 'export', subject: 'Invoice', scoped: 'Invoice' }],
    serverChecks: ['invoice-export'],
    presets: presets(true, true, false, false),
  }),
  entry({
    key: 'record_payments',
    module: 'Invoices',
    label: 'Record payments',
    helpText:
      'Record a payment on an invoice they can open, and a deposit on an estimate they can open. ' +
      'The method must be one the company accepts and one of their Allowed payment methods.',
    requires: ['see_prices'],
    grants: [
      { action: 'record_payment', subject: 'Invoice', scoped: 'Invoice' },
      { action: 'record_payment', subject: 'Estimate', scoped: 'Estimate' },
    ],
    serverChecks: ['invoice-record-payment', 'estimate-record-payment'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'refund_payments',
    module: 'Invoices',
    label: 'Refund payments',
    helpText: 'Refund a payment or a deposit, send money back to a customer and settle payments that need attention.',
    grants: [{ action: 'refund', subject: 'Invoice', scoped: 'Invoice' }],
    requires: ['view_invoices', 'view_payments'],
    serverChecks: [
      'invoice-refund',
      'invoice-cancel-bank-payment',
      'payment-attention-list',
      'payment-attention-refund',
      'payment-attention-resolve',
      // Payments go-live P4: marking a failed payment or refund resolved from the Needs attention list.
      'payments-page-attention-resolve',
      // Payments go-live P10: saving and submitting the evidence on a dispute.
      'dispute-evidence-stage',
      'dispute-evidence-submit',
    ],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'send_payment_links',
    module: 'Invoices',
    label: 'Send payment links',
    helpText: 'Create a payment link for an invoice they can open; card payments only happen this way.',
    grants: [{ action: 'send_payment_link', subject: 'Invoice', scoped: 'Invoice' }],
    serverChecks: ['invoice-payment-link', 'payments-page-attention-contact'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'void_invoices',
    module: 'Invoices',
    label: 'Void invoices',
    helpText: 'Void an invoice they can open.',
    requires: ['view_invoices'],
    grants: [{ action: 'void', subject: 'Invoice', scoped: 'Invoice' }],
    serverChecks: ['invoice-void'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'apply_credits',
    module: 'Invoices',
    label: 'Apply credits',
    helpText: 'Apply a credit or give-back on an invoice they can open.',
    requires: ['view_invoices'],
    grants: [{ action: 'credit', subject: 'Invoice', scoped: 'Invoice' }],
    serverChecks: ['invoice-credit'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'void_payments',
    module: 'Invoices',
    label: 'Void payments',
    helpText: 'Void a recorded payment on an invoice they can open.',
    requires: ['view_invoices'],
    grants: [{ action: 'void_payment', subject: 'Invoice', scoped: 'Invoice' }],
    serverChecks: ['invoice-void-payment'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'edit_invoice_line_items',
    module: 'Invoices',
    label: 'Edit invoice line items',
    helpText: 'Add and remove an invoice\'s lines and scopes of work, on an invoice they can open.',
    requires: ['view_invoices'],
    grants: [{ action: 'manage_lines', subject: 'Invoice', scoped: 'Invoice' }],
    serverChecks: ['invoice-line-add', 'invoice-line-delete'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'allowed_payment_methods',
    module: 'Invoices',
    label: 'Allowed payment methods',
    helpText:
      'Which of the company\'s accepted payment methods they may record. "All accepted methods" follows the company\'s list as it ' +
      'changes; a ticked subset stays as ticked until someone changes it.',
    kind: 'list',
    listOptions: [...ALL_PAYMENT_METHODS],
    serverChecks: ['invoice-payment-method', 'estimate-deposit-method'],
    presets: presets(ALL_ACCEPTED_METHODS, ALL_ACCEPTED_METHODS, ALL_ACCEPTED_METHODS, ALL_ACCEPTED_METHODS),
  }),
  entry({
    key: 'edit_invoice_record_ids',
    module: 'Invoices',
    label: 'Edit record ID numbers (invoices)',
    helpText: 'Change an invoice\'s number.',
    requires: ['view_invoices'],
    grants: [{ action: 'renumber', subject: 'Invoice', scoped: 'Invoice' }],
    serverChecks: ['invoice-renumber'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'alert_every_invoice',
    module: 'Invoices',
    label: 'Alert me about every invoice and payment',
    helpText: 'Get a copy of every invoice and payment alert, on top of the normal recipients, for invoices they can open.',
    requires: ['view_invoices'],
    pending: 'Not a check of its own: the alert chain (alertChain.ts) reads it to add a copy of every alert of its area for its holders.',
    presets: presets(true, false, false, false),
  }),

  // ─── Service plans ───────────────────────────────────────────────────────────────────────────
  entry({
    key: 'view_service_plans',
    module: 'Service Plans',
    label: 'View service plans',
    helpText: 'Open service plans.',
    grants: [{ action: 'read', subject: 'ServicePlan' }],
    serverChecks: ['service-plan-read'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'create_service_plans',
    module: 'Service Plans',
    label: 'Create service plans',
    helpText:
      'Create plans, including a new customer from the plan builder\'s quick customer create (name, company, phone, email ' +
      'and the plan\'s service address), without Create customers.',
    requires: ['view_service_plans', 'edit_service_plans'],
    grants: [{ action: 'create', subject: 'ServicePlan' }],
    serverChecks: ['service-plan-create', 'service-plan-customer-create'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'edit_service_plans',
    module: 'Service Plans',
    label: 'Edit service plans',
    helpText: 'Edit, activate, renew and cancel plans.',
    requires: ['view_service_plans'],
    grants: [{ action: 'update', subject: 'ServicePlan' }],
    serverChecks: ['service-plan-update'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'delete_service_plans',
    module: 'Service Plans',
    label: 'Delete service plans',
    helpText: 'Delete draft plans.',
    requires: ['view_service_plans'],
    grants: [{ action: 'delete', subject: 'ServicePlan' }],
    serverChecks: ['service-plan-delete'],
    presets: presets(true, false, true, false),
  }),

  // ─── Automations ─────────────────────────────────────────────────────────────────────────────
  // Text automations in the Communication section follow these four, like every other automation.
  entry({
    key: 'view_automations',
    module: 'Automations',
    label: 'View automations',
    helpText: 'Open automations and their activity, including text automations in the Communication section.',
    grants: [{ action: 'read', subject: 'Automation' }],
    serverChecks: ['automation-list', 'text-automation-list'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'create_automations',
    module: 'Automations',
    label: 'Create automations',
    helpText: 'Create automations, including text automations in the Communication section. Contact customers alone does not allow it.',
    requires: ['view_automations', 'edit_automations'],
    grants: [{ action: 'create', subject: 'Automation' }],
    serverChecks: ['automation-create', 'text-automation-create'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'edit_automations',
    module: 'Automations',
    label: 'Edit automations',
    helpText: 'Edit, enable, disable and test automations, including text automations in the Communication section.',
    requires: ['view_automations'],
    grants: [{ action: 'update', subject: 'Automation' }],
    serverChecks: ['automation-update', 'text-automation-update'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'delete_automations',
    module: 'Automations',
    label: 'Delete automations',
    helpText: 'Delete automations, including text automations in the Communication section.',
    requires: ['view_automations'],
    grants: [{ action: 'delete', subject: 'Automation' }],
    serverChecks: ['automation-delete', 'text-automation-delete'],
    presets: presets(true, false, false, false),
  }),

  // ─── Tasks ───────────────────────────────────────────────────────────────────────────────────
  entry({
    key: 'view_tasks',
    module: 'Tasks',
    label: 'View tasks',
    helpText: 'See the tasks they are assignee or watcher on, and the tasks linked to a record they can open.',
    grants: [{ action: 'read', subject: 'Task' }],
    serverChecks: ['task-list', 'task-detail'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'create_tasks',
    module: 'Tasks',
    label: 'Create tasks',
    helpText: 'Create tasks.',
    requires: ['view_tasks', 'edit_tasks'],
    grants: [{ action: 'create', subject: 'Task' }],
    serverChecks: ['task-create'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'edit_tasks',
    module: 'Tasks',
    label: 'Edit tasks',
    helpText: 'Edit tasks: title, status, priority, due date, comments and subtasks.',
    requires: ['view_tasks'],
    grants: [{ action: 'update', subject: 'Task' }],
    serverChecks: ['task-update'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'delete_tasks',
    module: 'Tasks',
    label: 'Delete tasks',
    helpText: 'Delete tasks. A person who made a to-do for themselves alone can always delete it.',
    requires: ['view_tasks'],
    grants: [{ action: 'delete', subject: 'Task' }],
    serverChecks: ['task-delete'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'assign_tasks_to_others',
    module: 'Tasks',
    label: 'Assign tasks to others',
    helpText: 'Give a task to someone else.',
    requires: ['view_tasks'],
    grants: [{ action: 'assign', subject: 'Task' }],
    serverChecks: ['task-assign'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'tasks_scope',
    module: 'Tasks',
    label: 'Tasks scope',
    helpText:
      'Which tasks list and open: Attached (a task you are the assignee or a watcher of), Team (a task someone in your department ' +
      'is the assignee or a watcher of) or All. A task linked to a record you can open stays open to you on any choice. It also ' +
      'decides whose file names show on those tasks.',
    kind: 'choice',
    choices: SCOPE_CHOICES,
    pending: 'Not a check of its own: it sets which tasks every Tasks switch reaches (lib/permissions/moduleReach.ts).',
    presets: presets('all', 'attached', 'all', 'attached'),
  }),

  // ─── Events ──────────────────────────────────────────────────────────────────────────────────
  entry({
    key: 'view_events',
    module: 'Events',
    label: 'View events',
    helpText: 'See calendar entries (meetings, blocks) they take part in.',
    grants: [{ action: 'read', subject: 'CalendarEntry' }],
    serverChecks: ['calendar-entry-list', 'calendar-entry-detail', 'calendar-entry-search'],
    presets: presets(true, false, true, true),
  }),
  entry({
    key: 'create_events',
    module: 'Events',
    label: 'Create events',
    helpText: 'Create calendar entries.',
    requires: ['view_events', 'edit_events'],
    grants: [{ action: 'create', subject: 'CalendarEntry' }],
    serverChecks: ['calendar-entry-create'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'edit_events',
    module: 'Events',
    label: 'Edit events',
    helpText: 'Edit calendar entries.',
    requires: ['view_events'],
    grants: [{ action: 'update', subject: 'CalendarEntry' }],
    serverChecks: ['calendar-entry-update'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'delete_events',
    module: 'Events',
    label: 'Delete events',
    helpText: 'Delete calendar entries.',
    requires: ['view_events'],
    grants: [{ action: 'delete', subject: 'CalendarEntry' }],
    serverChecks: ['calendar-entry-delete'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'events_scope',
    module: 'Events',
    label: 'Events scope',
    helpText:
      'Which calendar entries list and open: Attached (an entry you take part in), Team (an entry someone in your department ' +
      'takes part in) or All.',
    kind: 'choice',
    choices: SCOPE_CHOICES,
    pending: 'Not a check of its own: it sets which calendar entries every Events switch reaches (lib/permissions/moduleReach.ts).',
    presets: presets('all', 'attached', 'all', 'attached'),
  }),

  // ─── Notes ───────────────────────────────────────────────────────────────────────────────────
  // Uploads and notes are the record's own data (P10, A8d): anyone who can open the record reads them, anyone with the
  // record's Edit adds, changes and removes them, another person's included. Add notes stays for a person who writes notes
  // without being able to edit the record.
  entry({
    key: 'add_notes',
    module: 'Notes',
    label: 'Add notes',
    helpText: 'Add notes to jobs and leads they can open. Editing the job or lead is not needed.',
    grants: [
      { action: 'add_note', subject: 'Job', scoped: 'Job' },
      { action: 'add_note', subject: 'Lead', scoped: 'Lead' },
    ],
    serverChecks: ['job-note-create', 'lead-note-create'],
    presets: presets(true, true, true, true),
  }),

  // ─── Users ───────────────────────────────────────────────────────────────────────────────────
  entry({
    key: 'view_users',
    module: 'Users',
    label: 'View users',
    helpText: 'See team members\' names in pickers and on records.',
    grants: [{ action: 'read', subject: 'User' }],
    serverChecks: ['user-list', 'user-detail'],
    presets: presets(true, false, true, true),
  }),
  // Create users, Invite users, Edit users, Delete users and Manage roles and permissions retired (AL-18, migration M13):
  // managing people and roles is the Admin flag's alone (requireAdmin on every such route), so no switch can grant it.
  entry({
    key: 'can_own_leads',
    module: 'Users',
    label: 'Can own leads / be Sold By',
    helpText:
      'Can be a lead\'s Owner or a job\'s Sold By. A creator with this on is pre-filled as the Owner (Sold By on jobs) on the ' +
      'create form; anyone with Assign people to leads or jobs can change that before saving.',
    pending: 'PRD 3 builds the Owner and Sold By slot checks and pickers.',
    presets: presets(true, true, false, true),
  }),
  entry({
    key: 'can_be_dispatcher',
    module: 'Users',
    label: 'Can be a dispatcher',
    helpText:
      'Can be a lead\'s or job\'s Dispatcher. A creator with this on and Can own leads / be Sold By off is pre-filled as the ' +
      'Dispatcher instead; with both off, or both on, they are pre-filled as the Owner (Sold By on jobs).',
    pending: 'PRD 3 builds the Dispatcher slot checks and pickers.',
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'can_be_on_crew',
    module: 'Users',
    label: 'Can be on a crew',
    helpText: 'Can be on a visit\'s crew or a walkthrough.',
    pending: 'PRD 3 builds the crew and walkthrough slot checks and pickers.',
    presets: presets(true, true, false, true),
  }),

  // ─── Departments ─────────────────────────────────────────────────────────────────────────────
  entry({
    key: 'view_departments',
    module: 'Departments',
    label: 'View departments',
    helpText: 'See departments.',
    grants: [{ action: 'read', subject: 'Department' }],
    serverChecks: ['department-list'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'create_departments',
    module: 'Departments',
    label: 'Create departments',
    helpText: 'Create departments.',
    requires: ['view_departments', 'edit_departments'],
    grants: [{ action: 'create', subject: 'Department' }],
    serverChecks: ['department-create'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'edit_departments',
    module: 'Departments',
    label: 'Edit departments',
    helpText: 'Rename departments.',
    requires: ['view_departments'],
    grants: [{ action: 'update', subject: 'Department' }],
    serverChecks: ['department-update'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'delete_departments',
    module: 'Departments',
    label: 'Delete departments',
    helpText: 'Delete departments.',
    requires: ['view_departments'],
    grants: [{ action: 'delete', subject: 'Department' }],
    serverChecks: ['department-delete'],
    presets: presets(true, false, false, false),
  }),

  // ─── Locations ───────────────────────────────────────────────────────────────────────────────
  entry({
    key: 'view_locations',
    module: 'Locations',
    label: 'View locations',
    helpText: 'See business locations.',
    grants: [{ action: 'read', subject: 'Location' }],
    serverChecks: ['location-list'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'create_locations',
    module: 'Locations',
    label: 'Create locations',
    helpText: 'Create business locations.',
    requires: ['view_locations', 'edit_locations'],
    grants: [{ action: 'create', subject: 'Location' }],
    serverChecks: ['location-create'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'edit_locations',
    module: 'Locations',
    label: 'Edit locations',
    helpText: 'Edit, archive and restore business locations.',
    requires: ['view_locations'],
    grants: [{ action: 'update', subject: 'Location' }],
    serverChecks: ['location-update'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'delete_locations',
    module: 'Locations',
    label: 'Delete locations',
    helpText: 'Delete business locations.',
    requires: ['view_locations'],
    grants: [{ action: 'delete', subject: 'Location' }],
    serverChecks: ['location-delete'],
    presets: presets(true, false, false, false),
  }),

  // ─── Settings ─────────────────────────────────────────────────────────────────────────────────
  // Company settings retired (ticket 36b, migration M17): setting up the company (its details, branding, tax rates, job statuses,
  // lists, custom fields, payment defaults, sender address, main-mailbox readers, phone service and numbers) is the Admin flag's
  // alone (requireAdminTo on every such route), so no switch can grant it, and no switch emits `update` on the company or on app
  // settings. Reading the company stays open to everyone.
  entry({
    key: 'create_tags',
    module: 'Settings',
    label: 'Create tags',
    helpText: 'Create new tag names.',
    grants: [{ action: 'create', subject: 'Tag' }],
    serverChecks: ['tag-create'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'manage_tags',
    module: 'Settings',
    label: 'Manage tags',
    helpText: 'Rename and delete tags for the whole company.',
    grants: [
      { action: 'update', subject: 'Tag' },
      { action: 'delete', subject: 'Tag' },
    ],
    serverChecks: ['tag-update', 'tag-delete'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'manage_task_categories',
    module: 'Settings',
    label: 'Manage task categories',
    helpText: 'Create, rename and delete task categories.',
    grants: [
      { action: 'create', subject: 'TaskCategory' },
      { action: 'update', subject: 'TaskCategory' },
      { action: 'delete', subject: 'TaskCategory' },
    ],
    serverChecks: ['task-category-create', 'task-category-update', 'task-category-delete'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'manage_payout_account',
    module: 'Settings',
    label: 'Manage payout account',
    helpText:
      'Accept the payments terms, set up and verify the account that receives payouts, and manage its bank and identity details. ' +
      'This is the company owner\'s switch.',
    grants: [{ action: 'manage_payout_account', subject: 'Organization' }],
    serverChecks: ['payout-account-session', 'payout-terms-accept', 'payout-account-link', 'payout-account-connect', 'payments-page-attention-resolve-payout'],
    presets: presets(true, false, false, false),
  }),

  // ─── Pages ────────────────────────────────────────────────────────────────────────────────────
  // The dashboard has no switch: every signed-in person has one as their home page, so its endpoint answers everyone.
  entry({
    key: 'access_schedule',
    module: 'Pages',
    label: 'Access Schedule',
    helpText:
      'Open the schedule. The jobs and walkthroughs on it still follow View jobs and View leads, and its calendar entries follow View events: ' +
      'those lists also serve the Jobs, Leads and customer pages.',
    grants: [{ action: 'access', subject: 'Schedule' }],
    serverChecks: ['schedule-service-plan-feed'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'access_reports',
    module: 'Pages',
    label: 'Access Reports',
    helpText: 'Open reports, the Call Tracking report included.',
    grants: [{ action: 'read', subject: 'Report' }],
    // The shared unpaid-invoices endpoint (ar-aging) is named here and on Access Billing: either switch opens it.
    // Every other report endpoint opens on this switch alone.
    serverChecks: [
      'report-unpaid-invoices',
      'report-estimate-conversion',
      'report-estimate-conversion-drilldown',
      'report-jobs',
      'report-leads',
      'report-estimates',
      'report-revenue',
      'report-payments',
      'report-payment-fees',
      'report-invoices',
      'report-activity',
      'report-inventory-usage',
    ],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'export_reports',
    module: 'Pages',
    label: 'Export reports',
    helpText: 'Download report data.',
    requires: ['access_reports'],
    grants: [{ action: 'export', subject: 'Report' }],
    pending: 'The report download buttons show only with it; no server report export exists, and one added later checks this switch.',
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'access_billing',
    module: 'Pages',
    label: 'Access Billing',
    helpText:
      'Open Billing (unpaid invoices). When a payment comes in on a record with no Dispatcher, holders are alerted to deal with it.',
    grants: [{ action: 'access', subject: 'Billing' }],
    // Billing is the unpaid-invoices report: this switch opens that one endpoint (Access Reports opens it too).
    serverChecks: ['report-unpaid-invoices'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'access_marketing',
    module: 'Pages',
    label: 'Access Marketing',
    helpText: 'Open Marketing.',
    pending: 'Display only: Marketing has no server data to check.',
    presets: presets(true, false, false, false),
  }),

  // ─── Time tracking ───────────────────────────────────────────────────────────────────────────
  entry({
    key: 'timesheets_scope',
    module: 'Time tracking',
    label: 'Timesheets scope',
    helpText:
      'Whose timesheets and time entries show, including where each clock-in and clock-out happened: Attached (their own), Team ' +
      '(people in their department) or All.',
    kind: 'choice',
    choices: SCOPE_CHOICES,
    pending: 'Not a check of its own: it sets whose timesheets the organisation views reach (lib/permissions/moduleReach.ts).',
    presets: presets('all', 'attached', 'all', 'attached'),
  }),

  // ─── Inventory: Stock ────────────────────────────────────────────────────────────────────────
  entry({
    key: 'view_stock',
    module: 'Stock',
    label: 'View stock',
    helpText:
      'See quantities, locations, categories and types, and the staging of jobs they can open plus stages assigned to them. ' +
      'A job\'s own staging on its job page shows to everyone attached to that job, whatever their switches.',
    grants: [{ action: 'read', subject: 'Inventory' }],
    serverChecks: ['stock-locations'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'create_stock',
    module: 'Stock',
    label: 'Create stock',
    helpText: 'Add stock records.',
    requires: ['view_stock', 'edit_stock'],
    grants: [{ action: 'create', subject: 'Inventory' }],
    serverChecks: ['stock-location-create'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'edit_stock',
    module: 'Stock',
    label: 'Edit stock',
    helpText: 'Change stock records.',
    requires: ['view_stock'],
    grants: [{ action: 'update', subject: 'Inventory' }],
    serverChecks: ['stock-set-quantity'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'delete_stock',
    module: 'Stock',
    label: 'Delete stock',
    helpText: 'Delete stock records.',
    requires: ['view_stock'],
    grants: [{ action: 'delete', subject: 'Inventory' }],
    serverChecks: ['stock-location-delete'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'export_stock',
    module: 'Stock',
    label: 'Export stock',
    helpText: 'Download stock lists.',
    requires: ['view_stock'],
    grants: [{ action: 'export', subject: 'Inventory' }],
    pending: 'The Stock export buttons show only with it; the stock file is built in the browser, so no server check exists.',
    presets: presets(true, true, false, false),
  }),
  entry({
    key: 'see_inventory_activity',
    module: 'Stock',
    label: 'See inventory activity',
    helpText: 'Open the inventory Activity tab and an item\'s movement history.',
    requires: ['view_stock'],
    grants: [{ action: 'see_inventory_activity', subject: 'Inventory' }],
    serverChecks: ['stock-movement-list', 'stock-movement-detail'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'assets_scope',
    module: 'Stock',
    label: 'Assets scope',
    helpText:
      'Which assets list and open: Attached (an asset held by you), Team (an asset held by someone in your department) or All.',
    kind: 'choice',
    choices: SCOPE_CHOICES,
    pending: 'Not a check of its own: it sets which assets the asset routes reach (lib/permissions/moduleReach.ts).',
    presets: presets('all', 'all', 'all', 'attached'),
  }),
  entry({
    key: 'inventory_view',
    module: 'Stock',
    label: 'Inventory view',
    helpText:
      'Which inventory view opens for them: Counter (the full stock screens) or Field (the view for people out on jobs, ' +
      'built around their own van). It is a setting of the person, not a stock read.',
    kind: 'choice',
    choices: ['counter', 'field'],
    serverChecks: ['inventory-view'],
    presets: presets('counter', 'counter', 'counter', 'field'),
  }),
  entry({
    key: 'restrict_stock_to_own_van',
    module: 'Stock',
    label: 'Restrict stock to own van',
    helpText:
      'Their stock deductions must come from their own van; a deduction from any other location is refused. ' +
      'It is a setting of the person, not a stock read.',
    serverChecks: ['stock-van-limit'],
    presets: presets(false, false, false, false),
  }),
  entry({
    key: 'pick_up_staged_items',
    module: 'Stock',
    label: 'Pick up staged items',
    helpText:
      'Mark a stage, or a Processed logistic order, they can see as taken by them; the person and the time are saved. ' +
      'Does not need Edit stock.',
    grants: [{ action: 'pick_up_staged', subject: 'Inventory' }],
    serverChecks: ['stage-pickup', 'order-pickup'],
    presets: presets(true, false, true, true),
  }),
  entry({
    key: 'record_pickup_for_someone_else',
    module: 'Stock',
    label: 'Record pickup for someone else',
    helpText:
      'Record that another person took a stage or a Processed logistic order they can see, picking that person ' +
      '("Taken by Tom, recorded by Lee"). Does not need Edit stock.',
    grants: [{ action: 'record_pickup_for_other', subject: 'Inventory' }],
    serverChecks: ['stage-pickup-for-other', 'stage-pickup-people', 'order-pickup-for-other', 'order-pickup-people'],
    presets: presets(true, false, true, false),
  }),

  // ─── Inventory: Purchase orders ──────────────────────────────────────────────────────────────
  // Reach: orders on jobs the person can open; an order with no job needs Jobs scope All.
  entry({
    key: 'view_purchase_orders',
    module: 'Purchase Orders',
    label: 'View purchase orders',
    helpText:
      'Open purchase orders, quotes and the reservation queue, for orders on jobs they can open. An order with no job needs ' +
      'Jobs scope All.',
    grants: [{ action: 'read', subject: 'PurchaseOrder', scoped: 'PurchaseOrder' }],
    serverChecks: ['purchase-order-list', 'purchase-order-detail'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'create_purchase_orders',
    module: 'Purchase Orders',
    label: 'Create purchase orders',
    helpText: 'Create purchase orders and reservations, on a job they can open (an order with no job needs Jobs scope All).',
    requires: ['view_purchase_orders', 'edit_purchase_orders'],
    grants: [{ action: 'create', subject: 'PurchaseOrder', scoped: 'PurchaseOrder' }],
    serverChecks: ['purchase-order-create'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'edit_purchase_orders',
    module: 'Purchase Orders',
    label: 'Edit purchase orders',
    helpText: 'Edit and receive purchase orders they can open.',
    requires: ['view_purchase_orders'],
    grants: [{ action: 'update', subject: 'PurchaseOrder', scoped: 'PurchaseOrder' }],
    serverChecks: ['purchase-order-update'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'delete_purchase_orders',
    module: 'Purchase Orders',
    label: 'Delete purchase orders',
    helpText: 'Delete purchase orders they can open.',
    requires: ['view_purchase_orders'],
    grants: [{ action: 'delete', subject: 'PurchaseOrder', scoped: 'PurchaseOrder' }],
    serverChecks: ['purchase-order-delete'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'export_purchase_orders',
    module: 'Purchase Orders',
    label: 'Export purchase orders',
    helpText: 'Download purchase order lists.',
    requires: ['view_purchase_orders'],
    grants: [{ action: 'export', subject: 'PurchaseOrder' }],
    pending: 'The Purchase Orders export buttons show only with it; the file is built in the browser, so no server check exists.',
    presets: presets(true, true, false, false),
  }),

  // ─── Inventory: Vendors ──────────────────────────────────────────────────────────────────────
  entry({
    key: 'view_vendors',
    module: 'Vendors',
    label: 'View vendors',
    helpText: 'See vendor names and contacts.',
    grants: [{ action: 'read', subject: 'Vendor' }],
    serverChecks: ['vendor-list'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'create_vendors',
    module: 'Vendors',
    label: 'Create vendors',
    helpText: 'Create vendors.',
    requires: ['view_vendors', 'edit_vendors'],
    grants: [{ action: 'create', subject: 'Vendor' }],
    serverChecks: ['vendor-create'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'edit_vendors',
    module: 'Vendors',
    label: 'Edit vendors',
    helpText: 'Edit vendors.',
    requires: ['view_vendors'],
    grants: [{ action: 'update', subject: 'Vendor' }],
    serverChecks: ['vendor-update', 'vendor-category-rename'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'delete_vendors',
    module: 'Vendors',
    label: 'Delete vendors',
    helpText: 'Delete vendors.',
    requires: ['view_vendors'],
    grants: [{ action: 'delete', subject: 'Vendor' }],
    serverChecks: ['vendor-delete'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'export_vendors',
    module: 'Vendors',
    label: 'Export vendors',
    helpText: 'Download vendor lists.',
    requires: ['view_vendors'],
    grants: [{ action: 'export', subject: 'Vendor' }],
    pending: 'The Vendors export buttons show only with it; the file is built in the browser, so no server check exists.',
    presets: presets(true, true, false, false),
  }),

  // ─── Inventory: Logistic orders ──────────────────────────────────────────────────────────────
  // Reach: orders on jobs and leads the person can open; an order on neither needs Jobs scope All.
  entry({
    key: 'view_logistic_orders',
    module: 'Logistic Orders',
    label: 'View logistic orders',
    helpText:
      'Open logistic orders on jobs and leads they can open. An order on neither a job nor a lead needs Jobs scope All.',
    grants: [{ action: 'read', subject: 'LogisticOrder', scoped: 'LogisticOrder' }],
    serverChecks: ['logistic-order-list'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'create_logistic_orders',
    module: 'Logistic Orders',
    label: 'Create logistic orders',
    helpText:
      'Create logistic orders on a job they can open, and submit them for approval (submitting is part of creating). ' +
      'Without Approve logistic orders, a submitted order waits for an approver.',
    requires: ['view_logistic_orders', 'edit_logistic_orders'],
    grants: [
      { action: 'create', subject: 'LogisticOrder', scoped: 'LogisticOrderOnJob' },
      { action: 'submit', subject: 'LogisticOrder', scoped: 'LogisticOrder' },
    ],
    serverChecks: ['logistic-order-create', 'logistic-order-submit'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'edit_logistic_orders',
    module: 'Logistic Orders',
    label: 'Edit logistic orders',
    helpText: 'Edit draft logistic orders they can open.',
    requires: ['view_logistic_orders'],
    grants: [{ action: 'update', subject: 'LogisticOrder', scoped: 'LogisticOrder' }],
    serverChecks: ['logistic-order-update'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'delete_logistic_orders',
    module: 'Logistic Orders',
    label: 'Delete logistic orders',
    helpText: 'Delete draft logistic orders they can open.',
    requires: ['view_logistic_orders'],
    grants: [{ action: 'delete', subject: 'LogisticOrder', scoped: 'LogisticOrder' }],
    serverChecks: ['logistic-order-delete'],
    presets: presets(true, true, false, false),
  }),
  entry({
    key: 'approve_logistic_orders',
    module: 'Logistic Orders',
    label: 'Approve logistic orders',
    helpText:
      'Approve submitted logistic orders on any order they can reach, whatever their role. A person who can create orders but ' +
      'not approve them submits and waits for an approver; with both they take their own order through. Holders who can reach ' +
      'an order are alerted when it is submitted.',
    requires: ['view_logistic_orders'],
    grants: [{ action: 'approve', subject: 'LogisticOrder', scoped: 'LogisticOrder' }],
    serverChecks: ['logistic-order-approve', 'logistic-order-submitted-alert'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'process_logistic_orders',
    module: 'Logistic Orders',
    label: 'Process logistic orders',
    helpText:
      'Process an approved order, which takes the stock. With Approve logistic orders as well, carry a draft or submitted ' +
      'order straight to processed.',
    requires: ['view_logistic_orders'],
    grants: [{ action: 'process', subject: 'LogisticOrder', scoped: 'LogisticOrder' }],
    serverChecks: ['logistic-order-process'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'cancel_logistic_orders',
    module: 'Logistic Orders',
    label: 'Cancel logistic orders',
    helpText: 'Cancel a logistic order they can open.',
    requires: ['view_logistic_orders'],
    grants: [{ action: 'cancel', subject: 'LogisticOrder', scoped: 'LogisticOrder' }],
    serverChecks: ['logistic-order-cancel'],
    presets: presets(true, false, true, false),
  }),

  // ─── Inventory: Price book ───────────────────────────────────────────────────────────────────
  entry({
    key: 'view_price_book',
    module: 'Price Book',
    label: 'View price book',
    helpText: 'See items, categories and prices. Cost needs See costs.',
    grants: [{ action: 'read', subject: 'PriceBook' }],
    serverChecks: ['price-book-list'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'create_price_book_items',
    module: 'Price Book',
    label: 'Create price book items',
    helpText: 'Add items and categories.',
    requires: ['view_price_book', 'edit_price_book_items'],
    grants: [{ action: 'create', subject: 'PriceBook' }],
    serverChecks: ['price-book-create'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'edit_price_book_items',
    module: 'Price Book',
    label: 'Edit price book items',
    helpText: 'Edit items and categories.',
    requires: ['view_price_book'],
    grants: [{ action: 'update', subject: 'PriceBook' }],
    serverChecks: ['price-book-update'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'delete_price_book_items',
    module: 'Price Book',
    label: 'Delete price book items',
    helpText: 'Delete items and categories.',
    requires: ['view_price_book'],
    grants: [{ action: 'delete', subject: 'PriceBook' }],
    serverChecks: ['price-book-delete'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'export_price_book',
    module: 'Price Book',
    label: 'Export price book',
    helpText: 'Download the price book.',
    requires: ['view_price_book'],
    grants: [{ action: 'export', subject: 'PriceBook' }],
    pending: 'The Price Book export button shows only with it; the price book file is built in the browser, so no server check exists.',
    presets: presets(true, true, false, false),
  }),

  // ─── Communication ───────────────────────────────────────────────────────────────────────────
  // The row's View is View communication (the record tab). Access Communication is the section's own switch,
  // outside the row rule: Show Phone, Show Text, Show Email, the seven phone tab switches and Export call log need
  // Access Communication only, never View communication.
  entry({
    key: 'view_communication',
    module: 'Communication',
    label: 'View communication',
    helpText:
      'The Communication tab on records they can open. On a job or lead they can open, the tab shows all of that ' +
      'record\'s communication, whatever number or mailbox it came through.',
    grants: [{ action: 'read', subject: 'Communication' }],
    // The tabs on a job, lead and customer, and every read in the Communication section (calls, texts, email, templates,
    // the phone customer directory), which each ask for it on top of Access Communication.
    serverChecks: ['job-communications', 'lead-communications', 'customer-communications', 'communication-reads'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'contact_customers',
    module: 'Communication',
    label: 'Contact customers',
    helpText: 'Call, text and email customers. Creating text automations is not part of it: that is Create automations.',
    requires: ['view_communication'],
    grants: [{ action: 'create', subject: 'Communication' }],
    // Sending a text is the first; the rest is placing a call, starting a text or WhatsApp conversation, sending an email
    // and adding a call flow, a call group or a blocked caller, which all ask for it.
    serverChecks: ['text-send', 'contact-compose'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'attach_conversations',
    module: 'Communication',
    label: 'Attach conversations to jobs and leads',
    helpText:
      'Attach a call, text or email they can read to a job or lead they can open, or move it to another. ' +
      'Edit communication records does not allow it.',
    requires: ['view_communication'],
    grants: [{ action: 'attach', subject: 'Communication' }],
    serverChecks: ['call-attach-job', 'call-attach-lead', 'email-attach-job', 'email-attach-lead', 'text-attach-job', 'text-attach-lead'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'edit_communication_records',
    module: 'Communication',
    label: 'Edit communication records',
    helpText:
      'Assign, archive and snooze an email conversation; file an unmatched inbound email into a conversation; create, ' +
      'change and delete message templates; and, with the matching phone tab switch, edit call flows, call groups and a ' +
      'number\'s call flow or where its calls ring. Attaching a conversation to a job or lead is its own switch, and text ' +
      'automations follow the Automations switches.',
    requires: ['view_communication'],
    grants: [{ action: 'update', subject: 'Communication' }],
    serverChecks: [
      'email-thread-assign', 'email-thread-archive', 'email-thread-snooze', 'email-link-inbound',
      'message-template-create', 'message-template-update', 'message-template-delete', 'call-flow-update', 'call-group-update',
    ],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'delete_communication_records',
    module: 'Communication',
    label: 'Delete communication records',
    helpText: 'Delete communication records such as call flows.',
    requires: ['view_communication'],
    grants: [{ action: 'delete', subject: 'Communication' }],
    serverChecks: ['call-flow-delete', 'call-group-delete'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'access_communication',
    module: 'Communication',
    label: 'Access Communication',
    helpText: 'Open the Communication section. What a person sees inside follows Communication scope.',
    grants: [{ action: 'access_inbox', subject: 'Communication' }],
    serverChecks: ['communication-section'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'show_phone',
    module: 'Communication',
    label: 'Show Phone',
    helpText: 'The Phone sub-page of the Communication section.',
    requires: ['access_communication'],
    pending: 'Display only: the sub-page, its menu entry and its address follow it; the server never checks it.',
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'show_text',
    module: 'Communication',
    label: 'Show Text',
    helpText: 'The Text sub-page of the Communication section, scoped to their own numbers and customers.',
    requires: ['access_communication'],
    pending: 'Display only: the sub-page, its menu entry and its address follow it; the server never checks it.',
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'show_email',
    module: 'Communication',
    label: 'Show Email',
    helpText:
      'The Email sub-page of the Communication section, scoped to their own mailbox. Off closes their mailbox on the server too: ' +
      'they cannot list, read, reply to, write from the Email page, assign or file its email, and the Email count leaves their badge. ' +
      'Writing to a customer from a job, lead or customer page stays with Contact customers.',
    requires: ['access_communication'],
    grants: [{ action: 'show_email', subject: 'Communication' }],
    // The Email page's routes ask for it beside the section (the list, a message, assigning and filing a conversation, the
    // attachments, the mailbox list and the person's own address); the send route asks for it for a reply or a send that names
    // no record; the unread badge leaves the email count out.
    serverChecks: ['email-mailbox', 'email-page-send', 'email-unread-count'],
    presets: presets(true, true, true, true),
  }),
  entry({
    key: 'communication_scope',
    module: 'Communication',
    label: 'Communication scope',
    helpText:
      'Attached (the numbers linked to them, their own mailbox, and mailboxes handed over to them), Team (the same for everyone ' +
      'in their department) or All (every number and mailbox): one choice for calls, texts and mailboxes. Missed-call, text and ' +
      'email alerts follow it.',
    kind: 'choice',
    choices: SCOPE_CHOICES,
    pending: 'Not a check of its own: it narrows the rows the section\'s lists and single reads answer with and the communication alerts, so no route refuses by it.',
    presets: presets('all', 'attached', 'attached', 'attached'),
  }),
  entry({
    key: 'see_main_line_when_no_number',
    module: 'Communication',
    label: 'See the main line when I have no number',
    helpText:
      'On Attached with no number linked to them: see and work the company\'s main line in the Communication section. ' +
      'Off: they still see the calls they placed or answered and the texts they sent, and the replies to them.',
    pending: 'Not a check of its own: it widens the rows the section lists and the communication alerts answer with for a person with no linked number, so no route refuses by it.',
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'play_recording',
    module: 'Communication',
    label: 'Play recording',
    helpText: 'Play call recordings.',
    requires: ['view_communication'],
    grants: [{ action: 'play_recording', subject: 'Communication' }],
    serverChecks: ['recording-play'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'view_transcript',
    module: 'Communication',
    label: 'View transcript',
    helpText: 'Read transcripts and the call summary.',
    requires: ['view_communication'],
    grants: [{ action: 'view_transcript', subject: 'Communication' }],
    serverChecks: ['transcript-view'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'download_recording',
    module: 'Communication',
    label: 'Download recording',
    helpText:
      'Shows the download button for call recordings. Off hides the download button only; recordings can still be played, ' +
      'and playback can be captured.',
    requires: ['view_communication'],
    grants: [{ action: 'download_recording', subject: 'Communication' }],
    serverChecks: ['recording-download'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'download_transcript',
    module: 'Communication',
    label: 'Download transcript',
    helpText: 'Download transcripts. No transcript download exists yet, so this switch has no effect until one is built.',
    requires: ['view_communication'],
    pending: 'PRD 8; no transcript download exists yet.',
    presets: presets(true, true, false, false),
  }),
  entry({
    key: 'see_call_insights',
    module: 'Communication',
    label: 'See call insights',
    helpText: 'Call insights and the Performance & QA page. Call revenue and agent revenue on them also need See company figures.',
    requires: ['view_communication'],
    grants: [{ action: 'see_call_insights', subject: 'Communication' }],
    // Neither is a refusal: the call responses lose the sentiment and the review flag, and the phone agents list keeps
    // each agent's identity (it also names who answered a call) and loses only the scorecard metrics.
    serverChecks: ['call-insights', 'phone-agent-metrics'],
    presets: presets(true, true, true, false),
  }),
  entry({
    key: 'export_call_log',
    module: 'Communication',
    label: 'Export call log',
    helpText: 'Download the call log.',
    requires: ['access_communication'],
    grants: [{ action: 'export', subject: 'Communication' }],
    pending: 'The call log\'s Export button shows only with it; the call file is built in the browser from the rows the call answers carry, so no server check exists.',
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'log_past_communications',
    module: 'Communication',
    label: 'Log past communications',
    helpText: 'Log past calls, texts and emails by hand, and edit or delete their own entries.',
    requires: ['view_communication'],
    grants: [{ action: 'log_past', subject: 'Communication' }],
    serverChecks: ['manual-log-create'],
    presets: presets(true, false, true, true),
  }),
  entry({
    key: 'edit_others_logged_communications',
    module: 'Communication',
    label: 'Edit other people\'s logged communications',
    helpText: 'Edit or delete a hand-logged entry someone else wrote.',
    requires: ['log_past_communications'],
    grants: [{ action: 'edit_others_log', subject: 'Communication' }],
    serverChecks: ['manual-log-edit-others'],
    presets: presets(true, false, false, false),
  }),
  entry({
    key: 'phone_numbers_tab',
    module: 'Communication',
    label: 'Phone numbers tab',
    helpText: 'The Phone numbers tab.',
    requires: ['access_communication'],
    // A routing change is refused without it; the numbers list answers either way and leaves the routing and call-flow
    // fields out (not a refusal, so it has no probe row of its own). The usage read follows the same tab: the bar sits on
    // that tab and a display-only switch of its own is retired (P1).
    grants: [{ action: 'phone_numbers_tab', subject: 'Communication' }],
    serverChecks: ['phone-numbers-routing', 'phone-numbers-fields', 'phone-usage'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'call_flows_tab',
    module: 'Communication',
    label: 'Call flows tab',
    helpText: 'The Call flows tab.',
    requires: ['access_communication'],
    // Reading, creating, changing and deleting a flow all need the tab, on top of Contact customers (create), Edit
    // communication records (change) and Delete communication records (delete); the pilot-or-demo org gate sits after it.
    grants: [{ action: 'call_flows_tab', subject: 'Communication' }],
    serverChecks: ['call-flows-read', 'call-flows-write'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'call_masking_tab',
    module: 'Communication',
    label: 'Call masking tab',
    helpText: 'The Call masking tab.',
    requires: ['access_communication'],
    grants: [{ action: 'call_masking_tab', subject: 'Communication' }],
    pending: 'Display only: a demo-only prototype with no server data, so nothing to check.',
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'call_groups_tab',
    module: 'Communication',
    label: 'Call groups tab',
    helpText: 'The Call groups tab.',
    requires: ['access_communication'],
    // The same for call groups.
    grants: [{ action: 'call_groups_tab', subject: 'Communication' }],
    serverChecks: ['call-groups-read', 'call-groups-write'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'training_tab',
    module: 'Communication',
    label: 'Training tab',
    helpText: 'The Training tab.',
    requires: ['access_communication'],
    // The scenarios and the sessions; a session's transcript turns also need View transcript.
    grants: [{ action: 'training_tab', subject: 'Communication' }],
    serverChecks: ['training-scenarios', 'training-sessions'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'blocked_callers_tab',
    module: 'Communication',
    label: 'Blocked callers tab',
    helpText: 'The Blocked callers tab.',
    requires: ['access_communication'],
    // The blocked list, blocking (also Contact customers) and unblocking (also Delete communication records).
    grants: [{ action: 'blocked_callers_tab', subject: 'Communication' }],
    serverChecks: ['blocked-read', 'blocked-add', 'blocked-remove'],
    presets: presets(true, false, true, false),
  }),
  entry({
    key: 'office_phone_in_browser',
    module: 'Communication',
    label: 'Office phone in the browser',
    helpText: 'Make and take office calls in the browser.',
    requires: ['contact_customers'],
    grants: [{ action: 'use_browser_phone', subject: 'Communication' }],
    serverChecks: ['phone-token'],
    presets: presets(true, true, true, false),
  }),
];

export function findSwitch(key: string): SwitchEntry | undefined {
  return SWITCH_CATALOG.find((s) => s.key === key);
}

export function isBuiltInRole(key: string): key is BuiltInRole {
  return (BUILT_IN_ROLES as readonly string[]).includes(key);
}

/** The full set of switch values a built-in role starts with: the catalog's preset column for that role. */
export function presetSwitchSet(role: BuiltInRole): Record<string, SwitchValue> {
  return Object.fromEntries(SWITCH_CATALOG.map((s) => [s.key, s.presets[role]]));
}

/** Every value a stored choice may hold: the options plus any kept value. */
export function storableChoices(entry: SwitchEntry): string[] {
  return [...(entry.choices ?? []), ...(entry.keptValues ?? [])];
}
