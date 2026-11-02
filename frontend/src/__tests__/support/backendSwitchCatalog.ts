import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { buildAbility, type AbilityRule, type AppAbility } from '@/lib/ability';

/**
 * The backend switch catalog, read from its own source file (the module is not importable into the browser
 * build; the schedule board's switch test reads it the same way). Tests that need a switch's key or a built-in
 * role's preset value look it up here by the label a person sees, so no second list of switches exists.
 */
export type PresetRole = 'ADMIN' | 'SALES' | 'DISPATCHER' | 'TECHNICIAN';
const ROLE_ORDER: PresetRole[] = ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'];

export interface CatalogToggle {
  key: string;
  label: string;
  /** The ability-layer pairs the switch grants (class level: the scope conditions are the server's). */
  grants: Array<{ action: string; subject: string }>;
  presets: Record<PresetRole, boolean>;
}

/** Every catalog entry's needs, any kind: what the harness checks a test's grants against. */
interface CatalogNeeds {
  key: string;
  label: string;
  /** Keys of the switches that must be on for this one to be on. */
  requires: string[];
  /** Keys of which at least one must be on. */
  requiresAny: string[];
  grants: Array<{ action: string; subject: string }>;
}

const CATALOG_SOURCE = readFileSync(
  join(__dirname, '../../../../backend/src/lib/permissions/switches/catalog.ts'),
  'utf8',
);
const ENTRY_BLOCKS = CATALOG_SOURCE.split(/\n {2}entry\(\{/).slice(1);

const keyList = (text: string | undefined): string[] => [...(text ?? '').matchAll(/'([a-z_0-9]+)'/g)].map((m) => m[1]!);
const grantsIn = (block: string) =>
  [...(/grants: \[([\s\S]*?)\],\n\s+(?:serverChecks|pending|presets)/.exec(block)?.[1] ?? '').matchAll(
    /action: '(\w+)', subject: '(\w+)'/g,
  )].map((m) => ({ action: m[1]!, subject: m[2]! }));

const NEEDS: CatalogNeeds[] = ENTRY_BLOCKS.flatMap((block) => {
  const key = /key: '([a-z_0-9]+)'/.exec(block)?.[1];
  const label = /label: '((?:[^'\\]|\\.)*)'/.exec(block)?.[1];
  if (!key || !label) return [];
  return [{
    key,
    label: label.replace(/\\'/g, "'"),
    requires: keyList(/\brequires: \[([^\]]*)\]/.exec(block)?.[1]),
    requiresAny: keyList(/\brequiresAny: \[([^\]]*)\]/.exec(block)?.[1]),
    grants: grantsIn(block),
  }];
});
const NEEDS_BY_KEY = new Map(NEEDS.map((n) => [n.key, n]));
const named = (key: string) => {
  const n = NEEDS_BY_KEY.get(key);
  return n ? `${n.label} (${key})` : key;
};

const TOGGLES: CatalogToggle[] = (() => {
  const out: CatalogToggle[] = [];
  for (const block of ENTRY_BLOCKS) {
    const key = /key: '([a-z_0-9]+)'/.exec(block)?.[1];
    const label = /label: '((?:[^'\\]|\\.)*)'/.exec(block)?.[1];
    const args = /presets: presets\(([^)]*)\)/.exec(block)?.[1];
    if (!key || !label || !args) continue;
    const values = args.split(',').map((v) => v.trim());
    if (values.some((v) => v !== 'true' && v !== 'false')) continue;
    const grants = grantsIn(block);
    out.push({
      key,
      label: label.replace(/\\'/g, "'"),
      grants,
      presets: Object.fromEntries(ROLE_ORDER.map((r, i) => [r, values[i] === 'true'])) as Record<PresetRole, boolean>,
    });
  }
  return out;
})();

/** The toggle switch a person sees under this label. Throws when the catalog has none, so a rename fails the test. */
export function catalogToggle(label: string): CatalogToggle {
  const found = TOGGLES.find((t) => t.label === label);
  if (!found) throw new Error(`No toggle switch labelled "${label}" in the backend catalog`);
  return found;
}

/**
 * The ability a person holds with exactly these switches on, named by the label a person sees: the grants the
 * catalog gives each switch, nothing else. A switch the person lacks contributes no rule.
 */
export function abilityWithSwitches(...labels: string[]): AppAbility {
  const keys = labels.map((label) => catalogToggle(label).key);
  assertPossibleSwitchSet(Object.fromEntries(keys.map((k) => [k, true])));
  const rules: AbilityRule[] = [];
  for (const label of labels) {
    for (const g of catalogToggle(label).grants) rules.push({ action: g.action, subject: g.subject } as AbilityRule);
  }
  return buildAbility(rules);
}

// ─── Impossible combinations ───────────────────────────────
//
// The catalog's `requires` / `requiresAny` say which switches a switch needs on. The Roles screen and the server refuse
// a set that breaks them, so no real person holds one. A test that grants one tests a screen nobody can see. The
// harnesses (`renderWithProviders`, `abilityWithSwitches`, `seedMySwitches`) check every person against the catalog
// and throw, naming both switches. A test that needs the impossible state on purpose marks it with a reason.

const ON_PURPOSE = new WeakMap<AppAbility, string>();

