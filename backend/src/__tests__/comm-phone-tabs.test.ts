import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { env } from '../config/env';
import { clearTokenCache } from '../middleware/authenticate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';
import { mockAuthAs, mockRoleSwitches, authHeader, ALPHA_ORG_ID } from './helpers';
import { withDependantsOff } from './support/switchDependants';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

/**
 * Roles & Permissions S08.16: Call flows, Call groups, Training and Blocked callers follow their own switch on the server,
 * on top of today's checks (Contact customers to add, Edit communication records to change, Delete communication records to
 * delete or unblock) and on top of the pilot-or-demo org gate. Call masking has no server data, so its switch is display only.
 *
 * The person is always a built-in base with stored switch values (a custom-role shape): the switches decide, never the
 * role's name. Switch keys are read from the catalog, so a rename there fails here instead of passing on a copy.
 */

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const mockPrisma = prisma as any;
const keyOf = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)!.key;
const FLOWS = keyOf('Call flows tab');
const GROUPS = keyOf('Call groups tab');
const TRAINING = keyOf('Training tab');
const BLOCKED = keyOf('Blocked callers tab');
const MASKING = keyOf('Call masking tab');
const CONTACT = keyOf('Contact customers');
const EDIT = keyOf('Edit communication records');
const DELETE = keyOf('Delete communication records');
const TRANSCRIPT = keyOf('View transcript');

const SECTION_OPEN = { access_communication: true, view_communication: true };
const ID = 'a1000000-0000-4000-8000-0000000000aa';
const NOW = new Date('2026-07-09T12:00:00Z');

const flowRow = { id: ID, name: 'Main', structure: 'basic', record: false, status: 'draft', hours_mode: 'always', open_nodes: [], closed_nodes: [], updated_at: NOW };
const groupRow = { id: ID, name: 'Front desk', ring: 'all', members: [], updated_at: NOW };
const blockedRow = { id: ID, number: '+15550000123', name: null, reason: 'spam', note: null, blocked_at: NOW, blocked_by: 'Dispatcher', organization_id: ALPHA_ORG_ID };
const sessionRow = {
  id: ID, trainee_name: 'A. Trainee', trainee_role: 'Dispatcher', role_id: 'r1', scenario_slug: 'trn_book_new', scenario_title: 'Book',
  difficulty: 'easy', trainer_name: 'T', score: 80, outcome: 'pass', duration_sec: 120, completed_at: NOW, has_recording: false,
  coaching_note: null, transcript: [{ speaker: 'agent', text: 'Hello' }],
};
const scenarioRow = { id: ID, slug: 'trn_book_new', role_id: 'r1', title: 'Book', difficulty: 'easy', duration_min: 5, script_focus: 'x', trainer_name: 'T', persona: {}, steps: [], dialogue: [] };

type Org = { is_demo?: boolean };
function as(role: 'dispatcher' | 'technician', switches: Record<string, boolean | string>, org: Org = { is_demo: true }) {
  mockAuthAs(role, org);
  mockRoleSwitches({ ...SECTION_OPEN, communication_scope: 'all', ...switches });
  return authHeader(role);
}

beforeEach(() => {
  vi.clearAllMocks();
  clearTokenCache();
  clearPermissionCache();
  mockPrisma.callFlow.deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  mockPrisma.callGroup.deleteMany = vi.fn().mockResolvedValue({ count: 1 });
  mockPrisma.callFlow.findMany.mockResolvedValue([flowRow]);
  mockPrisma.callFlow.findFirst.mockResolvedValue(flowRow);
  mockPrisma.callFlow.create.mockResolvedValue(flowRow);
  mockPrisma.callFlow.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.callGroup.findMany.mockResolvedValue([groupRow]);
  mockPrisma.callGroup.findFirst.mockResolvedValue(groupRow);
  mockPrisma.callGroup.create.mockResolvedValue(groupRow);
  mockPrisma.callGroup.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.blockedNumber.findMany.mockResolvedValue([blockedRow]);
  mockPrisma.blockedNumber.findFirst.mockResolvedValue(blockedRow);
  mockPrisma.blockedNumber.create.mockResolvedValue(blockedRow);
  mockPrisma.blockedNumber.deleteMany.mockResolvedValue({ count: 1 });
  mockPrisma.trainingScenario.findMany.mockResolvedValue([scenarioRow]);
  mockPrisma.trainingScenario.findFirst.mockResolvedValue(scenarioRow);
  mockPrisma.trainingSession.findMany.mockResolvedValue([sessionRow]);
  mockPrisma.trainingSession.findFirst.mockResolvedValue(sessionRow);
});

describe('the catalog names the switches and their checks', () => {
  it('reads the switch keys the way this file does', () => {
    expect([FLOWS, GROUPS, TRAINING, BLOCKED, MASKING, CONTACT, EDIT, DELETE, TRANSCRIPT])
      .toEqual(['call_flows_tab', 'call_groups_tab', 'training_tab', 'blocked_callers_tab', 'call_masking_tab',
        'contact_customers', 'edit_communication_records', 'delete_communication_records', 'view_transcript']);
  });
});

