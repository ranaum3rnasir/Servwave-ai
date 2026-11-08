// POST /numbers/sync-if-stale - opening a phone-numbers screen syncs in the
// background.
//
// Both numbers screens show the stored list at once and call this on mount.
// It runs the shared number sync through the per-org throttle and answers
// whether anything changed plus the list, in the GET /numbers shape. Anyone
// who can read the numbers list may call it: the texting switch-on a sync
// makes is system policy, not the viewer's act. A phone-system failure is the
// viewer's problem never: the stored list comes back as it was.
//
// Only the phone-system client is mocked (globally, in setup.ts); the stored
// numbers live in an in-memory table so the assertions read what is stored.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../app';
import { prisma } from '../../lib/prisma';
import { logger } from '../../lib/logger';
import * as ctmClient from '../../lib/ctm/client';
import { resetNumberSyncThrottle, AUTO_SYNC_WINDOW_MS } from '../../lib/ctm/numberSync';
import { clearTokenCache } from '../../middleware/authenticate';
import { clearPermissionCache } from '../../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from '../../__tests__/helpers';
import { installPhoneNumberStore } from '../../lib/ctm/__tests__/phoneNumberStore';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const CTM_ACCOUNT_ID = '500002';
const OTHER_ORG_ID = '00000000-0000-0000-0000-0000000000ff';
const URL = '/api/communication/numbers/sync-if-stale';

type UserKey = 'admin' | 'dispatcher' | 'sales' | 'technician';
const syncIfStale = (who: UserKey = 'dispatcher') => {
  mockAuthAs(who);
  return request(app).post(URL).set(authHeader(who)).send({});
};
const list = (who: UserKey = 'dispatcher') => {
  mockAuthAs(who);
  return request(app).get('/api/communication/numbers').set(authHeader(who));
};

/** The org's one stored number, as the phone system also reports it. */
const STORED = {
  organization_id: ALPHA_ORG_ID,
  e164: '+16097191235',
  formatted: '(609) 719-1235',
  label: 'Website',
  type: 'local',
  sms_enabled: true,
  ctm_number_id: 'TPN-1',
};
function remote(over: Record<string, unknown> = {}) {
  return {
    id: 'TPN-1',
    number: '+16097191235',
    formatted: '(609) 719-1235',
    name: null,
    type: 'local',
    status: 'active',
    sms_enabled: true,
    route_to: { type: 'receiving_number', dial: [] },
    source: { id: 'TSOF1', name: 'Website', url: null },
    ...over,
  };
}

let clock = 5_000_000;
let store: ReturnType<typeof installPhoneNumberStore>;

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  clock = 5_000_000;
  resetNumberSyncThrottle({ now: () => clock });
  p.auditLog.create.mockResolvedValue({});

  client.isCtmConfigured.mockReturnValue(true);
  client.enableSms.mockResolvedValue('ok');
  // Only this org is connected; any other org id reads as not connected.
  p.organization.findUnique.mockImplementation(async (args: any) =>
    args?.where?.id === ALPHA_ORG_ID ? { ctm_account_id: CTM_ACCOUNT_ID } : { ctm_account_id: null },
  );
  // Drops any held answer a failed test left queued.
  client.listNumbers.mockReset();
  client.listNumbers.mockResolvedValue([remote()]);
  store = installPhoneNumberStore([
    STORED,
    { organization_id: OTHER_ORG_ID, e164: '+12125550100', label: 'Another org' },
  ]);
});

describe('who may call it', () => {
  it('lets a non-admin who can read the numbers list call it', async () => {
    const res = await syncIfStale('dispatcher');

    expect(res.status).toBe(200);
    expect(client.listNumbers).toHaveBeenCalledWith(CTM_ACCOUNT_ID);
  });

  it('gives a sales user, who cannot read the list, the same refusal as the list endpoint, and never syncs', async () => {
    const listed = await list('sales');
    const synced = await syncIfStale('sales');

    expect(listed.status).toBe(403);
    expect(synced.status).toBe(listed.status);
    expect(synced.body).toEqual(listed.body);
    expect(client.listNumbers).not.toHaveBeenCalled();
  });

  it.each(['admin', 'dispatcher', 'sales', 'technician'] as const)(
    'answers a %s with the same allow or refuse as the list endpoint',
    async (who) => {
      const listed = await list(who);
      resetNumberSyncThrottle({ now: () => clock });
      const synced = await syncIfStale(who);

      expect(synced.status).toBe(listed.status);
    },
  );
});

