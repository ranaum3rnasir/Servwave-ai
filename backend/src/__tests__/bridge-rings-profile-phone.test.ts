// Mobile slice 21 (build half) - the click-to-call bridge rings the CALLER's own
// profile phone first, chosen by the server switch CTM_BRIDGE_RING_CALLER.
//
// - off (the default): the CTM body is byte-for-byte today's, the profile phone
//   is never read, and a user with no profile phone can still call.
// - call_number_caller (PROVEN on a live staging call, 2026-10-03): the body is
//   { from_number: TPN, call_number: the caller's phone, to_number: the customer }
//   and nothing else; CTM rings call_number first.
// - any other mode: the body carries that mode's ring-first field(s), the same
//   for every role; a caller with no usable profile phone (or one with an
//   extension), or missing from the spike agent map in an agent mode, is
//   refused BEFORE anything is written or sent to CTM.
//
// The CTM client is mocked (setup.ts); nothing here reaches the vendor.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import { env } from '../config/env';
import { logger } from '../lib/logger';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { ALPHA_ORG_ID, TEST_USERS, mockAuthAs, authHeader } from './helpers';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;
const mutableEnv = env as any;

const CUSTOMER_ID = 'c0000000-0000-0000-0000-000000000001';
const OUT_BODY = {
  direction: 'out',
  from_number: '(551) 282-7064',
  to_number: '(555) 123-4567',
  status: 'ringing',
  customer_id: CUSTOMER_ID,
};
const TODAY_BODY = { from_number: 'TPN-A', call_number: '+15551234567' };
const CALLER_E164 = '+16095550142';

function mockConnectedOrg() {
  client.isCtmConfigured.mockReturnValue(true);
  p.organization.findUnique.mockResolvedValue({ ctm_account_id: 'acct-test' });
  p.phoneNumber.findFirst.mockResolvedValue({ ctm_number_id: 'TPN-A' });
  p.customer.findFirst.mockResolvedValue({ id: CUSTOMER_ID });
  p.pendingCallAttribution.create.mockResolvedValue({ id: 'pending-1' });
  p.pendingCallAttribution.deleteMany.mockResolvedValue({ count: 0 });
  client.placeCall.mockResolvedValue({ status: 'success' });
  p.auditLog.create.mockResolvedValue({});
}

/** The caller's profile phone, as the controller reads it fresh from the DB. */
function mockProfilePhone(phone: string | null, phone_ext: string | null = null) {
  p.user.findFirst.mockResolvedValue({ phone, phone_ext });
}

function post(role: 'admin' | 'dispatcher' | 'technician' = 'dispatcher') {
  return request(app).post('/api/communication/calls').set(authHeader(role)).send(OUT_BODY);
}

function expectNothingWrittenOrPlaced() {
  expect(client.placeCall).not.toHaveBeenCalled();
  expect(p.pendingCallAttribution.create).not.toHaveBeenCalled();
  expect(p.callSession.create).not.toHaveBeenCalled();
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  client.isCtmConfigured.mockReturnValue(false);
  mutableEnv.CTM_BRIDGE_RING_CALLER = 'off';
  mutableEnv.CTM_BRIDGE_AGENT_IDS = new Map();
});

afterEach(() => {
  client.isOutboundAllowed.mockReturnValue(true);
  mutableEnv.CTM_BRIDGE_RING_CALLER = 'off';
  mutableEnv.CTM_BRIDGE_AGENT_IDS = new Map();
});

describe('bridge ring-first switch OFF (default) - zero behaviour change', () => {
  it("sends today's exact body and never reads the profile phone", async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockProfilePhone(CALLER_E164);

    const res = await post();

    expect(res.status).toBe(202);
    expect(client.placeCall).toHaveBeenCalledTimes(1);
    expect(client.placeCall.mock.calls[0]).toStrictEqual(['acct-test', TODAY_BODY]);
    expect(p.user.findFirst).not.toHaveBeenCalled();
  });

  it('a user with NO profile phone can still call while the switch is off', async () => {
    mockAuthAs('technician');
    mockConnectedOrg();
    mockProfilePhone(null, '12');

    const res = await post('technician');

    expect(res.status).toBe(202);
    expect(client.placeCall.mock.calls[0]).toStrictEqual(['acct-test', TODAY_BODY]);
  });
});

