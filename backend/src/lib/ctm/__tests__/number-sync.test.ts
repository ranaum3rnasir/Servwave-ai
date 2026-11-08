// The one number-sync routine behind connect and the Sync button.
//
// The phone-system client is the only thing mocked (globally, in setup.ts);
// assertions read what ended up stored, what the routine returned, and which
// calls reached the phone system.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readdirSync, readFileSync, statSync } from 'fs';
import { join, relative } from 'path';
import { prisma } from '../../prisma';
import * as ctmClient from '../client';
import { stopRunningSync, syncNumbers } from '../numberSync';
import { installPhoneNumberStore } from './phoneNumberStore';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const ORG = 'org-1';
const ACCOUNT = '500002';

/** A provider number record in the live shape (2026-08-12 response). */
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

const sync = () => syncNumbers({ orgId: ORG, accountId: ACCOUNT, trigger: 'manual' });

beforeEach(() => {
  vi.clearAllMocks();
  p.auditLog.create.mockResolvedValue({});
  client.enableSms.mockResolvedValue('ok');
  // The org is on the account being synced (a run re-reads it after the list).
  p.organization.findUnique.mockResolvedValue({ ctm_account_id: ACCOUNT });
});

describe('syncNumbers - what a sync writes', () => {
  it('adds a number the account holds and ServWave does not', async () => {
    const store = installPhoneNumberStore();
    client.listNumbers.mockResolvedValue([remote({ id: 'TPN-new', number: '+18555334801', type: 'tollfree' })]);

    const result = await sync();

    expect(store.get('+18555334801')).toMatchObject({
      organization_id: ORG,
      ctm_number_id: 'TPN-new',
      type: 'tollfree',
      source: 'ctm',
    });
    expect(result.read).toBe(1);
    expect(result.added).toEqual(['+18555334801']);
    expect(result.numbers.map((n) => n.e164)).toEqual(['+18555334801']);
  });

  it('updates a number already on file without counting it as added', async () => {
    const store = installPhoneNumberStore([
      { e164: '+16097191235', ctm_number_id: 'TPN-old', type: null },
    ]);
    client.listNumbers.mockResolvedValue([remote({ id: 'TPN-1', type: 'local' })]);

    const result = await sync();

    expect(store.rows).toHaveLength(1);
    expect(store.get('+16097191235')).toMatchObject({ ctm_number_id: 'TPN-1', type: 'local' });
    expect(result.added).toEqual([]);
  });

  it('counts a number the phone system lists twice once, and writes it once', async () => {
    // The list is oldest-first and paged; a number shifting across a page
    // boundary mid-walk shows up on two pages.
    const store = installPhoneNumberStore();
    client.listNumbers.mockResolvedValue([
      remote({ id: 'TPN-dup', number: '+16097191235', sms_enabled: false }),
      remote({ id: 'TPN-other', number: '+16090000009' }),
      remote({ id: 'TPN-dup', number: '+16097191235', sms_enabled: false }),
    ]);

    const result = await sync();

    expect(store.rows).toHaveLength(2);
    expect(result.read).toBe(2);
    expect(result.added).toEqual(['+16097191235', '+16090000009']);
    expect(result.textingEnabled).toEqual(['+16097191235']);
    expect(client.enableSms).toHaveBeenCalledTimes(1);
  });
});

