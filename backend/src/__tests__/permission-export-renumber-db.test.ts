/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.23 - Export per module and Edit record ID numbers per module.

   Everything goes through the public interface: the role store and the export and renumber routes of
   the five modules (customers, leads, jobs, estimates, invoices), called as people on custom roles
   (never a built-in role name) whose switch values are the ones under test. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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
// The suite-wide setup hands every record the same number; a renumber needs the real allocator's rows.
vi.unmock('../lib/numbering');

import { switchFixture, type Person } from './permission-switches-fixture';
import { findSwitch, SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('export and record ID numbers follow their own switches (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values on top of the Dispatcher base. */
  async function personWith(org: string, values: Record<string, boolean | string>) {
    const key = `export-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person: Person = await fx.addUser(org, `p${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    return {
      api: (): Promise<Api> => fx.signedInAs(person),
      roleSwitches: (more: Record<string, boolean | string>) =>
        setRoleSwitchValues({ organizationId: org, roleKey: key, values: more, actorId: null, reason: 'manual' }),
    };
  }

  /** The five modules: the switches that decide them, their export route and a record the person can reach. */
  const modules = [
    { name: 'customers', view: 'view_customers', exportKey: 'export_customers', list: '/api/customers', exportPath: '/api/customers/export' },
    { name: 'leads', view: 'view_leads', exportKey: 'export_leads', list: '/api/leads', exportPath: '/api/leads/export' },
    { name: 'jobs', view: 'view_jobs', exportKey: 'export_jobs', list: '/api/jobs', exportPath: '/api/jobs/export' },
    { name: 'estimates', view: 'view_estimates', exportKey: 'export_estimates', list: '/api/estimates', exportPath: '/api/estimates/export' },
    { name: 'invoices', view: 'view_invoices', exportKey: 'export_invoices', list: '/api/invoices', exportPath: '/api/invoices/export' },
  ];
  const everyScope = { leads_scope: 'all', jobs_scope: 'all', estimates_scope: 'all', invoices_scope: 'all' };

  describe('Export', () => {
    it.each(modules)('refuses the $name export to a custom role with View on and Export off, and lets it in with Export on', async (m) => {
      const { org } = await fx.newOrg();
      const everythingViewable = Object.fromEntries(modules.map((x) => [x.view, true]));
      const me = await personWith(org, { ...everyScope, ...everythingViewable, [m.exportKey]: false });
      const api = await me.api();

      // View alone opens the list page's data...
      expect((await api.get(m.list)).status, `${m.name} list with View on`).toBe(200);
      // ...but not the download.
      expect((await api.get(m.exportPath)).status, `${m.name} export with Export off`).toBe(403);

      await me.roleSwitches({ [m.exportKey]: true });
      expect((await api.get(m.exportPath)).status, `${m.name} export with Export on`).toBe(200);
    });

    it('lets each module\'s Export switch decide that module alone', async () => {
      const { org } = await fx.newOrg();
      const everythingViewable = Object.fromEntries(modules.map((x) => [x.view, true]));
      const onlyJobs = Object.fromEntries(modules.map((x) => [x.exportKey, x.name === 'jobs']));
      const me = await personWith(org, { ...everyScope, ...everythingViewable, ...onlyJobs });
      const api = await me.api();

      for (const m of modules) {
        expect((await api.get(m.exportPath)).status, m.name).toBe(m.name === 'jobs' ? 200 : 403);
      }
    });

    it('names the server check on each of the five Export switches', () => {
      for (const m of modules) {
        expect(findSwitch(m.exportKey)!.serverChecks, m.exportKey).toEqual([`${m.name.replace(/s$/, '')}-export`]);
      }
    });

    it('has no server check on Export reports: no server report export exists', () => {
      const reports = SWITCH_CATALOG.find((s) => s.key === 'export_reports')!;
      expect(reports.serverChecks).toEqual([]);
      expect(reports.pending).toBeTruthy();
    });
  });

  describe('Edit record ID numbers', () => {
    it('lets a person with it on for jobs and off for customers renumber a job and refuses them on a customer', async () => {
      const { org, customer } = await fx.newOrg();
      const job = await fx.addJob(org, customer);
      const me = await personWith(org, {
        ...everyScope, view_jobs: true, view_customers: true, edit_job_record_ids: true, edit_customer_record_ids: false,
      });
      const api = await me.api();

      const renamed = await api.patch(`/api/jobs/${job.id}/number`, { number: 'J-9001' });
      expect(renamed.status).toBe(200);
      expect((await db.job.findUniqueOrThrow({ where: { id: job.id } })).job_number).toBe('J-9001');

      const before = (await db.customer.findUniqueOrThrow({ where: { id: customer } })).customer_number;
      const refused = await api.patch(`/api/customers/${customer}/number`, { number: 'C-9001' });
      expect(refused.status).toBe(403);
      expect((await db.customer.findUniqueOrThrow({ where: { id: customer } })).customer_number).toBe(before);
    });

    it('refuses a renumber, and its preview, on each module whose switch is off', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const lead = await fx.addLead(org, customer);
      const job = await fx.addJob(org, customer);
      const estimate = await fx.addEstimate(org, customer, admin.id);
      const invoice = await fx.addInvoice(org, customer);
      const me = await personWith(org, {
        ...everyScope,
        view_customers: true, view_leads: true, view_jobs: true, view_estimates: true, view_invoices: true,
        edit_customer_record_ids: false, edit_lead_record_ids: false, edit_job_record_ids: false,
        edit_estimate_record_ids: false, edit_invoice_record_ids: false,
      });
      const api = await me.api();
      const targets = [
        `/api/customers/${customer}`, `/api/leads/${lead.id}`, `/api/jobs/${job.id}`,
        `/api/estimates/${estimate.id}`, `/api/invoices/${invoice.id}`,
      ];
      for (const target of targets) {
        expect((await api.patch(`${target}/number`, { number: 'X-1' })).status, `${target} renumber`).toBe(403);
        expect((await api.post(`${target}/number/preview`, { number: 'X-1' })).status, `${target} preview`).toBe(403);
      }
    });

    it('names the server check on each of the five Edit record ID numbers switches', () => {
      const keys = ['customer', 'lead', 'job', 'estimate', 'invoice'];
      for (const k of keys) {
        expect(findSwitch(`edit_${k}_record_ids`)!.serverChecks, k).toEqual([`${k}-renumber`]);
      }
    });
  });
});
