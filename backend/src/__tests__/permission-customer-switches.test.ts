/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.5 - the Customers and Service Plans rows of the switch catalog,
   and the reach a customer switch compiles into.

   Pure: no database. The expected values are the PRD's catalog tables, written out as literals here
   (they are the source of truth the catalog is built from), never read back from the catalog.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { BUILT_IN_ROLES, SWITCH_CATALOG, findSwitch, presetSwitchSet } from '../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../lib/permissions/switches/validate';
import { compileSwitchGrants } from '../lib/permissions/switches/store';
import { customerReach, customerThroughRecordsReach } from '../lib/permissions/recordPeople';

const keyOfLabel = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)?.key;

describe('the Customers and Service Plans rows', () => {
  // Admin, Sales, Dispatcher, Technician - the PRD's catalog table.
  const rows: Record<string, [boolean, boolean, boolean, boolean]> = {
    'View customers': [true, true, true, false],
    'Create customers': [true, true, true, false],
    'Edit customers': [true, true, false, false],
    'Delete customers': [true, false, false, false],
    'Show Customers page': [true, true, false, false],
    'Export customers': [true, false, false, false],
    'Archive customers': [true, false, false, false],
    'Edit record ID numbers (customers)': [true, false, false, false],
    'Change customer created date': [true, false, false, false],
    'Copy customer phone': [true, true, true, false],
    'Copy customer email': [true, true, true, true],
    'View service plans': [true, false, true, false],
    'Create service plans': [true, false, true, false],
    'Edit service plans': [true, false, true, false],
    'Delete service plans': [true, false, true, false],
    'Show Service Plans page': [true, false, true, false],
  };

  it('hold every switch the slice lists, each with help text and a value for all four built-in roles', () => {
    for (const label of Object.keys(rows)) {
      const key = keyOfLabel(label);
      expect(key, `a switch labelled "${label}"`).toBeDefined();
      const entry = findSwitch(key!)!;
      expect(entry.helpText.length, label).toBeGreaterThan(0);
      expect(Object.keys(entry.presets).sort(), label).toEqual([...BUILT_IN_ROLES].sort());
    }
  });

  it('carry the PRD presets for Admin, Sales, Dispatcher and Technician', () => {
    for (const [label, [admin, sales, dispatcher, technician]] of Object.entries(rows)) {
      const entry = findSwitch(keyOfLabel(label)!)!;
      expect(entry.presets, label).toEqual({ ADMIN: admin, SALES: sales, DISPATCHER: dispatcher, TECHNICIAN: technician });
    }
  });

  it('put the Technician preset on Customers View off and Copy customer email on, and pass validation', () => {
    const technician = presetSwitchSet('TECHNICIAN');
    expect(technician[keyOfLabel('View customers')!]).toBe(false);
    expect(technician[keyOfLabel('Copy customer email')!]).toBe(true);
    expect(validateSwitchSet(technician)).toEqual([]);
  });

  it('keep the row rule: Show, Create, Edit, Delete, Export, Archive and the id numbers need View customers, created date needs Edit customers', () => {
    const view = keyOfLabel('View customers')!;
    for (const label of ['Show Customers page', 'Create customers', 'Edit customers', 'Delete customers', 'Export customers', 'Archive customers', 'Edit record ID numbers (customers)']) {
      expect(findSwitch(keyOfLabel(label)!)!.requires, label).toEqual([view]);
    }
    expect(findSwitch(keyOfLabel('Change customer created date')!)!.requires).toEqual([keyOfLabel('Edit customers')!]);
    // The copy switches say what a screen shows of a customer that comes with a job or lead: nothing to stand on.
    expect(findSwitch(keyOfLabel('Copy customer phone')!)!.requires).toEqual([]);
    expect(findSwitch(keyOfLabel('Copy customer email')!)!.requires).toEqual([]);
  });

  it('turns Create customers off for a role that turns View customers off', () => {
    const set = { ...presetSwitchSet('ADMIN'), [keyOfLabel('View customers')!]: false };
    const broken = validateSwitchSet(set).map((v) => v.switchKey);
    expect(broken).toEqual(expect.arrayContaining([keyOfLabel('Create customers')!, keyOfLabel('Edit customers')!]));
  });

  it('give the Service Plans rows their own group and the row rule', () => {
    const view = keyOfLabel('View service plans')!;
    for (const label of ['View service plans', 'Create service plans', 'Edit service plans', 'Delete service plans', 'Show Service Plans page']) {
      expect(findSwitch(keyOfLabel(label)!)!.module, label).toBe('Service Plans');
    }
    for (const label of ['Create service plans', 'Edit service plans', 'Delete service plans', 'Show Service Plans page']) {
      expect(findSwitch(keyOfLabel(label)!)!.requires, label).toEqual([view]);
    }
  });
});

