import type { AppAbility } from '@/lib/ability';

import { seedMySwitches } from '../helpers';
import { abilityWithSwitches, catalogToggle, labelsWithRequirements } from './backendSwitchCatalog';

/** The switches behind the new-estimate dialog's three ways out (Roles & Permissions S02.26), by the label a person sees. */
export const NEW_ESTIMATE_ENTRY_SWITCHES = ['Create customers', 'View customers', 'Create leads', 'Standalone estimates'];

/**
 * A person who holds every way out of the new-estimate dialog, for a suite whose subject is something else (where the
 * buttons lead, what the lead list holds). Returns the person's compiled rules and the answer their own-switches request
 * must give; the answer is also cached on the device so the first paint already has it.
 */
export function everyNewEstimateEntry(): { ability: AppAbility; meAnswer: { admin_box: boolean; values: Record<string, boolean>; rules: never[] } } {
  // With the switches those ways out need (Edit customers, View and Edit leads, Create estimates and what it needs), so the
  // person is one the catalog allows.
  const labels = labelsWithRequirements(...NEW_ESTIMATE_ENTRY_SWITCHES);
  const values = Object.fromEntries(labels.map((label) => [catalogToggle(label).key, true]));
  seedMySwitches(values);
  return { ability: abilityWithSwitches(...labels), meAnswer: { admin_box: false, values, rules: [] } };
}