describe('syncNumbers - switching texting on', () => {
  it('switches texting on for a number that has it off, and stores it as able to text', async () => {
    const store = installPhoneNumberStore();
    client.listNumbers.mockResolvedValue([remote({ id: 'TPN-calls-only', sms_enabled: false })]);
    client.enableSms.mockResolvedValue('ok');

    const result = await sync();

    expect(client.enableSms).toHaveBeenCalledWith(ACCOUNT, 'TPN-calls-only');
    expect(store.get('+16097191235')!.sms_enabled).toBe(true);
    expect(result.textingEnabled).toEqual(['+16097191235']);
    expect(result.textingFailed).toEqual([]);
  });

  it('switches texting on for a number ServWave already had stored as calls-only', async () => {
    const store = installPhoneNumberStore([{ e164: '+16097191235', sms_enabled: false }]);
    client.listNumbers.mockResolvedValue([remote({ sms_enabled: false })]);

    const result = await sync();

    expect(store.get('+16097191235')!.sms_enabled).toBe(true);
    expect(result.textingEnabled).toEqual(['+16097191235']);
  });

  it('leaves the phone system alone for a number that can already text', async () => {
    const store = installPhoneNumberStore();
    client.listNumbers.mockResolvedValue([remote({ sms_enabled: true })]);

    const result = await sync();

    expect(client.enableSms).not.toHaveBeenCalled();
    expect(store.get('+16097191235')!.sms_enabled).toBe(true);
    expect(result.textingEnabled).toEqual([]);
  });

  it('stores "already enabled" as able to text', async () => {
    const store = installPhoneNumberStore([{ e164: '+16097191235', sms_enabled: false }]);
    client.listNumbers.mockResolvedValue([remote({ sms_enabled: false })]);
    client.enableSms.mockResolvedValue('alreadyenabled');

    const result = await sync();

    expect(store.get('+16097191235')!.sms_enabled).toBe(true);
    expect(result.textingFailed).toEqual([]);
  });

  it.each(['notfound', 'failure'] as const)(
    'keeps a number calls-only when switching texting on answers "%s", and reports it',
    async (outcome) => {
      const store = installPhoneNumberStore();
      client.listNumbers.mockResolvedValue([remote({ sms_enabled: false })]);
      client.enableSms.mockResolvedValue(outcome);

      const result = await sync();

      expect(store.get('+16097191235')!.sms_enabled).toBe(false);
      expect(result.textingEnabled).toEqual([]);
      expect(result.textingFailed).toEqual([{ e164: '+16097191235', outcome }]);
    },
  );

  it('keeps going when the phone system errors on one number, and reports that number', async () => {
    const store = installPhoneNumberStore();
    client.listNumbers.mockResolvedValue([
      remote({ id: 'TPN-a', number: '+16090000001', sms_enabled: false }),
      remote({ id: 'TPN-b', number: '+16090000002', sms_enabled: false }),
    ]);
    client.enableSms
      .mockRejectedValueOnce(new ctmClient.CtmApiError(500, 'boom'))
      .mockResolvedValueOnce('ok');

    const result = await sync();

    expect(store.get('+16090000001')!.sms_enabled).toBe(false);
    expect(store.get('+16090000002')!.sms_enabled).toBe(true);
    expect(result.textingFailed).toEqual([{ e164: '+16090000001', outcome: 'error' }]);
    expect(result.textingEnabled).toEqual(['+16090000002']);
  });

  it('retries a number that failed last time on the next sync', async () => {
    const store = installPhoneNumberStore();
    client.listNumbers.mockResolvedValue([remote({ sms_enabled: false })]);
    client.enableSms.mockResolvedValueOnce('failure').mockResolvedValueOnce('ok');

    await sync();
    const second = await sync();

    expect(client.enableSms).toHaveBeenCalledTimes(2);
    expect(store.get('+16097191235')!.sms_enabled).toBe(true);
    expect(second.textingEnabled).toEqual(['+16097191235']);
  });

  it('reports a calls-only number the phone system gave no id for, since texting cannot be switched on without one', async () => {
    const store = installPhoneNumberStore();
    client.listNumbers.mockResolvedValue([remote({ id: null, sms_enabled: false })]);

    const result = await sync();

    expect(client.enableSms).not.toHaveBeenCalled();
    expect(store.get('+16097191235')!.sms_enabled).toBe(false);
    expect(result.textingFailed).toEqual([{ e164: '+16097191235', outcome: 'noid' }]);
    const audit = p.auditLog.create.mock.calls[0][0].data.metadata;
    expect(audit.texting_failed).toEqual([{ e164: '+16097191235', outcome: 'noid' }]);
  });

  it('never turns texting off on a stored number', async () => {
    const store = installPhoneNumberStore([{ e164: '+16097191235', sms_enabled: true }]);
    client.listNumbers.mockResolvedValue([remote({ sms_enabled: false })]);
    client.enableSms.mockResolvedValue('failure');

    await sync();

    expect(store.get('+16097191235')!.sms_enabled).toBe(true);
  });
});

