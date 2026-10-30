/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.19 - the alert "someone" test.

   The access resolver's "can this person open the record" answer, exposed as the test an alert recipient has to pass
   (PRD 4's recipient lookup and PRD 6's alert moves use it): a person is "someone" for an alert about a record when
   they are active, can open the record, and are not the person who caused the alert.

   Called as the exported function, with people on custom roles holding exactly the switch values under test. Real
   migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, afterAll, vi } from 'vitest';
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

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

suite('the alert "someone" test (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  afterAll(() => fx.cleanup());

  let sequence = 0;

  /** A person on a fresh custom role of this base holding exactly these switch values (every other toggle off). */
  async function personWith(org: string, values: Record<string, boolean | string>, opts: { base?: Role } = {}): Promise<Person> {
    const key = `someone-role-${++sequence}`;
    const base = opts.base ?? 'TECHNICIAN';
    const role = await fx.addCustomRole(org, key, base);
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...allOff, ...values }, actorId: null, reason: 'manual' });
    return fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
  }

  const opensEverything = { view_jobs: true, jobs_scope: 'all', view_leads: true, leads_scope: 'all', view_estimates: true, view_invoices: true };

  async function someoneFor(org: string, candidates: Person[], record: { type: string; id: string }, actor: Person | null) {
    const { alertSomeone } = await import('../lib/permissions/alertSomeone.js');
    return alertSomeone({ organizationId: org, candidateIds: candidates.map((c) => c.id), record, actorId: actor?.id ?? null });
  }

  it('keeps an active person who can open the record, and refuses an inactive person, a person who cannot open it and the actor', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const job = await fx.addJob(org, customer);
    const opens = await personWith(org, opensEverything);
    const cannotOpen = await personWith(org, { ...opensEverything, view_jobs: false, create_jobs: false });
    const inactive = await personWith(org, opensEverything);
    await db.user.update({ where: { id: inactive.id }, data: { is_active: false } });
    const actor = await personWith(org, opensEverything);

    const everyone = [opens, cannotOpen, inactive, actor, admin];
    const kept = await someoneFor(org, everyone, { type: 'JOB', id: job.id }, actor);

    // The Admin box opens everything; the actor, the inactive person and the person without View jobs are out.
    expect(kept).toEqual([opens.id, admin.id]);
  });

  it('judges "can open" by the record: a person attached to this job is someone for it, and not for another job', async () => {
    const { org, customer } = await fx.newOrg();
    const mine = await fx.addJob(org, customer);
    const notMine = await fx.addJob(org, customer);
    const crew = await personWith(org, { view_jobs: true, jobs_scope: 'attached' });
    await fx.addVisit(org, { jobId: mine.id, crew: [crew.id] });

    expect(await someoneFor(org, [crew], { type: 'JOB', id: mine.id }, null)).toEqual([crew.id]);
    expect(await someoneFor(org, [crew], { type: 'JOB', id: notMine.id }, null)).toEqual([]);
  });

  it('answers for estimates, leads and invoices the same way', async () => {
    const { org, customer, admin } = await fx.newOrg();
    const estimate = await fx.addEstimate(org, customer, admin.id);
    const lead = await fx.addLead(org, customer);
    const invoice = await fx.addInvoice(org, customer);
    const opens = await personWith(org, opensEverything);
    const blind = await personWith(org, {});

    for (const record of [
      { type: 'ESTIMATE', id: estimate.id },
      { type: 'LEAD', id: lead.id },
      { type: 'INVOICE', id: invoice.id },
    ]) {
      expect(await someoneFor(org, [opens, blind], record, null), record.type).toEqual([opens.id]);
    }
  });

  it('never returns someone from another company, and nobody for a record that does not exist or a type it does not know', async () => {
    const mine = await fx.newOrg();
    const theirs = await fx.newOrg();
    const job = await fx.addJob(mine.org, mine.customer);
    const insider = await personWith(mine.org, opensEverything);
    const outsider = await personWith(theirs.org, opensEverything);

    expect(await someoneFor(mine.org, [insider, outsider], { type: 'JOB', id: job.id }, null)).toEqual([insider.id]);
    expect(await someoneFor(mine.org, [insider], { type: 'JOB', id: '00000000-0000-0000-0000-00000000dead' }, null)).toEqual([]);
    expect(await someoneFor(mine.org, [insider], { type: 'ROCKET', id: job.id }, null)).toEqual([]);
  });
});
