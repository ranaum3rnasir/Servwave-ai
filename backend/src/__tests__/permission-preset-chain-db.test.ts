/* =============================================================================
   Roles & Permissions alignment, AL-04 (A3, A7, A8): what the built-in Technician and Dispatcher presets do through the
   real routes once Create requires Edit. A Technician edits the lead, estimate and job they are on and cannot create a
   customer, record a payment or send a payment link; a Dispatcher edits customers and estimates.

   Everything goes through the public interface: people on custom roles made from the built-in role with no change to its
   preset, calling the routes. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));
// ...and so is the numbering allocator (the setup's stub hands every lead the same number, and this file makes several).
vi.unmock('../lib/numbering');

import { switchFixture, type Person } from './permission-switches-fixture';

const suite = realClient ? describe : describe.skip;

suite('the built-in presets after Create requires Edit (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 600_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;
  /** A person on a custom role that holds exactly the built-in role's preset. */
  async function onPreset(org: string, base: 'TECHNICIAN' | 'DISPATCHER'): Promise<Person> {
    const role = await fx.addCustomRole(org, `preset-${base.toLowerCase()}-${++sequence}`, base, { copyGrants: false });
    return fx.addUser(org, `${base.toLowerCase()}${sequence}`, base, { customRoleId: role.id, basedOnRoleKey: role.key });
  }

  describe('Technician', () => {
    it('edits a job and a lead they are attached to, and not one they are not', async () => {
      const { org, customer } = await fx.newOrg();
      const tech = await onPreset(org, 'TECHNICIAN');
      const api = await fx.signedInAs(tech);
      const mine = await fx.addJob(org, customer, { crew: [tech.id] });
      const theirs = await fx.addJob(org, customer);
      expect((await api.patch(`/api/jobs/${mine.id}`, { scope_notes: 'Edited' })).status).toBe(200);
      expect((await api.patch(`/api/jobs/${theirs.id}`, { scope_notes: 'Edited' })).status).toBeGreaterThanOrEqual(400);

      const myLead = await fx.addLead(org, customer, { assignees: [tech.id] });
      const otherLead = await fx.addLead(org, customer);
      expect((await api.patch(`/api/leads/${myLead.id}`, { service_request: 'Edited' })).status).toBe(200);
      expect((await api.patch(`/api/leads/${otherLead.id}`, { service_request: 'Edited' })).status).toBeGreaterThanOrEqual(400);
    });

    it('edits an estimate on a job they are on, and not one on a job they are not', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const tech = await onPreset(org, 'TECHNICIAN');
      const api = await fx.signedInAs(tech);
      const job = await fx.addJob(org, customer, { crew: [tech.id] });
      const otherJob = await fx.addJob(org, customer);
      const mine = await fx.addEstimate(org, customer, admin.id, { jobId: job.id });
      const theirs = await fx.addEstimate(org, customer, admin.id, { jobId: otherJob.id });
      expect((await api.patch(`/api/estimates/${mine.id}`, { name: 'Front door' })).status).toBe(200);
      expect((await api.patch(`/api/estimates/${theirs.id}`, { name: 'Front door' })).status).toBeGreaterThanOrEqual(400);
    });

    it('cannot create a customer, record a payment or send a payment link', async () => {
      const { org, customer } = await fx.newOrg();
      const tech = await onPreset(org, 'TECHNICIAN');
      const api = await fx.signedInAs(tech);
      expect((await api.post('/api/customers', { first_name: 'New', email: `new-${sequence}@example.test` })).status).toBe(403);
      const job = await fx.addJob(org, customer, { crew: [tech.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      expect((await api.post(`/api/invoices/${invoice.id}/payments`, { amount: 10, method: 'CASH' })).status).toBe(403);
      expect((await api.post(`/api/invoices/${invoice.id}/payment-link`)).status).toBe(403);
    });
  });

  describe('a new customer inside a lead form (A7)', () => {
    const newCustomer = () => ({ first_name: 'New', last_name: `Person${++sequence}`, phone: `617555${String(sequence).padStart(4, '0')}` });

    it('is refused to a Technician, who may still start a lead on an existing customer, and let in for a Dispatcher', async () => {
      const { org, customer } = await fx.newOrg();
      const tech = await onPreset(org, 'TECHNICIAN');
      const techApi = await fx.signedInAs(tech);
      const viaNew = await techApi.post('/api/leads', { new_customer: newCustomer(), service_request: 'Fix the door' });
      expect(viaNew.status).toBe(403);
      expect(viaNew.body.error).toMatch(/create customers/i);
      expect((await techApi.post('/api/leads', { customer_id: customer, service_request: 'Fix the door' })).status).toBe(201);

      const dispatcher = await onPreset(org, 'DISPATCHER');
      const dispatcherApi = await fx.signedInAs(dispatcher);
      expect((await dispatcherApi.post('/api/leads', { new_customer: newCustomer(), service_request: 'Fix the door' })).status).toBe(201);
    });
  });

  describe('Dispatcher', () => {
    it('edits customers and estimates', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const dispatcher = await onPreset(org, 'DISPATCHER');
      const api = await fx.signedInAs(dispatcher);
      expect((await api.patch(`/api/customers/${customer}`, { notes: 'Edited by the dispatcher' })).status).toBe(200);
      const estimate = await fx.addEstimate(org, customer, admin.id);
      expect((await api.patch(`/api/estimates/${estimate.id}`, { name: 'Front door' })).status).toBe(200);
    });
  });
});
