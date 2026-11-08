import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { readFileSync } from 'fs';
import { join } from 'path';

const mockEnv = vi.hoisted(() => ({
  env: {
    CTM_ACCESS_KEY: 'test-access-key' as string | undefined,
    CTM_SECRET_KEY: 'test-secret-key' as string | undefined,
    CTM_WEBHOOK_TOKEN: 'hook-token' as string | undefined,
    CTM_API_BASE: undefined as string | undefined,
    CTM_RECORDINGS_BUCKET: 'call-recordings',
    BACKEND_PUBLIC_URL: 'https://alpha-crm-test-env.onrender.com' as string | undefined,
  },
}));
vi.mock('../config/env', () => mockEnv);

import { prisma } from '../lib/prisma';
import * as ctmClient from '../lib/ctm/client';
import { installPhoneNumberStore } from '../lib/ctm/__tests__/phoneNumberStore';
import { resetNumberSyncThrottle, syncNumbers } from '../lib/ctm/numberSync';
import { validate } from '../middleware/validate';
import {
  connectCtm,
  checkCtmA2p,
  disconnectCtm,
  connectCtmSchema,
} from '../controllers/organization-ctm.controller';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

function mockRes() {
  const res: any = {};
  res.status = vi.fn().mockReturnValue(res);
  res.json = vi.fn().mockReturnValue(res);
  return res;
}

const req = (body: Record<string, unknown> = {}) =>
  ({
    body,
    headers: {},
    socket: {},
    user: { id: 'user-1', organization_id: 'org-1', email: 'admin@test.dev' },
  }) as any;

const WEBURL = (position: string) =>
  `https://alpha-crm-test-env.onrender.com/api/webhooks/ctm/${position}?token=hook-token`;

let store: ReturnType<typeof installPhoneNumberStore>;

beforeEach(() => {
  vi.clearAllMocks();
  mockEnv.env.BACKEND_PUBLIC_URL = 'https://alpha-crm-test-env.onrender.com';
  mockEnv.env.CTM_WEBHOOK_TOKEN = 'hook-token';

  client.isCtmConfigured.mockReturnValue(true);
  client.listAccounts.mockResolvedValue([
    { id: 111111, name: 'Pilot Org' },
    { id: 222222, name: 'Servwave' },
  ]);
  client.listNumbers.mockResolvedValue([
    { id: 'TPN-A', number: '+12019037784', name: 'Main line' },
    { id: 'TPN-B', number: '+12017401509', name: 'Ported line' },
  ]);
  client.enableSms.mockResolvedValue('alreadyenabled');
  client.listWebhooks.mockResolvedValue([]);
  client.createWebhook.mockResolvedValue({ id: 1 });
  client.deleteWebhook.mockResolvedValue(undefined);
  client.getA2pStatus.mockResolvedValue({ a2p_campaigns: [{ name: 'contact Customer', status: 'Approved' }] });

  p.organization.update.mockResolvedValue({ id: 'org-1' });
  p.organization.findUnique.mockResolvedValue({ ctm_account_id: '111111' });
  store = installPhoneNumberStore();
  p.phoneNumber.updateMany.mockResolvedValue({ count: 0 });
  p.auditLog.create.mockResolvedValue({});
});

