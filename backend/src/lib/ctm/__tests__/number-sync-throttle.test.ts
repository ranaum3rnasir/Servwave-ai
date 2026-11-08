// The per-org throttle and the `changed` report on the one number-sync routine.
//
// Automatic syncs (a phone-numbers screen opening, and later an unknown number
// taking a call) must not hit the phone system on every page open: at most one
// run per org at a time, and an automatic sync is skipped when one finished in
// the last 60 seconds. The manual Sync button ignores the window but still
// joins a run already in progress.
//
// The phone-system client is the only thing mocked (globally, in setup.ts).
// The clock is injected, so "60 seconds later" is a number, not a sleep.
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { prisma } from '../../prisma';
import { logger } from '../../logger';
import * as ctmClient from '../client';
import {
  AUTO_SYNC_WAIT_MS,
  AUTO_SYNC_WINDOW_MS,
  numberSyncThrottleSize,
  resetNumberSyncThrottle,
  STOP_SYNC_WAIT_MS,
  stopRunningSync,
  syncNumbers,
  type NumberSyncTrigger,
} from '../numberSync';
import { installPhoneNumberStore } from './phoneNumberStore';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const ORG = 'org-1';
const OTHER_ORG = 'org-2';
const ACCOUNT = '500002';

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

let clock = 1_000_000;
const NEW_ACCOUNT = '600001';
const sync = (trigger: NumberSyncTrigger, orgId = ORG, accountId = ACCOUNT) =>
  syncNumbers({ orgId, accountId, trigger });

/** A listNumbers call that stays pending until the test settles it. */
function holdListNumbers() {
  let resolve!: (rows: unknown[]) => void;
  let reject!: (err: unknown) => void;
  client.listNumbers.mockImplementationOnce(
    () =>
      new Promise((res, rej) => {
        resolve = res;
        reject = rej;
      }),
  );
  return { resolve: (rows: unknown[]) => resolve(rows), reject: (err: unknown) => reject(err) };
}

/** Let the routine run up to its pending phone-system call. */
const flush = () => new Promise((r) => setImmediate(r));

beforeEach(() => {
  vi.clearAllMocks();
  clock = 1_000_000;
  resetNumberSyncThrottle({ now: () => clock });
  p.auditLog.create.mockResolvedValue({});
  p.organization.findUnique.mockReset();
  // The org is on the account under test unless a test says otherwise: a run
  // re-reads it after reading the list and stores nothing if the org left it.
  p.organization.findUnique.mockResolvedValue({ ctm_account_id: ACCOUNT });
  client.enableSms.mockResolvedValue('ok');
  // Drops any held answer a failed test left queued.
  client.listNumbers.mockReset();
  client.listNumbers.mockResolvedValue([remote()]);
});

