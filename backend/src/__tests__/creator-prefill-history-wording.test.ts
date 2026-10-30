/**
 * The History lines written when a new lead or job is saved with its people (creator pre-fill, or picked): the
 * Dispatcher line reads like the Owner and Sold By lines, "<name> set as <Slot> on <record> (<how>)", with the slot
 * name capitalised. Seam: the two writers, over a stub that records each timeline event they create.
 */
import { describe, it, expect } from 'vitest';
import type { Prisma } from '@prisma/client';
import { recordJobCreationPeople, recordLeadCreationPeople } from '../lib/permissions/creatorPrefill';

function recorder() {
  const descriptions: string[] = [];
  const db = {
    timelineEvent: {
      create: async ({ data }: { data: { description: string } }) => {
        descriptions.push(data.description);
        return {};
      },
    },
  } as unknown as Prisma.TransactionClient;
  return { db, descriptions };
}

describe('History lines for the people a new record was saved with', () => {
  it('writes the job lines for Sold By and Dispatcher in one shape', async () => {
    const { db, descriptions } = recorder();
    await recordJobCreationPeople(db, {
      organizationId: 'org-1',
      job: { id: 'job-1', job_number: 'J00726' },
      createdBy: 'user-1',
      people: {
        soldBy: { id: 'u-1', name: 'Sam Seller', source: 'creator' },
        dispatcher: { id: 'u-2', name: 'Dee Spatch', source: 'creator' },
      },
    });
    expect(descriptions).toEqual([
      'Sam Seller set as Sold By on job J00726 (set to the creator at creation)',
      'Dee Spatch set as Dispatcher on job J00726 (set to the creator at creation)',
    ]);
  });

  it('writes the lead lines for Owner and Dispatcher in one shape, picked or kept', async () => {
    const { db, descriptions } = recorder();
    await recordLeadCreationPeople(db, {
      organizationId: 'org-1',
      lead: {
        id: 'lead-1',
        lead_number: 'L00412',
        commission_owner: { first_name: 'Olive', last_name: 'Owner' },
        dispatcher: { first_name: 'Dee', last_name: 'Spatch' },
      },
      createdBy: 'user-1',
      people: { owner: { id: 'u-1', source: 'picked' }, dispatcher: { id: 'u-2', source: 'creator' } },
    });
    expect(descriptions).toEqual([
      'Olive Owner set as Owner on L00412 (picked at creation)',
      'Dee Spatch set as Dispatcher on L00412 (set to the creator at creation)',
    ]);
  });
});
