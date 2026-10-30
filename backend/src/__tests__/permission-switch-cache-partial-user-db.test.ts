/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.8 (post-merge fix 1) - a person's switch values are never
   resolved from a partial user row.

   The per-person switch cache holds a person's values for a minute. A caller that asked for a person's
   switches with a user row that lacked the custom role (the notification recipient filter, the task
   assignee cohort) resolved the person as their BASE role, and the base role's preset - everything on
   for a Dispatcher - sat in the cache under that person's id. Their own next request then got the
   preset instead of the values their role stores.

   Everything goes through the public interfaces: the notification recipient filter, the assignee
   cohort, the switch resolver, and the person's own request (`/api/auth/me`, a job route). Real
   migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is
   removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

// One factory for every client in this file (see permission-switches-db.test.ts for why).
const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues, resolveSwitches } from '../lib/permissions/switches/store';
import { clearAllSwitchCaches } from '../lib/permissions/switches/cache';
import { filterRecipientsByAccess } from '../services/notifications/filterByAccess';

const suite = realClient ? describe : describe.skip;

// Loaded on use: the cohort module reads the app's client when it loads, and without a database that
// client is undefined, so a static import would throw before the skip takes effect.
const readersWithEntityAccess = async (...args: Parameters<typeof import('../lib/tasks/entityAccessCohort.js').readersWithEntityAccess>) =>
  (await import('../lib/tasks/entityAccessCohort.js')).readersWithEntityAccess(...args);

suite('a partial user row never poisons the switch cache (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());
  beforeEach(() => clearAllSwitchCaches());

  type Rule = { action: string; subject: string };
  let sequence = 0;

  /** The switches a Dispatcher preset holds that the role under test turns off. */
  const OFF = {
    complete_jobs: false, update_any_visit_status: false, assign_people_to_jobs: false,
    duplicate_jobs: false, edit_job_line_items: false,
  };

  /** A person on a custom role (based on Dispatcher, so the base preset is everything on) with these switches off. */
  async function bareDispatcher(org: string, values: Record<string, boolean | string> = {}): Promise<Person & { key: string }> {
    const key = `bare-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', jobs_scope: 'all', view_jobs: true, ...OFF, ...values },
      actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `bare${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    return Object.assign(person, { key });
  }

  const rulesOf = async (person: Person): Promise<Rule[]> =>
    (await (await fx.signedInAs(person)).get('/api/auth/me')).body.abilityRules as Rule[];
  const holdsOnJob = (rules: Rule[], action: string) => rules.some((r) => r.subject === 'Job' && r.action === action);

  /** What the person's own request is told, for each switch that is off. */
  function expectSwitchesOff(rules: Rule[]) {
    for (const action of ['complete', 'update_any_visit_status', 'assign', 'unassign', 'duplicate', 'manage_lines']) {
      expect(holdsOnJob(rules, action), action).toBe(false);
    }
  }

  it('keeps the person on their own values after a notification recipient check on a job', async () => {
    const { org, customer } = await fx.newOrg();
    const person = await bareDispatcher(org);
    const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });

    expectSwitchesOff(await rulesOf(person));
    clearAllSwitchCaches();

    // The notification path, as a job being created or changed would run it, for this person as recipient.
    await filterRecipientsByAccess('JOB', job.id, [person.id], org);

    expectSwitchesOff(await rulesOf(person));
    const refused = await (await fx.signedInAs(person)).post(`/api/jobs/${job.id}/complete`, {});
    expect(refused.status).toBe(403);
    expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).status).toBe('IN_PROGRESS');
  });

  it('keeps the person on their own values after the task assignee cohort is asked about them with a plain user row', async () => {
    const { org, customer } = await fx.newOrg();
    const person = await bareDispatcher(org);
    const job = await fx.addJob(org, customer);

    // A plain `users` row without the custom role, the way a careless caller selects a person.
    const plain = await db.user.findUniqueOrThrow({
      where: { id: person.id },
      select: { id: true, role: true, organization_id: true, department_id: true, location_id: true },
    });
    await readersWithEntityAccess([plain], { type: 'JOB', id: job.id });

    expectSwitchesOff(await rulesOf(person));
  });

  it('resolves a person from the stored person, whatever user row the caller hands it', async () => {
    const { org } = await fx.newOrg();
    const person = await bareDispatcher(org);

    const values = await resolveSwitches({ id: person.id, role: 'DISPATCHER', organization_id: org });

    for (const key of Object.keys(OFF)) expect(values[key], key).toBe(false);
    // Asked again with the whole user row, the same values come back from the cache.
    const whole = await db.user.findUniqueOrThrow({ where: { id: person.id }, select: { id: true, role: true, organization_id: true, custom_role_id: true, custom_role: { select: { key: true } } } });
    expect(await resolveSwitches(whole)).toEqual(values);
  });

  it('does not let a person who differs from the others on their role share their answer in the assignee cohort', async () => {
    const { org, customer } = await fx.newOrg();
    const role = await fx.addCustomRole(org, `shared-role-${++sequence}`, 'DISPATCHER');
    await setRoleSwitchValues({
      organizationId: org, roleKey: role.key, values: { leads_scope: 'all', jobs_scope: 'all', view_jobs: true }, actorId: null, reason: 'manual',
    });
    const sees = await fx.addUser(org, `sees${++sequence}`, 'DISPATCHER', { customRoleId: role.id });
    const blind = await fx.addUser(org, `blind${++sequence}`, 'DISPATCHER', { customRoleId: role.id });
    // The same role, but this person was tailored to see no jobs.
    await db.permissionUserSwitch.createMany({
      data: [
        { organization_id: org, user_id: blind.id, switch_key: 'view_jobs', value: false },
        { organization_id: org, user_id: blind.id, switch_key: 'jobs_scope', value: 'attached' },
      ],
    });
    clearAllSwitchCaches();
    const job = await fx.addJob(org, customer);

    const readers = await db.user.findMany({
      where: { id: { in: [sees.id, blind.id] } },
      select: { id: true, role: true, organization_id: true, department_id: true, location_id: true, custom_role_id: true, custom_role: { select: { key: true } } },
    });
    // Either order: the first reader of the role must not decide for the second.
    for (const order of [readers, [...readers].reverse()]) {
      clearAllSwitchCaches();
      const { withAccess } = await readersWithEntityAccess(order, { type: 'JOB', id: job.id });
      expect(withAccess.has(sees.id)).toBe(true);
      expect(withAccess.has(blind.id)).toBe(false);
    }
  });
});
