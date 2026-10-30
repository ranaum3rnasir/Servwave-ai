/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.9 - the Inventory group of the switch catalog: Stock, Purchase
   Orders, Vendors, Logistic Orders and Price Book.

   Pure: no database. The expected values are the PRD's catalog table, written out as literals here (they
   are the source of truth the catalog is built from), never read back from the catalog.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import {
  BUILT_IN_ROLES,
  SWITCH_CATALOG,
  findSwitch,
  presetSwitchSet,
} from '../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../lib/permissions/switches/validate';
import { compileSwitchGrants } from '../lib/permissions/switches/store';
import { scopeWhereFor, MATCH_NOTHING } from '../lib/permissions/scopeWhereFor';

type Row = [admin: boolean | string, sales: boolean | string, dispatcher: boolean | string, technician: boolean | string];

const STOCK_ROWS: Record<string, Row> = {
  'View stock': [true, true, true, true],
  'Create stock': [true, false, false, false],
  'Edit stock': [true, false, false, false],
  'Delete stock': [true, false, false, false],
  'Export stock': [true, true, false, false],
  'See inventory activity': [true, true, true, false],
  'Assets scope': ['all', 'all', 'all', 'attached'],
  'Inventory view': ['counter', 'counter', 'counter', 'field'],
  'Restrict stock to own van': [false, false, false, false],
  'Pick up staged items': [true, false, true, true],
  'Record pickup for someone else': [true, false, true, false],
};
const PURCHASE_ORDER_ROWS: Record<string, Row> = {
  'View purchase orders': [true, true, true, false],
  'Create purchase orders': [true, false, false, false],
  'Edit purchase orders': [true, false, false, false],
  'Delete purchase orders': [true, false, false, false],
  'Export purchase orders': [true, true, false, false],
};
const VENDOR_ROWS: Record<string, Row> = {
  'View vendors': [true, true, true, false],
  'Create vendors': [true, false, false, false],
  'Edit vendors': [true, false, false, false],
  'Delete vendors': [true, false, false, false],
  'Export vendors': [true, true, false, false],
};
const LOGISTIC_ORDER_ROWS: Record<string, Row> = {
  'View logistic orders': [true, true, true, true],
  'Create logistic orders': [true, true, true, false],
  'Edit logistic orders': [true, true, true, false],
  'Delete logistic orders': [true, true, false, false],
  'Approve logistic orders': [true, false, false, false],
  'Process logistic orders': [true, false, true, false],
  'Cancel logistic orders': [true, false, true, false],
};
const PRICE_BOOK_ROWS: Record<string, Row> = {
  'View price book': [true, true, true, true],
  'Create price book items': [true, false, false, false],
  'Edit price book items': [true, false, false, false],
  'Delete price book items': [true, false, false, false],
  'Export price book': [true, true, false, false],
};

const GROUPS: Record<string, Record<string, Row>> = {
  Stock: STOCK_ROWS,
  'Purchase Orders': PURCHASE_ORDER_ROWS,
  Vendors: VENDOR_ROWS,
  'Logistic Orders': LOGISTIC_ORDER_ROWS,
  'Price Book': PRICE_BOOK_ROWS,
};

const keyOfLabel = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)?.key;
const entryOf = (label: string) => {
  const key = keyOfLabel(label);
  expect(key, `a switch labelled "${label}"`).toBeDefined();
  return findSwitch(key!)!;
};

describe('the Inventory rows of the switch catalog', () => {
  it('hold every switch the PRD lists, in its group, with the four preset values and help text', () => {
    for (const [group, rows] of Object.entries(GROUPS)) {
      for (const [label, [admin, sales, dispatcher, technician]] of Object.entries(rows)) {
        const entry = entryOf(label);
        expect(entry.module, label).toBe(group);
        expect(entry.helpText.length, label).toBeGreaterThan(0);
        expect(entry.presets, label).toEqual({ ADMIN: admin, SALES: sales, DISPATCHER: dispatcher, TECHNICIAN: technician });
      }
    }
  });

  it('hold nothing else in those groups', () => {
    for (const [group, rows] of Object.entries(GROUPS)) {
      const labels = SWITCH_CATALOG.filter((s) => s.module === group).map((s) => s.label);
      expect(labels.sort(), group).toEqual(Object.keys(rows).sort());
    }
  });

  it('pass the catalog validator for every built-in preset', () => {
    for (const role of BUILT_IN_ROLES) expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
  });

  it('name a server check for each switch, or say which slice builds it', () => {
    for (const rows of Object.values(GROUPS)) {
      for (const label of Object.keys(rows)) {
        const entry = entryOf(label);
        expect(entry.serverChecks.length > 0 || Boolean(entry.pending), label).toBe(true);
      }
    }
  });

  it('name no vendor in a label or help text', () => {
    for (const rows of Object.values(GROUPS)) {
      for (const label of Object.keys(rows)) {
        const entry = entryOf(label);
        expect(`${entry.label} ${entry.helpText}`, label).not.toMatch(/\b(stripe|twilio|supabase|render|ctm|calltrackingmetrics)\b/i);
      }
    }
  });
});

