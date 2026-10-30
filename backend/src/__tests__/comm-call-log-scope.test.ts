import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { Mock } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, mockRoleSwitches, authHeader, ALPHA_ORG_ID, TEST_USERS } from './helpers';
import { matchesWhere, type Row } from './whereMatcher';

/**
 * Roles & Permissions S08.2: the call log and call detail follow Communication scope. As in comm-visibility.test.ts,
 * every assertion captures the `where` the handler handed the database and runs fixture rows through it, never the
 * rendered payload. The stored switch values, not the role name, decide what each person sees.
 */

const mockPrisma = prisma as any;
const ME = TEST_USERS.dispatcher.id;
const LINKED = 'a1000000-0000-4000-8000-000000000001';
const UNLINKED = 'a1000000-0000-4000-8000-000000000002';
const MY_JOB = { id: 'ab000000-0000-0000-0000-00000000000a', visits: [{ assignees: [{ user_id: ME }] }] };

function callRow(id: string, fields: Partial<Row> = {}): Row {
  return {
    id, organization_id: ALPHA_ORG_ID, phone_number_id: null, agent_id: null,
    job_id: null, job: null, lead_id: null, lead: null, customer_id: null, customer: null, vendor_id: null, ...fields,
  };
}
const ON_LINKED = callRow('c0000000-0000-4000-8000-000000000001', { phone_number_id: LINKED });
const ON_UNLINKED = callRow('c0000000-0000-4000-8000-000000000002', { phone_number_id: UNLINKED });
const PLACED_BY_ME = callRow('c0000000-0000-4000-8000-000000000003', { phone_number_id: UNLINKED, agent_id: ME });
const TIED_TO_NOTHING = callRow('c0000000-0000-4000-8000-000000000004');
const ON_MY_JOB_UNLINKED = callRow('c0000000-0000-4000-8000-000000000005', { phone_number_id: UNLINKED, job_id: MY_JOB.id, job: MY_JOB });
const MAIN_LINE = 'a1000000-0000-4000-8000-0000000000ff';
const ON_MAIN_LINE = callRow('c0000000-0000-4000-8000-000000000006', { phone_number_id: MAIN_LINE });
const ON_MAIN_LINE_MY_JOB = callRow('c0000000-0000-4000-8000-000000000007', { phone_number_id: MAIN_LINE, job_id: MY_JOB.id, job: MY_JOB });
const ALL = [ON_LINKED, ON_UNLINKED, PLACED_BY_ME, TIED_TO_NOTHING, ON_MY_JOB_UNLINKED, ON_MAIN_LINE, ON_MAIN_LINE_MY_JOB];

const visible = (where: Record<string, unknown>) => ALL.filter((r) => matchesWhere(r, where)).map((r) => r.id as string);
const capturedWhere = (fn: Mock, call = 0) => {
  expect(fn, 'expected the handler to query prisma').toHaveBeenCalled();
  return fn.mock.calls[call][0].where as Record<string, unknown>;
};

/** The person's Settings > Caller ID links, as the database would answer them. */
function linkNumbers(...ids: string[]) {
  mockPrisma.userPhoneNumber.findMany.mockResolvedValue(ids.map((phone_number_id) => ({ phone_number_id })));
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  mockPrisma.callSession.findMany.mockResolvedValue([]);
  mockPrisma.callSession.findFirst.mockResolvedValue(null);
  linkNumbers();
  mockPrisma.phoneNumber.findFirst.mockResolvedValue({ id: MAIN_LINE });
});

describe('GET /communication/calls on "Linked to me"', () => {
  beforeEach(() => {
    mockAuthAs('dispatcher');
    mockRoleSwitches({ communication_scope: 'linked_to_me', see_main_line_when_no_number: false, view_jobs: true, jobs_scope: 'attached' });
  });

  it('lists the calls on a linked number and the calls the person placed, and nothing else', async () => {
    linkNumbers(LINKED);
    const res = await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    expect(res.status).toBe(200);
    const where = capturedWhere(mockPrisma.callSession.findMany as Mock);
    expect(where.organization_id).toBe(ALPHA_ORG_ID);
    expect(visible(where)).toEqual([ON_LINKED.id, PLACED_BY_ME.id]);
  });

  it('no longer lists a call tied to nothing, nor one tied to a job on a number that is not linked', async () => {
    linkNumbers(LINKED);
    await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    const ids = visible(capturedWhere(mockPrisma.callSession.findMany as Mock));
    expect(ids).not.toContain(TIED_TO_NOTHING.id);
    expect(ids).not.toContain(ON_MY_JOB_UNLINKED.id);
  });

  it('reads the links afresh on every request: unlinking a number removes its calls on the next one', async () => {
    linkNumbers(LINKED, UNLINKED);
    await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    expect(visible(capturedWhere(mockPrisma.callSession.findMany as Mock, 0))).toContain(ON_UNLINKED.id);

    linkNumbers(LINKED);
    await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    expect(visible(capturedWhere(mockPrisma.callSession.findMany as Mock, 1))).not.toContain(ON_UNLINKED.id);
  });

  it('shows two people ticked on one number both its calls', async () => {
    linkNumbers(LINKED);
    await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    const first = visible(capturedWhere(mockPrisma.callSession.findMany as Mock, 0));

    mockAuthAs('technician');
    mockRoleSwitches({ communication_scope: 'linked_to_me' });
    linkNumbers(LINKED);
    await request(app).get('/api/communication/calls').set(authHeader('technician'));
    const second = visible(capturedWhere(mockPrisma.callSession.findMany as Mock, 1));

    expect(first).toContain(ON_LINKED.id);
    expect(second).toContain(ON_LINKED.id);
  });
});

