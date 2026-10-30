/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.13 - the job page's controls follow the per-record action list.

   GET /api/jobs/:id carries `actions`: what THIS person may do on THIS job, decided on the server from the person's
   switches and where they stand on the job. The job page draws a control only when its action is listed, and the
   job routes ask the same switches, so a listed action is one the route lets in and an unlisted one is refused.

   Everything goes through the public interface: the job routes, called as people on custom roles (never a
   built-in role name) holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL);
   the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient, Role } from '@prisma/client';

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

// The suite-wide setup hands every record the same number; the duplicate case creates a second job in one company.
vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { withDependantsOff } from './support/switchDependants';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, presetSwitchSet, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** The page's actions and the one switch each stands on (the slice's own table, not read from the code under test). */
const ACTION_SWITCH = {
  edit: 'edit_jobs',
  assign: 'assign_people_to_jobs',
  schedule: 'schedule_visits',
  complete: 'complete_jobs',
  cancel: 'cancel_jobs',
  delete: 'delete_jobs',
  duplicate: 'duplicate_jobs',
  create_invoice: 'create_invoices',
  create_estimate: 'create_estimates',
  renumber: 'edit_job_record_ids',
  edit_line_items: 'edit_job_line_items',
  add_note: 'add_notes',
  log_communication: 'log_past_communications',
} as const;
type JobAction = keyof typeof ACTION_SWITCH;

/** Edit jobs also lists the job's own data actions: a note and an upload are the job's own data (P10), so its Edit adds them. */
const EDIT_BRINGS: string[] = ['edit', 'add_note', 'upload_attachment'];
const ACTIONS = Object.keys(ACTION_SWITCH) as JobAction[];

/**
 * Create requires Edit (AL-04): holding the switch behind some actions takes other switches too. The extras are valid
 * together, and an extra that is itself a page action is listed with it (Duplicate needs Create jobs, which needs Edit jobs).
 */
const ALSO_HOLDS: Partial<Record<JobAction, Record<string, SwitchValue>>> = {
  duplicate: { edit_jobs: true, create_jobs: true },
  create_invoice: { edit_invoices: true },
  create_estimate: { edit_estimates: true },
};
const ALSO_LISTED: Partial<Record<JobAction, JobAction[]>> = { duplicate: ['edit'] };
/** The page's order, the server's. */
const PAGE_ORDER: string[] = [
  'edit', 'assign', 'schedule', 'complete', 'cancel', 'delete', 'duplicate', 'create_invoice', 'create_estimate', 'renumber',
  'edit_line_items', 'apply_discount', 'add_note', 'upload_attachment', 'log_communication',
];
/** Edit jobs also lists the job's own data actions: a note and an upload are the job's own data (P10), so its Edit adds them. */
const withOwnData = (held: Set<string>) => {
  if (held.has('edit')) { held.add('add_note'); held.add('upload_attachment'); }
  return PAGE_ORDER.filter((a) => held.has(a));
};
/** The actions a person holding `action`'s switch (and what it takes) is listed, in the page's order. */
const listedFor = (action: JobAction) => withOwnData(new Set<string>([action, ...(ALSO_LISTED[action] ?? [])]));

/** What opening the job and holding a switch's requirements takes, with no action switch on. */
const OPENING = {
  view_jobs: true, jobs_scope: 'all',
  // View leads too: an estimate on a lead is reached only with it (ticket 33), and an estimate reach narrower than All limits
  // Create estimates to the jobs the person is crew on.
  view_communication: true, view_invoices: true, view_estimates: true, view_leads: true, leads_scope: 'all',
};