describe('what it answers', () => {
  it('answers in the same shape as the numbers list', async () => {
    // Nothing new at the phone system, so the list is what was already stored.
    const synced = await syncIfStale();
    const listed = await list();

    expect(synced.body.changed).toBe(false);
    expect(synced.body.numbers).toEqual(listed.body.numbers);
  });

  it('reports no change when the phone system holds what is stored', async () => {
    const res = await syncIfStale();

    expect(res.body.changed).toBe(false);
    expect(res.body.stillRunning).toBe(false);
  });

  it('reports a change, and returns the new number, when a number was added', async () => {
    client.listNumbers.mockResolvedValue([
      remote(),
      remote({ id: 'TPN-new', number: '+18555334801', formatted: '(855) 533-4801', type: 'tollfree' }),
    ]);

    const res = await syncIfStale();

    expect(res.body.changed).toBe(true);
    expect(res.body.numbers.map((n: any) => n.e164)).toEqual(['+16097191235', '+18555334801']);
  });

  it('reports a change when texting was switched on', async () => {
    store.get('+16097191235')!.sms_enabled = false;
    client.listNumbers.mockResolvedValue([remote({ sms_enabled: false })]);

    const res = await syncIfStale();

    expect(res.body.changed).toBe(true);
    expect(res.body.numbers[0].sms_enabled).toBe(true);
  });

  it('reports a change when a name was filled', async () => {
    store.get('+16097191235')!.label = null;

    const res = await syncIfStale();

    expect(res.body.changed).toBe(true);
    expect(res.body.numbers[0].label).toBe('Website');
  });
});

describe('org scoping', () => {
  it("syncs the caller's own org and returns only that org's numbers", async () => {
    client.listNumbers.mockResolvedValue([remote(), remote({ id: 'TPN-new', number: '+18555334801' })]);

    const res = await syncIfStale();

    expect(p.organization.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ALPHA_ORG_ID } }),
    );
    expect(res.body.numbers.map((n: any) => n.e164)).not.toContain('+12125550100');
    expect(store.get('+18555334801')!.organization_id).toBe(ALPHA_ORG_ID);
  });

  it('ignores an org id sent in the body or the query and syncs the caller\'s own org', async () => {
    mockAuthAs('dispatcher');
    const res = await request(app)
      .post(URL)
      .query({ orgId: OTHER_ORG_ID, organization_id: OTHER_ORG_ID })
      .set(authHeader('dispatcher'))
      .send({ orgId: OTHER_ORG_ID, organization_id: OTHER_ORG_ID });

    expect(res.status).toBe(200);
    expect(p.organization.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ALPHA_ORG_ID } }),
    );
    expect(p.organization.findUnique).not.toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: OTHER_ORG_ID } }),
    );
    expect(client.listNumbers).toHaveBeenCalledWith(CTM_ACCOUNT_ID);
    expect(res.body.numbers.map((n: any) => n.e164)).toEqual(['+16097191235']);
  });

  it('never returns another org\'s numbers, even when the sync is skipped', async () => {
    await syncIfStale();
    const res = await syncIfStale();

    expect(res.body.numbers.map((n: any) => n.e164)).toEqual(['+16097191235']);
  });
});

describe('when there is nothing to sync against', () => {
  it('returns the stored list with no change, and no phone-system call, for an org with no phone account', async () => {
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: null });

    const res = await syncIfStale();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      changed: false,
      stillRunning: false,
      numbers: [expect.objectContaining({ e164: '+16097191235' })],
    });
    expect(client.listNumbers).not.toHaveBeenCalled();
  });

  it('returns the stored list with no change when the phone service is not configured', async () => {
    client.isCtmConfigured.mockReturnValue(false);

    const res = await syncIfStale();

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.numbers).toHaveLength(1);
    expect(client.listNumbers).not.toHaveBeenCalled();
  });
});

