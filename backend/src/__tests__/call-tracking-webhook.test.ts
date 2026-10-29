/**
 * External call-tracking receiver - POST /api/webhooks/call-tracking/:provider/:urlToken/:phase?
 *
 * Gates (controllers/call-tracking-webhook.controller.ts): known provider,
 * enabled row for the token, CallRail HMAC over the raw body, JSON that the
 * adapter recognises. The 200 goes out before processing; malformed bodies get
 * a 202 so the vendor never auto-disables the hook.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';
import express from 'express';
import request from 'supertest';
import crypto from 'crypto';
import webhookRoutes from '../routes/webhook.routes';
import { prisma } from '../lib/prisma';
import { logger } from '../lib/logger';

const app = express();
app.use('/api/webhooks', webhookRoutes);

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;

const TOKEN = 'a'.repeat(64);
const KEY = 'callrail-company-signing-key';
const ORG_ID = 'b0000000-0000-0000-0000-0000000000bb';
const INTEGRATION = { id: 'cti-1', organization_id: ORG_ID, signing_key: KEY };

const PRE_CALL = {
  id: 'CAL-pre-1',
  customer_phone_number: '+16095550123',
  tracking_phone_number: '+18565708007',
  start_time: '2026-09-10T10:15:30.000-04:00',
  source: 'Google Ads',
  source_name: 'Website Pool',
  medium: 'cpc',
  gclid: 'Cj0abc',
  first_call: true,
};

function sign(body: string, key = KEY): string {
  return crypto.createHmac('sha1', key).update(body).digest('base64');
}

function post(opts: { provider?: string; token?: string; phase?: string; body: string; signature?: string | null }) {
  const provider = opts.provider ?? 'callrail';
  const token = opts.token ?? TOKEN;
  const url = `/api/webhooks/call-tracking/${provider}/${token}${opts.phase ? `/${opts.phase}` : ''}`;
  let r = request(app).post(url).set('Content-Type', 'application/json');
  const sig = opts.signature === undefined ? sign(opts.body) : opts.signature;
  if (sig !== null) r = r.set('Signature', sig);
  return r.send(opts.body);
}

/** Let the post-ack setImmediate continuation settle. */
const flush = () => new Promise((r) => setImmediate(() => setImmediate(r)));

beforeEach(() => {
  vi.clearAllMocks();
  p.callTrackingIntegration.findFirst.mockResolvedValue(INTEGRATION);
  p.callTrackingIntegration.update.mockResolvedValue({});
  p.callSession.findFirst.mockResolvedValue(null);
  p.callSession.update.mockResolvedValue({});
  p.pendingCallAttribution.upsert.mockResolvedValue({ id: 'stash-1' });
});

describe('call-tracking webhook gates', () => {
  it('404s an unknown provider before touching the database', async () => {
    const res = await post({ provider: 'ctm', body: JSON.stringify(PRE_CALL) });
    expect(res.status).toBe(404);
    expect(p.callTrackingIntegration.findFirst).not.toHaveBeenCalled();
  });

  it('404s a token that resolves no enabled row (query is provider + token + enabled)', async () => {
    p.callTrackingIntegration.findFirst.mockResolvedValue(null);
    const res = await post({ token: 'b'.repeat(64), body: JSON.stringify(PRE_CALL) });
    expect(res.status).toBe(404);
    expect(p.callTrackingIntegration.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({ where: { url_token: 'b'.repeat(64), provider: 'callrail', enabled: true } }),
    );
    expect(p.pendingCallAttribution.upsert).not.toHaveBeenCalled();
  });

  it('401s a wrong Signature', async () => {
    const res = await post({ body: JSON.stringify(PRE_CALL), signature: sign('other body') });
    expect(res.status).toBe(401);
    expect(p.pendingCallAttribution.upsert).not.toHaveBeenCalled();
  });

  it('401s a missing Signature', async () => {
    const res = await post({ body: JSON.stringify(PRE_CALL), signature: null });
    expect(res.status).toBe(401);
  });

  it('401s a CallRail row that has no signing key, even with no Signature header (fail closed)', async () => {
    p.callTrackingIntegration.findFirst.mockResolvedValue({ ...INTEGRATION, signing_key: null });
    const res = await post({ body: JSON.stringify(PRE_CALL), signature: null });
    expect(res.status).toBe(401);
    expect(p.pendingCallAttribution.upsert).not.toHaveBeenCalled();
  });

  it('verifies the HMAC over the exact raw bytes (whitespace change breaks it)', async () => {
    const pretty = JSON.stringify(PRE_CALL, null, 2);
    const res = await post({ body: pretty, signature: sign(JSON.stringify(PRE_CALL)) });
    expect(res.status).toBe(401);
    const ok = await post({ body: pretty, signature: sign(pretty) });
    expect(ok.status).toBe(200);
  });

  it('202s a malformed body with a warning, never a 4xx', async () => {
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any);
    const body = '{not json';
    const res = await post({ body, signature: sign(body) });
    expect(res.status).toBe(202);
    expect(res.body).toEqual({ received: true, ignored: 'malformed' });
    expect(warn).toHaveBeenCalled();
    expect(p.pendingCallAttribution.upsert).not.toHaveBeenCalled();
    warn.mockRestore();
  });

  it('202s a JSON body the adapter does not recognise', async () => {
    const body = JSON.stringify({ hello: 'world' });
    const res = await post({ body, signature: sign(body) });
    expect(res.status).toBe(202);
    expect(res.body.ignored).toBe('unrecognised');
  });

  it('WhatConverts needs no signature: the URL token is the only gate', async () => {
    p.callTrackingIntegration.findFirst.mockResolvedValue({ ...INTEGRATION, signing_key: null });
    const body = JSON.stringify({ lead_id: 1, caller_number: '+16095550123', lead_source: 'google' });
    const res = await post({ provider: 'whatconverts', body, signature: null });
    expect(res.status).toBe(200);
  });
});