suite('the job page action list comes from the server (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values over everything else off. */
  async function personWith(
    org: string,
    values: Record<string, SwitchValue>,
    base: Role = 'DISPATCHER',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `job-actions-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, see_prices: true, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  async function actionsOn(api: Api, jobId: string): Promise<string[]> {
    const res = await api.get(`/api/jobs/${jobId}`);
    expect(res.status).toBe(200);
    return res.body.job.actions;
  }

  it('lists nothing for a person who can open the job and holds no action switch', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, OPENING);
    const job = await fx.addJob(org, customer, {});
    expect(await actionsOn(await me.api(), job.id)).toEqual([]);
  });

  for (const action of ACTIONS) {
    it(`lists ${action} for the person holding ${ACTION_SWITCH[action]}, and only that`, async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { ...OPENING, ...ALSO_HOLDS[action], [ACTION_SWITCH[action]]: true });
      const job = await fx.addJob(org, customer, {});
      expect(await actionsOn(await me.api(), job.id)).toEqual(listedFor(action));
    });
  }

  it('lists, for the Technician preset values, exactly the actions whose switch the preset holds', async () => {
    const { org, customer } = await fx.newOrg();
    const me = await personWith(org, presetSwitchSet('TECHNICIAN'), 'TECHNICIAN');
    const job = await fx.addJob(org, customer, { crew: [me.id] });
    const preset = presetSwitchSet('TECHNICIAN');
    const expected = withOwnData(new Set<string>(ACTIONS.filter((a) => preset[ACTION_SWITCH[a]] === true)));
    const actions = await actionsOn(await me.api(), job.id);
    expect(actions).toEqual(expected);
    // The controls the slice takes away from a technician are not there.
    // AL-04: the Technician preset now holds Edit jobs (Create jobs requires it), so Edit is listed; the rest are not.
    expect(actions).toContain('edit');
    for (const gone of ['assign', 'schedule', 'cancel', 'delete', 'complete', 'duplicate'] as const) {
      expect(actions, gone).not.toContain(gone);
    }
  });

  it('lists create_estimate under a reach over estimates narrower than All only on a job the person is crewed on', async () => {
    const { org, customer } = await fx.newOrg();
    const colleague = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
    // Every job opens (Jobs scope All) but the Leads scope is Attached, so the reach over estimates is narrower than All (P6).
    const me = await personWith(org, { ...OPENING, jobs_scope: 'all', leads_scope: 'attached', edit_estimates: true, create_estimates: true });
    const mine = await fx.addJob(org, customer, { crew: [me.id] });
    const theirs = await fx.addJob(org, customer, { crew: [colleague.id] });
    const api = await me.api();
    expect(await actionsOn(api, mine.id)).toEqual(['create_estimate']);
    expect(await actionsOn(api, theirs.id)).toEqual([]);
    expect((await api.post(`/api/jobs/${mine.id}/estimates`, {})).status).not.toBe(403);
    expect((await api.post(`/api/jobs/${theirs.id}/estimates`, {})).status).toBe(403);
  });

  it('takes the actions away on the next request once the person is off the job', async () => {
    const { org, customer } = await fx.newOrg();
    const colleague = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
    const me = await personWith(org, { ...OPENING, jobs_scope: 'attached', edit_jobs: true });
    const job = await fx.addJob(org, customer, { crew: [me.id, colleague.id] });
    const api = await me.api();
    expect(await actionsOn(api, job.id)).toEqual(EDIT_BRINGS);
    await fx.removeCrew(job.visitId!, me.id);
    // Off the only visit and under Attached scope, the person no longer opens the job, so nothing is listed.
    const res = await api.get(`/api/jobs/${job.id}`);
    expect(res.status).not.toBe(200);
    expect(res.body.job?.actions).toBeUndefined();
  });

  describe('the routes let in exactly where the list says', () => {
    const uuid = () => randomUUID();
    const when = { scheduled_start: '2030-01-01T10:00:00.000Z', scheduled_end: '2030-01-01T11:00:00.000Z' };

    /** Every verb the page offers a control for, as the call that control makes. */
    const CALLS: Record<JobAction, (api: Api, job: { id: string; visitId?: string }) => Promise<{ status: number }>> = {
      edit: (api, job) => api.patch(`/api/jobs/${job.id}`, { description: 'changed' }),
      assign: (api, job) => api.post(`/api/jobs/${job.id}/dispatcher`, { dispatcher_id: null }),
      schedule: (api, job) => api.post(`/api/jobs/${job.id}/visits`, when),
      complete: (api, job) => api.post(`/api/jobs/${job.id}/complete`, {}),
      cancel: (api, job) => api.post(`/api/jobs/${job.id}/cancel`, { reason: 'Customer changed their mind' }),
      delete: (api, job) => api.delete(`/api/jobs/${job.id}`),
      duplicate: (api, job) => api.post(`/api/jobs/${job.id}/duplicate`, {}),
      create_invoice: (api, job) => api.post(`/api/jobs/${job.id}/invoices`, {}),
      create_estimate: (api, job) => api.post(`/api/jobs/${job.id}/estimates`, {}),
      renumber: (api, job) => api.patch(`/api/jobs/${job.id}/number`, { job_number: `JN-${uuid().slice(0, 8)}` }),
      edit_line_items: (api, job) => api.post(`/api/jobs/${job.id}/line-items`, { description: 'Hinge', quantity: 1, unit_price: 10 }),
      add_note: (api, job) => api.post(`/api/jobs/${job.id}/notes`, { content: 'a note' }),
      log_communication: (api, job) => api.post('/api/communication/manual-log', {}),
    };

    for (const action of ACTIONS) {
      it(`${action}: refused without ${ACTION_SWITCH[action]}, not refused with it`, async () => {
        const { org, customer } = await fx.newOrg();
        const without = await personWith(org, OPENING);
        const withIt = await personWith(org, { ...OPENING, ...ALSO_HOLDS[action], [ACTION_SWITCH[action]]: true });
        const a = await fx.addJob(org, customer, {});
        const b = await fx.addJob(org, customer, {});
        expect((await CALLS[action](await without.api(), a)).status).toBe(403);
        expect((await CALLS[action](await withIt.api(), b)).status).not.toBe(403);
      });
    }

    it('refuses every verb the Technician preset values leave out, and the tag and sub-status doors', async () => {
      const { org, customer } = await fx.newOrg();
      // AL-04: the Technician preset holds Edit jobs now (Create jobs requires it), and the edit, tag and sub-status doors
      // stand on Edit jobs. So the doors are checked for a Technician whose Edit jobs (and Create jobs) is taken off.
      const me = await personWith(org, { ...presetSwitchSet('TECHNICIAN'), edit_jobs: false, create_jobs: false }, 'TECHNICIAN');
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const api = await me.api();
      const calls: [string, Promise<{ status: number }>][] = [
        ['edit details', api.patch(`/api/jobs/${job.id}`, { description: 'changed', job_type: 'Other' })],
        ['edit service location', api.patch(`/api/jobs/${job.id}`, { service_location_id: uuid() })],
        ['add tag', api.post(`/api/jobs/${job.id}/tags`, { tag_id: uuid() })],
        ['remove tag', api.delete(`/api/jobs/${job.id}/tags/${uuid()}`)],
        ['set sub-status', api.post(`/api/jobs/${job.id}/sub-status`, { sub_status_id: null })],
        ['add visit', api.post(`/api/jobs/${job.id}/visits`, when)],
        ['reschedule visit', api.patch(`/api/jobs/${job.id}/visits/${job.visitId}`, when)],
        ['cancel visit', api.post(`/api/jobs/${job.id}/visits/${job.visitId}/cancel`, {})],
        ['assign', api.post(`/api/jobs/${job.id}/assign`, { assignee_ids: [me.id] })],
        ['set crew', api.post(`/api/jobs/${job.id}/assignees`, { assignee_ids: [me.id] })],
        ['set visit crew', api.post(`/api/jobs/${job.id}/visits/${job.visitId}/assignees`, { assignee_ids: [me.id] })],
        ['unassign', api.post(`/api/jobs/${job.id}/unassign`, { user_id: me.id })],
        ['set dispatcher', api.post(`/api/jobs/${job.id}/dispatcher`, { dispatcher_id: me.id })],
        ['set sold by', api.post(`/api/jobs/${job.id}/sold-by`, { salesperson_id: me.id })],
        ['cancel', api.post(`/api/jobs/${job.id}/cancel`, { reason: 'x' })],
        ['delete', api.delete(`/api/jobs/${job.id}`)],
        ['job-level complete', api.post(`/api/jobs/${job.id}/complete`, {})],
        ['duplicate', api.post(`/api/jobs/${job.id}/duplicate`, {})],
        ['renumber', api.patch(`/api/jobs/${job.id}/number`, { job_number: 'J-NEW' })],
        ['create invoice', api.post(`/api/jobs/${job.id}/invoices`, {})],
      ];
      for (const [name, call] of calls) expect((await call).status, name).toBe(403);
    });
  });
});