describe('syncNumbers - naming', () => {
  it("stores a number's own name from the phone system", async () => {
    const store = installPhoneNumberStore();
    client.listNumbers.mockResolvedValue([remote({ name: 'NYC line' })]);

    await sync();

    expect(store.get('+16097191235')!.label).toBe('NYC line');
  });

  it("lets the number's own name replace a stored name", async () => {
    const store = installPhoneNumberStore([{ e164: '+16097191235', label: 'Old name' }]);
    client.listNumbers.mockResolvedValue([remote({ name: 'Paid search' })]);

    await sync();

    expect(store.get('+16097191235')!.label).toBe('Paid search');
  });

  it('fills an empty stored name from the source name when the number has no own name', async () => {
    const store = installPhoneNumberStore([{ e164: '+16097191235', label: null }]);
    client.listNumbers.mockResolvedValue([
      remote({ name: null, source: { id: 'TSOF9', name: 'Google Ads', url: null } }),
    ]);

    await sync();

    expect(store.get('+16097191235')!.label).toBe('Google Ads');
  });

  it('names a newly added number from its source name when it has no own name', async () => {
    const store = installPhoneNumberStore();
    client.listNumbers.mockResolvedValue([
      remote({ name: '  ', source: { id: 'TSOF9', name: 'Google Ads', url: null } }),
    ]);

    await sync();

    expect(store.get('+16097191235')!.label).toBe('Google Ads');
  });

  it('never overwrites a stored name with a source name', async () => {
    const store = installPhoneNumberStore([{ e164: '+16097191235', label: 'Front desk' }]);
    client.listNumbers.mockResolvedValue([
      remote({ name: null, source: { id: 'TSOF9', name: 'Google Ads', url: null } }),
    ]);

    await sync();

    expect(store.get('+16097191235')!.label).toBe('Front desk');
  });

  it('keeps an empty name when the number has neither its own name nor a source name', async () => {
    const store = installPhoneNumberStore();
    client.listNumbers.mockResolvedValue([remote({ name: null, source: null })]);

    await sync();

    expect(store.get('+16097191235')!.label).toBeNull();
  });
});

describe('syncNumbers - status and forwarding', () => {
  it('stores a stopped number as paused, and an active one as active', async () => {
    const store = installPhoneNumberStore([{ e164: '+16095968565', status: 'active' }]);
    client.listNumbers.mockResolvedValue([
      remote({ id: 'TPN-stopped', number: '+16095968565', status: 'stopped' }),
      remote({ id: 'TPN-live', number: '+16097191235', status: 'active' }),
    ]);

    await sync();

    expect(store.get('+16095968565')!.status).toBe('paused');
    expect(store.get('+16097191235')!.status).toBe('active');
  });

  it('reactivates a number left inactive by a disconnect when the account reports it active', async () => {
    const store = installPhoneNumberStore([{ e164: '+16097191235', status: 'inactive' }]);
    client.listNumbers.mockResolvedValue([remote({ status: 'active' })]);

    await sync();

    expect(store.get('+16097191235')!.status).toBe('active');
  });

  it('stores the destination of a single-destination forward', async () => {
    const store = installPhoneNumberStore();
    client.listNumbers.mockResolvedValue([
      remote({ route_to: { type: 'receiving_number', dial: [{ number: '+15555550199' }] } }),
    ]);

    await sync();

    expect(store.get('+16097191235')!.route_to).toEqual({ forward_to: '+15555550199' });
  });

  it('updates the stored destination when a number on file now forwards somewhere else', async () => {
    const store = installPhoneNumberStore([
      { e164: '+16097191235', route_to: { forward_to: '+16090000000' } },
    ]);
    client.listNumbers.mockResolvedValue([
      remote({ route_to: { type: 'receiving_number', dial: [{ number: '+15555550199' }] } }),
    ]);

    await sync();

    expect(store.get('+16097191235')!.route_to).toEqual({ forward_to: '+15555550199' });
  });

  it.each([
    ['rings several destinations at once', { type: 'receiving_number', dial: [{ number: '+15555550199' }, { number: '+15555550198' }] }],
    ['is routed to a queue', { type: 'call_queue', dial: { id: 'CQU1', name: 'Queue' } }],
    ['rings nowhere', { type: 'receiving_number', dial: [] }],
  ])('stores no forward destination for a number that %s', async (_label, routeTo) => {
    const store = installPhoneNumberStore([
      { e164: '+16097191235', route_to: { forward_to: '+16090000000' } },
    ]);
    client.listNumbers.mockResolvedValue([
      remote({ id: 'TPN-new', number: '+16097770000', route_to: routeTo }),
      remote({ route_to: routeTo }),
    ]);

    await sync();

    expect(store.get('+16097770000')!.route_to).toBeNull();
    // An existing destination is not invented, and not wiped either: the
    // stored value is only ever set from a shape ServWave owns.
    expect(store.get('+16097191235')!.route_to).toEqual({ forward_to: '+16090000000' });
  });
});