describe('bridge ring-first switch ON - each mode sends its candidate body', () => {
  it('call_number_caller: call_number = the caller profile phone (E.164), to_number = the customer, nothing else', async () => {
    mutableEnv.CTM_BRIDGE_RING_CALLER = 'call_number_caller';
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockProfilePhone('(609) 555-0142');

    const res = await post();

    expect(res.status).toBe(202);
    expect(client.placeCall).toHaveBeenCalledTimes(1);
    expect(client.placeCall.mock.calls[0]).toStrictEqual([
      'acct-test',
      { from_number: 'TPN-A', call_number: '+16095550142', to_number: '+15551234567' },
    ]);
    // The profile phone is read for THIS caller, inside THIS org.
    expect(p.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TEST_USERS.dispatcher.id, organization_id: ALPHA_ORG_ID },
      }),
    );
    // The happy path still writes the attribution stash (so the refusal tests'
    // "nothing written" assertions below are not vacuous).
    expect(p.pendingCallAttribution.create).toHaveBeenCalled();
  });

  it('to_number_user_id: to_number plus user_id = the caller agent id', async () => {
    mutableEnv.CTM_BRIDGE_RING_CALLER = 'to_number_user_id';
    mutableEnv.CTM_BRIDGE_AGENT_IDS = new Map([[TEST_USERS.dispatcher.id, 'agent-77']]);
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockProfilePhone(CALLER_E164);

    const res = await post();

    expect(res.status).toBe(202);
    expect(client.placeCall.mock.calls[0]).toStrictEqual([
      'acct-test',
      { ...TODAY_BODY, to_number: CALLER_E164, user_id: 'agent-77' },
    ]);
    // The agent id never leaves the server.
    expect(JSON.stringify(res.body)).not.toContain('agent-77');
  });

  it('to_agent: to_agent = the caller agent id, no to_number', async () => {
    mutableEnv.CTM_BRIDGE_RING_CALLER = 'to_agent';
    mutableEnv.CTM_BRIDGE_AGENT_IDS = new Map([[TEST_USERS.dispatcher.id, 'agent-77']]);
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockProfilePhone(CALLER_E164);

    const res = await post();

    expect(res.status).toBe(202);
    expect(client.placeCall.mock.calls[0]).toStrictEqual([
      'acct-test',
      { ...TODAY_BODY, to_agent: 'agent-77' },
    ]);
  });

  it.each(['admin', 'dispatcher', 'technician'] as const)(
    'role-agnostic: a %s gets the same ring-first leg',
    async (role) => {
      mutableEnv.CTM_BRIDGE_RING_CALLER = 'call_number_caller';
      mockAuthAs(role);
      mockConnectedOrg();
      mockProfilePhone(CALLER_E164);

      const res = await post(role);

      expect(res.status).toBe(202);
      expect(client.placeCall.mock.calls[0]).toStrictEqual([
        'acct-test',
        { from_number: 'TPN-A', call_number: CALLER_E164, to_number: '+15551234567' },
      ]);
    },
  );

  it("the outbound allowlist keeps checking the CUSTOMER number, never the caller's phone", async () => {
    mutableEnv.CTM_BRIDGE_RING_CALLER = 'call_number_caller';
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockProfilePhone(CALLER_E164);

    await post();

    expect(client.isOutboundAllowed).toHaveBeenCalledWith('+15551234567');
    expect(client.isOutboundAllowed).not.toHaveBeenCalledWith(CALLER_E164);
  });

  it('call_number_caller: an allowlist holding ONLY the customer lets the call through', async () => {
    mutableEnv.CTM_BRIDGE_RING_CALLER = 'call_number_caller';
    client.isOutboundAllowed.mockImplementation((n: string) => n === '+15551234567');
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockProfilePhone(CALLER_E164);

    const res = await post();

    expect(res.status).toBe(202);
    expect(client.placeCall).toHaveBeenCalledTimes(1);
  });

  it("call_number_caller: an allowlist holding ONLY the caller's own phone refuses the call (NOT_IN_TEST_ALLOWLIST)", async () => {
    mutableEnv.CTM_BRIDGE_RING_CALLER = 'call_number_caller';
    client.isOutboundAllowed.mockImplementation((n: string) => n === CALLER_E164);
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockProfilePhone(CALLER_E164);

    const res = await post();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('NOT_IN_TEST_ALLOWLIST');
    expectNothingWrittenOrPlaced();
  });

  it('call_number_caller: the attribution stash is keyed by the CUSTOMER number, never the caller phone', async () => {
    mutableEnv.CTM_BRIDGE_RING_CALLER = 'call_number_caller';
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockProfilePhone(CALLER_E164);

    const res = await post();

    expect(res.status).toBe(202);
    expect(p.pendingCallAttribution.create).toHaveBeenCalledTimes(1);
    expect(p.pendingCallAttribution.create.mock.calls[0][0].data.to_number).toBe('+15551234567');
  });
});

