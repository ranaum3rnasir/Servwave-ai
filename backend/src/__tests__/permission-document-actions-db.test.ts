/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.27 - invoice and estimate page actions from the per-record answer.

   The invoice page and the estimate page draw send, edit, delete, copy payment link and record payment from the
   server's answer for THIS record: `actions` on the record's own read. A creator with View off gets send, edit and
   delete on the record they made (the creator rule) and none on anyone else's; copy payment link and record payment
   follow Send payment links and Record payments, which the creator rule never grants. No role name is asked.

   Everything goes through the public interface: the invoice and estimate routes, called as people on custom roles
   (never a built-in role name). Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every
   org it creates is removed again.
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

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

/** What opening the job takes, with View invoices and View estimates off: the Technician preset's reach. */
const FIELD_WORKER = { view_jobs: true, jobs_scope: 'attached', view_invoices: false, view_estimates: false };
const SEES_INVOICES = { ...FIELD_WORKER, view_invoices: true, invoices_scope: 'all' };
const SEES_ESTIMATES = { ...FIELD_WORKER, view_estimates: true, estimates_scope: 'all' };

suite('invoice and estimate page actions from the per-record answer (real database)', () => {
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
  async function personWith(org: string, values: Record<string, SwitchValue>): Promise<Person & { api: () => Promise<Api> }> {
    const key = `doc-actions-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'TECHNICIAN');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `worker${sequence}`, 'TECHNICIAN', { customRoleId: role.id, basedOnRoleKey: key });
    return { ...person, api: () => fx.signedInAs(person) };
  }

  /** A job the person is crew on, with a draft invoice they made and one the office made. */
  async function jobWithTwoInvoices(org: string, customer: string, me: Person, officeUser: string) {
    const job = await fx.addJob(org, customer, { crew: [me.id] });
    const mine = (await fx.addInvoice(org, customer, { jobId: job.id, createdBy: me.id })).id;
    const theirs = (await fx.addInvoice(org, customer, { jobId: job.id, createdBy: officeUser })).id;
    return { jobId: job.id, mine, theirs };
  }

  async function invoiceActions(api: Api, id: string): Promise<string[]> {
    const res = await api.get(`/api/invoices/${id}`);
    expect(res.status).toBe(200);
    return res.body.invoice.actions;
  }

  describe('the invoice page', () => {
    it('lists send, edit and delete on the invoice a creator made, with View invoices off, and nothing money', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, FIELD_WORKER);
      const world = await jobWithTwoInvoices(org, customer, me, admin.id);
      const api = await me.api();

      expect(await invoiceActions(api, world.mine)).toEqual(['edit', 'send', 'delete']);
    });

    it('opens no one else\'s invoice to a creator with View invoices off', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, FIELD_WORKER);
      const world = await jobWithTwoInvoices(org, customer, me, admin.id);

      expect((await (await me.api()).get(`/api/invoices/${world.theirs}`)).status).toBe(403);
    });

    it('lists nothing to edit, send or delete on another person\'s invoice a viewer can open, and all three on their own', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, SEES_INVOICES);
      const world = await jobWithTwoInvoices(org, customer, me, admin.id);
      const api = await me.api();

      expect(await invoiceActions(api, world.theirs)).toEqual([]);
      expect(await invoiceActions(api, world.mine)).toEqual(['edit', 'send', 'delete']);
    });

    it('lists edit and send on another person\'s invoice with Edit invoices on, delete only with Delete invoices on', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const editor = await personWith(org, { ...SEES_INVOICES, edit_invoices: true });
      const remover = await personWith(org, { ...SEES_INVOICES, edit_invoices: true, delete_invoices: true });
      const world = await jobWithTwoInvoices(org, customer, editor, admin.id);

      expect(await invoiceActions(await editor.api(), world.theirs)).toEqual(['edit', 'send']);
      expect(await invoiceActions(await remover.api(), world.theirs)).toEqual(['edit', 'send', 'delete']);
    });

    it('lists copy payment link only with Send payment links on, and record payment only with Record payments on', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const linker = await personWith(org, { ...FIELD_WORKER, send_payment_links: true });
      const collector = await personWith(org, { ...FIELD_WORKER, record_payments: true, allowed_payment_methods: ['CASH'] });
      const worldA = await jobWithTwoInvoices(org, customer, linker, admin.id);
      const worldB = await jobWithTwoInvoices(org, customer, collector, admin.id);

      expect(await invoiceActions(await linker.api(), worldA.mine)).toEqual(['edit', 'send', 'delete', 'copy_payment_link']);
      expect(await invoiceActions(await collector.api(), worldB.mine)).toEqual(['edit', 'send', 'delete', 'record_payment']);
    });

    it('lists the money actions on an invoice a viewer can open but did not make, when the money switches are on', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { ...SEES_INVOICES, send_payment_links: true, record_payments: true, allowed_payment_methods: ['CASH'] });
      const world = await jobWithTwoInvoices(org, customer, me, admin.id);

      expect(await invoiceActions(await me.api(), world.theirs)).toEqual(['copy_payment_link', 'record_payment']);
    });

    it('lists every action on any invoice to the company admin', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, FIELD_WORKER);
      const world = await jobWithTwoInvoices(org, customer, me, admin.id);

      expect(await invoiceActions(await fx.signedInAs(admin), world.mine))
        .toEqual(['edit', 'send', 'delete', 'copy_payment_link', 'record_payment']);
    });

    it('takes the creator\'s actions away on the next read once they are off the job', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, FIELD_WORKER);
      const world = await jobWithTwoInvoices(org, customer, me, admin.id);
      const api = await me.api();
      expect(await invoiceActions(api, world.mine)).toEqual(['edit', 'send', 'delete']);

      const visit = await db.visit.findFirstOrThrow({ where: { job_id: world.jobId }, select: { id: true } });
      await fx.removeCrew(visit.id, me.id);
      expect((await api.get(`/api/invoices/${world.mine}`)).status).toBe(403);
    });
  });

  describe('the estimate page', () => {
    it('lists edit, send, delete and cancel on the estimate a creator made, with View estimates off', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, FIELD_WORKER);
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const mine = await fx.addEstimate(org, customer, me.id, { jobId: job.id });
      const theirs = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      const api = await me.api();

      const own = await api.get(`/api/estimates/${mine.id}`);
      expect(own.status).toBe(200);
      expect(own.body.estimate.actions).toEqual(['edit', 'send', 'delete', 'cancel']);
      expect((await api.get(`/api/estimates/${theirs.id}`)).status).toBe(403);
    });

    it('lists nothing to edit on another person\'s estimate a viewer can open, and the full set with Edit and Delete estimates on', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const viewer = await personWith(org, SEES_ESTIMATES);
      const editor = await personWith(org, { ...SEES_ESTIMATES, edit_estimates: true, delete_estimates: true });
      const job = await fx.addJob(org, customer, { crew: [viewer.id, editor.id] });
      const theirs = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });

      const asViewer = await (await viewer.api()).get(`/api/estimates/${theirs.id}`);
      expect(asViewer.body.estimate.actions).toEqual([]);
      const asEditor = await (await editor.api()).get(`/api/estimates/${theirs.id}`);
      expect(asEditor.body.estimate.actions).toEqual(['edit', 'send', 'delete', 'cancel']);
    });

    it('lists record payment only with Record payments on', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const collector = await personWith(org, { ...SEES_ESTIMATES, record_payments: true, allowed_payment_methods: ['CASH'] });
      const job = await fx.addJob(org, customer, { crew: [collector.id] });
      const theirs = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });

      const res = await (await collector.api()).get(`/api/estimates/${theirs.id}`);
      expect(res.body.estimate.actions).toEqual(['record_payment']);
    });
  });
});
