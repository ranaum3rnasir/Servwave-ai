/* =============================================================================
   Roles & Permissions, PRD 4, slice S04.21 - convert a lead to a job without landing on a refused page.

   Converting a lead needs Create jobs AND a lead the person can open (Leads scope). Whether the person may then
   open the new job is its own question, answered from the job as it now stands (Jobs scope: crew, Sold By,
   Dispatcher). The conversion answer says which, so the page can stay on the lead and say the job was created
   instead of walking into a page the server refuses. A person who cannot open the job gets back its id and
   number and nothing else of it.

   Every person here holds a custom role built from switches (the base role chosen to disagree with the switch
   where it matters), so a role-name check cannot pass. Everything goes through the job and lead routes. Real
   migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed
   again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
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

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('converting a lead to a job: who may, and whether they may open the result (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  type Who = Person & { api: () => Promise<Api> };
  let sequence = 0;

  /** A person on a fresh custom role of this base holding exactly these switch values. */
  async function personWith(org: string, values: Record<string, boolean | string>, base: Role = 'TECHNICIAN'): Promise<Who> {
    const key = `convert-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  /** Someone who can see and create jobs, with the two scopes given. */
  const converter = (
    org: string,
    opts: { leads: 'attached' | 'all'; jobs: 'attached' | 'all'; createJobs?: boolean; canOwn?: boolean },
  ) =>
    personWith(org, {
      view_leads: true,
      leads_scope: opts.leads,
      view_jobs: true,
      jobs_scope: opts.jobs,
      create_jobs: opts.createJobs ?? true,
      view_estimates: true,
      can_own_leads: opts.canOwn ?? false,
      assign_people_to_jobs: false,
    });

  /** A lead with its people and `estimates` WON estimates on it, ready to convert. */
  async function leadToConvert(
    org: string,
    customer: string,
    adminId: string,
    people: { owner?: string; walkthroughCrew?: string[] },
    estimates = 1,
  ) {
    const location = randomUUID();
    await db.serviceLocation.create({
      data: { id: location, customer_id: customer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' },
    });
    const lead = await fx.addLead(org, customer, {
      owner: people.owner, assignees: people.owner ? [people.owner] : [], walkthroughCrew: people.walkthroughCrew,
    });
    const estimateIds: string[] = [];
    for (let i = 0; i < estimates; i++) {
      const estimate = await fx.addEstimate(org, customer, adminId, { leadId: lead.id });
      await db.estimate.update({ where: { id: estimate.id }, data: { status: 'WON' } });
      estimateIds.push(estimate.id);
    }
    return { lead: lead.id, estimateIds, location };
  }

  type Conversion = Awaited<ReturnType<typeof leadToConvert>>;

  /** Convert the way the Convert dialog does: one id for one estimate, a list for several. */
  const convert = (api: Api, c: Conversion) =>
    api.post(
      '/api/jobs',
      c.estimateIds.length === 1
        ? { estimate_id: c.estimateIds[0], service_location_id: c.location }
        : { estimate_ids: c.estimateIds, service_location_id: c.location },
    );

  /** How many jobs the conversion made: the estimates are attached to one job, or to none. */
  async function jobsFor(c: Conversion) {
    const rows = await db.estimate.findMany({ where: { id: { in: c.estimateIds } }, select: { job_id: true } });
    return new Set(rows.map((r) => r.job_id).filter((id) => id !== null)).size;
  }

  const sources = [
    ['a single estimate', 1],
    ['several estimates', 2],
  ] as const;

  describe.each(sources)('converting %s', (_label, estimates) => {
    it('succeeds for a person with Create jobs on a lead they can open, and refuses without Create jobs', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const withIt = await converter(org, { leads: 'attached', jobs: 'all' });
      const without = await converter(org, { leads: 'attached', jobs: 'all', createJobs: false });
      const c = await leadToConvert(org, customer, admin.id, { walkthroughCrew: [withIt.id, without.id] }, estimates);

      const refused = await convert(await without.api(), c);
      expect(refused.status).toBe(403);
      expect(await jobsFor(c)).toBe(0);

      const ok = await convert(await withIt.api(), c);
      expect(ok.status, JSON.stringify(ok.body)).toBe(201);
      expect(await jobsFor(c)).toBe(1);
    });

    it('refuses a person with Create jobs whose Leads scope does not reach the lead, even when their Jobs scope is All', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const stranger = await converter(org, { leads: 'attached', jobs: 'all' });
      const c = await leadToConvert(org, customer, admin.id, {}, estimates);

      const res = await convert(await stranger.api(), c);

      expect(res.status).toBe(403);
      expect(await jobsFor(c)).toBe(0);
    });

    it('lets a person whose Leads scope is All convert any lead', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const office = await converter(org, { leads: 'all', jobs: 'all' });
      const c = await leadToConvert(org, customer, admin.id, {}, estimates);

      const res = await convert(await office.api(), c);

      expect(res.status, JSON.stringify(res.body)).toBe(201);
    });

    it('tells the lead\'s Owner, who becomes the job\'s Sold By, that they can open the new job', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const owner = await converter(org, { leads: 'attached', jobs: 'attached', canOwn: true });
      const c = await leadToConvert(org, customer, admin.id, { owner: owner.id }, estimates);
      const api = await owner.api();

      const res = await convert(api, c);

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.job_openable).toBe(true);
      expect((await db.job.findUniqueOrThrow({ where: { id: res.body.job.id } })).salesperson_id).toBe(owner.id);
      // The answer is true: the job page opens for them.
      expect((await api.get(`/api/jobs/${res.body.job.id}`)).status).toBe(200);
      // And the response still carries the job as the page needs it.
      expect(res.body.job.customer).toBeTruthy();
    });

    it('tells a walkthrough-crew-only converter the job was created but is not theirs to open, and sends back no job details', async () => {
      const { org, admin, customer } = await fx.newOrg();
      const crew = await converter(org, { leads: 'attached', jobs: 'attached' });
      const c = await leadToConvert(org, customer, admin.id, { walkthroughCrew: [crew.id] }, estimates);
      const api = await crew.api();

      const res = await convert(api, c);

      expect(res.status, JSON.stringify(res.body)).toBe(201);
      expect(res.body.job_openable).toBe(false);
      expect(Object.keys(res.body.job).sort()).toEqual(['id', 'job_number']);
      expect(await jobsFor(c)).toBe(1);
      // The answer is true: the server does refuse that job page to them.
      expect((await api.get(`/api/jobs/${res.body.job.id}`)).status).toBe(403);
    });
  });

  it('gives a repeated conversion by someone who cannot open the job the same minimal answer, not the job\'s details', async () => {
    const { org, admin, customer } = await fx.newOrg();
    const crew = await converter(org, { leads: 'attached', jobs: 'attached' });
    const c = await leadToConvert(org, customer, admin.id, { walkthroughCrew: [crew.id] });
    const api = await crew.api();
    const first = await convert(api, c);
    expect(first.status).toBe(201);

    const again = await convert(api, c);

    expect(again.status).toBe(200);
    expect(again.body.job_openable).toBe(false);
    expect(Object.keys(again.body.job).sort()).toEqual(['id', 'job_number']);
    expect(again.body.job.id).toBe(first.body.job.id);
  });
});