describe('the reach of a customer', () => {
  const ON = presetSwitchSet('ADMIN');
  const compiled = (scopes: { leads_scope: string; jobs_scope: string }, extra: Record<string, boolean | string> = {}) =>
    compileSwitchGrants({ ...ON, ...scopes, ...extra });
  const readOnCustomers = (grants: ReturnType<typeof compileSwitchGrants>) => grants.filter((g) => g.action === 'read' && g.subject === 'Customer');

  it('is every customer, with no condition, when Leads scope and Jobs scope are both All', () => {
    expect(readOnCustomers(compiled({ leads_scope: 'all', jobs_scope: 'all' }))).toEqual([{ action: 'read', subject: 'Customer' }]);
  });

  it('is conditional when either scope is narrower than All', () => {
    for (const scopes of [
      { leads_scope: 'attached', jobs_scope: 'all' },
      { leads_scope: 'all', jobs_scope: 'attached' },
      { leads_scope: 'team', jobs_scope: 'location' },
    ]) {
      const reads = readOnCustomers(compiled(scopes));
      expect(reads.length, JSON.stringify(scopes)).toBeGreaterThan(0);
      for (const g of reads) expect(g.conditions, JSON.stringify(scopes)).toBeDefined();
    }
  });

  it('always includes the customers the person created', () => {
    const arms = customerReach('attached', 'attached');
    expect(arms).toContainEqual({ conditions: { created_by_id: '{{userId}}' } });
  });

  it('reaches nothing for a scope value it does not know', () => {
    expect(customerReach('mystery', 'all')).toBeNull();
    expect(readOnCustomers(compiled({ leads_scope: 'mystery', jobs_scope: 'all' }))).toEqual([]);
  });

  it('compiles no customer grant at all while View customers is off', () => {
    const grants = compiled({ leads_scope: 'all', jobs_scope: 'all' }, { view_customers: false, create_customers: false, edit_customers: false,
      delete_customers: false, show_customers_page: false, export_customers: false, archive_customers: false,
      edit_customer_record_ids: false, change_customer_created_date: false });
    expect(grants.filter((g) => g.subject === 'Customer')).toEqual([]);
  });

  it('conditions every acting grant on the customer\'s reach, not only the read', () => {
    const grants = compiled({ leads_scope: 'attached', jobs_scope: 'attached' });
    for (const action of ['update', 'delete', 'export', 'archive', 'renumber', 'change_created_date']) {
      const forAction = grants.filter((g) => g.action === action && g.subject === 'Customer');
      expect(forAction.length, action).toBeGreaterThan(0);
      for (const g of forAction) expect(g.conditions, action).toBeDefined();
    }
    expect(grants.filter((g) => g.action === 'create' && g.subject === 'Customer')).toEqual([{ action: 'create', subject: 'Customer' }]);
  });

  it('has no condition on an acting grant when Leads scope and Jobs scope are both All', () => {
    const grants = compiled({ leads_scope: 'all', jobs_scope: 'all' });
    expect(grants.filter((g) => g.action === 'update' && g.subject === 'Customer')).toEqual([{ action: 'update', subject: 'Customer' }]);
  });
});

describe('the customers that come with a record', () => {
  it('are those of the leads and jobs the person can open or is attached to, and not the ones they only created', () => {
    const arms = customerThroughRecordsReach('attached', 'attached');
    expect(arms).not.toBeNull();
    expect(arms!.length).toBeGreaterThan(0);
    for (const arm of arms!) expect(Object.keys(arm)).toSatisfy((keys: string[]) => keys.every((k) => k === 'leads' || k === 'jobs'));
    expect(arms).not.toContainEqual({ created_by_id: '{{userId}}' });
  });

  it('are the customers who have any lead or job, even on Leads scope All and Jobs scope All', () => {
    expect(customerThroughRecordsReach('all', 'all')).toEqual([{ leads: { some: {} } }, { jobs: { some: {} } }]);
  });

  it('reach nothing for a scope value it does not know', () => {
    expect(customerThroughRecordsReach('mystery', 'all')).toBeNull();
  });
});