describe('connectCtmSchema', () => {
  it('requires exactly one of ctm_account_id / createNew', () => {
    expect(connectCtmSchema.safeParse({ ctm_account_id: '111111' }).success).toBe(true);
    expect(connectCtmSchema.safeParse({ createNew: true, name: 'New Org' }).success).toBe(true);
    expect(connectCtmSchema.safeParse({}).success).toBe(false);
    expect(connectCtmSchema.safeParse({ ctm_account_id: '1', createNew: true, name: 'x' }).success).toBe(false);
    expect(connectCtmSchema.safeParse({ createNew: true }).success).toBe(false);
  });

  // The 400 body a failed connect gets back. A screen shows it through
  // extractApiError, which prints `field: message` whenever `field` is set, so
  // both the message AND the field must be free of internal (vendor-named)
  // field names.
  async function rejection(body: unknown) {
    const res = mockRes();
    const next = vi.fn();
    validate(connectCtmSchema)({ body } as any, res, next);
    expect(next).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(400);
    return res.json.mock.calls[0][0];
  }

  const CHOOSE = 'Choose an existing phone account or create a new one.';
  const NAME_IT = 'Enter a name for the new phone account.';

  it.each([
    ['neither an account nor a new one', {}, CHOOSE],
    ['both an account and a new one', { ctm_account_id: '111111', createNew: true, name: 'New Org' }, CHOOSE],
    ['a blank account', { ctm_account_id: '   ' }, CHOOSE],
    ['an account that is not text', { ctm_account_id: 111111 }, CHOOSE],
    ['a create flag that is not true/false', { createNew: 'yes', name: 'New Org' }, CHOOSE],
    ['a new account with no name', { createNew: true }, NAME_IT],
    ['a new account with a blank name', { createNew: true, name: '   ' }, NAME_IT],
    ['a new account with a name over 200 characters', { createNew: true, name: 'x'.repeat(201) }, 'Keep the new phone account name to 200 characters or fewer.'],
    ['an account id too long to be real', { ctm_account_id: '1'.repeat(41) }, 'That phone account was not found.'],
    ['a body that is a list, not an object', [{ ctm_account_id: '111111' }], CHOOSE],
    ['a body that is JSON null', null, CHOOSE],
    ['a body that is a bare string', 'connect', CHOOSE],
  ])('rejects %s with plain copy and no internal field name', async (_label, body, message) => {
    const sent = await rejection(body);

    expect(sent).toEqual({ error: 'Validation failed', details: [{ field: '', message }] });
    expect(JSON.stringify(sent)).not.toMatch(/ctm|createNew|account_id|\bname is\b/i);
  });

  it('passes a valid body on, trimmed', () => {
    const next = vi.fn();
    const r: any = { body: { ctm_account_id: ' 111111 ' } };
    validate(connectCtmSchema)(r, mockRes(), next);
    expect(next).toHaveBeenCalledWith();
    expect(r.body).toEqual({ ctm_account_id: '111111' });

    const created: any = { body: { createNew: true, name: '  New Org ' } };
    validate(connectCtmSchema)(created, mockRes(), next);
    expect(created.body).toEqual({ createNew: true, name: 'New Org' });
  });
});