describe('syncNumbers - audit', () => {
  it('records one audit entry with the counts, the numbers switched on and the numbers that failed', async () => {
    installPhoneNumberStore([{ e164: '+16090000001', sms_enabled: true }]);
    client.listNumbers.mockResolvedValue([
      remote({ id: 'TPN-known', number: '+16090000001', sms_enabled: true }),
      remote({ id: 'TPN-on', number: '+16090000002', sms_enabled: false }),
      remote({ id: 'TPN-off', number: '+16090000003', sms_enabled: false }),
    ]);
    client.enableSms.mockResolvedValueOnce('ok').mockResolvedValueOnce('notfound');

    await syncNumbers({ orgId: ORG, accountId: ACCOUNT, trigger: 'manual' });

    expect(p.auditLog.create).toHaveBeenCalledTimes(1);
    const row = p.auditLog.create.mock.calls[0][0].data;
    expect(row).toMatchObject({
      org_id: ORG,
      action: 'numbers.synced',
      resource_type: 'Organization',
      resource_id: ORG,
    });
    expect(row.metadata).toEqual({
      trigger: 'manual',
      read: 3,
      added: ['+16090000002', '+16090000003'],
      texting_enabled: ['+16090000002'],
      texting_failed: [{ e164: '+16090000003', outcome: 'notfound' }],
      texting_found_on: [],
    });
  });

  it('lists the stored calls-only numbers the phone system already reported able to text', async () => {
    // The pilot org's calls-only numbers flipped to "can text" this way and the
    // audit entry could not say which ones: no switch-on call was made, so they
    // were in neither texting_enabled nor texting_failed.
    const store = installPhoneNumberStore([
      { e164: '+16090000011', sms_enabled: false },
      { e164: '+16090000012', sms_enabled: true },
      { e164: '+16090000014', sms_enabled: false },
      { e164: '+16090000015', sms_enabled: false },
    ]);
    client.listNumbers.mockResolvedValue([
      // stored calls-only, reported able to text: found on
      remote({ id: 'TPN-found-a', number: '+16090000011', sms_enabled: true }),
      // stored able to text already: nothing changed
      remote({ id: 'TPN-known', number: '+16090000012', sms_enabled: true }),
      // new, reported able to text: added, not found on
      remote({ id: 'TPN-new', number: '+16090000013', sms_enabled: true }),
      // stored calls-only, reported calls-only, switched on by this sync
      remote({ id: 'TPN-ours', number: '+16090000014', sms_enabled: false }),
      // a second stored calls-only number reported able to text, after the others
      remote({ id: 'TPN-found-b', number: '+16090000015', sms_enabled: true }),
    ]);

    await sync();

    expect(store.get('+16090000011')!.sms_enabled).toBe(true);
    expect(store.get('+16090000015')!.sms_enabled).toBe(true);
    const audit = p.auditLog.create.mock.calls[0][0].data.metadata;
    expect(audit.texting_found_on).toEqual(['+16090000011', '+16090000015']);
    expect(audit.added).toEqual(['+16090000013']);
    expect(audit.texting_enabled).toEqual(['+16090000014']);
    expect(audit.texting_failed).toEqual([]);
  });

  it('leaves a number out of the found-on list when a disconnect stopped the run before storing it', async () => {
    const store = installPhoneNumberStore([
      { e164: '+16090000021', sms_enabled: false },
      { e164: '+16090000022', sms_enabled: false },
    ]);
    client.listNumbers.mockResolvedValue([
      remote({ id: 'TPN-a', number: '+16090000021', sms_enabled: true }),
      remote({ id: 'TPN-b', number: '+16090000022', sms_enabled: true }),
    ]);
    // The org disconnects while the first number is being written.
    const write = p.phoneNumber.upsert.getMockImplementation();
    p.phoneNumber.upsert.mockImplementation(async (args: any) => {
      const row = await write(args);
      if (args.where.organization_id_e164.e164 === '+16090000021') void stopRunningSync(ORG);
      return row;
    });

    await sync();

    expect(store.get('+16090000022')!.sms_enabled).toBe(false);
    const audit = p.auditLog.create.mock.calls[0][0].data.metadata;
    expect(audit.stopped).toBe('disconnected');
    expect(audit.texting_found_on).toEqual(['+16090000021']);
  });

  it('names the admin who pressed Sync as the actor', async () => {
    installPhoneNumberStore();
    client.listNumbers.mockResolvedValue([remote()]);
    const req = {
      user: { id: 'user-9', organization_id: ORG, email: 'admin@test.dev' },
      headers: {},
      socket: {},
    } as any;

    await syncNumbers({ orgId: ORG, accountId: ACCOUNT, trigger: 'manual', req });

    expect(p.auditLog.create.mock.calls[0][0].data).toMatchObject({
      actor_id: 'user-9',
      actor_email: 'admin@test.dev',
    });
  });

  it('writes nothing and records nothing when the phone system cannot list the numbers', async () => {
    const store = installPhoneNumberStore();
    client.listNumbers.mockRejectedValue(new ctmClient.CtmApiError(500, 'boom'));

    await expect(sync()).rejects.toBeInstanceOf(ctmClient.CtmApiError);

    expect(store.rows).toEqual([]);
    expect(p.auditLog.create).not.toHaveBeenCalled();
  });
});

