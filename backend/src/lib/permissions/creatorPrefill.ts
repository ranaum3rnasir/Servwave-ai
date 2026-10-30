import type { Prisma, PrismaClient } from '@prisma/client';
import { resolveSwitches, type SwitchSubject } from './switches/store';

/**
 * THE CREATOR PRE-FILL RULE (Roles & Permissions, PRD 3, M3).
 *
 * Where a creator lands on the lead (or job) they make, worked out from their own switches and nothing else:
 *   - Can own leads / be Sold By on:                       Owner (Sold By on a job);
 *   - that off and Can be a dispatcher on:                 Dispatcher instead;
 *   - both off:                                            Owner (Sold By), so the creator always lands on it;
 *   - both on (the Admin preset):                          Owner (Sold By), never Dispatcher.
 * No role name or base role is read, so a role copied from the Dispatcher preset behaves exactly like it.
 *
 * The create form shows this result and the create route applies it for anyone who may not choose the people
 * themselves, so what the form shows is what is saved. It only answers: whether the person it names may hold
 * the slot is not asked (the "both off" case lands the creator on Owner on purpose).
 */

/** Where the creator is pre-filled: the Owner (Sold By) slot, or the Dispatcher slot. */
export type PrefillSlot = 'owner' | 'dispatcher';

export async function creatorPrefillSlot(creator: SwitchSubject): Promise<PrefillSlot> {
  const values = await resolveSwitches(creator);
  if (values.can_own_leads === true) return 'owner';
  return values.can_be_dispatcher === true ? 'dispatcher' : 'owner';
}

/**
 * Whether the creator's own "Can be on a crew" switch is on: the new-lead form offers "I'll do this walkthrough"
 * only to a person who can be put on one. Their own switch, never a role name.
 */
export async function creatorCanBeOnCrew(creator: SwitchSubject): Promise<boolean> {
  return (await resolveSwitches(creator)).can_be_on_crew === true;
}

/** The pre-fill as the two people fields hold it: the creator in one, nobody in the other. */
export interface CreatorPrefill {
  owner_id: string | null;
  dispatcher_id: string | null;
}

export async function creatorPrefill(creator: SwitchSubject): Promise<CreatorPrefill> {
  const slot = await creatorPrefillSlot(creator);
  return {
    owner_id: slot === 'owner' ? creator.id : null,
    dispatcher_id: slot === 'dispatcher' ? creator.id : null,
  };
}

/** Where a person on a new lead came from: the pre-fill kept (the creator), or picked by a holder of Assign people to leads. */
export type CreationSource = 'creator' | 'picked';

/**
 * Write the people a new lead was saved with onto its history, once it is created: one
 * "Owner" and one "Dispatcher" event for each slot that holds someone, marked "set to the creator at creation"
 * when the pre-fill was kept or "picked at creation" when a holder chose them. A slot left empty writes
 * nothing. The event types are the ones the lead page's own Owner and Dispatcher changes use.
 */
export async function recordLeadCreationPeople(
  db: Prisma.TransactionClient | PrismaClient,
  args: {
    organizationId: string;
    lead: {
      id: string;
      lead_number: string;
      commission_owner?: { first_name: string; last_name: string } | null;
      dispatcher?: { first_name: string; last_name: string } | null;
    };
    createdBy: string;
    people: {
      owner: { id: string; source: CreationSource } | null;
      dispatcher: { id: string; source: CreationSource } | null;
    };
  },
): Promise<void> {
  const { organizationId, lead, createdBy, people } = args;
  const slots = [
    { label: 'Owner', eventType: 'OWNER_CHANGED', pick: people.owner, person: lead.commission_owner },
    { label: 'Dispatcher', eventType: 'DISPATCHER_CHANGED', pick: people.dispatcher, person: lead.dispatcher },
  ];
  for (const { label, eventType, pick, person } of slots) {
    if (!pick) continue;
    const name = person ? `${person.first_name} ${person.last_name}` : 'A person';
    const how = pick.source === 'creator' ? 'set to the creator at creation' : 'picked at creation';
    await db.timelineEvent.create({
      data: {
        organization_id: organizationId,
        entity_type: 'LEAD',
        entity_id: lead.id,
        event_type: eventType,
        description: `${name} set as ${label} on ${lead.lead_number} (${how})`,
        metadata: { from_user_id: null, to_user_id: pick.id, source: pick.source },
        created_by: createdBy,
      },
    });
  }
}

/** The pre-fill as the new-job form's two people fields hold it: the creator in one, nobody in the other. */
export interface JobCreatorPrefill {
  sold_by_id: string | null;
  dispatcher_id: string | null;
}

/** The same rule over a job: the Owner slot is Sold By. */
export async function jobCreatorPrefill(creator: SwitchSubject): Promise<JobCreatorPrefill> {
  const slot = await creatorPrefillSlot(creator);
  return {
    sold_by_id: slot === 'owner' ? creator.id : null,
    dispatcher_id: slot === 'dispatcher' ? creator.id : null,
  };
}

/** A person a new job was saved with: who, where they came from, and the name the history line uses. */
export interface JobCreationPick {
  id: string;
  name: string;
  source: CreationSource;
}

/**
 * Write the people a new job was saved with onto its history, in the transaction that creates it: one "Sold By"
 * and one "Dispatcher" event for each slot that holds someone, marked "set to the creator at creation" when the
 * pre-fill was kept or "picked at creation" when a holder of Assign people to jobs chose them. A slot left empty
 * writes nothing. The event types are the ones the Team card's own changes use.
 */
export async function recordJobCreationPeople(
  tx: Prisma.TransactionClient,
  args: {
    organizationId: string;
    job: { id: string; job_number: string };
    createdBy: string;
    people: { soldBy: JobCreationPick | null; dispatcher: JobCreationPick | null };
  },
): Promise<void> {
  const { organizationId, job, createdBy, people } = args;
  const slots = [
    { label: 'Sold By', eventType: 'SOLD_BY_CHANGED', pick: people.soldBy },
    { label: 'Dispatcher', eventType: 'DISPATCHER_CHANGED', pick: people.dispatcher },
  ];
  for (const { label, eventType, pick } of slots) {
    if (!pick) continue;
    const how = pick.source === 'creator' ? 'set to the creator at creation' : 'picked at creation';
    await tx.timelineEvent.create({
      data: {
        organization_id: organizationId,
        entity_type: 'JOB',
        entity_id: job.id,
        event_type: eventType,
        description: `${pick.name} set as ${label} on job ${job.job_number} (${how})`,
        metadata: { from: null, to: pick.id, source: pick.source },
        created_by: createdBy,
      },
    });
  }
}