describe('connectCtm', () => {
  it('503s when CTM keys are not configured', async () => {
    client.isCtmConfigured.mockReturnValue(false);
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '111111' }), res);
    expect(res.status).toHaveBeenCalledWith(503);
  });

  it('422s an account id that is not under the ServWave agency', async () => {
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '999999' }), res);
    expect(res.status).toHaveBeenCalledWith(422);
    // Same words as the schema's too-long-to-be-real id: one phrasing for
    // "no such phone account", naming neither the field nor ServWave's agency.
    expect(res.json).toHaveBeenCalledWith({ error: 'That phone account was not found.' });
    expect(p.organization.update).not.toHaveBeenCalled();
  });

  it('connects: stores the account id, imports BOTH numbers, provisions the four live hooks, flips sms_ready', async () => {
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '111111' }), res);

    expect(p.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'org-1' }, data: { ctm_account_id: '111111' } }),
    );
    expect(store.rows.map((r) => r.e164)).toEqual(['+12019037784', '+12017401509']);
    expect(store.get('+12019037784')).toMatchObject({
      organization_id: 'org-1',
      ctm_number_id: 'TPN-A',
      sms_enabled: true,
    });

    // `outbound_text` is deliberately NOT provisioned: measured live 2026-08-01,
    // it was registered on both connected CTM accounts and fired zero times in
    // 21 days, while `status_change` carried every outbound text instead.
    // Provisioning it advertised coverage that does not exist.
    expect(client.createWebhook).toHaveBeenCalledTimes(4);
    const positions = client.createWebhook.mock.calls.map((c: any[]) => c[1].position).sort();
    expect(positions).toEqual(['end', 'inbound_text', 'start', 'status_change']);
    expect(positions).not.toContain('outbound_text');
    // Token travels in the query string (log-redaction contract) + Basic creds set.
    expect(client.createWebhook.mock.calls[0][1].weburl).toContain('?token=hook-token');
    expect(client.createWebhook.mock.calls[0][1].username).toBe('servwave');

    expect(p.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ctm_sms_ready: true } }),
    );

    const body = res.json.mock.calls[0][0];
    expect(body.connected).toBe(true);
    expect(body.numbers_imported).toBe(2);
    expect(body.sms_ready).toBe(true);
    expect(body.webhooks_provisioned).toHaveLength(4);
  });

  it('sends CTM the position it validates (`start`) while keeping our `starts` route path', async () => {
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '111111' }), res);

    const startCall = client.createWebhook.mock.calls.find(
      (c: any[]) => String(c[1].weburl).includes('/ctm/starts?'),
    );
    expect(startCall).toBeDefined();
    // Probed live against account 500001 on 2026-08-05: CTM 406s `starts` with
    // {"position":["is not included in the list"]}. `start` is accepted.
    expect(startCall![1].position).toBe('start');
    // The path is OURS and must not follow the position - ctm-webhook.controller
    // dispatches on `starts` and 404s anything it does not know.
    expect(startCall![1].weburl).toBe(WEBURL('starts'));
  });

  it('is idempotent: existing hooks are not re-created on a second connect', async () => {
    client.listWebhooks.mockResolvedValue(
      ['starts', 'end', 'inbound_text', 'status_change'].map((pos, i) => ({
        id: i + 1,
        weburl: WEBURL(pos),
      })),
    );
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '111111' }), res);
    expect(client.createWebhook).not.toHaveBeenCalled();
    expect(res.json.mock.calls[0][0].webhooks_provisioned).toHaveLength(4);
  });

  it('409s a claim-jack (account already connected to another org)', async () => {
    p.organization.update.mockRejectedValueOnce({ code: 'P2002' });
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '111111' }), res);
    expect(res.status).toHaveBeenCalledWith(409);
    expect(store.rows).toEqual([]);
    expect(client.listNumbers).not.toHaveBeenCalled();
  });

  it('connects without provisioning when BACKEND_PUBLIC_URL is unset (warning, not failure)', async () => {
    mockEnv.env.BACKEND_PUBLIC_URL = undefined;
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '111111' }), res);
    expect(client.createWebhook).not.toHaveBeenCalled();
    const body = res.json.mock.calls[0][0];
    expect(body.connected).toBe(true);
    expect(body.warnings).toEqual([
      'Live call and text updates are not set up yet. Contact ServWave support.',
    ]);
  });

  it('surfaces a number that could not text, in plain words, instead of failing the connect', async () => {
    client.enableSms.mockResolvedValueOnce('failure').mockResolvedValueOnce('alreadyenabled');
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '111111' }), res);
    const body = res.json.mock.calls[0][0];
    expect(body.connected).toBe(true);
    expect(body.warnings).toEqual(['Texting could not be switched on for +12019037784.']);
    expect(store.get('+12019037784')!.sms_enabled).toBe(false);
    expect(store.get('+12017401509')!.sms_enabled).toBe(true);
  });

  it('reports a live-update hook the phone system refused once, in plain words', async () => {
    client.createWebhook
      .mockRejectedValueOnce(new ctmClient.CtmApiError(406, 'position is not included in the list'))
      .mockRejectedValueOnce(new ctmClient.CtmApiError(406, 'position is not included in the list'));
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '111111' }), res);
    const body = res.json.mock.calls[0][0];
    expect(body.connected).toBe(true);
    expect(body.warnings).toEqual([
      'Some live call and text updates could not be set up. Contact ServWave support.',
    ]);
  });

  it('reports a failed texting-approval check in plain words', async () => {
    client.getA2pStatus.mockRejectedValueOnce(new Error('boom'));
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '111111' }), res);
    const body = res.json.mock.calls[0][0];
    expect(body.sms_ready).toBe(false);
    expect(body.warnings).toEqual([
      'Texting approval could not be checked. Texting stays off until the check succeeds.',
    ]);
  });

  // The greeting and retention are set up by ServWave, so the step points the
  // admin at ServWave support - never at a provider behind the phone service.
  it('the manual steps point the admin at ServWave support, not a provider', async () => {
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '111111' }), res);
    const steps: string[] = res.json.mock.calls[0][0].manual_steps;
    expect(steps).toContain(
      'Contact ServWave support to set the recording-consent greeting and retention policy.',
    );
    expect(steps.join(' ')).not.toMatch(/provider|ctm|calltracking|vendor/i);
  });

  // Ran: "the account ID cannot be exposed". The connect answer reaches an
  // admin's browser, so the phone account id must not appear in it anywhere,
  // under any key, at any depth - and no warning may carry an internal code,
  // an env var or the vendor's name.
  describe('the connect answer never carries the phone account id', () => {
    function everyKey(value: unknown, keys: string[] = []): string[] {
      if (value && typeof value === 'object') {
        for (const [k, v] of Object.entries(value)) {
          keys.push(k);
          everyKey(v, keys);
        }
      }
      return keys;
    }

    function expectClean(body: unknown, accountId: string) {
      expect(JSON.stringify(body)).not.toContain(accountId);
      expect(everyKey(body).filter((k) => /account|ctm/i.test(k))).toEqual([]);
    }

    function failEverything() {
      mockEnv.env.BACKEND_PUBLIC_URL = undefined;
      client.enableSms.mockResolvedValue('failure');
      client.getA2pStatus.mockRejectedValue(new ctmClient.CtmApiError(500, 'a2p_status_failed'));
    }

    it('connecting an existing account', async () => {
      const res = mockRes();
      await connectCtm(req({ ctm_account_id: '111111' }), res);
      expect(res.json.mock.calls[0][0].connected).toBe(true);
      expectClean(res.json.mock.calls[0][0], '111111');
    });

    it('creating a new account', async () => {
      client.createAccount.mockResolvedValue({ account: { id: 612345 } });
      const res = mockRes();
      await connectCtm(req({ createNew: true, name: 'New Org' }), res);
      expect(p.organization.update).toHaveBeenCalledWith(
        expect.objectContaining({ data: { ctm_account_id: '612345' } }),
      );
      expect(res.json.mock.calls[0][0].connected).toBe(true);
      expectClean(res.json.mock.calls[0][0], '612345');
    });

    it('when every warning fires, the warnings stay plain', async () => {
      failEverything();
      const res = mockRes();
      await connectCtm(req({ ctm_account_id: '111111' }), res);
      const body = res.json.mock.calls[0][0];
      expect(body.warnings.length).toBeGreaterThan(0);
      expectClean(body, '111111');
      expect(body.warnings.join(' ')).not.toMatch(
        /ctm|calltracking|webhook|a2p|sms|BACKEND_PUBLIC_URL|_TOKEN|failure|failed\b|\(|_/i,
      );
    });
  });

  it('runs the shared number sync: a stopped number is stored paused, a single forward is kept', async () => {
    client.listNumbers.mockResolvedValue([
      {
        id: 'TPN-A',
        number: '+12019037784',
        name: 'Main line',
        status: 'stopped',
        sms_enabled: true,
        route_to: { type: 'receiving_number', dial: [{ number: '+12015550100' }] },
      },
    ]);
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '111111' }), res);

    expect(store.get('+12019037784')).toMatchObject({
      status: 'paused',
      route_to: { forward_to: '+12015550100' },
    });
  });

  it('only asks the phone system to switch texting on where it is off', async () => {
    client.listNumbers.mockResolvedValue([
      { id: 'TPN-A', number: '+12019037784', status: 'active', sms_enabled: true },
      { id: 'TPN-B', number: '+12017401509', status: 'active', sms_enabled: false },
    ]);
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '111111' }), res);

    expect(client.enableSms).toHaveBeenCalledTimes(1);
    expect(client.enableSms).toHaveBeenCalledWith('111111', 'TPN-B');
  });

  it('names an unnamed number from its source name', async () => {
    client.listNumbers.mockResolvedValue([
      { id: 'TPN-A', number: '+12019037784', name: null, source: { id: 'TSOF1', name: 'Google Ads' } },
    ]);
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '111111' }), res);

    expect(store.get('+12019037784')!.label).toBe('Google Ads');
  });

  it('a re-connect never turns texting off on a number already stored as able to text', async () => {
    store = installPhoneNumberStore([
      { organization_id: 'org-1', e164: '+12019037784', sms_enabled: true, status: 'inactive' },
    ]);
    client.enableSms.mockResolvedValue('failure');
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '111111' }), res);

    expect(store.get('+12019037784')!.sms_enabled).toBe(true);
  });

  it('records the number sync in the audit log alongside the connect', async () => {
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '111111' }), res);

    const entries = p.auditLog.create.mock.calls.map((c: any[]) => c[0].data);
    const sync = entries.find((e: any) => e.action === 'numbers.synced');
    expect(sync?.metadata).toMatchObject({ trigger: 'connect', read: 2 });
    expect(entries.map((e: any) => e.action)).toContain('ctm.connected');
  });
});

