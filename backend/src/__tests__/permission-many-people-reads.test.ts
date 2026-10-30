/* =============================================================================
   Roles & Permissions, scenario pass 1 fix - asking "which of these people hold switch X" for a whole company.

   A company of 217 people on 136 roles made the roster pickers and the Inventory page take 17 to 28 seconds (and
   sometimes answer 500): every place that asked about many people resolved them one at a time, or read each
   distinct role with its own queries, so the reads grew with the people and the roles. These tests count the
   database reads for 50 people, each on a role of their own, and assert a small constant. Each fails if its caller
   goes back to one read per person (or per role). The answers themselves are checked against the one-at-a-time
   resolver in permission-many-people-db.test.ts, against a real database.
   ========================================================================== */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import request from 'supertest';
import app from '../app';
import { prisma } from '../lib/prisma';
import { mockAuthAs, authHeader, ALPHA_ORG_ID } from './helpers';
import { clearAllSwitchCaches } from '../lib/permissions/switches/cache';
import { presetValues, resolveSwitchesForPeople, summarizePeopleRoles } from '../lib/permissions/switches/store';
import { activeSwitchHolders } from '../lib/permissions/switchHolders';
import { eligibleUserIds } from '../lib/permissions/slotEligibility';
import { peopleWhoCanReachOrder } from '../lib/permissions/logisticOrderApprovers';
import { readersWithEntityAccess } from '../lib/tasks/entityAccessCohort';
import { findSwitch } from '../lib/permissions/switches/catalog';

type Mock = ReturnType<typeof vi.fn>;
const db = prisma as unknown as {
  user: { findMany: Mock; findUnique: Mock; findFirst: Mock };
  permissionUserSwitch: { findMany: Mock };
  permissionRoleSwitch: { findMany: Mock };
  customRole: { findMany: Mock; findFirst: Mock };
  logisticOrder: { count: Mock };
  job: { findFirst: Mock };
  trainingScenario: { findFirst: Mock };
};

const PEOPLE = 50;

/** 50 technicians, each on a custom role of their own (the shape that made the reads grow with the roles). */
const roster = Array.from({ length: PEOPLE }, (_, i) => ({
  id: `00000000-0000-0000-0000-${String(i + 1).padStart(12, '0')}`,
  organization_id: ALPHA_ORG_ID,
  role: 'TECHNICIAN',
  is_active: true,
  based_on_role_key: null,
  department_id: null,
  location_id: null,
  custom_role_id: `cr-${i}`,
  custom_role: { key: `role-${i}` },
}));

/** Every database read that can resolve a person's switches or role. */
const switchReads = () =>
  [db.user.findMany, db.user.findUnique, db.user.findFirst, db.permissionUserSwitch.findMany, db.permissionRoleSwitch.findMany,
    db.customRole.findMany, db.customRole.findFirst].reduce((n, fn) => n + fn.mock.calls.length, 0);

beforeEach(() => {
  vi.clearAllMocks();
  clearAllSwitchCaches();
  // A demo org: the Training endpoints are behind the pilot-or-demo org gate (S08.16).
  mockAuthAs('admin', { is_demo: true });
  db.customRole.findFirst.mockReset();
  db.user.findMany.mockResolvedValue(roster);
  db.customRole.findMany.mockResolvedValue(roster.map((p, i) => ({
    key: `role-${i}`, label: `Role ${i}`, base_role: 'TECHNICIAN', made_from_blank: false,
  })));
  // Only the roster's first person holds anything stored: a role row and an own row for Can be a dispatcher.
  db.permissionRoleSwitch.findMany.mockResolvedValue([{ role_key: 'role-0', switch_key: 'can_be_dispatcher', value: true }]);
  db.permissionUserSwitch.findMany.mockResolvedValue([{ user_id: roster[1]!.id, switch_key: 'can_be_dispatcher', value: true }]);
});

describe('resolving many people at once', () => {
  it('reads a constant number of times for 50 people on 50 roles, and answers each from their own role and values', async () => {
    const answers = await resolveSwitchesForPeople(roster, ['can_be_dispatcher', 'can_be_on_crew']);

    expect(switchReads()).toBeLessThanOrEqual(4);
    expect(answers.size).toBe(PEOPLE);
    const dispatcherOf = (i: number) => answers.get(roster[i]!.id)!.can_be_dispatcher;
    expect(dispatcherOf(0)).toBe(true); // its role's stored row
    expect(dispatcherOf(1)).toBe(true); // the person's own row
    expect(dispatcherOf(2)).toBe(findSwitch('can_be_dispatcher')!.presets.TECHNICIAN); // the base preset
    expect(Object.keys(answers.get(roster[0]!.id)!).sort()).toEqual(['can_be_dispatcher', 'can_be_on_crew']);
  });

  it('answers every switch for 50 people in the same constant number of reads', async () => {
    const answers = await resolveSwitchesForPeople(roster);
    expect(switchReads()).toBeLessThanOrEqual(4);
    expect(answers.get(roster[0]!.id)).toEqual({ ...presetValues('TECHNICIAN'), can_be_dispatcher: true });
    expect(Object.keys(answers.get(roster[5]!.id)!)).toEqual(Object.keys(presetValues('TECHNICIAN')));
  });

  it('holds every switch on for the Admin box without reading anything', async () => {
    const box = { id: 'box', organization_id: ALPHA_ORG_ID, role: 'ADMIN' };
    const answers = await resolveSwitchesForPeople([box]);
    expect(switchReads()).toBe(0);
    expect(answers.get('box')).toEqual(presetValues('ADMIN'));
  });

  it('answers a person already cached from the cache, as the one-at-a-time resolver does', async () => {
    await resolveSwitchesForPeople(roster);
    vi.clearAllMocks();
    const again = await resolveSwitchesForPeople(roster);
    expect(switchReads()).toBe(0);
    expect(again.size).toBe(PEOPLE);
  });

  it('reads fresh for named switches, whatever the cache holds', async () => {
    await resolveSwitchesForPeople(roster);
    vi.clearAllMocks();
    db.user.findMany.mockResolvedValue(roster);
    await resolveSwitchesForPeople(roster, ['can_be_on_crew']);
    expect(switchReads()).toBeGreaterThan(0);
  });

  it('refuses a switch the catalog does not hold', async () => {
    await expect(resolveSwitchesForPeople(roster, ['no_such_switch'])).rejects.toThrow('Unknown permission switch');
  });
});

