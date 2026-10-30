/* =============================================================================
   Roles & Permissions, PRD 2, slice S02.1 - where each switch sits on the Roles and Permissions screens.

   Pure: no database. The catalog read carries a `layout` so the shared switch-set editor draws every switch in its
   module group and under the switch it narrows, without a list of its own. The structural checks (every switch is
   placed once) read the catalog; the shapes of specific rows are written out here from the PRD.
   ========================================================================== */

import { describe, it, expect, vi } from 'vitest';
import type { Request, Response } from 'express';
import { SWITCH_CATALOG, findSwitch } from '../lib/permissions/switches/catalog';
import { buildCatalogLayout, type CatalogLayout } from '../lib/permissions/switches/layout';

vi.mock('../lib/prisma', () => ({ prisma: {} }));

const layout: CatalogLayout = buildCatalogLayout(SWITCH_CATALOG);

const allModules = () => layout.groups.flatMap((g) => g.modules);
const placedKeys = (): string[] => [
  ...layout.money.map((m) => m.key),
  // Per-person settings are edited on the person's profile, not in the module rows (P1/A1), but each is still placed once.
  ...layout.settings,
  ...allModules().flatMap((m) => [...m.lines, ...(m.scope ? [m.scope] : []), ...m.extras.map((e) => e.key)]),
];
const rowOf = (module: string) => allModules().find((m) => m.module === module)!;

