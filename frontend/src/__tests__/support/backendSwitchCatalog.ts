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

const TOGGLES: CatalogToggle[] = (() => {
  const source = readFileSync(
    join(__dirname, '../../../../backend/src/lib/permissions/switches/catalog.ts'),
    'utf8',
  );
  const out: CatalogToggle[] = [];
  for (const block of source.split(/\n {2}entry\(\{/).slice(1)) {
    const key = /key: '([a-z_0-9]+)'/.exec(block)?.[1];
    const label = /label: '((?:[^'\\]|\\.)*)'/.exec(block)?.[1];
    const args = /presets: presets\(([^)]*)\)/.exec(block)?.[1];
    if (!key || !label || !args) continue;
    const values = args.split(',').map((v) => v.trim());
    if (values.some((v) => v !== 'true' && v !== 'false')) continue;
    const grantsText = /grants: \[([\s\S]*?)\],\n\s+(?:serverChecks|pending|presets)/.exec(block)?.[1] ?? '';
    const grants = [...grantsText.matchAll(/action: '(\w+)', subject: '(\w+)'/g)].map((m) => ({
      action: m[1]!,
      subject: m[2]!,
    }));
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
  const rules: AbilityRule[] = [];
  for (const label of labels) {
    for (const g of catalogToggle(label).grants) rules.push({ action: g.action, subject: g.subject } as AbilityRule);
  }
  return buildAbility(rules);
}

/** The labels of the switches a built-in role's preset turns on (the starting point of a custom role copied from it). */
export function presetSwitchLabels(role: PresetRole): string[] {
  return TOGGLES.filter((t) => t.presets[role]).map((t) => t.label);
}
