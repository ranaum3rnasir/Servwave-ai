/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.16 - "See company figures" in the switch catalog.

   Pure: no database. The expected values are the PRD's catalog row, written out as literals here (they are the
   source of truth the catalog is built from), never read back from the catalog.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { BUILT_IN_ROLES, SWITCH_CATALOG, presetSwitchSet } from '../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../lib/permissions/switches/validate';
import { compileSwitchGrants } from '../lib/permissions/switches/store';

const rows = SWITCH_CATALOG.filter((s) => s.label === 'See company figures');

describe('the See company figures switch', () => {
  it('is one on/off switch in the Money group, standing on See prices, with help text that says company-wide money', () => {
    expect(rows).toHaveLength(1);
    const entry = rows[0]!;
    expect(entry.module).toBe('Money');
    expect(entry.kind).toBe('toggle');
    expect(entry.requires).toEqual(['see_prices']);
    expect(entry.requiresAny ?? []).toEqual([]);
    expect(entry.helpText).toMatch(/company-wide/i);
    expect(entry.helpText).toMatch(/revenue/i);
    // The activity feed names no figure in its words (M16), so the help text must not promise one hidden from it.
    expect(entry.helpText).not.toMatch(/dollar amounts/i);
    expect(entry.helpText).toMatch(/activity feed reads the same for everyone/i);
    expect(entry.helpText).not.toMatch(/\b(stripe|twilio|supabase|render|ctm|calltrackingmetrics|resend)\b/i);
  });

  it('is on for Admin only', () => {
    const entry = rows[0]!;
    expect(BUILT_IN_ROLES.map((role) => entry.presets[role])).toEqual([true, false, false, false]);
  });

  it('compiles into its own grant, apart from the one See costs holds', () => {
    expect(rows[0]!.grants.map((g) => `${g.action}:${g.subject}`)).toEqual(['read:CompanyFigures']);
    for (const g of rows[0]!.grants) expect(g.scoped).toBeUndefined();
    const financial = SWITCH_CATALOG.find((s) => s.label === 'See costs')!;
    expect(financial.grants.map((g) => `${g.action}:${g.subject}`)).not.toContain('read:CompanyFigures');
  });

  it('turns the grant on in exactly the presets that have the switch on', () => {
    const on = BUILT_IN_ROLES.filter((role) =>
      compileSwitchGrants(presetSwitchSet(role)).some((g) => g.action === 'read' && g.subject === 'CompanyFigures'),
    );
    expect(on).toEqual(['ADMIN']);
  });

  it('accounts for itself with named server checks, one for each place the server leaves company money out (PRD 8 adds the two on calls)', () => {
    const entry = rows[0]!;
    expect(new Set(entry.serverChecks)).toEqual(
      new Set([
        'dashboard-company-figures',
        'dashboard-scoreboard-revenue',
        'dashboard-activity-unchanged',
        'report-revenue-totals',
        'report-payment-fees-totals',
        'report-estimate-conversion-totals',
        'report-unpaid-invoices-totals',
        'call-revenue',
        'agent-revenue',
      ]),
    );
    expect(entry.serverChecks.length).toBe(new Set(entry.serverChecks).size);
  });

  it('sits in the Money group after See prices, which it needs', () => {
    const labels = SWITCH_CATALOG.filter((s) => s.module === 'Money').map((s) => s.label);
    expect(labels.indexOf('See prices')).toBe(0);
    expect(labels.indexOf('See company figures')).toBeGreaterThan(labels.indexOf('See prices'));
  });

  it('passes the catalog validator in every built-in preset', () => {
    for (const role of BUILT_IN_ROLES) expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
  });
});
