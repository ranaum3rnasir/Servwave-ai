/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.18 - Standalone estimates, Create invoices and Standalone invoices.

   Everything goes through the public interface: the role store and the estimate and invoice routes, called as
   people on custom roles (never a built-in role name). Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.
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
// ...and so is the numbering allocator (the setup's stub hands every document the same number, so a second estimate
// or invoice in a company would collide on it).
vi.unmock('../lib/numbering');

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('standalone estimates, Create invoices and standalone invoices (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role holding exactly these switch values on top of the base role's preset. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    opts: { base?: 'DISPATCHER' | 'SALES' | 'TECHNICIAN'; name?: string } = {},
  ): Promise<Person & { api: () => Promise<Api>; roleKey: string }> {
    const key = `sa-role-${++sequence}`;
    const base = opts.base ?? 'DISPATCHER';
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `${opts.name ?? 'maker'}${sequence}`, base, { customRoleId: role.id, basedOnRoleKey: key });
    return { ...person, roleKey: key, api: () => fx.signedInAs(person) };
  }

  const lineItems = [{ description: 'Service', quantity: 1, unit_price: 100, is_taxable: false }];
  const customerOnlyEstimate = (customer: string) => ({ customer_id: customer, line_items: lineItems });
  const standaloneInvoice = (customer: string) => ({ customer_id: customer, line_items: lineItems });

  describe('Standalone estimates', () => {
    it('refuses a customer-only estimate without it, and lets one in with it', async () => {
      const { org, customer } = await fx.newOrg();
      const without = await personWith(org, { edit_estimates: true, create_estimates: true, standalone_estimates: false });
      const refused = await (await without.api()).post('/api/estimates', customerOnlyEstimate(customer));
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatch(/without a lead or job/);

      const withIt = await personWith(org, { edit_estimates: true, create_estimates: true, standalone_estimates: true });
      expect((await (await withIt.api()).post('/api/estimates', customerOnlyEstimate(customer))).status).toBe(201);
    });

    it('lets an estimate on a lead the person can open in, without Standalone estimates, and refuses a lead they cannot open', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached', edit_estimates: true, create_estimates: true, standalone_estimates: false });
      const mine = await fx.addLead(org, customer, { assignees: [me.id] });
      const theirs = await fx.addLead(org, customer);
      const api = await me.api();

      expect((await api.post('/api/estimates', { lead_id: mine.id, line_items: lineItems })).status).toBe(201);
      expect((await api.post('/api/estimates', { lead_id: theirs.id, line_items: lineItems })).status).toBe(404);
    });

    it('opens a lead the person is Owner of but not an assignee on, since Attached reaches it', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached', jobs_scope: 'attached', edit_estimates: true, create_estimates: true, standalone_estimates: false });
      const owned = await fx.addLead(org, customer, { owner: me.id });
      expect((await (await me.api()).post('/api/estimates', { lead_id: owned.id, line_items: lineItems })).status).toBe(201);
    });

    it('lets an estimate on a job the person can open in, and refuses one they cannot', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', edit_estimates: true, create_estimates: true, standalone_estimates: false });
      const mine = await fx.addJob(org, customer, { crew: [me.id] });
      const theirs = await fx.addJob(org, customer, { crew: [] });
      const api = await me.api();

      expect((await api.post('/api/estimates', { job_id: mine.id, line_items: lineItems })).status).toBe(201);
      expect((await api.post('/api/estimates', { job_id: theirs.id, line_items: lineItems })).status).toBe(404);
    });

    it('holds a duplicate that lands on no lead and no job to the same switch', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const source = await fx.addEstimate(org, customer, admin.id);
      const lead = await fx.addLead(org, customer);
      const onLead = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });

      const without = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', edit_estimates: true, create_estimates: true, standalone_estimates: false }, { base: 'SALES' });
      const api = await without.api();
      const refused = await api.post(`/api/estimates/${source.id}/duplicate`, {});
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatch(/without a lead or job/);
      // A copy that stays on its lead is not a standalone estimate.
      expect((await api.post(`/api/estimates/${onLead.id}/duplicate`, {})).status).toBe(201);

      const withIt = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', edit_estimates: true, create_estimates: true, standalone_estimates: true }, { base: 'SALES' });
      expect((await (await withIt.api()).post(`/api/estimates/${source.id}/duplicate`, {})).status).toBe(201);
    });
  });

  describe('Create invoices and Standalone invoices', () => {
    it('creates a standalone invoice with Standalone invoices, and refuses it with Create invoices on and Standalone invoices off, while a job invoice by the same person passes', async () => {
      const { org, customer } = await fx.newOrg();
      const job = await fx.addJob(org, customer, { crew: [] });

      const both = await personWith(org, { view_invoices: true, edit_invoices: true, create_invoices: true, standalone_invoices: true });
      expect((await (await both.api()).post('/api/invoices', standaloneInvoice(customer))).status).toBe(201);

      const jobOnly = await personWith(org, { jobs_scope: 'all', view_invoices: true, edit_invoices: true, create_invoices: true, standalone_invoices: false });
      const api = await jobOnly.api();
      const refused = await api.post('/api/invoices', standaloneInvoice(customer));
      expect(refused.status).toBe(403);
      expect(refused.body.error).toMatch(/without a job/);
      const jobInvoice = await api.post('/api/invoices', { job_id: job.id, line_items: lineItems });
      expect(jobInvoice.status).toBe(201);
    });

    it('refuses a job invoice, either door, without Create invoices, whatever the base role', async () => {
      const { org, customer } = await fx.newOrg();
      const job = await fx.addJob(org, customer, { crew: [] });
      const me = await personWith(org, { jobs_scope: 'all', view_invoices: true, create_invoices: false, standalone_invoices: false });
      const api = await me.api();

      expect((await api.post('/api/invoices', { job_id: job.id, line_items: lineItems })).status).toBe(403);
      expect((await api.post(`/api/jobs/${job.id}/invoices`, { amount: 25 })).status).toBe(403);
    });

    it('lets a Sales-based role with Create invoices make a job invoice on a job it can open, and refuses one it cannot open', async () => {
      const { org, customer } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'attached', view_invoices: true, edit_invoices: true, create_invoices: true }, { base: 'SALES' });
      const dispatchedToMe = await fx.addJob(org, customer, { dispatcher: me.id });
      const notMine = await fx.addJob(org, customer, { crew: [] });
      const api = await me.api();

      // Attached reaches a job the person dispatches, though they are not on its crew.
      expect((await api.post('/api/invoices', { job_id: dispatchedToMe.id, line_items: lineItems })).status).toBe(201);
      expect((await api.post('/api/invoices', { job_id: notMine.id, line_items: lineItems })).status).toBe(404);
    });
  });

  describe('Estimate-to-invoice copy', () => {
    it('follows Create invoices, whatever the base role, and needs an estimate the person can open', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const lead = await fx.addLead(org, customer);

      const sales = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', view_invoices: true, edit_invoices: true, create_invoices: true }, { base: 'SALES' });
      const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
      expect((await (await sales.api()).post(`/api/estimates/${estimate.id}/copy-to-invoice`, {})).status).toBe(201);

      const dispatcher = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', view_invoices: true, create_invoices: false, standalone_invoices: false }, { base: 'DISPATCHER' });
      const another = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
      expect((await (await dispatcher.api()).post(`/api/estimates/${another.id}/copy-to-invoice`, {})).status).toBe(403);

      const narrow = await personWith(org, { jobs_scope: 'attached', leads_scope: 'attached', view_invoices: true, edit_invoices: true, create_invoices: true });
      const notTheirs = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id });
      expect((await (await narrow.api()).post(`/api/estimates/${notTheirs.id}/copy-to-invoice`, {})).status).toBe(404);
    });

    it('needs no Standalone invoices, since it is a copy of an estimate and not a bare invoice', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { jobs_scope: 'all', leads_scope: 'all', view_invoices: true, edit_invoices: true, create_invoices: true, standalone_invoices: false });
      const estimate = await fx.addEstimate(org, customer, admin.id);
      expect((await (await me.api()).post(`/api/estimates/${estimate.id}/copy-to-invoice`, {})).status).toBe(201);
    });
  });
});
