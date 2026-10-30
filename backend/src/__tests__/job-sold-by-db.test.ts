/* =============================================================================
   Roles & Permissions, PRD 3, slice S03.8 - the stored Sold By on the job detail.

   The job's detail response carries the Sold By stored on the job (its salesperson), not the Owner of
   the lead its estimate came from: a job built from several estimates and a service plan visit job show
   their seller, and a job with no Sold By shows nobody even when the lead it came from has an Owner.

   Everything goes through the public interface: the job detail route. Real migrated database
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

import { switchFixture } from './permission-switches-fixture';

const suite = realClient ? describe : describe.skip;

suite('the job detail reads the stored Sold By (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type SoldBy = { id: string; first_name: string; last_name: string } | null;
  const soldByOf = async (org: { admin: { id: string; email: string } }, jobId: string) => {
    const res = await (await fx.signedInAs(org.admin)).get(`/api/jobs/${jobId}`);
    expect(res.status).toBe(200);
    return res.body.job.salesperson as SoldBy;
  };

  it('shows the stored seller of a job built from several estimates, which has no single estimate to walk', async () => {
    const setup = await fx.newOrg();
    const { org, customer } = setup;
    const seller = await fx.addUser(org, 'seller', 'SALES');
    const leadOwner = await fx.addUser(org, 'owner', 'SALES');
    const lead = await fx.addLead(org, customer, { owner: leadOwner.id });
    const job = await fx.addJob(org, customer, { soldBy: seller.id });
    await db.job.update({ where: { id: job.id }, data: { lead_id: lead.id } });

    const shown = await soldByOf(setup, job.id);

    expect(shown?.id).toBe(seller.id);
  });

  it('shows nobody for a job with no Sold By, even when the lead it came from has an Owner', async () => {
    const setup = await fx.newOrg();
    const { org, customer } = setup;
    const leadOwner = await fx.addUser(org, 'owner2', 'SALES');
    const lead = await fx.addLead(org, customer, { owner: leadOwner.id });
    const job = await fx.addJob(org, customer, { fromLead: lead.id });

    expect(await soldByOf(setup, job.id)).toBeNull();
  });

  it('shows the stored seller, not the lead Owner, when the two differ', async () => {
    const setup = await fx.newOrg();
    const { org, customer } = setup;
    const seller = await fx.addUser(org, 'seller3', 'SALES');
    const leadOwner = await fx.addUser(org, 'owner3', 'SALES');
    const lead = await fx.addLead(org, customer, { owner: leadOwner.id });
    const job = await fx.addJob(org, customer, { fromLead: lead.id, soldBy: seller.id });

    expect((await soldByOf(setup, job.id))?.id).toBe(seller.id);
  });
});
