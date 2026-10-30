/* =============================================================================
   Roles & Permissions alignment, AL-04 (P2, A3, A7, A8): Create requires Edit, and the four built-in presets obey the
   chain. Nobody can create a record they could not edit.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { BUILT_IN_ROLES, SWITCH_CATALOG, findSwitch, presetSwitchSet } from '../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../lib/permissions/switches/validate';

const creates = SWITCH_CATALOG.filter((s) => s.key.startsWith('create_'));

describe('Create requires Edit', () => {
  it('names the module\'s Edit in every Create switch that has an Edit beside it', () => {
    const withEdit = creates.filter((s) => findSwitch(`edit_${s.key.slice('create_'.length)}`));
    expect(withEdit.map((s) => s.key).sort()).toEqual(
      ['create_customers', 'create_leads', 'create_jobs', 'create_estimates', 'create_invoices', 'create_service_plans', 'create_automations',
       'create_tasks', 'create_events', 'create_departments', 'create_locations', 'create_stock', 'create_purchase_orders',
       'create_vendors', 'create_logistic_orders', 'create_price_book_items'].sort(),
    );
    for (const s of withEdit) expect(s.requires, s.key).toContain(`edit_${s.key.slice('create_'.length)}`);
  });

  it('refuses a set that has Create on with Edit off, naming the Edit it needs', () => {
    for (const s of creates.filter((c) => findSwitch(`edit_${c.key.slice('create_'.length)}`))) {
      const edit = `edit_${s.key.slice('create_'.length)}`;
      const set = { ...presetSwitchSet('ADMIN'), [edit]: false };
      const violation = validateSwitchSet(set).find((v) => v.switchKey === s.key);
      expect(violation, s.key).toBeDefined();
      expect(violation!.needs, s.key).toContain(edit);
    }
  });

  it('holds in every built-in preset: Create on means Edit on, and each preset validates', () => {
    for (const role of BUILT_IN_ROLES) {
      const set = presetSwitchSet(role);
      expect(validateSwitchSet(set), role).toEqual([]);
      for (const s of creates) {
        const edit = `edit_${s.key.slice('create_'.length)}`;
        if (set[s.key] === true && findSwitch(edit)) expect(set[edit], `${role} ${s.key}`).toBe(true);
      }
    }
  });
});

describe('the built-in presets after the chain (A3, A7, A8)', () => {
  it('gives Technician Edit leads, Edit estimates and Edit jobs, and no Create customers, Record payments or Send payment links', () => {
    const technician = presetSwitchSet('TECHNICIAN');
    expect(technician).toMatchObject({
      edit_leads: true, edit_estimates: true, edit_jobs: true,
      create_leads: true, create_estimates: true, create_jobs: true,
      create_customers: false, record_payments: false, send_payment_links: false,
    });
    // At Their own: the scope switches did not move.
    expect(technician).toMatchObject({ leads_scope: 'attached', jobs_scope: 'attached' });
  });

  it('gives Dispatcher Edit customers and Edit estimates, with Create customers and Create estimates still on', () => {
    expect(presetSwitchSet('DISPATCHER')).toMatchObject({ edit_customers: true, edit_estimates: true, create_customers: true, create_estimates: true });
  });

  it('leaves Sales and Admin as they were', () => {
    expect(presetSwitchSet('SALES')).toMatchObject({ create_customers: true, edit_customers: true, create_estimates: true, edit_estimates: true });
    expect(presetSwitchSet('ADMIN')).toMatchObject({ create_customers: true, edit_customers: true, record_payments: true });
  });
});
