/**
 * receiving-numbers.test.ts - resolve a CTM `receiving_number_id` to a phone.
 *
 * A forwarded inbound call arrives with NO agent object; the only identity in
 * the payload is `receiving_number_id`, which is CTM's numeric `filter_id`
 * (NOT the RPN string id). Confirmed against the live Northwind Services sub-account
 * on 2026-08-07: filter_id 3902576 is the number ending 5160, and the
 * receiving_numbers list endpoint carries `filter_id` on every record.
 *
 * Two hard constraints shape this module, and both are asserted below:
 *
 *  1. LOOKUP NEVER FETCHES. ingestCall runs inside the webhook's
 *     prisma.$transaction, so an HTTP call on that path would hold a database
 *     transaction open across the network - the 5s interactive-transaction
 *     timeout would abort the whole ingest and lose the call row entirely.
 *     Callers warm the cache BEFORE the transaction; the in-transaction read
 *     is a pure cache hit or nothing.
 *
 *  2. WARMING FAILS OPEN. Attribution is a nice-to-have on top of a call
 *     record. A CTM outage, a revoked key or an unconfigured environment must
 *     degrade the answer to "unknown", never reject the webhook - CTM would
 *     retry a 500 and we would drop calls to gain a name.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as ctmClient from '../client';
import {
  warmReceivingNumbers,
  lookupReceivingNumber,
  clearReceivingNumberCache,
  RECEIVING_NUMBER_TTL_MS,
} from '../receivingNumbers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const client = ctmClient as any;

const ACCOUNT_ID = '500001';
const OTHER_ACCOUNT = '111111';

// Shaped exactly like the live endpoint's records: `filter_id` is a NUMBER,
// `number` is already E.164, and `name` is null on numbers nobody has labelled
// in CTM yet (3 of the 6 live Northwind Services records).
const LIVE_SHAPE = [
  { id: 'RPN-A', filter_id: 3831362, name: 'Art Nakamura', number: '+15551115252' },
  { id: 'RPN-B', filter_id: 3902576, name: null, number: '+15551115160' },
  { id: 'RPN-C', filter_id: 3833870, name: 'Dome OFFICE', number: '+15551119424' },
];

beforeEach(() => {
  vi.clearAllMocks();
  clearReceivingNumberCache();
  client.isCtmConfigured.mockReturnValue(true);
  client.listReceivingNumbers.mockResolvedValue(LIVE_SHAPE);
});

afterEach(() => {
  vi.useRealTimers();
});

describe('warmReceivingNumbers / lookupReceivingNumber', () => {
  it('resolves a numeric filter_id to its E.164 number and CTM name', async () => {
    await warmReceivingNumbers(ACCOUNT_ID);

    // The webhook sends receiving_number_id as a number and ingest stringifies
    // it, so the cache must be keyed on the string form of filter_id.
    expect(lookupReceivingNumber(ACCOUNT_ID, '3831362')).toEqual({
      e164: '+15551115252',
      name: 'Art Nakamura',
    });
  });

  it('returns the number even when CTM has no name for it', async () => {
    await warmReceivingNumbers(ACCOUNT_ID);

    // Half the live records are unnamed. The number alone is still useful: it
    // is what gets matched against a ServWave user's phone.
    expect(lookupReceivingNumber(ACCOUNT_ID, '3902576')).toEqual({
      e164: '+15551115160',
      name: null,
    });
  });

  it('never fetches on lookup - a cold cache is a miss, not a network call', () => {
    expect(lookupReceivingNumber(ACCOUNT_ID, '3831362')).toBeNull();

    // See constraint 1 in the file header: this read happens inside the
    // webhook's database transaction.
    expect(client.listReceivingNumbers).not.toHaveBeenCalled();
  });

  it('returns null for a filter_id CTM does not know', async () => {
    await warmReceivingNumbers(ACCOUNT_ID);

    expect(lookupReceivingNumber(ACCOUNT_ID, '9999999')).toBeNull();
  });

  it('keeps accounts separate so one org cannot read another org numbers', async () => {
    await warmReceivingNumbers(ACCOUNT_ID);

    expect(lookupReceivingNumber(OTHER_ACCOUNT, '3831362')).toBeNull();
  });

  it('serves a second warm from cache instead of re-fetching', async () => {
    await warmReceivingNumbers(ACCOUNT_ID);
    await warmReceivingNumbers(ACCOUNT_ID);
    await warmReceivingNumbers(ACCOUNT_ID);

    // Every inbound webhook warms; without this the call volume would map 1:1
    // onto CTM API requests and hit its rate limiter.
    expect(client.listReceivingNumbers).toHaveBeenCalledTimes(1);
  });

  it('collapses concurrent warms into a single request', async () => {
    await Promise.all([
      warmReceivingNumbers(ACCOUNT_ID),
      warmReceivingNumbers(ACCOUNT_ID),
      warmReceivingNumbers(ACCOUNT_ID),
    ]);

    // Simultaneous webhooks are the normal case on a busy line, and the naive
    // "check cache then fetch" races into N identical requests.
    expect(client.listReceivingNumbers).toHaveBeenCalledTimes(1);
    expect(lookupReceivingNumber(ACCOUNT_ID, '3831362')).not.toBeNull();
  });

  it('re-fetches once the entry has aged past its TTL', async () => {
    vi.useFakeTimers();
    await warmReceivingNumbers(ACCOUNT_ID);

    vi.advanceTimersByTime(RECEIVING_NUMBER_TTL_MS + 1);
    await warmReceivingNumbers(ACCOUNT_ID);

    // Numbers get added, renamed and released in CTM; a process that cached
    // forever would attribute calls to a stale roster until the next deploy.
    expect(client.listReceivingNumbers).toHaveBeenCalledTimes(2);
  });

  it('fails open when CTM errors, leaving the lookup a quiet miss', async () => {
    client.listReceivingNumbers.mockRejectedValue(new Error('CTM 503'));

    await expect(warmReceivingNumbers(ACCOUNT_ID)).resolves.toBeUndefined();
    expect(lookupReceivingNumber(ACCOUNT_ID, '3831362')).toBeNull();
  });

  it('does not cache a failure, so the next call retries', async () => {
    client.listReceivingNumbers.mockRejectedValueOnce(new Error('CTM 503'));
    await warmReceivingNumbers(ACCOUNT_ID);

    await warmReceivingNumbers(ACCOUNT_ID);

    // A transient 503 must not blind attribution for a whole TTL window.
    expect(client.listReceivingNumbers).toHaveBeenCalledTimes(2);
    expect(lookupReceivingNumber(ACCOUNT_ID, '3831362')).not.toBeNull();
  });

  it('skips the request entirely when CTM is not configured', async () => {
    client.isCtmConfigured.mockReturnValue(false);

    await expect(warmReceivingNumbers(ACCOUNT_ID)).resolves.toBeUndefined();
    expect(client.listReceivingNumbers).not.toHaveBeenCalled();
  });

  it('ignores records with no usable number rather than caching junk', async () => {
    client.listReceivingNumbers.mockResolvedValue([
      { id: 'RPN-X', filter_id: 4000001, name: 'No number', number: null },
      { id: 'RPN-Y', filter_id: null, name: 'No filter id', number: '+15551110000' },
      ...LIVE_SHAPE,
    ]);

    await warmReceivingNumbers(ACCOUNT_ID);

    expect(lookupReceivingNumber(ACCOUNT_ID, '4000001')).toBeNull();
    expect(lookupReceivingNumber(ACCOUNT_ID, '3831362')).not.toBeNull();
  });

  it('normalises whatever shape CTM sends the number in', async () => {
    // The live endpoint returns E.164 today, but `formatted` and
    // `display_number` on the same record are punctuated, and CTM's field
    // naming drifts across endpoints (see the ingest header note).
    client.listReceivingNumbers.mockResolvedValue([
      { id: 'RPN-Z', filter_id: 4100001, name: 'Punctuated', number: '(555) 111-5252' },
    ]);

    await warmReceivingNumbers(ACCOUNT_ID);

    expect(lookupReceivingNumber(ACCOUNT_ID, '4100001')).toEqual({
      e164: '+15551115252',
      name: 'Punctuated',
    });
  });
});