describe('GET /communication/calls on "All"', () => {
  it('lists every call for a person on All, whatever their numbers', async () => {
    mockAuthAs('dispatcher');
    mockRoleSwitches({ communication_scope: 'all' });
    await request(app).get('/api/communication/calls').set(authHeader('dispatcher'));
    const where = capturedWhere(mockPrisma.callSession.findMany as Mock);
    expect(where.OR).toBeUndefined();
    expect(visible(where)).toEqual(ALL.map((r) => r.id));
  });

  it('lists every call for the built-in Admin, as before', async () => {
    mockAuthAs('admin');
    await request(app).get('/api/communication/calls').set(authHeader('admin'));
    const where = capturedWhere(mockPrisma.callSession.findMany as Mock);
    expect(where.OR).toBeUndefined();
    expect(visible(where)).toEqual(ALL.map((r) => r.id));
  });
});

describe('GET /communication/calls/:id', () => {
  beforeEach(() => {
    mockAuthAs('dispatcher');
    mockRoleSwitches({ communication_scope: 'linked_to_me', view_jobs: true, jobs_scope: 'attached' });
    linkNumbers(LINKED);
  });

  async function opens(row: Row): Promise<boolean> {
    mockPrisma.callSession.findFirst.mockClear();
    await request(app).get(`/api/communication/calls/${row.id}`).set(authHeader('dispatcher'));
    const where = capturedWhere(mockPrisma.callSession.findFirst as Mock);
    return matchesWhere(row, where);
  }

  it('opens a call in the section scope', async () => {
    expect(await opens(ON_LINKED)).toBe(true);
    expect(await opens(PLACED_BY_ME)).toBe(true);
  });

  it('opens a job-tied call on an unlinked number for a person who can open the job', async () => {
    expect(await opens(ON_MY_JOB_UNLINKED)).toBe(true);
  });

  it('refuses a call on an unlinked number that is tied to nothing', async () => {
    expect(await opens(ON_UNLINKED)).toBe(false);
    expect(await opens(TIED_TO_NOTHING)).toBe(false);
  });

  it('opens any call for a person on All', async () => {
    mockRoleSwitches({ communication_scope: 'all' });
    expect(await opens(TIED_TO_NOTHING)).toBe(true);
  });
});