describe('the catalog layout', () => {
  it('places every switch of the catalog exactly once', () => {
    const placed = placedKeys();
    expect([...placed].sort()).toEqual(SWITCH_CATALOG.map((s) => s.key).sort());
    expect(new Set(placed).size).toBe(placed.length);
  });

  it('places the two switches another stream registered on the company record like any other', () => {
    // View payments and payouts moved to the Invoices and payments group (payments go-live P8).
    expect(rowOf('Settings').extras.map((e) => e.key)).toEqual(expect.arrayContaining(['manage_payout_account']));
    expect(rowOf('Invoices').extras.map((e) => e.key)).toEqual(expect.arrayContaining(['view_payments']));
  });

  it('puts every module of the catalog in a named group, none left over', () => {
    const catalogModules = new Set(SWITCH_CATALOG.map((s) => s.module).filter((m) => m !== 'Data Scope' && m !== 'Money'));
    expect(new Set(allModules().map((m) => m.module))).toEqual(catalogModules);
  });

  it('gives the groups the PRD order, Inventory and Communication being headings over their modules', () => {
    expect(layout.groups.map((g) => g.label)).toEqual([
      'Customers', 'Leads', 'Estimates', 'Jobs and visits', 'Invoices and payments', 'Notes',
      'Tasks and events', 'Inventory', 'Service Plans and Automations', 'Communication', 'Team and settings',
      'Time tracking', 'Pages',
    ]);
    const group = (label: string) => layout.groups.find((g) => g.label === label)!;
    expect(group('Inventory').modules.map((m) => m.module)).toEqual(['Stock', 'Purchase Orders', 'Vendors', 'Logistic Orders', 'Price Book']);
    expect(group('Team and settings').modules.map((m) => m.module)).toEqual(['Users', 'Departments', 'Locations', 'Settings']);
    expect(group('Pages').modules.map((m) => m.module)).toEqual(['Pages']);
  });

  it('draws the three money classes as one Money row: See prices, with See costs and See company figures nested under it', () => {
    expect(layout.money).toEqual([
      { key: 'see_prices', parent: null },
      { key: 'see_costs', parent: 'see_prices' },
      { key: 'see_company_figures', parent: 'see_prices' },
    ]);
    // The money switches are a row of their own, not a module group and not a scope.
    expect(allModules().map((m) => m.module)).not.toContain('Money');
  });

  it('keeps Edit and Create on the first line of their row although they also Require See prices', () => {
    // See prices is the root of the money chain, not what the row narrows, so it does not move a switch off the row's lines.
    expect(rowOf('Estimates').lines).toEqual(expect.arrayContaining(['view_estimates', 'edit_estimates']));
    expect(rowOf('Invoices').lines).toEqual(expect.arrayContaining(['view_invoices', 'edit_invoices']));
    expect(rowOf('Estimates').extras.find((e) => e.key === 'create_estimates')?.parent).toBe('edit_estimates');
    expect(rowOf('Invoices').extras.find((e) => e.key === 'create_invoices')?.parent).toBe('edit_invoices');
  });

  it('puts a scope choice on the row of the records it narrows', () => {
    expect(rowOf('Leads').scope).toBe('leads_scope');
    expect(rowOf('Jobs').scope).toBe('jobs_scope');
    // Estimates and invoices have no scope choice of their own (P6): their rows say they follow the leads and jobs.
    expect(rowOf('Estimates').scope).toBeNull();
    expect(rowOf('Estimates').scopeNote).not.toBeNull();
    expect(rowOf('Invoices').scope).toBeNull();
    expect(rowOf('Invoices').scopeNote).not.toBeNull();
    // The modules that are not record anchors carry their one scope switch on their own row too (P6, AL-08).
    expect(rowOf('Tasks').scope).toBe('tasks_scope');
    expect(rowOf('Events').scope).toBe('events_scope');
    expect(rowOf('Stock').scope).toBe('assets_scope');
    expect(rowOf('Time tracking').scope).toBe('timesheets_scope');
    expect(rowOf('Communication').scope).toBe('communication_scope');
    expect(allModules().filter((m) => m.scope).map((m) => m.module).sort()).toEqual([
      'Communication', 'Events', 'Jobs', 'Leads', 'Stock', 'Tasks', 'Time tracking',
    ]);
    // A scope switch sits on its row's dropdown only, never again among the row's switches.
    const placed = new Set(allModules().flatMap((m) => [...m.lines, ...m.extras.map((e) => e.key)]));
    for (const key of ['tasks_scope', 'events_scope', 'assets_scope', 'timesheets_scope', 'communication_scope']) expect(placed.has(key), key).toBe(false);
  });

  it('gives the modules that have no scope of their own the line saying their reach follows the leads and jobs', () => {
    const noScopeOfTheirOwn = ['Customers', 'Estimates', 'Invoices', 'Purchase Orders', 'Logistic Orders'];
    for (const module of noScopeOfTheirOwn) expect(rowOf(module).scopeNote, module).toBe('Follows the leads and jobs this person can open.');
    // Every other row carries no such line: the scoped four have a control instead, the rest are not about records.
    const others = allModules().filter((m) => !noScopeOfTheirOwn.includes(m.module));
    expect(others.length).toBeGreaterThan(0);
    for (const row of others) expect(row.scopeNote, row.module).toBeNull();
  });

  it('draws the line from the catalog\'s grants, not from a list of module names', () => {
    const reachedThroughRecords = new Set(
      SWITCH_CATALOG.filter((s) => s.grants.some((g) => g.scoped === 'Customer' || g.scoped === 'Estimate' || g.scoped === 'Invoice' || g.scoped === 'PurchaseOrder' || g.scoped === 'LogisticOrder' || g.scoped === 'LogisticOrderOnJob')).map((s) => s.module),
    );
    expect(allModules().filter((m) => m.scopeNote).map((m) => m.module).sort()).toEqual([...reachedThroughRecords].sort());
  });

  it('opens a row with View, Create, Edit, Delete and Export, only those the catalog gives the module', () => {
    // Create requires Edit (P2, AL-04), so a Create is nested under its Edit and is not a first-line switch of the row.
    expect(rowOf('Leads').lines).toEqual(['view_leads', 'edit_leads', 'delete_leads', 'export_leads']);
    expect(rowOf('Customers').lines).toEqual([
      'view_customers', 'edit_customers', 'delete_customers', 'export_customers',
    ]);
    expect(rowOf('Departments').lines).toEqual(['view_departments', 'edit_departments', 'delete_departments']);
    // Uploads are the record's own data (P10): there is no Attachments row.
    expect(allModules().map((m) => m.module)).not.toContain('Attachments');
    // Managing people is the Admin flag's alone (AL-18): nothing in the Users row needs View users any more, so it stands alone
    // under the row instead of opening it.
    expect(rowOf('Users').lines).toEqual([]);
    expect(rowOf('Users').extras.find((e) => e.key === 'view_users')).toEqual({ key: 'view_users', parent: null });
    expect(rowOf('Communication').lines).toEqual(['view_communication', 'edit_communication_records', 'delete_communication_records']);
    const createOf = (module: string, key: string) => rowOf(module).extras.find((e) => e.key === key)?.parent;
    expect(createOf('Leads', 'create_leads')).toBe('edit_leads');
    expect(createOf('Customers', 'create_customers')).toBe('edit_customers');
    expect(createOf('Departments', 'create_departments')).toBe('edit_departments');
  });

  it('gives the Pages, Settings, Notes and Time tracking rows no View line', () => {
    for (const module of ['Pages', 'Settings', 'Notes', 'Time tracking']) expect(rowOf(module).lines, module).toEqual([]);
    expect(rowOf('Pages').extras.map((e) => e.key)).toEqual(['access_schedule', 'access_reports', 'export_reports', 'access_billing', 'access_marketing']);
    expect(placedKeys()).not.toContain('view_dashboard');
  });

  it('nests an extra under the switch it narrows', () => {
    const parentOf = (module: string, key: string) => rowOf(module).extras.find((e) => e.key === key)?.parent;
    expect(parentOf('Leads', 'change_lead_status_by_hand')).toBe('edit_leads');
    expect(parentOf('Customers', 'change_customer_created_date')).toBe('edit_customers');
    expect(parentOf('Communication', 'show_phone')).toBe('access_communication');
    expect(parentOf('Communication', 'office_phone_in_browser')).toBe('contact_customers');
    expect(parentOf('Communication', 'edit_others_logged_communications')).toBe('log_past_communications');
    expect(parentOf('Pages', 'export_reports')).toBe('access_reports');
    expect(parentOf('Estimates', 'standalone_estimates')).toBe('create_estimates');
    expect(parentOf('Invoices', 'standalone_invoices')).toBe('create_invoices');
  });

  it('leaves a switch that needs only its row\'s View, or nothing, un-nested', () => {
    for (const row of allModules()) {
      for (const extra of row.extras) {
        if (extra.parent === null) continue;
        const entry = findSwitch(extra.key)!;
        expect(entry.requires, extra.key).toContain(extra.parent);
        expect([...row.lines, ...row.extras.map((e) => e.key)], extra.key).toContain(extra.parent);
      }
    }
    expect(rowOf('Jobs').extras.find((e) => e.key === 'office_review')?.parent).toBeNull();
  });

  it('keeps the round-3 and round-4 switches in the rows the PRD names', () => {
    const inRow = (module: string, key: string) => rowOf(module).extras.some((e) => e.key === key);
    expect(inRow('Leads', 'reopen_leads')).toBe(true);
    // The alert switches are per-person settings now: they leave the module rows for the person's profile.
    for (const key of ['alert_every_lead', 'alert_every_job', 'alert_every_estimate', 'alert_every_invoice']) {
      expect(layout.settings, key).toContain(key);
    }
    expect(inRow('Leads', 'alert_every_lead')).toBe(false);
    expect(inRow('Estimates', 'apply_discounts')).toBe(true);
    expect(inRow('Invoices', 'record_payments')).toBe(true);
    expect(inRow('Invoices', 'refund_payments')).toBe(true);
    expect(inRow('Stock', 'pick_up_staged_items')).toBe(true);
    expect(inRow('Stock', 'record_pickup_for_someone_else')).toBe(true);
    expect(inRow('Communication', 'see_main_line_when_no_number')).toBe(true);
    expect(inRow('Communication', 'attach_conversations')).toBe(true);
    expect(inRow('Logistic Orders', 'approve_logistic_orders')).toBe(true);
  });
});

