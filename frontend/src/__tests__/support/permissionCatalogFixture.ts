import type { BuiltInRoleKey, CatalogLayout, CatalogSwitch, SwitchCatalog } from '@/lib/api/permissionSwitches';
import type { SwitchSet, SwitchValue } from '@/lib/api/shared/switchTypes';

/**
 * A catalog in the shape the server's catalog read answers, small enough to read and wide enough to hold every kind
 * of place a switch can sit: the Money row, a full first line, a switch nested under a line and under
 * another extra, a scope choice on its row, a plain choice, a list, a module with no View (Settings, Pages), a
 * group heading over two modules (Inventory), and the two switches registered on the company record.
 *
 * Tests read their expectations from this object (labels, help text, order, presets), never from a second list.
 */

const presets = (admin: SwitchValue, sales: SwitchValue, dispatcher: SwitchValue, technician: SwitchValue): Record<BuiltInRoleKey, SwitchValue> => ({
  ADMIN: admin, SALES: sales, DISPATCHER: dispatcher, TECHNICIAN: technician,
});

function toggle(key: string, module: string, label: string, p: Record<BuiltInRoleKey, SwitchValue>, requires: string[] = []): CatalogSwitch {
  return { key, module, label, helpText: `Help for ${label}.`, kind: 'toggle', requires, presets: p };
}

const ON = presets(true, true, true, true);
const ADMIN_ONLY = presets(true, false, false, false);

const SCOPE = ['attached', 'team', 'all'];

