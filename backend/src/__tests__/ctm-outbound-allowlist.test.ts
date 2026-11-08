// Phase-0 outbound allowlist SAFETY GUARD — env-driven. When
// CTM_OUTBOUND_ALLOWLIST is UNSET the guard is inert (unrestricted, zero
// behavior change); when SET, only listed E.164 destinations may receive an
// outbound SMS or a click-to-call, and the block happens BEFORE any CTM API
// call (the opt-out check included). Covers the pure guard (isOutboundAllowed),
// the SMS delivery-gate wiring (runGates via precheckCtmSms/sendCtmSms), and
// the click-to-call controller wiring.
import { describe, it, expect, vi, beforeEach, afterEach, beforeAll } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import { precheckCtmSms, sendCtmSms, _resetCtmSmsDoubleFireGuard } from '../lib/ctm/sendSms';
import { env } from '../config/env';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, mockAuthAs, authHeader } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const ORG_ID = ALPHA_ORG_ID;
const THREAD_ID = 'a1b2c3d4-0000-0000-0000-000000000001';
const MSG_ID = '99990000-0000-0000-0000-000000000001';
const TO = '+12015550123';

// The client module is globally mocked (setup.ts); importActual gets the REAL
// isOutboundAllowed, which reads env.CTM_OUTBOUND_ALLOWLIST at call time. The
// tests below mutate the shared (mocked) env object to toggle the allowlist —
// per-file isolation keeps that from leaking to other suites.
let isOutboundAllowed: (to: string) => boolean;
beforeAll(async () => {
  const real = await vi.importActual<typeof import('../lib/ctm/client')>('../lib/ctm/client');
  isOutboundAllowed = real.isOutboundAllowed;
});

/** Fully connected + SMS-ready + entitled org with one usable number (mirrors ctm-sms-send). */
function mockConnectedOrg() {
  client.isCtmConfigured.mockReturnValue(true);
  p.organization.findUnique.mockResolvedValue({
    ctm_account_id: '500001',
    ctm_sms_ready: true,
    sms_sending_enabled: true,
    plan: 'PRO',
    trial_ends_at: null,
    feature_overrides: { phone: true },
  });
  p.phoneNumber.findFirst.mockResolvedValue({ ctm_number_id: 'TPN-A' });
  client.isOptedOut.mockResolvedValue(false);
  client.sendSms.mockResolvedValue({ id: 'MSG123' });
  p.message.update.mockResolvedValue({ id: MSG_ID });
  p.auditLog.create.mockResolvedValue({});
}

/** Let fire-and-forget continuations (logAudit) settle. */
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  vi.clearAllMocks();
  _resetCtmSmsDoubleFireGuard();
  clearTokenCache();
  clearPermissionCache();
  // setup.ts defaults: platform unconfigured, not opted out.
  client.isCtmConfigured.mockReturnValue(false);
  client.isOptedOut.mockResolvedValue(false);
  // The guard mock defaults to "allowed" (mirrors the unset-allowlist behavior).
  client.isOutboundAllowed.mockReturnValue(true);
  // Real-guard env source: always start UNSET so a case that sets it can't leak.
  (env as any).CTM_OUTBOUND_ALLOWLIST = undefined;
});

afterEach(() => {
  (env as any).CTM_OUTBOUND_ALLOWLIST = undefined;
});

// ─── isOutboundAllowed — the pure env-driven guard ──────────────────────────

describe('isOutboundAllowed (env-driven guard)', () => {
  it('unset allowlist → allows any number (unrestricted)', () => {
    (env as any).CTM_OUTBOUND_ALLOWLIST = undefined;
    expect(isOutboundAllowed('+12015550123')).toBe(true);
    expect(isOutboundAllowed('+19998887777')).toBe(true);
  });

  it('empty / whitespace allowlist → unrestricted', () => {
    (env as any).CTM_OUTBOUND_ALLOWLIST = '   ';
    expect(isOutboundAllowed('+12015550123')).toBe(true);
  });

  it('set allowlist → allows each listed number', () => {
    (env as any).CTM_OUTBOUND_ALLOWLIST = '+12015550123,+15551230000';
    expect(isOutboundAllowed('+12015550123')).toBe(true);
    expect(isOutboundAllowed('+15551230000')).toBe(true);
  });

  it('normalizes both entries and arg — raw / paren / +1 spellings all match', () => {
    (env as any).CTM_OUTBOUND_ALLOWLIST = '2015550123, (555) 123-0000';
    expect(isOutboundAllowed('+12015550123')).toBe(true); // arg E.164 vs bare entry
    expect(isOutboundAllowed('(201) 555-0123')).toBe(true); // arg paren vs bare entry
    expect(isOutboundAllowed('+15551230000')).toBe(true); // arg E.164 vs paren entry
  });

  it('set allowlist → refuses an unlisted number', () => {
    (env as any).CTM_OUTBOUND_ALLOWLIST = '+12015550123';
    expect(isOutboundAllowed('+15551230000')).toBe(false);
    expect(isOutboundAllowed('+19998887777')).toBe(false);
  });
});

