/**
 * ctm-voicemail-ingest.test.ts — Phone master plan Phase C, Task C4.
 *
 * RESEARCH NOTE (Supabase MCP, project redacted-staging-ref, 2026-07-16): the
 * live `ctm_events` table holds 15 stored `end` events for Northwind Services
 * (500001) and NONE of them are a voicemail — every one is either
 * agent-answered (`agent` present, dial_status "answered") or forwarded to an
 * external phone (`agent` null, dial_status "answered"/"completed",
 * `call_path`'s only hop is a `PhysicalPhoneNumber`/`CallQueue`/
 * `ConditionalRouter`/`RoutingRule`). `dial_status`/`call_status` are never
 * literally "voicemail" in any stored row, and there is no `voicemail` key in
 * the payload at all (checked via `jsonb_object_keys`). So the synthetic
 * voicemail payload below is the BEST-AVAILABLE shape, not an observed one:
 * it extends the real field set (same caller_number/tracking_number/
 * unix_time shape seen live) with a `call_path` whose last hop is a
 * `VoiceMenu` route — the CTM object routing.ts (Task C3) provisions for the
 * voicemail box, and the only route class not yet observed in real traffic.
 * See lib/ctm/ingest.ts `isVoicemailByCallPath` for the full reasoning.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest';
import { prisma } from '../lib/prisma';
import { ingestCall } from '../lib/ctm/ingest';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const ORG_ID = 'org-1';

// Real-shape base (from the live Northwind Services rows above) — inbound, no
// agent, answered by CTM's IVR rather than a human.
const BASE_END = {
  sid: 'CA9101',
  account_id: 500001,
  caller_number: '+15555550199',
  caller_number_complete: '+15555550199',
  tracking_number: '+12017401509',
  direction: 'inbound',
  unix_time: 1_784_204_219,
  agent: null,
};

// Best-available synthetic voicemail payload (no real example exists yet —
// see file header). dial_status/call_status stay "completed"/"answered"
// because CTM's Voice Menu DID answer the call; the tell is the VoiceMenu
// call_path hop + audio/transcript with no agent.
const VOICEMAIL_END = {
  ...BASE_END,
  dial_status: 'completed',
  call_status: 'answered',
  duration: 42,
  talk_time: 38,
  audio: 'https://app.calltrackingmetrics.com/api/v1/accounts/500001/calls/CA9101/recording',
  transcription: '/api/v1/accounts/500001/calls/CA9101/transcription.json',
  transcription_text: 'Hi, this is Greg — please call me back about the leak.',
  call_path: [
    {
      route_id: 'CQU182BC82C1063561EACCE9CAE5096937145B6D39BFB4D0635',
      route_name: 'Main smart ruter',
      route_type: 'CallQueue',
      started_at: '2026-07-16T13:33:23Z',
    },
    {
      route_id: 'VOM1819B95F1F30B8D29D6074F01BE71F04D8CBF51A96',
      route_name: 'Art Nakamura — Voicemail',
      route_type: 'VoiceMenu',
      started_at: '2026-07-16T13:33:41Z',
    },
  ],
};

// A normal answered call — real shape from the live rows (agent present,
// dial_status "answered", no VoiceMenu hop). Must NEVER be flagged voicemail.
const ANSWERED_END = {
  ...BASE_END,
  sid: 'CA9102',
  dial_status: 'answered',
  call_status: 'answered',
  duration: 24,
  talk_time: 16,
  agent: { id: 'USR1', name: 'Emanuel Dahan', email: 'emanuel@northwind.example.com' },
  call_path: [
    {
      route_id: 'COR1819B95F1F30B8D29D6074F01BE71F04D8CBF51A96',
      route_name: 'Main smart ruter',
      route_type: 'ConditionalRouter',
      started_at: '2026-07-16T13:33:23Z',
    },
  ],
};

// A plain missed call (no agent, no VoiceMenu hop) — must stay 'missed', not
// get swept into 'voicemail' by the call_path fallback.
const MISSED_END = {
  ...BASE_END,
  sid: 'CA9103',
  dial_status: 'no-answer',
  call_status: 'no answer',
  duration: 0,
  call_path: [
    {
      route_id: 'RPN34D8AC3F61E8848FEA641CEF711011AA',
      route_name: 'Dome OFFICE (929) 403-9424',
      route_type: 'PhysicalPhoneNumber',
      started_at: '2026-07-16T13:33:23Z',
    },
  ],
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

describe('ingestCall — voicemail disposition (call_path fallback)', () => {
  it('flags a VoiceMenu-routed, agent-less end payload as voicemail and persists recording + transcript', async () => {
    const result = await ingestCall(prisma, ORG_ID, VOICEMAIL_END, 'end');

    expect(result?.status).toBe('voicemail');
    expect(result?.hasRecording).toBe(true);

    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.create.status).toBe('voicemail');
    expect(args.create.answered_by).toEqual({
      kind: 'voicemail',
      ctm_agent_id: null,
      name: null,
      email: null,
    });
    expect(args.create.has_recording).toBe(true);
    expect(args.create.transcript_preview).toBe(
      'Hi, this is Greg — please call me back about the leak.',
    );

    expect(args.update.status).toBe('voicemail');
    expect(args.update.answered_by).toEqual({
      kind: 'voicemail',
      ctm_agent_id: null,
      name: null,
      email: null,
    });
    expect(args.update.has_recording).toBe(true);
    expect(args.update.transcript_preview).toBe(
      'Hi, this is Greg — please call me back about the leak.',
    );
  });

  it('flags voicemail when CTM literally says so in dial_status/call_status (no call_path needed)', async () => {
    await ingestCall(
      prisma,
      ORG_ID,
      { ...BASE_END, sid: 'CA9104', dial_status: 'voicemail', call_status: 'voicemail', call_path: [] },
      'end',
    );
    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.create.status).toBe('voicemail');
    expect(args.create.answered_by.kind).toBe('voicemail');
  });

  it('never flags a normal agent-answered call as voicemail', async () => {
    const result = await ingestCall(prisma, ORG_ID, ANSWERED_END, 'end');
    expect(result?.status).toBe('completed');

    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.create.status).toBe('completed');
    expect(args.create.answered_by.kind).toBe('csr');
  });

  it('never flags a plain missed call (no agent, no VoiceMenu hop) as voicemail', async () => {
    const result = await ingestCall(prisma, ORG_ID, MISSED_END, 'end');
    expect(result?.status).toBe('missed');

    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.create.status).toBe('missed');
    expect(args.create.answered_by.kind).toBe('none');
  });

  it('never flags a ringing `starts` payload as voicemail even with a VoiceMenu hop already in call_path', async () => {
    const result = await ingestCall(
      prisma,
      ORG_ID,
      { ...VOICEMAIL_END, sid: 'CA9105' },
      'starts',
    );
    expect(result?.status).toBe('ringing');
  });
});
