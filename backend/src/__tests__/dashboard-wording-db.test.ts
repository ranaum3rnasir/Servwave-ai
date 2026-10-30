/* =============================================================================
   Roles & Permissions, PRD 9, slice S09.14 - "Unassigned" leaves the dashboard, and the tiles use PRD 6's
   completion words.

   Everything goes through the public interface: GET /api/dashboard as people on the four built-in presets (the
   words a stock person is sent are the preset's own behaviour), with every tile eligible for them computed. Real
   migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again,
   and every assertion is about rows the test created in its own org.
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
    allocateNumber: vi.fn(async (_tx: unknown, entity: string) => `${entity[0]!.toUpperCase()}W${Date.now()}${++issued}`),
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { TILE_CATALOG } from '../lib/dashboard/tileCatalog';

const suite = realClient ? describe : describe.skip;

type Answer = { tiles: Array<Record<string, unknown>>; categories: Array<Record<string, unknown>>; data: Record<string, any> };

/** Every key and every string value anywhere in a JSON value, as `path: text` lines, so a failure names where it sits. */
function wordsOf(value: unknown, path = '$'): string[] {
  if (typeof value === 'string') return [`${path}: ${value}`];
  if (Array.isArray(value)) return value.flatMap((item, i) => wordsOf(item, `${path}[${i}]`));
  if (value && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => [`${path}.${key}: (key)`, ...wordsOf(inner, `${path}.${key}`)]);
  }
  return [];
}
const unassignedIn = (value: unknown) => wordsOf(value).filter((line) => /unassign/i.test(line));

suite('the dashboard says "Unassigned" nowhere, and uses the completion words (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM tasks WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM visit_assignees WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM visits WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }

  const dashboardOf = async (person: Person): Promise<Answer> => {
    const res = await (await fx.signedInAs(person)).get('/api/dashboard');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Answer;
  };

  /**
   * A company with every empty slot the dashboard used to call "Unassigned": a job nobody has scheduled, a visit today
   * and another in three days with nobody on the crew, a booked walkthrough with nobody on it, an open lead with no
   * Owner, a finished job with no Dispatcher, and a job in each status that counts as finished work.
   */
  async function emptySlotsWorld() {
    const world = await newOrg();
    const { org, customer } = world;
    const crew = await fx.addUser(org, 'wording-crew', 'TECHNICIAN');
    const dispatcher = await fx.addUser(org, 'wording-dispatcher', 'DISPATCHER');
    await fx.addJob(org, customer, { status: 'UNSCHEDULED' });
    const today = await fx.addJob(org, customer, { status: 'SCHEDULED' });
    await fx.addVisit(org, { jobId: today.id, crew: [], daysFromNow: 0 });
    const soon = await fx.addJob(org, customer, { status: 'SCHEDULED' });
    await fx.addVisit(org, { jobId: soon.id, crew: [], daysFromNow: 3 });
    const lead = await fx.addLead(org, customer);
    await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [], daysFromNow: 2 });
    for (const status of ['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE'] as const) {
      await fx.addJob(org, customer, { status, crew: [crew.id], pastVisit: true });
      await fx.addJob(org, customer, { status, dispatcher: dispatcher.id });
    }
    await db.job.updateMany({ where: { organization_id: org, status: { in: ['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE'] } }, data: { amount_invoiced: 100 } });
    return world;
  }

  describe('the whole dashboard answer, for each built-in preset with every tile it is eligible for', () => {
    it.each(['ADMIN', 'DISPATCHER', 'SALES', 'TECHNICIAN'] as Role[])('holds the word "unassigned" in no key and no value for %s', async (role) => {
      const { org } = await emptySlotsWorld();
      const person = await fx.addUser(org, `sweep-${role.toLowerCase()}`, role);
      const answer = await dashboardOf(person);

      // Every eligible tile is in the answer (a person with none would make the walk prove nothing).
      expect(answer.tiles.length).toBeGreaterThan(0);
      expect(Object.keys(answer.data).length).toBeGreaterThan(0);
      expect(unassignedIn(answer)).toEqual([]);
    });
  });

  it('holds the word in no id, title, label or category of the tile catalog', () => {
    expect(TILE_CATALOG.length).toBeGreaterThan(0);
    expect(unassignedIn(TILE_CATALOG)).toEqual([]);
  });

  describe('each empty slot is named for what is missing', () => {
    it('labels the Unscheduled job status "Unscheduled" in Jobs by Status', async () => {
      const { org, customer, admin } = await newOrg();
      await fx.addJob(org, customer, { status: 'UNSCHEDULED' });
      const slices = (await dashboardOf(admin)).data.jobs_by_status as Array<{ key: string; label: string; count: number }>;
      expect(slices.find((s) => s.key === 'unscheduled')).toEqual({ key: 'unscheduled', label: 'Unscheduled', count: 1 });
    });

    it('puts visits and walkthroughs nobody is on in a lane named "No crew", last', async () => {
      const { org, customer, admin } = await newOrg();
      const crew = await fx.addUser(org, 'wording-lane-crew', 'TECHNICIAN');
      const staffed = await fx.addJob(org, customer, { status: 'SCHEDULED' });
      await fx.addVisit(org, { jobId: staffed.id, crew: [crew.id], daysFromNow: 0 });
      const empty = await fx.addJob(org, customer, { status: 'SCHEDULED' });
      await fx.addVisit(org, { jobId: empty.id, crew: [], daysFromNow: 0 });

      const lanes = (await dashboardOf(admin)).data.schedule_today as Array<{ user_id: string | null; first_name: string; last_name: string; jobs: Array<{ id: string }> }>;
      const last = lanes[lanes.length - 1]!;
      expect(last).toMatchObject({ user_id: null, first_name: 'No crew', last_name: '' });
      expect(last.jobs.map((j) => j.id)).toEqual([empty.id]);
      expect(lanes.filter((l) => l.user_id !== null).map((l) => l.user_id)).toEqual([crew.id]);
    });
  });

  describe('the completion words', () => {
    it('names the pipeline\'s job stage "Job completed" and no stage "Done" or "Closed"', async () => {
      const { admin } = await newOrg();
      const stages = (await dashboardOf(admin)).data.pipeline as Array<{ key: string; label: string }>;
      expect(stages.find((s) => s.key === 'job')?.label).toBe('Job completed');
      expect(stages.map((s) => s.label)).not.toContain('Done');
      expect(stages.map((s) => s.label.toLowerCase())).not.toContain('closed');
    });

    it('keeps the finished-job slice of Jobs by Status as "Completed" for every status from Completed on', async () => {
      const { org, customer, admin } = await newOrg();
      for (const status of ['COMPLETED', 'OFFICE_REVIEW', 'READY_TO_CLOSE', 'DONE'] as const) await fx.addJob(org, customer, { status });
      const slices = (await dashboardOf(admin)).data.jobs_by_status as Array<{ label: string; count: number }>;
      expect(slices.map((s) => s.label)).toEqual(['Completed']);
      expect(slices[0]!.count).toBe(4);
    });
  });
});