// One row per endpoint: which tab it belongs to, which of today's grants it also needs, and a call that would succeed.
type Call = (header: Record<string, string>) => request.Test;
const get = (path: string): Call => (h) => request(app).get(path).set(h);
const send = (method: 'post' | 'patch' | 'delete', path: string, body?: object): Call => (h) => request(app)[method](path).set(h).send(body);

const FLOW_BODY = { name: 'New', structure: 'basic' };
const GROUP_BODY = { name: 'New', ring: 'all' };
const BLOCK_BODY = { number: '+15550000999', reason: 'spam' };

const ENDPOINTS: Array<{ name: string; tab: string; also: Record<string, boolean>; call: Call }> = [
  { name: 'GET call-flows', tab: FLOWS, also: {}, call: get('/api/communication/call-flows') },
  { name: 'GET call-flows/:id', tab: FLOWS, also: {}, call: get(`/api/communication/call-flows/${ID}`) },
  { name: 'POST call-flows', tab: FLOWS, also: { [CONTACT]: true }, call: send('post', '/api/communication/call-flows', FLOW_BODY) },
  { name: 'PATCH call-flows/:id', tab: FLOWS, also: { [EDIT]: true }, call: send('patch', `/api/communication/call-flows/${ID}`, { name: 'Renamed' }) },
  { name: 'DELETE call-flows/:id', tab: FLOWS, also: { [DELETE]: true }, call: send('delete', `/api/communication/call-flows/${ID}`) },
  { name: 'GET call-groups', tab: GROUPS, also: {}, call: get('/api/communication/call-groups') },
  { name: 'GET call-groups/:id', tab: GROUPS, also: {}, call: get(`/api/communication/call-groups/${ID}`) },
  { name: 'POST call-groups', tab: GROUPS, also: { [CONTACT]: true }, call: send('post', '/api/communication/call-groups', GROUP_BODY) },
  { name: 'PATCH call-groups/:id', tab: GROUPS, also: { [EDIT]: true }, call: send('patch', `/api/communication/call-groups/${ID}`, { name: 'Renamed' }) },
  { name: 'DELETE call-groups/:id', tab: GROUPS, also: { [DELETE]: true }, call: send('delete', `/api/communication/call-groups/${ID}`) },
  { name: 'GET training/scenarios', tab: TRAINING, also: {}, call: get('/api/communication/training/scenarios') },
  { name: 'GET training/scenarios/:id', tab: TRAINING, also: {}, call: get('/api/communication/training/scenarios/trn_book_new') },
  { name: 'GET training/sessions', tab: TRAINING, also: {}, call: get('/api/communication/training/sessions') },
  { name: 'GET training/sessions/:id', tab: TRAINING, also: {}, call: get(`/api/communication/training/sessions/${ID}`) },
  { name: 'GET blocked', tab: BLOCKED, also: {}, call: get('/api/communication/blocked') },
  { name: 'GET blocked/:id', tab: BLOCKED, also: {}, call: get(`/api/communication/blocked/${ID}`) },
  { name: 'POST blocked', tab: BLOCKED, also: { [CONTACT]: true }, call: send('post', '/api/communication/blocked', BLOCK_BODY) },
  { name: 'POST blocked/unblock', tab: BLOCKED, also: { [DELETE]: true }, call: send('post', '/api/communication/blocked/unblock', { id: ID }) },
];

describe.each(ENDPOINTS)('$name', ({ tab, also, call }) => {
  it('goes through with the tab on and the grant it needed before', async () => {
    for (const role of ['dispatcher', 'technician'] as const) {
      const res = await call(as(role, { [tab]: true, ...also }));
      expect(res.status, role).toBeLessThan(300);
    }
  });

  it('is refused with the tab off, whatever else the person holds', async () => {
    for (const role of ['dispatcher', 'technician'] as const) {
      const everything = { [CONTACT]: true, [EDIT]: true, [DELETE]: true, ...also };
      const res = await call(as(role, { [tab]: false, ...everything }));
      expect(res.status, role).toBe(403);
    }
  });

  it('keeps needing the grant it needed before, with the tab on', async () => {
    const needed = Object.keys(also);
    if (needed.length === 0) return;
    const off = withDependantsOff(needed);
    const res = await call(as('dispatcher', { [tab]: true, ...off }));
    expect(res.status).toBe(403);
  });

  it('does not stand in for another tab', async () => {
    const others = [FLOWS, GROUPS, TRAINING, BLOCKED].filter((t) => t !== tab);
    const res = await call(as('dispatcher', { ...Object.fromEntries(others.map((t) => [t, true])), [tab]: false, ...also }));
    expect(res.status).toBe(403);
  });

  it('gives no data in an org outside the pilot and demo gate, even with the tab on', async () => {
    const res = await call(as('dispatcher', { [tab]: true, ...also }, { is_demo: false }));
    expect(res.status).toBe(404);
    expect(res.body).toEqual({ error: 'FEATURE_DISABLED', feature: 'phone-setup' });
    // The write never reached the database.
    expect(mockPrisma.callFlow.create).not.toHaveBeenCalled();
    expect(mockPrisma.callFlow.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.callFlow.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.callGroup.create).not.toHaveBeenCalled();
    expect(mockPrisma.callGroup.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.callGroup.deleteMany).not.toHaveBeenCalled();
    expect(mockPrisma.blockedNumber.create).not.toHaveBeenCalled();
    expect(mockPrisma.blockedNumber.deleteMany).not.toHaveBeenCalled();
  });
});

