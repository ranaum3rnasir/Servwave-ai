/**
 * ctm-assigned-answerer-attribution.test.ts - attribute a forwarded call to
 * the person the number is assigned to.
 *
 * The phone-matching resolver shipped in #1376 answers "who picked up?" by
 * mapping the payload's `receiving_number_id` to an E.164 and matching that
 * against `users.phone`. On the live sub-account it resolves nobody: all 23
 * users have `phone: null` and the receiving number is unnamed, so it fails
 * open and every forwarded call stays unattributed. Five of the 28 forwarded
 * calls in staging do not even carry a `receiving_number_id` (#1387), so no
 * amount of roster work would reach them.
 *
 * Assignment is the signal that does not depend on any of that. A number is
 * bought with a forward destination, and assigned to the user who is
 * responsible for the calls it takes; that user is who answered. The number
 * dialed is on the payload itself, so this works with no roster, no user phone
 * number, and no receiving_number_id.
 *
 * Two limits are deliberate. It fires only for an ANSWERED call - a call that
 * forwarded to someone and was not picked up is not that person answering. And
 * a number with several assignees names nobody, because "the assigned user
 * answered" stops being a fact the moment there are two of them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma';
import { ingestCall } from '../lib/ctm/ingest';
import * as ctmClient from '../lib/ctm/client';
import { clearReceivingNumberCache } from '../lib/ctm/receivingNumbers';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const ORG_ID = 'a0000000-0000-0000-0000-0000000000aa';
const ACCOUNT_ID = '500002';
const TRACKING = '+16097191235';

const SHERRY_ID = 'b0000000-0000-0000-0000-00000000000b';
const OTHER_ID = 'b0000000-0000-0000-0000-00000000000c';

const sherryLink = {
  user_id: SHERRY_ID,
  user: { id: SHERRY_ID, first_name: 'Sherry', last_name: 'Alvarez', email: 'sherry@example.com' },
};
const otherLink = {
  user_id: OTHER_ID,
  user: { id: OTHER_ID, first_name: 'Dana', last_name: 'Reyes', email: 'dana@example.com' },
};

/** A completed inbound call with no agent object: a forwarded answer. */
function forwardedCall(over: Record<string, unknown> = {}) {
  return {
    sid: 'CAL-assigned-1',
    direction: 'inbound',
    tracking_number: TRACKING,
    caller_number: '+19735550111',
    call_status: 'completed',
    dial_status: 'answered',
    talk_time: 74,
    unix_time: 1786000000,
    ...over,
  };
}

function created() {
  expect(p.callSession.upsert, 'ingest should have upserted a call').toHaveBeenCalled();
  return p.callSession.upsert.mock.calls[0][0].create as Record<string, any>;
}

function updated() {
  return p.callSession.upsert.mock.calls[0][0].update as Record<string, any>;
}

/** The org's number, with whoever it is assigned to. */
function assignTo(links: Array<Record<string, unknown>>) {
  p.phoneNumber.findFirst.mockResolvedValue({
    id: 'pn-1',
    e164: TRACKING,
    user_links: links,
  });
}

beforeEach(() => {
  vi.clearAllMocks();
  clearReceivingNumberCache();
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  p.user.findFirst.mockResolvedValue(null);
  p.user.findMany.mockResolvedValue([]);
  p.callSession.findFirst.mockResolvedValue(null);
  p.callSession.upsert.mockResolvedValue({ id: 'cs-1' });
  p.pendingCallAttribution.findFirst.mockResolvedValue(null);
  p.pendingCallAttribution.updateMany.mockResolvedValue({ count: 0 });
  p.blockedNumber?.findFirst?.mockResolvedValue?.(null);

  client.isCtmConfigured.mockReturnValue(true);
  client.listReceivingNumbers.mockResolvedValue([]);

  assignTo([sherryLink]);
});