describe('when the phone system fails', () => {
  it('returns the stored list unchanged, surfaces no error, and logs the failure', async () => {
    client.listNumbers.mockRejectedValue(new ctmClient.CtmApiError(500, 'upstream exploded'));

    const res = await syncIfStale();

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      changed: false,
      stillRunning: false,
      numbers: [expect.objectContaining({ e164: '+16097191235', label: 'Website' })],
    });
    expect(res.body.error).toBeUndefined();
    // Nothing about the failure, and never the phone account's id.
    expect(JSON.stringify(res.body)).not.toMatch(/500002|upstream exploded|phone system/i);
    expect(store.rows).toHaveLength(2);
    const logged = [...vi.mocked(logger.warn).mock.calls, ...vi.mocked(logger.error).mock.calls];
    expect(logged.some((args) => args.some((a) => a instanceof ctmClient.CtmApiError))).toBe(true);
  });

  it('logs the failed sync once, not once per layer', async () => {
    client.listNumbers.mockRejectedValue(new ctmClient.CtmApiError(500, 'upstream exploded'));

    await syncIfStale();

    const logged = [
      ...vi.mocked(logger.warn).mock.calls,
      ...vi.mocked(logger.error).mock.calls,
      ...vi.mocked(logger.info).mock.calls,
    ].filter((args) => args.some((a) => a instanceof ctmClient.CtmApiError));
    expect(logged).toHaveLength(1);
  });

  it("still logs a failure to read the org's phone account, and serves the stored list", async () => {
    const blip = new Error('db blip reading the org');
    p.organization.findUnique.mockRejectedValueOnce(blip);

    const res = await syncIfStale();

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    const logged = [...vi.mocked(logger.warn).mock.calls, ...vi.mocked(logger.error).mock.calls];
    expect(logged.filter((args) => args.includes(blip))).toHaveLength(1);
  });

  it('keeps a number calls-only and reports no change when its switch-on request throws', async () => {
    store.get('+16097191235')!.sms_enabled = false;
    client.listNumbers.mockResolvedValue([remote({ sms_enabled: false })]);
    client.enableSms.mockRejectedValue(new Error('socket hang up'));

    const res = await syncIfStale();

    expect(res.status).toBe(200);
    expect(res.body.changed).toBe(false);
    expect(res.body.numbers[0].sms_enabled).toBe(false);
  });
});

describe('the throttle', () => {
  it('calls the phone system once for two page opens within 60 seconds', async () => {
    await syncIfStale();
    clock += AUTO_SYNC_WINDOW_MS - 1;
    const second = await syncIfStale();

    expect(client.listNumbers).toHaveBeenCalledTimes(1);
    expect(second.body.changed).toBe(false);
    expect(second.body.numbers).toHaveLength(1);
  });

  it('shares one run between two page opens at the same moment', async () => {
    // Hold the phone system's answer until BOTH requests have reached the
    // sync, so the second cannot be a window skip of a run already finished.
    let answer!: (rows: unknown[]) => void;
    client.listNumbers.mockImplementationOnce(() => new Promise((res) => (answer = res)));
    mockAuthAs('dispatcher');
    const first = request(app).post(URL).set(authHeader('dispatcher')).send({}).then((r) => r);
    const second = request(app).post(URL).set(authHeader('dispatcher')).send({}).then((r) => r);
    await vi.waitFor(() => expect(p.organization.findUnique).toHaveBeenCalledTimes(2));
    await new Promise((r) => setImmediate(r));
    answer([remote(), remote({ id: 'TPN-new', number: '+18555334801' })]);
    const [a, b] = await Promise.all([first, second]);

    expect(client.listNumbers).toHaveBeenCalledTimes(1);
    // Both viewers learn about the new number from the one shared run.
    expect(a.body.changed).toBe(true);
    expect(b.body.changed).toBe(true);
  });

  it('still lets the Sync button sync inside the window', async () => {
    await syncIfStale();
    mockAuthAs('admin');
    const res = await request(app)
      .post('/api/communication/numbers/refresh')
      .set(authHeader('admin'))
      .send({});

    expect(res.status).toBe(200);
    expect(client.listNumbers).toHaveBeenCalledTimes(2);
  });

  it('does not call the phone system again on the next page open after a failure', async () => {
    client.listNumbers.mockRejectedValueOnce(new ctmClient.CtmApiError(503, 'down'));

    await syncIfStale();
    clock += 1_000;
    const res = await syncIfStale();

    expect(res.status).toBe(200);
    expect(client.listNumbers).toHaveBeenCalledTimes(1);
  });
});

describe('a slow phone system', () => {
  it('answers with the stored list once the wait runs out, and the sync still lands', async () => {
    resetNumberSyncThrottle({ now: () => clock, autoWaitMs: 30 });
    let answer!: (rows: unknown[]) => void;
    client.listNumbers.mockImplementationOnce(() => new Promise((res) => (answer = res)));

    const res = await syncIfStale();

    expect(res.status).toBe(200);
    // stillRunning tells the screen to ask again shortly for the result.
    expect(res.body).toEqual({
      changed: false,
      stillRunning: true,
      numbers: [expect.objectContaining({ e164: '+16097191235' })],
    });

    answer([remote(), remote({ id: 'TPN-new', number: '+18555334801' })]);
    await vi.waitFor(() => expect(store.get('+18555334801')).toBeDefined());
  });
});

describe('the audit entry', () => {
  it('records the automatic sync as numbers.synced with the page-open trigger and no person as actor', async () => {
    await syncIfStale('dispatcher');

    const rows = p.auditLog.create.mock.calls.map((c: any[]) => c[0].data);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      org_id: ALPHA_ORG_ID,
      action: 'numbers.synced',
      actor_id: null,
      metadata: expect.objectContaining({ trigger: 'page-open' }),
    });
  });
});