describe('a person with the tab on and Edit communication records off', () => {
  it('reads the tab\'s data and cannot change it', async () => {
    const header = as('dispatcher', { [FLOWS]: true, [GROUPS]: true, [EDIT]: false });
    expect((await request(app).get('/api/communication/call-flows').set(header)).body.callFlows).toHaveLength(1);
    expect((await request(app).get('/api/communication/call-groups').set(header)).body.callGroups).toHaveLength(1);
    expect((await request(app).patch(`/api/communication/call-flows/${ID}`).set(header).send({ name: 'x' })).status).toBe(403);
    expect((await request(app).patch(`/api/communication/call-groups/${ID}`).set(header).send({ name: 'x' })).status).toBe(403);
    expect(mockPrisma.callFlow.updateMany).not.toHaveBeenCalled();
    expect(mockPrisma.callGroup.updateMany).not.toHaveBeenCalled();
  });

  it('reads the blocked list and cannot unblock without Delete communication records', async () => {
    const header = as('dispatcher', { [BLOCKED]: true, [EDIT]: true, [DELETE]: false });
    expect((await request(app).get('/api/communication/blocked').set(header)).body.blocked).toHaveLength(1);
    expect((await request(app).post('/api/communication/blocked/unblock').set(header).send({ id: ID })).status).toBe(403);
    expect(mockPrisma.blockedNumber.deleteMany).not.toHaveBeenCalled();
  });
});

describe('the pilot and demo gate', () => {
  it('lets a real org on the pilot allowlist through', async () => {
    const before = env.COMMUNICATION_ALLOWED_ORG_IDS;
    env.COMMUNICATION_ALLOWED_ORG_IDS = `00000000-0000-0000-0000-0000000000aa, ${ALPHA_ORG_ID}`;
    try {
      const res = await request(app).get('/api/communication/call-flows').set(as('dispatcher', { [FLOWS]: true }, { is_demo: false }));
      expect(res.status).toBe(200);
    } finally {
      env.COMMUNICATION_ALLOWED_ORG_IDS = before;
    }
  });

  it('refuses a real org that is not on it', async () => {
    const before = env.COMMUNICATION_ALLOWED_ORG_IDS;
    env.COMMUNICATION_ALLOWED_ORG_IDS = '00000000-0000-0000-0000-0000000000aa';
    try {
      const res = await request(app).get('/api/communication/call-flows').set(as('dispatcher', { [FLOWS]: true }, { is_demo: false }));
      expect(res.status).toBe(404);
    } finally {
      env.COMMUNICATION_ALLOWED_ORG_IDS = before;
    }
  });
});

describe('the Training tab and the transcript', () => {
  const sessionList = (header: Record<string, string>) => request(app).get('/api/communication/training/sessions').set(header);
  const sessionOne = (header: Record<string, string>) => request(app).get(`/api/communication/training/sessions/${ID}`).set(header);

  it('carries the transcript turns for a holder of View transcript', async () => {
    const header = as('dispatcher', { [TRAINING]: true, [TRANSCRIPT]: true });
    expect((await sessionList(header)).body.sessions[0].transcript).toEqual(sessionRow.transcript);
    expect((await sessionOne(header)).body.session.transcript).toEqual(sessionRow.transcript);
  });

  it('leaves the transcript turns out, keeps the rest of the session, without View transcript', async () => {
    const header = as('dispatcher', { [TRAINING]: true, [TRANSCRIPT]: false });
    for (const body of [(await sessionList(header)).body.sessions[0], (await sessionOne(header)).body.session]) {
      expect(body).toMatchObject({ id: ID, traineeName: 'A. Trainee', score: 80, outcome: 'pass' });
      expect('transcript' in body).toBe(false);
    }
  });

  it('refuses the sessions with View transcript on and the Training tab off', async () => {
    const header = as('dispatcher', { [TRAINING]: false, [TRANSCRIPT]: true });
    expect((await sessionList(header)).status).toBe(403);
    expect((await sessionOne(header)).status).toBe(403);
  });
});

describe('the Call masking tab', () => {
  it('has no endpoint behind it: the switch is display only', () => {
    const entry = SWITCH_CATALOG.find((s) => s.key === MASKING)!;
    expect(entry.serverChecks).toEqual([]);
    expect(entry.pending).toMatch(/display only/i);
  });
});