describe('ingestCall - attributing a forwarded call to the number assignee', () => {
  it('attributes an answered forwarded call to the number sole assignee', async () => {
    await ingestCall(prisma, ORG_ID, forwardedCall(), 'end', { ctmAccountId: ACCOUNT_ID });

    expect(created().agent_id).toBe(SHERRY_ID);
    expect(created().answered_by).toMatchObject({
      kind: 'external',
      user_id: SHERRY_ID,
      name: 'Sherry Alvarez',
    });
  });

  it('marks the attribution as inferred, not observed', async () => {
    // The difference matters to anyone reading a report: we did not see who
    // picked up, we know who is responsible for the number.
    await ingestCall(prisma, ORG_ID, forwardedCall(), 'end', { ctmAccountId: ACCOUNT_ID });

    expect(created().answered_by.resolved_from).toBe('assignment');
  });

  it('works with no receiving_number_id at all (#1387)', async () => {
    await ingestCall(prisma, ORG_ID, forwardedCall(), 'end', { ctmAccountId: ACCOUNT_ID });

    expect(created().answered_by.receiving_number_id).toBeUndefined();
    expect(created().agent_id).toBe(SHERRY_ID);
  });

  it('needs no phone number on the user record', async () => {
    // The dependency that made #1376 resolve nobody on the live account.
    p.user.findMany.mockResolvedValue([]);

    await ingestCall(prisma, ORG_ID, forwardedCall(), 'end', { ctmAccountId: ACCOUNT_ID });

    expect(created().agent_id).toBe(SHERRY_ID);
  });

  it('names nobody when the number is shared between several people', async () => {
    assignTo([sherryLink, otherLink]);

    await ingestCall(prisma, ORG_ID, forwardedCall({ receiving_number_id: 3906455 }), 'end', {
      ctmAccountId: ACCOUNT_ID,
    });

    expect(created().agent_id).toBeNull();
    expect(created().answered_by).toEqual({
      kind: 'external',
      receiving_number_id: '3906455',
    });
  });

  it('names nobody when the number has no assignee', async () => {
    assignTo([]);

    await ingestCall(prisma, ORG_ID, forwardedCall(), 'end', { ctmAccountId: ACCOUNT_ID });

    expect(created().agent_id).toBeNull();
    expect(created().answered_by.user_id).toBeUndefined();
  });

  it('does NOT attribute a missed call to the assignee', async () => {
    // Forwarding to someone who did not pick up is not that person answering.
    await ingestCall(
      prisma,
      ORG_ID,
      forwardedCall({ call_status: 'missed', dial_status: 'no-answer', talk_time: 0 }),
      'end',
      { ctmAccountId: ACCOUNT_ID },
    );

    expect(created().answered_by.kind).not.toBe('external');
    expect(created().agent_id).toBeNull();
  });

  it('never overrides a softphone answer with the assignee', async () => {
    // A vendor agent object is a direct observation of who picked up; the
    // assignee is a fallback, never a correction.
    p.user.findFirst.mockResolvedValue({ id: OTHER_ID });

    await ingestCall(
      prisma,
      ORG_ID,
      forwardedCall({ agent: { id: '12', name: 'Dana Reyes', email: 'dana@example.com' } }),
      'end',
      { ctmAccountId: ACCOUNT_ID },
    );

    expect(created().answered_by.kind).toBe('csr');
    expect(created().agent_id).toBe(OTHER_ID);
  });

  it('does not attribute a call to a number belonging to another org', async () => {
    // findFirst is org-scoped; a miss must leave the call unattributed rather
    // than reaching for any number with that E.164.
    p.phoneNumber.findFirst.mockResolvedValue(null);

    await ingestCall(prisma, ORG_ID, forwardedCall(), 'end', { ctmAccountId: ACCOUNT_ID });

    expect(created().agent_id).toBeNull();
  });

  it('stamps the same attribution on the update path, not just create', async () => {
    await ingestCall(prisma, ORG_ID, forwardedCall(), 'end', { ctmAccountId: ACCOUNT_ID });

    expect(updated().answered_by).toMatchObject({ kind: 'external', user_id: SHERRY_ID });
    expect(updated().agent_id).toBe(SHERRY_ID);
  });
});