describe('automatic syncs - the 60-second window', () => {
  it('calls the phone system once for two automatic syncs within 60 seconds', async () => {
    installPhoneNumberStore([{ e164: '+16097191235', sms_enabled: true, label: 'Website' }]);

    await sync('page-open');
    clock += AUTO_SYNC_WINDOW_MS - 1;
    const second = await sync('page-open');

    expect(client.listNumbers).toHaveBeenCalledTimes(1);
    expect(second.skipped).toBe(true);
    expect(second.changed).toBe(false);
    // The skipped sync still hands back the stored list, so a screen can use it.
    expect(second.numbers.map((n) => n.e164)).toEqual(['+16097191235']);
    expect(p.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('syncs again once 60 seconds have passed since the last run finished', async () => {
    installPhoneNumberStore();

    await sync('page-open');
    clock += AUTO_SYNC_WINDOW_MS;
    const second = await sync('page-open');

    expect(client.listNumbers).toHaveBeenCalledTimes(2);
    expect(second.skipped).toBe(false);
  });

  it('times the window from when the run FINISHED, not when it started', async () => {
    installPhoneNumberStore();
    const held = holdListNumbers();

    const first = sync('page-open');
    await flush();
    clock += AUTO_SYNC_WINDOW_MS + 5_000; // a slow phone system
    held.resolve([remote()]);
    await first;
    clock += 1_000;
    await sync('page-open');

    expect(client.listNumbers).toHaveBeenCalledTimes(1);
  });

  it('keeps the window per org: another org still syncs', async () => {
    installPhoneNumberStore();

    await sync('page-open', ORG);
    await sync('page-open', OTHER_ORG);

    expect(client.listNumbers).toHaveBeenCalledTimes(2);
  });

  it('counts a failed run as finished, so a phone-system outage is not retried on every page open', async () => {
    const store = installPhoneNumberStore([{ e164: '+16097191235', sms_enabled: true }]);
    client.listNumbers.mockRejectedValueOnce(new ctmClient.CtmApiError(500, 'down'));

    await expect(sync('page-open')).rejects.toBeInstanceOf(ctmClient.CtmApiError);
    clock += 10_000;
    const second = await sync('page-open');

    expect(client.listNumbers).toHaveBeenCalledTimes(1);
    expect(second).toMatchObject({ skipped: true, changed: false });
    expect(second.numbers.map((n) => n.e164)).toEqual(store.rows.map((r) => r.e164));
  });
});

describe('one run per org at a time', () => {
  it('shares one run between two concurrent automatic syncs', async () => {
    installPhoneNumberStore();
    const held = holdListNumbers();

    const a = sync('page-open');
    const b = sync('page-open');
    await flush();
    held.resolve([remote({ number: '+18555334801', id: 'TPN-new' })]);
    const [ra, rb] = await Promise.all([a, b]);

    expect(client.listNumbers).toHaveBeenCalledTimes(1);
    expect(p.auditLog.create).toHaveBeenCalledTimes(1);
    // The joiner gets the run's real outcome, not a "skipped" stand-in.
    expect(rb).toBe(ra);
    expect(rb.changed).toBe(true);
  });

  it('hands the failure to every caller that joined a run that failed', async () => {
    installPhoneNumberStore();
    const held = holdListNumbers();

    const a = sync('page-open');
    const b = sync('page-open');
    await flush();
    held.reject(new ctmClient.CtmApiError(503, 'down'));

    await expect(a).rejects.toBeInstanceOf(ctmClient.CtmApiError);
    await expect(b).rejects.toBeInstanceOf(ctmClient.CtmApiError);
    expect(client.listNumbers).toHaveBeenCalledTimes(1);
  });
});

describe('the manual Sync button', () => {
  it('syncs even inside the 60-second window', async () => {
    installPhoneNumberStore();

    await sync('page-open');
    clock += 1_000;
    const manual = await sync('manual');

    expect(client.listNumbers).toHaveBeenCalledTimes(2);
    expect(manual.skipped).toBe(false);
  });

  it('syncs again right after a failed run', async () => {
    installPhoneNumberStore();
    client.listNumbers.mockRejectedValueOnce(new ctmClient.CtmApiError(500, 'down'));

    await expect(sync('page-open')).rejects.toBeInstanceOf(ctmClient.CtmApiError);
    await sync('manual');

    expect(client.listNumbers).toHaveBeenCalledTimes(2);
  });

  it('joins a sync already running instead of starting a second one', async () => {
    installPhoneNumberStore();
    const held = holdListNumbers();

    const automatic = sync('page-open');
    const manual = sync('manual');
    await flush();
    held.resolve([remote()]);
    const [ra, rm] = await Promise.all([automatic, manual]);

    expect(client.listNumbers).toHaveBeenCalledTimes(1);
    expect(rm).toBe(ra);
  });

  it('connect also ignores the window', async () => {
    installPhoneNumberStore();

    await sync('page-open');
    await sync('connect');

    expect(client.listNumbers).toHaveBeenCalledTimes(2);
  });
});

describe('a different phone account', () => {
  it('does not let connect to a new account join a sync of the old account: it waits, then syncs the new one', async () => {
    installPhoneNumberStore();
    const oldRun = holdListNumbers();

    const automatic = sync('page-open', ORG, ACCOUNT);
    await flush();
    // Connect stores the new account on the org before it syncs.
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: NEW_ACCOUNT });
    const connect = sync('connect', ORG, NEW_ACCOUNT);
    await flush();
    // The new account is not read while the old account's run is going.
    expect(client.listNumbers.mock.calls).toEqual([[ACCOUNT]]);

    client.listNumbers.mockResolvedValueOnce([remote({ id: 'TPN-new', number: '+18555334801' })]);
    oldRun.resolve([remote()]);
    const [ra, rc] = await Promise.all([automatic, connect]);

    expect(client.listNumbers.mock.calls).toEqual([[ACCOUNT], [NEW_ACCOUNT]]);
    expect(rc).not.toBe(ra);
    expect(rc.added).toEqual(['+18555334801']);
  });

  it('still runs the new account when the old account run fails', async () => {
    installPhoneNumberStore();
    const oldRun = holdListNumbers();

    const automatic = sync('page-open', ORG, ACCOUNT);
    await flush();
    const connect = sync('connect', ORG, NEW_ACCOUNT);
    await flush();
    oldRun.reject(new ctmClient.CtmApiError(500, 'down'));

    await expect(automatic).rejects.toBeInstanceOf(ctmClient.CtmApiError);
    const rc = await connect;
    expect(rc.skipped).toBe(false);
    expect(client.listNumbers.mock.calls).toEqual([[ACCOUNT], [NEW_ACCOUNT]]);
  });

  // An automatic sync that had to wait behind another account's run asks the
  // org which account it is on NOW before starting: the run it waited for may
  // have been the org reconnecting to a different account, and syncing the old
  // one afterwards would write the old account's numbers back into the org.
  it('skips an automatic sync of the old account that waited behind a connect to a new one', async () => {
    const store = installPhoneNumberStore();
    const connectRun = holdListNumbers();
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: NEW_ACCOUNT });

    const connect = sync('connect', ORG, NEW_ACCOUNT);
    await flush();
    const stale = sync('page-open', ORG, ACCOUNT);
    await flush();
    connectRun.resolve([remote({ id: 'TPN-new', number: '+18555334801' })]);
    const [, rs] = await Promise.all([connect, stale]);

    expect(client.listNumbers.mock.calls).toEqual([[NEW_ACCOUNT]]);
    expect(rs).toMatchObject({ skipped: true, changed: false });
    expect(rs.numbers.map((n) => n.e164)).toEqual(['+18555334801']);
    expect(store.get('+16097191235')).toBeUndefined();
    expect(p.organization.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: ORG } }),
    );
  });

  it('still runs an automatic sync that waited behind another account, when the org is on its account', async () => {
    installPhoneNumberStore();
    const oldRun = holdListNumbers();
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: NEW_ACCOUNT });

    const manualOld = sync('manual', ORG, ACCOUNT);
    await flush();
    const pageOpenNew = sync('page-open', ORG, NEW_ACCOUNT);
    await flush();
    oldRun.resolve([remote()]);
    const [, rn] = await Promise.all([manualOld, pageOpenNew]);

    expect(client.listNumbers.mock.calls).toEqual([[ACCOUNT], [NEW_ACCOUNT]]);
    expect(rn.skipped).toBe(false);
  });

  it('skips the automatic sync, without reading the phone system for it, when the org account cannot be read', async () => {
    installPhoneNumberStore();
    const oldRun = holdListNumbers();
    p.organization.findUnique.mockRejectedValue(new Error('db blip'));

    const manualOld = sync('manual', ORG, ACCOUNT);
    await flush();
    const pageOpenNew = sync('page-open', ORG, NEW_ACCOUNT);
    await flush();
    oldRun.resolve([remote()]);
    const [, rn] = await Promise.all([manualOld, pageOpenNew]);

    expect(p.organization.findUnique).toHaveBeenCalled();
    expect(client.listNumbers.mock.calls).toEqual([[ACCOUNT]]);
    expect(rn).toMatchObject({ skipped: true, changed: false });
  });

  it('skips the automatic sync when the org no longer has a phone account at all', async () => {
    installPhoneNumberStore();
    const oldRun = holdListNumbers();
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: null });

    const manualOld = sync('manual', ORG, ACCOUNT);
    await flush();
    const pageOpenNew = sync('page-open', ORG, NEW_ACCOUNT);
    await flush();
    oldRun.resolve([remote()]);
    const [, rn] = await Promise.all([manualOld, pageOpenNew]);

    expect(client.listNumbers.mock.calls).toEqual([[ACCOUNT]]);
    expect(rn.skipped).toBe(true);
  });

  it('does not re-read the account for a manual sync that waited behind another account', async () => {
    installPhoneNumberStore();
    const oldRun = holdListNumbers();
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: ACCOUNT });

    const automatic = sync('page-open', ORG, ACCOUNT);
    await flush();
    const connect = sync('connect', ORG, NEW_ACCOUNT);
    await flush();
    oldRun.resolve([remote()]);
    await Promise.all([automatic, connect]);

    // Connect is how the org moves to a new account; it must never be talked
    // out of syncing it by an org row that is not updated yet.
    expect(client.listNumbers.mock.calls).toEqual([[ACCOUNT], [NEW_ACCOUNT]]);
  });

  it('applies the 60-second window only to syncs of the same account', async () => {
    installPhoneNumberStore();

    await sync('page-open', ORG, ACCOUNT);
    clock += 1_000;
    const other = await sync('page-open', ORG, NEW_ACCOUNT);
    clock += 1_000;
    const same = await sync('page-open', ORG, NEW_ACCOUNT);

    expect(other.skipped).toBe(false);
    expect(same.skipped).toBe(true);
    expect(client.listNumbers.mock.calls).toEqual([[ACCOUNT], [NEW_ACCOUNT]]);
  });
});