describe('bridge ring-first switch ON - refusals happen before anything is written or sent', () => {
  it.each([
    ['no', null],
    ['a blank', '  '],
  ])('%s profile phone => 409 PROFILE_PHONE_REQUIRED with plain copy', async (_label, phone) => {
    mutableEnv.CTM_BRIDGE_RING_CALLER = 'call_number_caller';
    mockAuthAs('technician');
    mockConnectedOrg();
    mockProfilePhone(phone);

    const res = await post('technician');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: 'PROFILE_PHONE_REQUIRED',
      reason: 'missing',
      error: 'Add your phone number to your profile to place calls from your phone',
    });
    expectNothingWrittenOrPlaced();
  });

  it('no profile row for the caller in this org => refused as missing, never routed to anyone else', async () => {
    mutableEnv.CTM_BRIDGE_RING_CALLER = 'call_number_caller';
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    p.user.findFirst.mockResolvedValue(null);

    const res = await post();

    expect(res.status).toBe(409);
    expect(res.body).toMatchObject({ code: 'PROFILE_PHONE_REQUIRED', reason: 'missing' });
    // The lookup is scoped to the caller AND the caller's org: no other user's
    // phone can stand in for the first leg.
    expect(p.user.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: TEST_USERS.dispatcher.id, organization_id: ALPHA_ORG_ID },
      }),
    );
    expectNothingWrittenOrPlaced();
  });

  it('a profile phone on file that is not a dialable number => 409 PROFILE_PHONE_REQUIRED, reason invalid', async () => {
    mutableEnv.CTM_BRIDGE_RING_CALLER = 'call_number_caller';
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockProfilePhone('555-0142');

    const res = await post();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: 'PROFILE_PHONE_REQUIRED',
      reason: 'invalid',
      error: "Your profile phone isn't a number we can ring. Update it in your profile to place calls from your phone",
    });
    expectNothingWrittenOrPlaced();
  });

  it('an extension typed inline in the profile phone => reason extension', async () => {
    mutableEnv.CTM_BRIDGE_RING_CALLER = 'call_number_caller';
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockProfilePhone('609-555-0142 x204');

    const res = await post();

    expect(res.status).toBe(409);
    expect(res.body.code).toBe('PROFILE_PHONE_REQUIRED');
    expect(res.body.reason).toBe('extension');
    expectNothingWrittenOrPlaced();
  });

  it("calling your own profile phone => 409 CALLER_IS_CUSTOMER", async () => {
    mutableEnv.CTM_BRIDGE_RING_CALLER = 'call_number_caller';
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockProfilePhone('(555) 123-4567'); // same as OUT_BODY.to_number

    const res = await post();

    expect(res.status).toBe(409);
    expect(res.body).toEqual({ code: 'CALLER_IS_CUSTOMER', error: "You can't call your own profile phone" });
    expectNothingWrittenOrPlaced();
  });

  it('calling your own profile phone is NOT refused while the switch is off', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockProfilePhone('(555) 123-4567');

    const res = await post();

    expect(res.status).toBe(202);
  });

  it('a profile phone with an extension => 409 PROFILE_PHONE_REQUIRED, reason extension, says why', async () => {
    mutableEnv.CTM_BRIDGE_RING_CALLER = 'call_number_caller';
    mockAuthAs('admin');
    mockConnectedOrg();
    mockProfilePhone(CALLER_E164, '204');

    const res = await post('admin');

    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      code: 'PROFILE_PHONE_REQUIRED',
      reason: 'extension',
      error:
        "Your profile phone has an extension, which can't ring first. Add a direct number to your profile to place calls from your phone",
    });
    expectNothingWrittenOrPlaced();
  });

  it.each(['to_number_user_id', 'to_agent'])(
    '%s: a caller missing from the agent map is refused with de-branded copy',
    async (mode) => {
      mutableEnv.CTM_BRIDGE_RING_CALLER = mode;
      mutableEnv.CTM_BRIDGE_AGENT_IDS = new Map([['00000000-0000-0000-0000-0000000000ff', 'agent-1']]);
      mockAuthAs('dispatcher');
      mockConnectedOrg();
      mockProfilePhone(CALLER_E164);

      const res = await post();

      expect(res.status).toBe(409);
      expect(res.body.code).toBe('PHONE_CALLING_NOT_SET_UP');
      expect(res.body.error).toMatch(/ServWave support/);
      expect(JSON.stringify(res.body)).not.toMatch(/ctm|calltracking|agent-1/i);
      expectNothingWrittenOrPlaced();
    },
  );
});

