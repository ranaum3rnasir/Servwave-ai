import { describe, it, expect, vi } from 'vitest';
import {
  recordEntryAdded,
  recordEntryChanged,
  recordEntryCorrected,
  recordEntryRemoved,
} from '../lib/record-contact-history.js';

// The sentence a job's or a lead's History shows for a phone, with and without an extension. The writers take the
// transaction client, so a stand-in that keeps what was written is all the test needs (and, for a job, no job in Ready to close).
function fakeDb() {
  const create = vi.fn().mockResolvedValue({});
  return { db: { timelineEvent: { create }, job: { findMany: vi.fn().mockResolvedValue([]) } } as never, descriptions: () => create.mock.calls.map((c) => c[0].data.description as string) };
}
const actor = { orgId: 'org-1', userId: 'user-1' };
const JOB = { type: 'JOB', id: 'job-1' } as const;
const LEAD = { type: 'LEAD', id: 'lead-1' } as const;
const phone = (value: string, extension: string | null) => ({ value, extension, label: null });

describe('contact history sentences carry the extension', () => {
  it('a phone changed only in its extension names the extension on both sides', async () => {
    const { db, descriptions } = fakeDb();
    await recordEntryChanged(db, actor, JOB, {
      id: 'e1', kind: 'PHONE', intent: 'CHANGED', old: phone('5550100102', '12'), new: phone('5550100102', null),
    });
    expect(descriptions()).toEqual(['Phone (555) 010-0102 ext. 12 changed to (555) 010-0102 for this job only']);
  });

  it('the same change on a lead says "for this lead only"', async () => {
    const { db, descriptions } = fakeDb();
    await recordEntryChanged(db, actor, LEAD, {
      id: 'e1', kind: 'PHONE', intent: 'CHANGED', old: phone('5550100102', null), new: phone('5550100102', '7'),
    });
    expect(descriptions()).toEqual(['Phone (555) 010-0102 changed to (555) 010-0102 ext. 7 for this lead only']);
  });

  it('a first phone for the record (the customer held none) shows its extension', async () => {
    const { db, descriptions } = fakeDb();
    await recordEntryChanged(db, actor, JOB, {
      id: 'e1', kind: 'PHONE', intent: 'CHANGED', old: phone('', null), new: phone('5550100102', '12'),
    });
    expect(descriptions()).toEqual(['Phone set to (555) 010-0102 ext. 12 for this job only']);
  });

  it('an added phone shows its extension, and one without leaves the sentence as it was', async () => {
    const { db, descriptions } = fakeDb();
    await recordEntryAdded(db, actor, JOB, { id: 'e1', kind: 'PHONE', intent: 'ADDED', ...phone('5550100102', '12') });
    await recordEntryAdded(db, actor, JOB, { id: 'e2', kind: 'PHONE', intent: 'ADDED', ...phone('5550100103', null) });
    expect(descriptions()).toEqual([
      'Phone (555) 010-0102 ext. 12 added for this job only',
      'Phone (555) 010-0103 added for this job only',
    ]);
  });

  it('a corrected extension no longer reads as the same number twice', async () => {
    const { db, descriptions } = fakeDb();
    await recordEntryCorrected(db, actor, JOB, {
      id: 'e1', kind: 'PHONE', intent: 'ADDED', old: phone('5550100102', '12'), new: phone('5550100102', '13'),
    });
    await recordEntryCorrected(db, actor, JOB, {
      id: 'e2', kind: 'PHONE', intent: 'ADDED', old: phone('5550100103', null), new: phone('5550100104', null),
    });
    expect(descriptions()).toEqual([
      'Phone (555) 010-0102 ext. 12 corrected to (555) 010-0102 ext. 13 for this job only',
      'Phone (555) 010-0103 corrected to (555) 010-0104 for this job only',
    ]);
  });

  it('a removed phone shows the extension it had', async () => {
    const { db, descriptions } = fakeDb();
    await recordEntryRemoved(db, actor, LEAD, {
      id: 'e1', kind: 'PHONE', intent: 'ADDED', old: phone('5550100102', '12'), restoredCustomerValue: null,
    });
    expect(descriptions()).toEqual(['Phone (555) 010-0102 ext. 12 removed from this lead']);
  });

  it('an email never gets an extension', async () => {
    const { db, descriptions } = fakeDb();
    await recordEntryAdded(db, actor, JOB, { id: 'e1', kind: 'EMAIL', intent: 'ADDED', ...phone('a@b.co', null) });
    expect(descriptions()).toEqual(['Email a@b.co added for this job only']);
  });
});
