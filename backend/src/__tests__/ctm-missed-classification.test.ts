/**
 * ctm-missed-classification.test.ts — `hangup` end-status classification.
 *
 * Live QA 2026-07-21: a real inbound test call rang the org queue, the caller
 * hung up before anyone connected, and CTM's `end` webhook carried
 * `dial_status: "hangup"` with `talk_time: 0`. The classifier had no branch
 * for "hangup", fell through to the default `completed`, and the
 * communication.call_missed bell (gated on missed/voicemail) never fired.
 *
 * Rule under test: `hangup` with zero talk time = nobody ever connected =
 * missed. `hangup` with talk time > 0 = a real conversation that simply ended
 * by hanging up = completed (same live QA produced an outbound 7s-talk call
 * with dial_status "hangup").
 *
 * Payload shapes below mirror the stored ctm_events rows for those calls
 * (numbers masked — no real customer PII in fixtures).
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { prisma } from '../lib/prisma';
import { ingestCall } from '../lib/ctm/ingest';
import { emit } from '../services/notifications/notificationService';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const emitMock = emit as unknown as ReturnType<typeof vi.fn>;

const ORG_ID = 'org-1';

// Inbound queue-hangup end event (real shape: no agent object, CallQueue as
// the terminal call_path hop, talk_time zero).
const INBOUND_HANGUP_END = {
  sid: 'CA9101',
  account_id: 500001,
  caller_number: '+15550001111',
  tracking_number: '+12019037784',
  direction: 'inbound',
  dial_status: 'hangup',
  call_status: 'hangup',
  talk_time: 0,
  call_path: [{ route_type: 'CallQueue' }],
  unix_time: 1_752_000_000,
};

beforeEach(() => {
  vi.clearAllMocks();
  p.customer.findFirst.mockResolvedValue(null);
  p.lead.findFirst.mockResolvedValue(null);
  p.vendor.findFirst.mockResolvedValue(null);
  p.vendorContact.findFirst.mockResolvedValue(null);
  p.user.findFirst.mockResolvedValue(null);
  p.callSession.findFirst.mockResolvedValue(null);
  p.callSession.upsert.mockResolvedValue({ id: 'cs-1' });
  p.pendingCallAttribution.findFirst.mockResolvedValue(null);
});

describe('callStatus — hangup end events', () => {
  it('inbound hangup with zero talk time is stored as missed', async () => {
    const res = await ingestCall(prisma, ORG_ID, INBOUND_HANGUP_END, 'end');

    expect(res?.status).toBe('missed');
    const upsert = p.callSession.upsert.mock.calls[0][0];
    expect(upsert.create.status).toBe('missed');
  });

  it('inbound hangup with zero talk time fires the call_missed bell', async () => {
    await ingestCall(prisma, ORG_ID, INBOUND_HANGUP_END, 'end');

    expect(emitMock).toHaveBeenCalledWith(
      expect.objectContaining({
        verb: 'communication.call_missed',
        dedupKey: 'ctm:CA9101:missed',
        data: expect.objectContaining({ call_status: 'missed' }),
      }),
    );
  });

  it('string talk_time "0" (webhook JSON) still classifies as missed', async () => {
    await ingestCall(
      prisma,
      ORG_ID,
      { ...INBOUND_HANGUP_END, sid: 'CA9102', talk_time: '0' },
      'end',
    );

    expect(p.callSession.upsert.mock.calls[0][0].create.status).toBe('missed');
  });

  it('hangup WITH talk time stays completed (a real conversation ended)', async () => {
    await ingestCall(
      prisma,
      ORG_ID,
      {
        ...INBOUND_HANGUP_END,
        sid: 'CA9103',
        direction: 'outbound',
        talk_time: 7,
      },
      'end',
    );

    expect(p.callSession.upsert.mock.calls[0][0].create.status).toBe('completed');
    expect(emitMock).not.toHaveBeenCalled();
  });

  it('outbound hangup with zero talk time is missed but rings no bell', async () => {
    await ingestCall(
      prisma,
      ORG_ID,
      { ...INBOUND_HANGUP_END, sid: 'CA9104', direction: 'outbound' },
      'end',
    );

    expect(p.callSession.upsert.mock.calls[0][0].create.status).toBe('missed');
    expect(emitMock).not.toHaveBeenCalled();
  });
});

describe('call_incoming removal (ingest-only model — inbound rings the cell, not the app)', () => {
  it('an inbound starts event emits no notification at all', async () => {
    await ingestCall(
      prisma,
      ORG_ID,
      {
        sid: 'CA9105',
        account_id: 500001,
        caller_number: '+15550001111',
        tracking_number: '+12019037784',
        direction: 'inbound',
        unix_time: 1_752_000_000,
      },
      'starts',
    );

    expect(p.callSession.upsert).toHaveBeenCalledTimes(1);
    expect(emitMock).not.toHaveBeenCalled();
  });
});
