import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, mockRoleSwitches, authHeader, ALPHA_ORG_ID } from './helpers';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

vi.mock('../lib/comm-usage', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../lib/comm-usage')>()),
  getCommUsage: vi.fn().mockResolvedValue({ calling: { used: 3, limit: 100, unit: 'min' }, texting: { used: 1, limit: 500, unit: 'texts' } }),
}));

/**
 * Roles & Permissions S08.15: the Phone numbers tab and the Phone usage bar follow their own switches on the server.
 *
 * The person is always a built-in base with stored switch values (a custom-role shape): the switches decide, never the
 * role's name. Expected switch keys are read from the catalog, so a rename there fails here instead of passing on a copy.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as any;
const NUMBER_ID = 'a1000000-0000-4000-8000-000000000001';
const TAB = SWITCH_CATALOG.find((s) => s.label === 'Phone numbers tab')!.key;
const USAGE = SWITCH_CATALOG.find((s) => s.label === 'Phone usage bar')!.key;
const EDIT = SWITCH_CATALOG.find((s) => s.label === 'Edit communication records')!.key;

const SECTION_OPEN = { access_communication: true, view_communication: true };

const numberRow = {
  id: NUMBER_ID, organization_id: ALPHA_ORG_ID, e164: '+15550000001', formatted: null, label: null,
  source: 'byo', type: null, sms_enabled: true, ctm_number_id: null, call_flow_id: 'flow-1',
  route_to: { forward_to: '+15550000999' }, status: 'active', created_at: new Date('2026-07-09T12:00:00Z'),
};

function as(role: 'dispatcher' | 'technician', switches: Record<string, boolean | string>) {
  mockAuthAs(role);
  mockRoleSwitches({ ...SECTION_OPEN, communication_scope: 'all', ...switches });
  return authHeader(role);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  mockPrisma.phoneNumber.findMany.mockResolvedValue([numberRow]);
  mockPrisma.phoneNumber.findFirst.mockResolvedValue(numberRow);
  mockPrisma.phoneNumber.update.mockResolvedValue({ ...numberRow, call_flow_id: null });
  mockPrisma.organization.findUnique.mockResolvedValue({ timezone: 'America/New_York', comm_usage_uncapped: false });
});

describe('the Phone numbers tab, on the server', () => {
  it('names its switches in the catalog', () => {
    expect([TAB, USAGE, EDIT]).toEqual(['phone_numbers_tab', 'phone_usage_bar', 'edit_communication_records']);
  });

  describe.each([
    ['GET /communication/numbers', 'get', '/api/communication/numbers'],
    ['POST /communication/numbers/sync-if-stale', 'post', '/api/communication/numbers/sync-if-stale'],
  ] as const)('%s', (_name, method, path) => {
    it('carries the routing and call-flow fields with the tab on', async () => {
      const header = as('technician', { [TAB]: true });
      const res = await request(app)[method](path).set(header);
      expect(res.status).toBe(200);
      expect(res.body.numbers).toHaveLength(1);
      expect(res.body.numbers[0]).toMatchObject({ call_flow_id: 'flow-1', forward_to: '+15550000999' });
    });

    it('answers with the number but leaves the routing and call-flow fields out with the tab off', async () => {
      for (const role of ['dispatcher', 'technician'] as const) {
        const header = as(role, { [TAB]: false });
        const res = await request(app)[method](path).set(header);
        expect(res.status, role).toBe(200);
        expect(res.body.numbers, role).toHaveLength(1);
        expect(res.body.numbers[0].e164, role).toBe('+15550000001');
        expect('call_flow_id' in res.body.numbers[0], `${role} call_flow_id`).toBe(false);
        expect('forward_to' in res.body.numbers[0], `${role} forward_to`).toBe(false);
      }
    });

    it('leaves them in for the built-in Admin', async () => {
      mockAuthAs('admin');
      const res = await request(app)[method](path).set(authHeader('admin'));
      expect(res.status).toBe(200);
      expect(res.body.numbers[0]).toMatchObject({ call_flow_id: 'flow-1', forward_to: '+15550000999' });
    });
  });

  describe('PATCH /communication/numbers/:id (a routing change)', () => {
    const change = (header: Record<string, string>) =>
      request(app).patch(`/api/communication/numbers/${NUMBER_ID}`).set(header).send({ call_flow_id: null });

    it('goes through with the tab and Edit communication records both on', async () => {
      const res = await change(as('technician', { [TAB]: true, [EDIT]: true }));
      expect(res.status).toBe(200);
    });

    it('is refused with the tab off, whatever Edit communication records says', async () => {
      for (const edit of [true, false]) {
        const res = await change(as('dispatcher', { [TAB]: false, [EDIT]: edit }));
        expect(res.status, `edit ${edit}`).toBe(403);
      }
      expect(mockPrisma.phoneNumber.update).not.toHaveBeenCalled();
    });

    it('is refused with the tab on and Edit communication records off, while the tab still reads', async () => {
      const header = as('dispatcher', { [TAB]: true, [EDIT]: false });
      expect((await change(header)).status).toBe(403);
      const read = await request(app).get('/api/communication/numbers').set(header);
      expect(read.status).toBe(200);
      expect(read.body.numbers[0]).toMatchObject({ call_flow_id: 'flow-1', forward_to: '+15550000999' });
      expect(mockPrisma.phoneNumber.update).not.toHaveBeenCalled();
    });
  });
});

describe('the Phone usage bar, on the server', () => {
  it('answers the usage endpoint with the switch on', async () => {
    const res = await request(app).get('/api/communication/usage').set(as('technician', { [USAGE]: true }));
    expect(res.status).toBe(200);
    expect(res.body.calling.used).toBe(3);
  });

  it('refuses the usage endpoint with the switch off', async () => {
    for (const role of ['dispatcher', 'technician'] as const) {
      const res = await request(app).get('/api/communication/usage').set(as(role, { [USAGE]: false }));
      expect(res.status, role).toBe(403);
    }
  });

  it('does not let the Phone numbers tab stand in for the usage bar', async () => {
    const res = await request(app).get('/api/communication/usage').set(as('dispatcher', { [TAB]: true, [USAGE]: false }));
    expect(res.status).toBe(403);
  });
});