describe('how long an automatic caller waits', () => {
  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('gives up after the deadline with the stored list, while the run carries on and stores its result', async () => {
    const store = installPhoneNumberStore([{ e164: '+16097191235', label: 'Website', sms_enabled: true, type: 'local' }]);
    const held = holdListNumbers();

    const pageOpen = sync('page-open');
    await flush();
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_WAIT_MS);
    const answered = await pageOpen;

    expect(answered).toMatchObject({ changed: false, stillRunning: true });
    expect(answered.numbers.map((n) => n.e164)).toEqual(['+16097191235']);

    held.resolve([remote(), remote({ id: 'TPN-new', number: '+18555334801' })]);
    await vi.waitFor(() => expect(store.get('+18555334801')).toBeDefined());
    expect(p.auditLog.create).toHaveBeenCalledTimes(1);
  });

  it('answers with the run result when the run beats the deadline', async () => {
    installPhoneNumberStore();
    const held = holdListNumbers();

    const pageOpen = sync('page-open');
    await flush();
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_WAIT_MS - 1);
    held.resolve([remote()]);
    const answered = await pageOpen;

    expect(answered).toMatchObject({ changed: true, stillRunning: false });
    // The deadline timer is cleared once the run answers: a fire-and-forget
    // caller (a webhook) must not leave a 15-second timer behind every sync.
    expect(vi.getTimerCount()).toBe(0);
  });

  it('lets the next page open within the window see the late result as the stored list', async () => {
    installPhoneNumberStore();
    const held = holdListNumbers();

    const first = sync('page-open');
    await flush();
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_WAIT_MS);
    await first;
    held.resolve([remote({ id: 'TPN-new', number: '+18555334801' })]);
    await flush();
    await flush();
    clock += 1_000;
    const next = await sync('page-open');

    expect(client.listNumbers).toHaveBeenCalledTimes(1);
    expect(next.numbers.map((n) => n.e164)).toEqual(['+18555334801']);
  });

  it('never leaves an unhandled rejection when a run it gave up on later fails, and logs the failure', async () => {
    installPhoneNumberStore();
    const held = holdListNumbers();
    const unhandled = vi.fn();
    process.on('unhandledRejection', unhandled);

    try {
      const pageOpen = sync('page-open');
      await flush();
      await vi.advanceTimersByTimeAsync(AUTO_SYNC_WAIT_MS);
      await pageOpen;
      held.reject(new ctmClient.CtmApiError(503, 'down'));
      await flush();
      await flush();
      await new Promise((r) => setImmediate(r));

      expect(unhandled).not.toHaveBeenCalled();
      const logged = [...vi.mocked(logger.warn).mock.calls, ...vi.mocked(logger.error).mock.calls];
      expect(logged.some((args) => args.some((a) => a instanceof ctmClient.CtmApiError))).toBe(true);
    } finally {
      process.off('unhandledRejection', unhandled);
    }
  });

  it('keeps the manual Sync button waiting past the deadline for the real result', async () => {
    installPhoneNumberStore();
    const held = holdListNumbers();

    let settled = false;
    const manual = sync('manual').then((r) => {
      settled = true;
      return r;
    });
    await flush();
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_WAIT_MS * 3);
    expect(settled).toBe(false);

    held.resolve([remote()]);
    const result = await manual;
    expect(result).toMatchObject({ changed: true, stillRunning: false });
  });

  it('keeps connect waiting past the deadline too', async () => {
    installPhoneNumberStore();
    const held = holdListNumbers();

    let settled = false;
    const connect = sync('connect').then(() => (settled = true));
    await flush();
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_WAIT_MS * 3);
    expect(settled).toBe(false);
    held.resolve([remote()]);
    await connect;
  });

  it('bounds the wait for an automatic caller queued behind another account run as well', async () => {
    installPhoneNumberStore();
    const held = holdListNumbers();

    const manualOld = sync('manual', ORG, ACCOUNT);
    await flush();
    const pageOpenNew = sync('page-open', ORG, NEW_ACCOUNT);
    await flush();
    await vi.advanceTimersByTimeAsync(AUTO_SYNC_WAIT_MS);

    await expect(pageOpenNew).resolves.toMatchObject({ changed: false, stillRunning: true });
    held.resolve([remote()]);
    await manualOld;
  });
});

