/**
 * The per-person SETTINGS of the switch catalog (Roles & Permissions P1, A1).
 *
 * A switch exists for a verb on a module, a money class, a sensitive money action, or a scope. A thing that only changes
 * what a person is OFFERED, not what they may do, is a setting on the person: a slot such as "Can be on a crew", an alert
 * such as "Alert me about every new lead", which inventory view opens, a van limit, which Phone tabs show. Settings keep
 * the storage and the behaviour they always had (a role holds a default, a person may hold their own value, the server
 * reads them as before), but they are NOT drawn on the Permissions pages. The person's profile edits them.
 *
 * This is the one list. The layout leaves these keys out of the Roles page and the person's Permissions page and hands
 * them to the profile instead; a test holds every other catalog key to the four kinds above.
 */
export const PERSON_SETTING_KEYS = [
  // Who the person can be put on a record as.
  'can_own_leads',
  'can_be_dispatcher',
  'can_be_on_crew',
  // Which new records alert them.
  'alert_every_lead',
  'alert_every_job',
  'alert_every_estimate',
  'alert_every_invoice',
  // Which stock view opens, and whether their stock is limited to their own van.
  'inventory_view',
  'restrict_stock_to_own_van',
  // Which Phone tabs they are offered.
  'phone_numbers_tab',
  'call_flows_tab',
  'call_masking_tab',
  'call_groups_tab',
  'training_tab',
  'blocked_callers_tab',
] as const;

const SETTING_SET: ReadonlySet<string> = new Set(PERSON_SETTING_KEYS);

/** Is this catalog key a per-person setting rather than a switch? */
export function isPersonSetting(key: string): boolean {
  return SETTING_SET.has(key);
}
