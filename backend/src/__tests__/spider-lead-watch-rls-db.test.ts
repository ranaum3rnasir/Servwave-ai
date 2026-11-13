/* =============================================================================
   #3468: a lead save keeps its watch row as the live API's database role (`app_rls`, no BYPASSRLS) under the tenant
   guard (DB_TENANT_GUARD=on): scoped to the lead's company and unscoped, through the app's own HTTP doors.

   Every lead save now also writes the lead's row in spider_lead_watch, inside the user's own transaction, through the
   table's tenant policy. If the policy refused that write, the lead save itself would fail, for every company. So:
     - the real journey: an Admin creates a lead and moves it New -> Contacted -> Won over HTTP (and another lead is
       marked lost), and after each save the watch row says so, in the same save;
     - a save scoped to the company (app.current_org_id, as every request and every per-company job sets it) and an
       unscoped one (app.bypass_rls, as a cross-company job sets it) both work and both write the row;
     - the row is part of the lead's transaction: a save rolled back takes its row change with it;
     - another company's scope sees none of the rows; a lead deleted as that role takes its row with it.

   Seam: the real app, real migrated database. The app's client is the real client wrapped by the real tenant guard
   (lib/tenant-guard.ts), exactly as lib/prisma.ts builds it when the guard is on, with every transaction taking the
   `app_rls` role first (what the live API's login role is), as spider-recipient-sets-rls-db.test.ts wires it.

   Role DDL: beforeAll makes the role if it is missing and grants it the runbook's grants, as login-lockout-rls.test.ts does.
   Skips when TEST_DATABASE_URL is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { Prisma, PrismaClient } from '@prisma/client';

const { superClient } = vi.hoisted(() => {
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  const dbUrl = process.env.TEST_DATABASE_URL;
  // The test's own client: the database's superuser, for setup and for looking at what was stored.
  return { superClient: dbUrl ? new PrismaClient({ datasources: { db: { url: dbUrl } } }) : undefined };
});

// The app's client: the real client under the real tenant guard, every transaction run as app_rls.
vi.mock('../lib/prisma', async () => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { prisma: undefined };
  const { PrismaClient } = await import('@prisma/client');
  const { wrapWithTenantGuard } = await import('../lib/tenant-guard.js');
  // Options typed first, not inlined: an inline literal assigned to a `PrismaClient`-typed place costs ~39k types (~700k the first) and once ran CI's typecheck out of memory.
  const baseOptions: Prisma.PrismaClientOptions = { datasources: { db: { url: dbUrl } } };
  const base = new PrismaClient(baseOptions);
  const SET_ROLE = 'SET LOCAL ROLE app_rls';
  const asAppRls = new Proxy(base, {
    get(target, prop) {
      if (prop === '$transaction') {
        return (arg: unknown, opts?: unknown) =>
          typeof arg === 'function'
            ? target.$transaction(async (tx) => {
                await tx.$executeRawUnsafe(SET_ROLE);
                return (arg as (t: typeof tx) => Promise<unknown>)(tx);
              }, opts as never)
            : target.$transaction([target.$executeRawUnsafe(SET_ROLE), ...(arg as never[])], opts as never).then((r) => r.slice(1));
      }
      return Reflect.get(target, prop, target);
    },
  });
  return { prisma: wrapWithTenantGuard(asAppRls as typeof base) };
});
vi.mock('../config/env', async () => {
  const { testEnv } = await import('./test-env.js');
  return { env: { ...testEnv, DATABASE_URL: process.env.TEST_DATABASE_URL ?? testEnv.DATABASE_URL } };
});

import { switchFixture } from './permission-switches-fixture';
import { runWithOrg, runUnscoped } from '../lib/tenant-context';
import { logger } from '../lib/logger';

const suite = superClient ? describe : describe.skip;

const ISO = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;
const HOUR = 3_600_000;
const ROLLBACK = new Error('rolled back on purpose');

suite("Spider watch list as the live API's database role, under the tenant guard (real database)", () => {
  const db = superClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  let prisma: PrismaClient;

  beforeAll(async () => {
    await db.$executeRawUnsafe(
      `DO $$ BEGIN
         IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'app_rls') THEN
           CREATE ROLE app_rls NOLOGIN NOBYPASSRLS;
         END IF;
       END $$;`,
    );
    await db.$executeRawUnsafe('GRANT USAGE ON SCHEMA public TO app_rls');
    await db.$executeRawUnsafe('GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO app_rls');
    ({ prisma } = await import('../lib/prisma.js'));
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    await fx.cleanup();
  });

  async function watchOf(leadId: string) {
    const [row] = await db.$queryRawUnsafe<{ stage: string | null; entered_at: string | null; pending: boolean; changed_at: string }[]>(
      `SELECT stage, to_char(entered_at, ${ISO}) AS entered_at, pending, to_char(changed_at, ${ISO}) AS changed_at
         FROM spider_lead_watch WHERE lead_id = $1::uuid`, leadId);
    return row;
  }
  /** What the app logged as an error, so a 500 says why. */
  const serverErrors = () => JSON.stringify(vi.mocked(logger.error).mock.calls.map((c) => c.map((x) =>
    (x instanceof Error ? { message: x.message, code: (x as { code?: unknown }).code, meta: (x as { meta?: unknown }).meta } : x))));
  const createdAt = async (leadId: string) => (await db.lead.findUniqueOrThrow({ where: { id: leadId }, select: { created_at: true } })).created_at.toISOString();
  const claimLongAgo = (leadId: string) =>
    db.$executeRawUnsafe(`UPDATE spider_lead_watch SET pending = false, changed_at = '2000-01-01 00:00:00' WHERE lead_id = $1::uuid`, leadId);

  it('the journey over HTTP: create, Contacted (by status, then by a contact time), Won, and Lost each change the row in the same save', async () => {
    const o = await fx.newOrg();
    const api = await fx.signedInAs(o.admin);

    const created = await api.post('/api/leads', { customer_id: o.customer, service_request: 'Garage door will not close' });
    expect(created.status, serverErrors()).toBe(201);
    const lead = created.body.lead.id as string;
    expect(await watchOf(lead)).toMatchObject({ stage: 'NEW', entered_at: await createdAt(lead), pending: true });

    // New -> Contacted by the status pill: no contact time yet, so the stay counts from creation (config.ts, kept 11 Nov).
    await claimLongAgo(lead);
    const toContacted = await api.patch(`/api/leads/${lead}`, { status: 'CONTACTED' });
    expect(toContacted.status, serverErrors()).toBe(200);
    expect(await watchOf(lead)).toMatchObject({ stage: 'CONTACTED', entered_at: await createdAt(lead), pending: true });

    // A contact time set by hand: the same stage, a new entry instant, so a new stay.
    await claimLongAgo(lead);
    const contactedAt = new Date(Date.now() - 2 * HOUR).toISOString();
    const contact = await api.post(`/api/leads/${lead}/contact`, { contacted_at: contactedAt });
    expect(contact.status, serverErrors()).toBe(200);
    expect(await watchOf(lead)).toMatchObject({ stage: 'CONTACTED', entered_at: contactedAt, pending: true });

    // Won: no stage.
    const won = await api.patch(`/api/leads/${lead}`, { status: 'WON' });
    expect(won.status, serverErrors()).toBe(200);
    expect(await watchOf(lead)).toMatchObject({ stage: null, entered_at: null });

    // Lost, through its own door: no stage. (The second lead is made directly: in this harness a second POST /api/leads for
    // the same customer fails with a unique-constraint error even with the watch triggers switched off, so it is not
    // what this test is about; see the #3468 builder report.)
    const other = (await fx.addLead(o.org, o.customer)).id;
    expect(await watchOf(other)).toMatchObject({ stage: 'NEW' });
    const lost = await api.post(`/api/leads/${other}/mark-lost`, { lost_reason: 'Went with someone else' });
    expect(lost.status, serverErrors()).toBe(200);
    expect(await watchOf(other)).toMatchObject({ stage: null, entered_at: null });
  });

  it('a save scoped to the company (app.current_org_id) writes the row', async () => {
    const o = await fx.newOrg();
    const lead = (await fx.addLead(o.org, o.customer)).id;
    const contactedAt = new Date(Date.now() - HOUR);
    await runWithOrg(o.org, () => prisma.lead.update({ where: { id: lead }, data: { contacted_at: contactedAt } }));
    expect(await watchOf(lead)).toMatchObject({ stage: 'CONTACTED', entered_at: contactedAt.toISOString(), pending: true });
  });

  it('an unscoped save (app.bypass_rls, a cross-company job) writes the rows of two companies at once', async () => {
    const a = await fx.newOrg();
    const b = await fx.newOrg();
    const leads = [(await fx.addLead(a.org, a.customer)).id, (await fx.addLead(b.org, b.customer)).id];
    const visited = new Date(Date.now() - HOUR);
    const result = await runUnscoped(() =>
      prisma.lead.updateMany({ where: { id: { in: leads } }, data: { status: 'WALKTHROUGH_COMPLETED', walkthrough_first_booked_at: visited, last_visit_completed_at: visited } }));
    expect(result.count).toBe(2);
    for (const lead of leads) expect(await watchOf(lead)).toMatchObject({ stage: 'WALKTHROUGH_COMPLETED', entered_at: visited.toISOString() });
  });

  it('the row is written in the lead save\'s own transaction: rolled back, it is as it was', async () => {
    const o = await fx.newOrg();
    const lead = (await fx.addLead(o.org, o.customer)).id;
    const before = await watchOf(lead);
    let seenInside: unknown;
    await expect(runWithOrg(o.org, () => prisma.$transaction(async (tx) => {
      await tx.lead.update({ where: { id: lead }, data: { status: 'CONTACTED' } });
      [seenInside] = await tx.$queryRawUnsafe<{ stage: string }[]>(`SELECT stage FROM spider_lead_watch WHERE lead_id = $1::uuid`, lead);
      throw ROLLBACK;
    }))).rejects.toBe(ROLLBACK);
    expect(seenInside).toEqual({ stage: 'CONTACTED' });
    expect(await watchOf(lead)).toEqual(before);
    expect(before).toMatchObject({ stage: 'NEW' });
  });

  it("another company's scope sees none of the rows; a lead deleted as that role takes its row with it", async () => {
    const a = await fx.newOrg();
    const b = await fx.newOrg();
    const lead = (await fx.addLead(a.org, a.customer)).id;
    const read = (org: string) => runWithOrg(org, () => prisma.spiderLeadWatch.findMany({ where: { lead_id: lead }, select: { lead_id: true } }));
    expect(await read(a.org)).toEqual([{ lead_id: lead }]);
    expect(await read(b.org)).toEqual([]);

    await runWithOrg(a.org, () => prisma.lead.delete({ where: { id: lead } }));
    expect(await watchOf(lead)).toBeUndefined();
  });
});