describe('throttle memory', () => {
  it('forgets an org once its window has passed, so the state does not grow with every org ever synced', async () => {
    installPhoneNumberStore();

    await sync('page-open', ORG);
    await sync('page-open', OTHER_ORG);
    expect(numberSyncThrottleSize()).toBe(2);

    clock += AUTO_SYNC_WINDOW_MS;
    await sync('manual', ORG);

    // OTHER_ORG's window is over, so it was dropped; ORG holds its new run.
    expect(numberSyncThrottleSize()).toBe(1);
  });
});

describe('changed - did the sync change what a numbers screen shows', () => {
  it('is false when the phone system holds exactly what is stored', async () => {
    installPhoneNumberStore([
      { e164: '+16097191235', label: 'Website', sms_enabled: true, type: 'local', ctm_number_id: 'TPN-1' },
    ]);

    const result = await sync('manual');

    expect(result.changed).toBe(false);
  });

  it('is true when a number was added', async () => {
    installPhoneNumberStore();

    const result = await sync('manual');

    expect(result.changed).toBe(true);
  });

  it('is true when texting was switched on for a stored calls-only number', async () => {
    installPhoneNumberStore([
      { e164: '+16097191235', label: 'Website', sms_enabled: false, type: 'local' },
    ]);
    client.listNumbers.mockResolvedValue([remote({ sms_enabled: false })]);

    const result = await sync('manual');

    expect(result.changed).toBe(true);
  });

  it('is false when the switch-on only confirms texting ServWave already stored as on', async () => {
    installPhoneNumberStore([
      { e164: '+16097191235', label: 'Website', sms_enabled: true, type: 'local' },
    ]);
    client.listNumbers.mockResolvedValue([remote({ sms_enabled: false })]);
    client.enableSms.mockResolvedValue('alreadyenabled');

    const result = await sync('manual');

    expect(result.changed).toBe(false);
  });

  it('is false when the switch-on fails and the number stays calls-only', async () => {
    installPhoneNumberStore([
      { e164: '+16097191235', label: 'Website', sms_enabled: false, type: 'local' },
    ]);
    client.listNumbers.mockResolvedValue([remote({ sms_enabled: false })]);
    client.enableSms.mockResolvedValue('failure');

    const result = await sync('manual');

    expect(result.changed).toBe(false);
  });

  it('is true when an empty name was filled', async () => {
    installPhoneNumberStore([{ e164: '+16097191235', label: null, sms_enabled: true, type: 'local' }]);

    const result = await sync('manual');

    expect(result.changed).toBe(true);
  });

  it("is true when the number's own name changed", async () => {
    installPhoneNumberStore([
      { e164: '+16097191235', label: 'Website', sms_enabled: true, type: 'local' },
    ]);
    client.listNumbers.mockResolvedValue([remote({ name: 'Paid search' })]);

    const result = await sync('manual');

    expect(result.changed).toBe(true);
  });

  it('is true when a number type changed', async () => {
    installPhoneNumberStore([
      { e164: '+16097191235', label: 'Website', sms_enabled: true, type: 'local' },
    ]);
    client.listNumbers.mockResolvedValue([remote({ type: 'tollfree' })]);

    const result = await sync('manual');

    expect(result.changed).toBe(true);
  });

  it('is true when a number was paused', async () => {
    installPhoneNumberStore([
      { e164: '+16097191235', label: 'Website', sms_enabled: true, type: 'local', status: 'active' },
    ]);
    client.listNumbers.mockResolvedValue([remote({ status: 'stopped' })]);

    const result = await sync('manual');

    expect(result.changed).toBe(true);
  });

  it('is true when a forward destination changed', async () => {
    installPhoneNumberStore([
      {
        e164: '+16097191235', label: 'Website', sms_enabled: true, type: 'local',
        route_to: { forward_to: '+16090000001' },
      },
    ]);
    client.listNumbers.mockResolvedValue([
      remote({ route_to: { type: 'receiving_number', dial: [{ number: '+16090000002' }] } }),
    ]);

    const result = await sync('manual');

    expect(result.changed).toBe(true);
  });

  it('is false when a forward destination is unchanged', async () => {
    installPhoneNumberStore([
      {
        e164: '+16097191235', label: 'Website', sms_enabled: true, type: 'local',
        route_to: { forward_to: '+16090000001' },
      },
    ]);
    client.listNumbers.mockResolvedValue([
      remote({ route_to: { type: 'receiving_number', dial: [{ number: '+16090000001' }] } }),
    ]);

    const result = await sync('manual');

    expect(result.changed).toBe(false);
  });
});

