import { SCOPE_SWITCH_KEY, type SwitchEntry } from './catalog';
import { MODULE_SCOPE_KEY } from './moduleScopes';
import { isPersonSetting } from './settings';

/**
 * What a catalog key IS (Roles & Permissions P1, A1): a switch exists for a verb on a module, for a money class, for a
 * sensitive money action, or for a scope; anything that only changes what a person is OFFERED is a setting on the person
 * (`settings.ts`). Nothing else is in the catalog. The test `permission-switch-classes.test.ts` holds every key to exactly
 * one of these kinds and keeps a display, a slot or an alert from slipping back in as a "verb".
 */
export type SwitchClass = 'scope' | 'money-class' | 'money-action' | 'setting' | 'verb';

/**
 * The sensitive money actions (P12): the ones that move money out or write it off, each its own switch and never implied by
 * the switch that records money in. Listed, because no naming rule tells them from other verbs.
 */
export const MONEY_ACTION_KEYS = [
  'refund_payments',
  'void_payments',
  'void_invoices',
  'apply_credits',
  'waive_deposits',
  'close_jobs_with_money_owed',
  'manage_payout_account',
] as const;

/**
 * A switch that refines the scope of a module without being a scope itself: "See the main line when I have no number"
 * widens what Communication scope Attached lists for a person with no linked number.
 */
export const SCOPE_REFINEMENT_KEYS = ['see_main_line_when_no_number'] as const;

/** The money classes live in the one Money row (P11): See prices, See costs and See company figures. */
const MONEY_CLASS_MODULE = 'Money';

const SCOPE_KEYS: ReadonlySet<string> = new Set<string>([
  ...Object.values(SCOPE_SWITCH_KEY),
  ...Object.values(MODULE_SCOPE_KEY),
  ...SCOPE_REFINEMENT_KEYS,
]);
const MONEY_ACTIONS: ReadonlySet<string> = new Set<string>(MONEY_ACTION_KEYS);

export function classOfSwitch(entry: Pick<SwitchEntry, 'key' | 'module'>): SwitchClass {
  if (isPersonSetting(entry.key)) return 'setting';
  if (SCOPE_KEYS.has(entry.key)) return 'scope';
  if (entry.module === MONEY_CLASS_MODULE) return 'money-class';
  if (MONEY_ACTIONS.has(entry.key)) return 'money-action';
  return 'verb';
}
