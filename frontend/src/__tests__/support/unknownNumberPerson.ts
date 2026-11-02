import { buildAbility, type AbilityRule, type AppAbility } from '@/lib/ability';
import { seedMySwitches } from '@/__tests__/helpers';

import { catalogToggle, impossibleOnPurpose, labelsWithRequirements, presetSwitchLabels, type PresetRole } from './backendSwitchCatalog';

/**
 * Roles & Permissions S02.27 - the people the Texts inbox and the dialer's unknown-number panels are tried against.
 * Create lead needs Create leads + View leads; Create job needs Create jobs + View jobs. A person is
 * described by the switches they hold, by the label a person sees, never by a role name; the Create half reaches the
 * screen as a compiled rule, the View half as the person's own switch answer (seeded as the last-known answer, and compiled
 * into its read as well).
 */
export const LEAD_PAIR = ['Create leads', 'View leads'] as const;
export const JOB_PAIR = ['Create jobs', 'View jobs'] as const;

const SHOW_LABELS = ['View leads', 'View jobs', 'View customers'];
const CREATE_LABELS = ['Create leads', 'Create jobs', 'Create customers'];

export interface Person {
  ability: AppAbility;
  /** The person's own switch answer, as the server gives it. */
  values: Record<string, boolean>;
  /** Stores that answer as the last-known one, so a screen draws from it on its first paint. */
  seed: () => void;
}

/**
 * The ability and switch answer of a person whose Create and Show switches are exactly `on`. Any other switch those need
 * (Edit leads for Create leads) is held too, so the person is one the catalog allows. A case about a set the catalog
 * refuses (Create leads without View leads) passes `impossibleOnPurpose` with its reason, and gets exactly `on`.
 */
export function personHolding(
  on: readonly string[],
  /** Rules the screen under test needs for itself (the Communication section), whatever the switches say. */
  alsoCan: AbilityRule[] = [],
  options: { impossibleOnPurpose?: string } = {},
): Person {
  const held = new Set(on);
  const pairs = [...SHOW_LABELS, ...CREATE_LABELS];
  // The switches outside the Create/View pairs that the held ones need; the pairs themselves stay exactly as given.
  const needed = options.impossibleOnPurpose ? [] : labelsWithRequirements(...on).filter((l) => !pairs.includes(l));
  const grantsOf = (l: string) => catalogToggle(l).grants.map((g) => ({ action: g.action, subject: g.subject }) as AbilityRule);
  // A held View switch compiles into its read too, as it does for a real person (the screen reads the View half from the
  // switch answer either way).
  const fromSwitches = [...pairs.filter((l) => held.has(l)), ...needed].flatMap(grantsOf);
  const values = Object.fromEntries([
    ...pairs.map((l) => [catalogToggle(l).key, held.has(l)] as const),
    ...needed.map((l) => [catalogToggle(l).key, true] as const),
  ]);
  const ability = buildAbility([...alsoCan, ...fromSwitches]);
  return {
    ability: options.impossibleOnPurpose ? impossibleOnPurpose(ability, options.impossibleOnPurpose) : ability,
    values,
    seed: () => seedMySwitches(values, undefined, { impossibleOnPurpose: options.impossibleOnPurpose }),
  };
}

/** A person holding what a built-in role's preset holds, as a custom role copied from it. */
export function personCopiedFrom(role: PresetRole, alsoCan: AbilityRule[] = []): Person {
  const labels = new Set(presetSwitchLabels(role));
  return personHolding([...SHOW_LABELS, ...CREATE_LABELS].filter((l) => labels.has(l)), alsoCan);
}