describe('automatic syncs - the audit entry', () => {
  it('writes the same numbers.synced entry as a manual sync, with the trigger recorded and no person as actor', async () => {
    installPhoneNumberStore();
    const viewer = {
      user: { id: 'user-7', organization_id: ORG, email: 'viewer@test.dev' },
      headers: {},
      socket: {},
    } as any;

    await syncNumbers({ orgId: ORG, accountId: ACCOUNT, trigger: 'page-open', req: viewer });

    expect(p.auditLog.create).toHaveBeenCalledTimes(1);
    const row = p.auditLog.create.mock.calls[0][0].data;
    expect(row).toMatchObject({
      org_id: ORG,
      action: 'numbers.synced',
      resource_type: 'Organization',
      resource_id: ORG,
      actor_id: null,
      actor_email: null,
    });
    expect(row.metadata).toEqual({
      trigger: 'page-open',
      read: 1,
      added: ['+16097191235'],
      texting_enabled: [],
      texting_failed: [],
      texting_found_on: [],
    });
  });

  it('writes no audit entry for a sync the window skipped', async () => {
    installPhoneNumberStore();

    await sync('page-open');
    await sync('page-open');

    expect(p.auditLog.create).toHaveBeenCalledTimes(1);
  });
});

// An admin can disconnect the phone account while a sync is running. Disconnect
// marks every stored phone-system number inactive; a run that carried on
// writing afterwards would put them back to active (and able to text) on an
// org that no longer has an account, so send and click-to-call would pick a
// dead number.
describe('the org disconnects while a sync is running', () => {
  it('stores nothing when the org lost its phone account while the list was being read', async () => {
    const store = installPhoneNumberStore([
      { e164: '+16097191235', status: 'inactive', sms_enabled: false, label: 'Front desk' },
    ]);
    const held = holdListNumbers();
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: ACCOUNT });

    const running = sync('manual');
    await flush();
    // The disconnect lands while the phone system is still answering.
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: null });
    held.resolve([remote({ sms_enabled: false }), remote({ id: 'TPN-2', number: '+16097190000' })]);
    const result = await running;

    expect(store.get('+16097191235')).toMatchObject({ status: 'inactive', sms_enabled: false });
    expect(store.get('+16097190000')).toBeUndefined();
    expect(client.enableSms).not.toHaveBeenCalled();
    expect(p.auditLog.create).not.toHaveBeenCalled();
    expect(result).toMatchObject({ changed: false, added: [] });
  });

  it('stores nothing when the org moved to a different account while the list was being read', async () => {
    const store = installPhoneNumberStore();
    const held = holdListNumbers();
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: NEW_ACCOUNT });

    const running = sync('manual');
    await flush();
    held.resolve([remote()]);
    await running;

    expect(store.get('+16097191235')).toBeUndefined();
  });

  it('stops before its next write once disconnect asks it to stop', async () => {
    const store = installPhoneNumberStore([
      { e164: '+16097191235', status: 'inactive', sms_enabled: false },
      { e164: '+16097190000', status: 'inactive', sms_enabled: false },
    ]);
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: ACCOUNT });
    client.listNumbers.mockResolvedValueOnce([
      remote({ sms_enabled: false }),
      remote({ id: 'TPN-2', number: '+16097190000', sms_enabled: false }),
    ]);
    let releaseSwitchOn!: (outcome: string) => void;
    client.enableSms.mockImplementationOnce(
      () => new Promise((res) => (releaseSwitchOn = res)),
    );

    const running = sync('manual');
    await vi.waitFor(() => expect(client.enableSms).toHaveBeenCalledTimes(1));
    const stopped = stopRunningSync(ORG);
    releaseSwitchOn('ok');
    await Promise.all([running, stopped]);

    // Neither number was written back as active, and the second number's
    // texting was never touched.
    expect(store.rows.map((r) => r.status)).toEqual(['inactive', 'inactive']);
    expect(store.rows.map((r) => r.sms_enabled)).toEqual([false, false]);
    expect(client.enableSms).toHaveBeenCalledTimes(1);
    // The audit entry records what the run did before it stopped, and why.
    const audit = p.auditLog.create.mock.calls.map((c: any[]) => c[0].data);
    expect(audit).toHaveLength(1);
    expect(audit[0].metadata).toMatchObject({ stopped: 'disconnected', added: [] });
  });

  it('touches the phone system no further when the stop lands while a number is being stored', async () => {
    const store = installPhoneNumberStore([
      { e164: '+16097191235', status: 'inactive', sms_enabled: false },
      { e164: '+16097190000', status: 'inactive', sms_enabled: false },
      { e164: '+16097190001', status: 'inactive', sms_enabled: false },
    ]);
    client.listNumbers.mockResolvedValueOnce([
      remote({ sms_enabled: false }),
      remote({ id: 'TPN-2', number: '+16097190000', sms_enabled: false }),
      remote({ id: 'TPN-3', number: '+16097190001', sms_enabled: false }),
    ]);
    // Hold the first number's write so the stop lands in the middle of it.
    const realUpsert = p.phoneNumber.upsert.getMockImplementation();
    let releaseWrite!: () => void;
    p.phoneNumber.upsert.mockImplementationOnce(async (args: any) => {
      await new Promise<void>((res) => (releaseWrite = res));
      return realUpsert(args);
    });

    const running = sync('manual');
    await vi.waitFor(() => expect(p.phoneNumber.upsert).toHaveBeenCalledTimes(1));
    const stopped = stopRunningSync(ORG);
    releaseWrite();
    await Promise.all([running, stopped]);

    // The write in flight lands (disconnect waits for it, then marks every
    // number inactive); nothing after it does.
    expect(client.enableSms).toHaveBeenCalledTimes(1);
    expect(p.phoneNumber.upsert).toHaveBeenCalledTimes(1);
    expect(store.get('+16097190000')).toMatchObject({ status: 'inactive', sms_enabled: false });
    expect(store.get('+16097190001')).toMatchObject({ status: 'inactive', sms_enabled: false });
  });

  it('waits for the run to settle before it answers', async () => {
    installPhoneNumberStore();
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: ACCOUNT });
    const held = holdListNumbers();

    const running = sync('manual');
    await flush();
    let settled = false;
    const stopped = stopRunningSync(ORG).then(() => {
      settled = true;
    });
    await flush();
    expect(settled).toBe(false);
    held.resolve([remote()]);
    await Promise.all([running, stopped]);
    expect(settled).toBe(true);
  });

  it("answers without rejecting when the run fails", async () => {
    installPhoneNumberStore();
    const held = holdListNumbers();

    const running = sync('manual');
    await flush();
    const stopped = stopRunningSync(ORG);
    held.reject(new ctmClient.CtmApiError(500, 'down'));

    await expect(running).rejects.toBeInstanceOf(ctmClient.CtmApiError);
    await expect(stopped).resolves.toBeUndefined();
  });

  it('stops waiting for a run that hangs once its bound has passed', async () => {
    installPhoneNumberStore();
    resetNumberSyncThrottle({ now: () => clock, stopWaitMs: 30 });
    holdListNumbers(); // never answers

    void sync('manual').catch(() => undefined);
    await flush();
    const startedAt = Date.now();
    await stopRunningSync(ORG);

    expect(Date.now() - startedAt).toBeLessThan(1_000);
  });

  it('answers at once when nothing is running for the org', async () => {
    await expect(stopRunningSync(ORG)).resolves.toBeUndefined();
  });

  it('bounds the wait at 20 seconds by default', () => {
    expect(STOP_SYNC_WAIT_MS).toBe(20_000);
  });
});

