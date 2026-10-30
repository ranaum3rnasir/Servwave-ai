import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, mockRoleSwitches, authHeader, ALPHA_ORG_ID } from './helpers';
import { matchesWhere, type Row } from './whereMatcher';

/**
 * Roles & Permissions S08.3: the company numbers list follows Communication scope and the main-line fallback. As in
 * comm-call-log-scope.test.ts, the `where` the handler hands the database is run over fixture rows, and the stored
 * switch values, not the role name, decide what each person gets.
 */

const mockPrisma = prisma as any;
const LINKED = 'a1000000-0000-4000-8000-000000000001';
const UNLINKED = 'a1000000-0000-4000-8000-000000000002';
const MAIN_LINE = 'a1000000-0000-4000-8000-0000000000ff';

const numberRow = (id: string): Row => ({
  id, organization_id: ALPHA_ORG_ID, e164: `+1555${id.slice(-7).replace(/\D/g, '0')}`, formatted: null, label: null,
  source: 'byo', type: null, sms_enabled: true, ctm_number_id: null, call_flow_id: null, route_to: null,
  status: 'active', created_at: new Date('2026-07-09T12:00:00Z'),
});
const NUMBERS = [LINKED, UNLINKED, MAIN_LINE].map(numberRow);

const SECTION_OPEN = { access_communication: true, view_communication: true, access_inbox: true };

function linkNumbers(...ids: string[]) {
  mockPrisma.userPhoneNumber.findMany.mockResolvedValue(ids.map((phone_number_id) => ({ phone_number_id })));
}

/** The numbers the list route returns, with the database answering the way a real one filters on `where`. */
async function listFor(role: 'dispatcher' | 'technician', switches: Record<string, boolean | string>, path = '/api/communication/numbers') {
  mockAuthAs(role);
  mockRoleSwitches({ ...SECTION_OPEN, ...switches });
  mockPrisma.phoneNumber.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
    NUMBERS.filter((r) => matchesWhere(r, where)));
  const res = path.endsWith('sync-if-stale')
    ? await request(app).post(path).set(authHeader(role))
    : await request(app).get(path).set(authHeader(role));
  expect(res.status).toBe(200);
  return (res.body.numbers as { id: string }[]).map((n) => n.id);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  linkNumbers();
  mockPrisma.phoneNumber.findFirst.mockResolvedValue({ id: MAIN_LINE });
});

describe.each([
  ['GET /communication/numbers', '/api/communication/numbers'],
  ['POST /communication/numbers/sync-if-stale', '/api/communication/numbers/sync-if-stale'],
])('%s on "Linked to me"', (_name, path) => {
  const NARROW = { communication_scope: 'attached' } as const;

  it('returns only the numbers linked to the person', async () => {
    linkNumbers(LINKED);
    expect(await listFor('dispatcher', { ...NARROW, see_main_line_when_no_number: true }, path)).toEqual([LINKED]);
  });

  it('returns the main line for a person with no number who holds the switch, and nothing with it off', async () => {
    expect(await listFor('dispatcher', { ...NARROW, see_main_line_when_no_number: true }, path)).toEqual([MAIN_LINE]);
    expect(await listFor('dispatcher', { ...NARROW, see_main_line_when_no_number: false }, path)).toEqual([]);
  });

  it('reads the links on every request: linking a number ends the main-line fallback, unlinking it restores it', async () => {
    const on = { ...NARROW, see_main_line_when_no_number: true };
    expect(await listFor('dispatcher', on, path)).toEqual([MAIN_LINE]);
    linkNumbers(UNLINKED);
    expect(await listFor('dispatcher', on, path)).toEqual([UNLINKED]);
    linkNumbers();
    expect(await listFor('dispatcher', on, path)).toEqual([MAIN_LINE]);
  });

  it('gives a role copied from the Technician preset the main line once the switch is on, with no role-name check', async () => {
    expect(await listFor('technician', { ...NARROW, see_main_line_when_no_number: true }, path)).toEqual([MAIN_LINE]);
    expect(await listFor('technician', { ...NARROW, see_main_line_when_no_number: false }, path)).toEqual([]);
  });

  it('returns every number under "All", whatever the main-line switch says', async () => {
    for (const on of [true, false]) {
      expect(await listFor('dispatcher', { communication_scope: 'all', see_main_line_when_no_number: on }, path)).toEqual(NUMBERS.map((n) => n.id));
    }
  });

  it('returns every number to the built-in Admin', async () => {
    mockAuthAs('admin');
    mockPrisma.phoneNumber.findMany.mockImplementation(async ({ where }: { where: Record<string, unknown> }) =>
      NUMBERS.filter((r) => matchesWhere(r, where)));
    const res = path.endsWith('sync-if-stale')
      ? await request(app).post(path).set(authHeader('admin'))
      : await request(app).get(path).set(authHeader('admin'));
    expect((res.body.numbers as { id: string }[]).map((n) => n.id)).toEqual(NUMBERS.map((n) => n.id));
  });
});

describe('the numbers list when the main line is not set', () => {
  it('returns nothing to a person with no number, even with the switch on', async () => {
    mockPrisma.phoneNumber.findFirst.mockResolvedValue(null);
    expect(await listFor('dispatcher', { communication_scope: 'attached', see_main_line_when_no_number: true })).toEqual([]);
    expect(mockPrisma.phoneNumber.findMany as Mock).toHaveBeenCalled();
  });
});
