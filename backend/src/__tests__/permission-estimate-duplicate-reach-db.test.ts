/* =============================================================================
   Roles & Permissions security, finding M2 (ticket 32) - "Duplicate estimate" checks the person's reach on the source
   estimate AND on the lead it is duplicated onto.

   Everything goes through the public interface: the duplicate route, called as people on custom roles (never a built-in
   role name) whose Leads scope and Jobs scope are the switch values under test. A source estimate or a target lead
   outside the person's reach answers "not found", the same as one that does not exist, and no estimate is created.
   The same action on reachable records still works. Real migrated database (TEST_DATABASE_URL); the suite skips when it
   is unset. Every org it creates is removed again.
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

// The suite-wide setup stubs the number allocator with one constant, so a second estimate in a company collides with the
// first. The real allocator is the one that serves requests, and the one these cases need.
vi.mock('../lib/numbering', async (importOriginal) => await importOriginal<typeof import('../lib/numbering')>());

import { switchFixture } from './permission-switches-fixture';
import { findSwitch, SWITCH_CATALOG } from '../lib/permissions/switches/catalog';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';

const suite = realClient ? describe : describe.skip;

suite('Duplicate estimate checks reach on the source and the target (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** Every switch that stands on this one, directly or through another: turning this off takes them all off. */
  const standingOn = (key: string): string[] => {
    const direct = SWITCH_CATALOG.filter((sw) => sw.requires.includes(key)).map((sw) => sw.key);
    return [...new Set([...direct, ...direct.flatMap(standingOn)])];
  };

  /** A person on a fresh custom role: the Dispatcher preset (Create estimates on), with exactly these switch values on top. */
  async function personWith(org: string, values: Record<string, boolean | string>) {
    const key = `m2-dup-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, 'DISPATCHER');
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, 'DISPATCHER', { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const duplicate = async (who: { api: () => Promise<Awaited<ReturnType<typeof fx.signedInAs>>> }, id: string, target?: string) =>
    (await who.api()).post(`/api/estimates/${id}/duplicate`, target ? { target_lead_id: target } : {});

  const estimateCount = (org: string) => db.estimate.count({ where: { organization_id: org } });

  /** A person who reaches only what they are attached to, an estimate on a lead they are on, and a lead and estimate they are not. */
  async function world() {
    const { org, customer, admin } = await fx.newOrg();
    const me = await personWith(org, { leads_scope: 'attached', jobs_scope: 'attached' });
    const mine = await fx.addLead(org, customer, { dispatcher: me.id });
    const mineToo = await fx.addLead(org, customer, { dispatcher: me.id });
    const theirs = await fx.addLead(org, customer, { assignees: [admin.id] });
    const myEstimate = await fx.addEstimate(org, customer, admin.id, { leadId: mine.id });
    const theirEstimate = await fx.addEstimate(org, customer, admin.id, { leadId: theirs.id });
    return { org, customer, admin, me, mine, mineToo, theirs, myEstimate, theirEstimate };
  }

  it('holds Create estimates and the Attached scope the cases rely on, read from the catalog', () => {
    expect(findSwitch('create_estimates')!.presets.DISPATCHER).toBe(true);
    expect(findSwitch('leads_scope')!.presets.SALES).toBe('attached');
  });

  it('refuses a target lead the person cannot open with the same "not found" as a missing lead, and creates nothing', async () => {
    const w = await world();
    const before = await estimateCount(w.org);

    const refused = await duplicate(w.me, w.myEstimate.id, w.theirs.id);
    const missing = await duplicate(w.me, w.myEstimate.id, randomUUID());

    expect(refused.status).toBe(404);
    expect(refused.status).toBe(missing.status);
    expect(refused.body).toEqual(missing.body);
    expect(await estimateCount(w.org)).toBe(before);
    expect(await db.estimate.count({ where: { lead_id: w.theirs.id } })).toBe(1);
  });

  it('refuses a source estimate the person cannot open the same way as a missing estimate, and creates nothing', async () => {
    const w = await world();
    const before = await estimateCount(w.org);

    const refused = await duplicate(w.me, w.theirEstimate.id);
    const refusedOntoMyLead = await duplicate(w.me, w.theirEstimate.id, w.mine.id);
    const missing = await duplicate(w.me, randomUUID());

    expect(refused.status).toBe(404);
    expect(refusedOntoMyLead.status).toBe(404);
    expect(refused.body).toEqual(missing.body);
    expect(refusedOntoMyLead.body).toEqual(missing.body);
    expect(await estimateCount(w.org)).toBe(before);
  });

  it('still duplicates a reachable estimate on its own lead', async () => {
    const w = await world();

    const res = await duplicate(w.me, w.myEstimate.id);

    expect(res.status).toBe(201);
    expect(await db.estimate.count({ where: { lead_id: w.mine.id } })).toBe(2);
  });

  it('still duplicates a reachable estimate onto another lead the person can open', async () => {
    const w = await world();

    const res = await duplicate(w.me, w.myEstimate.id, w.mineToo.id);

    expect(res.status).toBe(201);
    expect(await db.estimate.count({ where: { lead_id: w.mineToo.id } })).toBe(1);
  });

  describe('an estimate the person reaches through its job while its lead is not theirs', () => {
    async function jobOnlyWorld() {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { leads_scope: 'attached', jobs_scope: 'attached' });
      const lead = await fx.addLead(org, customer, { assignees: [admin.id] });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id, jobId: job.id });
      return { org, me, lead, estimate };
    }

    it('is opened by the person (the probe) but cannot be duplicated onto its own lead, by default or by naming the lead, and creates nothing', async () => {
      const w = await jobOnlyWorld();
      expect((await (await w.me.api()).get(`/api/estimates/${w.estimate.id}`)).status).toBe(200);
      // ...while its lead is not theirs to open.
      expect((await (await w.me.api()).get(`/api/leads/${w.lead.id}`)).status).not.toBe(200);
      const before = await estimateCount(w.org);

      const bare = await duplicate(w.me, w.estimate.id);
      const named = await duplicate(w.me, w.estimate.id, w.lead.id);
      const missing = await duplicate(w.me, randomUUID(), randomUUID());

      expect(bare.status).toBe(404);
      expect(named.status).toBe(404);
      expect(bare.body).toEqual({ error: 'Target lead not found' });
      expect(named.body).toEqual(bare.body);
      expect(missing.status).toBe(404);
      expect(await estimateCount(w.org)).toBe(before);
    });
  });

  describe('when the person\'s Leads scope reaches nothing (View leads off)', () => {
    it('opens the estimate through its job but cannot duplicate it onto the lead, by default or by naming the lead, and creates nothing', async () => {
      const { org, customer, admin } = await fx.newOrg();
      const me = await personWith(org, { view_leads: false, ...Object.fromEntries(standingOn('view_leads').map((k) => [k, false])), leads_scope: 'all', jobs_scope: 'attached' });
      const lead = await fx.addLead(org, customer, { dispatcher: me.id });
      const job = await fx.addJob(org, customer, { crew: [me.id] });
      const estimate = await fx.addEstimate(org, customer, admin.id, { leadId: lead.id, jobId: job.id });
      expect((await (await me.api()).get(`/api/estimates/${estimate.id}`)).status).toBe(200);
      const before = await estimateCount(org);

      const bare = await duplicate(me, estimate.id);
      const named = await duplicate(me, estimate.id, lead.id);
      const crossed = await duplicate(me, estimate.id, randomUUID());

      expect(bare.status).toBe(404);
      expect(bare.body).toEqual({ error: 'Target lead not found' });
      expect(named.status).toBe(404);
      expect(named.body).toEqual(bare.body);
      expect(crossed.status).toBe(404);
      expect(crossed.body).toEqual(bare.body);
      expect(await estimateCount(org)).toBe(before);
    });
  });

  it('duplicates the same estimate twice in a row, onto its own lead and then onto another', async () => {
    const w = await world();

    const first = await duplicate(w.me, w.myEstimate.id);
    const second = await duplicate(w.me, w.myEstimate.id, w.mine.id);

    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
  });

  it('still duplicates onto any lead for a person whose scope is All', async () => {
    const w = await world();
    const wide = await personWith(w.org, { leads_scope: 'all', jobs_scope: 'all' });

    const res = await duplicate(wide, w.myEstimate.id, w.theirs.id);

    expect(res.status).toBe(201);
    expect(await db.estimate.count({ where: { lead_id: w.theirs.id } })).toBe(2);
  });
});
