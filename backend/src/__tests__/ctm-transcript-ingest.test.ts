/**
 * ctm-transcript-ingest.test.ts — SERV10X-65 slice: transcript capture +
 * answered-by attribution for forwarded calls + the lazy transcript endpoint.
 *
 * CTM transcribes upstream and its `end` payloads carry `transcription_text`
 * (speaker-labelled text) — but ingest never captured it, so the drawer showed
 * "Transcript is still being generated." forever. The `transcription` key is a
 * URL PATH (/api/v1/…/transcription.json), never text. Completed inbound calls
 * answered on an external forwarded phone (Northwind Services' real routing) carry no
 * `agent` object and used to ingest as answered_by kind 'none' → rendered
 * "No answer" for calls that were answered.
 *
 * The insight half of the same card: ingest read `a.notes` into the `summary`
 * column, but `notes` is empty on all 51 stored Northwind Services payloads while
 * CTM's own `summary` string (a real AI call summary) is populated on 6 of 34
 * `end` events - so the Calls "Insights" column could never be anything but
 * "—". CTM derives the summary from the transcript, so it arrives on the same
 * async schedule and rides the same lazy re-pull.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { ingestCall, transcriptOf, summaryOf, transcriptTurnsOf } from '../lib/ctm/ingest';
import { Prisma } from '@prisma/client';
import { isCtmConfigured, getCall, getCallTranscription } from '../lib/ctm/client';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, mockAuthAs, authHeader } from './helpers';

vi.mock('../services/notifications/notificationService', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const ORG_ID = 'org-1';
const CALL_END = {
  sid: 'CA9001',
  account_id: 500001,
  caller_number: '+15555550199',
  tracking_number: '+12395395911',
  direction: 'inbound',
  dial_status: 'answered',
  talk_time: 28,
  unix_time: 1_752_400_000,
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
});

// ─── transcriptOf reader ────────────────────────────────────────────────────

describe('transcriptOf', () => {
  it('reads transcription_text', () => {
    expect(transcriptOf({ transcription_text: 'Emanuel Dahan: Hello? Ma.' })).toBe(
      'Emanuel Dahan: Hello? Ma.',
    );
  });

  it('never treats the transcription URL path as text', () => {
    expect(
      transcriptOf({ transcription: '/api/v1/accounts/500001/calls/4347062651/transcription.json' }),
    ).toBeNull();
    expect(transcriptOf({ transcript: 'https://example.com/t.json' })).toBeNull();
  });

  it('returns null for missing/empty/non-string values', () => {
    expect(transcriptOf({})).toBeNull();
    expect(transcriptOf({ transcription_text: '' })).toBeNull();
    expect(transcriptOf({ transcription_text: 42 })).toBeNull();
  });

  it('caps runaway transcripts', () => {
    const text = 'a'.repeat(30_000);
    expect(transcriptOf({ transcription_text: text })!.length).toBe(20_000);
  });
});

// ─── transcriptTurnsOf reader ───────────────────────────────────────────────

describe('transcriptTurnsOf', () => {
  const OUTLINE = [
    { speaker: 'PRINCETON    NJ', text: ' Can you hear me? ', channel: 1, s: 0.5, e: 2.1 },
    { speaker: 'Art Nakamura', text: 'Yes, go ahead.', channel: 2, s: 2.4, e: 3.9 },
  ];

  it('normalizes outline[] into speaker/text/channel/timing turns', () => {
    expect(transcriptTurnsOf({ outline: OUTLINE })).toEqual([
      { speaker: 'PRINCETON NJ', text: 'Can you hear me?', channel: 1, startSec: 0.5, endSec: 2.1 },
      { speaker: 'Art Nakamura', text: 'Yes, go ahead.', channel: 2, startSec: 2.4, endSec: 3.9 },
    ]);
  });

  it('drops entries with empty or non-string text', () => {
    expect(
      transcriptTurnsOf({ outline: [{ speaker: 'A', text: '   ', channel: 1, s: 0, e: 1 }] }),
    ).toBeNull();
    expect(
      transcriptTurnsOf({ outline: [{ speaker: 'A', text: 42, channel: 1, s: 0, e: 1 }, ...OUTLINE] }),
    ).toHaveLength(2);
  });

  it('returns null for missing, non-array, or empty outline', () => {
    expect(transcriptTurnsOf({})).toBeNull();
    expect(transcriptTurnsOf({ outline: 'not-an-array' })).toBeNull();
    expect(transcriptTurnsOf({ outline: [] })).toBeNull();
  });

  it('handles a one-sided transcript (single channel only)', () => {
    expect(transcriptTurnsOf({ outline: [OUTLINE[0]] })).toEqual([
      { speaker: 'PRINCETON NJ', text: 'Can you hear me?', channel: 1, startSec: 0.5, endSec: 2.1 },
    ]);
  });

  it('caps total turn text so a runaway transcript cannot bloat the row', () => {
    const bigOutline = Array.from({ length: 50 }, (_, i) => ({
      speaker: 'A',
      text: 'x'.repeat(500),
      channel: 1,
      s: i,
      e: i + 1,
    }));
    const turns = transcriptTurnsOf({ outline: bigOutline })!;
    const totalChars = turns.reduce((sum, t) => sum + t.text.length, 0);
    expect(totalChars).toBeLessThanOrEqual(20_000);
    expect(turns.length).toBeLessThan(50);
  });
});

// ─── ingestCall: transcript capture ─────────────────────────────────────────

describe('ingestCall — transcript capture', () => {
  it('stores transcription_text into transcript_preview on create', async () => {
    await ingestCall(prisma, ORG_ID, { ...CALL_END, transcription_text: 'A: hi\nB: hello' }, 'end');
    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.create.transcript_preview).toBe('A: hi\nB: hello');
    expect(args.update.transcript_preview).toBe('A: hi\nB: hello');
  });

  it('never writes transcript on starts and never clobbers with null', async () => {
    await ingestCall(prisma, ORG_ID, { ...CALL_END, sid: 'CA9002' }, 'starts');
    const startsArgs = p.callSession.upsert.mock.calls[0][0];
    expect(startsArgs.create.transcript_preview).toBeNull();
    expect(startsArgs.update).toEqual({});

    p.callSession.upsert.mockClear();
    await ingestCall(prisma, ORG_ID, { ...CALL_END, sid: 'CA9003' }, 'end');
    const endArgs = p.callSession.upsert.mock.calls[0][0];
    // No transcript in payload → update side must not carry the key at all.
    expect('transcript_preview' in endArgs.update).toBe(false);
  });

  it('stores outline[] into transcript_turns on create and update, never on starts', async () => {
    const outline = [{ speaker: 'A', text: 'hi', channel: 1, s: 0, e: 1 }];
    await ingestCall(prisma, ORG_ID, { ...CALL_END, sid: 'CA9007', outline }, 'end');
    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.create.transcript_turns).toEqual([
      { speaker: 'A', text: 'hi', channel: 1, startSec: 0, endSec: 1 },
    ]);
    expect(args.update.transcript_turns).toEqual(args.create.transcript_turns);

    p.callSession.upsert.mockClear();
    await ingestCall(prisma, ORG_ID, { ...CALL_END, sid: 'CA9008' }, 'starts');
    expect(p.callSession.upsert.mock.calls[0][0].create.transcript_turns).toBe(Prisma.JsonNull);
    expect('transcript_turns' in p.callSession.upsert.mock.calls[0][0].update).toBe(false);
  });
});

// ─── summaryOf reader ───────────────────────────────────────────────────────

describe('summaryOf', () => {
  it("reads CTM's AI call summary", () => {
    expect(
      summaryOf({ summary: 'Agent Emanuel Dahan called the contact (PRINCETON NJ).' }),
    ).toBe('Agent Emanuel Dahan called the contact (PRINCETON NJ).');
  });

  it('falls back to notes only when there is no summary', () => {
    expect(summaryOf({ notes: 'manual note' })).toBe('manual note');
    expect(summaryOf({ summary: 'ai summary', notes: 'manual note' })).toBe('ai summary');
  });

  // Every one of the 51 real Northwind Services payloads carries notes as "" - the
  // reason the old `summary: a.notes` read could never populate the column.
  it('treats an empty notes string as absent', () => {
    expect(summaryOf({ notes: '' })).toBeNull();
    expect(summaryOf({ summary: '', notes: '   ' })).toBeNull();
    expect(summaryOf({})).toBeNull();
  });

  it('ignores non-string values and caps a runaway summary', () => {
    expect(summaryOf({ summary: { general: 'nope' } })).toBeNull();
    expect(summaryOf({ summary: 42 })).toBeNull();
    expect(summaryOf({ summary: 'a'.repeat(10_000) })!.length).toBe(4_000);
  });

  // `activity_analysis` is CTM's AskAI panel: 9 sections of which only
  // `general` is a real call summary (the other 8 are B2B-SaaS template prose -
  // "No product or feature was demonstrated"). Take `general` as a fallback so
  // a call that only got the AskAI pass still shows an insight; the top-level
  // `summary` is the more specific narrative and keeps precedence.
  it('falls back to activity_analysis.general when there is no summary', () => {
    const analysis = {
      general: 'This was a very brief outbound call with only greeting and hang-up.',
      demo: 'No product or feature was demonstrated or discussed.',
      sales: 'Not applicable - there was no sales content or pitch.',
    };
    expect(summaryOf({ activity_analysis: analysis })).toBe(
      'This was a very brief outbound call with only greeting and hang-up.',
    );
    expect(summaryOf({ summary: 'ai summary', activity_analysis: analysis })).toBe('ai summary');
  });

  it('prefers activity_analysis.general over the manual notes field', () => {
    expect(
      summaryOf({ activity_analysis: { general: 'ask-ai general' }, notes: 'manual note' }),
    ).toBe('ask-ai general');
  });

  it('never reads the other eight activity_analysis sections', () => {
    expect(summaryOf({ activity_analysis: { demo: 'No product was demonstrated.' } })).toBeNull();
    expect(summaryOf({ activity_analysis: { general: '   ' } })).toBeNull();
    expect(summaryOf({ activity_analysis: { general: 42 } })).toBeNull();
    expect(summaryOf({ activity_analysis: 'not-an-object' })).toBeNull();
  });
});

// ─── ingestCall: AI insight capture ─────────────────────────────────────────

describe('ingestCall - insight capture', () => {
  it("stores CTM's summary, not the always-empty notes field", async () => {
    await ingestCall(
      prisma,
      ORG_ID,
      { ...CALL_END, summary: 'Caller asked about a shower install.', notes: '' },
      'end',
    );
    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.create.summary).toBe('Caller asked about a shower install.');
    expect(args.update.summary).toBe('Caller asked about a shower install.');
  });

  it('never writes summary on starts and never clobbers a stored one with null', async () => {
    await ingestCall(prisma, ORG_ID, { ...CALL_END, sid: 'CA9005' }, 'starts');
    const startsArgs = p.callSession.upsert.mock.calls[0][0];
    expect(startsArgs.create.summary).toBeNull();
    expect(startsArgs.update).toEqual({});

    p.callSession.upsert.mockClear();
    await ingestCall(prisma, ORG_ID, { ...CALL_END, sid: 'CA9006' }, 'end');
    const endArgs = p.callSession.upsert.mock.calls[0][0];
    expect('summary' in endArgs.update).toBe(false);
  });
});

// ─── ingestCall: answered-by attribution ────────────────────────────────────

describe('ingestCall — answered_by attribution', () => {
  it("marks a completed inbound call with no agent as answered by an external forwarded phone", async () => {
    await ingestCall(prisma, ORG_ID, { ...CALL_END, receiving_number_id: 3835511 }, 'end');
    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.create.answered_by).toEqual({ kind: 'external', receiving_number_id: '3835511' });
    expect(args.update.answered_by).toEqual({ kind: 'external', receiving_number_id: '3835511' });
  });

  it('keeps csr attribution when an agent answered in the CTM app', async () => {
    await ingestCall(
      prisma,
      ORG_ID,
      { ...CALL_END, agent: { id: 'USR1', name: 'Emanuel Dahan', email: 'e@x.com' } },
      'end',
    );
    const args = p.callSession.upsert.mock.calls[0][0];
    expect(args.create.answered_by.kind).toBe('csr');
    expect(args.update.answered_by.kind).toBe('csr');
  });

  it('keeps kind none for missed calls and for ringing starts', async () => {
    await ingestCall(prisma, ORG_ID, { ...CALL_END, dial_status: 'no-answer' }, 'end');
    expect(p.callSession.upsert.mock.calls[0][0].create.answered_by.kind).toBe('none');

    p.callSession.upsert.mockClear();
    await ingestCall(prisma, ORG_ID, { ...CALL_END, sid: 'CA9004' }, 'starts');
    expect(p.callSession.upsert.mock.calls[0][0].create.answered_by.kind).toBe('none');
  });

  it('outbound completed calls without an agent stay none (requested-by stamping lands with the attribution slice)', async () => {
    await ingestCall(
      prisma,
      ORG_ID,
      { ...CALL_END, direction: 'outbound', called_number: '+15555550199' },
      'end',
    );
    expect(p.callSession.upsert.mock.calls[0][0].create.answered_by.kind).toBe('none');
  });
});

// ─── GET /api/communication/calls/:id/transcript ────────────────────────────

const CALL_ID = 'cd000000-0000-0000-0000-000000000001';

describe('GET /api/communication/calls/:id/transcript', () => {
  beforeEach(() => {
    clearTokenCache();
    clearPermissionCache();
  });

  it('404s for a cross-org/unknown call', async () => {
    mockAuthAs('dispatcher');
    p.callSession.findFirst.mockResolvedValue(null);
    const res = await request(app)
      .get(`/api/communication/calls/${CALL_ID}/transcript`)
      .set(authHeader('dispatcher'));
    expect(res.status).toBe(404);
  });

  it('returns stored text without calling CTM when transcript, summary, and turns are already populated', async () => {
    mockAuthAs('dispatcher');
    const storedTurns = [{ speaker: 'A', text: 'hi', channel: 1, startSec: 0, endSec: 1 }];
    p.callSession.findFirst.mockResolvedValue({
      id: CALL_ID,
      ctm_call_id: 'CA9001',
      transcript_preview: 'stored text',
      summary: 'stored summary',
      transcript_turns: storedTurns,
    });
    const res = await request(app)
      .get(`/api/communication/calls/${CALL_ID}/transcript`)
      .set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transcript: 'stored text', summary: 'stored summary', turns: storedTurns });
    expect(getCall).not.toHaveBeenCalled();
  });

  // CTM derives the summary FROM the transcript, so it can land after one. A
  // stored transcript must not short-circuit the re-pull while the insight is
  // still missing, or the Insights column stays blank forever.
  it('still re-pulls when the transcript is stored but the summary is not', async () => {
    mockAuthAs('dispatcher');
    (isCtmConfigured as any).mockReturnValue(true);
    p.callSession.findFirst.mockResolvedValue({
      id: CALL_ID,
      ctm_call_id: 'CA9001',
      transcript_preview: 'stored text',
      summary: null,
    });
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: '500001' });
    (getCall as any).mockResolvedValue({ summary: 'late insight' });
    p.callSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .get(`/api/communication/calls/${CALL_ID}/transcript`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transcript: 'stored text', summary: 'late insight', turns: null });
    expect(getCall).toHaveBeenCalledWith('500001', 'CA9001');
    // Only the newly-found field is written; the stored transcript is not rewritten.
    const update = p.callSession.updateMany.mock.calls[0][0];
    expect(update.data).toEqual({ summary: 'late insight' });
    expect(update.where.id).toBe(CALL_ID);
    expect(update.where.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('persists a transcript and a summary that arrive together', async () => {
    mockAuthAs('dispatcher');
    (isCtmConfigured as any).mockReturnValue(true);
    p.callSession.findFirst.mockResolvedValue({
      id: CALL_ID,
      ctm_call_id: 'CA9001',
      transcript_preview: null,
      summary: null,
    });
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: '500001' });
    (getCall as any).mockResolvedValue({
      transcription_text: 'A: hi',
      summary: 'Caller asked about a shower install.',
    });
    p.callSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .get(`/api/communication/calls/${CALL_ID}/transcript`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      transcript: 'A: hi',
      summary: 'Caller asked about a shower install.',
      turns: null,
    });
    expect(p.callSession.updateMany.mock.calls[0][0].data).toEqual({
      transcript_preview: 'A: hi',
      summary: 'Caller asked about a shower install.',
    });
  });

  it('fetches from CTM, persists, and returns when nothing is stored', async () => {
    mockAuthAs('dispatcher');
    (isCtmConfigured as any).mockReturnValue(true);
    p.callSession.findFirst.mockResolvedValue({
      id: CALL_ID,
      ctm_call_id: 'CA9001',
      transcript_preview: null,
    });
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: '500001' });
    (getCall as any).mockResolvedValue({ transcription_text: 'fresh text' });
    p.callSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .get(`/api/communication/calls/${CALL_ID}/transcript`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transcript: 'fresh text', summary: null, turns: null });
    expect(getCall).toHaveBeenCalledWith('500001', 'CA9001');
    const update = p.callSession.updateMany.mock.calls[0][0];
    expect(update.data.transcript_preview).toBe('fresh text');
    expect(update.where.id).toBe(CALL_ID);
    expect(update.where.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('dereferences the transcription URL when only the URL-shape is present, and persists it (t4)', async () => {
    mockAuthAs('dispatcher');
    (isCtmConfigured as any).mockReturnValue(true);
    p.callSession.findFirst.mockResolvedValue({
      id: CALL_ID,
      ctm_call_id: 'CA9001',
      transcript_preview: null,
    });
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: '500001' });
    (getCall as any).mockResolvedValue({
      transcription: '/api/v1/accounts/500001/calls/4347062651/transcription.json',
    });
    (getCallTranscription as any).mockResolvedValue({ transcript_text: 'from the json resource' });
    p.callSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .get(`/api/communication/calls/${CALL_ID}/transcript`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transcript: 'from the json resource', summary: null, turns: null });
    expect(getCallTranscription).toHaveBeenCalledWith(
      '/api/v1/accounts/500001/calls/4347062651/transcription.json',
    );
    const update = p.callSession.updateMany.mock.calls[0][0];
    expect(update.data.transcript_preview).toBe('from the json resource');
    expect(update.where.id).toBe(CALL_ID);
  });

  it('captures outline[] into turns from the same transcription doc that supplies the flat fallback text', async () => {
    mockAuthAs('dispatcher');
    (isCtmConfigured as any).mockReturnValue(true);
    p.callSession.findFirst.mockResolvedValue({
      id: CALL_ID,
      ctm_call_id: 'CA9001',
      transcript_preview: null,
    });
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: '500001' });
    (getCall as any).mockResolvedValue({
      transcription: '/api/v1/accounts/500001/calls/4347062651/transcription.json',
    });
    (getCallTranscription as any).mockResolvedValue({
      transcript_text: 'from the json resource',
      outline: [{ speaker: 'PRINCETON NJ', text: 'hello', channel: 1, s: 0, e: 1 }],
    });
    p.callSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .get(`/api/communication/calls/${CALL_ID}/transcript`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.turns).toEqual([
      { speaker: 'PRINCETON NJ', text: 'hello', channel: 1, startSec: 0, endSec: 1 },
    ]);
    const update = p.callSession.updateMany.mock.calls[0][0];
    expect(update.data.transcript_turns).toEqual(res.body.turns);
  });

  it('still dereferences the transcription URL for turns even when inline transcript text already arrived', async () => {
    mockAuthAs('dispatcher');
    (isCtmConfigured as any).mockReturnValue(true);
    p.callSession.findFirst.mockResolvedValue({
      id: CALL_ID,
      ctm_call_id: 'CA9001',
      transcript_preview: null,
    });
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: '500001' });
    (getCall as any).mockResolvedValue({
      transcription_text: 'inline text wins',
      transcription: '/api/v1/accounts/500001/calls/4347062651/transcription.json',
    });
    // The doc has not diarized this call yet — no outline — so turns stays null.
    (getCallTranscription as any).mockResolvedValue({ transcript_text: 'ignored, flat text already won' });
    p.callSession.updateMany.mockResolvedValue({ count: 1 });

    const res = await request(app)
      .get(`/api/communication/calls/${CALL_ID}/transcript`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transcript: 'inline text wins', summary: null, turns: null });
    expect(getCallTranscription).toHaveBeenCalledWith(
      '/api/v1/accounts/500001/calls/4347062651/transcription.json',
    );
    expect(p.callSession.updateMany.mock.calls[0][0].data).toEqual({
      transcript_preview: 'inline text wins',
    });
  });

  it('returns null quietly when CTM is unconfigured or the fetch fails', async () => {
    mockAuthAs('dispatcher');
    (isCtmConfigured as any).mockReturnValue(false);
    p.callSession.findFirst.mockResolvedValue({
      id: CALL_ID,
      ctm_call_id: 'CA9001',
      transcript_preview: null,
    });
    let res = await request(app)
      .get(`/api/communication/calls/${CALL_ID}/transcript`)
      .set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transcript: null, summary: null, turns: null });
    expect(getCall).not.toHaveBeenCalled();

    (isCtmConfigured as any).mockReturnValue(true);
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: '500001' });
    (getCall as any).mockRejectedValue(new Error('ctm down'));
    res = await request(app)
      .get(`/api/communication/calls/${CALL_ID}/transcript`)
      .set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ transcript: null, summary: null, turns: null });
    expect(p.callSession.updateMany).not.toHaveBeenCalled();
  });
});