// The webhook's unknown-number sync never looks at the list a skipped or
// given-up sync hands back, so it asks for none and costs no query.
describe('a caller that needs no number list', () => {
  const syncQuietly = () =>
    syncNumbers({ orgId: ORG, accountId: ACCOUNT, trigger: 'unknown-number', needsNumbers: false });

  it('reads no stored list when the window skips its sync', async () => {
    installPhoneNumberStore([{ e164: '+16097191235', sms_enabled: true }]);
    await syncQuietly();
    p.phoneNumber.findMany.mockClear();

    const second = await syncQuietly();

    expect(second).toMatchObject({ skipped: true, changed: false, numbers: [] });
    expect(p.phoneNumber.findMany).not.toHaveBeenCalled();
  });

  it('reads no stored list when it stops waiting for a slow run', async () => {
    installPhoneNumberStore([{ e164: '+16097191235', sms_enabled: true }]);
    resetNumberSyncThrottle({ now: () => clock, autoWaitMs: 20 });
    const held = holdListNumbers();

    const result = await syncQuietly();

    expect(result).toMatchObject({ stillRunning: true, numbers: [] });
    expect(p.phoneNumber.findMany).not.toHaveBeenCalled();
    held.resolve([remote()]);
  });

  it('still hands a page-open caller the stored list when the window skips it', async () => {
    installPhoneNumberStore([{ e164: '+16097191235', sms_enabled: true }]);
    await sync('page-open');

    const second = await sync('page-open');

    expect(second.skipped).toBe(true);
    expect(second.numbers.map((n) => n.e164)).toEqual(['+16097191235']);
  });
});

