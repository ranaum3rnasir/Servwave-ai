import type { Prisma } from '@prisma/client';
import { prisma } from '../prisma';
import { mayHoldSlot, type SlotCandidate } from './slotEligibility';
import { resolveSwitches } from './switches/store';

/**
 * CONVERSION PEOPLE (Roles & Permissions, PRD 3, slice S03.13).
 *
 * When a lead is converted to a job (one estimate or several), the job's people are copies taken at that
 * moment, never links:
 *   - Sold By is the lead's Owner when that person may still hold the owner slot. When the Owner can't be
 *     carried over, a converter who holds Assign people to jobs leaves it empty to choose on the Team card;
 *     a converter without it is the Sold By when they may be; otherwise it stays empty. A lead with no Owner
 *     gives an empty Sold By (nobody sold it, so the converter is not credited).
 *   - Dispatcher is the lead's Dispatcher when that person may still hold the dispatcher slot; otherwise,
 *     including a lead with no Dispatcher, the converter when they may be a dispatcher; otherwise empty.
 *   - Crew is none: the walkthrough crew is neither copied nor pre-filled.
 *
 * "May hold" is slot eligibility (M5): active, and the person's own switch on. Nothing here reads a role name.
 * `source` says where the value came from, for the job's history:
 *   - `lead`:       copied from the lead;
 *   - `converter`:  set to the person converting;
 *   - `left_empty`: Sold By left empty to choose (only when the Owner couldn't be carried over).
 * A slot that was simply never set (no Owner, nobody to fall back to) has no source and writes no history.
 */

export type ConversionSource = 'lead' | 'converter' | 'left_empty';

/** The slice of a person the conversion names on the job's history. */
export interface ConversionPerson extends SlotCandidate {
  first_name: string;
  last_name: string;
}

export interface ConversionPick {
  /** Who goes in the slot, or null when it stays empty. */
  person: ConversionPerson | null;
  /** Why, or null when there is nothing to record. */
  source: ConversionSource | null;
}

export interface ConversionPeople {
  soldBy: ConversionPick;
  dispatcher: ConversionPick;
}

/** The stored-person fields slot eligibility and the history need; a person selected with this satisfies `ConversionPerson`. */
const PERSON_SELECT = {
  id: true,
  organization_id: true,
  role: true,
  based_on_role_key: true,
  custom_role_id: true,
  is_admin: true,
  custom_role: { select: { key: true } },
  is_active: true,
  first_name: true,
  last_name: true,
} as const;

/**
 * Decide the job's Sold By and Dispatcher for a conversion. `organizationId` scopes every read, and the lead
 * is named by its owner and dispatcher ids (null when the slot is empty on the lead).
 */
export async function resolveConversionPeople(args: {
  organizationId: string;
  converterId: string;
  leadOwnerId: string | null;
  leadDispatcherId: string | null;
}): Promise<ConversionPeople> {
  const { organizationId, converterId, leadOwnerId, leadDispatcherId } = args;
  const ids = [converterId, leadOwnerId, leadDispatcherId].filter((id): id is string => id !== null);
  const people = await prisma.user.findMany({ where: { id: { in: ids }, organization_id: organizationId }, select: PERSON_SELECT });
  const byId = new Map(people.map((p) => [p.id, p]));
  const converter = byId.get(converterId) ?? null;
  const owner = leadOwnerId ? byId.get(leadOwnerId) ?? null : null;
  const leadDispatcher = leadDispatcherId ? byId.get(leadDispatcherId) ?? null : null;

  const converterMay = async (slot: 'owner' | 'dispatcher') => (converter !== null && (await mayHoldSlot(converter, slot)) ? converter : null);

  // Sold By.
  let soldBy: ConversionPick = { person: null, source: null };
  if (owner && (await mayHoldSlot(owner, 'owner'))) {
    soldBy = { person: owner, source: 'lead' };
  } else if (leadOwnerId !== null) {
    // The Owner can't be carried over (inactive, switched off, or gone from the company).
    const holdsAssign = converter !== null && (await resolveSwitches(converter)).assign_people_to_jobs === true;
    if (holdsAssign) {
      soldBy = { person: null, source: 'left_empty' };
    } else {
      const fallback = await converterMay('owner');
      soldBy = fallback ? { person: fallback, source: 'converter' } : { person: null, source: null };
    }
  }

  // Dispatcher.
  let dispatcher: ConversionPick;
  if (leadDispatcher && (await mayHoldSlot(leadDispatcher, 'dispatcher'))) {
    dispatcher = { person: leadDispatcher, source: 'lead' };
  } else {
    const fallback = await converterMay('dispatcher');
    dispatcher = fallback ? { person: fallback, source: 'converter' } : { person: null, source: null };
  }

  return { soldBy, dispatcher };
}

/** The sentence on the new job's history for one slot, in the words the Team card's own changes use. */
export function historySentence(slot: 'sold_by' | 'dispatcher', pick: ConversionPick, jobNumber: string): string {
  const label = slot === 'sold_by' ? 'Sold By' : 'Dispatcher';
  if (pick.source === 'left_empty') {
    return `Sold By left empty to choose on job ${jobNumber} (the lead's Owner can't be carried over)`;
  }
  const name = `${pick.person!.first_name} ${pick.person!.last_name}`;
  const how = pick.source === 'lead' ? 'copied from the lead' : 'set to the person converting';
  return `${name} set as ${label} on job ${jobNumber} (${how})`;
}

/**
 * Write each recorded slot as an event on the new job, in the transaction that creates it. The event types are
 * the ones the Team card's own changes use; `source` (and the lead) in the metadata says it was a conversion.
 */
export async function recordConversionPeople(
  tx: Prisma.TransactionClient,
  args: { organizationId: string; jobId: string; jobNumber: string; leadId: string; convertedBy: string; people: ConversionPeople },
): Promise<void> {
  const { organizationId, jobId, jobNumber, leadId, convertedBy, people } = args;
  const slots = [
    { slot: 'sold_by' as const, eventType: 'SOLD_BY_CHANGED', pick: people.soldBy },
    { slot: 'dispatcher' as const, eventType: 'DISPATCHER_CHANGED', pick: people.dispatcher },
  ];
  for (const { slot, eventType, pick } of slots) {
    if (pick.source === null) continue;
    await tx.timelineEvent.create({
      data: {
        organization_id: organizationId,
        entity_type: 'JOB',
        entity_id: jobId,
        event_type: eventType,
        description: historySentence(slot, pick, jobNumber),
        metadata: { from: null, to: pick.person?.id ?? null, source: pick.source, lead_id: leadId },
        created_by: convertedBy,
      },
    });
  }
}