describe('upstream failure logging never carries the caller phone in full', () => {
  it('call_number_caller: masks phone-like digit runs in the typed vendor reason', async () => {
    mutableEnv.CTM_BRIDGE_RING_CALLER = 'call_number_caller';
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockProfilePhone(CALLER_E164);
    client.placeCall.mockRejectedValue(new client.CtmApiError(422, 'call_number +16095550142 is not reachable'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any);

    const res = await post();

    expect(res.status).toBe(502);
    const logged = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('***0142');
    expect(logged).not.toContain('6095550142');
    warn.mockRestore();
  });

  it('call_number_caller: masks a non-typed failure message too', async () => {
    mutableEnv.CTM_BRIDGE_RING_CALLER = 'call_number_caller';
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockProfilePhone(CALLER_E164);
    client.placeCall.mockRejectedValue(new Error('could not dial +16095550142'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any);

    await post();

    const logged = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).not.toContain('6095550142');
    warn.mockRestore();
  });

  it('masking follows the MODE, not the body: to_agent (no to_number) still masks an echoed phone', async () => {
    mutableEnv.CTM_BRIDGE_RING_CALLER = 'to_agent';
    mutableEnv.CTM_BRIDGE_AGENT_IDS = new Map([[TEST_USERS.dispatcher.id, 'agent-77']]);
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    mockProfilePhone(CALLER_E164);
    client.placeCall.mockRejectedValue(new client.CtmApiError(422, 'agent phone +16095550142 is busy'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any);

    await post();

    const logged = warn.mock.calls.map((c) => c.map(String).join(' ')).join('\n');
    expect(logged).toContain('***0142');
    expect(logged).not.toContain('6095550142');
    warn.mockRestore();
  });

  it("off: logging is unchanged - the vendor reason is logged as-is, unmasked", async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    client.placeCall.mockRejectedValue(new client.CtmApiError(422, 'call_number +15551234567 is not reachable'));
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any);

    const res = await post();

    expect(res.status).toBe(502);
    expect(warn).toHaveBeenCalledWith('[ctm] click-to-call failed (422): call_number +15551234567 is not reachable');
    warn.mockRestore();
  });

  it('off: a non-typed failure is still logged with the raw error object', async () => {
    mockAuthAs('dispatcher');
    mockConnectedOrg();
    const boom = new Error('could not dial +15551234567');
    client.placeCall.mockRejectedValue(boom);
    const warn = vi.spyOn(logger, 'warn').mockImplementation(() => undefined as any);

    await post();

    expect(warn).toHaveBeenCalledWith('[ctm] click-to-call failed:', boom);
    warn.mockRestore();
  });
});
