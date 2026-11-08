import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';

// Mutable env double — recordings/controller read env.* at call time. Mirrors
// setup.ts (this file's mock REPLACES the global one for its whole module
// graph, so the full-app playback tests need every boot-time field too).
const mockEnv = vi.hoisted(() => ({
  env: {
    PORT: 3000,
    NODE_ENV: 'test',
    FRONTEND_URL: 'http://localhost:5173',
    TAX_RATE: 0.0875,
    DATABASE_URL: 'postgresql://test:test@localhost:5432/test',
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_SERVICE_ROLE_KEY: 'test-service-role-key',
    GEMINI_API_KEY: 'test-gemini-key',
    GEMINI_TEXT_MODEL: 'gemini-2.5-flash',
    GEMINI_LIVE_MODEL: 'gemini-2.5-flash-native-audio-preview-12-2025',
    COPILOT_VOICE_NAME: 'Puck',
    COPILOT_SESSION_MINUTES: 30,
    COPILOT_RATELIMIT_CAPACITY: 30,
    COPILOT_RATELIMIT_REFILL_PER_MIN: 15,
    CTM_ACCESS_KEY: 'test-access-key' as string | undefined,
    CTM_SECRET_KEY: 'test-secret-key' as string | undefined,
    CTM_WEBHOOK_TOKEN: 'hook-token' as string | undefined,
    CTM_API_BASE: undefined as string | undefined,
    CTM_RECORDINGS_BUCKET: 'call-recordings',
  },
}));
vi.mock('../config/env', () => mockEnv);

import app from '../app';
import { prisma } from '../lib/prisma';
import { supabaseAdmin } from '../lib/supabase';
import { logger } from '../lib/logger';
import { getRecordingResponse, CtmApiError } from '../lib/ctm/client';
import { ingestRecording } from '../lib/ctm/recordings';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, ORG_B_ID, mockAuthAs, authHeader } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const mockedGetRecording = vi.mocked(getRecordingResponse);

// setup.ts mocks storage.from with mockReturnValue → the SAME object every call.
const storageApi = (supabaseAdmin.storage.from as any)();

const CALL_ID = 'cd000000-0000-0000-0000-000000000001';

function audioResponse(contentType = 'audio/mpeg', bytes = 'fake-audio-bytes') {
  return new Response(Buffer.from(bytes), { headers: { 'content-type': contentType } });
}

function ctmError(httpStatus: number): Error {
  const err = new CtmApiError(httpStatus, `CTM API error ${httpStatus}`) as unknown as {
    httpStatus: number;
  };
  err.httpStatus = httpStatus;
  return err as unknown as Error;
}

const flushAsync = () => new Promise<void>((r) => setImmediate(r));

const INGEST_ARGS = {
  orgId: 'org-1',
  callSessionId: 'cs-1',
  ctmAccountId: '500001',
  callSid: 'CA0001',
};

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  mockEnv.env.CTM_WEBHOOK_TOKEN = 'hook-token';
  p.callSession.update.mockResolvedValue({ id: 'cs-1' });
});

// ─── Recording ingest (lib/ctm/recordings.ts) ───────────────────────────────