describe('the main-line fallback on the call log and call detail', () => {
  const SIGNED_IN = { communication_scope: 'linked_to_me', view_jobs: true, jobs_scope: 'attached' } as const;

  async function logFor(role: 'dispatcher' | 'technician', switches: Record<string, boolean | string>) {
    mockAuthAs(role);
    mockRoleSwitches({ ...SIGNED_IN, ...switches });
    mockPrisma.callSession.findMany.mockClear();
    await request(app).get('/api/communication/calls').set(authHeader(role));
    return visible(capturedWhere(mockPrisma.callSession.findMany as Mock));
  }

  async function opens(row: Row, role: 'dispatcher' | 'technician' = 'dispatcher'): Promise<boolean> {
    mockPrisma.callSession.findFirst.mockClear();
    await request(app).get(`/api/communication/calls/${row.id}`).set(authHeader(role));
    return matchesWhere(row, capturedWhere(mockPrisma.callSession.findFirst as Mock));
  }

  it('lists the main line\'s calls for a person with no linked number when the switch is on', async () => {
    const ids = await logFor('dispatcher', { see_main_line_when_no_number: true });
    expect(ids).toEqual([PLACED_BY_ME.id, ON_MAIN_LINE.id, ON_MAIN_LINE_MY_JOB.id]);
  });

  it('lists only the calls the person placed or answered when the switch is off, and the main-line call tied to their job still opens', async () => {
    const ids = await logFor('dispatcher', { see_main_line_when_no_number: false });
    expect(ids).toEqual([PLACED_BY_ME.id]);
    mockRoleSwitches({ ...SIGNED_IN, see_main_line_when_no_number: false });
    expect(await opens(ON_MAIN_LINE_MY_JOB)).toBe(true);
    expect(await opens(ON_MAIN_LINE)).toBe(false);
  });

  it('gives no main-line call to a person with a linked number, whatever the switch says', async () => {
    linkNumbers(LINKED);
    const ids = await logFor('dispatcher', { see_main_line_when_no_number: true });
    expect(ids).toEqual([ON_LINKED.id, PLACED_BY_ME.id]);
    expect(mockPrisma.phoneNumber.findFirst).not.toHaveBeenCalled();
  });

  it('reads "no linked number" on every request: linking a first number ends the fallback, unlinking it restores it', async () => {
    expect(await logFor('dispatcher', { see_main_line_when_no_number: true })).toContain(ON_MAIN_LINE.id);
    linkNumbers(LINKED);
    expect(await logFor('dispatcher', { see_main_line_when_no_number: true })).not.toContain(ON_MAIN_LINE.id);
    linkNumbers();
    expect(await logFor('dispatcher', { see_main_line_when_no_number: true })).toContain(ON_MAIN_LINE.id);
  });

  it('changes nothing for a person on All', async () => {
    for (const on of [true, false]) {
      expect(await logFor('dispatcher', { communication_scope: 'all', see_main_line_when_no_number: on })).toEqual(ALL.map((r) => r.id));
    }
  });

  it('gives the fallback to a role copied from the Technician preset once the switch is turned on, with no role-name check', async () => {
    const on = await logFor('technician', { see_main_line_when_no_number: true });
    expect(on).toContain(ON_MAIN_LINE.id);
    const off = await logFor('technician', { see_main_line_when_no_number: false });
    expect(off).not.toContain(ON_MAIN_LINE.id);
  });
});

describe('GET /communication/calls/outcome ("did my call connect") follows the same scope as call detail', () => {
  const SINCE = '2026-07-09T12:00:00.000Z';
  const OUTCOME = `/api/communication/calls/outcome?to_number=%2B15555550100&since=${encodeURIComponent(SINCE)}`;

  /** Whether the call the person just placed would be answered: the row runs through the `where` the handler built. */
  async function answers(row: Row, role: 'dispatcher' | 'technician' = 'dispatcher'): Promise<boolean> {
    mockPrisma.callSession.findFirst.mockClear();
    mockPrisma.callSession.findFirst.mockResolvedValue(null);
    const res = await request(app).get(OUTCOME).set(authHeader(role));
    expect(res.status).toBe(200);
    // The question itself (which call, to whom, since when) is asked as before; what is under test is the scope around it.
    const { direction, to_number, started_at, ...scope } = capturedWhere(mockPrisma.callSession.findFirst as Mock);
    expect({ direction, to_number }).toEqual({ direction: 'out', to_number: '+15555550100' });
    expect(started_at).toEqual({ gte: new Date(SINCE) });
    return matchesWhere(row, scope);
  }

  beforeEach(() => {
    mockAuthAs('dispatcher');
    mockRoleSwitches({ communication_scope: 'linked_to_me', see_main_line_when_no_number: false, view_jobs: true, jobs_scope: 'attached' });
    linkNumbers(LINKED);
  });

  it('answers for a call on a linked number and for one the person placed', async () => {
    expect(await answers(ON_LINKED)).toBe(true);
    expect(await answers(PLACED_BY_ME)).toBe(true);
  });

  it('does not answer for a call the person cannot read: one on an unlinked number or tied to nothing', async () => {
    expect(await answers(ON_UNLINKED)).toBe(false);
    expect(await answers(TIED_TO_NOTHING)).toBe(false);
  });

  it('answers for a call on an unlinked number that is tied to a job the person can open', async () => {
    expect(await answers(ON_MY_JOB_UNLINKED)).toBe(true);
  });

  it('reflects the main-line fallback, on and off', async () => {
    linkNumbers();
    mockRoleSwitches({ communication_scope: 'linked_to_me', see_main_line_when_no_number: true, view_jobs: true, jobs_scope: 'attached' });
    expect(await answers(ON_MAIN_LINE)).toBe(true);
    mockRoleSwitches({ communication_scope: 'linked_to_me', see_main_line_when_no_number: false, view_jobs: true, jobs_scope: 'attached' });
    expect(await answers(ON_MAIN_LINE)).toBe(false);
  });

  it('answers for any call to a person on All', async () => {
    mockRoleSwitches({ communication_scope: 'all' });
    expect(await answers(TIED_TO_NOTHING)).toBe(true);
    expect(await answers(ON_UNLINKED)).toBe(true);
  });
});
