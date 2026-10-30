import type { SwitchSubject } from './switches/store';
import { resolveSwitches } from './switches/store';
import { activeSwitchHolders } from './switchHolders';

/**
 * M5 - SLOT ELIGIBILITY (Roles & Permissions, PRD 3).
 *
 * The people slots on a lead or a job, and who may hold one. A slot is one of:
 *   - `owner`:      a lead's Owner or a job's Sold By;
 *   - `dispatcher`: a lead's or a job's Dispatcher;
 *   - `crew`:       a visit's crew or a walkthrough's crew.
 *
 * A user may hold a slot when they are active and their resolved switch for it is on. The switch value
 * is the person's own (PRD 1's per-user store, with its fallback to the role they are based on); the
 * built-in Admin box holds every switch. NOTHING HERE READS A ROLE NAME OR A BASE ROLE, which is the
 * point of the module: a custom role or a per-person value decides, and a name check would agree with
 * the presets and be wrong for every company that changed anything.
 *
 * Three questions, one module, so a door that places a person cannot forget to ask:
 *   - `mayHoldSlot`     may this user hold this slot?
 *   - `eligibleUserIds` which users of a company may hold it? (the roster's filter)
 *   - `whyNotSlot`      the plain sentence for a refusal.
 *
 * It only answers. A person who already holds a slot keeps it when their switch is turned off or they
 * are deactivated, so the callers that write a slot ask about newly named people only, and the pickers
 * show the current holder from the record.
 */

export type Slot = 'owner' | 'dispatcher' | 'crew';

export const SLOTS = ['owner', 'dispatcher', 'crew'] as const satisfies readonly Slot[];

export function isSlot(value: unknown): value is Slot {
  return typeof value === 'string' && (SLOTS as readonly string[]).includes(value);
}

/** The switch each slot reads. A total record, so a new slot cannot be added without deciding its switch. */
const SLOT_SWITCH: Readonly<Record<Slot, string>> = {
  owner: 'can_own_leads',
  dispatcher: 'can_be_dispatcher',
  crew: 'can_be_on_crew',
};

/** What a refusal says when the person's switch for the slot is off. */
const SLOT_REFUSAL: Readonly<Record<Slot, string>> = {
  owner: "This person can't own leads or be Sold By.",
  dispatcher: "This person can't be a dispatcher.",
  crew: "This person can't be on a crew.",
};

const INACTIVE_REFUSAL = 'This person is inactive.';

/** The slice of a stored person M5 reads; a row selected with `custom_role` satisfies it. */
export interface SlotCandidate extends SwitchSubject {
  is_active: boolean;
}

export async function mayHoldSlot(user: SlotCandidate, slot: Slot): Promise<boolean> {
  return (await whyNotSlot(user, slot)) === null;
}

/** `null` when the user may hold the slot, otherwise the plain reason they may not. */
export async function whyNotSlot(user: SlotCandidate, slot: Slot): Promise<string | null> {
  if (!user.is_active) return INACTIVE_REFUSAL;
  const values = await resolveSwitches(user);
  return values[SLOT_SWITCH[slot]] === true ? null : SLOT_REFUSAL[slot];
}

/**
 * The ids of the company's active users who may hold the slot. The roster applies it as its filter,
 * so the list a picker offers and the answer a write gets come from the same switch values.
 */
export async function eligibleUserIds(organizationId: string, slot: Slot): Promise<string[]> {
  return activeSwitchHolders(organizationId, SLOT_SWITCH[slot]);
}