// ─── SMS delivery gate — allowlist wiring (runGates) ────────────────────────

describe('SMS delivery gate — allowlist wiring', () => {
  const sendParams = (overrides: Record<string, unknown> = {}) => ({
    orgId: ORG_ID,
    toE164: TO,
    body: 'Guard test',
    threadId: THREAD_ID,
    messageId: MSG_ID,
    ...overrides,
  });

  it('blocks an unlisted destination with NOT_IN_TEST_ALLOWLIST — before opt-out, CTM never called', async () => {
    mockConnectedOrg();
    client.isOutboundAllowed.mockReturnValue(false);

    const pre = await precheckCtmSms(prisma, {
      orgId: ORG_ID,
      toE164: TO,
      threadId: THREAD_ID,
      body: 'Guard test',
    });

    expect(pre).toEqual({ ok: false, reason: 'NOT_IN_TEST_ALLOWLIST' });
    // Blocked BEFORE the opt-out API and any send — a blocked number never
    // even reaches CTM.
    expect(client.isOptedOut).not.toHaveBeenCalled();
    expect(client.sendSms).not.toHaveBeenCalled();
    // The guard was consulted with the resolved destination.
    expect(client.isOutboundAllowed).toHaveBeenCalledWith(TO);
  });

  it('a listed destination passes the allowlist gate and delivers normally', async () => {
    mockConnectedOrg();
    client.isOutboundAllowed.mockReturnValue(true); // listed

    const result = await sendCtmSms(prisma, sendParams());
    await flush();

    expect(result).toEqual({ delivered: true });
    expect(client.isOutboundAllowed).toHaveBeenCalledWith(TO);
    // The gate advances past the guard to the normal opt-out + send path.
    expect(client.isOptedOut).toHaveBeenCalledWith('500001', TO);
    expect(client.sendSms).toHaveBeenCalledWith('500001', {
      from: 'TPN-A',
      to: TO,
      msg: 'Guard test',
    });
  });

  it('unset allowlist (guard inert) → a normal listed send still works — no regression', async () => {
    mockConnectedOrg();
    // isOutboundAllowed defaults to true (mirrors the unset allowlist) — do not
    // override it, so this exercises exactly today's behavior.
    const result = await sendCtmSms(prisma, sendParams());
    await flush();

    expect(result).toEqual({ delivered: true });
    expect(client.sendSms).toHaveBeenCalledTimes(1);
  });
});

// ─── click-to-call controller — allowlist wiring ────────────────────────────

const OUT_BODY = {
  direction: 'out',
  from_number: '(551) 282-7064',
  to_number: '(201) 555-0123', // normalizes to +12015550123
  status: 'ringing',
};

/** Org connected to CTM with one active tracking number to dial from. */
function mockConnectedCallOrg() {
  client.isCtmConfigured.mockReturnValue(true);
  p.organization.findUnique.mockResolvedValue({ ctm_account_id: '500001' });
  p.phoneNumber.findFirst.mockResolvedValue({ ctm_number_id: 'TPN-A' });
  client.placeCall.mockResolvedValue({ status: 'success' });
  p.auditLog.create.mockResolvedValue({});
}

describe('POST /api/communication/calls — click-to-call allowlist guard', () => {
  it('409s NOT_IN_TEST_ALLOWLIST for an unlisted destination — placeCall never called, no row', async () => {
    mockAuthAs('dispatcher');
    mockConnectedCallOrg();
    client.isOutboundAllowed.mockReturnValue(false);

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send(OUT_BODY);

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_IN_TEST_ALLOWLIST');
    expect(res.body.error).toBeTruthy();
    expect(client.placeCall).not.toHaveBeenCalled();
    expect(p.callSession.create).not.toHaveBeenCalled();
    // The guard was consulted with the normalized E.164 destination.
    expect(client.isOutboundAllowed).toHaveBeenCalledWith('+12015550123');
  });

  it('a listed destination places the call as before (202 queued, placeCall called, no row)', async () => {
    mockAuthAs('dispatcher');
    mockConnectedCallOrg();
    client.isOutboundAllowed.mockReturnValue(true);

    const res = await request(app)
      .post('/api/communication/calls')
      .set(authHeader('dispatcher'))
      .send(OUT_BODY);

    expect(res.status).toBe(202);
    expect(res.body).toEqual({ queued: true, outcome_since: expect.any(String) });
    expect(client.placeCall).toHaveBeenCalledWith('500001', {
      from_number: 'TPN-A',
      call_number: '+12015550123',
    });
    expect(p.callSession.create).not.toHaveBeenCalled();
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
