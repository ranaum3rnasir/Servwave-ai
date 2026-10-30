/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.13 - the Time tracking group of the switch catalog: See everyone's
   timesheets only. The clock-in location switches and Manage timeclock settings are not in the catalog.

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
import { PERMISSION_CATALOG, isCatalogEntry } from '../lib/permissions/catalog';

const TIME_TRACKING = SWITCH_CATALOG.filter((s) => s.module === 'Time tracking');

describe('the Time tracking group of the switch catalog', () => {
  it("holds exactly See everyone's timesheets, on for Admin and Dispatcher only, with help text", () => {
    expect(TIME_TRACKING.map((s) => s.label)).toEqual(["See everyone's timesheets"]);
    const entry = TIME_TRACKING[0]!;
    expect(entry.kind).toBe('toggle');
    expect(entry.helpText.length).toBeGreaterThan(0);
    expect(entry.presets).toEqual({ ADMIN: true, SALES: false, DISPATCHER: true, TECHNICIAN: false });
  });

  it('needs no other switch on: timesheets are not the users list', () => {
    expect(TIME_TRACKING[0]!.requires).toEqual([]);
    expect(TIME_TRACKING[0]!.requiresAny ?? []).toEqual([]);
    const alone = Object.fromEntries(SWITCH_CATALOG.map((s) => [s.key, s.kind === 'toggle' ? false : s.presets.ADMIN]));
    expect(validateSwitchSet({ ...alone, [TIME_TRACKING[0]!.key]: true }).map((v) => v.switchKey)).not.toContain(TIME_TRACKING[0]!.key);
  });

  it('names the two org timesheet views as its server checks', () => {
    expect(TIME_TRACKING[0]!.serverChecks.sort()).toEqual(['timesheet-ot-reviews-org', 'timesheet-punches-org']);
  });

  it('holds no clock-in location switch and no Manage timeclock settings switch anywhere in the catalog', () => {
    const text = SWITCH_CATALOG.map((s) => `${s.key} ${s.label}`).join('\n');
    expect(text).not.toMatch(/geofence|clock.?in.*(location|outside|zone)|outside the|timeclock settings|clock corrections|approve clock/i);
    expect(SWITCH_CATALOG.some((s) => s.grants.some((g) => g.subject === 'Timeclock' && g.action !== 'see_all'))).toBe(false);
  });

  it('names no vendor in its label or help text', () => {
    expect(`${TIME_TRACKING[0]!.label} ${TIME_TRACKING[0]!.helpText}`).not.toMatch(/\b(stripe|twilio|supabase|render|ctm|calltrackingmetrics)\b/i);
  });

  it('passes the catalog validator for every built-in preset', () => {
    for (const role of BUILT_IN_ROLES) expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
  });
});

describe('what the Time tracking switch compiles into', () => {
  it('is one action of its own on the Timeclock subject', () => {
    expect(findSwitch(TIME_TRACKING[0]!.key)!.grants.map((g) => `${g.action}:${g.subject}`)).toEqual(['see_all:Timeclock']);
  });

  it('is in the Admin and Dispatcher presets and not in the Sales or Technician presets', () => {
    const has = (role: (typeof BUILT_IN_ROLES)[number]) =>
      compileSwitchGrants(presetSwitchSet(role)).some((g) => g.action === 'see_all' && g.subject === 'Timeclock');
    expect([has('ADMIN'), has('SALES'), has('DISPATCHER'), has('TECHNICIAN')]).toEqual([true, false, true, false]);
  });

  it('leaves the timeclock settings grant out of the ability catalog, so no role can be given it', () => {
    expect(isCatalogEntry('update', 'Timeclock')).toBe(false);
    expect(isCatalogEntry('read', 'Timeclock')).toBe(false);
    expect(PERMISSION_CATALOG.some((c) => c.subject === 'Timeclock')).toBe(false);
  });
});
