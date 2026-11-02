import { SWITCH_CATALOG, findSwitch, type SwitchValue } from '../../lib/permissions/switches/catalog';
import { validateSwitchSet } from '../../lib/permissions/switches/validate';

/**
 * The given switches off, and every switch that needs one of them off with it, so the set stays storable (a chain such as
 * Create requires Edit requires View, or a Requires-any whose every switch is off). A test that turns a root off without
 * this is refused by the catalog's own validator.
 */
export function withDependantsOff(off: string[]): Record<string, boolean> {
  const out: Record<string, boolean> = Object.fromEntries(off.map((k) => [k, false]));
  for (let grew = true; grew; ) {
    grew = false;
    for (const s of SWITCH_CATALOG) {
      const anyGone = !!s.requiresAny?.length && s.requiresAny.every((r) => out[r] === false);
      if (!(s.key in out) && (s.requires.some((r) => out[r] === false) || anyGone)) {
        out[s.key] = false;
        grew = true;
      }
    }
  }
  return out;
}

const named = (key: string) => `${findSwitch(key)?.label ?? key} (${key})`;

/**
 * Throws when a test fixture would hand a person a switch set no person can hold: a switch on while a switch it Requires
 * (or every switch of its Requires-any) is off. The rule is the catalog's own validator, the one every writer runs; only
 * its Requires findings are read here (a bad value is the writer's own concern). `values` is the person's whole set, the
 * preset with the test's values laid over it, so a root turned off with its dependants left on is caught too.
 *
 * A test whose subject IS such a set passes `impossibleOnPurpose` with its reason; an empty reason is refused, so the
 * opt-out is never silent.
 */
export function assertPossibleSwitchSet(
  values: Record<string, SwitchValue>,
  where: string,
  options: { impossibleOnPurpose?: string } = {},
): void {
  if (options.impossibleOnPurpose !== undefined) {
    if (!options.impossibleOnPurpose.trim()) {
      throw new Error(`${where}: impossibleOnPurpose needs a reason: say why this test needs a switch set the product refuses.`);
    }
    return;
  }
  const problems = validateSwitchSet(values)
    .filter((v) => v.needs.length > 0)
    .map((v) => {
      const s = findSwitch(v.switchKey)!;
      const any = s.requiresAny && v.needs === s.requiresAny;
      return any
        ? `${named(v.switchKey)} needs one of ${v.needs.map(named).join(' or ')} on`
        : `${named(v.switchKey)} needs ${v.needs.map(named).join(' and ')} on`;
    });
  if (!problems.length) return;
  throw new Error(
    `${where}: this test gives a person a switch combination no person can hold, because the switch catalog refuses it:\n` +
      problems.map((p) => `  - ${p}`).join('\n') +
      '\nAdd the required switch to the test\'s values (or turn the dependant off too). If the test is about this ' +
      'impossible set on purpose, pass { impossibleOnPurpose: reason }.',
  );
}
