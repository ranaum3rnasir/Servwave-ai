/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.12 - a service plan visit job copies the plan's "Sold by".

   Scheduling a plan visit creates a job (made by the system, no creator). Its Sold By is the plan's seller
   when that person is still active and may be Sold By (slot eligibility), and empty otherwise. Its
   Dispatcher starts empty. The copy is written on the job's history as copied from the plan. The seller can
   open each visit job with Attached scope and gets its started and cancelled alerts, and the visit job does
   not count as a sale for its Sold By.

   Every case uses people on custom roles whose base role and the owner switch disagree (a Technician base
   with Can own leads / be Sold By on, a Dispatcher base with it off), so no role-name or base-role check can
   pass. Everything goes through the service plan, job and notification boundaries. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
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

// The suite-wide setup hands every record the same number; these cases create several jobs in one company.
vi.mock('../lib/numbering', () => {
  let issued = 0;
  return {
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}T${Date.now()}${++issued}`),
  };
});

// The alerts are the notification service's boundary: what a job's start and cancel hand it is what is checked.
vi.mock('../services/notifications/notificationService', () => ({ emit: vi.fn().mockResolvedValue(undefined) }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { emit } from '../services/notifications/notificationService';
import { reviewAttentionSettled } from '../services/notifications/reviewAttentionQueue';

const suite = realClient ? describe : describe.skip;

suite('a service plan visit job copies the plan Sold by (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);

  const planOrgs: string[] = [];
  afterAll(async () => {
    // Service plans are not part of the shared fixture's cleanup, and they pin their customer.
    for (const org of planOrgs) {
      await db.job.deleteMany({ where: { organization_id: org } }).catch(() => undefined);
      await db.servicePlan.deleteMany({ where: { organization_id: org } }).catch(() => undefined);
    }
    await fx.cleanup();
  });

  let sequence = 0;

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(
    org: string,
    values: Record<string, boolean | string>,
    base: Role,
    opts: { active?: boolean } = {},
  ): Promise<Person & { roleKey: string }> {
    const key = `plan-seller-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({
      organizationId: org, roleKey: key, values: { leads_scope: 'all', jobs_scope: 'all', view_jobs: true, ...values }, actorId: null, reason: 'manual',
    });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    if (opts.active === false) await db.user.update({ where: { id: person.id }, data: { is_active: false } });
    return Object.assign(person, { roleKey: key });
  }

  /** Each visit gets its own day, so one booking never collides with another's. */
  let dayOffset = 20;
  const nextWindow = () => {
    const start = new Date(Date.now() + ++dayOffset * 86_400_000);
    return { scheduled_start: start.toISOString(), scheduled_end: new Date(start.getTime() + 3_600_000).toISOString() };
  };

  /** A plan sold by `seller`, scheduled through the route by the company's admin; answers the new job's id. */
  async function scheduleVisitFor(setup: Awaited<ReturnType<typeof fx.newOrg>>, seller: string | null) {
    planOrgs.push(setup.org);
    const plan = await fx.addServicePlan(setup.org, setup.customer, { soldBy: seller ?? undefined });
    const api = await fx.signedInAs(setup.admin);
    const res = await api.post(`/api/service-plans/${plan.id}/schedule-visit`, nextWindow());
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return { jobId: res.body.job.id as string, plan, api };
  }

  const soldByOf = async (jobId: string) => (await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { salesperson_id: true } })).salesperson_id;

  it('takes the plan seller as Sold By when they are active and may be Sold By, whatever their role is based on', async () => {
    const setup = await fx.newOrg();
    const technicianWhoCan = await personWith(setup.org, { can_own_leads: true }, 'TECHNICIAN');

    const { jobId } = await scheduleVisitFor(setup, technicianWhoCan.id);

    expect(await soldByOf(jobId)).toBe(technicianWhoCan.id);
  });

  it('leaves Sold By empty when the plan seller cannot be Sold By, even on a Dispatcher base', async () => {
    const setup = await fx.newOrg();
    const dispatcherWhoCannot = await personWith(setup.org, { can_own_leads: false }, 'DISPATCHER');

    const { jobId } = await scheduleVisitFor(setup, dispatcherWhoCannot.id);

    expect(await soldByOf(jobId)).toBeNull();
  });

  it('leaves Sold By empty when the plan seller is inactive', async () => {
    const setup = await fx.newOrg();
    const inactive = await personWith(setup.org, { can_own_leads: true }, 'TECHNICIAN', { active: false });

    const { jobId } = await scheduleVisitFor(setup, inactive.id);

    expect(await soldByOf(jobId)).toBeNull();
  });

  it('leaves Sold By empty for a plan with no seller', async () => {
    const setup = await fx.newOrg();

    const { jobId } = await scheduleVisitFor(setup, null);

    expect(await soldByOf(jobId)).toBeNull();
  });

  it('starts the visit job with no Dispatcher', async () => {
    const setup = await fx.newOrg();
    const seller = await personWith(setup.org, { can_own_leads: true }, 'SALES');

    const { jobId } = await scheduleVisitFor(setup, seller.id);

    const job = await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { dispatcher_id: true } });
    expect(job.dispatcher_id).toBeNull();
  });

  it('writes the copy on the job history as copied from the plan, and nothing when nothing was copied', async () => {
    const setup = await fx.newOrg();
    const seller = await personWith(setup.org, { can_own_leads: true }, 'SALES');
    const cannot = await personWith(setup.org, { can_own_leads: false }, 'SALES');

    const copied = await scheduleVisitFor(setup, seller.id);
    const notCopied = await scheduleVisitFor(setup, cannot.id);

    const events = (jobId: string) => db.timelineEvent.findMany({ where: { entity_type: 'JOB', entity_id: jobId, event_type: 'SOLD_BY_CHANGED' } });
    const [event] = await events(copied.jobId);
    expect(event?.description).toContain('copied from service plan');
    expect(event?.description).toContain(`SP-${copied.plan.id.slice(0, 8)}`);
    expect(event?.metadata).toMatchObject({ from: null, to: seller.id, source: 'service_plan' });
    expect(await events(notCopied.jobId)).toHaveLength(0);
  });

  it('lets the seller open the visit job with Attached scope', async () => {
    const setup = await fx.newOrg();
    const attachedSeller = await personWith(setup.org, { can_own_leads: true, jobs_scope: 'attached' }, 'TECHNICIAN');
    const other = await personWith(setup.org, { can_own_leads: true, jobs_scope: 'attached' }, 'TECHNICIAN');

    const { jobId } = await scheduleVisitFor(setup, attachedSeller.id);

    const sellerOpens = await (await fx.signedInAs(attachedSeller)).get(`/api/jobs/${jobId}`);
    const otherOpens = await (await fx.signedInAs(other)).get(`/api/jobs/${jobId}`);
    expect(sellerOpens.status).toBe(200);
    expect(otherOpens.status).not.toBe(200);
  });

  it('hands the seller to the started and cancelled alerts of the visit job', async () => {
    const setup = await fx.newOrg();
    const seller = await personWith(setup.org, { can_own_leads: true }, 'SALES');
    const started = await scheduleVisitFor(setup, seller.id);
    const cancelled = await scheduleVisitFor(setup, seller.id);

    vi.mocked(emit).mockClear();
    expect((await started.api.post(`/api/jobs/${started.jobId}/start`, {})).status).toBe(200);
    expect((await cancelled.api.post(`/api/jobs/${cancelled.jobId}/cancel`, { cancel_reason_code: 'OTHER', cancelled_reason: 'Customer asked to move it' })).status).toBe(200);

    // The alerts go through the chain after the response; the seller is in lane 1 of each, the visit job having no Dispatcher.
    await reviewAttentionSettled();
    const sentFor = (verb: string, jobId: string) => vi.mocked(emit).mock.calls.map(([e]) => e).find((e) => e.verb === verb && e.object.id === jobId);
    expect(sentFor('job.started', started.jobId)?.entity?.lane_one_ids).toContain(seller.id);
    expect(sentFor('job.cancelled', cancelled.jobId)?.entity?.lane_one_ids).toContain(seller.id);
  });

  it('does not count the visit job as a sale for its Sold By', async () => {
    const setup = await fx.newOrg();
    const seller = await personWith(setup.org, { can_own_leads: true }, 'SALES');
    const { jobId } = await scheduleVisitFor(setup, seller.id);
    const fromLead = await fx.addJob(setup.org, setup.customer, { soldBy: seller.id });
    const { jobCountsAsSale } = await import('../lib/jobSale.js');

    const visitJob = await db.job.findUniqueOrThrow({ where: { id: jobId }, select: { source_plan_id: true } });
    const leadJob = await db.job.findUniqueOrThrow({ where: { id: fromLead.id }, select: { source_plan_id: true } });

    expect(jobCountsAsSale(visitJob)).toBe(false);
    expect(jobCountsAsSale(leadJob)).toBe(true);
  });
});
