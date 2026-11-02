/**
 * The test harness refuses a person the app cannot produce: a switch on while a switch it Requires is off.
 *
 * The switch catalog says, per switch, which switches it needs (`requires`, `requiresAny`); the Roles screen and the
 * server refuse a set that breaks it. A test that grants "See costs" without "See prices" is testing a screen no person
 * can ever see, and passes or fails for the wrong reason. Every harness that hands a test a person checks the grants
 * against the catalog (read from the backend's own file, no second list) and throws, naming both switches.
 *
 * A test that needs the impossible state on purpose says so by name: `impossibleOnPurpose(ability, reason)` or the
 * `impossibleOnPurpose` option of `seedMySwitches`.
 */
import { describe, it, expect } from 'vitest';

import { renderWithProviders, seedMySwitches } from '@/__tests__/helpers';
import { abilityWithSwitches, impossibleOnPurpose } from '@/__tests__/support/backendSwitchCatalog';
import { buildAbility } from '@/lib/ability';

const Nothing = () => <div>screen</div>;

describe('a test person must be one the switch catalog allows', () => {
  it('rendering with See costs but not See prices throws, naming both switches', () => {
    // `read Pricing` is what See costs grants; See costs requires See prices (`read Prices`).
    const costsOnly = buildAbility([{ action: 'read', subject: 'Pricing' }]);
    expect(() => renderWithProviders(<Nothing />, { ability: costsOnly })).toThrow(/See costs.*See prices/s);
  });

  it('rendering with See costs AND See prices is fine', () => {
    const both = buildAbility([
      { action: 'read', subject: 'Pricing' },
      { action: 'read', subject: 'Prices' },
    ]);
    expect(() => renderWithProviders(<Nothing />, { ability: both })).not.toThrow();
  });

  it('a grant no switch stands for is left alone', () => {
    const legacy = buildAbility([{ action: 'read', subject: 'Inventory' }]);
    expect(() => renderWithProviders(<Nothing />, { ability: legacy })).not.toThrow();
  });

  it('the full-access ability is never refused', () => {
    const everything = buildAbility([{ action: 'manage', subject: 'all' }]);
    expect(() => renderWithProviders(<Nothing />, { ability: everything })).not.toThrow();
  });

  it('abilityWithSwitches refuses a switch whose required switch is not among the labels', () => {
    expect(() => abilityWithSwitches('See costs')).toThrow(/See costs.*See prices/s);
    expect(() => abilityWithSwitches('See prices', 'See costs')).not.toThrow();
  });

  it('seedMySwitches refuses a stored set with a switch on and its requirement off', () => {
    expect(() => seedMySwitches({ see_costs: true })).toThrow(/See costs.*See prices/s);
    expect(() => seedMySwitches({ see_costs: true, see_prices: true })).not.toThrow();
    expect(() => seedMySwitches({ see_costs: false })).not.toThrow();
  });

  it('a deliberate impossible state needs the named opt-out, with a reason', () => {
    const costsOnly = impossibleOnPurpose(
      buildAbility([{ action: 'read', subject: 'Pricing' }]),
      'proves the cost column hides itself even if the server ever sent costs without prices',
    );
    expect(() => renderWithProviders(<Nothing />, { ability: costsOnly })).not.toThrow();
    expect(() => impossibleOnPurpose(buildAbility([]), '')).toThrow(/reason/);
    expect(() =>
      seedMySwitches({ see_costs: true }, undefined, { impossibleOnPurpose: 'a stale stored set from before the rule' }),
    ).not.toThrow();
  });
});