describe('call-tracking webhook processing (after the ack)', () => {
  it('a valid pre_call answers 200 {received:true} and then stashes by caller, idempotent on (provider, vendor id)', async () => {
    const res = await post({ phase: 'pre', body: JSON.stringify(PRE_CALL) });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ received: true });

    await flush();
    expect(p.callTrackingIntegration.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'cti-1' }, data: { last_event_at: expect.any(Date) } }),
    );
    expect(p.pendingCallAttribution.upsert).toHaveBeenCalledTimes(1);
    const args = p.pendingCallAttribution.upsert.mock.calls[0][0];
    expect(args.where).toEqual({ provider_vendor_call_id: { provider: 'callrail', vendor_call_id: 'CAL-pre-1' } });
    expect(args.create).toMatchObject({
      organization_id: ORG_ID,
      provider: 'callrail',
      vendor_call_id: 'CAL-pre-1',
      from_number: '+16095550123',
      to_number: '+18565708007',
      tracking_source: 'Google Ads',
      attribution: expect.objectContaining({ source: 'Google Ads', medium: 'cpc', gclid: 'Cj0abc', first_call: true }),
    });
    // The tracker's display name never becomes the source.
    expect(args.create.tracking_source).not.toBe('Website Pool');
  });

  it('a processing failure is logged and never changes the response already sent', async () => {
    const error = vi.spyOn(logger, 'error').mockImplementation(() => undefined as any);
    p.pendingCallAttribution.upsert.mockRejectedValue(new Error('db down'));
    const res = await post({ phase: 'pre', body: JSON.stringify(PRE_CALL) });
    expect(res.status).toBe(200);
    await flush();
    expect(error).toHaveBeenCalledWith(expect.stringContaining('processing failed'));
    // No phone number in the log line.
    expect(error.mock.calls[0][0]).not.toContain('6095550123');
    error.mockRestore();
  });

  it('a post_call that matches no call row merges over the pre-call stash instead of replacing it', async () => {
    // The pre-call stash is still waiting (the phone system's row has not
    // arrived); the post must add duration/recording WITHOUT losing the gclid.
    p.pendingCallAttribution.findFirst.mockResolvedValueOnce({
      attribution: { source: 'Google Ads', medium: 'cpc', gclid: 'Cj0abc', landing_page: 'https://x.test/?k=1' },
      tracking_source: 'Google Ads',
    });
    const body = JSON.stringify({
      id: 'CAL-pre-1',
      customer_phone_number: '+16095550123',
      start_time: '2026-09-10T10:15:30.000-04:00',
      duration: 47,
      recording: 'https://app.callrail.com/r/1',
    });
    const res = await post({ phase: 'post', body });
    expect(res.status).toBe(200);
    await flush();
    expect(p.pendingCallAttribution.upsert).toHaveBeenCalledTimes(1);
    const args = p.pendingCallAttribution.upsert.mock.calls[0][0];
    for (const data of [args.create, args.update]) {
      expect(data.attribution).toMatchObject({
        gclid: 'Cj0abc',
        medium: 'cpc',
        landing_page: 'https://x.test/?k=1',
        vendor_duration_sec: 47,
        vendor_recording_url: 'https://app.callrail.com/r/1',
      });
      // A post carrying no `source` keeps the pre-call's label.
      expect(data.tracking_source).toBe('Google Ads');
    }
  });

  it('a post_call whose vendor id is already on a call row enriches that row without stashing', async () => {
    p.callSession.findFirst.mockResolvedValueOnce({
      id: 'cs-9',
      attribution: { source: 'Website', medium: 'organic' },
      tracking_source: 'Website',
    });
    const body = JSON.stringify({ ...PRE_CALL, duration: 184, recording: 'https://app.callrail.com/r/1' });
    const res = await post({ phase: 'post', body });
    expect(res.status).toBe(200);
    await flush();
    expect(p.callSession.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { organization_id: ORG_ID, call_tracking_provider: 'callrail', vendor_call_id: 'CAL-pre-1' },
      }),
    );
    expect(p.callSession.update).toHaveBeenCalledTimes(1);
    const upd = p.callSession.update.mock.calls[0][0];
    expect(upd.where).toEqual({ id: 'cs-9' });
    expect(upd.data.tracking_source).toBe('Google Ads');
    expect(upd.data.attribution).toMatchObject({
      source: 'Google Ads',
      medium: 'cpc',
      vendor_duration_sec: 184,
      vendor_recording_url: 'https://app.callrail.com/r/1',
    });
    // The phone system's own duration and recording columns are untouched.
    expect(upd.data).not.toHaveProperty('duration_sec');
    expect(upd.data).not.toHaveProperty('has_recording');
    expect(p.pendingCallAttribution.upsert).not.toHaveBeenCalled();
  });
});
