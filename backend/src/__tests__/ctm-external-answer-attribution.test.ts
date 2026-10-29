/**
 * ctm-external-answer-attribution.test.ts - name whoever picked up a forwarded call.
 *
 * Alpha Doors runs campaign numbers that forward to staff mobiles and to the
 * office, so most answered inbound calls carry NO CTM agent object. Ingest
 * classified those as `{ kind: 'external', receiving_number_id }` and stopped
 * there: the row knew a human had answered and could not say which one, and
 * `agent_id` stayed null, so per-person reporting was impossible for exactly
 * the calls the business cares most about.
 *
 * `receiving_number_id` IS resolvable - it is CTM's numeric `filter_id`, and
 * the receiving-numbers roster maps it to an E.164 (verified against the live
 * sub-account 2026-08-07). Matching that against `users.phone` names the
 * answerer and, when it lands on a real ServWave user, sets `agent_id`.
 *
 * Two live details drive the fixtures below:
 *
 *  - `users.phone` is stored as BARE 10 DIGITS ('6465550111'), while CTM
 *    returns E.164 ('+16465550111'). Every match therefore has to normalise
 *    both sides; comparing the stored strings directly matches nothing.
 *  - CTM names only some receiving numbers (3 of 6 live records are unnamed),
 *    and a named one need not correspond to any ServWave user - the office
 *    line is a place, not a person.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma';
import { ingestCall } from '../lib/ctm/ingest';
import * as ctmClient from '../lib/ctm/client';
import {
  warmReceivingNumbers,
  clearReceivingNumberCache,
} from '../lib/ctm/receivingNumbers';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const ORG_ID = 'a0000000-0000-0000-0000-0000000000aa';
const ACCOUNT_ID = '596375';

const SAGIV_ID = 'b0000000-0000-0000-0000-00000000000b';

// filter_id -> number, in the endpoint's real record shape.
const ROSTER = [
  { id: 'RPN-A', filter_id: 3831356, name: 'Sagiv Peker', number: '+16465550111' },
  { id: 'RPN-B', filter_id: 3833870, name: 'Dome OFFICE', number: '+16465550222' },
  { id: 'RPN-C', filter_id: 3902576, name: null, number: '+16465550333' },
];

/** A completed inbound call with no agent object: a forwarded answer. */
function forwardedCall(receivingNumberId: number) {
  return {
    sid: `CAL-fwd-${receivingNumberId}`,
    direction: 'inbound',
    tracking_number: '+18626262706',
    caller_number: '+19735550111',
    call_status: 'completed',
    dial_status: 'answered',
    talk_time: 74,
    unix_time: 1786000000,
    receiving_number_id: receivingNumberId,
  };
}

function created() {
  expect(p.callSession.upsert, 'ingest should have upserted a call').toHaveBeenCalled();
  return p.callSession.upsert.mock.calls[0][0].create as Record<string, any>;
}

function updated() {
  return p.callSession.upsert.mock.calls[0][0].update as Record<string, any>;
}

beforeEach(async () => {
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

  client.isCtmConfigured.mockReturnValue(true);
  client.listReceivingNumbers.mockResolvedValue(ROSTER);
  await warmReceivingNumbers(ACCOUNT_ID);
});