describe('checkCtmA2p', () => {
  it('flips ctm_sms_ready from the live A2P status', async () => {
    const res = mockRes();
    await checkCtmA2p(req(), res);
    expect(p.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ctm_sms_ready: true } }),
    );
    expect(res.json).toHaveBeenCalledWith({ sms_ready: true });
  });

  it('409s when the org is not connected', async () => {
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: null });
    const res = mockRes();
    await checkCtmA2p(req(), res);
    expect(res.status).toHaveBeenCalledWith(409);
  });
});

describe('disconnectCtm', () => {
  it('deletes ONLY our-host webhooks and nulls the account column', async () => {
    client.listWebhooks.mockResolvedValue([
      { id: 1, weburl: WEBURL('end') },
      { id: 2, weburl: 'https://some-other-integration.example.com/hook' },
    ]);
    const res = mockRes();
    await disconnectCtm(req(), res);
    expect(client.deleteWebhook).toHaveBeenCalledTimes(1);
    expect(client.deleteWebhook).toHaveBeenCalledWith('111111', '1');
    expect(p.organization.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: { ctm_account_id: null, ctm_sms_ready: false } }),
    );
    expect(res.json).toHaveBeenCalledWith({ connected: false });
  });

  it("deactivates the org's CTM-sourced numbers so send/call TPN resolution (status:'active') skips them", async () => {
    const res = mockRes();
    await disconnectCtm(req(), res);

    expect(p.phoneNumber.updateMany).toHaveBeenCalledWith({
      where: { organization_id: 'org-1', source: 'ctm' },
      data: { status: 'inactive' },
    });
    expect(res.json).toHaveBeenCalledWith({ connected: false });
  });

  it('a re-connect reactivates the numbers a disconnect left inactive', async () => {
    store = installPhoneNumberStore([
      { organization_id: 'org-1', e164: '+12019037784', status: 'inactive' },
      { organization_id: 'org-1', e164: '+12017401509', status: 'inactive' },
    ]);
    client.listNumbers.mockResolvedValue([
      { id: 'TPN-A', number: '+12019037784', status: 'active' },
      { id: 'TPN-B', number: '+12017401509', status: 'active' },
    ]);
    const res = mockRes();
    await connectCtm(req({ ctm_account_id: '111111' }), res);

    expect(store.rows.map((r) => r.status)).toEqual(['active', 'active']);
  });
});

