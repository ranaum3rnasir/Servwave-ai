/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.18 - Standalone estimates, Create invoices and Standalone invoices in
   the switch catalog.

   Pure: no database. The expected values are the PRD's catalog rows, written out as literals here (they are the
   source of truth the catalog is built from), never read back from the catalog.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { BUILT_IN_ROLES, SWITCH_CATALOG, presetSwitchSet } from '../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../lib/permissions/switches/validate';
import { compileSwitchGrants } from '../lib/permissions/switches/store';

const byLabel = (label: string) => SWITCH_CATALOG.filter((s) => s.label === label);
const presetsOf = (label: string) => BUILT_IN_ROLES.map((role) => byLabel(label)[0]!.presets[role]);
const VENDORS = /\b(stripe|twilio|supabase|render|ctm|calltrackingmetrics|resend)\b/i;

describe('Standalone estimates, Create invoices and Standalone invoices', () => {
  it.each([
    ['Standalone estimates', 'Estimates', ['Create estimates'], [true, true, true, false]],
    ['Create invoices', 'Invoices', ['View invoices'], [true, false, true, false]],
    ['Standalone invoices', 'Invoices', ['Create invoices'], [true, false, true, false]],
  ])('%s is one on/off switch with the PRD group, requirement and preset column', (label, group, needs, column) => {
    const rows = byLabel(label);
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;
    expect(entry.module).toBe(group);
    expect(entry.kind).toBe('toggle');
    expect(entry.requires.map((key) => SWITCH_CATALOG.find((s) => s.key === key)!.label)).toEqual(needs);
    expect(presetsOf(label)).toEqual(column);
    expect(`${entry.label} ${entry.helpText}`).not.toMatch(VENDORS);
  });

  it('keeps every built-in preset valid with the three new switches in it', () => {
    for (const role of BUILT_IN_ROLES) expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
  });

  it('refuses a set that has a standalone switch on while the switch it builds on is off', () => {
    const set = { ...presetSwitchSet('DISPATCHER'), create_invoices: false };
    expect(validateSwitchSet(set).map((v) => v.message).join(' ')).toMatch(/Standalone invoices needs Create invoices/);
    const noEstimates = { ...presetSwitchSet('DISPATCHER'), create_estimates: false };
    expect(validateSwitchSet(noEstimates).map((v) => v.message).join(' ')).toMatch(/Standalone estimates needs Create estimates/);
  });

  it('compiles Create invoices and the two standalone switches into grants of their own, in exactly the presets that hold them', () => {
    const holders = (action: string, subject: string) =>
      BUILT_IN_ROLES.filter((role) => compileSwitchGrants(presetSwitchSet(role)).some((g) => g.action === action && g.subject === subject));
    expect(holders('create', 'Invoice')).toEqual(['ADMIN', 'DISPATCHER']);
    expect(holders('create_standalone', 'Invoice')).toEqual(['ADMIN', 'DISPATCHER']);
    expect(holders('create_standalone', 'Estimate')).toEqual(['ADMIN', 'SALES', 'DISPATCHER']);
  });

  it('accounts for each switch with named server checks', () => {
    const checks = (label: string) => byLabel(label)[0]!.serverChecks;
    expect(new Set(checks('Create invoices'))).toEqual(new Set(['invoice-create', 'invoice-create-from-job-items', 'estimate-copy-to-invoice']));
    expect(checks('Standalone invoices')).toEqual(['invoice-create-standalone']);
    expect(new Set(checks('Standalone estimates'))).toEqual(new Set(['estimate-create-standalone', 'estimate-duplicate-standalone']));
  });
});