describe('the row rule and Requires in the Inventory group', () => {
  it('puts Show, Create, Edit, Delete and Export of each row under that row\'s View', () => {
    const viewOf: Record<string, string> = {
      Stock: 'View stock', 'Purchase Orders': 'View purchase orders', Vendors: 'View vendors',
      'Logistic Orders': 'View logistic orders', 'Price Book': 'View price book',
    };
    const rowRule = /^(Show .* page|Create .*|Edit .*|Delete .*|Export .*)$/;
    for (const [group, rows] of Object.entries(GROUPS)) {
      for (const label of Object.keys(rows).filter((l) => rowRule.test(l))) {
        expect(entryOf(label).requires, label).toContain(keyOfLabel(viewOf[group]!));
      }
    }
  });

  it('puts See inventory activity under View stock, and Approve, Process and Cancel under View logistic orders', () => {
    for (const label of ['See inventory activity']) expect(entryOf(label).requires, label).toEqual([keyOfLabel('View stock')]);
    for (const label of ['Approve logistic orders', 'Process logistic orders', 'Cancel logistic orders']) {
      expect(entryOf(label).requires, label).toEqual([keyOfLabel('View logistic orders')]);
    }
  });

  it('needs nothing for the pickup switches, Inventory view and Restrict stock to own van, so they stand with Edit stock and View stock off', () => {
    for (const label of ['Pick up staged items', 'Record pickup for someone else', 'Inventory view', 'Restrict stock to own van']) {
      expect(entryOf(label).requires, label).toEqual([]);
    }
    const set = {
      ...presetSwitchSet('ADMIN'),
      view_stock: false, create_stock: false, edit_stock: false, delete_stock: false, export_stock: false,
      see_inventory_activity: false, assets_scope: 'attached',
      // Turning the whole Stock row off must leave these valid and on.
      pick_up_staged_items: true, record_pickup_for_someone_else: true, restrict_stock_to_own_van: true, inventory_view: 'field',
    };
    expect(validateSwitchSet(set)).toEqual([]);
  });

  it('refuses Approve logistic orders on with View logistic orders off, and Create stock on with View stock off', () => {
    const noLo = { ...presetSwitchSet('ADMIN'), view_logistic_orders: false };
    expect(validateSwitchSet(noLo).some((v) => v.switchKey === 'approve_logistic_orders' && v.needs.includes('view_logistic_orders'))).toBe(true);
    const noStock = { ...presetSwitchSet('ADMIN'), view_stock: false };
    expect(validateSwitchSet(noStock).some((v) => v.switchKey === 'create_stock' && v.needs.includes('view_stock'))).toBe(true);
  });

  it('makes Inventory view a choice between Counter and Field, Counter first', () => {
    const entry = entryOf('Inventory view');
    expect(entry.kind).toBe('choice');
    expect(entry.choices).toEqual(['counter', 'field']);
    expect(validateSwitchSet({ ...presetSwitchSet('SALES'), inventory_view: 'warehouse' }).map((v) => v.switchKey)).toEqual(['inventory_view']);
  });
});