describe('one sync routine', () => {
  const src = join(__dirname, '../../..');

  /** Every non-test source file under backend/src. */
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) return name === '__tests__' ? [] : sourceFiles(path);
      return path.endsWith('.ts') && !path.endsWith('.test.ts') ? [path] : [];
    });
  }

  /**
   * Does this source reach the phone-system client's listNumbers, in any
   * import style: a named import (aliased or not), or a namespace, default or
   * dynamic import of the client used as `<x>.listNumbers` / `<x>['listNumbers']`.
   */
  function readsNumberList(code: string): boolean {
    const clientPath = `'(?:\\.\\/client|[^']*ctm\\/client)'`;
    const namedImport = new RegExp(`import\\s*(?:type\\s*)?\\{[^}]*\\blistNumbers\\b[^}]*\\}\\s*from\\s*${clientPath}`);
    if (namedImport.test(code)) return true;
    const loadsClient = new RegExp(`(?:from|import\\(|require\\()\\s*${clientPath}`).test(code);
    return loadsClient && /(?:\.listNumbers\b|\[\s*['"]listNumbers['"]\s*\])/.test(code);
  }

  const readers = () =>
    sourceFiles(src)
      .filter((f) => !f.endsWith(join('lib', 'ctm', 'client.ts')))
      .filter((f) => readsNumberList(readFileSync(f, 'utf8')))
      .map((f) => relative(src, f));

  it('is the only code that reads the phone account number list', () => {
    // A second copy of the number upsert has to read the list to do anything,
    // so a second reader of the client's listNumbers IS a second copy.
    expect(readers()).toEqual(['lib/ctm/numberSync.ts']);
  });

  it.each([
    ['a named import', "import { listNumbers } from '../lib/ctm/client';\nawait listNumbers(a);"],
    ['an aliased import', "import { listNumbers as ln } from '../lib/ctm/client';"],
    ['a namespace import', "import * as ctm from '../lib/ctm/client';\nawait ctm.listNumbers(a);"],
    ['a default import', "import ctm from '../lib/ctm/client';\nawait ctm['listNumbers'](a);"],
    ['a dynamic import', "const ctm = await import('../lib/ctm/client');\nawait ctm.listNumbers(a);"],
  ])('would notice a copy that reaches the list through %s', (_style, code) => {
    expect(readsNumberList(code)).toBe(true);
  });

  it("does not mistake the numbers route's own handler for a reader", () => {
    const code =
      "import { searchNumbers } from '../lib/ctm/client';\nexport async function listNumbers(req, res) {}";
    expect(readsNumberList(code)).toBe(false);
  });
});