export const FIXTURE_SWITCHES: CatalogSwitch[] = [
  { key: 'leads_scope', module: 'Data Scope', label: 'Leads scope', helpText: 'Help for Leads scope.', kind: 'choice', choices: SCOPE, requires: [], presets: presets('all', 'attached', 'all', 'attached') },
  {
    key: 'jobs_scope', module: 'Data Scope', label: 'Jobs scope', helpText: 'Help for Jobs scope.', kind: 'choice', choices: SCOPE, requires: [],
    keptValueHelp: { through_own_leads: { label: 'Through own leads', meaning: 'Jobs that come from a lead you are the Owner of.' } },
    presets: presets('all', 'through_own_leads', 'all', 'attached'),
  },
  toggle('see_prices', 'Money', 'See prices', ON),
  toggle('see_costs', 'Money', 'See costs', presets(true, true, false, false), ['see_prices']),
  toggle('see_company_figures', 'Money', 'See company figures', presets(true, false, false, false), ['see_prices']),

  toggle('view_customers', 'Customers', 'View customers', ON),
  toggle('create_customers', 'Customers', 'Create customers', presets(true, true, false, false), ['view_customers']),
  toggle('edit_customers', 'Customers', 'Edit customers', ON, ['view_customers']),
  toggle('delete_customers', 'Customers', 'Delete customers', ADMIN_ONLY, ['view_customers']),
  toggle('export_customers', 'Customers', 'Export customers', ADMIN_ONLY, ['view_customers']),
  toggle('change_customer_created_date', 'Customers', 'Change customer created date', ADMIN_ONLY, ['edit_customers']),

  toggle('view_estimates', 'Estimates', 'View estimates', ON),
  toggle('create_estimates', 'Estimates', 'Create estimates', ON, ['view_estimates', 'see_prices']),

  toggle('view_leads', 'Leads', 'View leads', ON),
  toggle('create_leads', 'Leads', 'Create leads', ON, ['view_leads']),
  toggle('edit_leads', 'Leads', 'Edit leads', ON, ['view_leads']),
  toggle('change_lead_status_by_hand', 'Leads', 'Change lead status by hand', ADMIN_ONLY, ['edit_leads']),
  toggle('assign_people_to_leads', 'Leads', 'Assign people to leads', presets(true, false, true, false), ['view_leads']),
  toggle('reopen_leads', 'Leads', 'Reopen leads', presets(true, true, true, false), ['view_leads']),

  toggle('view_jobs', 'Jobs', 'View jobs', ON),
  toggle('create_jobs', 'Jobs', 'Create jobs', ON, ['view_jobs']),
  { ...toggle('edit_job_and_lead_contact_details', 'Jobs', 'Edit job and lead contact details', presets(true, true, true, false)), requiresAny: ['view_jobs', 'view_leads'] },
  toggle('assign_people_to_jobs', 'Jobs', 'Assign people to jobs', presets(true, false, true, false), ['view_jobs']),

  toggle('view_invoices', 'Invoices', 'View invoices', ON),
  toggle('record_payments', 'Invoices', 'Record payments', presets(true, true, true, false), ['see_prices']),
  toggle('view_payments', 'Invoices', 'View payments and payouts', ADMIN_ONLY),
  {
    key: 'allowed_payment_methods', module: 'Invoices', label: 'Allowed payment methods', helpText: 'Help for Allowed payment methods.',
    kind: 'list', listOptions: ['CARD', 'CASH', 'CHECK'], requires: [], presets: presets('all_accepted', 'all_accepted', 'all_accepted', 'all_accepted'),
  },

  toggle('view_stock', 'Stock', 'View stock', ON),
  toggle('edit_stock', 'Stock', 'Edit stock', presets(true, false, true, false), ['view_stock']),
  toggle('pick_up_staged_items', 'Stock', 'Pick up staged items', presets(true, false, true, true)),
  toggle('record_pickup_for_someone_else', 'Stock', 'Record pickup for someone else', presets(true, false, true, false)),
  { key: 'inventory_view', module: 'Stock', label: 'Inventory view', helpText: 'Help for Inventory view.', kind: 'choice', choices: ['counter', 'field'], requires: [], setting: true, presets: presets('counter', 'counter', 'counter', 'field') },
  toggle('view_purchase_orders', 'Purchase Orders', 'View purchase orders', ON),
  toggle('view_logistic_orders', 'Logistic Orders', 'View logistic orders', ON),
  toggle('approve_logistic_orders', 'Logistic Orders', 'Approve logistic orders', ADMIN_ONLY, ['view_logistic_orders']),

  toggle('view_communication', 'Communication', 'View communication', ON),
  toggle('contact_customers', 'Communication', 'Contact customers', ON, ['view_communication']),
  toggle('attach_conversations', 'Communication', 'Attach conversations to jobs and leads', ON, ['view_communication']),
  toggle('edit_communication_records', 'Communication', 'Edit communication records', ADMIN_ONLY, ['view_communication']),
  toggle('delete_communication_records', 'Communication', 'Delete communication records', ADMIN_ONLY, ['view_communication']),
  toggle('access_communication', 'Communication', 'Access Communication', ON),
  toggle('export_call_log', 'Communication', 'Export call log', ADMIN_ONLY, ['access_communication']),
  toggle('show_phone', 'Communication', 'Show Phone', ON, ['access_communication']),
  toggle('show_email', 'Communication', 'Show Email', ON, ['access_communication']),
  { key: 'communication_scope', module: 'Communication', label: 'Communication scope', helpText: 'Help for Communication scope.', kind: 'choice', choices: ['attached', 'team', 'all'], requires: [], presets: presets('all', 'attached', 'all', 'attached') },

  { ...toggle('can_own_leads', 'Users', 'Can own leads / be Sold By', presets(true, true, false, true)), setting: true },
  { ...toggle('can_be_dispatcher', 'Users', 'Can be a dispatcher', presets(true, false, true, false)), setting: true },
  { ...toggle('can_be_on_crew', 'Users', 'Can be on a crew', presets(true, false, true, true)), setting: true },
  toggle('manage_payout_account', 'Settings', 'Manage payout account', ADMIN_ONLY),

  toggle('access_schedule', 'Pages', 'Access Schedule', ON),
  toggle('access_reports', 'Pages', 'Access Reports', presets(true, true, false, false)),
  toggle('export_reports', 'Pages', 'Export reports', ADMIN_ONLY, ['access_reports']),
];