describe('what Create and Approve logistic orders stand for', () => {
  it('folds submitting into Create logistic orders, and keeps Approve its own switch for any role', () => {
    const create = entryOf('Create logistic orders');
    expect(create.grants.map((g) => `${g.action}:${g.subject}`).sort()).toEqual(['create:LogisticOrder', 'submit:LogisticOrder']);
    expect(create.helpText).toMatch(/submit/i);
    expect(SWITCH_CATALOG.map((s) => s.label)).not.toContain('Submit logistic orders');

    const approve = entryOf('Approve logistic orders');
    expect(approve.grants.map((g) => `${g.action}:${g.subject}`)).toEqual(['approve:LogisticOrder']);
    // Every preset column is a plain on/off, none of them tied to a role name.
    expect(approve.requires).toEqual([keyOfLabel('View logistic orders')]);
  });

  it('makes See inventory activity a check of its own on the movement routes, standing for no row of the role editor', () => {
    const entry = entryOf('See inventory activity');
    expect(entry.pending).toBeUndefined();
    expect(entry.grants.map((g) => `${g.action}:${g.subject}`)).toEqual(['see_inventory_activity:Inventory']);
    expect(entry.serverChecks).toEqual(['stock-movement-list', 'stock-movement-detail']);
  });

  it('makes Record pickup for someone else a check of its own on the "Taken by..." routes (stage and logistic order) and their pickers, needing neither Edit stock nor Pick up staged items', () => {
    const entry = entryOf('Record pickup for someone else');
    expect(entry.pending).toBeUndefined();
    expect(entry.grants.map((g) => `${g.action}:${g.subject}`)).toEqual(['record_pickup_for_other:Inventory']);
    expect(entry.serverChecks).toEqual(['stage-pickup-for-other', 'stage-pickup-people', 'order-pickup-for-other', 'order-pickup-people']);
    expect(entry.requires).toEqual([]);
  });

  it('makes Pick up staged items a check of its own on the stage and logistic-order pickup routes, standing for no row of the role editor and needing no Edit stock', () => {
    const entry = entryOf('Pick up staged items');
    expect(entry.pending).toBeUndefined();
    expect(entry.grants.map((g) => `${g.action}:${g.subject}`)).toEqual(['pick_up_staged:Inventory']);
    expect(entry.serverChecks).toEqual(['stage-pickup', 'order-pickup']);
    expect(entry.requires).toEqual([]);
  });

  it('makes Assets scope the Stock row\'s one scope switch (P6): the standard three choices, narrowing the asset routes rather than refusing by a check of its own', () => {
    const entry = entryOf('Assets scope');
    expect(entry.key).toBe('assets_scope');
    expect(entry.kind).toBe('choice');
    expect(entry.choices).toEqual(['attached', 'team', 'all']);
    expect(entry.grants).toEqual([]);
    expect(entry.requires).toEqual([]);
    expect(entry.pending).toBeDefined();
    expect(entry.presets).toEqual({ ADMIN: 'all', SALES: 'all', DISPATCHER: 'all', TECHNICIAN: 'attached' });
  });
});

describe('what Export stock stands for', () => {
  it('compiles into an export grant on the stock, so the browser can hide the download without it', () => {
    const entry = entryOf('Export stock');
    expect(entry.grants.map((g) => `${g.action}:${g.subject}`)).toEqual(['export:Inventory']);
    expect(entry.requires).toEqual([keyOfLabel('View stock')]);
  });

  it('gives the grant to whoever holds the switch and to nobody else', () => {
    const exports = (values: Record<string, boolean | string>) =>
      compileSwitchGrants({ ...presetSwitchSet('ADMIN'), ...values }).filter((g) => g.action === 'export' && g.subject === 'Inventory');
    expect(exports({})).toEqual([{ action: 'export', subject: 'Inventory' }]);
    expect(exports({ export_stock: false })).toEqual([]);
  });
});

describe('what Export price book stands for', () => {
  it('compiles into an export grant on the price book, so the browser can hide the download without it', () => {
    const entry = entryOf('Export price book');
    expect(entry.grants.map((g) => `${g.action}:${g.subject}`)).toEqual(['export:PriceBook']);
    expect(entry.requires).toEqual([keyOfLabel('View price book')]);
  });

  it('gives the grant to whoever holds the switch and to nobody else', () => {
    const exports = (values: Record<string, boolean | string>) =>
      compileSwitchGrants({ ...presetSwitchSet('ADMIN'), ...values }).filter((g) => g.action === 'export' && g.subject === 'PriceBook');
    expect(exports({})).toEqual([{ action: 'export', subject: 'PriceBook' }]);
    expect(exports({ export_price_book: false })).toEqual([]);
  });
});