/**
 * Mark an ability as deliberately impossible (a switch on without one it requires), so the harness lets it through.
 * Only for a test whose subject IS that state, such as a screen's own guard against a malformed answer. The reason is
 * required and kept with the ability, so the opt-out is never silent.
 */
export function impossibleOnPurpose(ability: AppAbility, reason: string): AppAbility {
  if (!reason.trim()) throw new Error('impossibleOnPurpose needs a reason: say why this test needs a person the app cannot produce.');
  ON_PURPOSE.set(ability, reason);
  return ability;
}

function refuse(problems: string[], where: string): never {
  throw new Error(
    `${where}: this test grants a switch combination no person can hold, because the switch catalog refuses it:\n` +
      problems.map((p) => `  - ${p}`).join('\n') +
      '\nAdd the required switch to the test\'s grants. If the test is about this impossible state on purpose, ' +
      'wrap the ability in impossibleOnPurpose(ability, reason) (or pass { impossibleOnPurpose: reason } to seedMySwitches).',
  );
}

/**
 * These switches' labels plus every switch they need, followed down the chain (Create estimates -> Edit estimates ->
 * View estimates, See prices), so a fixture that names only the switches it is about still describes a possible person.
 * A Requires-any is met by its first switch.
 */
export function labelsWithRequirements(...labels: string[]): string[] {
  const keys: string[] = [];
  const add = (key: string) => {
    if (keys.includes(key)) return;
    keys.push(key);
    const n = NEEDS_BY_KEY.get(key);
    n?.requires.forEach(add);
    if (n?.requiresAny.length && !n.requiresAny.some((k) => keys.includes(k))) add(n.requiresAny[0]!);
  };
  labels.forEach((label) => add(catalogToggle(label).key));
  return keys.map((k) => NEEDS_BY_KEY.get(k)!.label);
}

/** The problems with a set of switch values (key -> value): each switch on while a switch it requires is not on. */
export function impossibleSwitchSet(values: Record<string, unknown>): string[] {
  const on = (key: string) => values[key] === true;
  const problems: string[] = [];
  for (const [key, value] of Object.entries(values)) {
    if (value !== true) continue;
    const needs = NEEDS_BY_KEY.get(key);
    if (!needs) continue;
    const missing = needs.requires.filter((r) => !on(r));
    if (missing.length) problems.push(`${named(key)} needs ${missing.map(named).join(' and ')} on`);
    if (needs.requiresAny.length && !needs.requiresAny.some(on)) {
      problems.push(`${named(key)} needs one of ${needs.requiresAny.map(named).join(' or ')} on`);
    }
  }
  return problems;
}

/** Throws when the set holds a switch on without one it requires. */
export function assertPossibleSwitchSet(values: Record<string, unknown>, where = 'Switch set'): void {
  const problems = impossibleSwitchSet(values);
  if (problems.length) refuse(problems, where);
}

type RawRule = { action: string | string[]; subject?: string | string[]; inverted?: boolean };
const asList = (v: string | string[] | undefined): string[] => (v === undefined ? [] : Array.isArray(v) ? v : [v]);

/**
 * The problems with an ability's rules, read back to the switches that grant them. Each (action, subject) pair belongs to
 * at most one switch, so any one grant of a switch present shows that switch is on: a requirement counts as on when at
 * least one of its grants is present. A pair that no switch grants (an older grant, a plan gate) is left alone, and so is
 * a requirement that grants nothing an ability can show.
 */
export function impossibleAbility(ability: AppAbility): string[] {
  const rules = (ability.rules as RawRule[]).filter((r) => !r.inverted);
  const has = (action: string, subject: string) =>
    rules.some((r) => {
      const actions = asList(r.action);
      const subjects = asList(r.subject);
      return (actions.includes(action) || actions.includes('manage')) && (subjects.includes(subject) || subjects.includes('all'));
    });
  if (has('manage', 'all')) return [];
  const isOn = (key: string) => {
    const n = NEEDS_BY_KEY.get(key);
    return !n || n.grants.length === 0 || n.grants.some((g) => has(g.action, g.subject));
  };
  const granted = new Set<string>();
  for (const r of rules) {
    for (const a of asList(r.action)) {
      for (const s of asList(r.subject)) {
        for (const n of NEEDS) if (n.grants.some((g) => g.action === a && g.subject === s)) granted.add(n.key);
      }
    }
  }
  const problems: string[] = [];
  for (const key of granted) {
    const n = NEEDS_BY_KEY.get(key)!;
    const missing = n.requires.filter((r) => !isOn(r));
    if (missing.length) problems.push(`${named(key)} needs ${missing.map(named).join(' and ')} on`);
    if (n.requiresAny.length && !n.requiresAny.some(isOn)) {
      problems.push(`${named(key)} needs one of ${n.requiresAny.map(named).join(' or ')} on`);
    }
  }
  return problems;
}

/** Throws when the ability grants a switch without one it requires, unless it was marked impossibleOnPurpose. */
export function assertPossibleAbility(ability: AppAbility, where = 'Ability'): void {
  if (ON_PURPOSE.has(ability)) return;
  const problems = impossibleAbility(ability);
  if (problems.length) refuse(problems, where);
}

/** The labels of the switches a built-in role's preset turns on (the starting point of a custom role copied from it). */
export function presetSwitchLabels(role: PresetRole): string[] {
  return TOGGLES.filter((t) => t.presets[role]).map((t) => t.label);
}