export const FIXTURE_LAYOUT: CatalogLayout = {
  money: [
    { key: 'see_prices', parent: null },
    { key: 'see_costs', parent: 'see_prices' },
    { key: 'see_company_figures', parent: 'see_prices' },
  ],
  // The per-person settings: in the catalog, never drawn by the switch editor, edited on the person's profile.
  settings: ['can_own_leads', 'can_be_dispatcher', 'can_be_on_crew', 'inventory_view'],
  groups: [
    {
      label: 'Customers',
      modules: [{
        module: 'Customers', label: 'Customers', scope: null, scopeNote: 'Follows the leads and jobs this person can open.',
        lines: ['view_customers', 'create_customers', 'edit_customers', 'delete_customers', 'export_customers'],
        extras: [{ key: 'change_customer_created_date', parent: 'edit_customers' }],
      }],
    },
    {
      label: 'Leads',
      modules: [{
        module: 'Leads', label: 'Leads', scope: 'leads_scope', scopeNote: null,
        lines: ['view_leads', 'create_leads', 'edit_leads'],
        extras: [
          { key: 'change_lead_status_by_hand', parent: 'edit_leads' },
          { key: 'assign_people_to_leads', parent: null },
          { key: 'reopen_leads', parent: null },
        ],
      }],
    },
    {
      label: 'Estimates',
      modules: [{
        module: 'Estimates', label: 'Estimates', scope: null, scopeNote: 'Follows the leads and jobs this person can open.',
        lines: ['view_estimates', 'create_estimates'], extras: [],
      }],
    },
    {
      label: 'Jobs and visits',
      modules: [{
        module: 'Jobs', label: 'Jobs', scope: 'jobs_scope', scopeNote: null,
        lines: ['view_jobs', 'create_jobs'],
        extras: [{ key: 'assign_people_to_jobs', parent: null }, { key: 'edit_job_and_lead_contact_details', parent: null }],
      }],
    },
    {
      label: 'Invoices and payments',
      modules: [{
        module: 'Invoices', label: 'Invoices', scope: null, scopeNote: 'Follows the leads and jobs this person can open.',
        lines: ['view_invoices'],
        extras: [{ key: 'record_payments', parent: null }, { key: 'view_payments', parent: null }, { key: 'allowed_payment_methods', parent: null }],
      }],
    },
    {
      label: 'Inventory',
      modules: [
        {
          module: 'Stock', label: 'Stock', scope: null, scopeNote: null, lines: ['view_stock', 'edit_stock'],
          extras: [{ key: 'pick_up_staged_items', parent: null }, { key: 'record_pickup_for_someone_else', parent: null }],
        },
        {
          module: 'Purchase Orders', label: 'Purchase Orders', scope: null, scopeNote: 'Follows the leads and jobs this person can open.',
          lines: ['view_purchase_orders'], extras: [],
        },
        {
          module: 'Logistic Orders', label: 'Logistic Orders', scope: null, scopeNote: 'Follows the leads and jobs this person can open.',
          lines: ['view_logistic_orders'], extras: [{ key: 'approve_logistic_orders', parent: null }],
        },
      ],
    },
    {
      label: 'Communication',
      modules: [{
        module: 'Communication', label: 'Communication', scope: 'communication_scope', scopeNote: null,
        lines: ['view_communication'],
        extras: [
          { key: 'contact_customers', parent: null },
          { key: 'attach_conversations', parent: null },
          { key: 'edit_communication_records', parent: null },
          { key: 'delete_communication_records', parent: null },
          { key: 'access_communication', parent: null },
          { key: 'show_phone', parent: 'access_communication' },
          { key: 'show_email', parent: 'access_communication' },
          { key: 'export_call_log', parent: 'access_communication' },
        ],
      }],
    },
    {
      label: 'Team and settings',
      modules: [{
        module: 'Users', label: 'Users', scope: null, scopeNote: null, lines: [],
        extras: [],
      }, {
        module: 'Settings', label: 'Settings', scope: null, scopeNote: null, lines: [],
        extras: [{ key: 'manage_payout_account', parent: null }],
      }],
    },
    {
      label: 'Pages',
      modules: [{
        module: 'Pages', label: 'Pages', scope: null, scopeNote: null, lines: [],
        extras: [{ key: 'access_schedule', parent: null }, { key: 'access_reports', parent: null }, { key: 'export_reports', parent: 'access_reports' }],
      }],
    },
  ],
};

/** The switches the Permissions editor draws: every catalog entry that is not a per-person setting. */
export const FIXTURE_DRAWN_SWITCHES: CatalogSwitch[] = FIXTURE_SWITCHES.filter((s) => !s.setting);

export const FIXTURE_CATALOG: SwitchCatalog = { switches: FIXTURE_SWITCHES, layout: FIXTURE_LAYOUT };

/** A built-in role's values: the catalog's preset column for that role. */
export function presetSet(role: BuiltInRoleKey, catalog: SwitchCatalog = FIXTURE_CATALOG): SwitchSet {
  return Object.fromEntries(catalog.switches.map((s) => [s.key, s.presets[role]]));
}

export const catalogSwitch = (key: string): CatalogSwitch => FIXTURE_SWITCHES.find((s) => s.key === key)!;
