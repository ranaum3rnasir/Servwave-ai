/* =============================================================================
   Roles & Permissions security fixes, ticket 33 (spec story 49): the SQL form of reach selects exactly what reach does.

   The activity report filters in the database with reach compiled to SQL (lib/permissions/reachSql.ts). The lists
   filter with the same reach as a Prisma `where` (scopeWhereForUser). This test holds the two together: over one company
   whose records are reached every way the rule knows (crew past and upcoming, Sold By, Dispatcher, lead assignee, Owner,
   walkthrough crew, a teammate, a converted lead, a job-linked estimate, a deposit invoice, documents made for a customer
   alone by the person and by someone else, a plan visit job), and people at every scope level (Their own with and
   without a department, Team with and without one, All, the kept "Through own leads" value) with each View switch on
   and off, the SQL form must pick exactly the ids the Prisma form picks, for jobs, leads, estimates and invoices.
   A change to either side that the other does not follow fails here.
   Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import { Prisma, type PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const dbUrl = process.env.TEST_DATABASE_URL;
  if (!dbUrl) return { realClient: undefined };
  const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
  return { realClient: new PrismaClient({ datasources: { db: { url: dbUrl } } }) };
});

vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { switchFixture, type Person } from './permission-switches-fixture';
import { SWITCH_CATALOG, THROUGH_OWN_LEADS, type SwitchValue } from '../lib/permissions/switches/catalog';
import { scopeWhereForUser } from '../lib/permissions/enforce';
import { tableSql, whereSql } from '../lib/permissions/reachSql';

const suite = realClient ? describe : describe.skip;

const ALL_OFF: Record<string, SwitchValue> = Object.fromEntries(
  SWITCH_CATALOG.map((s) => [s.key, s.kind === 'choice' ? s.choices![0]! : s.kind === 'list' ? [] : false]),
);
const VIEWS = { view_jobs: true, view_leads: true, view_estimates: true, view_invoices: true };
const KINDS = ['Job', 'Lead', 'Estimate', 'Invoice'] as const;
type Kind = (typeof KINDS)[number];
const DELEGATE = { Job: 'job', Lead: 'lead', Estimate: 'estimate', Invoice: 'invoice' } as const;

suite('the SQL form of reach selects exactly what reach selects (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  afterAll(() => fx.cleanup());

  let org = '';
  let sequence = 0;
  const people: { label: string; person: Person }[] = [];

  async function personWith(label: string, values: Record<string, SwitchValue>, opts: { departmentId?: string } = {}) {
    const key = `sql-eq-${++sequence}`;
    await fx.addCustomRole(org, key, 'TECHNICIAN', { madeFromBlank: true });
    await fx.setRoleSwitches(org, key, { ...ALL_OFF, ...values });
    const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key } });
    const person = await fx.addUser(org, `sq${sequence}`, 'TECHNICIAN', { customRoleId: role.id, departmentId: opts.departmentId });
    people.push({ label, person });
    return person;
  }

  beforeAll(async () => {
    const o = await fx.newOrg();
    org = o.org;
    const { customer, admin } = o;
    const team = await fx.addDepartment(org, 'crew');
    const mate = await fx.addUser(org, 'mate', 'TECHNICIAN', { departmentId: team });
    const other = await fx.addUser(org, 'other', 'TECHNICIAN');

    const own = { ...VIEWS, jobs_scope: 'attached', leads_scope: 'attached' };
    const me = await personWith('Their own, in a team', own, { departmentId: team });
    const levels: [string, Record<string, SwitchValue>, string | undefined][] = [
      ['Their own, no team', own, undefined],
      ['Team', { ...VIEWS, jobs_scope: 'team', leads_scope: 'team' }, team],
      ['Team, no department (fails closed)', { ...VIEWS, jobs_scope: 'team', leads_scope: 'team' }, undefined],
      ['All', { ...VIEWS, jobs_scope: 'all', leads_scope: 'all' }, undefined],
      ['Through own leads', { ...VIEWS, jobs_scope: THROUGH_OWN_LEADS, leads_scope: 'attached' }, undefined],
      ['Jobs All, Leads Their own', { ...VIEWS, jobs_scope: 'all', leads_scope: 'attached' }, undefined],
      ['All without View leads', { ...VIEWS, view_leads: false, jobs_scope: 'all', leads_scope: 'all' }, undefined],
      ['All without View jobs', { ...VIEWS, view_jobs: false, jobs_scope: 'all', leads_scope: 'all' }, undefined],
      ['Their own without View leads', { ...own, view_leads: false }, team],
      ['Their own without View jobs', { ...own, view_jobs: false }, team],
      ['Through own leads without View leads', { ...VIEWS, view_leads: false, jobs_scope: THROUGH_OWN_LEADS, leads_scope: 'attached' }, undefined],
      ['No View at all', { jobs_scope: 'all', leads_scope: 'all' }, undefined],
    ];
    for (const [label, values, dept] of levels) await personWith(label, values, { departmentId: dept });
    // Everyone below is attached to the records the way `me` is, so every level has something of its own to reach.
    const attachedPeople = people.map((p) => p.person);

    // Jobs, reached each way.
    for (const p of attachedPeople) {
      await fx.addJob(org, customer, { crew: [p.id] });
      await fx.addJob(org, customer, { crew: [p.id], pastVisit: true });
      await fx.addJob(org, customer, { soldBy: p.id });
      await fx.addJob(org, customer, { dispatcher: p.id });
    }
    const mateJob = await fx.addJob(org, customer, { crew: [mate.id] });
    const nobodyJob = await fx.addJob(org, customer, {});
    const plan = await fx.addServicePlan(org, customer, { soldBy: me.id });
    await fx.addJob(org, customer, { soldBy: me.id, sourcePlan: plan.id });

    // Leads, reached each way, and a converted one.
    for (const p of attachedPeople) {
      const assigned = await fx.addLead(org, customer, { assignees: [p.id] });
      await fx.addLead(org, customer, { owner: p.id });
      await fx.addLead(org, customer, { dispatcher: p.id });
      await fx.addLead(org, customer, { walkthroughCrew: [p.id] });
      const converted = await fx.addJob(org, customer, { fromLead: assigned.id });
      await fx.addInvoice(org, customer, { jobId: converted.id });
      // Their lead's estimate and its deposit invoice (no job yet).
      const e = await fx.addEstimate(org, customer, admin.id, { leadId: assigned.id });
      await fx.addInvoice(org, customer, { estimateId: e.id });
      // A customer-anchored estimate the person made that has since produced a job they are not on: no lead and no job link,
      // but a job points at it, so it is no longer "for a customer alone" and their having made it reaches nothing.
      const anchored = await fx.addEstimate(org, customer, p.id);
      const anchoredJob = await fx.addJob(org, customer, {});
      await db.job.update({ where: { id: anchoredJob.id }, data: { estimate_id: anchored.id } });
      // Documents made for a customer alone, by the person.
      const mine = await fx.addEstimate(org, customer, p.id);
      await fx.addInvoice(org, customer, { createdBy: p.id });
      await fx.addInvoice(org, customer, { estimateId: mine.id, createdBy: p.id });
    }
    const mateLead = await fx.addLead(org, customer, { assignees: [mate.id] });
    const nobodyLead = await fx.addLead(org, customer, {});
    await fx.addEstimate(org, customer, admin.id, { leadId: mateLead.id });
    await fx.addEstimate(org, customer, admin.id, { leadId: nobodyLead.id });
    await fx.addEstimate(org, customer, admin.id, { jobId: mateJob.id });
    await fx.addEstimate(org, customer, admin.id, { jobId: nobodyJob.id });
    await fx.addInvoice(org, customer, { jobId: mateJob.id });
    await fx.addInvoice(org, customer, { jobId: nobodyJob.id });
    // Someone else's documents made for a customer alone.
    await fx.addEstimate(org, customer, other.id);
    await fx.addInvoice(org, customer, { createdBy: other.id });
  }, 300_000);

  async function viaPrisma(kind: Kind, scope: Record<string, unknown>): Promise<string[]> {
    const delegate = db[DELEGATE[kind]] as unknown as { findMany: (a: unknown) => Promise<{ id: string }[]> };
    const rows = await delegate.findMany({ where: { organization_id: org, AND: [scope] }, select: { id: true } });
    return rows.map((r) => r.id).sort();
  }

  async function viaSql(kind: Kind, scope: Record<string, unknown>): Promise<string[]> {
    const rows = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
      SELECT rec.id::text AS id FROM ${tableSql(kind)} rec
      WHERE rec.organization_id = ${org}::uuid AND (${whereSql(kind, scope, 'rec')})`);
    return rows.map((r) => r.id).sort();
  }

  it('covers every scope level with a narrowed reach and a real answer', async () => {
    // A level that compiled to "every row" or "nothing" for every kind would test nothing about the join.
    let narrowed = 0;
    for (const { person } of people) {
      const user = await db.user.findUniqueOrThrow({ where: { id: person.id } });
      for (const kind of KINDS) if (Object.keys(await scopeWhereForUser(user, kind)).length > 0) narrowed += 1;
    }
    expect(narrowed).toBeGreaterThan(people.length * 2);
  });

  for (const kind of KINDS) {
    it(`selects the same ${kind.toLowerCase()} ids as the Prisma reach, at every scope level and View setting`, async () => {
      const differ: string[] = [];
      let nonEmpty = 0;
      let partial = 0;
      const total = (await viaPrisma(kind, {})).length;
      for (const { label, person } of people) {
        const user = await db.user.findUniqueOrThrow({ where: { id: person.id } });
        const scope = await scopeWhereForUser(user, kind);
        const [a, b] = [await viaPrisma(kind, scope), await viaSql(kind, scope)];
        if (JSON.stringify(a) !== JSON.stringify(b)) differ.push(`${label}: prisma ${a.length} / sql ${b.length}`);
        if (a.length > 0) nonEmpty += 1;
        if (a.length > 0 && a.length < total) partial += 1;
      }
      expect(differ).toEqual([]);
      // The fixture really exercises the rule: most levels reach some, but not all, of the records.
      expect(nonEmpty).toBeGreaterThan(5);
      expect(partial).toBeGreaterThan(5);
    }, 120_000);
  }
});
