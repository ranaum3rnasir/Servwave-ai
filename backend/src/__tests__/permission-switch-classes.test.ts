/* =============================================================================
   Roles & Permissions alignment, AL-10 (P1, A1) - the catalog holds only switches and settings, and every switch is one of
   four kinds. A switch exists for a verb on a module, for a money class, for a sensitive money action, or for a scope;
   what only changes what a person is offered (a slot, an alert, a view, a van limit, a Phone tab) is a SETTING, listed
   separately and edited on the person's profile. No display switch ("Show ... page", the Phone usage bar) remains.

   Pure: no database.
   ========================================================================== */

import { describe, it, expect } from 'vitest';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { buildCatalogLayout } from '../lib/permissions/switches/layout';
import { PERSON_SETTING_KEYS, isPersonSetting } from '../lib/permissions/switches/settings';
import { MONEY_ACTION_KEYS, SCOPE_REFINEMENT_KEYS, classOfSwitch } from '../lib/permissions/switches/switchClasses';
import { presetValues } from '../lib/permissions/switches/store';
import { validateSwitchSet } from '../lib/permissions/switches/validate';

const keys = SWITCH_CATALOG.map((s) => s.key);

/** What a verb is never named: a display, a slot, an alert or a tab. A key like this belongs in the settings list or nowhere. */
const NOT_A_VERB = [/^show_.+_page$/, /_bar$/, /^can_(own|be)_/, /^alert_every_/, /_tab$/];

/** The three Communication sub-pages that open on Access Communication: the View of that sub-page, kept as verbs. */
const SUBPAGE_VIEWS = ['show_phone', 'show_text', 'show_email'];

describe('the catalog holds switches, and settings are listed apart', () => {
  it('has no Show-page switch and no Phone usage bar: a page opens with its View and the sidebar follows it', () => {
    expect(keys.filter((k) => /^show_.+_page$/.test(k))).toEqual([]);
    expect(keys).not.toContain('phone_usage_bar');
  });

  it('lists the settings in one place, each a real catalog key, and flags exactly those', () => {
    expect([...PERSON_SETTING_KEYS].sort()).toEqual(
      [
        'alert_every_estimate', 'alert_every_invoice', 'alert_every_job', 'alert_every_lead',
        'blocked_callers_tab', 'call_flows_tab', 'call_groups_tab', 'call_masking_tab', 'can_be_dispatcher', 'can_be_on_crew',
        'can_own_leads', 'inventory_view', 'phone_numbers_tab', 'restrict_stock_to_own_van', 'training_tab',
      ].sort(),
    );
    for (const k of PERSON_SETTING_KEYS) expect(keys, k).toContain(k);
    expect(keys.filter(isPersonSetting).sort()).toEqual([...PERSON_SETTING_KEYS].sort());
  });

  it('puts every key in exactly one kind: a verb, a money class, a money action, a scope, or a setting', () => {
    const kinds = new Set(SWITCH_CATALOG.map((s) => classOfSwitch(s)));
    expect([...kinds].sort()).toEqual(['money-action', 'money-class', 'scope', 'setting', 'verb']);
    for (const s of SWITCH_CATALOG) {
      expect(['verb', 'money-class', 'money-action', 'scope', 'setting'], s.key).toContain(classOfSwitch(s));
    }
    // The listed money actions and scope refinements are real keys (a rename would silently demote them to verbs).
    for (const k of [...MONEY_ACTION_KEYS, ...SCOPE_REFINEMENT_KEYS]) expect(keys, k).toContain(k);
    for (const k of MONEY_ACTION_KEYS) expect(classOfSwitch({ key: k, module: 'x' }), k).toBe('money-action');
  });

  it('names no verb like a display, a slot, an alert or a tab; those are settings', () => {
    for (const s of SWITCH_CATALOG) {
      if (classOfSwitch(s) !== 'verb') continue;
      if (SUBPAGE_VIEWS.includes(s.key)) continue;
      for (const pattern of NOT_A_VERB) expect(pattern.test(s.key), `${s.key} looks like ${pattern}`).toBe(false);
      expect(s.key.startsWith('show_'), s.key).toBe(false);
    }
  });

  it('keeps every scope a choice over the standard three, and every other switch an on/off, a list or a setting choice', () => {
    for (const s of SWITCH_CATALOG) {
      if (classOfSwitch(s) === 'scope' && s.kind === 'choice') expect(s.choices, s.key).toEqual(expect.arrayContaining(['attached', 'team', 'all']));
    }
  });
});

describe('the Permissions screens leave the settings out', () => {
  const layout = buildCatalogLayout(SWITCH_CATALOG);
  const drawn = new Set([
    ...layout.money.map((m) => m.key),
    ...layout.groups.flatMap((g) => g.modules.flatMap((m) => [...m.lines, ...m.extras.map((e) => e.key), ...(m.scope ? [m.scope] : [])])),
  ]);

  it('draws no setting in the Money block or in any row', () => {
    for (const k of PERSON_SETTING_KEYS) expect(drawn.has(k), k).toBe(false);
  });

  it('hands the settings to the profile in the layout, in catalog order, and draws every other key', () => {
    expect(layout.settings).toEqual(keys.filter(isPersonSetting));
    for (const k of keys) if (!isPersonSetting(k)) expect(drawn.has(k), k).toBe(true);
  });
});

describe('a setting keeps the storage and behaviour it had', () => {
  it('still resolves from the role it is based on, holds its preset, and passes the catalog validator', () => {
    const admin = presetValues('ADMIN');
    for (const k of PERSON_SETTING_KEYS) expect(k in admin, k).toBe(true);
    expect(validateSwitchSet(admin)).toEqual([]);
    expect(presetValues('TECHNICIAN').can_be_on_crew).toBe(true);
    expect(presetValues('TECHNICIAN').inventory_view).toBe('field');
  });
});
