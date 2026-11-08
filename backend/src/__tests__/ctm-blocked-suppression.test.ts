/**
 * ctm-blocked-suppression.test.ts - ingest honours the blocked list (SRVW-98).
 *
 * ServWave's inbound model is post-hoc (BROWSER_INBOUND_ANSWER_ENABLED = false;
 * CTM's Smart Router forwards the call to the staff cell and we learn of it from
 * the after-the-fact webhook), so blocking can never stop the ring. What it CAN
 * do is stop the app-side noise: no missed-call bell, no inbound-SMS bell, no
 * thread unread increment. Suppression is never destructive - the CallSession
 * and the Message are still written, and the call is tagged 'Blocked caller' so
 * a mis-block stays visible and filterable in the Calls log.
 *
 * Cloned from ctm-ingest-suppress.test.ts's direct-unit-call harness.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma';
import { ingestCall, ingestSms, BLOCKED_CALL_TAG } from '../lib/ctm/ingest';
import { emit } from '../services/notifications/notificationService';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const emitMock = emit as unknown as ReturnType<typeof vi.fn>;

const ORG_ID = 'org-1';
const BLOCKED_E164 = '+12015551234';

const INBOUND_MISSED = {
  sid: 'CA9001',
  account_id: 500001,
  caller_number: BLOCKED_E164,
  tracking_number: '+12019037784',
  direction: 'inbound',
  dial_status: 'no-answer',
  unix_time: 1_752_000_000,
};

const OUTBOUND_CALL = {
  sid: 'CA9002',
  account_id: 500001,
  caller_number: '+12019037784',
  called_number: BLOCKED_E164,
  tracking_number: '+12019037784',
  direction: 'outbound',
  dial_status: 'completed',
  unix_time: 1_752_000_050,
};

const SMS_INBOUND = {
  message_id: 'MSG9001',
  account_id: 500001,
  caller_number: BLOCKED_E164,
  tracking_number: '+12019037784',
  direction: 'msg_inbound',
  message_body: 'Buy crypto now',
  unix_time: 1_752_000_100,
};

function blockList(number: string) {
  p.blockedNumber.findMany.mockResolvedValue([{ id: 'b1', number }]);
}

beforeEach(() => {
  vi.clearAllMocks();
  // Identity lookups: unmatched.
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  p.user.findFirst.mockResolvedValue(null);
  // Call path.
  p.callSession.findFirst.mockResolvedValue(null);
  p.callSession.upsert.mockResolvedValue({ id: 'cs-1' });
  // SMS path.
  p.messageThread.findFirst.mockResolvedValue(null);
  p.messageThread.create.mockResolvedValue({ id: 'th-1' });
  p.messageThread.update.mockResolvedValue({ id: 'th-1' });
  p.message.findFirst.mockResolvedValue(null);
  p.message.findMany.mockResolvedValue([]);
  p.message.create.mockResolvedValue({ id: 'msg-1', thread_id: 'th-1' });
  p.message.update.mockResolvedValue({ id: 'msg-1', thread_id: 'th-1' });
  // Nothing blocked unless a test says so.
  p.blockedNumber.findMany.mockResolvedValue([]);
});

describe('ingestCall - blocked caller', () => {
  it('records the row and emits nothing', async () => {
    blockList(BLOCKED_E164);

    await ingestCall(prisma, ORG_ID, INBOUND_MISSED, 'end');

    expect(p.callSession.upsert).toHaveBeenCalledTimes(1);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('tags the suppressed call rather than discarding it', async () => {
    blockList(BLOCKED_E164);

    await ingestCall(prisma, ORG_ID, INBOUND_MISSED, 'end');

    const create = p.callSession.upsert.mock.calls[0][0].create;
    expect(create.tags).toContain(BLOCKED_CALL_TAG);
  });

  it('a CTM tag list on end cannot erase the marker', async () => {
    blockList(BLOCKED_E164);

    await ingestCall(prisma, ORG_ID, { ...INBOUND_MISSED, tag_list: ['sales'] }, 'end');

    const update = p.callSession.upsert.mock.calls[0][0].update;
    expect(update.tags).toContain('sales');
    expect(update.tags).toContain(BLOCKED_CALL_TAG);
  });

  it('matches a display-form list row against an E.164 caller', async () => {
    // The two live staging rows are stored as '(201) 555-1234'; both sides must
    // go through the canonical key or those rows are silently inert.
    blockList('(201) 555-1234');

    await ingestCall(prisma, ORG_ID, INBOUND_MISSED, 'end');

    expect(emitMock).not.toHaveBeenCalled();
  });

  it('an unblocked inbound missed call still rings the bell', async () => {
    await ingestCall(prisma, ORG_ID, INBOUND_MISSED, 'end');

    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({ verb: 'communication.call_missed' }),
    );
  });

  it('outbound activity never consults the blocked list', async () => {
    blockList(BLOCKED_E164);

    await ingestCall(prisma, ORG_ID, OUTBOUND_CALL, 'end');

    expect(p.blockedNumber.findMany).not.toHaveBeenCalled();
  });

  it('the backfill path never consults the list and never retro-tags history', async () => {
    blockList(BLOCKED_E164);

    await ingestCall(prisma, ORG_ID, INBOUND_MISSED, 'end', { suppressNotifications: true });

    expect(p.blockedNumber.findMany).not.toHaveBeenCalled();
    const create = p.callSession.upsert.mock.calls[0][0].create;
    expect(create.tags ?? []).not.toContain(BLOCKED_CALL_TAG);
  });
});

describe('ingestSms - blocked sender', () => {
  it('stores the message but raises nothing', async () => {
    blockList(BLOCKED_E164);

    await ingestSms(prisma, ORG_ID, SMS_INBOUND);

    expect(p.message.create).toHaveBeenCalledTimes(1);
    expect(p.messageThread.update).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
