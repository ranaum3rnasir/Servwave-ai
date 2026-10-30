/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.3 - estimates and invoices open by Data Scope, with the kept
   "Through own leads" value.

   Everything goes through the public interface: the catalog read, the role store, and the estimate and
   invoice routes, called as people on custom roles (never a built-in role name) whose Estimates scope and
   Invoices scope are the switch values under test. Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';
import { randomUUID } from 'crypto';

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
import { ALL_ACCEPTED_METHODS, SWITCH_CATALOG, findSwitch, presetSwitchSet, type BuiltInRole, type SwitchValue } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { validateSwitchSet } from '../lib/permissions/switches/validate';
import { clearPermissionCache } from '../lib/permissions/permissionCache';

const suite = realClient ? describe : describe.skip;

suite('estimates and invoices open by Data Scope (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** Every switch that stands on this one, directly or through another (turning this off takes them all off). */
  /** What a switch needs on before it can be on (View payments for Refund payments), all the way down. */
  const needing = (key: string): string[] => {
    const direct = findSwitch(key)!.requires;
    return [...new Set([...direct, ...direct.flatMap(needing)])];
  };
  const standingOn = (key: string): string[] => {
    const direct = SWITCH_CATALOG.filter((s) => s.requires.includes(key)).map((s) => s.key);
    return [...new Set([...direct, ...direct.flatMap(standingOn)])];
  };

  /**
   * A person on a fresh custom role holding exactly these switch values on top of the base role's
   * preset. A role based on Sales holds the kept "Through own leads" value without being given it.
   */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { base?: 'DISPATCHER' | 'SALES' | 'TECHNICIAN'; departmentId?: string; locationId?: string; name?: string } = {},
  ): Promise<Person & { api: () => Promise<Api>; roleKey: string }> {
    const key = `ei-role-${++sequence}`;
    const base = opts.base ?? 'DISPATCHER';
    // The role copies the legacy grants of its base the way creating a role does; the catalog, not
    // those stored grants, decides what the person reaches in estimates and invoices.
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, opts.name ?? `p${sequence}`, base, {
      customRoleId: role.id, departmentId: opts.departmentId, locationId: opts.locationId,
    });
    return Object.assign(person, { api: () => fx.signedInAs(person), roleKey: key });
  }

  const listed = async (api: Api, path: string, key: 'estimates' | 'invoices') => {
    const res = await api.get(path);
    expect(res.status).toBe(200);
    return (res.body[key] as { id: string }[]).map((r) => r.id);
  };
  const listedEstimates = (api: Api) => listed(api, '/api/estimates', 'estimates');
  const listedInvoices = (api: Api) => listed(api, '/api/invoices', 'invoices');

  describe('Attached on Estimates scope', () => {
    type Path = {
      name: string;
      attach: (org: string, customer: string, me: Person, admin: Person) => Promise<{ id: string; detach: () => Promise<unknown> }>;
    };
    const paths: Path[] = [
      {
        name: 'an assignee of its lead',
        attach: async (org, customer, me, admin) => {
          const lead = await fx.addLead(org, customer, { assignees: [me.id] });
          const e = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
          return { id: e.id, detach: () => db.leadAssignee.deleteMany({ where: { lead_id: lead.id, user_id: me.id } }) };
        },
      },
      {
        name: 'the Owner of its lead',
        attach: async (org, customer, me, admin) => {
          const lead = await fx.addLead(org, customer, { owner: me.id });
          const e = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
          return { id: e.id, detach: () => db.lead.update({ where: { id: lead.id }, data: { commission_owner_id: null } }) };
        },
      },
      {
        name: 'on the walkthrough crew of its lead',
        attach: async (org, customer, me, admin) => {
          const lead = await fx.addLead(org, customer, { walkthroughCrew: [me.id] });
          const e = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
          return { id: e.id, detach: () => fx.removeCrew(lead.walkthroughId!, me.id) };
        },
      },
      {
        name: 'the Dispatcher of its lead',
        attach: async (org, customer, me, admin) => {
          const lead = await fx.addLead(org, customer, { dispatcher: me.id });
          const e = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
          return { id: e.id, detach: () => db.lead.update({ where: { id: lead.id }, data: { dispatcher_id: null } }) };
        },
      },
      {
        name: 'on the crew of the job it is attached to',
        attach: async (org, customer, me, admin) => {
          const job = await fx.addJob(org, customer, { crew: [me.id] });
          const e = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
          return { id: e.id, detach: () => fx.removeCrew(job.visitId!, me.id) };
        },
      },
      {
        name: 'on the crew of the job it produced',
        attach: async (org, customer, me) => {
          const lead = await fx.addLead(org, customer, {});
          const job = await fx.addJob(org, customer, { fromLead: lead.id, crew: [me.id] });
          return { id: job.estimateId!, detach: () => fx.removeCrew(job.visitId!, me.id) };
        },
      },
    ];

    it.each(paths)('lets a person on Attached open the estimate and see it listed when they are $name, and hides it on the next request once they are not', async (path) => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { estimates_scope: 'attached' });
      const api = await me.api();
      const decoy = await fx.addEstimate(org, customer, admin.id);
      const attached = await path.attach(org, customer, me, admin);

      expect((await api.get(`/api/estimates/${attached.id}`)).status).toBe(200);
      const ids = await listedEstimates(api);
      expect(ids).toContain(attached.id);
      expect(ids).not.toContain(decoy.id);
      expect((await api.get(`/api/estimates/${decoy.id}`)).status).toBe(403);

      await attached.detach();

      expect((await api.get(`/api/estimates/${attached.id}`)).status).toBe(403);
      expect(await listedEstimates(api)).not.toContain(attached.id);
    });

    it('does not let the person who created an estimate open it when they are on nothing', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { estimates_scope: 'attached' });
      const lead = await fx.addLead(org, customer, {});
      const estimate = await fx.addEstimate(org, customer, me.id, { leadId: lead.id });
      const api = await me.api();

      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(403);
      expect(await listedEstimates(api)).not.toContain(estimate.id);
    });
  });

  describe('Attached on Invoices scope', () => {
    type Path = {
      name: string;
      attach: (org: string, customer: string, me: Person) => Promise<{ id: string; detach: () => Promise<unknown> }>;
    };
    const paths: Path[] = [
      {
        name: 'crew on the job it is on',
        attach: async (org, customer, me) => {
          const job = await fx.addJob(org, customer, { crew: [me.id] });
          const inv = await fx.addInvoice(org, customer, { jobId: job.id });
          return { id: inv.id, detach: () => fx.removeCrew(job.visitId!, me.id) };
        },
      },
      {
        name: 'Sold By on the job it is on',
        attach: async (org, customer, me) => {
          const job = await fx.addJob(org, customer, { soldBy: me.id });
          const inv = await fx.addInvoice(org, customer, { jobId: job.id });
          return { id: inv.id, detach: () => db.job.update({ where: { id: job.id }, data: { salesperson_id: null } }) };
        },
      },
      {
        name: 'Dispatcher on the job it is on',
        attach: async (org, customer, me) => {
          const job = await fx.addJob(org, customer, { dispatcher: me.id });
          const inv = await fx.addInvoice(org, customer, { jobId: job.id });
          return { id: inv.id, detach: () => db.job.update({ where: { id: job.id }, data: { dispatcher_id: null } }) };
        },
      },
      {
        name: 'an assignee of the lead of the estimate of a deposit invoice with no job yet',
        attach: async (org, customer, me) => {
          const lead = await fx.addLead(org, customer, { assignees: [me.id] });
          const estimate = await fx.addEstimate(org, customer, (await fx.addUser(org, `mk${++sequence}`, 'SALES')).id, { leadId: lead.id });
          const inv = await fx.addInvoice(org, customer, { estimateId: estimate.id });
          return { id: inv.id, detach: () => db.leadAssignee.deleteMany({ where: { lead_id: lead.id, user_id: me.id } }) };
        },
      },
      {
        name: 'crew on the job of the estimate of a deposit invoice with no job yet',
        attach: async (org, customer, me) => {
          const job = await fx.addJob(org, customer, { crew: [me.id] });
          const estimate = await fx.addEstimate(org, customer, (await fx.addUser(org, `mk${++sequence}`, 'SALES')).id, { jobId: job.id });
          const inv = await fx.addInvoice(org, customer, { estimateId: estimate.id });
          return { id: inv.id, detach: () => fx.removeCrew(job.visitId!, me.id) };
        },
      },
    ];

    it.each(paths)('lets a person on Attached open the invoice and see it listed when they are $name, and hides it on the next request once they are not', async (path) => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { invoices_scope: 'attached' });
      const api = await me.api();
      const decoy = await fx.addInvoice(org, customer);
      const attached = await path.attach(org, customer, me);

      expect((await api.get(`/api/invoices/${attached.id}`)).status).toBe(200);
      const ids = await listedInvoices(api);
      expect(ids).toContain(attached.id);
      expect(ids).not.toContain(decoy.id);
      expect((await api.get(`/api/invoices/${decoy.id}`)).status).toBe(403);

      await attached.detach();

      expect((await api.get(`/api/invoices/${attached.id}`)).status).toBe(403);
      expect(await listedInvoices(api)).not.toContain(attached.id);
    });

    it('does not let a person on the lead\'s walkthrough crew only open the invoice of the converted job, and lets them open a deposit invoice that has no job yet', async () => {
      const { org, customer } = await fx.newOrg();
      const walker = await personWith(org, { invoices_scope: 'attached', jobs_scope: 'attached', estimates_scope: 'attached' });
      const lead = await fx.addLead(org, customer, { walkthroughCrew: [walker.id] });
      const crew = await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN');
      const job = await fx.addJob(org, customer, { fromLead: lead.id, crew: [crew.id] });
      const jobInvoice = await fx.addInvoice(org, customer, { jobId: job.id, estimateId: job.estimateId });
      const depositEstimate = await fx.addEstimate(org, customer, crew.id, { leadId: lead.id });
      const depositInvoice = await fx.addInvoice(org, customer, { estimateId: depositEstimate.id });
      const api = await walker.api();

      expect((await api.get(`/api/invoices/${jobInvoice.id}`)).status).toBe(403);
      expect(await listedInvoices(api)).not.toContain(jobInvoice.id);
      expect((await api.get(`/api/invoices/${depositInvoice.id}`)).status).toBe(200);
      expect(await listedInvoices(api)).toContain(depositInvoice.id);
    });

    it('does not let the person who created an invoice open it when they are on nothing', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { invoices_scope: 'attached' });
      // On a job the person is not on (an invoice for a customer alone stays its creator's for good: S01.4).
      const someoneElsesJob = await fx.addJob(org, customer, { crew: [(await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN')).id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: someoneElsesJob.id, createdBy: me.id });
      const api = await me.api();

      expect((await api.get(`/api/invoices/${invoice.id}`)).status).toBe(403);
      expect(await listedInvoices(api)).not.toContain(invoice.id);
    });
  });

  describe('Team and Location', () => {
    it('reach estimates and invoices with someone attached in the person\'s department or location, and nothing for a person with neither', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const [mine, theirs] = [await fx.addDepartment(org, 'mine'), await fx.addDepartment(org, 'theirs')];
      const [here, there] = [await fx.addLocation(org, 'here'), await fx.addLocation(org, 'there')];
      const teammate = await fx.addUser(org, 'mate', 'TECHNICIAN', { departmentId: mine, locationId: here });
      const stranger = await fx.addUser(org, 'away', 'TECHNICIAN', { departmentId: theirs, locationId: there });
      const mateJob = await fx.addJob(org, customer, { crew: [teammate.id] });
      const strangerJob = await fx.addJob(org, customer, { crew: [stranger.id] });
      const mateEstimate = await fx.addEstimate(org, customer, admin.id, { jobId: mateJob.id });
      const strangerEstimate = await fx.addEstimate(org, customer, admin.id, { jobId: strangerJob.id });
      const mateInvoice = await fx.addInvoice(org, customer, { jobId: mateJob.id });
      const strangerInvoice = await fx.addInvoice(org, customer, { jobId: strangerJob.id });

      for (const [scope, opts] of [['team', { departmentId: mine }], ['location', { locationId: here }]] as const) {
        const me = await personWith(org, { estimates_scope: scope, invoices_scope: scope }, opts);
        const api = await me.api();
        const estimates = await listedEstimates(api);
        expect(estimates, scope).toContain(mateEstimate.id);
        expect(estimates, scope).not.toContain(strangerEstimate.id);
        const invoices = await listedInvoices(api);
        expect(invoices, scope).toContain(mateInvoice.id);
        expect(invoices, scope).not.toContain(strangerInvoice.id);
        expect((await api.get(`/api/estimates/${strangerEstimate.id}`)).status, scope).toBe(403);
        expect((await api.get(`/api/invoices/${strangerInvoice.id}`)).status, scope).toBe(403);
      }

      for (const scope of ['team', 'location']) {
        const nobody = await personWith(org, { estimates_scope: scope, invoices_scope: scope });
        const api = await nobody.api();
        expect(await listedEstimates(api), scope).toEqual([]);
        expect(await listedInvoices(api), scope).toEqual([]);
      }
    });
  });

  describe('Through own leads', () => {
    it('lets an assignee of the lead open the converted job, its estimates and its invoices, and nobody else', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const seller = await personWith(org, {}, { base: 'SALES', name: 'seller' });
      const other = await personWith(org, {}, { base: 'SALES', name: 'other' });
      const lead = await fx.addLead(org, customer, { assignees: [seller.id] });
      const job = await fx.addJob(org, customer, { fromLead: lead.id });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const strangerLead = await fx.addLead(org, customer, { assignees: [other.id] });
      const strangerJob = await fx.addJob(org, customer, { fromLead: strangerLead.id });
      const strangerInvoice = await fx.addInvoice(org, customer, { jobId: strangerJob.id });
      const unrelated = await fx.addEstimate(org, customer, admin.id);

      const api = await seller.api();
      expect((await api.get(`/api/jobs/${job.id}`)).status).toBe(200);
      expect((await api.get(`/api/estimates/${job.estimateId}`)).status).toBe(200);
      expect((await api.get(`/api/invoices/${invoice.id}`)).status).toBe(200);
      expect(await listedEstimates(api)).toEqual([job.estimateId]);
      expect(await listedInvoices(api)).toEqual([invoice.id]);

      expect((await api.get(`/api/jobs/${strangerJob.id}`)).status).toBe(403);
      expect((await api.get(`/api/estimates/${strangerJob.estimateId}`)).status).toBe(403);
      expect((await api.get(`/api/estimates/${unrelated.id}`)).status).toBe(403);
      expect((await api.get(`/api/invoices/${strangerInvoice.id}`)).status).toBe(403);
    });

    it('refuses a lead-less estimate the person created on a job they are not attached to', async () => {
      const { org, customer } = await fx.newOrg();
      const seller = await personWith(org, {}, { base: 'SALES', name: 'seller' });
      const someoneElsesJob = await fx.addJob(org, customer, { crew: [(await fx.addUser(org, `crew${++sequence}`, 'TECHNICIAN')).id] });
      const estimate = await fx.addEstimate(org, customer, seller.id, { jobId: someoneElsesJob.id });
      const api = await seller.api();

      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(403);
      expect(await listedEstimates(api)).not.toContain(estimate.id);
    });

    it('does not reach a deposit invoice with no job: it follows the invoice\'s job\'s estimate\'s lead only', async () => {
      const { org, customer } = await fx.newOrg();
      const seller = await personWith(org, {}, { base: 'SALES', name: 'seller' });
      const lead = await fx.addLead(org, customer, { assignees: [seller.id] });
      const estimate = await fx.addEstimate(org, customer, (await fx.addUser(org, `mk${++sequence}`, 'DISPATCHER')).id, { leadId: lead.id });
      const deposit = await fx.addInvoice(org, customer, { estimateId: estimate.id });
      const api = await seller.api();

      expect((await api.get(`/api/estimates/${estimate.id}`)).status).toBe(200);
      expect((await api.get(`/api/invoices/${deposit.id}`)).status).toBe(403);
    });
  });

  describe('View off', () => {
    it('refuses every detail read of estimates and returns an empty list, not a 403', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const off = Object.fromEntries(
        standingOn('view_estimates').filter((key) => findSwitch(key)!.module === 'Estimates').map((key) => [key, false]),
      );
      const me = await personWith(org, { ...off, view_estimates: false, estimates_scope: 'all' });
      const lead = await fx.addLead(org, customer, { assignees: [me.id] });
      const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
      const api = await me.api();

      const list = await api.get('/api/estimates');
      expect(list.status).toBe(200);
      expect(list.body.estimates).toEqual([]);
      for (const path of ['', '/notes', '/history', '/scopes']) {
        expect((await api.get(`/api/estimates/${estimate.id}${path}`)).status, `estimates/:id${path}`).toBe(403);
      }
    });

    it('refuses every detail read of invoices and returns an empty list, not a 403', async () => {
      const { org, customer } = await fx.newOrg();
      const off = Object.fromEntries(
        standingOn('view_invoices').filter((key) => findSwitch(key)!.module === 'Invoices').map((key) => [key, false]),
      );
      const me = await personWith(org, { ...off, view_invoices: false, invoices_scope: 'all' });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const api = await me.api();

      const list = await api.get('/api/invoices');
      expect(list.status).toBe(200);
      expect(list.body.invoices).toEqual([]);
      for (const path of ['', '/timeline', '/notes']) {
        expect((await api.get(`/api/invoices/${invoice.id}${path}`)).status, `invoices/:id${path}`).toBe(403);
      }
    });
  });

  describe('the built-in presets, as the catalog states them', () => {
    it('lets Dispatcher open every estimate and invoice, and Technician only those attached to them', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const dispatcher = await fx.addUser(org, 'dee', 'DISPATCHER');
      const technician = await fx.addUser(org, 'tom', 'TECHNICIAN');
      const job = await fx.addJob(org, customer, { crew: [technician.id] });
      const mineEstimate = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      const otherEstimate = await fx.addEstimate(org, customer, admin.id);
      const mineInvoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const otherInvoice = await fx.addInvoice(org, customer);

      const asDispatcher = await fx.signedInAs(dispatcher);
      expect(await listedEstimates(asDispatcher)).toEqual(expect.arrayContaining([mineEstimate.id, otherEstimate.id]));
      expect(await listedInvoices(asDispatcher)).toEqual(expect.arrayContaining([mineInvoice.id, otherInvoice.id]));

      const asTechnician = await fx.signedInAs(technician);
      const estimates = await listedEstimates(asTechnician);
      expect(estimates).toContain(mineEstimate.id);
      expect(estimates).not.toContain(otherEstimate.id);
      // Technician holds View invoices off in its preset: no invoice lists or opens for them.
      expect(await listedInvoices(asTechnician)).toEqual([]);
      expect((await asTechnician.get(`/api/invoices/${mineInvoice.id}`)).status).toBe(403);
    });

    it('gives Sales the kept value on Jobs, Estimates and Invoices: the jobs, estimates and invoices of their own leads', async () => {
      const { org, customer } = await fx.newOrg();
      const seller = await fx.addUser(org, 'sam', 'SALES');
      const lead = await fx.addLead(org, customer, { assignees: [seller.id] });
      const job = await fx.addJob(org, customer, { fromLead: lead.id });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      const otherInvoice = await fx.addInvoice(org, customer);
      const api = await fx.signedInAs(seller);

      expect(await listedEstimates(api)).toEqual([job.estimateId]);
      const invoices = await listedInvoices(api);
      expect(invoices).toContain(invoice.id);
      expect(invoices).not.toContain(otherInvoice.id);
    });
  });

  describe('the kept "Through own leads" value', () => {
    it('is accepted on Jobs, Estimates and Invoices, refused on Leads, and absent from the choices the catalog serves', async () => {
      const { org } = await fx.newOrg();
      const technician = await fx.addUser(org, 'tech', 'TECHNICIAN');
      const res = await (await fx.signedInAs(technician)).get('/api/permission-switches/catalog');
      expect(res.status).toBe(200);
      const byKey = Object.fromEntries((res.body.switches as { key: string }[]).map((s) => [s.key, s])) as Record<string, Record<string, unknown>>;

      for (const key of ['jobs_scope', 'estimates_scope', 'invoices_scope']) {
        expect(byKey[key], key).toMatchObject({ kind: 'choice', module: 'Data Scope', choices: ['attached', 'team', 'location', 'all'] });
        expect(byKey[key]!.choices, key).not.toContain('through_own_leads');
        expect(validateSwitchSet({ ...presetSwitchSet('ADMIN'), [key]: 'through_own_leads' }), key).toEqual([]);
        // The plain name and meaning PRD 2 shows beside the real choices.
        expect(byKey[key]!.keptValueHelp, key).toMatchObject({ through_own_leads: { label: 'Through own leads' } });
      }
      expect(validateSwitchSet({ ...presetSwitchSet('ADMIN'), leads_scope: 'through_own_leads' }).some((v) => v.switchKey === 'leads_scope')).toBe(true);
    });

    const store = (org: string, roleKey: string, values: Record<string, boolean | string>, copiedFromHolder = false) =>
      setRoleSwitchValues({ organizationId: org, roleKey, values, actorId: null, reason: 'manual', copiedFromHolder });

    it.each(['jobs_scope', 'estimates_scope', 'invoices_scope'])('refuses a write that sets it on %s for a role that does not already hold it', async (key) => {
      const { org } = await fx.newOrg();
      const role = await fx.addCustomRole(org, `no-hold-${key}`, 'DISPATCHER');
      await expect(store(org, role.key, { [key]: 'through_own_leads' })).rejects.toThrow(/Through own leads/);
      expect(await db.permissionRoleSwitch.count({ where: { organization_id: org, role_key: role.key } })).toBe(0);
    });

    it.each(['jobs_scope', 'estimates_scope', 'invoices_scope'])('accepts it on %s for a role that holds it, and then never again once it has been changed', async (key) => {
      const { org } = await fx.newOrg();
      const role = await fx.addCustomRole(org, `hold-${key}`, 'SALES');
      await expect(store(org, role.key, { [key]: 'through_own_leads' })).resolves.toMatchObject({ [key]: 'through_own_leads' });
      await store(org, role.key, { [key]: 'attached' });
      await expect(store(org, role.key, { [key]: 'through_own_leads' })).rejects.toThrow(/Through own leads/);
    });

    it('accepts it when the whole set is copied from a holder', async () => {
      const { org } = await fx.newOrg();
      const role = await fx.addCustomRole(org, 'copy-of-sales', 'DISPATCHER');
      await expect(store(org, role.key, { jobs_scope: 'through_own_leads', estimates_scope: 'through_own_leads', invoices_scope: 'through_own_leads' }, true)).resolves.toMatchObject({ jobs_scope: 'through_own_leads', estimates_scope: 'through_own_leads', invoices_scope: 'through_own_leads' });
    });

    it('refuses it on Leads even when the whole set is copied', async () => {
      const { org } = await fx.newOrg();
      const role = await fx.addCustomRole(org, 'leads-never', 'SALES');
      await expect(store(org, role.key, { leads_scope: 'through_own_leads' }, true)).rejects.toThrow();
    });
  });

  describe('Approve estimates and Decline estimates', () => {
    it('lets a person with both on approve or decline an estimate they can open, and refuses one they cannot', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { estimates_scope: 'attached', approve_estimates: true, decline_estimates: true });
      const lead = await fx.addLead(org, customer, { assignees: [me.id] });
      const mine = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
      const theirs = await fx.addEstimate(org, customer, admin.id);
      await db.estimate.updateMany({ where: { id: { in: [mine.id, theirs.id] } }, data: { status: 'SENT' } });
      const api = await me.api();

      expect((await api.post(`/api/estimates/${theirs.id}/approve-internal`, {})).status).toBe(403);
      expect((await api.post(`/api/estimates/${theirs.id}/decline-internal`, { lost_reason: 'Went elsewhere' })).status).toBe(403);
      expect((await api.post(`/api/estimates/${mine.id}/decline-internal`, { lost_reason: 'PRICE' })).status).toBe(200);
      await db.estimate.update({ where: { id: mine.id }, data: { status: 'SENT' } });
      expect((await api.post(`/api/estimates/${mine.id}/approve-internal`, {})).status).toBe(200);
    });

    it('refuses both when they are off', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { estimates_scope: 'all', approve_estimates: false, decline_estimates: false });
      const estimate = await fx.addEstimate(org, customer, admin.id);
      const api = await me.api();

      expect((await api.post(`/api/estimates/${estimate.id}/approve-internal`, {})).status).toBe(403);
      expect((await api.post(`/api/estimates/${estimate.id}/decline-internal`, { lost_reason: 'x' })).status).toBe(403);
    });
  });

  describe('the route-level enforcement table', () => {
    // One request per server check, each against a record of its own. With the switch on the request
    // is let in (anything but a refusal); with it off it is refused with a 403, except a list, which
    // answers with no rows.
    type Probe = {
      switchKey: string; check: string; isList?: 'estimates' | 'invoices';
      /** The values that let the check in and refuse it, for a switch that is not on/off (a list). */
      on?: SwitchValue; off?: SwitchValue;
      run: (api: Api, org: string, customer: string, admin: Person) => Promise<{ status: number; body?: unknown }>;
    };
    const anEstimate = async (org: string, customer: string, admin: Person) => (await fx.addEstimate(org, customer, admin.id)).id;
    const aLine = [{ description: 'Service', quantity: 1, unit_price: 100, is_taxable: false }];
    const probes: Probe[] = [
      { switchKey: 'view_estimates', check: 'estimate-list', isList: 'estimates', run: (api) => api.get('/api/estimates') },
      { switchKey: 'view_estimates', check: 'estimate-detail', run: async (api, org, customer, admin) => api.get(`/api/estimates/${await anEstimate(org, customer, admin)}`) },
      { switchKey: 'create_estimates', check: 'estimate-create', run: (api) => api.post('/api/estimates', {}) },
      {
        switchKey: 'create_estimates', check: 'estimate-duplicate',
        run: async (api, org, customer, admin) => {
          const lead = await fx.addLead(org, customer);
          const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
          return api.post(`/api/estimates/${estimate.id}/duplicate`, {});
        },
      },
      { switchKey: 'standalone_estimates', check: 'estimate-create-standalone', run: async (api, _org, customer) => api.post('/api/estimates', { customer_id: customer, line_items: aLine }) },
      { switchKey: 'standalone_estimates', check: 'estimate-duplicate-standalone', run: async (api, org, customer, admin) => api.post(`/api/estimates/${await anEstimate(org, customer, admin)}/duplicate`, {}) },
      { switchKey: 'approve_estimates', check: 'estimate-approve', run: async (api, org, customer, admin) => api.post(`/api/estimates/${await anEstimate(org, customer, admin)}/approve-internal`, {}) },
      { switchKey: 'decline_estimates', check: 'estimate-decline', run: async (api, org, customer, admin) => api.post(`/api/estimates/${await anEstimate(org, customer, admin)}/decline-internal`, { lost_reason: 'Went elsewhere' }) },
      { switchKey: 'waive_deposits', check: 'estimate-waive-deposit', run: async (api, org, customer, admin) => api.post(`/api/estimates/${await anEstimate(org, customer, admin)}/waive-deposit`, {}) },
      { switchKey: 'edit_estimates', check: 'estimate-update', run: async (api, org, customer, admin) => api.patch(`/api/estimates/${await anEstimate(org, customer, admin)}`, {}) },
      { switchKey: 'edit_estimates', check: 'estimate-send', run: async (api, org, customer, admin) => api.post(`/api/estimates/${await anEstimate(org, customer, admin)}/send`, {}) },
      { switchKey: 'edit_estimates', check: 'estimate-cancel', run: async (api, org, customer, admin) => api.post(`/api/estimates/${await anEstimate(org, customer, admin)}/cancel`, {}) },
      { switchKey: 'edit_estimates', check: 'estimate-revise', run: async (api, org, customer, admin) => api.post(`/api/estimates/${await anEstimate(org, customer, admin)}/revise`, {}) },
      { switchKey: 'delete_estimates', check: 'estimate-delete', run: async (api, org, customer, admin) => api.delete(`/api/estimates/${await anEstimate(org, customer, admin)}`) },
      { switchKey: 'view_invoices', check: 'invoice-list', isList: 'invoices', run: (api) => api.get('/api/invoices') },
      { switchKey: 'view_invoices', check: 'invoice-detail', run: async (api, org, customer) => api.get(`/api/invoices/${(await fx.addInvoice(org, customer)).id}`) },
      { switchKey: 'create_invoices', check: 'invoice-create', run: (api) => api.post('/api/invoices', {}) },
      { switchKey: 'create_invoices', check: 'invoice-create-from-job-items', run: (api) => api.post(`/api/jobs/${randomUUID()}/invoices`, {}) },
      { switchKey: 'create_invoices', check: 'estimate-copy-to-invoice', run: async (api, org, customer, admin) => api.post(`/api/estimates/${await anEstimate(org, customer, admin)}/copy-to-invoice`, {}) },
      { switchKey: 'standalone_invoices', check: 'invoice-create-standalone', run: async (api, _org, customer) => api.post('/api/invoices', { customer_id: customer, line_items: aLine }) },
      { switchKey: 'edit_invoices', check: 'invoice-update', run: async (api, org, customer) => api.patch(`/api/invoices/${(await fx.addInvoice(org, customer)).id}`, {}) },
      { switchKey: 'edit_invoices', check: 'invoice-send', run: async (api, org, customer) => api.post(`/api/invoices/${(await fx.addInvoice(org, customer)).id}/send`, {}) },
      { switchKey: 'delete_invoices', check: 'invoice-delete', run: async (api, org, customer) => api.delete(`/api/invoices/${(await fx.addInvoice(org, customer)).id}`) },
      { switchKey: 'void_invoices', check: 'invoice-void', run: async (api, org, customer) => api.post(`/api/invoices/${(await fx.addInvoice(org, customer)).id}/void`, {}) },
      { switchKey: 'apply_credits', check: 'invoice-credit', run: async (api, org, customer) => api.post(`/api/invoices/${(await fx.addInvoice(org, customer)).id}/credit`, {}) },
      { switchKey: 'void_payments', check: 'invoice-void-payment', run: async (api, org, customer) => api.post(`/api/invoices/${(await fx.addInvoice(org, customer)).id}/void-payment`, {}) },
      { switchKey: 'record_payments', check: 'invoice-record-payment', run: async (api, org, customer) => api.post(`/api/invoices/${(await fx.addInvoice(org, customer)).id}/payments`, { amount: 10, method: 'CASH' }) },
      { switchKey: 'record_payments', check: 'estimate-record-payment', run: async (api, org, customer, admin) => api.post(`/api/estimates/${await anEstimate(org, customer, admin)}/record-payment`, { amount: 10, payment_method: 'CASH' }) },
      { switchKey: 'refund_payments', check: 'invoice-refund', run: async (api, org, customer) => api.post(`/api/invoices/${(await fx.addInvoice(org, customer)).id}/refund`, {}) },
      { switchKey: 'refund_payments', check: 'invoice-cancel-bank-payment', run: async (api, org, customer) => api.post(`/api/invoices/${(await fx.addInvoice(org, customer)).id}/cancel-bank-payment`, {}) },
      { switchKey: 'refund_payments', check: 'payment-attention-list', run: (api) => api.get('/api/payments-needing-attention') },
      { switchKey: 'refund_payments', check: 'payment-attention-refund', run: (api) => api.post(`/api/payments-needing-attention/${randomUUID()}/refund`, {}) },
      { switchKey: 'refund_payments', check: 'payment-attention-resolve', run: (api) => api.post(`/api/payments-needing-attention/${randomUUID()}/resolve`, {}) },
      // Payments go-live P4: the Needs attention actions. A made-up item answers 404, never 403, with the switch on.
      { switchKey: 'refund_payments', check: 'payments-page-attention-resolve', run: (api) => api.post(`/api/payments-page/attention/failed_payment:${randomUUID()}/resolve`, {}) },
      // Payments go-live P10: saving and submitting dispute evidence; a made-up dispute answers 404, never 403, with the switch on.
      { switchKey: 'refund_payments', check: 'dispute-evidence-stage', run: (api) => api.put(`/api/payments-page/disputes/${randomUUID()}/evidence`, { version: 0, files: {}, text: {} }) },
      { switchKey: 'refund_payments', check: 'dispute-evidence-submit', run: (api) => api.post(`/api/payments-page/disputes/${randomUUID()}/evidence/submit`, { version: 0 }) },
      // Payments go-live P3/P7/P8/P11: View payments and payouts sits in the Invoices module; each read answers 403 with it off and anything but 403/401 with it on.
      { switchKey: 'view_payments', check: 'payments-viewer-session', run: (api) => api.post('/api/organization/stripe/account-session', { surface: 'viewer' }) },
      { switchKey: 'view_payments', check: 'payments-page-summary', run: (api) => api.get('/api/payments-page/summary') },
      { switchKey: 'view_payments', check: 'payments-page-list', run: (api) => api.get('/api/payments-page/payments') },
      { switchKey: 'view_payments', check: 'payments-page-detail', run: (api) => api.get(`/api/payments-page/payments/${randomUUID()}`) },
      { switchKey: 'view_payments', check: 'payments-page-export', run: (api) => api.get('/api/payments-page/payments/export') },
      { switchKey: 'view_payments', check: 'payments-page-payouts', run: (api) => api.get('/api/payments-page/payouts') },
      { switchKey: 'view_payments', check: 'payments-page-payout-detail', run: (api) => api.get(`/api/payments-page/payouts/${randomUUID()}`) },
      { switchKey: 'view_payments', check: 'payments-page-payout-payments', run: (api) => api.get(`/api/payments-page/payouts/${randomUUID()}/payments`) },
      { switchKey: 'view_payments', check: 'payments-page-attention-summary', run: (api) => api.get('/api/payments-page/attention/summary') },
      { switchKey: 'view_payments', check: 'payments-page-attention-list', run: (api) => api.get('/api/payments-page/attention') },
      { switchKey: 'view_payments', check: 'dispute-evidence-read', run: (api) => api.get(`/api/payments-page/disputes/${randomUUID()}/evidence`) },
      { switchKey: 'send_payment_links', check: 'payments-page-attention-contact', run: (api) => api.post(`/api/payments-page/attention/failed_payment:${randomUUID()}/contact-customer`, {}) },
      { switchKey: 'send_payment_links', check: 'invoice-payment-link', run: async (api, org, customer) => api.post(`/api/invoices/${(await fx.addInvoice(org, customer)).id}/payment-link`, {}) },
      // A list switch: "All accepted methods" lets the payment in, a person with no methods listed is refused.
      { switchKey: 'allowed_payment_methods', check: 'invoice-payment-method', on: ALL_ACCEPTED_METHODS, off: [], run: async (api, org, customer) => api.post(`/api/invoices/${(await fx.addInvoice(org, customer)).id}/payments`, { amount: 10, method: 'CASH' }) },
      { switchKey: 'allowed_payment_methods', check: 'estimate-deposit-method', on: ALL_ACCEPTED_METHODS, off: [], run: async (api, org, customer, admin) => api.post(`/api/estimates/${await anEstimate(org, customer, admin)}/record-payment`, { amount: 10, payment_method: 'CASH' }) },
      { switchKey: 'edit_invoice_line_items', check: 'invoice-line-add', run: async (api, org, customer) => api.post(`/api/invoices/${(await fx.addInvoice(org, customer)).id}/line-items`, {}) },
      { switchKey: 'edit_invoice_line_items', check: 'invoice-line-delete', run: async (api, org, customer) => {
          const inv = await fx.addInvoice(org, customer);
          return api.delete(`/api/invoices/${inv.id}/line-items/${inv.lineId}`);
        } },
      // Slice S01.23 - each module's Export and Edit record ID numbers switches; the renumber preview answers with the same guard as the rename.
      { switchKey: 'export_estimates', check: 'estimate-export', run: (api) => api.get('/api/estimates/export') },
      { switchKey: 'export_invoices', check: 'invoice-export', run: (api) => api.get('/api/invoices/export') },
      { switchKey: 'edit_estimate_record_ids', check: 'estimate-renumber', run: async (api, org, customer, admin) => api.post(`/api/estimates/${await anEstimate(org, customer, admin)}/number/preview`, { number: 'E-9001' }) },
      { switchKey: 'edit_invoice_record_ids', check: 'invoice-renumber', run: async (api, org, customer) => api.post(`/api/invoices/${(await fx.addInvoice(org, customer)).id}/number/preview`, { number: 'I-9001' }) },
    ];

    const mine = (s: { module: string }) => ['Estimates', 'Invoices', 'Data Scope'].includes(s.module);

    it('has a row for every server check the catalog lists for an Estimates or Invoices switch, and no switch is left unaccounted for', () => {
      // Apply discounts is S01.1's row, See financial data is S01.15's and See company figures is S01.16's, each proved in its own suite.
      const listed = SWITCH_CATALOG.filter((s) => mine(s) && !['apply_discounts', 'see_financial_data', 'see_company_figures'].includes(s.key)).flatMap((s) => s.serverChecks.map((c) => `${s.key}:${c}`));
      expect(probes.map((p) => `${p.switchKey}:${p.check}`).sort()).toEqual([...listed].sort());
      for (const s of SWITCH_CATALOG.filter(mine)) expect(s.serverChecks.length > 0 || Boolean(s.pending), s.key).toBe(true);
      // The pending ones are listed in the table as pending, with who builds them.
      const pending = SWITCH_CATALOG.filter((s) => ['Estimates', 'Invoices'].includes(s.module) && s.serverChecks.length === 0);
      expect(pending.map((s) => s.key)).toEqual(expect.arrayContaining([
        'alert_every_estimate', 'alert_every_invoice',
      ]));
      for (const s of pending) expect(s.pending, s.key).toMatch(/S01\.\d+|PRD \d+|Display only|Not a check of its own/);
    });

    it('lets each check in with its switch on and refuses it with the switch off, for a custom role', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { estimates_scope: 'all', invoices_scope: 'all' }, { name: 'table' });
      // Duplicating an estimate is a grant of its own (not a switch yet); the person holds it so that only the switch decides.
      await db.rolePermission.create({ data: { organization_id: org, role: me.roleKey, action: 'duplicate', subject: 'Estimate' } });
      clearPermissionCache(org);
      const api = await me.api();
      const roleSwitches = async (values: Record<string, SwitchValue>) =>
        setRoleSwitchValues({ organizationId: org, roleKey: me.roleKey, values, actorId: null, reason: 'manual' });

      for (const probe of probes) {
        expect(findSwitch(probe.switchKey)!.serverChecks, probe.check).toContain(probe.check);
        const dependants = standingOn(probe.switchKey);

        const on = probe.on ?? true;
        await roleSwitches({ ...Object.fromEntries(needing(probe.switchKey).map((n) => [n, true])), [probe.switchKey]: on });
        if (probe.isList === 'estimates') await fx.addEstimate(org, customer, admin.id);
        if (probe.isList === 'invoices') await fx.addInvoice(org, customer);
        const letIn = await probe.run(api, org, customer, admin);
        if (probe.isList) {
          expect(letIn.status, `${probe.check} on`).toBe(200);
          expect((letIn.body as Record<string, unknown[]>)[probe.isList]!.length, `${probe.check} on`).toBeGreaterThan(0);
        } else {
          expect(letIn.status, `${probe.check} with the switch on`).not.toBe(403);
          expect(letIn.status, `${probe.check} with the switch on`).not.toBe(401);
        }

        // Off: the row rule takes everything that needs this switch off with it.
        await roleSwitches({ ...Object.fromEntries(dependants.map((d) => [d, false])), [probe.switchKey]: probe.off ?? false });
        const refused = await probe.run(api, org, customer, admin);
        if (probe.isList) {
          expect(refused.status, `${probe.check} off`).toBe(200);
          expect((refused.body as Record<string, unknown[]>)[probe.isList], `${probe.check} off`).toEqual([]);
        } else {
          expect(refused.status, `${probe.check} with the switch off`).toBe(403);
        }

        await roleSwitches({
          ...Object.fromEntries([...dependants, ...dependants.flatMap(needing)].map((d) => [d, true])),
          [probe.switchKey]: on,
        });
      }
    });
  });

  it('keeps every built-in preset valid', () => {
    for (const role of ['ADMIN', 'SALES', 'DISPATCHER', 'TECHNICIAN'] as BuiltInRole[]) {
      expect(validateSwitchSet(presetSwitchSet(role)), role).toEqual([]);
    }
  });
});