// A sync can be running (a phone-numbers screen opened, a call on a new
// number) when an admin disconnects. Disconnect marks the numbers inactive; the
// run must not write them back to active afterwards.
describe('disconnectCtm while a number sync is running', () => {
  let orgAccount: string | null;

  /** A phone-system list read that stays pending until the test answers it. */
  function holdListNumbers() {
    let resolve!: (rows: unknown[]) => void;
    client.listNumbers.mockImplementationOnce(() => new Promise((res) => (resolve = res)));
    return (rows: unknown[]) => resolve(rows);
  }
  const flush = () => new Promise((r) => setImmediate(r));

  beforeEach(() => {
    resetNumberSyncThrottle();
    orgAccount = '111111';
    // The org row, as both the sync and disconnect read and write it.
    p.organization.findUnique.mockImplementation(async () => ({ ctm_account_id: orgAccount }));
    p.organization.update.mockImplementation(async (args: any) => {
      if ('ctm_account_id' in args.data) orgAccount = args.data.ctm_account_id;
      return { id: 'org-1' };
    });
    store = installPhoneNumberStore([
      { organization_id: 'org-1', e164: '+12019037784', status: 'active', sms_enabled: false },
    ]);
    p.phoneNumber.updateMany.mockImplementation(async (args: any) => {
      const hit = store.rows.filter(
        (r) => r.organization_id === args.where.organization_id && r.source === args.where.source,
      );
      for (const r of hit) Object.assign(r, args.data);
      return { count: hit.length };
    });
  });

  afterEach(() => {
    resetNumberSyncThrottle();
  });

  it('leaves the numbers inactive when the running sync finishes after the disconnect started', async () => {
    const answer = holdListNumbers();
    const running = syncNumbers({ orgId: 'org-1', accountId: '111111', trigger: 'page-open' });
    await flush();

    const res = mockRes();
    const disconnecting = disconnectCtm(req(), res);
    await flush();
    answer([{ id: 'TPN-A', number: '+12019037784', status: 'active', sms_enabled: false }]);
    await Promise.all([running, disconnecting]);

    expect(res.json).toHaveBeenCalledWith({ connected: false });
    expect(store.get('+12019037784')).toMatchObject({ status: 'inactive', sms_enabled: false });
  });

  it('marks the numbers inactive only after the running sync has settled', async () => {
    const answer = holdListNumbers();
    const running = syncNumbers({ orgId: 'org-1', accountId: '111111', trigger: 'manual' });
    await flush();

    const disconnecting = disconnectCtm(req(), mockRes());
    for (let i = 0; i < 5; i += 1) await flush();
    // Still waiting on the run: nothing marked yet, account not dropped yet.
    expect(p.phoneNumber.updateMany).not.toHaveBeenCalled();
    answer([{ id: 'TPN-A', number: '+12019037784', status: 'active', sms_enabled: true }]);
    await Promise.all([running, disconnecting]);

    expect(p.phoneNumber.updateMany).toHaveBeenCalledTimes(1);
    expect(store.get('+12019037784')?.status).toBe('inactive');
  });

  it('still disconnects when the running sync hangs, once the wait is over', async () => {
    resetNumberSyncThrottle({ stopWaitMs: 30 });
    holdListNumbers(); // the phone system never answers
    void syncNumbers({ orgId: 'org-1', accountId: '111111', trigger: 'manual' }).catch(() => undefined);
    await flush();

    const res = mockRes();
    await disconnectCtm(req(), res);

    expect(res.json).toHaveBeenCalledWith({ connected: false });
    expect(orgAccount).toBeNull();
    expect(store.get('+12019037784')?.status).toBe('inactive');
  });
});

describe('route gating (ADMIN idiom)', () => {
  it("gates all three phone org routes, and their deprecated aliases, with canDo('update','Organization')", () => {
    const src = readFileSync(join(__dirname, '../routes/organization.routes.ts'), 'utf8');
    for (const path of [
      '/phone/connect',
      '/phone/check-texting-approval',
      '/phone/disconnect',
      '/connect-ctm',
      '/connect-ctm/check-a2p',
      '/disconnect-ctm',
    ]) {
      const line = src.split('\n').find((l) => l.includes(`'${path}'`));
      expect(line, `route ${path} missing`).toBeTruthy();
      expect(line).toContain("canDo('update', 'Organization')");
    }
  });
});
/* eslint-enable @typescript-eslint/no-explicit-any */
