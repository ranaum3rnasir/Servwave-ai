/* =============================================================================
   Payments go-live, slice P1 - the "Show Payments page" switch in the catalog.

   Pure: no database. Expected values are literals from the slice (the source of truth the catalog entry is
   built from), never read back from the catalog.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { BUILT_IN_ROLES, SWITCH_CATALOG, presetSwitchSet } from '../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../lib/permissions/switches/validate';

const VENDORS = /\b(stripe|twilio|supabase|render|ctm|calltrackingmetrics|resend)\b/i;
const rows = () => SWITCH_CATALOG.filter((s) => s.key === 'show_payments_page');

describe('Show Payments page switch', () => {
  it('is one display-only toggle in the Invoices group that needs View payments and payouts', () => {
    expect(rows()).toHaveLength(1);
    const entry = rows()[0]!;
    expect(entry.module).toBe('Invoices');
    expect(entry.kind).toBe('toggle');
    expect(entry.label).toBe('Show Payments page');
    expect(entry.requires).toEqual(['view_payments']);
    expect(BUILT_IN_ROLES.map((role) => entry.presets[role])).toEqual([true, false, false, false]);
    expect(entry.pending).toMatch(/Display only/);
    expect(entry.serverChecks ?? []).toEqual([]);
    expect(`${entry.label} ${entry.helpText}`).not.toMatch(VENDORS);
  });

  it('keeps every built-in preset valid with the new switch in it', () => {
    for (const role of BUILT_IN_ROLES) expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
  });

  it('refuses Show on while View payments and payouts is off, and accepts both on', () => {
    const base = presetSwitchSet('ADMIN');
    const bad = validateSwitchSet({ ...base, show_payments_page: true, view_payments: false });
    expect(bad.map((v) => v.message).join(' ')).toMatch(/Show Payments page needs View payments and payouts/);
    expect(validateSwitchSet({ ...base, show_payments_page: true, view_payments: true })).toEqual([]);
  });
});
