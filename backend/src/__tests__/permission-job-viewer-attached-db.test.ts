/* =============================================================================
   Roles & Permissions, PRD 7, slice S07.5 - the job page asks the server whether the person looking at it is
   attached to the job (the Logistics tab shows its staging to an attached person whatever their switches).

   Called through the job read route as people on custom roles (never a built-in role name). Real migrated
   database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, afterAll, beforeAll, vi } from 'vitest';
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
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

/** Every switch in the catalog off (a choice at its first option, a list empty), so a case turns on exactly the ones it is about. */
const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);

suite('a job read says whether the person is attached to the job (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role who can open every job and holds nothing else. */
  async function personWith(
    org: string,
    values: Record<string, SwitchValue> = { view_jobs: true, jobs_scope: 'all' },
    base: Role = 'TECHNICIAN',
  ): Promise<Person & { api: () => Promise<Api> }> {
    const key = `viewer-attached-role-${++sequence}`;
    const role = await fx.addCustomRole(org, key, base);
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...ALL_OFF, ...values }, actorId: null, reason: 'manual' });
    const person = await fx.addUser(org, `p${sequence}`, base, { customRoleId: role.id });
    return Object.assign(person, { api: () => fx.signedInAs(person) });
  }

  const attachedOn = async (person: { api: () => Promise<Api> }, jobId: string) => {
    const res = await (await person.api()).get(`/api/jobs/${jobId}`);
    expect(res.status).toBe(200);
    return res.body.job.viewer_attached;
  };

  it('is true for the crew of a visit, the Sold By and the Dispatcher, and false for someone who can only open the job', async () => {
    const { org, customer } = await fx.newOrg();
    const crew = await personWith(org);
    const soldBy = await personWith(org);
    const dispatcher = await personWith(org);
    const bystander = await personWith(org);
    const job = await fx.addJob(org, customer, { crew: [crew.id], soldBy: soldBy.id, dispatcher: dispatcher.id });

    expect(await attachedOn(crew, job.id)).toBe(true);
    expect(await attachedOn(soldBy, job.id)).toBe(true);
    expect(await attachedOn(dispatcher, job.id)).toBe(true);
    expect(await attachedOn(bystander, job.id)).toBe(false);
  });

  it('counts the crew of a past visit, and stops counting a person taken off the job on the very next read', async () => {
    const { org, customer } = await fx.newOrg();
    const crew = await personWith(org);
    const job = await fx.addJob(org, customer, { crew: [crew.id], pastVisit: true });
    expect(await attachedOn(crew, job.id)).toBe(true);

    await fx.removeCrew(job.visitId!, crew.id);
    expect(await attachedOn(crew, job.id)).toBe(false);
  });

  it('does not count the creator of the job as attached', async () => {
    const { org, customer } = await fx.newOrg();
    const creator = await personWith(org);
    const job = await fx.addJob(org, customer, { createdBy: creator.id });
    expect(await attachedOn(creator, job.id)).toBe(false);
  });
});
