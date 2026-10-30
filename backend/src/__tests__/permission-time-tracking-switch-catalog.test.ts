/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.13 - the Time tracking group of the switch catalog: Timesheets scope
   only (the See-everyone's-timesheets toggle became the module's one scope switch, P6). The clock-in location switches and Manage timeclock settings are not in the catalog.

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
  it('holds exactly Timesheets scope: the standard three choices, All for Admin and Dispatcher and Attached for the others, with help text', () => {
    expect(TIME_TRACKING.map((s) => s.label)).toEqual(['Timesheets scope']);
    const entry = TIME_TRACKING[0]!;
    expect(entry.kind).toBe('choice');
    expect(entry.choices).toEqual(['attached', 'team', 'all']);
    expect(entry.helpText.length).toBeGreaterThan(0);
    expect(entry.presets).toEqual({ ADMIN: 'all', SALES: 'attached', DISPATCHER: 'all', TECHNICIAN: 'attached' });
  });

  it('needs no other switch on: timesheets are not the users list', () => {
    expect(TIME_TRACKING[0]!.requires).toEqual([]);
    expect(TIME_TRACKING[0]!.requiresAny ?? []).toEqual([]);
    const alone = Object.fromEntries(SWITCH_CATALOG.map((s) => [s.key, s.kind === 'toggle' ? false : s.presets.ADMIN]));
    expect(validateSwitchSet({ ...alone, [TIME_TRACKING[0]!.key]: 'all' }).map((v) => v.switchKey)).not.toContain(TIME_TRACKING[0]!.key);
  });

  it('is not a check of its own: it narrows the two org timesheet views (see permission-time-tracking-db.test.ts)', () => {
    expect(TIME_TRACKING[0]!.serverChecks).toEqual([]);
    expect(TIME_TRACKING[0]!.pending).toBeDefined();
  });

  it('holds no clock-in location switch and no Manage timeclock settings switch anywhere in the catalog', () => {
    const text = SWITCH_CATALOG.map((s) => `${s.key} ${s.label}`).join('\n');
    expect(text).not.toMatch(/geofence|clock.?in.*(location|outside|zone)|outside the|timeclock settings|clock corrections|approve clock/i);
    expect(SWITCH_CATALOG.some((s) => s.grants.some((g) => g.subject === 'Timeclock'))).toBe(false);
  });

  it('names no vendor in its label or help text', () => {
    expect(`${TIME_TRACKING[0]!.label} ${TIME_TRACKING[0]!.helpText}`).not.toMatch(/\b(stripe|twilio|supabase|render|ctm|calltrackingmetrics)\b/i);
  });

  it('passes the catalog validator for every built-in preset', () => {
    for (const role of BUILT_IN_ROLES) expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
  });
});

describe('what the Time tracking switch compiles into', () => {
  it('is no grant at all: the scope is read from the switch value, so no ability carries it', () => {
    expect(findSwitch(TIME_TRACKING[0]!.key)!.grants).toEqual([]);
    for (const role of BUILT_IN_ROLES) {
      expect(compileSwitchGrants(presetSwitchSet(role)).some((g) => g.subject === 'Timeclock'), role).toBe(false);
    }
  });

  it('leaves the timeclock settings grant out of the ability catalog, so no role can be given it', () => {
    expect(isCatalogEntry('update', 'Timeclock')).toBe(false);
    expect(isCatalogEntry('read', 'Timeclock')).toBe(false);
    expect(PERMISSION_CATALOG.some((c) => c.subject === 'Timeclock')).toBe(false);
  });
});
