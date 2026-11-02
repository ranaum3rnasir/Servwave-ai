/**
 * The test harness refuses a person the product cannot produce: a switch on while a switch it Requires is off.
 *
 * The switch catalog's `requires` / `requiresAny` are enforced by every writer (validateSwitchSet), so no stored role or
 * person holds such a set. A suite that mocks one ("See costs" on, "See prices" off) proves a behaviour nobody can reach.
 * `mockRoleSwitches` lays its values over the built-in preset of the role `mockAuthAs` signed in, checks the result
 * against the catalog and throws, naming both switches. `mockRoleGrantsWithout` takes a switch's dependants away with
 * it, as the Roles screen does. A test whose subject IS the impossible set says so: `{ impossibleOnPurpose: reason }`.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma';
import { mockAuthAs, mockRoleSwitches, mockRoleGrantsWithout } from './helpers';
import { presetSwitchSet } from '../lib/permissions/switches/catalog';
import { withDependantsOff } from './support/switchDependants';

const storedRoleValues = async () =>
  Object.fromEntries(
    ((await (prisma.permissionRoleSwitch.findMany as unknown as () => Promise<{ switch_key: string; value: unknown }[]>)()) ?? []).map(
      (r) => [r.switch_key, r.value],
    ),
  );

describe('mockRoleSwitches refuses an impossible switch set', () => {
  beforeEach(() => {
    // Sales starts with See prices and See costs both on (the catalog preset).
    expect(presetSwitchSet('SALES').see_costs).toBe(true);
    mockAuthAs('sales');
  });

  it('turning See prices off while the preset keeps See costs on throws, naming both switches', () => {
    expect(() => mockRoleSwitches({ see_prices: false })).toThrow(/See costs \(see_costs\) needs See prices \(see_prices\)/);
  });

  it('See prices off with every switch that needs it off is a set a person can hold', () => {
    const off = withDependantsOff(['see_prices']);
    expect(off.see_costs).toBe(false);
    expect(() => mockRoleSwitches(off)).not.toThrow();
  });

  it('a switch on whose requirement the preset already holds is fine', () => {
    mockAuthAs('technician');
    expect(presetSwitchSet('TECHNICIAN').see_prices).toBe(true);
    expect(() => mockRoleSwitches({ see_costs: true })).not.toThrow();
  });

  it('a switch turned on with its requirement turned off in the same call throws', () => {
    mockAuthAs('technician');
    expect(() => mockRoleSwitches({ see_costs: true, see_prices: false })).toThrow(/See costs.*See prices/);
  });

  it('the opt-out is named and needs a reason', async () => {
    expect(() => mockRoleSwitches({ see_prices: false }, { impossibleOnPurpose: 'proves the server refuses costs without prices' })).not.toThrow();
    expect(await storedRoleValues()).toEqual({ see_prices: false });
    expect(() => mockRoleSwitches({ see_prices: false }, { impossibleOnPurpose: ' ' })).toThrow(/reason/);
  });
});

describe('mockRoleGrantsWithout takes the dependants of a switch away with it', () => {
  it('taking `read Prices` from Sales turns See prices off and every switch that needs it', async () => {
    mockAuthAs('sales');
    expect(() => mockRoleGrantsWithout('SALES', ['read', 'Prices'])).not.toThrow();
    const stored = await storedRoleValues();
    expect(stored.see_prices).toBe(false);
    expect(stored.see_costs).toBe(false);
  });
});
