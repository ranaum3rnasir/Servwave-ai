// POST /numbers/refresh - make the numbers list a mirror, not a snapshot.
//
// Numbers were imported ONCE, when the org connected, and never again. The
// live sub-account holds four numbers and ServWave shows two of them: a number
// bought in the vendor's own dashboard and a number ServWave bought but failed
// to save are both invisible, and the second is invisible while still billing.
// Every row also has a null `type`, so a toll-free number renders as "Local".
//
// Shapes below are the live 2026-08-12 response, not invented: `route_to` is
// `{type:'receiving_number', dial:[{number}]}` when a number simply forwards,
// `{type:'call_queue', dial:{...}}` when it does not, and `dial: []` when the
// number rings nowhere at all.
import { describe, it, expect, vi, beforeEach } from 'vitest';
import request from 'supertest';
import app from '../../app';
import { prisma } from '../../lib/prisma';
import * as ctmClient from '../../lib/ctm/client';
import { clearTokenCache } from '../../middleware/authenticate';
import { clearPermissionCache } from '../../lib/permissions/permissionCache';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from '../../__tests__/helpers';
import { installPhoneNumberStore } from '../../lib/ctm/__tests__/phoneNumberStore';

/* eslint-disable @typescript-eslint/no-explicit-any */
const p = prisma as any;
const client = ctmClient as any;

const CTM_ACCOUNT_ID = '500002';

const FORWARDING = {
  id: 'TPN-forwarding',
  number: '+16097191235',
  formatted: '(609) 719-1235',
  name: null,
  type: 'local',
  status: 'active',
  sms_enabled: true,
  route_to: {
    type: 'receiving_number',
    multi: true,
    mode: 'simultaneous',
    dial: [{ filter_id: 3906455, number: '+15555550199', name: null }],
  },
};

const TOLL_FREE_UNROUTED = {
  id: 'TPN-tollfree',
  number: '+18555334801',
  formatted: '(855) 533-4801',
  name: 'call flow ',
  type: 'tollfree',
  status: 'active',
  sms_enabled: true,
  route_to: { type: 'receiving_number', multi: true, mode: 'simultaneous', dial: [] },
};

const QUEUE_ROUTED = {
  id: 'TPN-queue',
  number: '+12394884861',
  formatted: '(239) 488-4861',
  name: '',
  type: 'local',
  status: 'active',
  sms_enabled: true,
  route_to: { type: 'call_queue', dial: { id: 'CQU1', name: 'Simultaneous|Receiving Number Queue' } },
};

const STOPPED = {
  id: 'TPN-stopped',
  number: '+16095968565',
  formatted: '(609) 596-8565',
  name: null,
  type: 'local',
  status: 'stopped',
  sms_enabled: false,
  route_to: { type: 'receiving_number', multi: true, mode: 'simultaneous', dial: [] },
};

const refresh = () =>
  request(app).post('/api/communication/numbers/refresh').set(authHeader('admin')).send({});

let store: ReturnType<typeof installPhoneNumberStore>;

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  p.auditLog.create.mockResolvedValue({});
  mockAuthAs('admin');

  client.isCtmConfigured.mockReturnValue(true);
  client.enableSms.mockResolvedValue('ok');
  p.organization.findUnique.mockResolvedValue({ ctm_account_id: CTM_ACCOUNT_ID });
  client.listNumbers.mockResolvedValue([FORWARDING, TOLL_FREE_UNROUTED, QUEUE_ROUTED, STOPPED]);
  // The forwarding number is already on file; the other three are new.
  store = installPhoneNumberStore([
    {
      organization_id: ALPHA_ORG_ID,
      e164: '+16097191235',
      formatted: '(609) 719-1235',
      type: 'local',
      sms_enabled: true,
      ctm_number_id: 'TPN-forwarding',
      route_to: { forward_to: '+15555550199' },
    },
  ]);
});

describe('POST /api/communication/numbers/refresh', () => {
  it('brings across every number the account holds, not just the ones already known', async () => {
    const res = await refresh();

    expect(res.status).toBe(200);
    expect(store.rows.map((r) => r.e164).sort()).toEqual(
      ['+12394884861', '+16095968565', '+16097191235', '+18555334801'],
    );
    expect(res.body.synced).toBe(4);
  });

  it('reports how many numbers were added and how many had texting switched on', async () => {
    // STOPPED is the only number the account reports with texting off.
    const res = await refresh();

    expect(res.body.added).toBe(3);
    expect(res.body.texting_enabled).toBe(1);
    expect(res.body.texting_failed).toBe(0);
    expect(client.enableSms).toHaveBeenCalledWith(CTM_ACCOUNT_ID, 'TPN-stopped');
  });

  it('switches texting on through the Sync button too, and stores the number as able to text', async () => {
    await refresh();

    expect(store.get('+16095968565')!.sms_enabled).toBe(true);
  });

  it('reports a number whose texting could not be switched on', async () => {
    client.enableSms.mockResolvedValue('failure');

    const res = await refresh();

    expect(res.body.texting_enabled).toBe(0);
    expect(res.body.texting_failed).toBe(1);
    expect(store.get('+16095968565')!.sms_enabled).toBe(false);
  });

  it('counts a calls-only number with no phone-system id as one texting could not be switched on for', async () => {
    client.listNumbers.mockResolvedValue([{ ...STOPPED, id: null }]);

    const res = await refresh();

    expect(res.body.texting_failed).toBe(1);
    expect(client.enableSms).not.toHaveBeenCalled();
  });

  it('carries the number type through so a toll-free number stops reading as Local', async () => {
    await refresh();

    expect(store.get('+18555334801')!.type).toBe('tollfree');
  });

  it('records where a forwarding number actually rings', async () => {
    await refresh();

    expect(store.get('+16097191235')!.route_to).toEqual({ forward_to: '+15555550199' });
  });

  it('does not flatten a queue-routed number into a forward it is not', async () => {
    await refresh();

    expect(store.get('+12394884861')!.route_to).toBeNull();
  });

  it('mirrors a stopped number as paused instead of dropping it', async () => {
    await refresh();

    expect(store.get('+16095968565')!.status).toBe('paused');
  });

  it('records one audit entry for the sync', async () => {
    await refresh();

    const actions = p.auditLog.create.mock.calls.map((c: any[]) => c[0].data.action);
    expect(actions).toEqual(['numbers.synced']);
  });

  it('returns the refreshed list so the table can render server truth', async () => {
    const res = await refresh();

    expect(res.body.numbers).toHaveLength(4);
    expect(res.body.numbers[0]).toMatchObject({ e164: '+16097191235', forward_to: '+15555550199' });
  });

  it('409s when the org is not connected, without calling the phone system', async () => {
    p.organization.findUnique.mockResolvedValue({ ctm_account_id: null });

    const res = await refresh();

    expect(res.status).toBe(409);
    expect(client.listNumbers).not.toHaveBeenCalled();
  });

  it('502s rather than reporting an empty account when the phone system fails', async () => {
    client.listNumbers.mockRejectedValue(new ctmClient.CtmApiError(500, 'boom'));

    const res = await refresh();

    expect(res.status).toBe(502);
    expect(res.body.error).toBe('The phone system request failed');
    expect(store.rows).toHaveLength(1);
  });

  it('is refused to a non-admin - it is org plumbing', async () => {
    mockAuthAs('technician');

    const res = await request(app)
      .post('/api/communication/numbers/refresh')
      .set(authHeader('technician'))
      .send({});

    expect(res.status).toBe(403);
    expect(client.listNumbers).not.toHaveBeenCalled();
  });
});
