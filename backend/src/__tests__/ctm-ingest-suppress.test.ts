/**
 * ctm-ingest-suppress.test.ts — backfill notification suppression.
 *
 * A historical import must not ring bells (notification emits) or mark
 * hundreds of threads unread. `ingestCall`/`ingestSms` take
 * { suppressNotifications: true } (passed only by scripts/ctm-backfill.ts);
 * the live webhook path passes nothing and keeps today's behavior exactly.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma';
import { ingestCall, ingestSms } from '../lib/ctm/ingest';
import { emit } from '../services/notifications/notificationService';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const emitMock = emit as unknown as ReturnType<typeof vi.fn>;

const ORG_ID = 'org-1';

const CALL_STARTS = {
  sid: 'CA5001',
  account_id: 500001,
  caller_number: '+12015551234',
  tracking_number: '+12019037784',
  direction: 'inbound',
  unix_time: 1_752_000_000,
};

const SMS_INBOUND = {
  message_id: 'MSG5001',
  account_id: 500001,
  caller_number: '+12015551234',
  tracking_number: '+12019037784',
  direction: 'msg_inbound',
  message_body: 'Hello there',
  unix_time: 1_752_000_100,
};

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
});

describe('ingestCall — suppressNotifications', () => {
  it('flag on: ingests the row but emits ZERO notifications', async () => {
    const res = await ingestCall(prisma, ORG_ID, CALL_STARTS, 'starts', {
      suppressNotifications: true,
    });

    expect(res).not.toBeNull();
    expect(p.callSession.upsert).toHaveBeenCalledTimes(1);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('flag on: a missed call at end emits nothing either', async () => {
    await ingestCall(
      prisma,
      ORG_ID,
      { ...CALL_STARTS, sid: 'CA5002', dial_status: 'no-answer' },
      'end',
      { suppressNotifications: true },
    );

    expect(p.callSession.upsert).toHaveBeenCalledTimes(1);
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('no flag (webhook path): a starts event emits nothing — call_incoming was removed', async () => {
    // Inbound rings the cell, never the app (#870), so there is no
    // incoming-call bell; the missed-call outcome is the only call bell.
    await ingestCall(prisma, ORG_ID, CALL_STARTS, 'starts');

    expect(emitMock).not.toHaveBeenCalled();
  });
});

describe('ingestSms — suppressNotifications', () => {
  it('flag on: stores the message but neither emits nor increments unread', async () => {
    const res = await ingestSms(prisma, ORG_ID, SMS_INBOUND, { suppressNotifications: true });

    expect(res).not.toBeNull();
    expect(p.message.create).toHaveBeenCalledTimes(1);
    expect(p.messageThread.update).not.toHaveBeenCalled();
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('no flag (webhook path): unread increments and the inbound bell fires', async () => {
    await ingestSms(prisma, ORG_ID, SMS_INBOUND);

    expect(p.messageThread.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { unread: { increment: 1 } } }),
    );
    expect(emitMock).toHaveBeenCalledTimes(1);
    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({ verb: 'communication.sms_inbound' }),
    );
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