describe.each([
  { label: 'Export purchase orders', view: 'View purchase orders', subject: 'PurchaseOrder', key: 'export_purchase_orders' },
  { label: 'Export vendors', view: 'View vendors', subject: 'Vendor', key: 'export_vendors' },
])('what $label stands for', ({ label, view, subject, key }) => {
  it('compiles into an export grant, so the browser can hide the download without it', () => {
    const entry = entryOf(label);
    expect(entry.grants.map((g) => `${g.action}:${g.subject}`)).toEqual([`export:${subject}`]);
    expect(entry.requires).toEqual([keyOfLabel(view)]);
  });

  it('gives the grant to whoever holds the switch and to nobody else', () => {
    const exports = (values: Record<string, boolean | string>) =>
      compileSwitchGrants({ ...presetSwitchSet('ADMIN'), ...values }).filter((g) => g.action === 'export' && g.subject === subject);
    expect(exports({})).toEqual([{ action: 'export', subject }]);
    expect(exports({ [key]: false })).toEqual([]);
  });
});

describe('what Edit vendors stands for', () => {
  it('lists the vendor update, which rides the vendor upsert route, among its server checks', () => {
    expect(entryOf('Edit vendors').serverChecks).toContain('vendor-update');
  });
});

describe('the reach of purchase orders and logistic orders, compiled from a person\'s switches', () => {
  const holder = (values: Record<string, boolean | string>) => compileSwitchGrants({ ...presetSwitchSet('ADMIN'), ...values });
  const person = { id: 'p1', role: 'DISPATCHER', is_admin: false, department_id: null, location_id: null };
  const grantsFor = (grants: ReturnType<typeof holder>, subject: string, action = 'read') =>
    grants.filter((g) => g.subject === subject && g.action === action);

  it('gives no purchase order grant on the records to a person who cannot open jobs, whatever their Jobs scope', () => {
    const grants = holder({ view_jobs: false, jobs_scope: 'all' });
    // The export grant only draws a button; every grant that opens or changes an order is gone.
    expect(grants.filter((g) => g.subject === 'PurchaseOrder' && g.action !== 'export')).toEqual([]);
  });

  it('reaches a purchase order with no job only under Jobs scope All', () => {
    expect(scopeWhereFor(person, 'PurchaseOrder', holder({ jobs_scope: 'all' }))).toEqual({});
    const attached = scopeWhereFor(person, 'PurchaseOrder', holder({ jobs_scope: 'attached' }));
    expect(Object.keys(attached)).toEqual(['job']);
  });

  it('fails closed on a Team scope for a person with no department', () => {
    expect(scopeWhereFor(person, 'PurchaseOrder', holder({ jobs_scope: 'team' }))).toEqual({ ...MATCH_NOTHING });
    // Their Leads arm still stands when only the jobs arm has nothing to match.
    const lo = scopeWhereFor(person, 'LogisticOrder', holder({ jobs_scope: 'team', leads_scope: 'attached' }));
    expect(Object.keys(lo)).toEqual(['lead']);
  });

  it('reaches an order on neither a job nor a lead only through Jobs scope All, and an order on a lead only through the leads they can open', () => {
    const grants = holder({ jobs_scope: 'all', leads_scope: 'attached' });
    const where = scopeWhereFor(person, 'LogisticOrder', grants) as { OR: Record<string, unknown>[] };
    expect(where.OR).toEqual(expect.arrayContaining([{ job_id: { not: null } }, { job_id: null, lead_id: null }]));
    expect(where.OR.some((arm) => 'lead' in arm)).toBe(true);
    // With View leads off the lead arm is gone: an order on a lead is not reached through any lead.
    const noLeads = scopeWhereFor(person, 'LogisticOrder', holder({ jobs_scope: 'all', view_leads: false })) as { OR: Record<string, unknown>[] };
    expect(noLeads.OR).toEqual([{ job_id: { not: null } }, { job_id: null, lead_id: null }]);
  });

  it('makes a new logistic order need a job the person can open, unless Jobs scope All lets it go on any anchor', () => {
    const narrow = grantsFor(holder({ jobs_scope: 'attached' }), 'LogisticOrder', 'create');
    expect(narrow).toHaveLength(1);
    expect(Object.keys(narrow[0]!.conditions ?? {})).toEqual(['job']);
    expect(grantsFor(holder({ jobs_scope: 'all' }), 'LogisticOrder', 'create')).toEqual([{ action: 'create', subject: 'LogisticOrder' }]);
  });
});
