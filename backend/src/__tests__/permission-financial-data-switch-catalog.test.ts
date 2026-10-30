/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.15 - "See financial data" in the switch catalog: one switch, costs only.

   Pure: no database. The expected values are the PRD's catalog row, written out as literals here (they are the
   source of truth the catalog is built from), never read back from the catalog.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { BUILT_IN_ROLES, SWITCH_CATALOG, presetSwitchSet } from '../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../lib/permissions/switches/validate';
import { compileSwitchGrants } from '../lib/permissions/switches/store';

const rows = SWITCH_CATALOG.filter((s) => s.label === 'See financial data');

describe('the See financial data switch', () => {
  it('is one on/off switch in the Data Scope group, standing on its own, with help text that says costs only', () => {
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;
    expect(entry.module).toBe('Data Scope');
    expect(entry.kind).toBe('toggle');
    expect(entry.requires).toEqual([]);
    expect(entry.requiresAny ?? []).toEqual([]);
    expect(entry.helpText).toMatch(/cost/i);
    expect(entry.helpText).toMatch(/prices/i);
    expect(entry.helpText).not.toMatch(/\b(stripe|twilio|supabase|render|ctm|calltrackingmetrics|resend)\b/i);
  });

  it('is on for Admin and Sales and off for Dispatcher and Technician', () => {
    const entry = rows[0]!;
    expect(BUILT_IN_ROLES.map((role) => entry.presets[role])).toEqual([true, true, false, false]);
  });

  it('compiles into the one grant the product has always read for it, and nothing else', () => {
    expect(rows[0]!.grants.map((g) => `${g.action}:${g.subject}`)).toEqual(['read:Pricing']);
    for (const g of rows[0]!.grants) expect(g.scoped).toBeUndefined();
  });

  it('turns the grant on in exactly the presets that have the switch on', () => {
    const on = BUILT_IN_ROLES.filter((role) =>
      compileSwitchGrants(presetSwitchSet(role)).some((g) => g.action === 'read' && g.subject === 'Pricing'),
    );
    expect(on).toEqual(['ADMIN', 'SALES']);
  });

  it('accounts for itself with named server checks, each one a cost the server leaves out', () => {
    const entry = rows[0]!;
    expect(entry.serverChecks.length).toBeGreaterThan(0);
    expect(new Set(entry.serverChecks).size).toBe(entry.serverChecks.length);
  });

  it('passes the catalog validator in every built-in preset', () => {
    for (const role of BUILT_IN_ROLES) expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
  });
});