// A run that disconnect stopped stores nothing. A reconnect to the same account
// made while it is still in flight (disconnect stops waiting after its bound)
// must not take that run's empty result as its own, and the stopped run must
// not count as the org's last sync.
describe('a run that disconnect stopped', () => {
  it('is not joined by a reconnect to the same account, which runs its own sync and reactivates the numbers', async () => {
    const store = installPhoneNumberStore([{ e164: '+16097191235', status: 'inactive', sms_enabled: true }]);
    resetNumberSyncThrottle({ now: () => clock, stopWaitMs: 20 });
    const stoppedRun = holdListNumbers();

    const running = sync('manual');
    await flush();
    await stopRunningSync(ORG); // gives up after its bound; the run is still reading
    // The admin reconnects the same account while the stopped run is in flight.
    const reconnect = sync('connect');
    await flush();
    client.listNumbers.mockResolvedValueOnce([remote()]);
    stoppedRun.resolve([remote()]);
    const [, rc] = await Promise.all([running, reconnect]);

    expect(client.listNumbers).toHaveBeenCalledTimes(2);
    expect(rc.read).toBe(1);
    expect(store.get('+16097191235')?.status).toBe('active');
  });

  it('does not open the 60-second window, so the next automatic sync still runs', async () => {
    installPhoneNumberStore();
    const held = holdListNumbers();

    const running = sync('manual');
    await flush();
    const stopped = stopRunningSync(ORG);
    held.resolve([remote()]);
    await Promise.all([running, stopped]);
    clock += 1_000;
    const next = await sync('page-open');

    expect(next.skipped).toBe(false);
    expect(client.listNumbers).toHaveBeenCalledTimes(2);
  });
});
