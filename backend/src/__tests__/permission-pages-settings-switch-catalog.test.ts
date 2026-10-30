/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.14 - the Settings and Pages groups of the switch catalog, and the
   switches the product does not have: no Access Dashboard.

   Pure: no database. The expected values are the PRD's catalog table, written out as literals here (they are
   the source of truth the catalog is built from), never read back from the catalog.
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

type Row = {
  label: string;
  // Admin, Sales, Dispatcher, Technician
  presets: [boolean, boolean, boolean, boolean];
  grants: string[];
  requires: string[];
};

const SETTINGS: Row[] = [
  // Company settings retired (36b, M17): setting up the company is the Admin flag's alone, so it is no row here.
  { label: 'Create tags', presets: [true, true, true, false], grants: ['create:Tag'], requires: [] },
  { label: 'Manage tags', presets: [true, false, false, false], grants: ['update:Tag', 'delete:Tag'], requires: [] },
  {
    label: 'Manage task categories', presets: [true, false, false, false],
    grants: ['create:TaskCategory', 'update:TaskCategory', 'delete:TaskCategory'], requires: [],
  },
  { label: 'Manage payout account', presets: [true, false, false, false], grants: ['manage_payout_account:Organization'], requires: [] },
  // 'View payments and payouts' moved to the Invoices group (payments go-live P8); see permission-refund-requires-view-payments.test.ts.
];

const PAGES: Row[] = [
  { label: 'Access Schedule', presets: [true, true, true, true], grants: ['access:Schedule'], requires: [] },
  { label: 'Access Reports', presets: [true, false, false, false], grants: ['read:Report'], requires: [] },
  { label: 'Export reports', presets: [true, false, false, false], grants: ['export:Report'], requires: ['Access Reports'] },
  { label: 'Access Billing', presets: [true, false, false, false], grants: ['access:Billing'], requires: [] },
  { label: 'Access Marketing', presets: [true, false, false, false], grants: [], requires: [] },
];

const inModule = (module: string) => SWITCH_CATALOG.filter((s) => s.module === module);
const byLabel = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)!;

describe.each([
  ['Settings', SETTINGS],
  ['Pages', PAGES],
])('the %s group of the switch catalog', (module, rows) => {
  it('holds exactly the PRD rows, in order, each an on/off switch with help text', () => {
    const entries = inModule(module);
    expect(entries.map((s) => s.label)).toEqual(rows.map((r) => r.label));
    for (const s of entries) {
      expect(s.kind, s.label).toBe('toggle');
      expect(s.helpText.length, s.label).toBeGreaterThan(0);
    }
  });

  it('gives each switch the PRD preset for Admin, Sales, Dispatcher and Technician', () => {
    for (const row of rows) {
      const entry = byLabel(row.label);
      expect(BUILT_IN_ROLES.map((role) => entry.presets[role]), row.label).toEqual(row.presets);
    }
  });

  it('compiles each switch into the grants the PRD names', () => {
    for (const row of rows) {
      const entry = byLabel(row.label);
      expect(entry.grants.map((g) => `${g.action}:${g.subject}`), row.label).toEqual(row.grants);
    }
  });

  it('requires only what the PRD says', () => {
    for (const row of rows) {
      const entry = byLabel(row.label);
      expect(entry.requires.map((k) => findSwitch(k)!.label), row.label).toEqual(row.requires);
      expect(entry.requiresAny ?? [], row.label).toEqual([]);
    }
  });

  it('accounts for each switch with a server check or a note saying who builds it', () => {
    for (const row of rows) {
      const entry = byLabel(row.label);
      expect(entry.serverChecks.length > 0 || Boolean(entry.pending), row.label).toBe(true);
    }
  });

  it('names no vendor in any label or help text', () => {
    for (const s of inModule(module)) {
      expect(`${s.label} ${s.helpText}`, s.label).not.toMatch(/\b(stripe|twilio|supabase|render|ctm|calltrackingmetrics|resend)\b/i);
    }
  });
});

describe('what the Settings and Pages switches compile into', () => {
  it('turns each switch on in exactly the presets the PRD turns it on in', () => {
    for (const row of [...SETTINGS, ...PAGES]) {
      const entry = byLabel(row.label);
      for (const [i, role] of BUILT_IN_ROLES.entries()) {
        const compiled = compileSwitchGrants(presetSwitchSet(role)).map((g) => `${g.action}:${g.subject}`);
        for (const grant of entry.grants.map((g) => `${g.action}:${g.subject}`)) {
          expect(compiled.includes(grant), `${row.label} / ${role}`).toBe(row.presets[i]);
        }
      }
    }
  });

  it('passes the catalog validator for every built-in preset', () => {
    for (const role of BUILT_IN_ROLES) expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
  });

  it('refuses Export reports on while Access Reports is off', () => {
    const set = { ...presetSwitchSet('ADMIN'), [byLabel('Access Reports').key]: false };
    expect(validateSwitchSet(set).map((v) => v.switchKey)).toEqual([byLabel('Export reports').key]);
  });
});

describe('the dashboard is every signed-in person\'s home page, so it has no switch', () => {
  it('holds no Access Dashboard switch and no switch compiling into a dashboard read', () => {
    expect(SWITCH_CATALOG.some((s) => /dashboard/i.test(`${s.key} ${s.label}`))).toBe(false);
    expect(SWITCH_CATALOG.some((s) => s.grants.some((g) => g.subject === 'Dashboard'))).toBe(false);
  });

  it('gives no built-in role a dashboard read through its switches', () => {
    for (const role of BUILT_IN_ROLES) {
      expect(compileSwitchGrants(presetSwitchSet(role)).some((g) => g.subject === 'Dashboard'), role).toBe(false);
    }
  });
});
