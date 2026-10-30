/* ======================================================================   Roles & Permissions (scenario pass 2 re-check): Complete job and Reopen must not slow down as the company grows.

   The hosted database sits behind a pooler that gives the service ONE connection, so every query of a request runs after
   the one before and its cost is the NUMBER of queries. Measured on the hosted demo company (about 270 people, 90 of them
   Dispatchers), Complete answered after 15 to 21 seconds and Reopen after 7 to 8. The alert writer every notification goes
   through (`emit`) asked "may this person open the job?" one recipient at a time (three reads per person while their
   switches were not cached) and then pinged each recipient's live channel one after the other.

   Seam: POST /api/jobs/:id/complete and POST /api/jobs/:id/reopen as an Admin, and the recipient filter the alert writer
   runs. Everything runs on a client created with connection_limit=1 that counts the queries it sends, with the people's
   switches uncached (the case after a minute of nobody logging in). Real migrated database (TEST_DATABASE_URL); the suite
   skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'crypto';
import express from 'express';
import type { PrismaClient, Role } from '@prisma/client';

const { realClient, sent } = vi.hoisted(() => {
  const sent: string[] = [];
  const dbUrl = process.env.TEST_DATABASE_URL;
  let client: unknown;
  if (dbUrl) {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    const pooled = new URL(dbUrl);
    pooled.searchParams.set('connection_limit', '1');
    pooled.searchParams.set('pool_timeout', '60');
    const made = new PrismaClient({ datasources: { db: { url: pooled.toString() } }, log: [{ emit: 'event', level: 'query' }] });
    (made as unknown as { $on: (e: string, f: (q: { query: string }) => void) => void }).$on('query', (q) => sent.push(q.query));
    client = made;
  }
  return { realClient: client as PrismaClient | undefined, sent };
});

// The suite-wide setup mocks the app's client; here it is the real one.
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

// The suite-wide setup hands every record the same number; these cases create several jobs in one company.
vi.mock('../lib/numbering', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../lib/numbering')>();
  let issued = 0;
  return {
    ...actual,
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
    // A logistic order is numbered after the job it hangs on.
    allocateAnchoredNumber: vi.fn(async (_tx: unknown, args: { anchorTable: string }) => ({ number: `${args.anchorTable.slice(0, 2).toUpperCase()}T${Date.now()}${++issued}`, seq: issued })),
  };
});

import { switchFixture } from './permission-switches-fixture';
import { clearAllSwitchCaches } from '../lib/permissions/switches/cache';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { reviewAttentionSettled } from '../services/notifications/reviewAttentionQueue';
import { flushRealtimePublishes } from '../services/notifications/realtimePublish';

const suite = realClient ? describe : describe.skip;

// The live-update ping goes to the vendor's broadcast door with plain fetch; here that door is a stub that records every
// message it is handed and the order of events around it (a response finishing, a request to the door). Any other
// address goes to the real fetch.
const pings = { count: 0, requests: 0, delayMs: 5, topics: [] as string[], order: [] as string[] };
const fetchBeforeStub = globalThis.fetch;
globalThis.fetch = (async (input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
  if (!url.includes('/realtime/v1/api/broadcast')) return fetchBeforeStub(input, init);
  const messages = (JSON.parse(String(init?.body)) as { messages: Array<{ topic: string }> }).messages;
  pings.order.push('ping request');
  pings.requests += 1;
  pings.count += messages.length;
  for (const m of messages) pings.topics.push(m.topic);
  await new Promise((resolve) => setTimeout(resolve, pings.delayMs));
  return new Response(null, { status: 202 });
}) as typeof fetch;

suite('Complete job and Reopen on a pool of one connection (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  // The parts stages the scheduling case makes hang off its companies; they go before the companies do.
  const stageOrgs: string[] = [];
  // The credits the billing case applies hang off its invoices.
  const creditOrgs: string[] = [];
  afterAll(async () => {
    for (const org of creditOrgs) {
      await db.$executeRawUnsafe(`DELETE FROM credits WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`).catch(() => undefined);
    }
    for (const org of stageOrgs) {
      for (const table of ['logistic_order_lines', 'logistic_orders', 'stock_movements', 'stock_balances', 'stage_audit_entries', 'job_stage_lines', 'job_stages', 'purchase_order_lines', 'purchase_orders', 'price_book_items', 'inventory_locations']) {
        await db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`).catch(() => undefined);
      }
    }
    await fx.cleanup();
  });

  /** A company with this many Dispatchers, an Admin, a technician and the rest sales, all active. */
  async function company(people: number, dispatchers: number) {
    const { org, customer, admin } = await fx.newOrg();
    const make = (role: Role, n: number) =>
      Array.from({ length: n }, (_, i) => ({
        id: randomUUID(), organization_id: org, email: `${role}${i}-${org.slice(0, 8)}@example.test`,
        first_name: role, last_name: String(i), role,
      }));
    await db.user.createMany({ data: [...make('DISPATCHER', dispatchers), ...make('SALES', people - dispatchers - 2)] });
    const crew = await fx.addUser(org, 'crew', 'TECHNICIAN');
    return { org, customer, admin, crew, dispatchers: await db.user.findMany({ where: { organization_id: org, role: 'DISPATCHER' }, select: { id: true } }) };
  }

  /**
   * The queries one request sends, with nobody's switches cached, and the alerts it queued for after the response (Reopen's and
   * the close-out ones): the whole cost of the action, which is what has to stay flat as the company grows.
   */
  async function queriesOf(request: () => Promise<{ status: number; body: unknown }>) {
    clearAllSwitchCaches();
    sent.length = 0;
    const res = await request();
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    await reviewAttentionSettled();
    return sent.length;
  }

  async function close(people: number, dispatchers: number) {
    const c = await company(people, dispatchers);
    const api = await fx.signedInAs(c.admin);
    const job = await fx.addJob(c.org, c.customer, { status: 'IN_PROGRESS', crew: [c.crew.id], soldBy: c.crew.id });
    await fx.addVisit(c.org, { jobId: job.id, crew: [c.crew.id], daysFromNow: 3, seq: 2 });
    await api.get(`/api/jobs/${job.id}`);
    const complete = await queriesOf(() => api.post(`/api/jobs/${job.id}/complete`, { cancel_open_visits: true }));
    const done = await fx.addJob(c.org, c.customer, { status: 'DONE', crew: [c.crew.id] });
    const reopen = await queriesOf(() => api.post(`/api/jobs/${done.id}/reopen`));
    return { ...c, complete, reopen, job, done };
  }

  it('sends the same number of queries for a company of 20 as for one of 270', async () => {
    const small = await close(20, 4);
    const large = await close(270, 90);

    // A few reads more or less is fine; one per person is not.
    expect(Math.abs(large.complete - small.complete), `complete: ${small.complete} vs ${large.complete}`).toBeLessThanOrEqual(3);
    expect(Math.abs(large.reopen - small.reopen), `reopen: ${small.reopen} vs ${large.reopen}`).toBeLessThanOrEqual(3);
    expect(large.reopen).toBeLessThan(60);
    expect(large.complete).toBeLessThan(100);
  }, 120_000);

  it('tells every Office review holder of the company when a job with no Dispatcher is reopened, and only the job\'s own people when it has one; and every one who must review a completed job', async () => {
    const c = await close(60, 25);
    const dispatcherIds = new Set(c.dispatchers.map((d) => d.id));

    // The job has no Dispatcher, so the step 2 holders (the Dispatcher role's preset holds Office review) cover for it.
    const reopened = await db.notificationRecipient.findMany({
      where: { organization_id: c.org, notification: { verb: 'job.reopened', object_id: c.done.id } },
      select: { recipient_id: true },
    });
    expect(new Set(reopened.map((r) => r.recipient_id))).toEqual(new Set([...dispatcherIds, c.crew.id]));

    // The same company, a job that has a Dispatcher: step 1 takes it and nobody else is covering.
    const [theirs] = c.dispatchers;
    const owned = await fx.addJob(c.org, c.customer, { status: 'DONE', crew: [c.crew.id], dispatcher: theirs!.id });
    const api = await fx.signedInAs(c.admin);
    expect((await api.post(`/api/jobs/${owned.id}/reopen`)).status).toBe(200);
    await reviewAttentionSettled();
    const told = await db.notificationRecipient.findMany({
      where: { organization_id: c.org, notification: { verb: 'job.reopened', object_id: owned.id } },
      select: { recipient_id: true },
    });
    expect(told.map((r) => r.recipient_id).sort()).toEqual([c.crew.id, theirs!.id].sort());

    const completed = await db.notificationRecipient.findMany({
      where: { organization_id: c.org, notification: { verb: 'job.completed', object_id: c.job.id } },
      select: { recipient_id: true },
    });
    const completedTold = new Set(completed.map((r) => r.recipient_id));
    expect(completedTold.has(c.crew.id)).toBe(true);
    for (const id of dispatcherIds) expect(completedTold.has(id), 'a Dispatcher is told').toBe(true);
    expect(completedTold.has(c.admin.id), 'the person who completed it is not told').toBe(false);
  }, 120_000);

  /**
   * S06.25: Job started, Job cancelled and Job reopened go through the same writer after the response, so a bigger company must not
   * cost more queries, and a bulk of jobs costs the same few reads per job however many people there are. The request itself
   * only queues the alert: it gains no query of its own.
   */
  it('sends the started, cancelled and reopened alerts in the same number of queries for a company of 20 as for one of 270, also in bulk', async () => {
    async function lifecycleCosts(people: number, dispatchers: number) {
      const c = await company(people, dispatchers);
      const api = await fx.signedInAs(c.admin);
      const settledQueries = async (request: () => Promise<{ status: number; body: unknown }>) => {
        clearAllSwitchCaches();
        sent.length = 0;
        const res = await request();
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const atResponse = sent.length;
        await reviewAttentionSettled();
        return { atResponse, settled: sent.length };
      };
      const open = (status: 'SCHEDULED' | 'IN_PROGRESS' | 'DONE') => fx.addJob(c.org, c.customer, { status, crew: [c.crew.id], soldBy: c.crew.id });

      const startJob = await open('SCHEDULED');
      const start = await settledQueries(() => api.post(`/api/jobs/${startJob.id}/start`));
      const cancelJob = await open('IN_PROGRESS');
      const cancel = await settledQueries(() => api.post(`/api/jobs/${cancelJob.id}/cancel`, { cancel_reason_code: 'PRICE' }));
      const reopenJob = await open('DONE');
      const reopen = await settledQueries(() => api.post(`/api/jobs/${reopenJob.id}/reopen`));

      const bulkIds: string[] = [];
      for (let i = 0; i < 20; i += 1) bulkIds.push((await open('SCHEDULED')).id);
      const bulkStart = await settledQueries(() => api.post('/api/jobs/bulk-status', { ids: bulkIds, action: 'start' }));
      const bulkCancelIds: string[] = [];
      for (let i = 0; i < 20; i += 1) bulkCancelIds.push((await open('IN_PROGRESS')).id);
      const bulkCancel = await settledQueries(() => api.post('/api/jobs/bulk-status', { ids: bulkCancelIds, action: 'cancel', cancel_reason_code: 'PRICE' }));
      return { start, cancel, reopen, bulkStart, bulkCancel, org: c.org, startJob, bulkIds, bulkCancelIds };
    }

    const small = await lifecycleCosts(20, 4);
    const large = await lifecycleCosts(270, 90);

    for (const key of ['start', 'cancel', 'reopen', 'bulkStart', 'bulkCancel'] as const) {
      const spread = key.startsWith('bulk') ? 20 * 3 : 3;
      expect(Math.abs(large[key].settled - small[key].settled), `${key}: ${small[key].settled} vs ${large[key].settled}`).toBeLessThanOrEqual(spread);
    }
    // A bulk of 20 jobs does 20 times a job's work, never 20 times a per-person read: a few dozen reads a job at the most.
    expect(large.bulkStart.settled).toBeLessThan(20 * 80);
    expect(large.bulkCancel.settled).toBeLessThan(20 * 80);
    // The alert is not on the request: the answer is not slower for it. Start's request path sends the same queries whatever the
    // alert would cost, and the rest of its queries come after it.
    expect(large.start.settled - large.start.atResponse, 'start: alert queries after the response').toBeGreaterThan(0);
    expect(large.reopen.settled - large.reopen.atResponse, 'reopen: alert queries after the response').toBeGreaterThan(0);
    expect(large.cancel.settled - large.cancel.atResponse, 'cancel: alert queries after the response').toBeGreaterThan(0);
    // Every bulk job was alerted, to its crew member and the Dispatchers covering for it.
    const alerted = (verb: string, jobIds: string[]) => db.notification.count({ where: { organization_id: large.org, verb, object_id: { in: jobIds } } });
    expect(await alerted('job.started', large.bulkIds)).toBeGreaterThanOrEqual(20);
    expect(await alerted('job.cancelled', large.bulkCancelIds)).toBeGreaterThanOrEqual(20);
    console.log(`[S06.25 query counts] small/large, at response -> settled: start ${small.start.atResponse}->${small.start.settled}/${large.start.atResponse}->${large.start.settled}; cancel ${small.cancel.atResponse}->${small.cancel.settled}/${large.cancel.atResponse}->${large.cancel.settled}; reopen ${small.reopen.atResponse}->${small.reopen.settled}/${large.reopen.atResponse}->${large.reopen.settled}; bulk start of 20 ${small.bulkStart.settled}/${large.bulkStart.settled}; bulk cancel of 20 ${small.bulkCancel.settled}/${large.bulkCancel.settled}`);
  }, 300_000);

  /**
   * S06.24: the two close-out alerts go through the same writer, so a bigger company must not cost more queries. The Office
   * review attention alert is sent after the response (its reads are counted once it has gone out): Complete itself only
   * queues it, so the request gains no query of its own.
   */
  it('sends the Office review attention and Ready to close alerts in the same number of queries for a company of 20 as for one of 270', async () => {
    async function alertCosts(people: number, dispatchers: number) {
      const c = await company(people, dispatchers);
      const api = await fx.signedInAs(c.admin);
      const entry = (jobId: string, event_type: string, metadata: Record<string, unknown>) =>
        db.timelineEvent.create({ data: { organization_id: c.org, entity_type: 'JOB', entity_id: jobId, event_type, description: event_type, metadata: metadata as never } });
      const settledQueries = async (request: () => Promise<{ status: number; body: unknown }>) => {
        clearAllSwitchCaches();
        sent.length = 0;
        const res = await request();
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        const atResponse = sent.length;
        await reviewAttentionSettled();
        return { atResponse, settled: sent.length };
      };

      // Complete with nothing unusual in the window, and with an unusual item in it.
      const plain = await fx.addJob(c.org, c.customer, { status: 'IN_PROGRESS', pastVisit: true, crew: [c.crew.id], soldBy: c.crew.id });
      const without = await settledQueries(() => api.post(`/api/jobs/${plain.id}/complete`));
      const flagged = await fx.addJob(c.org, c.customer, { status: 'IN_PROGRESS', pastVisit: true, crew: [c.crew.id], soldBy: c.crew.id });
      await entry(flagged.id, 'ATTACHMENT_DELETED', { attachment_id: randomUUID(), display_name: 'Old.pdf' });
      const withItem = await settledQueries(() => api.post(`/api/jobs/${flagged.id}/complete`));
      // The same with the unusual item on an invoice: each person's list depends on the invoices they can open, and the extra
      // reads are per invoice named, never per person.
      const invoiced = await fx.addJob(c.org, c.customer, { status: 'IN_PROGRESS', pastVisit: true, crew: [c.crew.id], soldBy: c.crew.id });
      const invoice = await fx.addInvoice(c.org, c.customer, { jobId: invoiced.id });
      const snap = (price: number) => ({ name: 'Service', quantity: 1, unit_price: price, line_total: price, is_taxable: true, discount_type: null, discount_value: null, discount_amount: 0 });
      await entry(invoiced.id, 'JOB_INVOICE_LINE_CHANGED', { invoice_id: invoice.id, invoice_number: 'INV-1', line_id: invoice.lineId, old: snap(100), new: snap(70) });
      const withInvoiceItem = await settledQueries(() => api.post(`/api/jobs/${invoiced.id}/complete`));

      // Finish the review of the first one: the Ready to close alert.
      const review = (await api.get(`/api/jobs/${plain.id}/review`)).body.review;
      await api.post(`/api/jobs/${plain.id}/review/checks/all`, { items: [{ item_key: 'summary', entry_id: review.summary.latest_entry_id }] });
      const version = (await api.get(`/api/jobs/${plain.id}/review`)).body.review.version;
      const finish = await settledQueries(() => api.post(`/api/jobs/${plain.id}/review/finish`, { version }));
      // What the Ready to close alert alone costs: the alert is sent again by hand and its queries counted.
      const { alertJobReadyToClose } = await import('../services/notifications/jobReviewAlerts.js');
      clearAllSwitchCaches();
      sent.length = 0;
      await alertJobReadyToClose({ organizationId: c.org, actorId: c.admin.id, jobId: plain.id });
      const readyAlone = sent.length;
      return { without, withItem, withInvoiceItem, finish, readyAlone, org: c.org, flagged: flagged.id, plain: plain.id };
    }

    const small = await alertCosts(20, 4);
    const large = await alertCosts(270, 90);

    for (const key of ['without', 'withItem', 'withInvoiceItem', 'finish'] as const) {
      expect(Math.abs(large[key].settled - small[key].settled), `${key}: ${small[key].settled} vs ${large[key].settled}`).toBeLessThanOrEqual(3);
    }
    expect(Math.abs(large.readyAlone - small.readyAlone), `ready to close alone: ${small.readyAlone} vs ${large.readyAlone}`).toBeLessThanOrEqual(3);
    expect(large.readyAlone).toBeLessThan(40);
    // The attention alert costs what Complete costs with an item over Complete without one, whatever the company's size.
    expect(large.withItem.settled - large.without.settled).toBeLessThan(40);
    expect(large.withInvoiceItem.settled - large.without.settled).toBeLessThan(40);
    // Both alerts reached their people in the large company.
    const told = (jobId: string, verb: string) => db.notificationRecipient.count({ where: { notification: { object_id: jobId, verb } } });
    expect(await told(large.flagged, 'job.review_attention')).toBeGreaterThan(0);
    expect(await told(large.plain, 'job.ready_to_close')).toBeGreaterThan(0);
    console.log(`[S06.24 query counts] small/large Complete without item at response ${small.without.atResponse}/${large.without.atResponse}, settled ${small.without.settled}/${large.without.settled}; with item settled ${small.withItem.settled}/${large.withItem.settled}; with invoice item settled ${small.withInvoiceItem.settled}/${large.withInvoiceItem.settled}; finish settled ${small.finish.settled}/${large.finish.settled}; ready alone ${small.readyAlone}/${large.readyAlone}`);
  }, 180_000);

  /**
   * S06.26: the lead and estimate alerts go through the same writer after the response, so a bigger company must not cost more
   * queries, and the request itself only queues the alert: it gains no query of its own.
   */
  it('sends the new lead, walkthrough and estimate alerts in the same number of queries for a company of 20 as for one of 270', async () => {
    async function leadEstimateCosts(people: number, dispatchers: number) {
      const c = await company(people, dispatchers);
      const api = await fx.signedInAs(c.admin);
      const settledQueries = async (request: () => Promise<{ status: number; body: unknown }>) => {
        clearAllSwitchCaches();
        sent.length = 0;
        const res = await request();
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
        const atResponse = sent.length;
        await reviewAttentionSettled();
        return { atResponse, settled: sent.length };
      };
      const estimateOn = async (status: 'SENT' | 'WON') => {
        const lead = await fx.addLead(c.org, c.customer, { owner: c.crew.id });
        const estimate = await fx.addEstimate(c.org, c.customer, c.admin.id, { leadId: lead.id });
        await db.estimate.update({ where: { id: estimate.id }, data: { status } });
        return estimate;
      };

      const newLead = await settledQueries(() => api.post('/api/leads', { customer_id: c.customer, service_request: 'Fix the door' }));
      const bookedLead = await fx.addLead(c.org, c.customer, { owner: c.crew.id });
      const walkthrough = await settledQueries(() => api.post(`/api/leads/${bookedLead.id}/walkthrough/schedule`, {
        walkthrough_scheduled_at: new Date(Date.now() + 3 * 86_400_000).toISOString(), performer_ids: [c.crew.id], send_email: false,
      }));
      const won = await estimateOn('SENT');
      const approve = await settledQueries(() => api.post(`/api/estimates/${won.id}/approve-internal`, {}));
      const declined = await estimateOn('SENT');
      const decline = await settledQueries(() => api.post(`/api/estimates/${declined.id}/decline-internal`, { lost_reason: 'PRICE' }));
      const paid = await estimateOn('SENT');
      const deposit = await settledQueries(() => api.post(`/api/estimates/${paid.id}/record-payment`, { amount: 10, payment_method: 'CASH' }));
      return { newLead, walkthrough, approve, decline, deposit, org: c.org, won: won.id, paid: paid.id };
    }

    const small = await leadEstimateCosts(20, 4);
    const large = await leadEstimateCosts(270, 90);

    for (const key of ['newLead', 'walkthrough', 'approve', 'decline', 'deposit'] as const) {
      expect(Math.abs(large[key].settled - small[key].settled), `${key}: ${small[key].settled} vs ${large[key].settled}`).toBeLessThanOrEqual(3);
      // The alert is not on the request: its queries come after the answer.
      expect(large[key].settled - large[key].atResponse, `${key}: alert queries after the response`).toBeGreaterThan(0);
    }
    // A few dozen reads an alert at the most (a deposit that approves the estimate sends two), never one per person.
    const alertCost = (key: 'newLead' | 'walkthrough' | 'approve' | 'decline' | 'deposit') => large[key].settled - large[key].atResponse;
    for (const key of ['newLead', 'walkthrough', 'approve', 'decline', 'deposit'] as const) expect(alertCost(key), key).toBeLessThan(150);
    // The 90 Dispatchers of the large company cover for the missing Dispatcher on a win: every one of them is told.
    const told = await db.notificationRecipient.count({ where: { notification: { object_id: large.won, verb: 'estimate.approved' } } });
    expect(told).toBeGreaterThanOrEqual(90);
    console.log(`[S06.26 query counts] small/large, at response -> settled: new lead ${small.newLead.atResponse}->${small.newLead.settled}/${large.newLead.atResponse}->${large.newLead.settled}; walkthrough ${small.walkthrough.atResponse}->${small.walkthrough.settled}/${large.walkthrough.atResponse}->${large.walkthrough.settled}; approve ${small.approve.atResponse}->${small.approve.settled}/${large.approve.atResponse}->${large.approve.settled}; decline ${small.decline.atResponse}->${small.decline.settled}/${large.decline.atResponse}->${large.decline.settled}; deposit ${small.deposit.atResponse}->${small.deposit.settled}/${large.deposit.atResponse}->${large.deposit.settled}`);
  }, 300_000);

  /**
   * S06.27: Job created, Job assigned, Job rescheduled, Unassigned from you and Parts staged and ready go through the same writer
   * after the response, so a bigger company must not cost more queries, and a bulk assign costs a few reads a job whatever the
   * size of the company. The request itself only queues the alert: it gains no query of its own.
   */
  it('sends the scheduling and parts alerts in the same number of queries for a company of 20 as for one of 270, also in bulk', async () => {
    async function schedulingCosts(people: number, dispatchers: number) {
      const c = await company(people, dispatchers);
      stageOrgs.push(c.org);
      const api = await fx.signedInAs(c.admin);
      const second = await fx.addUser(c.org, 'second', 'TECHNICIAN');
      const settledQueries = async (request: () => Promise<{ status: number; body: unknown }>) => {
        clearAllSwitchCaches();
        sent.length = 0;
        const res = await request();
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
        const atResponse = sent.length;
        await reviewAttentionSettled();
        return { atResponse, settled: sent.length };
      };
      const scheduled = () => fx.addJob(c.org, c.customer, { status: 'SCHEDULED', crew: [c.crew.id], soldBy: c.crew.id });

      const location = randomUUID();
      await db.serviceLocation.create({
        data: { id: location, customer_id: c.customer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
      });
      const created = await settledQueries(() => api.post('/api/jobs', { customer_id: c.customer, service_location_id: location }));
      const assignJob = await scheduled();
      const assigned = await settledQueries(() => api.post(`/api/jobs/${assignJob.id}/assignees`, { assignee_ids: [c.crew.id, second.id] }));
      const unassigned = await settledQueries(() => api.post(`/api/jobs/${assignJob.id}/assignees`, { assignee_ids: [c.crew.id] }));
      const moveJob = await scheduled();
      const start = new Date(Date.now() + 9 * 86_400_000);
      const rescheduled = await settledQueries(() => api.post(`/api/jobs/${moveJob.id}/assign`, {
        assignee_ids: [c.crew.id], scheduled_start: start.toISOString(), scheduled_end: new Date(start.getTime() + 3_600_000).toISOString(),
      }));
      const stageJob = await scheduled();
      const stageId = randomUUID();
      await db.jobStage.create({
        data: { id: stageId, organization_id: c.org, job_id: stageJob.id, job_number: 'J-FANOUT', customer: 'Pat Payer', site: '1 Test Way', trade: 'locksmith', status: 'staged', assigned_tech_id: c.crew.id },
      });
      const staged = await settledQueries(() => api.post('/api/inventory/job-stages/notify', { stageId }));
      const bulkIds: string[] = [];
      for (let i = 0; i < 20; i += 1) bulkIds.push((await scheduled()).id);
      const bulkAssign = await settledQueries(() => api.post('/api/jobs/bulk-assign', { ids: bulkIds, assignee_ids: [c.crew.id, second.id] }));
      return { created, assigned, unassigned, rescheduled, staged, bulkAssign, org: c.org, bulkIds, assignJob, stageId, moveJob };
    }

    const small = await schedulingCosts(20, 4);
    const large = await schedulingCosts(270, 90);

    for (const key of ['created', 'assigned', 'unassigned', 'rescheduled', 'staged', 'bulkAssign'] as const) {
      const spread = key === 'bulkAssign' ? 20 * 3 : 3;
      expect(Math.abs(large[key].settled - small[key].settled), `${key}: ${small[key].settled} vs ${large[key].settled}`).toBeLessThanOrEqual(spread);
    }
    // The alert is not on the request: its queries come after the answer (the personal alert needs only a couple).
    for (const key of ['created', 'assigned', 'unassigned', 'rescheduled', 'staged', 'bulkAssign'] as const) {
      expect(large[key].settled - large[key].atResponse, `${key}: alert queries after the response`).toBeGreaterThan(0);
    }
    // A few dozen reads an alert at the most, a bulk of 20 jobs does 20 times that and never 20 times a per-person read.
    expect(large.created.settled - large.created.atResponse).toBeLessThan(150);
    expect(large.assigned.settled - large.assigned.atResponse).toBeLessThan(150);
    expect(large.bulkAssign.settled).toBeLessThan(20 * 150);
    // The 90 Dispatchers of the large company cover for the missing Dispatcher on a new job: every one of them is told.
    const alerted = (verb: string, jobIds: string[]) => db.notification.count({ where: { organization_id: large.org, verb, object_id: { in: jobIds } } });
    expect(await alerted('dispatch.job_assigned', large.bulkIds)).toBeGreaterThanOrEqual(20);
    // ...and the personal alert goes to the one person taken off, whatever the size of the company.
    const removed = await db.notificationRecipient.findMany({ where: { notification: { organization_id: large.org, verb: 'dispatch.job_unassigned', object_id: large.assignJob.id } } });
    expect(removed.length).toBeLessThanOrEqual(1);
    console.log(`[S06.27 query counts] small/large, at response -> settled: created ${small.created.atResponse}->${small.created.settled}/${large.created.atResponse}->${large.created.settled}; assigned ${small.assigned.atResponse}->${small.assigned.settled}/${large.assigned.atResponse}->${large.assigned.settled}; unassigned ${small.unassigned.atResponse}->${small.unassigned.settled}/${large.unassigned.atResponse}->${large.unassigned.settled}; rescheduled ${small.rescheduled.atResponse}->${small.rescheduled.settled}/${large.rescheduled.atResponse}->${large.rescheduled.settled}; staged ${small.staged.atResponse}->${small.staged.settled}/${large.staged.atResponse}->${large.staged.settled}; bulk assign of 20 ${small.bulkAssign.settled}/${large.bulkAssign.settled}`);
  }, 300_000);

  /**
   * S06.28: the billing alerts go through the same writer, so a bigger company must not cost more queries. The three routes only
   * queue their alert (the request gains no query for it); a processor notice and the nightly sweep send it themselves after their
   * own commit. The sweep over many invoices reads each invoice's people with the invoices, asks once what was sent today and reads
   * each switch's holders once for the whole run, so what is left per invoice does not grow with the company either.
   */
  it('sends the billing alerts in the same number of queries for a company of 20 as for one of 270, also for a nightly sweep of many invoices', async () => {
    async function billingCosts(people: number, dispatchers: number) {
      const c = await company(people, dispatchers);
      creditOrgs.push(c.org);
      await db.organization.update({ where: { id: c.org }, data: { accepted_payment_methods: ['CASH', 'CHECK', 'CARD'] } });
      const api = await fx.signedInAs(c.admin);
      const settledQueries = async (request: () => Promise<{ status: number; body: unknown }>) => {
        clearAllSwitchCaches();
        sent.length = 0;
        const res = await request();
        expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
        const atResponse = sent.length;
        await reviewAttentionSettled();
        return { atResponse, settled: sent.length };
      };
      const open = async () => {
        const job = await fx.addJob(c.org, c.customer, { status: 'SCHEDULED', crew: [c.crew.id], soldBy: c.crew.id });
        const invoice = await fx.addInvoice(c.org, c.customer, { jobId: job.id });
        await db.invoice.update({ where: { id: invoice.id }, data: { status: 'SENT', sent_at: new Date(), public_token: randomUUID() } });
        return invoice;
      };

      const paid = await open();
      const payment = await settledQueries(() => api.post(`/api/invoices/${paid.id}/payments`, { amount: 10, method: 'CASH' }));
      const voided = await open();
      const voidCost = await settledQueries(() => api.post(`/api/invoices/${voided.id}/void`, { voided_reason: 'Sent in error' }));
      const credited = await open();
      const credit = await settledQueries(() => api.post(`/api/invoices/${credited.id}/credit`, { amount: 5, reason: 'goodwill' }));

      // A processor notice, sent with no request behind it.
      const disputed = await open();
      const { notifyOwners } = await import('../lib/owner-payment-notices.js');
      clearAllSwitchCaches();
      sent.length = 0;
      await notifyOwners({
        verb: 'billing.disputed', organizationId: c.org, object: { type: 'INVOICE', id: disputed.id, label: 'I-FANOUT' },
        data: { amount: '300.00' }, dedupKey: `billing.disputed:fanout:${disputed.id}`, actionLabel: 'Open the invoice',
      });
      const notice = sent.length;

      // The nightly sweep: 30 overdue invoices of this company, each on a job with a crew member, none with a Dispatcher.
      const overdue: string[] = [];
      for (let i = 0; i < 30; i += 1) {
        const invoice = await open();
        await db.invoice.update({ where: { id: invoice.id }, data: { due_date: new Date(Date.now() - 3 * 86_400_000) } });
        overdue.push(invoice.id);
      }
      const { runInvoiceDueChecks } = await import('../services/notifications/invoiceDueCron.js');
      clearAllSwitchCaches();
      sent.length = 0;
      await runInvoiceDueChecks(new Date());
      const sweep = sent.length;
      return { payment, voidCost, credit, notice, sweep, org: c.org, overdue, paid, disputed, dispatchers: c.dispatchers };
    }

    const small = await billingCosts(20, 4);
    const large = await billingCosts(270, 90);

    for (const key of ['payment', 'voidCost', 'credit'] as const) {
      expect(Math.abs(large[key].settled - small[key].settled), `${key}: ${small[key].settled} vs ${large[key].settled}`).toBeLessThanOrEqual(3);
      // The alert is not on the request: its queries come after the answer.
      expect(large[key].settled - large[key].atResponse, `${key}: alert queries after the response`).toBeGreaterThan(0);
      // A few dozen reads an alert at the most, never one per person.
      expect(large[key].settled - large[key].atResponse, key).toBeLessThan(80);
    }
    expect(Math.abs(large.notice - small.notice), `notice: ${small.notice} vs ${large.notice}`).toBeLessThanOrEqual(3);
    expect(large.notice).toBeLessThan(100);
    // 30 invoices cost about 30 times one alert, and never 30 times a per-person read; the company's size adds next to nothing.
    // (The sweep reads every open invoice in the database, so a little room is left for invoices of other suites.)
    expect(Math.abs(large.sweep - small.sweep), `sweep: ${small.sweep} vs ${large.sweep}`).toBeLessThanOrEqual(60);
    expect(large.sweep, 'sweep of 30 invoices').toBeLessThan(30 * 40);
    // Every overdue invoice of the large company was alerted, and the 90 Dispatchers of it cover for the missing Dispatcher on a
    // payment that nobody can place: they hold Access Billing in this company's presets.
    const alerted = await db.notification.count({ where: { organization_id: large.org, verb: 'billing.invoice_overdue', object_id: { in: large.overdue } } });
    expect(alerted).toBeGreaterThanOrEqual(30);
    console.log(`[S06.28 query counts] small/large, at response -> settled: payment ${small.payment.atResponse}->${small.payment.settled}/${large.payment.atResponse}->${large.payment.settled}; void ${small.voidCost.atResponse}->${small.voidCost.settled}/${large.voidCost.atResponse}->${large.voidCost.settled}; credit ${small.credit.atResponse}->${small.credit.settled}/${large.credit.atResponse}->${large.credit.settled}; processor notice ${small.notice}/${large.notice}; sweep of 30 invoices ${small.sweep}/${large.sweep}`);
  }, 300_000);

  /**
   * S06.29: the alerts that have no record go through the same writer, so a bigger company must not cost more queries. The routes
   * only queue their alert (the request gains no query for it); the payments-account door and the first-payment effects send it
   * themselves after their own commit. Each is measured with one holder of its switch in the company (the payments-account alerts go to the Admins, 36b: the company's own Admin), 20 people against 270. A request
   * that raises many of them (ten stock crossings at once) reads the company's holders once, not once per alert.
   */
  it('sends the alerts that have no record in the same number of queries for a company of 20 as for one of 270', async () => {
    const { default: request } = await import('supertest');
    const { supabaseAdmin } = await import('../lib/supabase.js');
    const { issueInviteToken } = await import('../lib/invite-link.js');
    const holderValues = {
      view_users: true, create_purchase_orders: true, view_purchase_orders: true,
      edit_stock: true, view_stock: true, edit_price_book_items: true, view_price_book: true, edit_purchase_orders: true, view_jobs: true, jobs_scope: 'all',
    };
    async function noRecordCosts(people: number, dispatchers: number) {
      const c = await company(people, dispatchers);
      stageOrgs.push(c.org);
      const key = `no-record-holder-${c.org.slice(0, 6)}`;
      const role = await fx.addCustomRole(c.org, key, 'DISPATCHER');
      await setRoleSwitchValues({ organizationId: c.org, roleKey: key, values: holderValues, actorId: null, reason: 'manual' });
      await fx.addUser(c.org, 'holder', 'DISPATCHER', { customRoleId: role.id });
      const actorRole = `no-record-actor-${c.org.slice(0, 6)}`;
      const actorRow = await fx.addCustomRole(c.org, actorRole, 'DISPATCHER');
      await setRoleSwitchValues({ organizationId: c.org, roleKey: actorRole, values: { ...holderValues, create_purchase_orders: false }, actorId: null, reason: 'manual' });
      const actor = await fx.addUser(c.org, 'actor', 'DISPATCHER', { customRoleId: actorRow.id });
      const api = await fx.signedInAs(actor);
      const settledQueries = async (act: () => Promise<{ status: number; body: unknown } | void>) => {
        clearAllSwitchCaches();
        sent.length = 0;
        const res = await act();
        if (res) expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
        const atResponse = sent.length;
        await reviewAttentionSettled();
        return { atResponse, settled: sent.length };
      };
      const shelf = async () => {
        const item = randomUUID();
        const from = randomUUID();
        const to = randomUUID();
        await db.priceBookItem.create({ data: { id: item, organization_id: c.org, name: `Hinge ${item.slice(0, 6)}`, sku: `SKU-${item.slice(0, 8)}`, unit_price: 10, track_inventory: true } });
        for (const id of [from, to]) await db.inventoryLocation.create({ data: { id, organization_id: c.org, name: `Shelf ${id.slice(0, 6)}`, type: 'warehouse' } });
        await db.stockBalance.create({ data: { organization_id: c.org, item_id: item, location_id: from, on_hand: 5, min: 4 } });
        return { item, from, to };
      };

      const stock = await shelf();
      const lowStock = await settledQueries(() => api.post('/api/inventory/transfer', { itemId: stock.item, fromId: stock.from, toId: stock.to, qty: 2 }));
      const backorderItem = randomUUID();
      await db.priceBookItem.create({ data: { id: backorderItem, organization_id: c.org, name: 'Closer', sku: `SKU-${backorderItem.slice(0, 8)}`, unit_price: 10 } });
      const backorder = await settledQueries(() => api.patch(`/api/price-book/items/${backorderItem}`, { status: 'on_backorder' }));
      const job = await fx.addJob(c.org, c.customer, { crew: [actor.id] });
      const po = await db.purchaseOrder.create({ data: { organization_id: c.org, po_number: `PO-${randomUUID().slice(0, 8)}`, vendor: 'Supply Co', status: 'ordered', job_id: job.id } });
      const poLine = await db.purchaseOrderLine.create({ data: { organization_id: c.org, purchase_order_id: po.id, item_sku: 'SKU', item_name: 'Hinge', uom: 'EA', qty_ordered: 4, qty_received: 0, price_book_item_id: stock.item } });
      const partial = await settledQueries(() => api.post('/api/inventory/purchase-orders/receive', { poId: po.id, destinationLocationId: stock.to, lines: [{ lineId: poLine.id, qtyReceived: 1 }] }));
      const stage = await db.jobStage.create({ data: { organization_id: c.org, job_id: job.id, job_number: 'J-1', customer: 'Customer', site: 'Site', trade: 'Locksmith', status: 'pending', staged_area: null } });
      const noArea = await settledQueries(() => api.patch(`/api/inventory/job-stages/${stage.id}`, { status: 'complete' }));

      const invitee = await fx.addUser(c.org, 'invitee', 'TECHNICIAN');
      // The person's one live invite, as an admin's invitation makes it.
      const inviteToken = await issueInviteToken(invitee);
      vi.mocked(supabaseAdmin.auth.admin.createUser).mockResolvedValue({ data: { user: { id: randomUUID() } }, error: null } as never);
      const app = (await import('../app.js')).default as never;
      const invite = await settledQueries(() => request(app).post('/api/auth/accept-invite').send({ token: inviteToken, password: 'sup3rsecret99', accepted_terms: true }));

      const { sendAccountNotices } = await import('../lib/payments-notifications.js');
      clearAllSwitchCaches();
      sent.length = 0;
      await sendAccountNotices([{ verb: 'billing.payments_paused', organizationId: c.org, dedup: `fanout:${randomUUID()}`, emailAdmins: false }], 'Acme Doors');
      const account = sent.length;

      // Ten stock crossings in ONE request read the company's holders once: ten alerts cost ten times the writes, never ten times the reads.
      const { runWithAttentionQueue, flushReviewAttention } = await import('../services/notifications/reviewAttentionQueue.js');
      const { queueNoRecordAlert } = await import('../services/notifications/noRecordAlerts.js');
      const raise = async (count: number) => {
        clearAllSwitchCaches();
        sent.length = 0;
        const { queue } = runWithAttentionQueue(() => {
          for (let i = 0; i < count; i += 1) {
            queueNoRecordAlert({
              verb: 'inventory.low_stock', organizationId: c.org, actorId: null,
              object: { type: 'INVENTORY_ITEM', id: randomUUID(), label: `Item ${i}` }, data: { item_name: `Item ${i}` }, dedupKey: `fanout-low:${randomUUID()}`,
            });
          }
        });
        flushReviewAttention(queue);
        await reviewAttentionSettled();
        return { total: sent.length, holderReads: sent.filter((q) => /FROM "public"\."users"[\s\S]*"is_active"/.test(q) && /"custom_role_id"/.test(q)).length };
      };
      const one = await raise(1);
      const ten = await raise(10);
      return { lowStock, backorder, partial, noArea, invite, account, one, ten };
    }

    const small = await noRecordCosts(20, 4);
    const large = await noRecordCosts(270, 90);

    for (const key of ['lowStock', 'backorder', 'partial', 'noArea', 'invite'] as const) {
      expect(Math.abs(large[key].settled - small[key].settled), `${key}: ${small[key].settled} vs ${large[key].settled}`).toBeLessThanOrEqual(3);
      // The alert is not on the request: its queries come after the answer.
      expect(large[key].settled - large[key].atResponse, `${key}: alert queries after the response`).toBeGreaterThan(0);
      // A few dozen reads an alert at the most, never one per person.
      expect(large[key].settled - large[key].atResponse, key).toBeLessThan(40);
    }
    expect(Math.abs(large.account - small.account), `account: ${small.account} vs ${large.account}`).toBeLessThanOrEqual(3);
    expect(large.account).toBeLessThan(40);
    expect(Math.abs(large.one.total - small.one.total), 'one crossing').toBeLessThanOrEqual(3);
    expect(Math.abs(large.ten.total - small.ten.total), 'ten crossings').toBeLessThanOrEqual(3);
    expect(large.ten.holderReads, 'the company\'s people are read once for ten alerts').toBe(large.one.holderReads);
    console.log(`[S06.29 query counts] small/large, at response -> settled: low stock ${small.lowStock.atResponse}->${small.lowStock.settled}/${large.lowStock.atResponse}->${large.lowStock.settled}; backorder ${small.backorder.atResponse}->${small.backorder.settled}/${large.backorder.atResponse}->${large.backorder.settled}; po partial ${small.partial.atResponse}->${small.partial.settled}/${large.partial.atResponse}->${large.partial.settled}; no area ${small.noArea.atResponse}->${small.noArea.settled}/${large.noArea.atResponse}->${large.noArea.settled}; invite ${small.invite.atResponse}->${small.invite.settled}/${large.invite.atResponse}->${large.invite.settled}; payments account ${small.account}/${large.account}; one crossing ${small.one.total}/${large.one.total}; ten crossings ${small.ten.total}/${large.ten.total} (people read ${large.ten.holderReads} time(s))`);
  }, 300_000);

  /**
   * S07.9: a logistic order submitted goes through the same writer after the response, so a bigger company must not cost more
   * queries. The submit only queues the alert (the request gains no query, and writes no alert row); the holders of Approve
   * logistic orders are read once and their reach to the order in a batch. Measured with one Approve holder in the company,
   * 20 people against 270.
   */
  it('sends the order submitted alert in the same number of queries for a company of 20 as for one of 270, all of them after the response', async () => {
    async function submitCosts(people: number, dispatchers: number) {
      const c = await company(people, dispatchers);
      stageOrgs.push(c.org);
      const key = `order-approver-${c.org.slice(0, 6)}`;
      const role = await fx.addCustomRole(c.org, key, 'DISPATCHER');
      await setRoleSwitchValues({
        organizationId: c.org, roleKey: key,
        values: { approve_logistic_orders: true, view_logistic_orders: true, view_jobs: true, view_leads: true, jobs_scope: 'all', leads_scope: 'all' },
        actorId: null, reason: 'manual',
      });
      const approver = await fx.addUser(c.org, 'approver', 'DISPATCHER', { customRoleId: role.id });
      const api = await fx.signedInAs(c.admin);
      const job = await fx.addJob(c.org, c.customer, { crew: [c.crew.id] });
      const item = randomUUID();
      const location = randomUUID();
      await db.priceBookItem.create({ data: { id: item, organization_id: c.org, name: `Hinge ${item.slice(0, 6)}`, sku: `SKU-${item.slice(0, 8)}`, unit_price: 10, track_inventory: true } });
      await db.inventoryLocation.create({ data: { id: location, organization_id: c.org, name: `Shelf ${location.slice(0, 6)}`, type: 'warehouse' } });
      await db.stockBalance.create({ data: { organization_id: c.org, item_id: item, location_id: location, on_hand: 100 } });
      const created = await api.post('/api/logistic-orders', { job_id: job.id, lines: [{ item_id: item, qty: 1, from_location_id: location }] });
      expect(created.status, JSON.stringify(created.body)).toBe(201);

      clearAllSwitchCaches();
      sent.length = 0;
      const res = await api.post(`/api/logistic-orders/${created.body.id}/submit`);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      const atResponse = sent.length;
      const onTheRequest = sent.slice(0, atResponse);
      await reviewAttentionSettled();
      const told = await db.notificationRecipient.findMany({ where: { organization_id: c.org, notification: { verb: 'lo.submitted', object_id: created.body.id } }, select: { recipient_id: true } });
      return { atResponse, settled: sent.length, onTheRequest, told: told.map((r) => r.recipient_id), approver: approver.id };
    }

    const small = await submitCosts(20, 4);
    const large = await submitCosts(270, 90);

    for (const run of [small, large]) expect(run.told, 'the Approve holder is told, the submitting Admin is not').toEqual([run.approver]);
    // The request gains no alert query of its own: no alert row is written before the answer, and the answer costs the same in both.
    for (const run of [small, large]) expect(run.onTheRequest.filter((q) => /INSERT INTO "public"."notifications"/.test(q))).toEqual([]);
    expect(Math.abs(large.atResponse - small.atResponse), `at response: ${small.atResponse} vs ${large.atResponse}`).toBeLessThanOrEqual(1);
    expect(Math.abs(large.settled - small.settled), `settled: ${small.settled} vs ${large.settled}`).toBeLessThanOrEqual(3);
    expect(large.settled - large.atResponse, 'alert queries after the response').toBeGreaterThan(0);
    expect(large.settled - large.atResponse, 'a few dozen reads at the most, never one per person').toBeLessThan(40);
    console.log(`[S07.9 query counts] small/large, at response -> settled: order submitted ${small.atResponse}->${small.settled}/${large.atResponse}->${large.settled}`);
  }, 300_000);

  /**
   * S08.21: a missed call, an inbound text and an inbound email are judged by the single read of the conversation, for every
   * recipient together. The statements one alert sends must not grow with the company. The company's Dispatchers (4 against
   * 90) are the recipients; the conversations sit on the main line (a number lookup), on a job (the cohort look at a record) and
   * in the main mailbox (its readers), so every kind of read the filter can make is made.
   */
  it('sends the call, text and email alerts in the same number of queries for a company of 20 as for one of 270', async () => {
    const { emit } = await import('../services/notifications/notificationService.js');
    const { alertEmailReply } = await import('../services/notifications/emailReplyAlerts.js');
    async function communicationCosts(people: number, dispatchers: number) {
      const c = await company(people, dispatchers);
      const main = randomUUID();
      await db.phoneNumber.create({ data: { id: main, organization_id: c.org, e164: `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`, label: 'run-main', is_org_default: true, status: 'active' } });
      const job = await fx.addJob(c.org, c.customer, { crew: [c.crew.id] });
      const call = randomUUID();
      await db.callSession.create({
        data: {
          id: call, organization_id: c.org, direction: 'in', from_number: '+15555550100', to_number: '+15555550199', status: 'missed',
          answered_by: {}, started_at: new Date(), phone_number_id: main, job_id: job.id,
        },
      });
      const thread = randomUUID();
      await db.messageThread.create({ data: { id: thread, organization_id: c.org, campaign_type: 'none', customer_id: c.customer } });
      // An outbound text the crew member sent from the main line first, so the reply is attributed to them (S08.23): the text alert's
      // one extra read of the conversation is made, and its answer is one more person told.
      await db.message.create({
        data: { id: randomUUID(), organization_id: c.org, thread_id: thread, direction: 'out', body: 'run-reply-to-this', ts: new Date(Date.now() - 60_000), phone_number_id: main, sent_by_user_id: c.crew.id },
      });
      const inbound = randomUUID();
      await db.message.create({
        data: { id: inbound, organization_id: c.org, thread_id: thread, direction: 'in', body: 'run-text', ts: new Date(), phone_number_id: main, job_id: job.id },
      });
      // A customer's reply in two record conversations in the main mailbox (S10.10): one about the job the crew member is on (lane 1 is
      // rung, the Admin box is a copy) and one about a job nobody is on (lane 1 finds nobody, so the fallback's second look is made).
      const mailbox = randomUUID();
      await db.mailbox.create({ data: { id: mailbox, organization_id: c.org, kind: 'main', status: 'active' } });
      const emptyJob = await fx.addJob(c.org, c.customer, {});
      const replyIn = async (jobId: string) => {
        const emailThread = randomUUID();
        const emailId = randomUUID();
        await db.emailThread.create({ data: { id: emailThread, organization_id: c.org, mailbox_id: mailbox, origin: 'record', record_type: 'job', record_id: jobId } });
        await db.email.create({
          data: {
            id: emailId, organization_id: c.org, thread_id: emailThread, customer_id: c.customer, account: 'user', direction: 'in', folder: 'inbox',
            from: { name: null, email: 'customer@example.com' }, to: 'office@example.com', subject: 'run-email', snippet: 's', body: ['b'], at: '1:00 PM', ts: BigInt(Date.now()),
          },
        });
        return { threadId: emailThread, emailId };
      };
      const crewThread = await replyIn(job.id);
      const fallbackThread = await replyIn(emptyJob.id);
      const emailCost = async ({ threadId, emailId }: { threadId: string; emailId: string }) => {
        clearAllSwitchCaches();
        sent.length = 0;
        const told = await alertEmailReply({ organizationId: c.org, threadId, emailId, providerMessageId: `fanout-comm:${randomUUID()}`, senderLabel: 'Caller', subject: 'run-email' });
        await flushRealtimePublishes();
        return { statements: sent.length, told: told.length };
      };
      const cost = async (verb: string, object: { type: string; id: string }, data: Record<string, unknown>, entity: Record<string, unknown> = {}) => {
        clearAllSwitchCaches();
        sent.length = 0;
        const told = await emit({ verb, organizationId: c.org, actorId: null, object: { ...object, label: 'Caller' }, entity, data, dedupKey: `fanout-comm:${randomUUID()}` });
        await flushRealtimePublishes();
        return { statements: sent.length, told: told.length };
      };
      return {
        call: await cost('communication.call_missed', { type: 'CALL', id: call }, { call_status: 'missed' }),
        text: await cost('communication.sms_inbound', { type: 'MESSAGE_THREAD', id: thread }, { preview: 'hello' }, { message_id: inbound }),
        email: await emailCost(crewThread),
        emailFallback: await emailCost(fallbackThread),
      };
    }

    const small = await communicationCosts(20, 4);
    const large = await communicationCosts(270, 90);

    for (const kind of ['call', 'text', 'email', 'emailFallback'] as const) {
      // The Admin box is kept for every kind, so the alert is real work in both companies. The missed call is told by the record's
      // people, All and the main line's fallback (S08.22): the Dispatchers here are covered by the fallback, whose preset is on.
      expect(small[kind].told, `${kind}: someone is told in the small company`).toBeGreaterThan(0);
      expect(large[kind].told, `${kind}: someone is told in the large company`).toBeGreaterThan(0);
      expect(Math.abs(large[kind].statements - small[kind].statements), `${kind}: ${small[kind].statements} vs ${large[kind].statements}`).toBeLessThanOrEqual(3);
      expect(large[kind].statements, `${kind}: a few dozen reads at the most, never one per person`).toBeLessThan(40);
    }
    // The main line's fallback covers every Dispatcher (no number of their own, the switch on), however many there are: the Admin box
    // (All) and each Dispatcher are told, one alert for the lot. The inbound text (S08.23) is told by the same lookup, plus the crew
    // member its reply is attributed to.
    expect(small.call.told, 'call: the Admin and the 4 Dispatchers').toBeGreaterThanOrEqual(5);
    expect(large.call.told, 'call: the Admin and the 90 Dispatchers').toBeGreaterThanOrEqual(91);
    expect(small.text.told, 'text: the Admin, the 4 Dispatchers and the crew member').toBeGreaterThanOrEqual(6);
    expect(large.text.told, 'text: the Admin, the 90 Dispatchers and the crew member').toBeGreaterThanOrEqual(92);
    console.log(`[S08.21/S08.22/S08.23 query counts] small/large statements per alert: call ${small.call.statements}/${large.call.statements}, text ${small.text.statements}/${large.text.statements}, email ${small.email.statements}/${large.email.statements}, email fallback ${small.emailFallback.statements}/${large.emailFallback.statements}`);
  }, 300_000);

  /**
   * S08.24: a missed call and an inbound text on a number nobody is linked to, with nobody on All, go to the company's Admins (the
   * never-silent fallback; the holders of Manage roles and permissions until AL-18). The statements one alert sends must not grow with
   * the company: the lookup that finds nobody, the Admins, the company's zone and one look at who can read.
   */
  it('sends the never-silent fallback of a call and a text in the same number of queries for a company of 20 as for one of 270', async () => {
    const { emit } = await import('../services/notifications/notificationService.js');
    async function fallbackCosts(people: number, managers: number) {
      const c = await company(people, managers);
      // Nobody on All: the Admin box is out, and no one else holds Communication scope All.
      await db.user.update({ where: { id: c.admin.id }, data: { is_active: false } });
      const holders = (key: string, jobsScope: 'all' | 'attached') => fx.addCustomRole(c.org, key, 'TECHNICIAN').then(async (role) => {
        await setRoleSwitchValues({
          organizationId: c.org, roleKey: key, actorId: null, reason: 'manual',
          values: {
            view_users: true, view_jobs: true, jobs_scope: jobsScope, access_communication: true,
            view_communication: true, communication_scope: 'attached', see_main_line_when_no_number: false,
          },
        });
        return role;
      });
      const readers = await holders('fanout-readers', 'all');
      const others = await holders('fanout-others', 'attached');
      const ids = c.dispatchers.map((d) => d.id);
      // The managers are Admins (the flag) on custom roles: half see the job company-wide, half only what they are attached to.
      await db.user.updateMany({ where: { id: { in: ids.slice(0, Math.ceil(ids.length / 2)) } }, data: { custom_role_id: readers.id, is_admin: true } });
      await db.user.updateMany({ where: { id: { in: ids.slice(Math.ceil(ids.length / 2)) } }, data: { custom_role_id: others.id, is_admin: true } });
      clearAllSwitchCaches();

      const number = randomUUID();
      await db.phoneNumber.create({ data: { id: number, organization_id: c.org, e164: `+1555${Math.floor(Math.random() * 9_000_000 + 1_000_000)}`, label: 'run-other', status: 'active' } });
      const job = await fx.addJob(c.org, c.customer, {});
      const call = randomUUID();
      await db.callSession.create({
        data: { id: call, organization_id: c.org, direction: 'in', from_number: '+15555550100', to_number: '+15555550199', status: 'missed', answered_by: {}, started_at: new Date(), phone_number_id: number, job_id: job.id },
      });
      const thread = randomUUID();
      await db.messageThread.create({ data: { id: thread, organization_id: c.org, campaign_type: 'none', customer_id: c.customer } });
      const inbound = randomUUID();
      await db.message.create({
        data: { id: inbound, organization_id: c.org, thread_id: thread, direction: 'in', body: 'run-text', ts: new Date(), phone_number_id: number, job_id: job.id },
      });
      const cost = async (verb: string, object: { type: string; id: string }, data: Record<string, unknown>, entity: Record<string, unknown> = {}) => {
        clearAllSwitchCaches();
        sent.length = 0;
        const told = await emit({ verb, organizationId: c.org, actorId: null, object: { ...object, label: 'Caller' }, entity, data, dedupKey: `fanout-fallback:${randomUUID()}` });
        await flushRealtimePublishes();
        return { statements: sent.length, told: told.length };
      };
      return {
        managers: ids.length,
        call: await cost('communication.call_missed', { type: 'CALL', id: call }, { call_status: 'missed', customer_name: 'Pat Payer' }),
        text: await cost('communication.sms_inbound', { type: 'MESSAGE_THREAD', id: thread }, { preview: 'hello' }, { message_id: inbound }),
      };
    }

    const small = await fallbackCosts(20, 4);
    const large = await fallbackCosts(270, 90);

    for (const kind of ['call', 'text'] as const) {
      // Every manager is told, however many there are.
      expect(small[kind].told, `${kind}: every manager of the small company`).toBe(small.managers);
      expect(large[kind].told, `${kind}: every manager of the large company`).toBe(large.managers);
      expect(Math.abs(large[kind].statements - small[kind].statements), `${kind}: ${small[kind].statements} vs ${large[kind].statements}`).toBeLessThanOrEqual(3);
      expect(large[kind].statements, `${kind}: a few dozen reads at the most, never one per person`).toBeLessThan(60);
    }
    console.log(`[S08.24 query counts] small/large statements per never-silent fallback (both alerts): call ${small.call.statements}/${large.call.statements}, text ${small.text.statements}/${large.text.statements}`);
  }, 300_000);

  it('pings the live channels of many recipients in one batched request, each exactly once', async () => {
    const c = await company(80, 60);
    const api = await fx.signedInAs(c.admin);
    const done = await fx.addJob(c.org, c.customer, { status: 'DONE', crew: [c.crew.id] });
    await flushRealtimePublishes();
    pings.count = 0;
    pings.requests = 0;
    pings.topics = [];

    expect((await api.post(`/api/jobs/${done.id}/reopen`)).status).toBe(200);
    // The alert is sent after the response.
    await reviewAttentionSettled();
    await flushRealtimePublishes();

    expect(pings.count).toBe(61);
    expect(new Set(pings.topics).size).toBe(61);
    expect(pings.requests).toBe(1);
  }, 60_000);

  it('answers Complete and Reopen without waiting for the pings, and still pings every recipient exactly once afterwards', async () => {
    const c = await company(270, 90);
    const api = await fx.signedInAs(c.admin);
    const job = await fx.addJob(c.org, c.customer, { status: 'IN_PROGRESS', crew: [c.crew.id], soldBy: c.crew.id });
    const done = await fx.addJob(c.org, c.customer, { status: 'DONE', crew: [c.crew.id] });
    await api.get(`/api/jobs/${job.id}`);
    await flushRealtimePublishes();
    // 100 ms a ping, 20 at once: pinging 90-odd people takes half a second, Complete's two alerts a second. None of it belongs in the answer.
    pings.delayMs = 100;
    try {
      for (const [name, path, body] of [
        ['reopen', `/api/jobs/${done.id}/reopen`, undefined],
        ['complete', `/api/jobs/${job.id}/complete`, { cancel_open_visits: true }],
      ] as const) {
        pings.count = 0;
        pings.topics = [];
        const started = new Date();
        const res = await api.post(path, body);
        const answeredAfter = Date.now() - started.getTime();
        expect(res.status, JSON.stringify(res.body)).toBe(200);

        // Reopen's alert is sent after the answer (S06.25), so it is waited for here; Complete still writes its first alert on the request.
        if (name === 'reopen') await reviewAttentionSettled();
        // Every alert row is there, and (for Complete) its ping is still on its way.
        const rows = await db.notificationRecipient.findMany({
          where: { organization_id: c.org, notification: { created_at: { gte: started } } },
          select: { recipient_id: true },
        });
        expect(rows.length, `${name}: alert rows written`).toBeGreaterThan(50);
        if (name === 'complete') {
          expect(pings.count, `${name}: pings still outstanding when the answer comes (answered after ${answeredAfter} ms)`).toBeLessThan(rows.length);
        }

        await flushRealtimePublishes();
        const owed = new Map<string, number>();
        for (const r of rows) owed.set(r.recipient_id, (owed.get(r.recipient_id) ?? 0) + 1);
        const sent = new Map<string, number>();
        for (const t of pings.topics) sent.set(t.split(':user:')[1]!, (sent.get(t.split(':user:')[1]!) ?? 0) + 1);
        expect(sent, `${name}: every recipient pinged once per alert, afterwards`).toEqual(owed);
      }
    } finally {
      pings.delayMs = 5;
    }
  }, 120_000);

  /**
   * Scenario pass 2, third timing re-check: pings started while the handler was still reading competed with it for the one
   * thread, so the answer waited as long as if they had been awaited. They go out only after the response has been written.
   */
  it('writes the response of Complete and Reopen before the first ping request starts', async () => {
    const { ServerResponse } = await import('node:http');
    const c = await company(270, 90);
    const api = await fx.signedInAs(c.admin);
    const job = await fx.addJob(c.org, c.customer, { status: 'IN_PROGRESS', crew: [c.crew.id], soldBy: c.crew.id });
    const done = await fx.addJob(c.org, c.customer, { status: 'DONE', crew: [c.crew.id] });
    await api.get(`/api/jobs/${job.id}`);
    await flushRealtimePublishes();

    const originalEmit = ServerResponse.prototype.emit;
    const watch = vi.spyOn(ServerResponse.prototype, 'emit').mockImplementation(function (this: InstanceType<typeof ServerResponse>, event: string | symbol, ...args: unknown[]) {
      if (event === 'finish' && this.req?.method === 'POST') pings.order.push(`finish ${(this.req as { originalUrl?: string }).originalUrl}`);
      return originalEmit.call(this, event, ...args);
    } as never);
    // The tail of the handler (the job detail it answers with) takes longer than a ping raised outside a request waits to start.
    const originalJson = express.response.json;
    const slowTail = vi.spyOn(express.response, 'json').mockImplementation(function (this: express.Response, payload: unknown) {
      setTimeout(() => originalJson.call(this, payload), 600);
      return this;
    } as never);
    try {
      for (const [path, body] of [
        [`/api/jobs/${done.id}/reopen`, undefined],
        [`/api/jobs/${job.id}/complete`, { cancel_open_visits: true }],
      ] as const) {
        pings.order = [];
        pings.count = 0;
        pings.requests = 0;
        expect((await api.post(path, body)).status).toBe(200);
        // Not flushed: the pings must start by themselves, and only after the answer has gone out.
        await vi.waitFor(() => expect(pings.requests, `${path}: pings sent`).toBeGreaterThan(0), { timeout: 5_000 });
        const finished = pings.order.indexOf(`finish ${path}`);
        expect(finished, `${path}: the response finished`).toBeGreaterThanOrEqual(0);
        expect(finished, `${path}: the response finished before the first ping request (${JSON.stringify(pings.order)})`).toBeLessThan(pings.order.indexOf('ping request'));
        await flushRealtimePublishes();
        expect(pings.count, `${path}: every recipient pinged`).toBeGreaterThan(50);
      }
    } finally {
      watch.mockRestore();
      slowTail.mockRestore();
    }
  }, 120_000);

  it('tells a task\'s assignees with the same number of queries for 10, 30 and 60 of them, and pings each once afterwards', async () => {
    const { emitTaskNotification } = await import('../lib/tasks/notify.js');
    const queriesFor: Record<number, number> = {};
    for (const assignees of [10, 30, 60]) {
      const c = await company(assignees + 2, 0);
      const ids = (await db.user.findMany({ where: { organization_id: c.org, role: 'SALES' }, select: { id: true } })).map((u) => u.id);
      expect(ids).toHaveLength(assignees);
      await flushRealtimePublishes();
      pings.count = 0;
      pings.topics = [];
      clearAllSwitchCaches();
      sent.length = 0;

      await emitTaskNotification({ orgId: c.org, actorId: c.admin.id }, 'task.assigned', { id: randomUUID(), title: 'Walk the site', task_number: 'TK-1' }, { added_assignee_ids: ids });
      queriesFor[assignees] = sent.length;
      await flushRealtimePublishes();

      expect(pings.topics.map((t) => t.split(':user:')[1]!).sort(), `${assignees} assignees pinged once each`).toEqual([...ids].sort());
    }
    // The alert writer asks the database a fixed number of questions however many people are named; the pings are not one of them.
    expect(queriesFor[60], JSON.stringify(queriesFor)).toBe(queriesFor[10]);
    expect(queriesFor[60]!, JSON.stringify(queriesFor)).toBeLessThan(10);
  }, 120_000);

  describe('the recipient filter keeps the same people as asking each one alone', () => {
    it('keeps someone whose scope reaches the job and drops someone whose does not, with no read per person', async () => {
      const { filterRecipientsByAccess } = await import('../services/notifications/filterByAccess.js');
      const { canAccessRow } = await import('../lib/permissions/enforce.js');
      const { abilityForUser } = await import('../lib/permissions/enforce.js');
      const { org, customer, admin } = await fx.newOrg();
      const values = (jobsScope: string) => {
        const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
        return { ...allOff, view_jobs: true, jobs_scope: jobsScope };
      };
      await fx.addCustomRole(org, 'attached-only', 'TECHNICIAN');
      await setRoleSwitchValues({ organizationId: org, roleKey: 'attached-only', values: values('attached'), actorId: null, reason: 'manual' });
      await fx.addCustomRole(org, 'sees-all', 'TECHNICIAN');
      await setRoleSwitchValues({ organizationId: org, roleKey: 'sees-all', values: values('all'), actorId: null, reason: 'manual' });
      const roleOf = async (key: string) => (await db.customRole.findFirstOrThrow({ where: { organization_id: org, key } })).id;

      const onJob = await fx.addUser(org, 'onjob', 'TECHNICIAN', { customRoleId: await roleOf('attached-only') });
      const otherA = await fx.addUser(org, 'other-a', 'TECHNICIAN', { customRoleId: await roleOf('attached-only') });
      const otherB = await fx.addUser(org, 'other-b', 'TECHNICIAN', { customRoleId: await roleOf('attached-only') });
      const seesAll = await fx.addUser(org, 'seesall', 'TECHNICIAN', { customRoleId: await roleOf('sees-all') });
      const dispatcher = await fx.addUser(org, 'disp', 'DISPATCHER');
      const stranger = (await fx.newOrg()).admin;
      const job = await fx.addJob(org, customer, { status: 'SCHEDULED', crew: [onJob.id] });

      const everyone = [onJob, otherA, otherB, seesAll, dispatcher, admin, stranger, { id: randomUUID() }].map((p) => p.id);
      clearAllSwitchCaches();
      sent.length = 0;
      const kept = await filterRecipientsByAccess('JOB', job.id, everyone, org);
      const queries = sent.length;

      // The answer asking each person alone gives (the way a request from that person is judged).
      const alone: string[] = [];
      for (const id of everyone) {
        const user = await db.user.findFirst({
          where: { id, organization_id: org },
          select: { id: true, role: true, is_admin: true, organization_id: true, department_id: true, location_id: true, custom_role_id: true, custom_role: { select: { key: true } } },
        });
        if (!user) continue;
        const ability = await abilityForUser(user);
        if (await canAccessRow({ user, ability } as never, 'Job', db.job as never, job.id)) alone.push(id);
      }

      expect(kept).toEqual(alone);
      expect(new Set(kept)).toEqual(new Set([onJob.id, seesAll.id, dispatcher.id, admin.id]));
      expect(queries, 'reads for eight people').toBeLessThan(15);
    }, 60_000);
  });
});
