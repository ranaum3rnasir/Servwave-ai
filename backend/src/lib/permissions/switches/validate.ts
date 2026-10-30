import { ALL_ACCEPTED_METHODS, SWITCH_CATALOG, findSwitch, storableChoices, type SwitchValue } from './catalog';

/**
 * The catalog validator (Roles & Permissions M1).
 *
 * A saved set of switch values breaks a rule when:
 *  - it names a switch the catalog does not hold, or holds a value of the wrong kind for a switch
 *    (a choice that is not one of the switch's choices, an on/off switch given text);
 *  - a switch is on while a switch it Requires is off. The row rule is the same thing stated for a
 *    whole row: View off leaves Show, Create, Edit, Delete and Export on nothing to stand on, so each
 *    of them Requires the row's View. Every other switch needs only what its own `requires` says, so
 *    a switch that needs nothing is valid with its row's View off.
 *
 * A kept value (a choice that is stored and honoured but never offered, "Through own leads") is accepted
 * only where the write already holds it. A caller that is storing a change passes what the target holds now
 * in `held`; a kept value that differs from it is refused. A write that copies a whole set from a holder
 * passes no `held`, and the value is accepted wherever the switch allows it.
 *
 * Every built-in preset must pass it. The server refuses a write that would store a set that does not.
 */
export interface SwitchSetViolation {
  switchKey: string;
  /** A plain-words reason a screen or an error message can show as it is. */
  message: string;
  /** The switches that must be on for this one to be on (empty for a bad value). */
  needs: string[];
}

export function validateSwitchSet(
  values: Record<string, SwitchValue>,
  options: { held?: Record<string, SwitchValue> } = {},
): SwitchSetViolation[] {
  const violations: SwitchSetViolation[] = [];
  for (const key of Object.keys(values)) {
    if (!findSwitch(key)) violations.push({ switchKey: key, message: `Unknown permission switch: ${key}`, needs: [] });
  }
  const isOn = (key: string) => values[key] === true;
  const label = (key: string) => findSwitch(key)?.label ?? key;

  for (const s of SWITCH_CATALOG) {
    const value = values[s.key];
    if (value === undefined) continue;

    if (s.kind === 'toggle') {
      if (typeof value !== 'boolean') {
        violations.push({ switchKey: s.key, message: `${s.label} is on or off.`, needs: [] });
        continue;
      }
    } else if (s.kind === 'list') {
      // The marker, or a fixed subset of the switch's options with none listed twice.
      const options = s.listOptions ?? [];
      const isSubset = Array.isArray(value) && value.every((m) => typeof m === 'string' && options.includes(m)) && new Set(value).size === value.length;
      if (value !== ALL_ACCEPTED_METHODS && !isSubset) {
        violations.push({ switchKey: s.key, message: `${s.label} cannot be set to that value.`, needs: [] });
        continue;
      }
    } else if (typeof value !== 'string' || !storableChoices(s).includes(value)) {
      violations.push({ switchKey: s.key, message: `${s.label} cannot be set to that value.`, needs: [] });
      continue;
    } else if (options.held && s.keptValues?.includes(value) && options.held[s.key] !== value) {
      const name = s.keptValueHelp?.[value]?.label ?? value;
      violations.push({ switchKey: s.key, message: `${s.label} cannot be set to ${name}: it is only kept where it is already held.`, needs: [] });
      continue;
    }

    if (value !== true) continue;
    const missing = s.requires.filter((needed) => !isOn(needed));
    if (missing.length) {
      violations.push({
        switchKey: s.key,
        message: `${s.label} needs ${missing.map(label).join(' and ')} on.`,
        needs: missing,
      });
    }
    if (s.requiresAny && !s.requiresAny.some(isOn)) {
      violations.push({
        switchKey: s.key,
        message: `${s.label} needs at least one of ${s.requiresAny.map(label).join(' or ')} on.`,
        needs: s.requiresAny,
      });
    }
  }
  return violations;
}
