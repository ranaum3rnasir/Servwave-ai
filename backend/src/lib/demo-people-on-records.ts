/**
 * Who the demo-org seeder puts in a lead's and a job's people slots (Roles & Permissions, PRD 3).
 *
 * The slots are a lead's Owner and Dispatcher and a job's Sold By and Dispatcher. A person may hold one
 * only when their switch for it is on, so the seeder draws from people whose built-in role holds that
 * switch out of the box (read from the switch catalog, never a copy of it) and the demo never shows
 * someone in a slot the product would refuse.
 *
 * Pure, so the seeder's choices are testable without a database (seed-demo-org.ts is a script).
 */
import { SWITCH_CATALOG, type BuiltInRole } from './permissions/switches/catalog';

export type DemoSlot = 'owner' | 'dispatcher';

/** The switch each slot reads; the same two the slot eligibility module asks about. */
const SLOT_SWITCH: Readonly<Record<DemoSlot, string>> = {
  owner: 'can_own_leads',
  dispatcher: 'can_be_dispatcher',
};

export interface DemoPerson {
  id: string;
  role: string;
}

/** The people, in the order given, whose built-in role holds the slot's switch. */
export function demoPeopleForSlot<T extends DemoPerson>(people: readonly T[], slot: DemoSlot): T[] {
  const entry = SWITCH_CATALOG.find((e) => e.key === SLOT_SWITCH[slot]);
  if (!entry) throw new Error(`The switch catalog has no ${SLOT_SWITCH[slot]} switch.`);
  return people.filter((p) => entry.presets[p.role as BuiltInRole] === true);
}

/**
 * Whose Dispatcher a demo lead carries. The Dispatcher is who books a lead's walkthrough, so a lead with a
 * walkthrough booked or done (and the estimate that follows it) always has one; a won lead has one two times
 * in three, so the demo also shows "No dispatcher" on a lead that moved on; a lead nobody has had a reason to
 * book yet, or that was lost, has none. `ordinal` is the lead's position in the seed, which rotates the pool.
 */
export function demoLeadDispatcherId(status: string, ordinal: number, pool: readonly string[]): string | null {
  if (pool.length === 0) return null;
  const booked = status === 'WALKTHROUGH_SCHEDULED' || status === 'WALKTHROUGH_COMPLETED' || status === 'ESTIMATED';
  const movedOn = status === 'WON' && ordinal % 3 !== 0;
  return booked || movedOn ? pool[ordinal % pool.length]! : null;
}