describe('the callers that ask about a whole company', () => {
  it('the switch-holder lookup (alerts) reads a constant number of times', async () => {
    const holders = await activeSwitchHolders(ALPHA_ORG_ID, 'can_be_dispatcher');
    expect(switchReads()).toBeLessThanOrEqual(5);
    expect(holders).toEqual(expect.arrayContaining([roster[0]!.id, roster[1]!.id]));
  });

  it('the slot roster filter (owner, dispatcher, crew) reads a constant number of times', async () => {
    for (const slot of ['owner', 'dispatcher', 'crew'] as const) {
      vi.clearAllMocks();
      db.user.findMany.mockResolvedValue(roster);
      await eligibleUserIds(ALPHA_ORG_ID, slot);
      expect(switchReads(), slot).toBeLessThanOrEqual(5);
    }
  });

  it('the logistic order reach lookup reads a constant number of times for 50 people', async () => {
    db.permissionRoleSwitch.findMany.mockResolvedValue(roster.map((_, i) => ({ role_key: `role-${i}`, switch_key: 'approve_logistic_orders', value: true })));
    db.logisticOrder.count.mockResolvedValue(1);
    const approvers = await peopleWhoCanReachOrder(ALPHA_ORG_ID, 'order-1', roster.map((p) => p.id));
    expect(approvers).toHaveLength(PEOPLE);
    // The people asked about (50) are read once and their switches in one round of the constant set.
    expect(switchReads()).toBeLessThanOrEqual(10);
    // At most one probe per person (an attached reach is per person, so one answer each).
    expect(db.logisticOrder.count.mock.calls.length).toBeLessThanOrEqual(PEOPLE);
  });

  it('the task cohort (assignee access warning) reads a constant number of times for 50 readers', async () => {
    db.job.findFirst.mockResolvedValue({ id: 'job-1' });
    await readersWithEntityAccess(roster, { type: 'JOB', id: 'job-1' });
    expect(switchReads()).toBeLessThanOrEqual(4);
  });

  it('the users list role column reads a constant number of times for 50 roles', async () => {
    const out = await summarizePeopleRoles(ALPHA_ORG_ID, roster);
    expect(switchReads()).toBeLessThanOrEqual(3);
    expect(out.get(roster[3]!.id)).toEqual({ role_label: 'Role 3', change_count: 0 });
    expect(out.get(roster[1]!.id)).toEqual({ role_label: 'Role 1', change_count: 1 });
  });

  it('GET /api/inventory/techs reads a constant number of times for 50 people', async () => {
    const users = roster.map((p, i) => ({ ...p, first_name: `Tech${i}`, last_name: 'T', email: `t${i}@example.test`, department: null }));
    db.user.findMany.mockResolvedValue(users);
    const res = await request(app).get('/api/inventory/techs').set(authHeader('admin'));
    expect(res.status).toBe(200);
    expect(res.body.techs).toHaveLength(PEOPLE);
    expect(switchReads()).toBeLessThanOrEqual(8);
  });
});

describe('GET /api/communication/training/scenarios/:id', () => {
  const idsCompared = () => {
    const where = db.trainingScenario.findFirst.mock.calls[0]![0].where as { OR: Record<string, string>[] };
    return where.OR.filter((clause) => 'id' in clause).map((clause) => clause.id);
  };

  it('looks a slug up by slug only: a slug is not a uuid, and comparing it with the uuid column makes the database fail', async () => {
    db.trainingScenario.findFirst.mockResolvedValue({ id: 'x', slug: 'trn_book_new', title: 'Book' });
    await request(app).get('/api/communication/training/scenarios/trn_book_new').set(authHeader('admin'));
    expect(db.trainingScenario.findFirst).toHaveBeenCalled();
    expect(idsCompared()).toEqual([]);
  });

  it('still finds a scenario by its uuid, or by a slug', async () => {
    const id = '3f2b8c1e-9d4a-4e6b-8a7c-1b2c3d4e5f60';
    db.trainingScenario.findFirst.mockResolvedValue(null);
    await request(app).get(`/api/communication/training/scenarios/${id}`).set(authHeader('admin'));
    expect(idsCompared()).toEqual([id]);
  });
});