describe('ingestRecording', () => {
  it('downloads by sid, uploads to the private bucket and stamps recording_key (mp3)', async () => {
    mockedGetRecording.mockResolvedValue(audioResponse('audio/mpeg'));

    await ingestRecording(INGEST_ARGS);

    expect(mockedGetRecording).toHaveBeenCalledWith('500001', 'CA0001');
    expect(supabaseAdmin.storage.from).toHaveBeenCalledWith('call-recordings');
    expect(storageApi.upload).toHaveBeenCalledTimes(1);
    const [key, body, opts] = storageApi.upload.mock.calls[0];
    expect(key).toBe('org-1/cs-1.mp3');
    expect(Buffer.isBuffer(body)).toBe(true);
    expect((body as Buffer).toString('utf8')).toBe('fake-audio-bytes');
    expect(opts).toMatchObject({ contentType: 'audio/mpeg' });
    expect(p.callSession.update).toHaveBeenCalledWith({
      where: { id: 'cs-1' },
      data: { recording_key: 'org-1/cs-1.mp3' },
    });
  });

  it('maps a wav content-type to a .wav storage key', async () => {
    mockedGetRecording.mockResolvedValue(audioResponse('audio/x-wav'));

    await ingestRecording(INGEST_ARGS);

    expect(storageApi.upload.mock.calls[0][0]).toBe('org-1/cs-1.wav');
    expect(p.callSession.update).toHaveBeenCalledWith({
      where: { id: 'cs-1' },
      data: { recording_key: 'org-1/cs-1.wav' },
    });
  });

  it('terminal fetch failure (4xx) → recording_key stays null, ONE warn, no throw, no retry', async () => {
    mockedGetRecording.mockRejectedValue(ctmError(404));

    await expect(ingestRecording(INGEST_ARGS)).resolves.toBeUndefined();

    expect(mockedGetRecording).toHaveBeenCalledTimes(1); // 4xx never retries
    expect(storageApi.upload).not.toHaveBeenCalled();
    expect(p.callSession.update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('retries transient failures with backoff and succeeds on the 3rd attempt', async () => {
    mockedGetRecording
      .mockRejectedValueOnce(ctmError(0)) // network
      .mockRejectedValueOnce(ctmError(503)) // 5xx
      .mockResolvedValueOnce(audioResponse());

    await ingestRecording(INGEST_ARGS);

    expect(mockedGetRecording).toHaveBeenCalledTimes(3);
    expect(p.callSession.update).toHaveBeenCalledWith({
      where: { id: 'cs-1' },
      data: { recording_key: 'org-1/cs-1.mp3' },
    });
    expect(logger.warn).not.toHaveBeenCalled();
  });

  it('gives up after 3 transient attempts: key stays null, one warn, no throw', async () => {
    mockedGetRecording.mockRejectedValue(ctmError(0));

    await expect(ingestRecording(INGEST_ARGS)).resolves.toBeUndefined();

    expect(mockedGetRecording).toHaveBeenCalledTimes(3);
    expect(p.callSession.update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
  });

  it('upload failure leaves recording_key null and never throws', async () => {
    mockedGetRecording.mockResolvedValue(audioResponse());
    storageApi.upload.mockResolvedValue({ data: null, error: { message: 'bucket unavailable' } });

    await expect(ingestRecording(INGEST_ARGS)).resolves.toBeUndefined();

    expect(p.callSession.update).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    // restore the shared happy-path upload mock for the rest of the file
    storageApi.upload.mockResolvedValue({ data: { path: 'test/file.jpg' }, error: null });
  });

  it('caps concurrent downloads at 2 and queues the rest', async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const release: Array<() => void> = [];
    mockedGetRecording.mockImplementation(
      () =>
        new Promise<Response>((resolve) => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          release.push(() => {
            inFlight -= 1;
            resolve(audioResponse());
          });
        }),
    );

    const jobs = [1, 2, 3, 4].map((i) =>
      ingestRecording({
        orgId: 'org-1',
        callSessionId: `cs-${i}`,
        ctmAccountId: '500001',
        callSid: `CA000${i}`,
      }),
    );

    await flushAsync();
    expect(mockedGetRecording).toHaveBeenCalledTimes(2); // 2 in flight, 2 queued
    expect(maxInFlight).toBe(2);

    release[0]!();
    release[1]!();
    await vi.waitFor(() => expect(mockedGetRecording).toHaveBeenCalledTimes(4));
    expect(maxInFlight).toBe(2); // queue drained without ever exceeding the cap

    release[2]!();
    release[3]!();
    await Promise.all(jobs);
    expect(p.callSession.update).toHaveBeenCalledTimes(4);
  });
});

// ─── Webhook wiring (fetch AFTER the 200, never delaying it) ────────────────

describe('CTM webhook → recording ingest wiring', () => {
  const CALL_END_PAYLOAD = {
    sid: 'CA0001',
    id: 12345,
    account_id: 500001,
    caller_number: '+12015551234',
    tracking_number: '+12019037784',
    direction: 'inbound',
    dial_status: 'answered',
    duration: 62,
    talk_time: 48,
    unix_time: 1_752_000_000,
    audio: 'https://app.calltrackingmetrics.com/recordings/RE123',
  };

  function mockWebhookHappyPath() {
    p.ctmEvent.findUnique.mockResolvedValue(null);
    p.ctmEvent.create.mockResolvedValue({ id: 'evt-1' });
    p.organization.findFirst.mockResolvedValue({ id: 'org-1', ctm_account_id: '500001' });
    p.callSession.upsert.mockResolvedValue({ id: 'cs-1' });
    p.user.findFirst.mockResolvedValue(null);
    p.customer.findFirst.mockResolvedValue(null);
    p.lead.findFirst.mockResolvedValue(null);
    p.vendor.findFirst.mockResolvedValue(null);
    p.vendorContact.findFirst.mockResolvedValue(null);
    p.notification.findFirst.mockResolvedValue(null);
    p.$transaction.mockImplementation(async (arg: any) =>
      typeof arg === 'function' ? arg(p) : Promise.all(arg),
    );
  }

  it('kicks off ingestRecording after responding 200 to an `end` with a recording', async () => {
    mockWebhookHappyPath();
    mockedGetRecording.mockResolvedValue(audioResponse());

    const res = await request(app)
      .post('/api/webhooks/ctm/end?token=hook-token')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify(CALL_END_PAYLOAD));

    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    await vi.waitFor(() =>
      expect(p.callSession.update).toHaveBeenCalledWith({
        where: { id: 'cs-1' },
        data: { recording_key: 'org-1/cs-1.mp3' },
      }),
    );
    expect(mockedGetRecording).toHaveBeenCalledWith('500001', 'CA0001');
  });

  it('does NOT fetch a recording when the payload has none', async () => {
    mockWebhookHappyPath();

    const res = await request(app)
      .post('/api/webhooks/ctm/end?token=hook-token')
      .set('Content-Type', 'application/json')
      .send(JSON.stringify({ ...CALL_END_PAYLOAD, sid: 'CA0002', audio: undefined }));

    expect(res.status).toBe(200);
    await flushAsync();
    await flushAsync();
    expect(mockedGetRecording).not.toHaveBeenCalled();
    expect(p.callSession.update).not.toHaveBeenCalled();
  });
});

// ─── Playback endpoint (GET /api/communication/calls/:id/recording) ─────────

describe('GET /api/communication/calls/:id/recording', () => {
  it('mints a 300-second signed URL and audits recording.played', async () => {
    mockAuthAs('dispatcher');
    p.callSession.findFirst.mockResolvedValue({ id: CALL_ID, recording_key: 'org-1/cs-1.mp3' });
    p.auditLog.create.mockResolvedValue({});

    const res = await request(app)
      .get(`/api/communication/calls/${CALL_ID}/recording`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(200);
    expect(res.body.url).toContain('https://test.supabase.co/storage/v1/object/sign/');
    expect(supabaseAdmin.storage.from).toHaveBeenCalledWith('call-recordings');
    expect(storageApi.createSignedUrl).toHaveBeenCalledWith('org-1/cs-1.mp3', 300);
    // tenantWhere scoping on the row lookup
    expect(p.callSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: CALL_ID, organization_id: ALPHA_ORG_ID }),
      }),
    );
    await vi.waitFor(() =>
      expect(p.auditLog.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            action: 'recording.played',
            resource_type: 'CallSession',
            resource_id: CALL_ID,
          }),
        }),
      ),
    );
  });

  it('404s (never 500) when the call has no recording yet', async () => {
    mockAuthAs('dispatcher');
    p.callSession.findFirst.mockResolvedValue({ id: CALL_ID, recording_key: null });

    const res = await request(app)
      .get(`/api/communication/calls/${CALL_ID}/recording`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Recording not available' });
    expect(storageApi.createSignedUrl).not.toHaveBeenCalled();
    expect(p.auditLog.create).not.toHaveBeenCalled();
  });

  it("404s for another org's call id (tenantWhere keeps org B out)", async () => {
    mockAuthAs('orgB_admin');
    p.callSession.findFirst.mockResolvedValue(null); // row invisible under org B scoping

    const res = await request(app)
      .get(`/api/communication/calls/${CALL_ID}/recording`)
      .set(authHeader('orgB_admin'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Recording not available' });
    expect(p.callSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: CALL_ID, organization_id: ORG_B_ID }),
      }),
    );
    expect(storageApi.createSignedUrl).not.toHaveBeenCalled();
    expect(p.auditLog.create).not.toHaveBeenCalled();
  });

  it('404s (never 500) when the signed-URL mint fails', async () => {
    mockAuthAs('dispatcher');
    p.callSession.findFirst.mockResolvedValue({ id: CALL_ID, recording_key: 'org-1/cs-1.mp3' });
    storageApi.createSignedUrl.mockResolvedValueOnce({ data: null, error: { message: 'boom' } });

    const res = await request(app)
      .get(`/api/communication/calls/${CALL_ID}/recording`)
      .set(authHeader('dispatcher'));

    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'Recording not available' });
    expect(p.auditLog.create).not.toHaveBeenCalled();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