describe('ingestCall - who answered a forwarded call', () => {
  it('sets agent_id when the receiving number is a ServWave user phone', async () => {
    // Stored bare, exactly as the live rows are.
    p.user.findMany.mockResolvedValue([
      { id: SAGIV_ID, first_name: 'Sagiv', last_name: 'Peker', email: 'sagiv@example.com', phone: '6465550111' },
    ]);

    await ingestCall(prisma, ORG_ID, forwardedCall(3831356), 'end', { ctmAccountId: ACCOUNT_ID });

    // The whole point: per-person call reporting needs a real FK, not a label.
    expect(created().agent_id).toBe(SAGIV_ID);
  });

  it('names the answerer on answered_by, preferring the ServWave user over CTM', async () => {
    p.user.findMany.mockResolvedValue([
      { id: SAGIV_ID, first_name: 'Sagiv', last_name: 'Peker', email: 'sagiv@example.com', phone: '6465550111' },
    ]);

    await ingestCall(prisma, ORG_ID, forwardedCall(3831356), 'end', { ctmAccountId: ACCOUNT_ID });

    expect(created().answered_by).toEqual({
      kind: 'external',
      receiving_number_id: '3831356',
      user_id: SAGIV_ID,
      name: 'Sagiv Peker',
      email: 'sagiv@example.com',
    });
  });

  it('keeps kind "external" so a forwarded answer stays distinguishable from a CSR', async () => {
    p.user.findMany.mockResolvedValue([
      { id: SAGIV_ID, first_name: 'Sagiv', last_name: 'Peker', email: 'sagiv@example.com', phone: '6465550111' },
    ]);

    await ingestCall(prisma, ORG_ID, forwardedCall(3831356), 'end', { ctmAccountId: ACCOUNT_ID });

    // Answering a forwarded call on a mobile is not the same operational event
    // as answering in the app, and the Calls view labels them differently.
    expect(created().answered_by.kind).toBe('external');
  });

  it('never stores the answering phone number itself', async () => {
    p.user.findMany.mockResolvedValue([
      { id: SAGIV_ID, first_name: 'Sagiv', last_name: 'Peker', email: 'sagiv@example.com', phone: '6465550111' },
    ]);

    await ingestCall(prisma, ORG_ID, forwardedCall(3831356), 'end', { ctmAccountId: ACCOUNT_ID });

    // answered_by is serialised straight to the API and rendered in the Calls
    // list, so a staff member's personal mobile would become visible to every
    // user in the org. The number is a lookup key, not a fact worth keeping -
    // agent_id already carries the identity.
    expect(JSON.stringify(created().answered_by)).not.toContain('646555');
  });

  it('falls back to the CTM label when no user owns that number', async () => {
    p.user.findMany.mockResolvedValue([]);

    await ingestCall(prisma, ORG_ID, forwardedCall(3833870), 'end', { ctmAccountId: ACCOUNT_ID });

    // The office line is a place, not a person: name it, but leave agent_id
    // null rather than inventing an owner.
    expect(created().answered_by).toEqual({
      kind: 'external',
      receiving_number_id: '3833870',
      name: 'Dome OFFICE',
    });
    expect(created().agent_id).toBeNull();
  });

  it('leaves an unnamed, unmatched number exactly as it ingested before', async () => {
    p.user.findMany.mockResolvedValue([]);

    await ingestCall(prisma, ORG_ID, forwardedCall(3902576), 'end', { ctmAccountId: ACCOUNT_ID });

    // No name in CTM and no matching user: there is nothing truthful to add,
    // and inventing an empty `name: null` key would only churn the shape.
    expect(created().answered_by).toEqual({
      kind: 'external',
      receiving_number_id: '3902576',
    });
  });

  it('degrades to the old shape when the roster was never warmed', async () => {
    clearReceivingNumberCache();
    p.user.findMany.mockResolvedValue([
      { id: SAGIV_ID, first_name: 'Sagiv', last_name: 'Peker', email: 'sagiv@example.com', phone: '6465550111' },
    ]);

    await ingestCall(prisma, ORG_ID, forwardedCall(3831356), 'end', { ctmAccountId: ACCOUNT_ID });

    // A CTM outage must cost the attribution, never the call record.
    expect(created().answered_by).toEqual({
      kind: 'external',
      receiving_number_id: '3831356',
    });
    expect(created().agent_id).toBeNull();
  });

  it('does not query users when there is no account id to resolve against', async () => {
    await ingestCall(prisma, ORG_ID, forwardedCall(3831356), 'end');

    // The backfill script and any future caller that omits it must not pay for
    // a lookup that cannot succeed.
    expect(p.user.findMany).not.toHaveBeenCalled();
  });

  it('leaves an agent-answered call alone', async () => {
    p.user.findMany.mockResolvedValue([
      { id: SAGIV_ID, first_name: 'Sagiv', last_name: 'Peker', email: 'sagiv@example.com', phone: '6465550111' },
    ]);

    await ingestCall(
      prisma,
      ORG_ID,
      { ...forwardedCall(3831356), agent: { id: 'AGT-1', name: 'CTM Agent', email: 'agent@example.com' } },
      'end',
      { ctmAccountId: ACCOUNT_ID },
    );

    // A CTM agent object is a direct answer, not a forward - the resolver must
    // not overwrite it, and must not run at all.
    expect(created().answered_by.kind).toBe('csr');
    expect(p.user.findMany).not.toHaveBeenCalled();
  });

  it('scopes the user match to the calling organization', async () => {
    p.user.findMany.mockResolvedValue([]);

    await ingestCall(prisma, ORG_ID, forwardedCall(3831356), 'end', { ctmAccountId: ACCOUNT_ID });

    expect(p.user.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ organization_id: ORG_ID }),
      }),
    );
  });

  it('carries the attribution onto the update path of a late end event', async () => {
    p.user.findMany.mockResolvedValue([
      { id: SAGIV_ID, first_name: 'Sagiv', last_name: 'Peker', email: 'sagiv@example.com', phone: '6465550111' },
    ]);

    await ingestCall(prisma, ORG_ID, forwardedCall(3831356), 'end', { ctmAccountId: ACCOUNT_ID });

    // The `starts` event creates a ringing row; the `end` that follows is what
    // knows who picked up, so the update half has to write it too.
    expect(updated().answered_by).toMatchObject({ user_id: SAGIV_ID });
    expect(updated().agent_id).toBe(SAGIV_ID);
  });

  it('matches a user whose phone is stored in a punctuated format', async () => {
    p.user.findMany.mockResolvedValue([
      { id: SAGIV_ID, first_name: 'Sagiv', last_name: 'Peker', email: 'sagiv@example.com', phone: '(646) 555-0111' },
    ]);

    await ingestCall(prisma, ORG_ID, forwardedCall(3831356), 'end', { ctmAccountId: ACCOUNT_ID });

    // Users type their phone into a free-text field, so the same person can be
    // stored three different ways; normalisation is what makes this match.
    expect(created().agent_id).toBe(SAGIV_ID);
  });
});