describe('what the screens draw, as the PRD words it', () => {
  const labelsOf = (module: string) => rowOf(module).extras.map((e) => findSwitch(e.key)!.label);
  const lineLabels = (module: string) => rowOf(module).lines.map((k) => findSwitch(k)!.label);
  const preset = (key: string) => findSwitch(key)!.presets;

  it('has no Dashboard line in the Pages group', () => {
    expect(labelsOf('Pages')).toEqual(['Access Schedule', 'Access Reports', 'Export reports', 'Access Billing', 'Access Marketing']);
  });

  it('shows Approve logistic orders and no Submit switch in the Logistic Orders row', () => {
    const labels = [...lineLabels('Logistic Orders'), ...labelsOf('Logistic Orders')];
    expect(labels).toContain('Approve logistic orders');
    expect(labels.filter((l) => /submit/i.test(l))).toEqual([]);
  });

  it('shows Assign people to jobs and Assign people to leads, off for the Sales preset', () => {
    expect(labelsOf('Jobs')).toContain('Assign people to jobs');
    expect(labelsOf('Leads')).toContain('Assign people to leads');
    expect(preset('assign_people_to_jobs').SALES).toBe(false);
    expect(preset('assign_people_to_leads').SALES).toBe(false);
  });

  it('shows no switch in Time tracking but its Timesheets scope, with no clock-in location or timeclock-settings switch', () => {
    expect(labelsOf('Time tracking')).toEqual([]);
    expect(rowOf('Time tracking').scope).toBe('timesheets_scope');
    expect(SWITCH_CATALOG.filter((s) => /clock-in|location|timeclock/i.test(s.label) && s.module !== 'Locations')).toEqual([]);
  });

  it('has no Mark jobs lost, Cancel leads, Mark Work Completed or "Start and complete visits" line', () => {
    const everyLabel = allModules().flatMap((m) => [...m.lines, ...m.extras.map((e) => e.key)]).map((k) => findSwitch(k)!.label);
    expect(everyLabel).not.toContain('Mark jobs lost');
    expect(everyLabel).not.toContain('Cancel leads');
    expect(everyLabel).not.toContain('Mark Work Completed');
    expect(everyLabel).not.toContain('Start and complete visits');
    expect(labelsOf('Jobs')).toContain('Start and finish visits');
    expect(labelsOf('Leads')).toEqual(expect.arrayContaining(['Mark leads lost', 'Reopen leads']));
  });

  it('holds the four "Alert me about every ..." switches among the person settings, on for the Admin preset only', () => {
    const alerts: Array<[string, string]> = [['Jobs', 'alert_every_job'], ['Leads', 'alert_every_lead'], ['Estimates', 'alert_every_estimate'], ['Invoices', 'alert_every_invoice']];
    for (const [module, key] of alerts) {
      expect(layout.settings, key).toContain(key);
      expect(rowOf(module).extras.map((e) => e.key), key).not.toContain(key);
      expect(preset(key)).toEqual({ ADMIN: true, SALES: false, DISPATCHER: false, TECHNICIAN: false });
    }
  });

  it('holds the staged-pickup, main-line, reopen and attach switches with the presets the PRD gives', () => {
    expect(preset('pick_up_staged_items')).toMatchObject({ ADMIN: true, DISPATCHER: true, TECHNICIAN: true, SALES: false });
    expect(preset('record_pickup_for_someone_else')).toMatchObject({ ADMIN: true, DISPATCHER: true, TECHNICIAN: false, SALES: false });
    expect(preset('see_main_line_when_no_number')).toMatchObject({ ADMIN: true, SALES: true, DISPATCHER: true, TECHNICIAN: false });
    expect(preset('reopen_leads')).toMatchObject({ ADMIN: true, SALES: true, DISPATCHER: true, TECHNICIAN: false });
    expect(preset('attach_conversations')).toEqual({ ADMIN: true, SALES: true, DISPATCHER: true, TECHNICIAN: true });
  });

  it('puts Record payments and Refund payments in the Invoices row, Apply discounts and Standalone estimates in Estimates, and Edit record ID numbers per module', () => {
    expect(labelsOf('Invoices')).toEqual(expect.arrayContaining(['Record payments', 'Refund payments']));
    expect(labelsOf('Estimates')).toEqual(expect.arrayContaining(['Apply discounts', 'Standalone estimates']));
    for (const module of ['Customers', 'Leads', 'Jobs', 'Estimates', 'Invoices']) {
      expect(labelsOf(module).some((l) => /^Edit record ID numbers/.test(l)), module).toBe(true);
    }
  });

  it('gives the eligibility switches no requirement, so they are never tied to Create leads or Create jobs', () => {
    for (const key of ['can_own_leads', 'can_be_dispatcher', 'can_be_on_crew']) {
      expect(findSwitch(key)!.requires, key).toEqual([]);
      expect(layout.settings, key).toContain(key);
    }
  });
});

describe('the catalog read', () => {
  it('carries the layout beside the switches', async () => {
    const { getCatalog } = await import('../controllers/permission-switch.controller.js');
    let body: { switches: Array<{ key: string }>; layout: CatalogLayout } | undefined;
    const res = { json: (b: unknown) => { body = b as typeof body; } } as unknown as Response;
    getCatalog({} as Request, res);
    expect(body!.layout).toEqual(layout);
    expect(body!.switches.map((s) => s.key)).toEqual(SWITCH_CATALOG.map((s) => s.key));
  });
});
