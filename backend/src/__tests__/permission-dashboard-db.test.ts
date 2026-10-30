/* =============================================================================
   Roles & Permissions, PRD 9, slice S09.1 - the per-person dashboard, and the route-level enforcement table for
   the dashboard endpoint (answers every signed-in person; tiles by category). Slice S09.4 adds its layout rows:
   read my layout and save my layout answer the signed-in person only, and only about their own layout.

   Everything goes through the public interface: GET /api/dashboard, called as people on custom roles (never a
   built-in role name) holding exactly the switch values under test. The one exception is the leak walk, which also
   signs in as a person on the built-in Technician preset on purpose: what a stock technician is sent is the
   preset's own behaviour. Real migrated database (TEST_DATABASE_URL); the suite skips when it is unset. Every org
   it creates is removed again, and every assertion is about rows the test created in its own org.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, afterEach, vi } from 'vitest';
import { randomUUID } from 'crypto';
import { JobStatus, type PrismaClient } from '@prisma/client';
import { formatInTimeZone } from 'date-fns-tz';
import { COMPLETED_OR_LATER_JOB_STATUSES } from '../lib/job-status-order';

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

// The send route's email goes nowhere: the estimate-leaves-the-tile case sends through the real route, and no message may leave.
vi.mock('../lib/email', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/email')>();
  const sent = async () => ({ status: 'sent' as const, providerMessageId: null, fromAddress: 'noreply@example.test', fromName: null });
  return { ...real, sendEstimateEmail: sent, sendEstimateWithDepositEmail: sent };
});

// The role defaults are fixed data, so the S09.8 cases vary one the only way a test can: the catalog's reader answers
// with these tile ids for a preset while a test has set them, and with the real default otherwise.
const { defaultsInForce } = vi.hoisted(() => ({ defaultsInForce: {} as Record<string, string[] | undefined> }));
vi.mock('../lib/dashboard/tileCatalog', async (importOriginal) => {
  const real = await importOriginal<typeof import('../lib/dashboard/tileCatalog')>();
  return {
    ...real,
    defaultLayoutOf: (preset: Parameters<typeof real.defaultLayoutOf>[0]) => {
      const ids = preset ? defaultsInForce[preset] : undefined;
      return ids ? ids.map((id) => ({ id, visible: true })) : real.defaultLayoutOf(preset);
    },
  };
});

import { switchFixture, type Person } from './permission-switches-fixture';
import { presetValues } from '../lib/permissions/switches/store';
import { clearSwitchCacheForUser } from '../lib/permissions/switches/cache';
import { SWITCH_CATALOG, type SwitchValue } from '../lib/permissions/switches/catalog';
import { defaultLayoutOf, eligibleTiles, TILE_CATALOG, type SwitchValues } from '../lib/dashboard/tileCatalog';

const suite = realClient ? describe : describe.skip;

type Tile = { id: string; category: string; mode: string; label: string | null };
type Answer = { tiles: Tile[]; categories: Array<{ id: string; label: string }>; data: Record<string, any>; generated_at: string };

suite('GET /api/dashboard answers each signed-in person from the records they can open (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  const orgs: string[] = [];
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    // All the companies in one statement per table, not a round trip per company per table.
    const inOrgs = orgs.map((org) => `'${org}'`).join(', ');
    if (orgs.length) {
      await quietly(db.$executeRawUnsafe(`DELETE FROM tasks WHERE organization_id IN (${inOrgs})`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM visit_assignees WHERE organization_id IN (${inOrgs})`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM visits WHERE organization_id IN (${inOrgs})`));
    }
    await fx.cleanup();
  });

  let sequence = 0;
  const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
  const ALL_SCOPES = { leads_scope: 'all', jobs_scope: 'all' };

  /** A person on a fresh custom role made from blank, holding exactly these switch values and every other toggle off. */
  async function personWith(org: string, values: Record<string, boolean | string>, opts: { departmentId?: string } = {}): Promise<Person> {
    const key = `dash-role-${++sequence}`;
    await fx.addCustomRole(org, key, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
    await fx.setRoleSwitches(org, key, { ...allOff, see_prices: true, ...values });
    const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key } });
    return fx.addUser(org, `p${sequence}`, 'TECHNICIAN', { customRoleId: role.id, departmentId: opts.departmentId });
  }

  const dashboardOf = async (person: Person, query = ''): Promise<Answer> => {
    const res = await (await fx.signedInAs(person)).get(`/api/dashboard${query}`);
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Answer;
  };
  const tile = (answer: Answer, id: string) => answer.tiles.find((t) => t.id === id);

  async function newOrg() {
    const made = await fx.newOrg();
    orgs.push(made.org);
    return made;
  }

  /** A paid invoice (one payment today) on a job, made by someone. */
  async function paidInvoice(org: string, customer: string, amount: number, opts: { jobId?: string; createdBy?: string }) {
    const inv = await fx.addInvoice(org, customer, { jobId: opts.jobId, createdBy: opts.createdBy });
    await db.invoice.update({ where: { id: inv.id }, data: { status: 'PAID', sent_at: new Date(), total_amount: amount, amount_due: 0 } });
    await db.payment.create({ data: { invoice_id: inv.id, amount, method: 'CHECK', paid_at: new Date(), state: 'SUCCEEDED' } });
    return inv;
  }

  describe('who gets which tiles', () => {
    it('answers a person whose switches unlock nothing with a normal, empty response', async () => {
      const { org } = await newOrg();
      const nobody = await personWith(org, {});
      const answer = await dashboardOf(nobody);
      expect(answer.tiles).toEqual([]);
      expect(answer.categories).toEqual([]);
      expect(answer.data).toEqual({});
      expect(answer.generated_at).toBeTruthy();
    });

    it('returns exactly the tiles the catalog says the switches unlock, each with a category, mode and label', async () => {
      const { org } = await newOrg();
      const values = { view_jobs: true, view_leads: true, view_invoices: true, jobs_scope: 'attached', leads_scope: 'all' };
      const person = await personWith(org, values);
      const answer = await dashboardOf(person);
      const expected = eligibleTiles({ ...presetValues(null), ...allOff, see_prices: true, ...values } as Record<string, SwitchValue>);
      expect(answer.tiles.map((t) => t.id)).toEqual(expected.map((t) => t.id));
      expect(answer.tiles).toEqual(expected);
      expect(Object.keys(answer.data).sort()).toEqual(expected.map((t) => t.id).filter((id) => !['service_areas', 'recent_calls'].includes(id)).sort());
    });

    it('names the categories of the tiles it sends, and only those: View leads on alone sends Leads and the all-records group', async () => {
      const { org } = await newOrg();
      const answer = await dashboardOf(await personWith(org, { view_leads: true, leads_scope: 'all' }));
      expect(answer.categories).toEqual([
        { id: 'leads', label: 'Leads' },
        { id: 'each_record', label: 'Across your records' },
      ]);
      // Every tile sent belongs to one of the named categories, and every named category has a tile.
      const named = new Set(answer.categories.map((c) => c.id));
      expect(answer.tiles.every((t) => named.has(t.category))).toBe(true);
      expect(answer.categories.every((c) => answer.tiles.some((t) => t.category === c.id))).toBe(true);
    });

    it('offers no invoices-and-payments tile with View invoices off, and no jobs tile with View jobs off', async () => {
      const { org } = await newOrg();
      const noInvoices = await dashboardOf(await personWith(org, { view_jobs: true, view_leads: true, ...ALL_SCOPES }));
      for (const id of ['kpi.revenue_mtd', 'kpi.collected_today', 'kpi.ar', 'kpi.avg_ticket', 'kpi.deposits', 'revenue_chart']) {
        expect(tile(noInvoices, id), id).toBeUndefined();
        expect(noInvoices.data[id], id).toBeUndefined();
      }
      const noJobs = await dashboardOf(await personWith(org, { view_leads: true, view_invoices: true, ...ALL_SCOPES }));
      for (const id of ['kpi.jobs_today', 'kpi.jobs_week', 'schedule_today', 'coming_up', 'jobs_by_status', 'tech_scoreboard']) {
        expect(tile(noJobs, id), id).toBeUndefined();
      }
    });

    it('does not return a tile asked for by id that the switches do not allow', async () => {
      const { org } = await newOrg();
      const person = await personWith(org, { view_jobs: true, ...ALL_SCOPES });
      const answer = await dashboardOf(person, '?tiles=kpi.ar,kpi.jobs_today,smart_insights,nonsense');
      expect(answer.tiles.map((t) => t.id)).toEqual(['kpi.jobs_today']);
      expect(Object.keys(answer.data)).toEqual(['kpi.jobs_today']);
    });

    it('puts money in own mode labelled Yours without See company figures, and by Invoices scope with it', async () => {
      const { org } = await newOrg();
      const department = await fx.addDepartment(org, 'crew');
      const base = { view_invoices: true };
      const without = await dashboardOf(await personWith(org, { ...base, jobs_scope: 'all', leads_scope: 'all' }));
      expect(tile(without, 'kpi.ar')).toMatchObject({ category: 'invoices_and_payments', mode: 'own', label: 'Yours' });
      const modeFor = async (scope: string, opts: { departmentId?: string } = {}) =>
        tile(await dashboardOf(await personWith(org, { ...base, see_company_figures: true, jobs_scope: scope, leads_scope: scope }, opts)), 'kpi.ar');
      expect(await modeFor('all')).toMatchObject({ mode: 'company', label: null });
      expect(await modeFor('attached')).toMatchObject({ mode: 'scope', label: 'Yours' });
      expect(await modeFor('team', { departmentId: department })).toMatchObject({ mode: 'scope', label: 'Your team' });
    });

    it('does not offer Recurring, Revenue by Job Type or Smart Insights without See company figures', async () => {
      const { org } = await newOrg();
      const wide = { view_jobs: true, view_leads: true, view_invoices: true, view_service_plans: true, ...ALL_SCOPES };
      const without = await dashboardOf(await personWith(org, wide));
      for (const id of ['kpi.recurring', 'revenue_by_job_type', 'smart_insights']) expect(tile(without, id), id).toBeUndefined();
      const withIt = await dashboardOf(await personWith(org, { ...wide, see_company_figures: true }));
      for (const id of ['kpi.recurring', 'revenue_by_job_type', 'smart_insights']) expect(tile(withIt, id), id).toMatchObject({ category: 'company_figures', mode: 'company', label: null });
    });
  });

  describe('counts follow the Data Scope', () => {
    it('counts only the jobs and leads an Attached person is on, and drops a job the moment they are taken off it', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { view_jobs: true, view_leads: true, jobs_scope: 'attached', leads_scope: 'attached' });
      const other = await fx.addUser(org, 'othertech', 'TECHNICIAN');
      const mine = await fx.addJob(org, customer, { crew: [me.id] });
      await fx.addVisit(org, { jobId: mine.id, crew: [me.id], daysFromNow: 0, seq: 2 });
      const theirs = await fx.addJob(org, customer, { crew: [other.id] });
      await fx.addVisit(org, { jobId: theirs.id, crew: [other.id], daysFromNow: 0, seq: 2 });
      await fx.addLead(org, customer, { assignees: [me.id] });
      await fx.addLead(org, customer, { assignees: [other.id] });
      await fx.addLead(org, customer, {});

      const before = await dashboardOf(me);
      expect(before.data['kpi.jobs_today'].total).toBe(1);
      expect(before.data['kpi.open_leads'].count).toBe(1);
      expect(tile(before, 'kpi.jobs_today')).toMatchObject({ mode: 'scope', label: null });

      const visits = await db.visit.findMany({ where: { job_id: mine.id } });
      await db.visitAssignee.deleteMany({ where: { visit_id: { in: visits.map((v) => v.id) }, user_id: me.id } });
      const after = await dashboardOf(me);
      expect(after.data['kpi.jobs_today'].total).toBe(0);
    });

    it('counts the whole company for an All-scope person', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { view_jobs: true, view_leads: true, ...ALL_SCOPES });
      for (let i = 0; i < 3; i++) {
        const job = await fx.addJob(org, customer, { crew: [] });
        await fx.addVisit(org, { jobId: job.id, crew: [], daysFromNow: 0, seq: 2 });
        await fx.addLead(org, customer, {});
      }
      const answer = await dashboardOf(me);
      expect(answer.data['kpi.jobs_today'].total).toBe(3);
      expect(answer.data['kpi.open_leads'].count).toBe(3);
      expect(tile(answer, 'kpi.jobs_today')).toMatchObject({ mode: 'company', label: null });
    });

    it('counts only the jobs an Attached person is on in both scoreboards, and Today\'s Schedule shows only their own crew visits', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { view_jobs: true, view_leads: true, jobs_scope: 'attached', leads_scope: 'attached' });
      const other = await fx.addUser(org, 'schedother', 'TECHNICIAN');
      const mine = await fx.addJob(org, customer, { status: 'COMPLETED', crew: [me.id], dispatcher: me.id });
      const theirs = await fx.addJob(org, customer, { status: 'COMPLETED', crew: [other.id], dispatcher: other.id });
      await db.job.updateMany({ where: { id: { in: [mine.id, theirs.id] } }, data: { completed_at: new Date(), amount_invoiced: 100 } });
      const mineToday = await fx.addJob(org, customer, { crew: [me.id] });
      const theirsToday = await fx.addJob(org, customer, { crew: [other.id] });
      for (const [job, who] of [[mineToday, me], [theirsToday, other]] as const) await fx.addVisit(org, { jobId: job.id, crew: [who.id], daysFromNow: 0, seq: 2 });

      const answer = await dashboardOf(me);
      expect(answer.data.tech_scoreboard.map((e: { user_id: string; jobs: number }) => [e.user_id, e.jobs])).toEqual([[me.id, 1]]);
      expect(answer.data.dispatch_scoreboard.map((e: { user_id: string; jobs: number }) => [e.user_id, e.jobs])).toEqual([[me.id, 1]]);
      const lanes = answer.data.schedule_today as { user_id: string | null; jobs: { id: string }[] }[];
      expect(lanes.map((l) => l.user_id)).toEqual([me.id]);
      expect(lanes.flatMap((l) => l.jobs.map((j) => j.id))).toEqual([mineToday.id]);
    });

    it('puts no visit on an Attached person\'s Today\'s Schedule when they are only the Dispatcher or Sold By of the job and someone else is its crew', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { view_jobs: true, jobs_scope: 'attached' });
      const other = await fx.addUser(org, 'jobcrew', 'TECHNICIAN');
      const dispatched = await fx.addJob(org, customer, { crew: [], dispatcher: me.id });
      const sold = await fx.addJob(org, customer, { crew: [], soldBy: me.id });
      for (const job of [dispatched, sold]) await fx.addVisit(org, { jobId: job.id, crew: [other.id], daysFromNow: 0, seq: 2 });

      // The jobs are theirs to open, so the day's trips are in the job count, but the card is for work they are crew on.
      const answer = await dashboardOf(me);
      expect(answer.data['kpi.jobs_today'].total).toBe(2);
      expect(answer.data.schedule_today).toEqual([]);

      // Hand one trip to them: that job, and only that job, is on the card, and the lane names no one else.
      const trip = await db.visit.findFirstOrThrow({ where: { job_id: sold.id, visit_seq: 2 } });
      await db.visitAssignee.deleteMany({ where: { visit_id: trip.id } });
      await db.visitAssignee.create({ data: { visit_id: trip.id, user_id: me.id, organization_id: org } });
      const lanes = (await dashboardOf(me)).data.schedule_today as { user_id: string | null; jobs: { id: string }[] }[];
      expect(lanes.flatMap((l) => l.jobs.map((j) => j.id))).toEqual([sold.id]);
      expect(lanes.map((l) => l.user_id)).toEqual([me.id]);
    });

    it('puts no walkthrough on an Attached person\'s Today\'s Schedule when they are only the Owner or Dispatcher of the lead and someone else is its crew', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { view_jobs: true, view_leads: true, jobs_scope: 'attached', leads_scope: 'attached' });
      const other = await fx.addUser(org, 'leadcrew', 'TECHNICIAN');
      const owned = await fx.addLead(org, customer, { owner: me.id });
      const dispatched = await fx.addLead(org, customer, { dispatcher: me.id });
      for (const lead of [owned, dispatched]) await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [other.id], daysFromNow: 0 });

      expect((await dashboardOf(me)).data.schedule_today).toEqual([]);

      // Hand one walkthrough to them: only that one is on the card, and the lane names no one else.
      const trip = await db.visit.findFirstOrThrow({ where: { lead_id: dispatched.id } });
      await db.visitAssignee.deleteMany({ where: { visit_id: trip.id } });
      await db.visitAssignee.create({ data: { visit_id: trip.id, user_id: me.id, organization_id: org } });
      const lanes = (await dashboardOf(me)).data.schedule_today as { user_id: string | null; jobs: { id: string; entity: string }[] }[];
      expect(lanes.map((l) => l.user_id)).toEqual([me.id]);
      expect(lanes.flatMap((l) => l.jobs.map((j) => `${j.entity}:${j.id}`))).toEqual([`walkthrough:${dispatched.id}`]);
    });
  });

  describe('money follows See company figures, not the Data Scope', () => {
    it('gives an All-scope person without the switch company-wide counts but only their own money, and no revenue column', async () => {
      const { org, customer, admin } = await newOrg();
      const me = await personWith(org, { view_jobs: true, view_leads: true, view_invoices: true, ...ALL_SCOPES });
      const mineJob = await fx.addJob(org, customer, { crew: [me.id], dispatcher: me.id });
      const otherJob = await fx.addJob(org, customer, { crew: [admin.id] });
      await fx.addVisit(org, { jobId: otherJob.id, crew: [admin.id], daysFromNow: 0, seq: 2 });
      await paidInvoice(org, customer, 400, { jobId: mineJob.id });
      await paidInvoice(org, customer, 7000, { jobId: otherJob.id });
      await db.job.updateMany({ where: { organization_id: org }, data: { status: 'COMPLETED', completed_at: new Date(), amount_invoiced: 123 } });
      const lead = await fx.addLead(org, customer, {});
      await db.lead.update({ where: { id: lead.id }, data: { source: 'referral' } });

      const answer = await dashboardOf(me);
      // Counts are the company's...
      expect(answer.data['kpi.jobs_today'].total).toBe(1);
      expect(answer.data['kpi.open_leads'].count).toBe(1);
      expect(answer.data.tech_scoreboard.map((e: { jobs: number }) => e.jobs).sort()).toEqual([1, 1]);
      // ...the money is theirs alone.
      expect(answer.data['kpi.collected_today'].amount).toBe(400);
      expect(answer.data['kpi.revenue_mtd'].collected).toBe(400);
      expect(tile(answer, 'kpi.collected_today')).toMatchObject({ mode: 'own', label: 'Yours' });
      expect(JSON.stringify(answer)).not.toMatch(/7000/);
      for (const entry of [...answer.data.tech_scoreboard, ...answer.data.dispatch_scoreboard, ...answer.data.lead_sources]) {
        expect('revenue' in entry, JSON.stringify(entry)).toBe(false);
      }
      expect(answer.data.lead_sources[0]).toMatchObject({ source: 'referral' });
    });

    it('counts a payment on an invoice someone else made, on a job the person is Dispatcher of, until they are taken off', async () => {
      const { org, customer, admin } = await newOrg();
      const me = await personWith(org, { view_jobs: true, view_invoices: true, ...ALL_SCOPES });
      const job = await fx.addJob(org, customer, { dispatcher: me.id });
      await paidInvoice(org, customer, 250, { jobId: job.id, createdBy: admin.id });

      expect((await dashboardOf(me)).data['kpi.collected_today'].amount).toBe(250);
      await db.job.update({ where: { id: job.id }, data: { dispatcher_id: null } });
      expect((await dashboardOf(me)).data['kpi.collected_today'].amount).toBe(0);
    });

    it('reports Monthly Revenue as payments collected with last month and the goal in company mode, and no goal in own mode', async () => {
      const { org, customer, admin } = await newOrg();
      const wide = { view_invoices: true, ...ALL_SCOPES };
      const company = await personWith(org, { ...wide, see_company_figures: true });
      const own = await personWith(org, wide);
      const inv = await fx.addInvoice(org, customer, { createdBy: admin.id });
      // Invoiced this month for 900, of which 300 is collected: the headline is the 300.
      await db.invoice.update({ where: { id: inv.id }, data: { status: 'PARTIAL', sent_at: new Date(), total_amount: 900, amount_due: 600 } });
      await db.payment.create({ data: { invoice_id: inv.id, amount: 300, method: 'CHECK', paid_at: new Date(), state: 'SUCCEEDED' } });
      await db.appSetting.create({ data: { organization_id: org, key: 'revenue_target_monthly', value: '1500' } });

      const wideAnswer = (await dashboardOf(company)).data['kpi.revenue_mtd'];
      expect(wideAnswer).toMatchObject({ collected: 300, invoiced: 900, collected_last_month: 0, target: 1500, pct_of_goal: 20 });
      const ownAnswer = (await dashboardOf(own)).data['kpi.revenue_mtd'];
      expect('target' in ownAnswer).toBe(false);
      expect('pct_of_goal' in ownAnswer).toBe(false);
    });

    it('builds Smart Insights on its own when Unpaid Balance, Close Rate and Top Lead Sources are not asked for', async () => {
      const { org, customer, admin } = await newOrg();
      const me = await personWith(org, { view_leads: true, view_invoices: true, see_company_figures: true, ...ALL_SCOPES });
      const overdue = await fx.addInvoice(org, customer, { createdBy: admin.id });
      await db.invoice.update({
        where: { id: overdue.id },
        data: { status: 'SENT', sent_at: new Date(Date.now() - 90 * 86_400_000), due_date: new Date(Date.now() - 70 * 86_400_000), total_amount: 5000, amount_due: 5000 },
      });
      const lead = await fx.addLead(org, customer, {});
      await db.lead.update({ where: { id: lead.id }, data: { source: 'google' } });

      const answer = await dashboardOf(me, '?tiles=smart_insights');
      expect(Object.keys(answer.data)).toEqual(['smart_insights']);
      const ids = answer.data.smart_insights.map((i: { id: string }) => i.id);
      expect(ids).toEqual(expect.arrayContaining(['past_due_ar', 'top_source']));
      expect(answer.data.smart_insights.find((i: { id: string }) => i.id === 'past_due_ar').text).toMatch(/\$5k past due/);
    });
  });

  describe('a tile that reads several kinds of record draws each part from its own category', () => {
    it('builds each Revenue Pipeline stage only for the record kinds the person may view, with no amount for another kind', async () => {
      const { org, customer, admin } = await newOrg();
      const leadsOnly = await personWith(org, { view_leads: true, ...ALL_SCOPES });
      await fx.addLead(org, customer, {});
      const lead = await dashboardOf(leadsOnly);
      expect(lead.data.pipeline.map((s: { key: string }) => s.key)).toEqual(['leads']);
      expect(lead.data.pipeline[0].value).toBe(1);

      const wide = await personWith(org, { view_leads: true, view_estimates: true, view_jobs: true, view_invoices: true, ...ALL_SCOPES });
      const keys = (await dashboardOf(wide)).data.pipeline.map((s: { key: string }) => s.key);
      expect(keys).toEqual(['leads', 'estimates', 'approved', 'deposit', 'job', 'invoiced', 'paid']);
      expect(admin.id).toBeTruthy();
    });

    it('sums the Revenue Pipeline stages and the revenue chart over the person\'s own records without See company figures', async () => {
      const { org, customer, admin } = await newOrg();
      const me = await personWith(org, { view_jobs: true, view_invoices: true, ...ALL_SCOPES });
      const mine = await fx.addJob(org, customer, { crew: [me.id] });
      const theirs = await fx.addJob(org, customer, { crew: [admin.id] });
      await paidInvoice(org, customer, 120, { jobId: mine.id });
      await paidInvoice(org, customer, 9999, { jobId: theirs.id });
      const answer = await dashboardOf(me);
      expect(tile(answer, 'pipeline')).toMatchObject({ category: 'each_record', mode: 'own', label: 'Yours' });
      const stage = (key: string) => answer.data.pipeline.find((s: { key: string }) => s.key === key).value;
      expect([stage('invoiced'), stage('paid')]).toEqual([120, 120]);
      const months = answer.data.revenue_chart.months as { collected: number; invoiced: number; is_current: boolean }[];
      expect(months.find((m) => m.is_current)).toMatchObject({ collected: 120, invoiced: 120 });
      expect('target' in answer.data.revenue_chart).toBe(false);
    });

    it('puts a walkthrough on Today\'s Schedule only for a person who may view leads, and an Attached person sees only their own crew', async () => {
      const { org, customer } = await newOrg();
      const crew = await fx.addUser(org, 'wtcrew', 'TECHNICIAN');
      const notOnIt = await fx.addUser(org, 'wtother', 'TECHNICIAN');
      const mineLead = await fx.addLead(org, customer, { assignees: [notOnIt.id] });
      await fx.addVisit(org, { leadId: mineLead.id, purpose: 'WALKTHROUGH', crew: [crew.id], daysFromNow: 0 });
      const lanesOf = async (values: Record<string, boolean | string>) => {
        const answer = await dashboardOf(await personWith(org, { view_jobs: true, ...values }));
        return (answer.data.schedule_today as { jobs: { id: string; entity: string }[] }[]).flatMap((l) => l.jobs.map((j) => j.entity));
      };
      expect(await lanesOf({ ...ALL_SCOPES })).toEqual([]);
      expect(await lanesOf({ view_leads: true, ...ALL_SCOPES })).toEqual(['walkthrough']);
      // Attached: the walkthrough crew's own visit is theirs; someone merely assigned to the lead has no card for it.
      const attached = await personWith(org, { view_jobs: true, view_leads: true, jobs_scope: 'attached', leads_scope: 'attached' });
      await db.visitAssignee.create({ data: { visit_id: (await db.visit.findFirstOrThrow({ where: { lead_id: mineLead.id } })).id, user_id: attached.id, organization_id: org } });
      // The card sits in each performer's lane, so it is the same walkthrough twice.
      const own = (await dashboardOf(attached)).data.schedule_today as { jobs: { id: string; entity: string }[] }[];
      expect([...new Set(own.flatMap((l) => l.jobs.map((j) => `${j.entity}:${j.id}`)))]).toEqual([`walkthrough:${mineLead.id}`]);
      await db.visitAssignee.deleteMany({ where: { user_id: attached.id } });
      expect((await dashboardOf(attached)).data.schedule_today).toEqual([]);
    });
  });

  describe('lists show only records the person can open', () => {
    it('leaves an overdue invoice the person cannot open off Needs Attention, and keeps one on their own job', async () => {
      const { org, customer, admin } = await newOrg();
      const me = await personWith(org, { view_jobs: true, view_invoices: true, jobs_scope: 'attached', leads_scope: 'attached' });
      const mineJob = await fx.addJob(org, customer, { crew: [me.id] });
      const otherJob = await fx.addJob(org, customer, { crew: [admin.id] });
      const overdue = async (jobId: string) => {
        const inv = await fx.addInvoice(org, customer, { jobId });
        await db.invoice.update({
          where: { id: inv.id },
          data: { status: 'SENT', sent_at: new Date(Date.now() - 20 * 86_400_000), due_date: new Date(Date.now() - 5 * 86_400_000), total_amount: 321, amount_due: 321 },
        });
        return inv.id;
      };
      const mine = await overdue(mineJob.id);
      const notMine = await overdue(otherJob.id);

      const items = (await dashboardOf(me)).data.needs_attention as { id: string; type: string }[];
      const invoiceIds = items.filter((i) => i.type === 'overdue_invoice').map((i) => i.id);
      expect(invoiceIds).toEqual([mine]);
      expect(invoiceIds).not.toContain(notMine);
    });

    it('leaves out an event on a job the person cannot open, and shows one on a job they can', async () => {
      const { org, customer, admin } = await newOrg();
      const me = await personWith(org, { view_jobs: true, jobs_scope: 'attached' });
      const mine = await fx.addJob(org, customer, { crew: [me.id] });
      const theirs = await fx.addJob(org, customer, { crew: [admin.id] });
      for (const [job, text] of [[mine, 'event-on-my-job'], [theirs, 'event-on-their-job']] as const) {
        await db.timelineEvent.create({ data: { organization_id: org, entity_type: 'JOB', entity_id: job.id, event_type: 'NOTE', description: text, created_by: admin.id } });
      }
      const feed = (await dashboardOf(me)).data.recent_activity as { description: string }[];
      expect(feed.map((e) => e.description)).toEqual(['event-on-my-job']);
    });

    describe('an event mirrored from an invoice onto its job (S06.6 to S06.9)', () => {
      /** The job's mirror of each kind of invoice event, and the invoice's own entry beside the two that have one. */
      async function mirroredWorld(org: string, customer: string, admin: Person, crew: Person, invoiceMadeBy?: Person) {
        const job = await fx.addJob(org, customer, { crew: [crew.id] });
        const made = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: invoiceMadeBy?.id ?? admin.id });
        const invoice = await db.invoice.findUniqueOrThrow({ where: { id: made.id }, select: { id: true, invoice_number: true } });
        const tag = { invoice_id: invoice.id, invoice_number: invoice.invoice_number };
        const write = (entity_type: string, entity_id: string, event_type: string, description: string, metadata: object) =>
          db.timelineEvent.create({ data: { organization_id: org, entity_type, entity_id, event_type, description, metadata: metadata as never, created_by: admin.id } });
        await write('JOB', job.id, 'JOB_NOTE_ADDED', 'plain-job-note', { note_id: randomUUID() });
        await write('INVOICE', invoice.id, 'PAYMENT_RECEIVED', 'invoice-own-payment', { amount: 90 });
        await write('JOB', job.id, 'JOB_PAYMENT_RECORDED', 'mirror-payment', { ...tag, amount: 90, method: 'CHECK', invoice_event_type: 'PAYMENT_RECEIVED' });
        await write('JOB', job.id, 'JOB_INVOICE_LINE_ADDED', 'mirror-invoice-line', { ...tag, line_id: randomUUID(), old: null, new: { description: 'Hinge' } });
        await write('INVOICE', invoice.id, 'ATTACHMENT_DELETED', 'invoice-own-file', { attachment_id: 'a1' });
        await write('JOB', job.id, 'ATTACHMENT_DELETED', 'mirror-invoice-file', { ...tag, attachment_id: 'a1', invoice_event_type: 'ATTACHMENT_DELETED' });
        return { job, invoice };
      }
      const descriptionsOf = async (p: Person) => ((await dashboardOf(p)).data.recent_activity as { description: string }[]).map((e) => e.description).sort();

      it('keeps all three mirrors, and the invoice id and number, away from a person who can open the job but not the invoice', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, { view_jobs: true, jobs_scope: 'attached' });
        const { invoice } = await mirroredWorld(org, customer, admin, me);

        const answer = await dashboardOf(me);
        expect((answer.data.recent_activity as { description: string }[]).map((e) => e.description)).toEqual(['plain-job-note']);
        expect(JSON.stringify(answer)).not.toContain(invoice.id);
        expect(invoice.invoice_number).toMatch(/^INV-/);
        expect(JSON.stringify(answer)).not.toContain(invoice.invoice_number);
      });

      it('keeps them away when View invoices is on but the invoices scope does not reach the invoice', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, { view_jobs: true, view_invoices: true, jobs_scope: 'attached', leads_scope: 'attached' });
        const other = await fx.addUser(org, 'othercrew', 'TECHNICIAN');
        const job = await fx.addJob(org, customer, { crew: [me.id, other.id] });
        // The invoice sits on a job the person is on, but a different one: the scope keys on the invoice's own attachment.
        const elsewhere = await fx.addJob(org, customer, { crew: [admin.id] });
        const made = await fx.addInvoice(org, customer, { jobId: elsewhere.id, createdBy: admin.id });
        const invoice = await db.invoice.findUniqueOrThrow({ where: { id: made.id }, select: { id: true, invoice_number: true } });
        await db.timelineEvent.create({
          data: {
            organization_id: org, entity_type: 'JOB', entity_id: job.id, event_type: 'JOB_PAYMENT_RECORDED', description: 'mirror-payment',
            metadata: { invoice_id: invoice.id, invoice_number: invoice.invoice_number, amount: 5, method: 'CHECK' }, created_by: admin.id,
          },
        });
        expect(await descriptionsOf(me)).toEqual([]);
      });

      it('lists each mirror once, and drops the invoice\'s own entry beside it, for a person who can open the invoice', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, { view_jobs: true, view_invoices: true, jobs_scope: 'attached' });
        await mirroredWorld(org, customer, admin, me);
        expect(await descriptionsOf(me)).toEqual(['mirror-invoice-file', 'mirror-invoice-line', 'mirror-payment', 'plain-job-note']);
      });

      it('keeps the mirrors from the person who made the invoice while attached to its job, with View invoices off (P7)', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, { view_jobs: true, jobs_scope: 'attached' });
        await mirroredWorld(org, customer, admin, me, me);
        expect(await descriptionsOf(me)).toEqual(['plain-job-note']);
      });

      it('lists a pair once in the Admin box too, and still shows everything else', async () => {
        const { org, customer, admin } = await newOrg();
        const crew = await fx.addUser(org, 'adminworldcrew', 'TECHNICIAN');
        await mirroredWorld(org, customer, admin, crew);
        expect(await descriptionsOf(admin)).toEqual(['mirror-invoice-file', 'mirror-invoice-line', 'mirror-payment', 'plain-job-note']);
      });
    });

    it('shows a task event to its assignee, hides it from a stranger, and shows it with the file name to See all tasks', async () => {
      const { org, admin } = await newOrg();
      const base = { view_tasks: true };
      const assignee = await personWith(org, base);
      const stranger = await personWith(org, base);
      const everything = await personWith(org, { ...base, tasks_scope: 'all' });
      const task = await db.task.create({
        data: { organization_id: org, task_number: `T-${randomUUID().slice(0, 6)}`, title: 'Review', assignee_ids: [assignee.id], created_by: admin.id },
      });
      await db.timelineEvent.create({
        data: { organization_id: org, entity_type: 'TASK', entity_id: task.id, event_type: 'ATTACHMENT_UPLOADED', description: 'File uploaded: payroll-sheet.pdf', created_by: admin.id },
      });
      const feedOf = async (p: Person) => ((await dashboardOf(p)).data.recent_activity as { description: string }[]).map((e) => e.description);

      expect(await feedOf(assignee)).toEqual(['File uploaded: payroll-sheet.pdf']);
      expect(await feedOf(stranger)).toEqual([]);
      expect(await feedOf(everything)).toEqual(['File uploaded: payroll-sheet.pdf']);
    });

    it('credits a job to the Dispatcher it has now, after a reassignment', async () => {
      const { org, customer } = await newOrg();
      const viewer = await personWith(org, { view_jobs: true, ...ALL_SCOPES });
      const first = await fx.addUser(org, 'firstdisp', 'DISPATCHER');
      const second = await fx.addUser(org, 'seconddisp', 'DISPATCHER');
      const job = await fx.addJob(org, customer, { status: 'COMPLETED', dispatcher: first.id });
      await db.job.update({ where: { id: job.id }, data: { completed_at: new Date() } });
      const credit = async (who: Person) =>
        ((await dashboardOf(viewer)).data.dispatch_scoreboard as { user_id: string; jobs: number }[]).find((e) => e.user_id === who.id)?.jobs ?? 0;
      expect([await credit(first), await credit(second)]).toEqual([1, 0]);
      await db.job.update({ where: { id: job.id }, data: { dispatcher_id: second.id } });
      expect([await credit(first), await credit(second)]).toEqual([0, 1]);
    });
  });

  describe('nothing outside the person\'s reach is in the answer at all', () => {
    /** Strings that identify a record the person cannot open: if one appears anywhere in the answer, it leaked. */
    async function buildForeignWorld(org: string, admin: Person, me: Person) {
      const foreign: string[] = [];
      const mineCustomer = randomUUID();
      await db.customer.create({
        data: { id: mineCustomer, organization_id: org, customer_number: 'C-MINE', kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Mineowner', last_name: 'Ownerson' },
      });
      const crew = await fx.addUser(org, 'foreigncrew', 'TECHNICIAN');
      foreign.push(crew.id, 'foreigncrew');
      for (let i = 0; i < 3; i++) {
        const customerId = randomUUID();
        const name = `Zorblax${i}`;
        await db.customer.create({
          data: { id: customerId, organization_id: org, customer_number: `C-F${i}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: name, last_name: `Quillfeather${i}` },
        });
        foreign.push(name, `Quillfeather${i}`);
        const job = await fx.addJob(org, customerId, { crew: [crew.id], dispatcher: admin.id, status: i === 0 ? 'COMPLETED' : 'SCHEDULED' });
        const row = await db.job.update({ where: { id: job.id }, data: { completed_at: new Date(), amount_invoiced: 4321 + i }, include: { service_location: true } });
        await db.serviceLocation.update({ where: { id: row.service_location_id }, data: { address_line1: `${90 + i} Wombat Gulch Road` } });
        await fx.addVisit(org, { jobId: job.id, crew: [crew.id], daysFromNow: 0, seq: 2 });
        await fx.addVisit(org, { jobId: job.id, crew: [], daysFromNow: 1, seq: 3 });
        foreign.push(job.id, row.job_number, `${90 + i} Wombat Gulch Road`);
        const lead = await fx.addLead(org, customerId, { assignees: [admin.id], walkthroughCrew: [crew.id] });
        const leadRow = await db.lead.update({ where: { id: lead.id }, data: { source: `yelp${i}` } });
        foreign.push(lead.id, leadRow.lead_number, `Yelp${i}`);
        const inv = await fx.addInvoice(org, customerId, { jobId: job.id, createdBy: admin.id });
        const invRow = await db.invoice.update({
          where: { id: inv.id },
          data: { status: 'SENT', sent_at: new Date(Date.now() - 20 * 86_400_000), due_date: new Date(Date.now() - 5 * 86_400_000), total_amount: 777 + i, amount_due: 777 + i },
        });
        foreign.push(inv.id, invRow.invoice_number);
        await db.timelineEvent.create({
          data: { organization_id: org, entity_type: 'JOB', entity_id: job.id, event_type: 'NOTE', description: `note on ${row.job_number}`, created_by: admin.id },
        });
        await db.timelineEvent.create({
          data: { organization_id: org, entity_type: 'LEAD', entity_id: lead.id, event_type: 'NOTE', description: `note on ${leadRow.lead_number}`, created_by: admin.id },
        });
      }
      // Something of their own, so the answer is not empty for the right reason.
      const own = await fx.addJob(org, mineCustomer, { crew: [me.id] });
      await fx.addVisit(org, { jobId: own.id, crew: [me.id], daysFromNow: 0, seq: 2 });
      await fx.addLead(org, mineCustomer, { assignees: [me.id] });
      return { foreign, ownJob: own.id };
    }

    it('sends a person with every switch off nothing at all', async () => {
      const { org, admin } = await newOrg();
      const nobody = await personWith(org, {});
      const { foreign } = await buildForeignWorld(org, admin, nobody);
      const text = JSON.stringify(await dashboardOf(nobody));
      for (const token of foreign) expect(text, token).not.toContain(token);
      expect((await dashboardOf(nobody)).tiles).toEqual([]);
    });

    it('sends a person on the Technician preset only what they are on', async () => {
      const { org, admin } = await newOrg();
      const stock = await fx.addUser(org, 'stocktech', 'TECHNICIAN');
      const { foreign, ownJob } = await buildForeignWorld(org, admin, stock);
      const answer = await dashboardOf(stock);
      const text = JSON.stringify(answer);
      for (const token of foreign) expect(text, token).not.toContain(token);
      // Their own work is there: the counts are theirs, not the company's, and their own job is on the day's schedule.
      expect(answer.data['kpi.jobs_today'].total).toBe(1);
      expect(answer.data['kpi.open_leads'].count).toBe(1);
      expect(JSON.stringify(answer.data.schedule_today)).toContain(ownJob);
      expect(answer.data.jobs_by_status.reduce((n: number, s: { count: number }) => n + s.count, 0)).toBe(1);
      // No company money and no invoice tile on the preset.
      expect(answer.tiles.map((t) => t.category)).not.toContain('invoices_and_payments');
      expect(answer.tiles.map((t) => t.category)).not.toContain('company_figures');
      expect(text).not.toMatch(/4321|4322|4323/);
    });
  });
  describe('the Unscheduled jobs tile (S09.9)', () => {
    const UNSCHEDULED = 'unscheduled_jobs';
    type Row = { id: string; job_number: string; title: string; address: string; age_days: number; link: string };
    type UnscheduledData = { count: number; jobs: Row[] };
    const JOBS = { view_jobs: true, jobs_scope: 'all' };
    const dataOf = (answer: Answer) => answer.data[UNSCHEDULED] as UnscheduledData;
    /** Book a trip the way the office does, so the server derives the job's status from its visits. */
    async function bookVisit(org: string, admin: Person, jobId: string) {
      const start = new Date(Date.now() + 2 * 86_400_000);
      const res = await (await fx.signedInAs(admin)).post(`/api/jobs/${jobId}/visits`, {
        scheduled_start: start.toISOString(),
        scheduled_end: new Date(start.getTime() + 3_600_000).toISOString(),
      });
      expect(res.status, JSON.stringify(res.body)).toBeLessThan(300);
      return res.body as { id?: string; visit?: { id: string } };
    }
    const statusOf = async (jobId: string) => (await db.job.findUniqueOrThrow({ where: { id: jobId } })).status;

    it('is a Jobs tile that View jobs unlocks, and is neither sent nor computed without it, even when asked for by id', async () => {
      const { org, customer } = await newOrg();
      await fx.addJob(org, customer, { status: 'UNSCHEDULED' });
      const holder = await dashboardOf(await personWith(org, JOBS));
      expect(tile(holder, UNSCHEDULED)).toMatchObject({ category: 'jobs', mode: 'company', label: null });
      expect(holder.categories.find((c) => c.id === 'jobs')?.label).toBe('Jobs');

      const without = await personWith(org, { view_leads: true, leads_scope: 'all' });
      const answer = await dashboardOf(without);
      expect(tile(answer, UNSCHEDULED)).toBeUndefined();
      expect(answer.data[UNSCHEDULED]).toBeUndefined();
      const byId = await dashboardOf(without, `?tiles=${UNSCHEDULED}`);
      expect(byId.tiles).toEqual([]);
      expect(byId.data).toEqual({});
    });

    it('lists a job whose status is Unscheduled, and drops it once a visit is booked', async () => {
      const { org, customer, admin } = await newOrg();
      const me = await personWith(org, JOBS);
      const job = await fx.addJob(org, customer, { status: 'UNSCHEDULED' });
      const before = dataOf(await dashboardOf(me));
      expect(before.count).toBe(1);
      expect(before.jobs).toHaveLength(1);
      expect(before.jobs[0]).toMatchObject({ id: job.id, title: 'Pat Payer', address: '1 Test Way, Testville', age_days: 0, link: `/jobs/${job.id}` });
      expect(before.jobs[0]!.job_number).toBe((await db.job.findUniqueOrThrow({ where: { id: job.id } })).job_number);

      await bookVisit(org, admin, job.id);
      expect(await statusOf(job.id)).toBe('SCHEDULED');
      const after = dataOf(await dashboardOf(me));
      expect(after.count).toBe(0);
      expect(after.jobs).toEqual([]);
    });

    it('keeps out a job whose only visit is finished but which was not marked Completed', async () => {
      const { org, customer, admin } = await newOrg();
      const me = await personWith(org, JOBS);
      const job = await fx.addJob(org, customer, { status: 'UNSCHEDULED' });
      const booked = await bookVisit(org, admin, job.id);
      const visitId = (booked.visit?.id ?? booked.id)!;
      const as = await fx.signedInAs(admin);
      expect((await as.post(`/api/jobs/${job.id}/visits/${visitId}/start`)).status).toBeLessThan(300);
      expect((await as.post(`/api/jobs/${job.id}/visits/${visitId}/complete`)).status).toBeLessThan(300);
      expect(await statusOf(job.id)).toBe('IN_PROGRESS');
      const answer = dataOf(await dashboardOf(me));
      expect(answer.count).toBe(0);
      expect(answer.jobs).toEqual([]);
    });

    it('lists only Unscheduled jobs: every other job status, Cancelled and the completed-or-later set included, is out', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, JOBS);
      const wanted = await fx.addJob(org, customer, { status: 'UNSCHEDULED' });
      const others = [];
      for (const status of Object.values(JobStatus).filter((s) => s !== 'UNSCHEDULED')) others.push(await fx.addJob(org, customer, { status }));
      // The statuses the PRD names are among those left out.
      for (const status of ['CANCELLED', ...COMPLETED_OR_LATER_JOB_STATUSES]) expect(Object.values(JobStatus)).toContain(status);
      const answer = dataOf(await dashboardOf(me));
      expect(answer.count).toBe(1);
      expect(answer.jobs.map((r) => r.id)).toEqual([wanted.id]);
      for (const other of others) expect(JSON.stringify(answer)).not.toContain(other.id);
    });

    it('counts only the jobs an Attached person is on, and every Unscheduled job for an All-scope person', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { ...JOBS, jobs_scope: 'attached' });
      const other = await fx.addUser(org, 'unsched-other', 'TECHNICIAN');
      const dispatched = await fx.addJob(org, customer, { status: 'UNSCHEDULED', dispatcher: me.id });
      const sold = await fx.addJob(org, customer, { status: 'UNSCHEDULED', soldBy: me.id });
      const theirs = await fx.addJob(org, customer, { status: 'UNSCHEDULED', dispatcher: other.id });
      const nobodys = await fx.addJob(org, customer, { status: 'UNSCHEDULED' });

      const attachedAnswer = await dashboardOf(me);
      expect(tile(attachedAnswer, UNSCHEDULED)).toMatchObject({ mode: 'scope', label: null });
      const mine = dataOf(attachedAnswer);
      expect(mine.count).toBe(2);
      expect(mine.jobs.map((r) => r.id).sort()).toEqual([dispatched.id, sold.id].sort());
      expect(JSON.stringify(mine)).not.toContain(theirs.id);
      expect(JSON.stringify(mine)).not.toContain(nobodys.id);

      const everyone = dataOf(await dashboardOf(await personWith(org, JOBS)));
      expect(everyone.count).toBe(4);
      expect(everyone.jobs.map((r) => r.id).sort()).toEqual([dispatched.id, sold.id, theirs.id, nobodys.id].sort());
    });

    it('counts every job in the person\'s scope but lists only the five that have waited longest, oldest first', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, JOBS);
      const made = [];
      for (let days = 1; days <= 7; days++) {
        const job = await fx.addJob(org, customer, { status: 'UNSCHEDULED' });
        await db.job.update({ where: { id: job.id }, data: { created_at: new Date(Date.now() - days * 86_400_000 - 60_000) } });
        made.push({ id: job.id, days });
      }
      const answer = dataOf(await dashboardOf(me));
      expect(answer.count).toBe(7);
      expect(answer.jobs).toHaveLength(5);
      expect(answer.jobs.map((r) => r.id)).toEqual(made.slice().reverse().slice(0, 5).map((m) => m.id));
      expect(answer.jobs.map((r) => r.age_days)).toEqual([7, 6, 5, 4, 3]);
    });

    it('sends View all (the Jobs list, filtered to Unscheduled) with View jobs alone (no Show page switch exists), and the rows open the job', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer, { status: 'UNSCHEDULED' });
      const open = await dashboardOf(await personWith(org, JOBS));
      expect((tile(open, UNSCHEDULED) as Tile & { link: string | null }).link).toBe('/jobs?status=UNSCHEDULED');
      expect(dataOf(open).jobs.map((r) => [r.id, r.link])).toEqual([[job.id, `/jobs/${job.id}`]]);
    });

    it('gives a person with nothing waiting a normal empty answer', async () => {
      const { org } = await newOrg();
      const answer = dataOf(await dashboardOf(await personWith(org, JOBS)));
      expect(answer).toEqual({ count: 0, jobs: [] });
    });
  });

  describe('the Office review queue tile (S09.10)', () => {
    const QUEUE = 'office_review_queue';
    type Row = { id: string; job_number: string; title: string; address: string; age_days: number; link: string };
    type QueueData = { count: number; jobs: Row[] };
    // Office review requires View jobs (the switch catalog refuses a set that holds it without), so a holder always reads jobs.
    const HOLDER = { view_jobs: true, jobs_scope: 'all', office_review: true };
    const dataOf = (answer: Answer) => answer.data[QUEUE] as QueueData;
    const linkOfTile = (answer: Answer) => (tile(answer, QUEUE) as (Tile & { link: string | null }) | undefined)?.link;
    /** What the Jobs menu shows this person: the queue rule's own endpoint. */
    const menuCount = async (person: Person) => {
      const res = await (await fx.signedInAs(person)).get('/api/jobs/review-queue');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return (res.body as { office_review?: number }).office_review;
    };
    const waitingSince = async (jobId: string, days: number) =>
      db.job.update({ where: { id: jobId }, data: { created_at: new Date(Date.now() - days * 86_400_000 - 60_000) } });

    it('is an Office review tile that the Office review switch unlocks, and is neither sent nor computed without it, even when asked for by id', async () => {
      const { org, customer } = await newOrg();
      await fx.addJob(org, customer, { status: 'OFFICE_REVIEW' });
      const holder = await dashboardOf(await personWith(org, HOLDER));
      expect(tile(holder, QUEUE)).toMatchObject({ category: 'office_review', mode: 'company', label: null });
      expect(holder.categories.find((c) => c.id === 'office_review')?.label).toBe('Office review');

      const without = await personWith(org, { view_jobs: true, jobs_scope: 'all' });
      const answer = await dashboardOf(without);
      expect(tile(answer, QUEUE)).toBeUndefined();
      expect(answer.data[QUEUE]).toBeUndefined();
      const byId = await dashboardOf(without, `?tiles=${QUEUE}`);
      expect(byId.tiles).toEqual([]);
      expect(byId.data).toEqual({});
    });

    it('is offered under every Jobs scope, and the switch catalog refuses Office review without View jobs, so a person never holds the one without the other', async () => {
      const { org, customer } = await newOrg();
      await fx.addJob(org, customer, { status: 'OFFICE_REVIEW' });
      for (const scope of ['attached', 'all']) {
        const answer = await dashboardOf(await personWith(org, { ...HOLDER, jobs_scope: scope }));
        expect(tile(answer, QUEUE), scope).toBeDefined();
      }
      await expect(personWith(org, { office_review: true, view_jobs: false })).rejects.toThrow();
    });

    it('lists a job in Office review for a holder who is not on it, and drops it once it is no longer in Office review', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, HOLDER);
      const job = await fx.addJob(org, customer, { status: 'OFFICE_REVIEW' });
      const answer = dataOf(await dashboardOf(me));
      expect(answer.count).toBe(1);
      expect(answer.jobs[0]).toMatchObject({ id: job.id, title: 'Pat Payer', address: '1 Test Way, Testville', age_days: 0, link: `/jobs/${job.id}?panel=review` });
      expect(answer.jobs[0]!.job_number).toBe((await db.job.findUniqueOrThrow({ where: { id: job.id } })).job_number);

      await db.job.update({ where: { id: job.id }, data: { status: 'READY_TO_CLOSE' } });
      expect(dataOf(await dashboardOf(me))).toEqual({ count: 0, jobs: [] });
    });

    it('lists only Office review: every other job status, Ready to close included, is out even for a holder of Close jobs', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { ...HOLDER, close_jobs: true });
      const wanted = await fx.addJob(org, customer, { status: 'OFFICE_REVIEW' });
      const others = [];
      for (const status of Object.values(JobStatus).filter((s) => s !== 'OFFICE_REVIEW')) others.push(await fx.addJob(org, customer, { status }));
      const answer = dataOf(await dashboardOf(me));
      expect(answer.count).toBe(1);
      expect(answer.jobs.map((r) => r.id)).toEqual([wanted.id]);
      for (const other of others) expect(JSON.stringify(answer)).not.toContain(other.id);
    });

    it('reaches a job the holder is not on under All scope, and only the jobs inside the reach under Attached scope', async () => {
      const { org, customer } = await newOrg();
      const attached = await personWith(org, { ...HOLDER, jobs_scope: 'attached' });
      const other = await fx.addUser(org, 'queue-other', 'TECHNICIAN');
      const dispatched = await fx.addJob(org, customer, { status: 'OFFICE_REVIEW', dispatcher: attached.id });
      const sold = await fx.addJob(org, customer, { status: 'OFFICE_REVIEW', soldBy: attached.id });
      const theirs = await fx.addJob(org, customer, { status: 'OFFICE_REVIEW', dispatcher: other.id });
      const nobodys = await fx.addJob(org, customer, { status: 'OFFICE_REVIEW' });

      const mine = dataOf(await dashboardOf(attached));
      expect(mine.count).toBe(2);
      expect(mine.jobs.map((r) => r.id).sort()).toEqual([dispatched.id, sold.id].sort());
      expect(JSON.stringify(mine)).not.toContain(theirs.id);
      expect(JSON.stringify(mine)).not.toContain(nobodys.id);

      const everyone = dataOf(await dashboardOf(await personWith(org, HOLDER)));
      expect(everyone.count).toBe(4);
      expect(everyone.jobs.map((r) => r.id).sort()).toEqual([dispatched.id, sold.id, theirs.id, nobodys.id].sort());
    });

    it('never reaches a job of another organization', async () => {
      const { org, customer } = await newOrg();
      const elsewhere = await newOrg();
      const stranger = await fx.addJob(elsewhere.org, elsewhere.customer, { status: 'OFFICE_REVIEW' });
      const mine = await fx.addJob(org, customer, { status: 'OFFICE_REVIEW' });
      const answer = dataOf(await dashboardOf(await personWith(org, HOLDER)));
      expect(answer.jobs.map((r) => r.id)).toEqual([mine.id]);
      expect(JSON.stringify(answer)).not.toContain(stranger.id);
    });

    it('counts exactly what the Jobs menu counts for the same person on the same jobs, under All scope and Attached scope', async () => {
      const { org, customer } = await newOrg();
      const all = await personWith(org, HOLDER);
      const attached = await personWith(org, { ...HOLDER, jobs_scope: 'attached' });
      const other = await fx.addUser(org, 'queue-count-other', 'TECHNICIAN');
      await fx.addJob(org, customer, { status: 'OFFICE_REVIEW', dispatcher: attached.id });
      await fx.addJob(org, customer, { status: 'OFFICE_REVIEW', dispatcher: other.id });
      await fx.addJob(org, customer, { status: 'OFFICE_REVIEW' });
      await fx.addJob(org, customer, { status: 'READY_TO_CLOSE', dispatcher: attached.id });
      await fx.addJob(org, customer, { status: 'IN_PROGRESS', dispatcher: attached.id });

      for (const person of [all, attached]) {
        const tileCount = dataOf(await dashboardOf(person)).count;
        expect(tileCount).toBe(await menuCount(person));
      }
      expect(dataOf(await dashboardOf(all)).count).toBe(3);
      expect(dataOf(await dashboardOf(attached)).count).toBe(1);
    });

    it('counts every job waiting but lists only the five that have waited longest, oldest first', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, HOLDER);
      const made = [];
      for (let days = 1; days <= 7; days++) {
        const job = await fx.addJob(org, customer, { status: 'OFFICE_REVIEW' });
        await waitingSince(job.id, days);
        made.push({ id: job.id, days });
      }
      const answer = dataOf(await dashboardOf(me));
      expect(answer.count).toBe(7);
      expect(answer.count).toBe(await menuCount(me));
      expect(answer.jobs).toHaveLength(5);
      expect(answer.jobs.map((r) => r.id)).toEqual(made.slice().reverse().slice(0, 5).map((m) => m.id));
      expect(answer.jobs.map((r) => r.age_days)).toEqual([7, 6, 5, 4, 3]);
    });

    it('sends View all (the Jobs list filtered to Office review) with View jobs alone, and the Jobs list it opens holds exactly the jobs the tile counts', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer, { status: 'OFFICE_REVIEW' });
      await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
      const holder = await personWith(org, HOLDER);
      const open = await dashboardOf(holder);
      const viewAll = linkOfTile(open)!;
      expect(viewAll).toBe('/jobs?in_office_review=true');

      // Follow the address the tile sent: the list holds the counted jobs and no others.
      const list = await (await fx.signedInAs(holder)).get(`/api/jobs${viewAll.slice('/jobs'.length)}`);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect((list.body.data ?? list.body.jobs).map((j: { id: string }) => j.id)).toEqual([job.id]);
      expect(list.body.pagination?.total ?? list.body.total).toBe(dataOf(open).count);

      expect(dataOf(open).jobs.map((r) => [r.id, r.link])).toEqual([[job.id, `/jobs/${job.id}?panel=review`]]);
    });

    it('gives a person with nothing waiting a normal empty answer', async () => {
      const { org } = await newOrg();
      expect(dataOf(await dashboardOf(await personWith(org, HOLDER)))).toEqual({ count: 0, jobs: [] });
    });
  });

  describe('Missing lead owner: the tile, the Needs Attention item and the Open Leads line (S09.11)', () => {
    const MISSING = 'missing_lead_owner';
    const OPEN_LEADS_TILE = 'kpi.open_leads';
    type Oldest = { id: string; lead_number: string; title: string; age_days: number; link: string };
    type MissingData = { count: number; oldest: Oldest | null };
    type Item = { id: string; type: string; title: string; meta: string; badge: string; link: string | null };
    const LEADS = { view_leads: true, leads_scope: 'all' };
    const ATTACHED = { ...LEADS, leads_scope: 'attached' };
    const dataOf = (answer: Answer) => answer.data[MISSING] as MissingData;
    const itemOf = (answer: Answer) => (answer.data.needs_attention as Item[]).find((i) => i.type === 'missing_lead_owner');
    const lineOf = (answer: Answer) => (answer.data[OPEN_LEADS_TILE] as { count: number; no_owner: number }).no_owner;
    const linkOfTile = (answer: Answer) => (tile(answer, MISSING) as (Tile & { link: string | null }) | undefined)?.link;
    const withStatus = async (org: string, customer: string, status: 'NEW' | 'CONTACTED' | 'WALKTHROUGH_SCHEDULED' | 'WALKTHROUGH_COMPLETED' | 'ESTIMATED' | 'WON' | 'LOST', opts: Parameters<typeof fx.addLead>[2] = {}) => {
      const lead = await fx.addLead(org, customer, opts);
      if (status !== 'NEW') await db.lead.update({ where: { id: lead.id }, data: { status } });
      return lead;
    };
    const openedSince = (leadId: string, days: number) =>
      db.lead.update({ where: { id: leadId }, data: { created_at: new Date(Date.now() - days * 86_400_000 - 60_000) } });
    /** What the Leads page shows this person on its No owner card, and the leads its No owner filter returns. */
    const leadsPage = async (person: Person) => {
      const api = await fx.signedInAs(person);
      const all = await api.get('/api/leads?limit=100');
      const filtered = await api.get('/api/leads?limit=100&assigned_to=NO_OWNER');
      expect(all.status, JSON.stringify(all.body)).toBe(200);
      expect(filtered.status, JSON.stringify(filtered.body)).toBe(200);
      return { card: all.body.stats.no_owner as number, filtered: (filtered.body.leads as Array<{ id: string }>).map((l) => l.id).sort() };
    };

    it('is a Leads tile that View leads unlocks under every Leads scope, and is neither sent nor computed without it, even when asked for by id', async () => {
      const { org, customer } = await newOrg();
      await fx.addLead(org, customer);
      for (const scope of ['attached', 'all']) {
        const answer = await dashboardOf(await personWith(org, { ...LEADS, leads_scope: scope }));
        expect(tile(answer, MISSING), scope).toMatchObject({ category: 'leads' });
      }
      const without = await personWith(org, { view_jobs: true, view_invoices: true, ...ALL_SCOPES });
      expect(tile(await dashboardOf(without), MISSING)).toBeUndefined();
      const byId = await dashboardOf(without, `?tiles=${MISSING}`);
      expect(byId.tiles).toEqual([]);
      expect(byId.data).toEqual({});
    });

    it('counts an open lead with no Owner even when it has a Dispatcher and a walkthrough crew, and drops it once an Owner is set', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, LEADS);
      const other = await fx.addUser(org, 'mlo-other', 'TECHNICIAN');
      const lead = await fx.addLead(org, customer, { dispatcher: other.id, walkthroughCrew: [other.id] });
      const before = await dashboardOf(me);
      expect(dataOf(before).count).toBe(1);
      expect(lineOf(before)).toBe(1);
      expect(itemOf(before)?.title).toBe('1 lead with no owner');

      await db.lead.update({ where: { id: lead.id }, data: { commission_owner_id: other.id } });
      const after = await dashboardOf(me);
      expect(dataOf(after)).toEqual({ count: 0, oldest: null });
      expect(lineOf(after)).toBe(0);
      expect(itemOf(after)).toBeUndefined();
    });

    it('counts Walkthrough Scheduled and Walkthrough Completed leads with no Owner, and no Won or Lost one', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, LEADS);
      for (const status of ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'] as const) await withStatus(org, customer, status);
      const closed = [await withStatus(org, customer, 'WON'), await withStatus(org, customer, 'LOST')];
      const answer = await dashboardOf(me);
      expect(dataOf(answer).count).toBe(5);
      expect(lineOf(answer)).toBe(5);
      expect(itemOf(answer)?.title).toBe('5 leads with no owner');
      for (const lead of closed) expect(JSON.stringify(answer.data)).not.toContain(lead.id);
    });

    it('counts a lead again once it is reopened with no Owner, and not while it stays Won', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, LEADS);
      const lead = await withStatus(org, customer, 'WON');
      expect(dataOf(await dashboardOf(me)).count).toBe(0);
      await db.lead.update({ where: { id: lead.id }, data: { status: 'CONTACTED' } });
      const reopened = await dashboardOf(me);
      expect(dataOf(reopened).count).toBe(1);
      expect(dataOf(reopened).oldest?.id).toBe(lead.id);
    });

    it('names the oldest one by lead number, customer and days open, and counts the rest', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, LEADS);
      const newest = await fx.addLead(org, customer);
      const oldest = await fx.addLead(org, customer);
      const middle = await fx.addLead(org, customer);
      await openedSince(oldest.id, 9);
      await openedSince(middle.id, 4);
      const answer = await dashboardOf(me);
      const stored = await db.lead.findUniqueOrThrow({ where: { id: oldest.id } });
      expect(dataOf(answer)).toEqual({
        count: 3,
        oldest: { id: oldest.id, lead_number: stored.lead_number, title: 'Pat Payer', age_days: 9, link: `/leads/${oldest.id}` },
      });
      expect(JSON.stringify(dataOf(answer))).not.toContain(newest.id);
      expect(itemOf(answer)).toMatchObject({ title: '3 leads with no owner', meta: 'Oldest: Pat Payer · 9 days open', badge: '3' });
    });

    it('says "1 day open" for a lead opened yesterday', async () => {
      const { org, customer } = await newOrg();
      const lead = await fx.addLead(org, customer);
      await openedSince(lead.id, 1);
      expect(itemOf(await dashboardOf(await personWith(org, LEADS)))?.meta).toBe('Oldest: Pat Payer · 1 day open');
    });

    it('reaches, under Attached scope, a lead the person is Dispatcher or walkthrough crew of, and a lead with nobody on it only under All scope', async () => {
      const { org, customer } = await newOrg();
      const attached = await personWith(org, ATTACHED);
      const all = await personWith(org, LEADS);
      const other = await fx.addUser(org, 'mlo-attached-other', 'TECHNICIAN');
      const dispatched = await fx.addLead(org, customer, { dispatcher: attached.id });
      const onWalkthrough = await fx.addLead(org, customer, { walkthroughCrew: [attached.id] });
      const theirs = await fx.addLead(org, customer, { dispatcher: other.id });
      const nobodys = await fx.addLead(org, customer);

      const mine = await dashboardOf(attached);
      expect(dataOf(mine).count).toBe(2);
      expect(lineOf(mine)).toBe(2);
      expect(itemOf(mine)?.title).toBe('2 leads with no owner');
      expect([dispatched.id, onWalkthrough.id]).toContain(dataOf(mine).oldest!.id);
      for (const unreachable of [theirs.id, nobodys.id]) expect(JSON.stringify(mine.data)).not.toContain(unreachable);

      const everyone = await dashboardOf(all);
      expect(dataOf(everyone).count).toBe(4);
      expect(lineOf(everyone)).toBe(4);
    });

    it('never reaches a lead of another organization', async () => {
      const { org, customer } = await newOrg();
      const elsewhere = await newOrg();
      const stranger = await fx.addLead(elsewhere.org, elsewhere.customer);
      const mine = await fx.addLead(org, customer);
      const answer = await dashboardOf(await personWith(org, LEADS));
      expect(dataOf(answer).count).toBe(1);
      expect(dataOf(answer).oldest?.id).toBe(mine.id);
      expect(JSON.stringify(answer.data)).not.toContain(stranger.id);
    });

    it('finds the lead of a creator who was pre-filled as Dispatcher (Can own leads off, Can be a dispatcher on) in their own Missing lead owner, with no role name checked', async () => {
      const { org, customer } = await newOrg();
      // A Technician base with Can be a dispatcher on, so no base-role check can produce this answer.
      const key = `mlo-creator-${++sequence}`;
      await fx.addCustomRole(org, key, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
      await fx.setRoleSwitches(org, key, { ...allOff, see_prices: true, ...ATTACHED, edit_leads: true, create_leads: true, can_own_leads: false, can_be_dispatcher: true });
      const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key } });
      const creator = await fx.addUser(org, `mlo-creator-p${sequence}`, 'TECHNICIAN', { customRoleId: role.id });

      const made = await (await fx.signedInAs(creator)).post('/api/leads', { customer_id: customer, service_request: 'Fix the door' });
      expect(made.status, JSON.stringify(made.body)).toBe(201);
      const stored = await db.lead.findUniqueOrThrow({ where: { id: made.body.id ?? made.body.lead?.id }, select: { id: true, commission_owner_id: true, dispatcher_id: true } });
      expect(stored).toMatchObject({ commission_owner_id: null, dispatcher_id: creator.id });

      const answer = await dashboardOf(creator);
      expect(dataOf(answer).count).toBe(1);
      expect(dataOf(answer).oldest?.id).toBe(stored.id);
      expect(lineOf(answer)).toBe(1);
      expect(itemOf(answer)?.title).toBe('1 lead with no owner');
    });

    it('gives the same number on the tile, the Needs Attention item, the Open Leads line and the Leads page, under All scope and Attached scope', async () => {
      const { org, customer } = await newOrg();
      const all = await personWith(org, LEADS);
      const attached = await personWith(org, ATTACHED);
      const other = await fx.addUser(org, 'mlo-agree-other', 'TECHNICIAN');
      await withStatus(org, customer, 'NEW', { dispatcher: attached.id });
      await withStatus(org, customer, 'WALKTHROUGH_SCHEDULED', { walkthroughCrew: [attached.id] });
      await withStatus(org, customer, 'WALKTHROUGH_COMPLETED', { dispatcher: other.id });
      await withStatus(org, customer, 'ESTIMATED');
      await withStatus(org, customer, 'WON', { dispatcher: attached.id });
      await withStatus(org, customer, 'LOST');
      await withStatus(org, customer, 'CONTACTED', { owner: other.id, dispatcher: attached.id });

      for (const [person, expected] of [[all, 4], [attached, 2]] as const) {
        const answer = await dashboardOf(person);
        const page = await leadsPage(person);
        expect(dataOf(answer).count).toBe(expected);
        expect(lineOf(answer)).toBe(expected);
        expect(itemOf(answer)?.badge).toBe(String(expected));
        expect(page.card).toBe(expected);
        expect(page.filtered).toHaveLength(expected);
      }
    });

    it('has no leads-unassigned item and no "Assign leads to your sales team" prompt, with leads missing an owner or not', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, LEADS);
      for (const withLeads of [false, true]) {
        if (withLeads) await fx.addLead(org, customer);
        const items = (await dashboardOf(me)).data.needs_attention as Item[];
        expect(items.map((i) => i.type)).not.toContain('unassigned_leads');
        expect(JSON.stringify(items)).not.toMatch(/unassigned|Assign leads to your sales team/i);
      }
    });

    it('sends the tile and the item to the Leads list filtered to No owner with View leads alone, and that list holds exactly the leads counted', async () => {
      const { org, customer } = await newOrg();
      const oldest = await fx.addLead(org, customer);
      await openedSince(oldest.id, 3);
      const second = await fx.addLead(org, customer);
      await withStatus(org, customer, 'WON');

      const opens = await personWith(org, LEADS);
      const open = await dashboardOf(opens);
      expect(linkOfTile(open)).toBe('/leads?assigned_to=NO_OWNER');
      expect(itemOf(open)?.link).toBe('/leads?assigned_to=NO_OWNER');
      const list = await (await fx.signedInAs(opens)).get(`/api/leads${linkOfTile(open)!.slice('/leads'.length)}`);
      expect(list.status, JSON.stringify(list.body)).toBe(200);
      expect((list.body.leads as Array<{ id: string }>).map((l) => l.id).sort()).toEqual([oldest.id, second.id].sort());
      expect(list.body.pagination.total).toBe(dataOf(open).count);

      expect(dataOf(open).oldest?.link).toBe(`/leads/${oldest.id}`);
    });

    it('gives a person with nothing missing a normal empty answer and no item', async () => {
      const { org } = await newOrg();
      const answer = await dashboardOf(await personWith(org, LEADS));
      expect(dataOf(answer)).toEqual({ count: 0, oldest: null });
      expect(itemOf(answer)).toBeUndefined();
      expect(lineOf(answer)).toBe(0);
    });

    it('gives each of the three uses its answer when only that use is asked for (the shared read does not depend on who asks first)', async () => {
      const { org, customer } = await newOrg();
      const lead = await fx.addLead(org, customer);
      const me = await personWith(org, LEADS);
      expect(dataOf(await dashboardOf(me, `?tiles=${MISSING}`)).oldest?.id).toBe(lead.id);
      expect(lineOf(await dashboardOf(me, `?tiles=${OPEN_LEADS_TILE}`))).toBe(1);
      expect(itemOf(await dashboardOf(me, '?tiles=needs_attention'))?.title).toBe('1 lead with no owner');
    });
  });

  describe('Missing crew: the tile and the Needs Attention item (S09.13)', () => {
    const MISSING = 'missing_crew';
    type Soonest = { id: string; kind: 'job' | 'lead'; number: string; title: string; starts_at: string; starts_label: string; until: string; link: string };
    type CrewData = { count: number; soonest: Soonest | null };
    type Item = { id: string; type: string; severity: string; title: string; meta: string; badge: string; link: string | null };
    const JOBS = { view_jobs: true, access_schedule: true, jobs_scope: 'all' };
    const JOBS_AND_LEADS = { ...JOBS, view_leads: true, leads_scope: 'all' };
    const ATTACHED = { ...JOBS_AND_LEADS, jobs_scope: 'attached', leads_scope: 'attached' };
    const NO_CREW_LINK = '/schedule?filter=no_crew';
    const dataOf = (answer: Answer) => answer.data[MISSING] as CrewData;
    const itemOf = (answer: Answer) => (answer.data.needs_attention as Item[]).find((i) => i.type === 'missing_crew');
    const linkOfTile = (answer: Answer) => (tile(answer, MISSING) as (Tile & { link: string | null }) | undefined)?.link;
    /** A booked visit on a job with nobody on it, `days` ahead (a number like 1.5 is a day and a half). */
    const crewlessVisit = (org: string, jobId: string, days: number, seq = 1) => fx.addVisit(org, { jobId, crew: [], daysFromNow: days, seq });
    const crewlessWalkthrough = (org: string, leadId: string, days: number) =>
      fx.addVisit(org, { leadId, purpose: 'WALKTHROUGH', crew: [], daysFromNow: days });
    /** What the Schedule's "No crew" filter shows this person: every visit id the jobs feed and the leads feed carry. */
    const scheduleVisits = async (person: Person) => {
      const api = await fx.signedInAs(person);
      const after = encodeURIComponent(new Date(Date.now() - 86_400_000).toISOString());
      const before = encodeURIComponent(new Date(Date.now() + 10 * 86_400_000).toISOString());
      const statuses = Object.values(JobStatus).map((st) => `status=${st}`).join('&');
      const jobs = await api.get(`/api/jobs?${statuses}&scheduled_after=${after}&scheduled_before=${before}&missing_crew=true&limit=500`);
      const leads = await api.get(`/api/leads?walkthrough_after=${after}&walkthrough_before=${before}&missing_crew=true&limit=500`);
      expect(jobs.status, JSON.stringify(jobs.body)).toBe(200);
      expect(leads.status, JSON.stringify(leads.body)).toBe(200);
      return [
        ...jobs.body.jobs.flatMap((j: { visits: Array<{ id: string }> }) => j.visits.map((v) => v.id)),
        ...leads.body.leads.flatMap((l: { walkthrough_visits: Array<{ id: string }> }) => l.walkthrough_visits.map((v) => v.id)),
      ].sort();
    };

    it('is a Jobs tile that View jobs unlocks under every Jobs scope, and is neither sent nor computed without it, even when asked for by id', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer, {});
      await crewlessVisit(org, job.id, 3);
      for (const scope of ['attached', 'all']) {
        const answer = await dashboardOf(await personWith(org, { ...JOBS, jobs_scope: scope }));
        expect(tile(answer, MISSING), scope).toMatchObject({ category: 'jobs' });
      }
      const without = await personWith(org, { view_leads: true, view_invoices: true, ...ALL_SCOPES });
      expect(tile(await dashboardOf(without), MISSING)).toBeUndefined();
      const byId = await dashboardOf(without, `?tiles=${MISSING}`);
      expect(byId.tiles).toEqual([]);
      expect(byId.data).toEqual({});
    });

    it('counts a booked job visit 3 days ahead with nobody on its crew, and drops it once a crew member is added', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, JOBS);
      const tech = await fx.addUser(org, 'mc-crew', 'TECHNICIAN');
      const job = await fx.addJob(org, customer, {});
      const visit = await crewlessVisit(org, job.id, 3);
      const before = await dashboardOf(me);
      expect(dataOf(before).count).toBe(1);
      expect(dataOf(before).soonest).toMatchObject({ id: job.id, kind: 'job', link: `/jobs/${job.id}` });
      expect(itemOf(before)?.title).toBe('1 visit with no crew');

      await db.visitAssignee.create({ data: { visit_id: visit, user_id: tech.id, organization_id: org } });
      const after = await dashboardOf(me);
      expect(dataOf(after)).toEqual({ count: 0, soonest: null });
      expect(itemOf(after)).toBeUndefined();
    });

    it('counts a booked walkthrough with nobody on it for a person with View leads, and leaves it out (not sent) for one with View leads off', async () => {
      const { org, customer } = await newOrg();
      const lead = await fx.addLead(org, customer);
      const walk = await crewlessWalkthrough(org, lead.id, 2);
      const stored = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { lead_number: true } });

      const withLeads = await dashboardOf(await personWith(org, JOBS_AND_LEADS));
      expect(dataOf(withLeads)).toMatchObject({ count: 1, soonest: { id: lead.id, kind: 'lead', number: stored.lead_number, link: `/leads/${lead.id}` } });
      expect(itemOf(withLeads)).toMatchObject({ title: '1 visit with no crew', link: NO_CREW_LINK });
      expect(await scheduleVisits(await personWith(org, JOBS_AND_LEADS))).toEqual([walk]);

      const noLeads = await dashboardOf(await personWith(org, JOBS));
      expect(dataOf(noLeads)).toEqual({ count: 0, soonest: null });
      expect(itemOf(noLeads)).toBeUndefined();
      expect(JSON.stringify(noLeads.data)).not.toContain(lead.id);
      expect(JSON.stringify(noLeads.data)).not.toContain(stored.lead_number);
    });

    it('leaves out a visit 8 days ahead, a walkthrough with performers and no time, a cancelled visit and a visit on a cancelled job', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, JOBS_AND_LEADS);
      const tech = await fx.addUser(org, 'mc-excluded', 'TECHNICIAN');
      const job = await fx.addJob(org, customer, {});
      await crewlessVisit(org, job.id, 8);
      const cancelledVisit = await crewlessVisit(org, job.id, 2, 2);
      await db.visit.update({ where: { id: cancelledVisit }, data: { status: 'CANCELLED', cancelled_at: new Date() } });
      const cancelledJob = await fx.addJob(org, customer, { status: 'CANCELLED' });
      await crewlessVisit(org, cancelledJob.id, 2);
      const lead = await fx.addLead(org, customer);
      const untimed = await crewlessWalkthrough(org, lead.id, 2);
      await db.visit.update({ where: { id: untimed }, data: { scheduled_at: null, scheduled_end: null } });
      await db.visitAssignee.create({ data: { visit_id: untimed, user_id: tech.id, organization_id: org } });

      const answer = await dashboardOf(me);
      expect(dataOf(answer)).toEqual({ count: 0, soonest: null });
      expect(itemOf(answer)).toBeUndefined();
    });

    it('does not count a job\'s Sold By or Dispatcher, nor a lead\'s Owner or Dispatcher, as crew', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, JOBS_AND_LEADS);
      const people = await fx.addUser(org, 'mc-people', 'TECHNICIAN');
      const job = await fx.addJob(org, customer, { soldBy: people.id, dispatcher: people.id });
      await crewlessVisit(org, job.id, 3);
      const lead = await fx.addLead(org, customer, { owner: people.id, dispatcher: people.id });
      await crewlessWalkthrough(org, lead.id, 3);
      expect(dataOf(await dashboardOf(me)).count).toBe(2);
    });

    it('reaches, under Attached scope, a crewless visit on a job the person is Dispatcher or Sold By of (or a lead they Own or Dispatch), and not one on a job they are not on', async () => {
      const { org, customer } = await newOrg();
      const attached = await personWith(org, ATTACHED);
      const other = await fx.addUser(org, 'mc-attached-other', 'TECHNICIAN');
      const dispatched = await fx.addJob(org, customer, { dispatcher: attached.id });
      const sold = await fx.addJob(org, customer, { soldBy: attached.id });
      const theirs = await fx.addJob(org, customer, { dispatcher: other.id });
      const nobodys = await fx.addJob(org, customer, {});
      for (const job of [dispatched, sold, theirs, nobodys]) await crewlessVisit(org, job.id, 3);
      const owned = await fx.addLead(org, customer, { owner: attached.id });
      const strangers = await fx.addLead(org, customer, { owner: other.id });
      await crewlessWalkthrough(org, owned.id, 3);
      await crewlessWalkthrough(org, strangers.id, 3);

      const mine = await dashboardOf(attached);
      expect(dataOf(mine).count).toBe(3);
      expect(itemOf(mine)?.title).toBe('3 visits with no crew');
      for (const unreachable of [theirs.id, nobodys.id, strangers.id]) expect(JSON.stringify(mine.data)).not.toContain(unreachable);
      expect([dispatched.id, sold.id, owned.id]).toContain(dataOf(mine).soonest!.id);
    });

    it('never reaches a visit of another organization', async () => {
      const { org, customer } = await newOrg();
      const elsewhere = await newOrg();
      const strangerJob = await fx.addJob(elsewhere.org, elsewhere.customer, {});
      await crewlessVisit(elsewhere.org, strangerJob.id, 2);
      const mine = await fx.addJob(org, customer, {});
      await crewlessVisit(org, mine.id, 2);
      const answer = await dashboardOf(await personWith(org, JOBS_AND_LEADS));
      expect(dataOf(answer).count).toBe(1);
      expect(JSON.stringify(answer.data)).not.toContain(strangerJob.id);
    });

    it('names the soonest one by number, customer, when it starts on the company\'s clock and how long until it, and counts the rest', async () => {
      const { org, customer } = await newOrg();
      await db.organization.update({ where: { id: org }, data: { timezone: 'America/New_York' } });
      const me = await personWith(org, JOBS_AND_LEADS);
      const later = await fx.addJob(org, customer, {});
      const soonestJob = await fx.addJob(org, customer, {});
      const lead = await fx.addLead(org, customer);
      await crewlessVisit(org, later.id, 5);
      const soonest = await crewlessVisit(org, soonestJob.id, 2);
      await crewlessWalkthrough(org, lead.id, 4);
      const start = (await db.visit.findUniqueOrThrow({ where: { id: soonest }, select: { scheduled_at: true } })).scheduled_at!;
      const stored = await db.job.findUniqueOrThrow({ where: { id: soonestJob.id }, select: { job_number: true } });
      const label = formatInTimeZone(start, 'America/New_York', 'EEE h:mm a');

      const answer = await dashboardOf(me);
      expect(dataOf(answer)).toEqual({
        count: 3,
        soonest: { id: soonestJob.id, kind: 'job', number: stored.job_number, title: 'Pat Payer', starts_at: start.toISOString(), starts_label: label, until: expect.stringMatching(/^[12]d$/), link: `/jobs/${soonestJob.id}` },
      });
      expect(itemOf(answer)).toMatchObject({
        id: 'missing-crew', severity: 'warning', title: '3 visits with no crew', meta: `${stored.job_number} starts ${label}`, badge: dataOf(answer).soonest!.until,
      });
    });

    it('names a walkthrough as the soonest in the lead\'s own words', async () => {
      const { org, customer } = await newOrg();
      await db.organization.update({ where: { id: org }, data: { timezone: 'America/New_York' } });
      const lead = await fx.addLead(org, customer);
      const walk = await crewlessWalkthrough(org, lead.id, 2);
      const start = (await db.visit.findUniqueOrThrow({ where: { id: walk }, select: { scheduled_at: true } })).scheduled_at!;
      const stored = await db.lead.findUniqueOrThrow({ where: { id: lead.id }, select: { lead_number: true } });
      const answer = await dashboardOf(await personWith(org, JOBS_AND_LEADS));
      expect(itemOf(answer)?.meta).toBe(`${stored.lead_number} walkthrough ${formatInTimeZone(start, 'America/New_York', 'EEE h:mm a')}`);
    });

    it('counts a crewless job visit 24 hours ahead once, in the Missing crew item, with no separate per-visit "no crew" line', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, JOBS);
      const job = await fx.addJob(org, customer, {});
      await crewlessVisit(org, job.id, 1);
      const items = (await dashboardOf(me)).data.needs_attention as Item[];
      expect(items.filter((i) => /no crew/i.test(`${i.title} ${i.meta}`))).toHaveLength(1);
      expect(items.map((i) => i.type)).not.toContain('job_unstaffed');
      expect(items.find((i) => i.type === 'missing_crew')).toMatchObject({ title: '1 visit with no crew', badge: expect.stringMatching(/^(23h|24h|0d|1d)$/) });
    });

    it('counts only records the person can open, in the tile and in the item', async () => {
      const { org, customer } = await newOrg();
      const attached = await personWith(org, ATTACHED);
      const mine = await fx.addJob(org, customer, { dispatcher: attached.id });
      const theirs = await fx.addJob(org, customer, {});
      await crewlessVisit(org, mine.id, 1);
      await crewlessVisit(org, theirs.id, 1);
      const answer = await dashboardOf(attached);
      expect(dataOf(answer).count).toBe(1);
      expect(itemOf(answer)?.title).toBe('1 visit with no crew');
      expect(JSON.stringify(answer.data)).not.toContain(theirs.id);
    });

    it('gives the same number on the tile, the Needs Attention item and the Schedule\'s No crew filter, under All scope and Attached scope', async () => {
      const { org, customer } = await newOrg();
      const all = await personWith(org, JOBS_AND_LEADS);
      const attached = await personWith(org, ATTACHED);
      const other = await fx.addUser(org, 'mc-agree-other', 'TECHNICIAN');
      const ownJob = await fx.addJob(org, customer, { dispatcher: attached.id });
      const otherJob = await fx.addJob(org, customer, { dispatcher: other.id });
      const ownLead = await fx.addLead(org, customer, { dispatcher: attached.id });
      const otherLead = await fx.addLead(org, customer, { owner: other.id });
      await crewlessVisit(org, ownJob.id, 1);
      await crewlessVisit(org, ownJob.id, 4, 2);
      await crewlessVisit(org, otherJob.id, 2);
      await crewlessWalkthrough(org, ownLead.id, 3);
      await crewlessWalkthrough(org, otherLead.id, 3);

      for (const [person, expected] of [[all, 5], [attached, 3]] as const) {
        const answer = await dashboardOf(person);
        expect(dataOf(answer).count).toBe(expected);
        expect(itemOf(answer)?.title).toBe(`${expected} visits with no crew`);
        expect(await scheduleVisits(person)).toHaveLength(expected);
      }
    });

    it('sends the tile and the item to the Schedule\'s No crew filter with Access Schedule, else to the soonest record', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer, {});
      await crewlessVisit(org, job.id, 2);
      const later = await fx.addJob(org, customer, {});
      await crewlessVisit(org, later.id, 5);

      const opens = await dashboardOf(await personWith(org, JOBS));
      expect(linkOfTile(opens)).toBe(NO_CREW_LINK);
      expect(itemOf(opens)?.link).toBe(NO_CREW_LINK);

      const noSchedule = await dashboardOf(await personWith(org, { ...JOBS, access_schedule: false }));
      expect(linkOfTile(noSchedule)).toBeNull();
      expect(itemOf(noSchedule)?.link).toBe(`/jobs/${job.id}`);
      expect(dataOf(noSchedule).soonest?.link).toBe(`/jobs/${job.id}`);
    });

    it('gives a person with nothing missing a normal empty answer and no item', async () => {
      const { org } = await newOrg();
      const answer = await dashboardOf(await personWith(org, JOBS_AND_LEADS));
      expect(dataOf(answer)).toEqual({ count: 0, soonest: null });
      expect(itemOf(answer)).toBeUndefined();
    });

    it('gives each of the two uses its answer when only that use is asked for (the shared read does not depend on who asks first)', async () => {
      const { org, customer } = await newOrg();
      const job = await fx.addJob(org, customer, {});
      await crewlessVisit(org, job.id, 2);
      const me = await personWith(org, JOBS);
      expect(dataOf(await dashboardOf(me, `?tiles=${MISSING}`)).soonest?.id).toBe(job.id);
      expect(itemOf(await dashboardOf(me, '?tiles=needs_attention'))?.title).toBe('1 visit with no crew');
    });
  });

  describe('Jobs this month (S09.16)', () => {
    const TILE = 'jobs_this_month';
    type MonthData = { jobs: number; finished: number; still_to_do: number };
    const JOBS = { view_jobs: true, jobs_scope: 'all' };
    const ATTACHED = { ...JOBS, jobs_scope: 'attached' };
    const dataOf = (answer: Answer) => answer.data[TILE] as MonthData;
    const linkOfTile = (answer: Answer) => (tile(answer, TILE) as (Tile & { link: string | null }) | undefined)?.link;

    /** The first day of the month `n` months from the one that holds `at` on a company's clock, as 'YYYY-MM-DD'. */
    const monthFirst = (at: Date, zone: string, n = 0) => {
      const [y, m] = formatInTimeZone(at, zone, 'yyyy-MM').split('-').map(Number) as [number, number];
      return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
    };
    /** Noon UTC on the 15th of the company's month `n` months from this one: well clear of every month edge in any zone. */
    const midMonth = (n: number, zone = 'America/New_York') => new Date(`${monthFirst(new Date(), zone, n).slice(0, 8)}15T12:00:00Z`);

    /** A visit on a job with a status, a start and a crew, written straight to the table (the fixture's own visit has no status choice). */
    let visitSeq = 0;
    async function visit(
      org: string,
      jobId: string,
      status: 'SCHEDULED' | 'EN_ROUTE' | 'ON_SITE' | 'IN_PROGRESS' | 'COMPLETED' | 'CANCELLED',
      at: Date,
      crew: string[] = [],
    ) {
      const id = randomUUID();
      await db.visit.create({
        data: { id, organization_id: org, job_id: jobId, purpose: 'WORK', visit_seq: ++visitSeq, status, scheduled_at: at, scheduled_end: new Date(at.getTime() + 3_600_000) },
      });
      for (const user of crew) await db.visitAssignee.create({ data: { visit_id: id, user_id: user, organization_id: org } });
      return id;
    }

    it('is a Jobs tile that View jobs unlocks under every Jobs scope, and is neither sent nor computed without it, even when asked for by id', async () => {
      const { org } = await newOrg();
      for (const scope of ['attached', 'team', 'all']) {
        const answer = await dashboardOf(await personWith(org, { ...JOBS, jobs_scope: scope }));
        expect(tile(answer, TILE), scope).toMatchObject({ category: 'jobs' });
      }
      const without = await personWith(org, { view_leads: true, view_invoices: true, ...ALL_SCOPES });
      expect(tile(await dashboardOf(without), TILE)).toBeUndefined();
      const byId = await dashboardOf(without, `?tiles=${TILE}`);
      expect(byId.tiles).toEqual([]);
      expect(byId.data).toEqual({});
    });

    it('counts a visit finished while its job is still In Progress under finished, a live visit under still to do, and a cancelled visit under neither', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, JOBS);
      const when = midMonth(0);
      // A finished visit on a job that is still In Progress: finished, not still to do.
      const doneJob = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
      await visit(org, doneJob.id, 'COMPLETED', when);
      // Every live visit status counts as still to do, one job each.
      for (const status of ['SCHEDULED', 'EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'] as const) {
        const job = await fx.addJob(org, customer, {});
        await visit(org, job.id, status, when);
      }
      // A job whose only visit this month was cancelled is not counted at all.
      const calledOff = await fx.addJob(org, customer, {});
      await visit(org, calledOff.id, 'CANCELLED', when);
      expect(dataOf(await dashboardOf(me, `?tiles=${TILE}`))).toEqual({ jobs: 5, finished: 1, still_to_do: 4 });
    });

    it('counts a job once however many visits it has this month, and every visit under its own word', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, JOBS);
      const job = await fx.addJob(org, customer, { status: 'IN_PROGRESS' });
      const day = 86_400_000;
      await visit(org, job.id, 'COMPLETED', midMonth(0));
      await visit(org, job.id, 'COMPLETED', new Date(midMonth(0).getTime() + day));
      await visit(org, job.id, 'SCHEDULED', new Date(midMonth(0).getTime() + 2 * day));
      await visit(org, job.id, 'CANCELLED', new Date(midMonth(0).getTime() + 3 * day));
      expect(dataOf(await dashboardOf(me, `?tiles=${TILE}`))).toEqual({ jobs: 1, finished: 2, still_to_do: 1 });
    });

    it('leaves out a visit last month and a visit next month, and a job whose only visits are those', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, JOBS);
      const lastMonth = await fx.addJob(org, customer, {});
      await visit(org, lastMonth.id, 'COMPLETED', midMonth(-1));
      const nextMonth = await fx.addJob(org, customer, {});
      await visit(org, nextMonth.id, 'SCHEDULED', midMonth(1));
      const both = await fx.addJob(org, customer, {});
      await visit(org, both.id, 'COMPLETED', midMonth(-1));
      await visit(org, both.id, 'SCHEDULED', midMonth(0));
      expect(dataOf(await dashboardOf(me, `?tiles=${TILE}`))).toEqual({ jobs: 1, finished: 0, still_to_do: 1 });
    });

    it('reads "this month" on the company\'s clock, not the server\'s: the last evening of the month in a zone behind UTC is still this month', async () => {
      const { org, customer } = await newOrg();
      const zone = 'America/Los_Angeles';
      await db.organization.update({ where: { id: org }, data: { timezone: zone } });
      const me = await personWith(org, JOBS);
      // 03:00 UTC on the 1st of next month is 7 or 8 pm on this month's last day in Los Angeles: in.
      const lastEvening = await fx.addJob(org, customer, {});
      await visit(org, lastEvening.id, 'SCHEDULED', new Date(`${monthFirst(new Date(), zone, 1)}T03:00:00Z`));
      // 02:00 UTC on the 1st of this month is the evening of last month's last day in Los Angeles: out.
      const prevEvening = await fx.addJob(org, customer, {});
      await visit(org, prevEvening.id, 'COMPLETED', new Date(`${monthFirst(new Date(), zone, 0)}T02:00:00Z`));
      expect(dataOf(await dashboardOf(me, `?tiles=${TILE}`))).toEqual({ jobs: 1, finished: 0, still_to_do: 1 });
    });

    it('under Attached counts only the visits the person is crew on: a visit on an attached job that someone else crews is left out', async () => {
      const { org, customer, admin } = await newOrg();
      const me = await personWith(org, ATTACHED);
      const when = midMonth(0);
      // Mine: on the crew of a finished visit and a live one on the same job.
      const mine = await fx.addJob(org, customer, { soldBy: me.id, status: 'IN_PROGRESS' });
      await visit(org, mine.id, 'COMPLETED', when, [me.id]);
      await visit(org, mine.id, 'SCHEDULED', when, [me.id]);
      // Attached to me (Sold By) but the visit is crewed by someone else: the job and its visit are both out.
      const theirs = await fx.addJob(org, customer, { soldBy: me.id });
      await visit(org, theirs.id, 'SCHEDULED', when, [admin.id]);
      // Attached to me, one visit mine and one not: only mine counts, and the job counts once.
      const shared = await fx.addJob(org, customer, { soldBy: me.id });
      await visit(org, shared.id, 'SCHEDULED', when, [me.id]);
      await visit(org, shared.id, 'COMPLETED', when, [admin.id]);
      // Not attached to me at all.
      const stranger = await fx.addJob(org, customer, {});
      await visit(org, stranger.id, 'SCHEDULED', when, [admin.id]);
      expect(dataOf(await dashboardOf(me, `?tiles=${TILE}`))).toEqual({ jobs: 2, finished: 1, still_to_do: 2 });
    });

    it('under All counts every visit of every job, whoever is crew', async () => {
      const { org, customer, admin } = await newOrg();
      const me = await personWith(org, JOBS);
      const job = await fx.addJob(org, customer, {});
      await visit(org, job.id, 'COMPLETED', midMonth(0), [admin.id]);
      await visit(org, job.id, 'SCHEDULED', midMonth(0), []);
      const other = await fx.addJob(org, customer, {});
      await visit(org, other.id, 'IN_PROGRESS', midMonth(0), [me.id]);
      expect(dataOf(await dashboardOf(me, `?tiles=${TILE}`))).toEqual({ jobs: 2, finished: 1, still_to_do: 2 });
    });

    it('never counts another company\'s visits', async () => {
      const mine = await newOrg();
      const other = await newOrg();
      const me = await personWith(mine.org, JOBS);
      const theirJob = await fx.addJob(other.org, other.customer, {});
      await visit(other.org, theirJob.id, 'COMPLETED', midMonth(0));
      await visit(other.org, theirJob.id, 'SCHEDULED', midMonth(0));
      expect(dataOf(await dashboardOf(me, `?tiles=${TILE}`))).toEqual({ jobs: 0, finished: 0, still_to_do: 0 });
    });

    it('does not count a walkthrough visit on a lead', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { ...JOBS, view_leads: true, leads_scope: 'all' });
      const lead = await fx.addLead(org, customer);
      await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [], daysFromNow: 0 });
      expect(dataOf(await dashboardOf(me, `?tiles=${TILE}`))).toEqual({ jobs: 0, finished: 0, still_to_do: 0 });
    });

    it('carries the Jobs list address with View jobs alone', async () => {
      const { org } = await newOrg();
      expect(linkOfTile(await dashboardOf(await personWith(org, JOBS)))).toBe('/jobs');
    });

    it('is computed for a person whose saved layout shows it, and left out of the read when the layout hides it', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, JOBS);
      const job = await fx.addJob(org, customer, {});
      await visit(org, job.id, 'SCHEDULED', midMonth(0));
      const api = await fx.signedInAs(me);
      expect((await api.put('/api/dashboard/layout', { layout: [{ id: TILE, visible: true }] })).status).toBe(200);
      expect(dataOf((await api.get('/api/dashboard?shown=1')).body as Answer)).toEqual({ jobs: 1, finished: 0, still_to_do: 1 });
      expect((await api.put('/api/dashboard/layout', { layout: [{ id: TILE, visible: false }] })).status).toBe(200);
      const hidden = (await api.get('/api/dashboard?shown=1')).body as Answer;
      expect(hidden.data[TILE]).toBeUndefined();
      // Still offered by the picker.
      expect(tile(hidden, TILE)).toBeDefined();
    });
  });

  describe('Completed jobs value (S09.17)', () => {
    const TILE = 'completed_jobs_value';
    type Value = { jobs: number; value: number };
    const JOBS = { view_jobs: true, jobs_scope: 'all' };
    /** The company's figures: See company figures on, so the Jobs scope decides (here All: every job). */
    const COMPANY = { ...JOBS, see_company_figures: true };
    const dataOf = (answer: Answer) => answer.data[TILE] as Value;
    const read = async (person: Person) => dashboardOf(person, `?tiles=${TILE}`);
    const figureOf = async (person: Person) => dataOf(await read(person));
    const linkOfTile = (answer: Answer) => (tile(answer, TILE) as (Tile & { link: string | null }) | undefined)?.link;

    /** The first day of the month `n` months from the one that holds `at` on a company's clock, as 'YYYY-MM-DD'. */
    const monthFirst = (at: Date, zone: string, n = 0) => {
      const [y, m] = formatInTimeZone(at, zone, 'yyyy-MM').split('-').map(Number) as [number, number];
      return new Date(Date.UTC(y, m - 1 + n, 1)).toISOString().slice(0, 10);
    };
    /** Noon UTC on the 15th of the company's month `n` months from this one: well clear of every month edge in any zone. */
    const midMonth = (n: number, zone = 'America/New_York') => new Date(`${monthFirst(new Date(), zone, n).slice(0, 8)}15T12:00:00Z`);

    /**
     * A job that reached `status` at `completedAt` with `amount` invoiced on it (the job's billed total, which the invoice
     * routes keep: the voided-invoice case below goes through the real route). Crew, Sold By, Dispatcher and the plan link
     * are the fixture's.
     */
    async function finished(
      org: string,
      customer: string,
      amount: number,
      opts: { status?: JobStatus; completedAt?: Date | null; crew?: string[]; soldBy?: string; dispatcher?: string; sourcePlan?: string } = {},
    ) {
      const { status = 'COMPLETED', completedAt = midMonth(0), ...people } = opts;
      const job = await fx.addJob(org, customer, { ...people, status });
      await db.job.update({ where: { id: job.id }, data: { completed_at: completedAt, amount_invoiced: amount } });
      return job;
    }

    it('is a Job value tile that View jobs unlocks, and is neither sent nor computed without it, even when asked for by id', async () => {
      const { org } = await newOrg();
      expect(tile(await read(await personWith(org, JOBS)), TILE)).toMatchObject({ category: 'job_value' });
      const without = await personWith(org, { view_leads: true, view_invoices: true, see_costs: true, see_company_figures: true, ...ALL_SCOPES });
      expect(tile(await dashboardOf(without), TILE)).toBeUndefined();
      const byId = await read(without);
      expect(byId.tiles).toEqual([]);
      expect(byId.data).toEqual({});
    });

    it('is a plain empty figure when nothing reached Completed this month', async () => {
      const { org } = await newOrg();
      expect(await figureOf(await personWith(org, COMPANY))).toEqual({ jobs: 0, value: 0 });
    });

    describe('own mode (no See company figures)', () => {
      const OWN = { ...JOBS, see_company_figures: false, jobs_scope: 'attached' };

      it('sums only the jobs the person is on that reached Completed this month, labelled "Yours": a technician on two of five sees those two', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, OWN);
        await finished(org, customer, 100, { crew: [me.id] });
        await finished(org, customer, 250.5, { crew: [me.id, admin.id] });
        await finished(org, customer, 1000, { crew: [admin.id] });
        await finished(org, customer, 2000, { crew: [admin.id] });
        await finished(org, customer, 4000, {});
        const answer = await read(me);
        expect(dataOf(answer)).toEqual({ jobs: 2, value: 350.5 });
        expect(tile(answer, TILE)).toMatchObject({ mode: 'own', label: 'Yours' });
      });

      it('counts the jobs the person is the Dispatcher or Sold By of, as the Attached rule does', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, OWN);
        await finished(org, customer, 10, { dispatcher: me.id, crew: [admin.id] });
        await finished(org, customer, 20, { soldBy: me.id, crew: [admin.id] });
        await finished(org, customer, 40, { crew: [me.id] });
        expect(await figureOf(me)).toEqual({ jobs: 3, value: 70 });
      });

      it('stays the person\'s own set, labelled "Yours", for a person whose Jobs scope is All but who lacks See company figures', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, { ...JOBS, see_company_figures: false });
        await finished(org, customer, 100, { crew: [me.id] });
        await finished(org, customer, 900, { crew: [admin.id] });
        const answer = await read(me);
        expect(dataOf(answer)).toEqual({ jobs: 1, value: 100 });
        expect(tile(answer, TILE)).toMatchObject({ mode: 'own', label: 'Yours' });
      });

      it('needs no See costs and no View invoices: the job\'s price shows to whoever can open the job', async () => {
        const { org, customer } = await newOrg();
        const me = await personWith(org, { ...OWN, see_costs: false, view_invoices: false });
        await finished(org, customer, 75, { crew: [me.id] });
        expect(await figureOf(me)).toEqual({ jobs: 1, value: 75 });
      });

      it('counts a crew-shared job in full for each member, with no splitting', async () => {
        const { org, customer } = await newOrg();
        const first = await personWith(org, OWN);
        const second = await personWith(org, OWN);
        await finished(org, customer, 300, { crew: [first.id, second.id] });
        expect(await figureOf(first)).toEqual({ jobs: 1, value: 300 });
        expect(await figureOf(second)).toEqual({ jobs: 1, value: 300 });
      });
    });

    describe('with See company figures, the Jobs scope decides', () => {
      it('covers every such job with no label under Jobs scope All', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, { ...JOBS, see_company_figures: true });
        await finished(org, customer, 100, { crew: [me.id] });
        await finished(org, customer, 900, { crew: [admin.id] });
        await finished(org, customer, 5, {});
        const answer = await read(me);
        expect(dataOf(answer)).toEqual({ jobs: 3, value: 1005 });
        expect(tile(answer, TILE)).toMatchObject({ mode: 'company', label: null });
      });

      it('covers the jobs the person is on, labelled "Yours", under Attached', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, { ...JOBS, see_company_figures: true, jobs_scope: 'attached' });
        await finished(org, customer, 100, { crew: [me.id] });
        await finished(org, customer, 900, { crew: [admin.id] });
        const answer = await read(me);
        expect(dataOf(answer)).toEqual({ jobs: 1, value: 100 });
        expect(tile(answer, TILE)).toMatchObject({ mode: 'scope', label: 'Yours' });
      });

      it('covers the jobs of the person\'s team, labelled "Your team", under Team', async () => {
        const { org, customer, admin } = await newOrg();
        const team = await fx.addDepartment(org, 'Crew A');
        const elsewhere = await fx.addDepartment(org, 'Crew B');
        const me = await personWith(org, { ...JOBS, see_company_figures: true, jobs_scope: 'team' }, { departmentId: team });
        const mate = await fx.addUser(org, 'mate', 'TECHNICIAN', { departmentId: team });
        const other = await fx.addUser(org, 'other', 'TECHNICIAN', { departmentId: elsewhere });
        await finished(org, customer, 100, { crew: [mate.id] });
        await finished(org, customer, 200, { crew: [me.id] });
        await finished(org, customer, 900, { crew: [other.id] });
        await finished(org, customer, 800, { crew: [admin.id] });
        const answer = await read(me);
        expect(dataOf(answer)).toEqual({ jobs: 2, value: 300 });
        expect(tile(answer, TILE)).toMatchObject({ mode: 'scope', label: 'Your team' });
      });
    });

    describe('which jobs "reached Completed this month"', () => {
      it('keeps a job moved on to Office review, Ready to close or Done, and leaves out a job that has not reached Completed', async () => {
        const { org, customer } = await newOrg();
        const me = await personWith(org, COMPANY);
        for (const status of COMPLETED_OR_LATER_JOB_STATUSES) await finished(org, customer, 10, { status });
        await finished(org, customer, 1000, { status: 'IN_PROGRESS' });
        await finished(org, customer, 1000, { status: 'SCHEDULED' });
        await finished(org, customer, 1000, { status: 'UNSCHEDULED' });
        expect(await figureOf(me)).toEqual({ jobs: COMPLETED_OR_LATER_JOB_STATUSES.length, value: 10 * COMPLETED_OR_LATER_JOB_STATUSES.length });
      });

      it('never counts a Cancelled job, even one that was completed this month before it was cancelled', async () => {
        const { org, customer } = await newOrg();
        const me = await personWith(org, COMPANY);
        await finished(org, customer, 500, { status: 'CANCELLED', completedAt: midMonth(0) });
        expect(await figureOf(me)).toEqual({ jobs: 0, value: 0 });
      });

      it('lets a job leave when it is reopened: Reopen clears the completed date, and the job drops out of the figure', async () => {
        const { org, customer } = await newOrg();
        const me = await personWith(org, COMPANY);
        const job = await finished(org, customer, 120, {});
        expect(await figureOf(me)).toEqual({ jobs: 1, value: 120 });
        await db.job.update({ where: { id: job.id }, data: { status: 'IN_PROGRESS', completed_at: null } });
        expect(await figureOf(me)).toEqual({ jobs: 0, value: 0 });
      });

      it('leaves out a job completed last month, and reads the month on the company\'s clock', async () => {
        const { org, customer } = await newOrg();
        const zone = 'America/Los_Angeles';
        await db.organization.update({ where: { id: org }, data: { timezone: zone } });
        const me = await personWith(org, COMPANY);
        await finished(org, customer, 7, { completedAt: midMonth(-1, zone) });
        // 03:00 UTC on the 1st of next month is the last evening of this month in Los Angeles: in.
        await finished(org, customer, 11, { completedAt: new Date(`${monthFirst(new Date(), zone, 1)}T03:00:00Z`) });
        // 02:00 UTC on the 1st of this month is the last evening of last month in Los Angeles: out.
        await finished(org, customer, 13, { completedAt: new Date(`${monthFirst(new Date(), zone, 0)}T02:00:00Z`) });
        // 09:00 UTC on the 1st of next month is the morning of next month in Los Angeles: out.
        await finished(org, customer, 17, { completedAt: new Date(`${monthFirst(new Date(), zone, 1)}T09:00:00Z`) });
        expect(await figureOf(me)).toEqual({ jobs: 1, value: 11 });
      });

      it('counts a job the one-time upgrade moved in the month it was completed, not the month of the upgrade', async () => {
        const { org, customer } = await newOrg();
        const me = await personWith(org, COMPANY);
        // The upgrade moves the status (Completed to Done or Ready to close) and keeps the completed date.
        await finished(org, customer, 90, { status: 'DONE', completedAt: midMonth(-2) });
        await finished(org, customer, 30, { status: 'READY_TO_CLOSE', completedAt: midMonth(-1) });
        await finished(org, customer, 5, { status: 'DONE', completedAt: midMonth(0) });
        expect(await figureOf(me)).toEqual({ jobs: 1, value: 5 });
      });

      it('never counts another company\'s jobs', async () => {
        const mine = await newOrg();
        const other = await newOrg();
        const me = await personWith(mine.org, { ...JOBS, see_company_figures: true });
        await finished(other.org, other.customer, 999, {});
        await finished(mine.org, mine.customer, 1, {});
        expect(await figureOf(me)).toEqual({ jobs: 1, value: 1 });
      });
    });

    describe('the invoiced value of a job', () => {
      it('is zero for a job with no invoice, which still counts as a job', async () => {
        const { org, customer } = await newOrg();
        const me = await personWith(org, COMPANY);
        await finished(org, customer, 0, {});
        await finished(org, customer, 80, {});
        expect(await figureOf(me)).toEqual({ jobs: 2, value: 80 });
      });

      it('leaves out a voided invoice: voiding the job\'s invoice through the invoice route takes its total off the figure', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, COMPANY);
        const job = await finished(org, customer, 100, {});
        const invoice = await fx.addInvoice(org, customer, { jobId: job.id, createdBy: admin.id });
        await db.invoice.update({ where: { id: invoice.id }, data: { status: 'SENT', sent_at: new Date() } });
        expect(await figureOf(me)).toEqual({ jobs: 1, value: 100 });
        const voided = await (await fx.signedInAs(admin)).post(`/api/invoices/${invoice.id}/void`, { voided_reason: 'Entered twice' });
        expect(voided.status, JSON.stringify(voided.body)).toBe(200);
        expect(await figureOf(me)).toEqual({ jobs: 1, value: 0 });
      });
    });

    describe('plan visit jobs (a service plan\'s visit job carries the plan\'s Sold By)', () => {
      it('counts for the crew member and the Dispatcher, and not for the plan\'s seller whose only link is the copied Sold By', async () => {
        const { org, customer } = await newOrg();
        const OWN = { ...JOBS, see_company_figures: false, jobs_scope: 'attached' };
        const seller = await personWith(org, OWN);
        const crew = await personWith(org, OWN);
        const dispatcher = await personWith(org, OWN);
        const plan = await fx.addServicePlan(org, customer, { soldBy: seller.id });
        // A plan visit job billed upfront has no invoice of its own: it adds nothing to the value and still counts as a job.
        await finished(org, customer, 0, { sourcePlan: plan.id, soldBy: seller.id, crew: [crew.id], dispatcher: dispatcher.id });
        // One that has an invoice: whatever invoices the job has.
        await finished(org, customer, 45, { sourcePlan: plan.id, soldBy: seller.id, crew: [crew.id] });
        // An ordinary job the same person sold still counts for them.
        await finished(org, customer, 1000, { soldBy: seller.id, crew: [crew.id] });
        expect(await figureOf(crew)).toEqual({ jobs: 3, value: 1045 });
        expect(await figureOf(dispatcher)).toEqual({ jobs: 1, value: 0 });
        expect(await figureOf(seller)).toEqual({ jobs: 1, value: 1000 });
      });

      it('is left out for the seller under the narrower scopes with See company figures too, and counts for everyone under All', async () => {
        const { org, customer } = await newOrg();
        const team = await fx.addDepartment(org, 'Plan team');
        const seller = await personWith(org, { ...JOBS, see_company_figures: true, jobs_scope: 'attached' });
        const teamSeller = await personWith(org, { ...JOBS, see_company_figures: true, jobs_scope: 'team' }, { departmentId: team });
        const teamSold = await fx.addUser(org, 'planseller', 'TECHNICIAN', { departmentId: team });
        const planA = await fx.addServicePlan(org, customer, { soldBy: seller.id });
        await finished(org, customer, 60, { sourcePlan: planA.id, soldBy: seller.id });
        const planB = await fx.addServicePlan(org, customer, { soldBy: teamSold.id });
        await finished(org, customer, 70, { sourcePlan: planB.id, soldBy: teamSold.id });
        expect(await figureOf(seller)).toEqual({ jobs: 0, value: 0 });
        expect(await figureOf(teamSeller)).toEqual({ jobs: 0, value: 0 });
        const everyone = await personWith(org, { ...JOBS, see_company_figures: true });
        expect(await figureOf(everyone)).toEqual({ jobs: 2, value: 130 });
      });
    });

    describe('where it leads', () => {
      it('carries the Jobs list with the Completed this month filter with View jobs alone', async () => {
        const { org } = await newOrg();
        expect(linkOfTile(await read(await personWith(org, COMPANY)))).toBe('/jobs?completed_this_month=true');
      });
    });

    it('is computed for a person whose saved layout shows it, and left out of the read when the layout hides it', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, COMPANY);
      await finished(org, customer, 33, {});
      const api = await fx.signedInAs(me);
      expect((await api.put('/api/dashboard/layout', { layout: [{ id: TILE, visible: true }] })).status).toBe(200);
      expect(dataOf((await api.get('/api/dashboard?shown=1')).body as Answer)).toEqual({ jobs: 1, value: 33 });
      expect((await api.put('/api/dashboard/layout', { layout: [{ id: TILE, visible: false }] })).status).toBe(200);
      const hidden = (await api.get('/api/dashboard?shown=1')).body as Answer;
      expect(hidden.data[TILE]).toBeUndefined();
      expect(tile(hidden, TILE)).toBeDefined();
    });
  });

  describe('Close Rate over Won and Lost (S09.15)', () => {
    type CloseRate = { rate: number; won: number; lost: number; vs_last_period_pp: number };
    const LEADS = { view_leads: true, leads_scope: 'all' };
    const ATTACHED = { ...LEADS, leads_scope: 'attached' };
    const DAY = 86_400_000;
    const ago = (days: number) => new Date(Date.now() - days * DAY);
    const rateOf = async (person: Person) => (await dashboardOf(person, '?tiles=kpi.close_rate')).data['kpi.close_rate'] as CloseRate;
    let numbering = 9_000_000;

    /**
     * A lead in a status. A closed one carries the date it closed on (`closedDaysAgo`, won_at or lost_at by its status);
     * `changedDaysAgo` is the lead's last-changed date, which defaults to the day it closed.
     */
    async function lead(
      org: string,
      customer: string,
      status: 'NEW' | 'CONTACTED' | 'WALKTHROUGH_SCHEDULED' | 'WALKTHROUGH_COMPLETED' | 'ESTIMATED' | 'WON' | 'LOST',
      opts: { closedDaysAgo?: number; changedDaysAgo?: number; reason?: string | null; noCloseDate?: boolean } & Parameters<typeof fx.addLead>[2] = {},
    ) {
      const { closedDaysAgo, changedDaysAgo, reason, noCloseDate, ...people } = opts;
      const made = await fx.addLead(org, customer, people);
      const closing = status === 'WON' || status === 'LOST';
      const closedAt = closing && closedDaysAgo !== undefined && !noCloseDate ? ago(closedDaysAgo) : null;
      const number = ++numbering;
      await db.lead.update({
        where: { id: made.id },
        data: {
          status,
          lead_number: `L${number}`,
          won_at: status === 'WON' ? closedAt : null,
          lost_at: status === 'LOST' ? closedAt : null,
          lost_reason: status === 'LOST' ? (reason ?? null) : null,
          updated_at: ago(changedDaysAgo ?? closedDaysAgo ?? 0),
        },
      });
      return { ...made, number };
    }

    /** A lead that Cancelled-to-Lost left behind: Lost, the cancel date as the lost date, its last-changed date untouched. */
    async function migrated(org: string, customer: string, cancelledDaysAgo: number, changedDaysAgo: number) {
      const made = await lead(org, customer, 'LOST', { closedDaysAgo: cancelledDaysAgo, changedDaysAgo, reason: 'No budget' });
      await db.timelineEvent.create({
        data: {
          organization_id: org,
          entity_type: 'LEAD',
          entity_id: made.id,
          event_type: 'STATUS_CHANGE',
          description: 'Lead was Cancelled before Cancelled was retired, and is now Lost. Old reason: No budget',
          metadata: { from: 'CANCELLED', to: 'LOST', via: 'lead_cancelled_retired', cancelled_reason: 'No budget' },
          created_at: new Date(ago(cancelledDaysAgo).getTime() + 1),
        },
      });
      return made;
    }

    /** A person who may reopen leads, on a role of their own. */
    const reopener = (org: string) => personWith(org, { ...LEADS, reopen_leads: true });

    it('counts a Lost lead as lost whatever its typed reason: Spam and Duplicate included', async () => {
      const { org, customer } = await newOrg();
      await lead(org, customer, 'WON', { closedDaysAgo: 3 });
      await lead(org, customer, 'LOST', { closedDaysAgo: 4, reason: 'Spam' });
      await lead(org, customer, 'LOST', { closedDaysAgo: 5, reason: 'Duplicate' });
      await lead(org, customer, 'LOST', { closedDaysAgo: 6, reason: 'Price too high' });
      await lead(org, customer, 'LOST', { closedDaysAgo: 7, reason: null });
      expect(await rateOf(await personWith(org, LEADS))).toMatchObject({ won: 1, lost: 4, rate: 20 });
    });

    it('shows the change against the 30 days before, by the date each lead closed', async () => {
      const { org, customer } = await newOrg();
      await lead(org, customer, 'WON', { closedDaysAgo: 2 });
      await lead(org, customer, 'LOST', { closedDaysAgo: 9, reason: 'Spam' });
      await lead(org, customer, 'WON', { closedDaysAgo: 45 });
      await lead(org, customer, 'LOST', { closedDaysAgo: 40, reason: 'Duplicate' });
      await lead(org, customer, 'LOST', { closedDaysAgo: 50 });
      await lead(org, customer, 'LOST', { closedDaysAgo: 70 });
      // 1 of 2 now (50%) against 1 of 3 before (33%); the lead closed 70 days ago is in neither.
      expect(await rateOf(await personWith(org, LEADS))).toMatchObject({ won: 1, lost: 1, rate: 50, vs_last_period_pp: 17 });
    });

    it('counts a lead by the day it closed, not by the day it last changed', async () => {
      const { org, customer } = await newOrg();
      // Closed long ago, edited yesterday: still an old close. Closed last week, last edited months ago: a current one.
      await lead(org, customer, 'WON', { closedDaysAgo: 100, changedDaysAgo: 1 });
      await lead(org, customer, 'LOST', { closedDaysAgo: 7, changedDaysAgo: 120 });
      expect(await rateOf(await personWith(org, LEADS))).toMatchObject({ won: 0, lost: 1, rate: 0 });
    });

    it('counts a lead closed before the close date was recorded at the day it last changed', async () => {
      const { org, customer } = await newOrg();
      await lead(org, customer, 'WON', { noCloseDate: true, changedDaysAgo: 12 });
      await lead(org, customer, 'LOST', { noCloseDate: true, changedDaysAgo: 14 });
      await lead(org, customer, 'LOST', { noCloseDate: true, changedDaysAgo: 90 });
      expect(await rateOf(await personWith(org, LEADS))).toMatchObject({ won: 1, lost: 1, rate: 50 });
    });

    it('leaves a lead migrated from Cancelled 90 days ago out of both windows, and counts one cancelled 10 days ago as Lost now', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, LEADS);
      // The migration leaves the last-changed date as it was, so the old one can look recent and the recent one old.
      await migrated(org, customer, 90, 5);
      expect(await rateOf(me)).toMatchObject({ won: 0, lost: 0, rate: 0, vs_last_period_pp: 0 });
      await migrated(org, customer, 10, 80);
      expect(await rateOf(me)).toMatchObject({ won: 0, lost: 1 });
      // Cancelled 45 days ago it is in the prior 30 days, so it moves the change and not the current count.
      await migrated(org, customer, 45, 45);
      await lead(org, customer, 'WON', { closedDaysAgo: 1 });
      expect(await rateOf(me)).toMatchObject({ won: 1, lost: 1, rate: 50, vs_last_period_pp: 50 });
    });

    it('takes a Won lead out of the count once it is reopened, and puts it back when it closes again', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, LEADS);
      const won = await lead(org, customer, 'WON', { closedDaysAgo: 5 });
      await lead(org, customer, 'LOST', { closedDaysAgo: 5, reason: 'Spam' });
      expect(await rateOf(me)).toMatchObject({ won: 1, lost: 1 });

      const reopened = await (await fx.signedInAs(await reopener(org))).post(`/api/leads/${won.id}/reopen`, { reason: 'Customer called back' });
      expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
      // The won date is still on the lead, and it is in neither count.
      expect((await db.lead.findUniqueOrThrow({ where: { id: won.id } })).won_at).not.toBeNull();
      expect(await rateOf(me)).toMatchObject({ won: 0, lost: 1 });
    });

    it('counts a lead first won long ago, reopened and won again today, at the new close', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, LEADS);
      // A person who may set a status by hand: a role with the Dispatcher grants and every switch on (a choice at its
      // widest option, a list empty), the way the reopen suite builds one.
      const closerRole = `dash-closer-${++sequence}`;
      const role = await fx.addCustomRole(org, closerRole, 'DISPATCHER');
      await fx.setRoleSwitches(
        org,
        closerRole,
        Object.fromEntries(
          SWITCH_CATALOG.map((sw) => [sw.key, sw.kind === 'choice' ? (sw.choices!.includes('all') ? 'all' : sw.choices![sw.choices!.length - 1]!) : sw.kind === 'list' ? [] : true]),
        ) as Record<string, SwitchValue>,
      );
      const closerPerson = await fx.addUser(org, `closer${sequence}`, 'DISPATCHER', { customRoleId: role.id });
      const won = await lead(org, customer, 'WON', { closedDaysAgo: 100, owner: closerPerson.id });
      expect(await rateOf(me)).toMatchObject({ won: 0, lost: 0 });

      const reopened = await (await fx.signedInAs(await reopener(org))).post(`/api/leads/${won.id}/reopen`, { reason: 'Customer called back' });
      expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
      expect(await rateOf(me)).toMatchObject({ won: 0, lost: 0 });

      // Closed again through the real route: the lead counts at that day, not at the first win 100 days ago.
      const wonAgain = await (await fx.signedInAs(closerPerson)).patch(`/api/leads/${won.id}`, { status: 'WON' });
      expect(wonAgain.status, JSON.stringify(wonAgain.body)).toBe(200);
      const row = await db.lead.findUniqueOrThrow({ where: { id: won.id } });
      expect(row.status).toBe('WON');
      expect(Date.now() - row.won_at!.getTime()).toBeLessThan(DAY);
      expect(await rateOf(me)).toMatchObject({ won: 1, lost: 0, rate: 100 });
    });

    it('takes a Lost lead out of the count once it is reopened', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, LEADS);
      const lost = await lead(org, customer, 'LOST', { closedDaysAgo: 2, reason: 'Duplicate' });
      const reopened = await (await fx.signedInAs(await reopener(org))).post(`/api/leads/${lost.id}/reopen`, { reason: 'Not a duplicate' });
      expect(reopened.status, JSON.stringify(reopened.body)).toBe(200);
      expect(await rateOf(me)).toMatchObject({ won: 0, lost: 0 });
    });

    it('counts no open lead: Walkthrough Scheduled, Walkthrough Completed, Estimate Sent, New and Contacted are in neither count', async () => {
      const { org, customer } = await newOrg();
      for (const status of ['NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'] as const) {
        // A won or lost date left on an open lead (it was reopened) must not count it either.
        await db.lead.update({ where: { id: (await lead(org, customer, status)).id }, data: { won_at: ago(3), lost_at: ago(3) } });
      }
      await lead(org, customer, 'WON', { closedDaysAgo: 3 });
      expect(await rateOf(await personWith(org, LEADS))).toMatchObject({ won: 1, lost: 0, rate: 100 });
    });

    it('covers only the person\'s own leads under Leads scope Attached, and every lead under All', async () => {
      const { org, customer } = await newOrg();
      const attached = await personWith(org, ATTACHED);
      const all = await personWith(org, LEADS);
      const other = await fx.addUser(org, 'cr-other', 'TECHNICIAN');
      await lead(org, customer, 'WON', { closedDaysAgo: 2, owner: attached.id });
      await lead(org, customer, 'LOST', { closedDaysAgo: 3, reason: 'Spam', dispatcher: attached.id });
      await lead(org, customer, 'WON', { closedDaysAgo: 4, owner: other.id });
      await lead(org, customer, 'LOST', { closedDaysAgo: 5, owner: other.id });
      await lead(org, customer, 'LOST', { closedDaysAgo: 6 });
      expect(await rateOf(attached)).toMatchObject({ won: 1, lost: 1, rate: 50 });
      expect(await rateOf(all)).toMatchObject({ won: 2, lost: 3, rate: 40 });
    });

    it('never counts a lead of another organization', async () => {
      const { org, customer } = await newOrg();
      const elsewhere = await newOrg();
      await lead(elsewhere.org, elsewhere.customer, 'LOST', { closedDaysAgo: 2 });
      await lead(org, customer, 'WON', { closedDaysAgo: 2 });
      expect(await rateOf(await personWith(org, LEADS))).toMatchObject({ won: 1, lost: 0 });
    });

    it('gives the tile, the Leads report and the Leads page the same Won and Lost counts on the same leads (All scope)', async () => {
      const { org, customer, admin } = await newOrg();
      await lead(org, customer, 'WON', { closedDaysAgo: 0 });
      await lead(org, customer, 'WON', { closedDaysAgo: 0 });
      await lead(org, customer, 'LOST', { closedDaysAgo: 0, reason: 'Spam' });
      await lead(org, customer, 'LOST', { closedDaysAgo: 0, reason: 'Duplicate' });
      await lead(org, customer, 'LOST', { closedDaysAgo: 0, reason: 'Price' });
      await migrated(org, customer, 0, 60);
      for (const status of ['NEW', 'WALKTHROUGH_COMPLETED', 'ESTIMATED'] as const) await lead(org, customer, status);
      const reopened = await lead(org, customer, 'CONTACTED');
      await db.lead.update({ where: { id: reopened.id }, data: { won_at: ago(1) } });

      const tile = await rateOf(admin);
      const report = await (await fx.signedInAs(admin)).get('/api/reports/leads');
      expect(report.status, JSON.stringify(report.body)).toBe(200);
      const rows = report.body.leads as Array<{ status: string }>;
      expect({ won: tile.won, lost: tile.lost }).toEqual({ won: 2, lost: 4 });
      expect(rows.filter((r) => r.status === 'Sold-done')).toHaveLength(tile.won);
      expect(rows.filter((r) => r.status === 'Lost')).toHaveLength(tile.lost);

      const page = await (await fx.signedInAs(admin)).get('/api/leads/stats');
      expect(page.status, JSON.stringify(page.body)).toBe(200);
      expect({ won: page.body.won_this_month, lost: page.body.lost_this_month }).toEqual({ won: tile.won, lost: tile.lost });
    });

    it('keeps the Leads page\'s Won and Lost this month off reopened leads and off leads closed in earlier months', async () => {
      const { org, customer, admin } = await newOrg();
      await lead(org, customer, 'WON', { closedDaysAgo: 0 });
      await lead(org, customer, 'WON', { closedDaysAgo: 0 });
      await lead(org, customer, 'WON', { closedDaysAgo: 100, changedDaysAgo: 0 });
      await lead(org, customer, 'LOST', { closedDaysAgo: 100, changedDaysAgo: 0 });
      const reopened = await lead(org, customer, 'CONTACTED');
      await db.lead.update({ where: { id: reopened.id }, data: { won_at: ago(0), lost_at: ago(0) } });
      const page = await (await fx.signedInAs(admin)).get('/api/leads/stats');
      expect({ won: page.body.won_this_month, lost: page.body.lost_this_month }).toEqual({ won: 2, lost: 0 });
    });

    it('feeds Smart Insights the same figure', async () => {
      const { org, customer } = await newOrg();
      await lead(org, customer, 'WON', { closedDaysAgo: 2 });
      await lead(org, customer, 'LOST', { closedDaysAgo: 3, reason: 'Spam' });
      await lead(org, customer, 'LOST', { closedDaysAgo: 4, reason: 'Duplicate' });
      await migrated(org, customer, 90, 3);
      await lead(org, customer, 'WON', { closedDaysAgo: 40 });
      const me = await personWith(org, { ...LEADS, view_invoices: true, see_company_figures: true, jobs_scope: 'all', leads_scope: 'all' });
      const together = await dashboardOf(me, '?tiles=kpi.close_rate,smart_insights');
      const nudge = (answer: Answer) => answer.data.smart_insights.find((i: { id: string }) => i.id === 'pipeline_nudge');
      // 1 of 3 now (33%) against 1 of 1 before (100%).
      expect(together.data['kpi.close_rate']).toMatchObject({ won: 1, lost: 2, rate: 33, vs_last_period_pp: -67 });
      expect(nudge(together).text).toMatch(/^Close rate 33% \(-67pp\)\./);
      expect(nudge(await dashboardOf(me, '?tiles=smart_insights')).text).toBe(nudge(together).text);
    });
  });

  describe('the saved layout (route-level rows: read my layout, save my layout)', () => {
    type Entry = { id: string; visible: boolean; size?: string; range?: string; available?: false };
    type LayoutAnswer = { layout: Entry[] };
    const JOBS_AND_LEADS = { view_jobs: true, view_leads: true, ...ALL_SCOPES };
    const [JOBS_TODAY, OPEN_LEADS, JOBS_WEEK] = ['kpi.jobs_today', 'kpi.open_leads', 'kpi.jobs_week'];

    const readLayout = async (person: Person): Promise<LayoutAnswer> => {
      const res = await (await fx.signedInAs(person)).get('/api/dashboard/layout');
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body as LayoutAnswer;
    };
    const saveLayout = async (person: Person, layout: unknown) => (await fx.signedInAs(person)).put('/api/dashboard/layout', { layout });
    const savedOk = async (person: Person, layout: Entry[]): Promise<LayoutAnswer> => {
      const res = await saveLayout(person, layout);
      expect(res.status, JSON.stringify(res.body)).toBe(200);
      return res.body as LayoutAnswer;
    };
    const ids = (layout: Entry[]) => layout.map((e) => e.id);

    /** The preset's default, cut to the tiles its switch values unlock (the expectation comes from the catalogs). */
    const defaultOf = (preset: 'ADMIN' | 'TECHNICIAN') => {
      const eligible = new Set(eligibleTiles(presetValues(preset) as SwitchValues).map((t) => t.id));
      return defaultLayoutOf(preset).filter((e) => eligible.has(e.id));
    };

    it('returns what was saved, in the same order with the same choices, to a later session of the same person', async () => {
      const { org } = await newOrg();
      const me = await personWith(org, JOBS_AND_LEADS);
      const sent: Entry[] = [
        { id: OPEN_LEADS, visible: true, size: 'full', range: '7d' },
        { id: JOBS_TODAY, visible: false },
        { id: JOBS_WEEK, visible: true, size: 'half', range: 'month' },
      ];
      expect((await savedOk(me, sent)).layout).toEqual(sent);
      expect((await readLayout(me)).layout).toEqual(sent);
      // A second sign-in (nothing carried from the first) reads the same.
      expect((await readLayout(me)).layout).toEqual(sent);
    });

    it('lets one person save and read only their own: another person, in the same company or another, is not touched', async () => {
      const first = await newOrg();
      const mine = await personWith(first.org, JOBS_AND_LEADS);
      const colleague = await personWith(first.org, JOBS_AND_LEADS);
      const stranger = await personWith((await newOrg()).org, JOBS_AND_LEADS);
      const before = await readLayout(colleague);
      const strangerBefore = await readLayout(stranger);
      await savedOk(mine, [{ id: JOBS_WEEK, visible: true }]);
      expect(await readLayout(colleague)).toEqual(before);
      expect(await readLayout(stranger)).toEqual(strangerBefore);
      // The save names no person: a user id in the body or in the address is not read, and there is no route for it.
      const res = await (await fx.signedInAs(mine)).put('/api/dashboard/layout', { layout: [{ id: OPEN_LEADS, visible: true }], user_id: colleague.id });
      expect(res.status).toBe(200);
      expect(await readLayout(colleague)).toEqual(before);
      // (the tile they saved before and left out of this save is kept, hidden: S09.8)
      expect((await readLayout(mine)).layout).toEqual([{ id: JOBS_WEEK, visible: false }, { id: OPEN_LEADS, visible: true }]);
      const other = await (await fx.signedInAs(mine)).put(`/api/dashboard/layout/${colleague.id}`, { layout: [] });
      expect(other.status).toBe(404);
      expect((await (await fx.signedInAs(mine)).get(`/api/dashboard/layout/${colleague.id}`)).status).toBe(404);
      expect(await readLayout(colleague)).toEqual(before);
    });

    it('stores one row per person, in their company', async () => {
      const { org } = await newOrg();
      const me = await personWith(org, JOBS_AND_LEADS);
      await savedOk(me, [{ id: JOBS_WEEK, visible: true }]);
      await savedOk(me, [{ id: JOBS_TODAY, visible: true }]);
      const rows = await db.userDashboardLayout.findMany({ where: { user_id: me.id } });
      expect(rows).toHaveLength(1);
      expect(rows[0]!.organization_id).toBe(org);
    });

    it('refuses a request from nobody signed in', async () => {
      const request = (await import('supertest')).default;
      const app = (await import('../app.js')).default as never;
      expect((await request(app).get('/api/dashboard/layout')).status).toBe(401);
      expect((await request(app).put('/api/dashboard/layout').send({ layout: [] })).status).toBe(401);
    });

    it('gives a person with no saved layout the default of the role they are based on', async () => {
      const { org, admin } = await newOrg();
      const technician = await fx.addCustomRole(org, 'senior-tech', 'TECHNICIAN');
      const fromIt = await fx.addCustomRole(org, 'senior-tech-two', 'TECHNICIAN');
      await db.customRole.update({ where: { id: fromIt.id }, data: { made_from_role_key: technician.key } });
      const direct = await fx.addUser(org, 'senior', 'TECHNICIAN', { customRoleId: technician.id });
      const chained = await fx.addUser(org, 'chained', 'TECHNICIAN', { customRoleId: fromIt.id });
      const blank = await personWith(org, {});
      const stock = await fx.addUser(org, 'stock', 'TECHNICIAN');

      expect((await readLayout(direct)).layout).toEqual(defaultOf('TECHNICIAN'));
      expect((await readLayout(chained)).layout).toEqual(defaultOf('TECHNICIAN'));
      expect((await readLayout(stock)).layout).toEqual(defaultOf('TECHNICIAN'));
      expect((await readLayout(blank)).layout).toEqual([]);
      expect((await readLayout(admin)).layout).toEqual(defaultOf('ADMIN'));
      expect(defaultOf('TECHNICIAN').length).toBeGreaterThan(0);
      // Reading a default does not save one: nothing is stored for a person who has not changed anything.
      expect(await db.userDashboardLayout.count({ where: { user_id: { in: [direct.id, chained.id, blank.id, stock.id, admin.id] } } })).toBe(0);
    });

    it('follows a role made from another role to the preset behind it, whether or not the first role is still active', async () => {
      const { org } = await newOrg();
      const source = await fx.addCustomRole(org, 'source-role', 'TECHNICIAN');
      const copy = await fx.addCustomRole(org, 'copy-of-source', 'TECHNICIAN');
      await db.customRole.update({ where: { id: copy.id }, data: { made_from_role_key: source.key } });
      const person = await fx.addUser(org, 'copyholder', 'TECHNICIAN', { customRoleId: copy.id });
      await db.customRole.update({ where: { id: source.id }, data: { archived_at: new Date() } });
      expect((await readLayout(person)).layout).toEqual(defaultOf('TECHNICIAN'));
      await db.customRole.update({ where: { id: copy.id }, data: { made_from_role_key: 'a-role-that-no-longer-exists' } });
      expect((await readLayout(person)).layout).toEqual(defaultOf('TECHNICIAN'));
      // A role pointing at itself, or in a circle, cannot hang the read.
      await db.customRole.update({ where: { id: copy.id }, data: { made_from_role_key: copy.key } });
      await db.customRole.update({ where: { id: source.id }, data: { made_from_role_key: copy.key } });
      expect((await readLayout(person)).layout).toEqual(defaultOf('TECHNICIAN'));
    });

    it('sends a layout stored in a shape it cannot read as the role default, not an error', async () => {
      const { org } = await newOrg();
      const me = await personWith(org, JOBS_AND_LEADS);
      await db.userDashboardLayout.create({ data: { user_id: me.id, organization_id: org, layout: { not: 'a list' } } });
      const answer = await readLayout(me);
      expect(answer.layout).toEqual([]);
    });

    it('stores the time-range choice and sends it back, and the numbers do not change with it', async () => {
      const { org } = await newOrg();
      const me = await personWith(org, JOBS_AND_LEADS);
      const before = await dashboardOf(me);
      const saved = await savedOk(me, [{ id: JOBS_WEEK, visible: true, range: 'today' }, { id: JOBS_TODAY, visible: true, range: 'all' }]);
      expect(saved.layout.map((e) => e.range)).toEqual(['today', 'all']);
      expect((await readLayout(me)).layout.map((e) => e.range)).toEqual(['today', 'all']);
      const after = await dashboardOf(me);
      expect(after.data).toEqual(before.data);
    });

    /** A person on a custom role whose switches the test can change (and read back through the real routes). */
    async function personWhoCanLoseAccess(org: string, values: Record<string, boolean | string>) {
      const key = `layout-role-${++sequence}`;
      await fx.addCustomRole(org, key, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
      const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key } });
      const setSwitches = async (next: Record<string, boolean | string>) => {
        await fx.setRoleSwitches(org, key, { ...allOff, see_prices: true, ...next });
        // A person's own stored switches were copied onto them when the role was given, so clear those too.
        await db.permissionUserSwitch.deleteMany({ where: { user_id: me.id } });
        clearSwitchCacheForUser(me.id);
      };
      await fx.setRoleSwitches(org, key, { ...allOff, see_prices: true, ...values });
      const me = await fx.addUser(org, `layout-p${sequence}`, 'TECHNICIAN', { customRoleId: role.id, basedOnRoleKey: key });
      return { me, setSwitches };
    }
    const storedLayout = async (person: Person) => (await db.userDashboardLayout.findUnique({ where: { user_id: person.id } }))?.layout;
    const WITHOUT_LEADS = { view_jobs: true, jobs_scope: 'all' };
    const LEADS_STORED_AS: Entry = { id: OPEN_LEADS, visible: true, size: 'full', range: '7d' };

    describe('a tile the person lost stays in place and comes back (S09.7)', () => {
      it('sends a stored tile whose category the person lost back in its place, flagged not available, and does not draw it', async () => {
        const { org } = await newOrg();
        const { me, setSwitches } = await personWhoCanLoseAccess(org, JOBS_AND_LEADS);
        await savedOk(me, [{ id: JOBS_TODAY, visible: true }, LEADS_STORED_AS, { id: JOBS_WEEK, visible: true }]);
        await setSwitches(WITHOUT_LEADS);
        expect((await readLayout(me)).layout).toEqual([
          { id: JOBS_TODAY, visible: true }, { ...LEADS_STORED_AS, available: false }, { id: JOBS_WEEK, visible: true },
        ]);
        // The dashboard itself no longer carries the tile, and nothing is flagged for a tile the person has.
        expect((await dashboardOf(me)).tiles.map((t) => t.id)).not.toContain(OPEN_LEADS);
        await setSwitches(JOBS_AND_LEADS);
        expect((await readLayout(me)).layout.some((e) => 'available' in e)).toBe(false);
      });

      it('saves a reorder whether the client sends the lost tile back as shown or leaves it out, and the tile is back, shown, in its old place when the access returns', async () => {
        const { org } = await newOrg();
        const { me, setSwitches } = await personWhoCanLoseAccess(org, JOBS_AND_LEADS);
        await savedOk(me, [{ id: JOBS_TODAY, visible: true }, LEADS_STORED_AS, { id: JOBS_WEEK, visible: true }]);
        await setSwitches(WITHOUT_LEADS);

        // The page sends back what it was given (the lost tile included), the other two swapped.
        const given = (await readLayout(me)).layout;
        const swapped = [given[2]!, given[1]!, given[0]!];
        const echoed = await savedOk(me, swapped);
        // The lost tile goes back right after the tile it followed, whatever place the client gave it.
        expect(ids(echoed.layout)).toEqual([JOBS_WEEK, JOBS_TODAY, OPEN_LEADS]);
        await setSwitches(JOBS_AND_LEADS);
        expect((await readLayout(me)).layout).toEqual([{ id: JOBS_WEEK, visible: true }, { id: JOBS_TODAY, visible: true }, LEADS_STORED_AS]);

        // The same again with the client leaving the lost tile out of what it sends.
        await setSwitches(WITHOUT_LEADS);
        const left = await savedOk(me, [{ id: JOBS_TODAY, visible: true }, { id: JOBS_WEEK, visible: true }]);
        expect(ids(left.layout)).toEqual([JOBS_TODAY, OPEN_LEADS, JOBS_WEEK]);
        await setSwitches(JOBS_AND_LEADS);
        expect((await readLayout(me)).layout).toEqual([{ id: JOBS_TODAY, visible: true }, LEADS_STORED_AS, { id: JOBS_WEEK, visible: true }]);
      });

      it('keeps the stored state of a lost tile whatever the client sends for it', async () => {
        const { org } = await newOrg();
        const { me, setSwitches } = await personWhoCanLoseAccess(org, JOBS_AND_LEADS);
        await savedOk(me, [{ id: JOBS_TODAY, visible: true }, LEADS_STORED_AS]);
        await setSwitches(WITHOUT_LEADS);
        // Hidden, resized and moved to the front by the client: none of it is stored.
        await savedOk(me, [{ id: OPEN_LEADS, visible: false, size: 'kpi', range: 'all' }, { id: JOBS_TODAY, visible: true }]);
        expect(await storedLayout(me)).toEqual([{ id: JOBS_TODAY, visible: true }, LEADS_STORED_AS]);
        // And a tile stored hidden stays hidden.
        await setSwitches(JOBS_AND_LEADS);
        await savedOk(me, [{ id: JOBS_TODAY, visible: true }, { id: OPEN_LEADS, visible: false, size: 'half' }]);
        await setSwitches(WITHOUT_LEADS);
        await savedOk(me, [{ id: JOBS_TODAY, visible: true }, { id: OPEN_LEADS, visible: false, size: 'full' }]);
        expect(await storedLayout(me)).toEqual([{ id: JOBS_TODAY, visible: true }, { id: OPEN_LEADS, visible: false, size: 'half' }]);
      });

      it('refuses a save that turns a tile the person cannot have from hidden into shown, and stores nothing', async () => {
        const { org } = await newOrg();
        const { me, setSwitches } = await personWhoCanLoseAccess(org, JOBS_AND_LEADS);
        await savedOk(me, [{ id: JOBS_TODAY, visible: true }, { id: OPEN_LEADS, visible: false }]);
        await setSwitches(WITHOUT_LEADS);
        const before = await storedLayout(me);
        const res = await saveLayout(me, [{ id: OPEN_LEADS, visible: true }, { id: JOBS_TODAY, visible: true }]);
        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(await storedLayout(me)).toEqual(before);
        // The reply is plain words for the person: no tile id, no switch name.
        expect(JSON.stringify(res.body)).not.toContain(OPEN_LEADS);
        expect(typeof res.body.error).toBe('string');
      });

      it('refuses a save that turns a tile the person cannot have from not stored into shown', async () => {
        const { org } = await newOrg();
        const { me } = await personWhoCanLoseAccess(org, WITHOUT_LEADS);
        await savedOk(me, [{ id: JOBS_TODAY, visible: true }]);
        const res = await saveLayout(me, [{ id: JOBS_TODAY, visible: true }, { id: OPEN_LEADS, visible: true }]);
        expect(res.status, JSON.stringify(res.body)).toBe(409);
        expect(await storedLayout(me)).toEqual([{ id: JOBS_TODAY, visible: true }]);
        // Sent hidden it turns nothing on, so it is simply not stored.
        const hidden = await savedOk(me, [{ id: JOBS_TODAY, visible: true }, { id: OPEN_LEADS, visible: false }]);
        expect(ids(hidden.layout)).toEqual([JOBS_TODAY]);
        expect(await storedLayout(me)).toEqual([{ id: JOBS_TODAY, visible: true }]);
        // A person with no saved layout at all is refused the same way.
        const fresh = (await personWhoCanLoseAccess((await newOrg()).org, WITHOUT_LEADS)).me;
        expect((await saveLayout(fresh, [{ id: OPEN_LEADS, visible: true }])).status).toBe(409);
        expect(await db.userDashboardLayout.count({ where: { user_id: fresh.id } })).toBe(0);
      });

      it('drops a tile id the catalog does not know and saves the rest', async () => {
        const { org } = await newOrg();
        const me = await personWith(org, JOBS_AND_LEADS);
        const res = await savedOk(me, [{ id: JOBS_TODAY, visible: true }, { id: 'tile.that.never.existed', visible: true }, { id: JOBS_WEEK, visible: false }]);
        expect(ids(res.layout)).toEqual([JOBS_TODAY, JOBS_WEEK]);
        expect(await storedLayout(me)).toEqual([{ id: JOBS_TODAY, visible: true }, { id: JOBS_WEEK, visible: false }]);
      });

      it('never stores the flag: a client that sends it back leaves nothing in the saved layout', async () => {
        const { org } = await newOrg();
        const { me, setSwitches } = await personWhoCanLoseAccess(org, JOBS_AND_LEADS);
        await savedOk(me, [{ id: JOBS_TODAY, visible: true }, LEADS_STORED_AS]);
        await setSwitches(WITHOUT_LEADS);
        await savedOk(me, (await readLayout(me)).layout);
        expect(JSON.stringify(await storedLayout(me))).not.toContain('available');
      });

      it('sends a role default with only the tiles the person has, and a reset replaces the whole saved layout, lost tiles included', async () => {
        const { org } = await newOrg();
        const { me, setSwitches } = await personWhoCanLoseAccess(org, JOBS_AND_LEADS);
        await savedOk(me, [{ id: JOBS_TODAY, visible: true }, LEADS_STORED_AS]);
        await setSwitches(WITHOUT_LEADS);
        const res = await (await fx.signedInAs(me)).post('/api/dashboard/layout/reset');
        expect(res.status).toBe(200);
        expect((res.body.layout as Entry[]).some((e) => e.id === OPEN_LEADS || 'available' in e)).toBe(false);
        expect(JSON.stringify(await storedLayout(me))).not.toContain(OPEN_LEADS);
      });
    });

    describe('new default tiles are appended once, and a hidden tile stays hidden (S09.8)', () => {
      afterEach(() => {
        for (const preset of Object.keys(defaultsInForce)) delete defaultsInForce[preset];
      });
      /** Tiles a Technician-preset person may have (read from the catalogs), none of them in the real default's way. */
      const mayHave = eligibleTiles(presetValues('TECHNICIAN') as SwitchValues).map((t) => t.id);
      const [A, B, C, D] = mayHave as [string, string, string, string];
      const setDefault = (ids: string[], preset = 'TECHNICIAN') => { defaultsInForce[preset] = ids; };
      /** A person on a role made from the Technician preset: their default is what `setDefault` says. */
      async function technician(org: string) {
        const role = await fx.addCustomRole(org, `append-${++sequence}`, 'TECHNICIAN');
        return fx.addUser(org, `append-p${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
      }
      const storedIds = async (person: Person) => ids(((await storedLayout(person)) ?? []) as Entry[]);

      it('has enough tiles for a Technician to tell the cases apart', () => {
        expect(mayHave.length).toBeGreaterThanOrEqual(4);
      });

      it('puts a tile added to the role default at the end of a saved layout, shown, and writes nothing on the read', async () => {
        const { org } = await newOrg();
        const me = await technician(org);
        setDefault([A, B]);
        await savedOk(me, [{ id: B, visible: true, size: 'half' }, { id: A, visible: false }]);
        setDefault([A, B, C]);
        expect((await readLayout(me)).layout).toEqual([{ id: B, visible: true, size: 'half' }, { id: A, visible: false }, { id: C, visible: true }]);
        expect(await storedIds(me)).toEqual([B, A]);
      });

      it('adds the tile once: not again after the person moves it, removes it, or hides another tile, however the default changes', async () => {
        const { org } = await newOrg();
        const me = await technician(org);
        setDefault([A, B]);
        await savedOk(me, [{ id: A, visible: true }, { id: B, visible: true }]);
        setDefault([A, B, C]);
        const added = (await readLayout(me)).layout;
        expect(ids(added)).toEqual([A, B, C]);
        // The page saves the whole list it was shown; here the person also moves the new tile to the front.
        await savedOk(me, [added[2]!, added[0]!, added[1]!]);
        expect(ids((await readLayout(me)).layout)).toEqual([C, A, B]);
        // The person removes it (the save leaves it out): it is not added again, and stays out of sight.
        await savedOk(me, [{ id: A, visible: true }, { id: B, visible: true }]);
        const removed = (await readLayout(me)).layout;
        expect(removed.filter((e) => e.id === C)).toEqual([{ id: C, visible: false }]);
        expect(ids(removed)).toEqual([C, A, B]);
        // Hiding another tile, then a changed default: the hidden one stays hidden, the removed one stays removed.
        await savedOk(me, [{ id: C, visible: false }, { id: A, visible: false }, { id: B, visible: true }]);
        setDefault([A, B, C, D]);
        const withD = [{ id: C, visible: false }, { id: A, visible: false }, { id: B, visible: true }, { id: D, visible: true }];
        expect((await readLayout(me)).layout).toEqual(withD);
        await savedOk(me, withD);
        // A default that drops tiles takes nothing from the saved layout, and one that brings them back adds nothing.
        setDefault([B]);
        expect((await readLayout(me)).layout).toEqual(withD);
        setDefault([A, B, C, D]);
        expect((await readLayout(me)).layout).toEqual(withD);
      });

      it('keeps a tile the person hid hidden, with its size and range, when the default changes', async () => {
        const { org } = await newOrg();
        const me = await technician(org);
        setDefault([A, B]);
        await savedOk(me, [{ id: A, visible: false, size: 'full', range: '7d' }, { id: B, visible: true }]);
        setDefault([B, C, A]);
        expect((await readLayout(me)).layout).toEqual([{ id: A, visible: false, size: 'full', range: '7d' }, { id: B, visible: true }, { id: C, visible: true }]);
      });

      it('answers a save with the same merged layout a read gives, and the next save stores it', async () => {
        const { org } = await newOrg();
        const me = await technician(org);
        setDefault([A]);
        await savedOk(me, [{ id: A, visible: true }]);
        setDefault([A, B]);
        const saved = await savedOk(me, [{ id: A, visible: true, size: 'half' }]);
        expect(saved.layout).toEqual((await readLayout(me)).layout);
        expect(ids(saved.layout)).toEqual([A, B]);
        await savedOk(me, saved.layout);
        expect(await storedIds(me)).toEqual([A, B]);
      });

      it('does not add a default tile the person may not have, nor remember it as given: it arrives with the access', async () => {
        const { org } = await newOrg();
        const key = `append-narrowed-${++sequence}`;
        const role = await fx.addCustomRole(org, key, 'DISPATCHER');
        const me = await fx.addUser(org, `append-narrowed-${sequence}`, 'DISPATCHER', { customRoleId: role.id });
        const setSwitches = async (values: Record<string, boolean | string>) => {
          await fx.setRoleSwitches(org, key, { ...allOff, see_prices: true, ...values });
          await db.permissionUserSwitch.deleteMany({ where: { user_id: me.id } });
          clearSwitchCacheForUser(me.id);
        };
        await setSwitches(WITHOUT_LEADS);
        setDefault([JOBS_TODAY, OPEN_LEADS], 'DISPATCHER');
        expect(ids((await readLayout(me)).layout)).toEqual([JOBS_TODAY]);
        await savedOk(me, [{ id: JOBS_TODAY, visible: true }]);
        setDefault([JOBS_TODAY, OPEN_LEADS, JOBS_WEEK], 'DISPATCHER');
        expect(ids((await readLayout(me)).layout)).toEqual([JOBS_TODAY, JOBS_WEEK]);
        await savedOk(me, [{ id: JOBS_TODAY, visible: true }, { id: JOBS_WEEK, visible: true }]);
        expect(await storedIds(me)).toEqual([JOBS_TODAY, JOBS_WEEK]);
        await setSwitches(JOBS_AND_LEADS);
        expect((await readLayout(me)).layout).toEqual([{ id: JOBS_TODAY, visible: true }, { id: JOBS_WEEK, visible: true }, { id: OPEN_LEADS, visible: true }]);
      });

      it('adds the default tiles a carried-over browser copy lacked, once, on the first read after the carry-over', async () => {
        const { org } = await newOrg();
        const me = await technician(org);
        setDefault([A, B, C]);
        const carried = await (await fx.signedInAs(me)).post('/api/dashboard/layout/carry-over', { layout: [{ id: B, visible: true, size: 'full' }, { id: A, visible: false }] });
        expect(carried.status, JSON.stringify(carried.body)).toBe(200);
        const expected = [{ id: B, visible: true, size: 'full' }, { id: A, visible: false }, { id: C, visible: true }];
        expect(carried.body.layout).toEqual(expected);
        expect(await storedIds(me)).toEqual([B, A]);
        expect((await readLayout(me)).layout).toEqual(expected);
        // The page saves what it was shown; the person then hides the added tile. It stays hidden from there on.
        await savedOk(me, [expected[0]!, expected[1]!, { id: C, visible: false }]);
        setDefault([A, B, C, D]);
        expect((await readLayout(me)).layout).toEqual([expected[0], expected[1], { id: C, visible: false }, { id: D, visible: true }]);
      });

      it('leaves a person with no saved layout on their role default, and a reset on the current default', async () => {
        const { org } = await newOrg();
        const me = await technician(org);
        setDefault([A, B]);
        expect((await readLayout(me)).layout).toEqual([{ id: A, visible: true }, { id: B, visible: true }]);
        expect(await db.userDashboardLayout.count({ where: { user_id: me.id } })).toBe(0);
        await savedOk(me, [{ id: B, visible: true }]);
        setDefault([A, B, C]);
        const reset = await (await fx.signedInAs(me)).post('/api/dashboard/layout/reset', {});
        expect(reset.body.layout).toEqual([{ id: A, visible: true }, { id: B, visible: true }, { id: C, visible: true }]);
      });
    });

    it('refuses a layout that is not a list of tiles with a known size and range', async () => {
      const { org } = await newOrg();
      const me = await personWith(org, JOBS_AND_LEADS);
      for (const bad of [
        'nothing', { id: JOBS_TODAY }, [{ id: JOBS_TODAY }], [{ visible: true }], [{ id: JOBS_TODAY, visible: true, size: 'huge' }],
        [{ id: JOBS_TODAY, visible: true, range: 'forever' }], [{ id: 7, visible: true }],
        Array.from({ length: TILE_CATALOG.length * 4 + 1 }, () => ({ id: JOBS_TODAY, visible: true })),
      ]) {
        const res = await saveLayout(me, bad);
        expect(res.status, JSON.stringify(bad).slice(0, 80)).toBe(400);
      }
      expect(await db.userDashboardLayout.count({ where: { user_id: me.id } })).toBe(0);
    });

    it('is deleted by the company purge', async () => {
      const { org } = await newOrg();
      const me = await personWith(org, JOBS_AND_LEADS);
      await savedOk(me, [{ id: JOBS_TODAY, visible: true }]);
      expect(await db.userDashboardLayout.count({ where: { organization_id: org } })).toBe(1);
      const { purgeOrganization } = await import('../lib/purge.js');
      await db.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(`SELECT set_config('app.bypass_rls', 'on', true)`);
        await purgeOrganization(tx, org, 'switches-');
      }, { timeout: 60_000 });
      expect(await db.userDashboardLayout.count({ where: { organization_id: org } })).toBe(0);
    });

    describe('the Unscheduled jobs tile reaches a person who saved a layout before it existed (S09.9)', () => {
      it('appends it once at the end of an older saved layout, shown, and leaves it hidden once the person hides it', async () => {
        const { org } = await newOrg();
        const role = await fx.addCustomRole(org, `unsched-layout-${++sequence}`, 'DISPATCHER');
        const me = await fx.addUser(org, `unsched-layout-p${sequence}`, 'DISPATCHER', { customRoleId: role.id });
        // The layout the person saved before the tile existed: the Dispatcher default without it.
        const older = defaultLayoutOf('DISPATCHER').filter((e) => e.id !== 'unscheduled_jobs');
        expect(older.length).toBe(defaultLayoutOf('DISPATCHER').length - 1);
        await savedOk(me, older);

        const shown = (await readLayout(me)).layout;
        expect(ids(shown)).toEqual([...ids(older), 'unscheduled_jobs']);
        expect(shown[shown.length - 1]).toEqual({ id: 'unscheduled_jobs', visible: true });
        // Reading writes nothing: the stored list is still the older one.
        expect(ids(((await storedLayout(me)) ?? []) as Entry[])).toEqual(ids(older));

        // The page saves what it showed and the person hides the tile: it stays once, hidden.
        await savedOk(me, shown.map((e) => (e.id === 'unscheduled_jobs' ? { ...e, visible: false } : e)));
        const after = (await readLayout(me)).layout;
        expect(after.filter((e) => e.id === 'unscheduled_jobs')).toEqual([{ id: 'unscheduled_jobs', visible: false }]);
      });
    });

    describe('the Office review queue tile reaches a person who saved a layout before it existed (S09.10)', () => {
      it('appends it once at the end of an older saved layout, shown, and leaves it hidden once the person hides it', async () => {
        const { org } = await newOrg();
        const role = await fx.addCustomRole(org, `queue-layout-${++sequence}`, 'DISPATCHER');
        const me = await fx.addUser(org, `queue-layout-p${sequence}`, 'DISPATCHER', { customRoleId: role.id });
        const older = defaultLayoutOf('DISPATCHER').filter((e) => e.id !== 'office_review_queue');
        expect(older.length).toBe(defaultLayoutOf('DISPATCHER').length - 1);
        await savedOk(me, older);

        const shown = (await readLayout(me)).layout;
        expect(ids(shown)).toEqual([...ids(older), 'office_review_queue']);
        expect(shown[shown.length - 1]).toEqual({ id: 'office_review_queue', visible: true });
        expect(ids(((await storedLayout(me)) ?? []) as Entry[])).toEqual(ids(older));

        await savedOk(me, shown.map((e) => (e.id === 'office_review_queue' ? { ...e, visible: false } : e)));
        const after = (await readLayout(me)).layout;
        expect(after.filter((e) => e.id === 'office_review_queue')).toEqual([{ id: 'office_review_queue', visible: false }]);
      });
    });

    describe('the Missing lead owner tile reaches a person who saved a layout before it existed (S09.11)', () => {
      it('appends it once at the end of an older saved layout, shown, and leaves it hidden once the person hides it', async () => {
        const { org } = await newOrg();
        const role = await fx.addCustomRole(org, `owner-layout-${++sequence}`, 'DISPATCHER');
        const me = await fx.addUser(org, `owner-layout-p${sequence}`, 'DISPATCHER', { customRoleId: role.id });
        const older = defaultLayoutOf('DISPATCHER').filter((e) => e.id !== 'missing_lead_owner');
        expect(older.length).toBe(defaultLayoutOf('DISPATCHER').length - 1);
        await savedOk(me, older);

        const shown = (await readLayout(me)).layout;
        expect(ids(shown)).toEqual([...ids(older), 'missing_lead_owner']);
        expect(shown[shown.length - 1]).toEqual({ id: 'missing_lead_owner', visible: true });
        expect(ids(((await storedLayout(me)) ?? []) as Entry[])).toEqual(ids(older));

        await savedOk(me, shown.map((e) => (e.id === 'missing_lead_owner' ? { ...e, visible: false } : e)));
        const after = (await readLayout(me)).layout;
        expect(after.filter((e) => e.id === 'missing_lead_owner')).toEqual([{ id: 'missing_lead_owner', visible: false }]);
      });

      it('is in the Dispatcher default and stays fully eligible for a person on that preset', async () => {
        const { org } = await newOrg();
        const dispatcher = await fx.addUser(org, `owner-default-p${++sequence}`, 'DISPATCHER');
        const shown = ids((await readLayout(dispatcher)).layout);
        expect(shown).toContain('missing_lead_owner');
        const answer = await dashboardOf(dispatcher);
        for (const id of shown) expect(tile(answer, id), id).toBeDefined();
      });
    });

    describe('the Missing crew tile reaches a person who saved a layout before it existed (S09.13)', () => {
      it('appends it once at the end of an older saved layout, shown, and leaves it hidden once the person hides it', async () => {
        const { org } = await newOrg();
        const role = await fx.addCustomRole(org, `crew-layout-${++sequence}`, 'DISPATCHER');
        const me = await fx.addUser(org, `crew-layout-p${sequence}`, 'DISPATCHER', { customRoleId: role.id });
        const older = defaultLayoutOf('DISPATCHER').filter((e) => e.id !== 'missing_crew');
        expect(older.length).toBe(defaultLayoutOf('DISPATCHER').length - 1);
        await savedOk(me, older);

        const shown = (await readLayout(me)).layout;
        expect(ids(shown)).toEqual([...ids(older), 'missing_crew']);
        expect(shown[shown.length - 1]).toEqual({ id: 'missing_crew', visible: true });
        expect(ids(((await storedLayout(me)) ?? []) as Entry[])).toEqual(ids(older));

        await savedOk(me, shown.map((e) => (e.id === 'missing_crew' ? { ...e, visible: false } : e)));
        const after = (await readLayout(me)).layout;
        expect(after.filter((e) => e.id === 'missing_crew')).toEqual([{ id: 'missing_crew', visible: false }]);
      });

      it('is in the Dispatcher default beside Missing lead owner and stays fully eligible for a person on that preset', async () => {
        const { org } = await newOrg();
        const dispatcher = await fx.addUser(org, `crew-default-p${++sequence}`, 'DISPATCHER');
        const shown = ids((await readLayout(dispatcher)).layout);
        expect(shown).toEqual(expect.arrayContaining(['missing_crew', 'missing_lead_owner']));
        const answer = await dashboardOf(dispatcher);
        for (const id of shown) expect(tile(answer, id), id).toBeDefined();
      });
    });

    describe('the Jobs this month tile reaches a person who saved a layout before it existed (S09.16)', () => {
      it('appends it once at the end of an older saved Technician layout, shown, and leaves it hidden once the person hides it', async () => {
        const { org } = await newOrg();
        const role = await fx.addCustomRole(org, `month-layout-${++sequence}`, 'TECHNICIAN');
        const me = await fx.addUser(org, `month-layout-p${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
        const older = defaultLayoutOf('TECHNICIAN').filter((e) => e.id !== 'jobs_this_month');
        expect(older.length).toBe(defaultLayoutOf('TECHNICIAN').length - 1);
        await savedOk(me, older);

        const shown = (await readLayout(me)).layout;
        expect(ids(shown)).toEqual([...ids(older), 'jobs_this_month']);
        expect(shown[shown.length - 1]).toEqual({ id: 'jobs_this_month', visible: true });
        // Reading writes nothing: the stored list is still the older one.
        expect(ids(((await storedLayout(me)) ?? []) as Entry[])).toEqual(ids(older));

        // The page saves what it showed and the person hides the tile: it stays once, hidden.
        await savedOk(me, shown.map((e) => (e.id === 'jobs_this_month' ? { ...e, visible: false } : e)));
        const after = (await readLayout(me)).layout;
        expect(after.filter((e) => e.id === 'jobs_this_month')).toEqual([{ id: 'jobs_this_month', visible: false }]);
      });

      it('is in the Technician default and stays fully eligible for a person on that preset', async () => {
        const { org } = await newOrg();
        const technician = await fx.addUser(org, `month-default-p${++sequence}`, 'TECHNICIAN');
        const shown = ids((await readLayout(technician)).layout);
        expect(shown).toContain('jobs_this_month');
        const answer = await dashboardOf(technician);
        for (const id of shown) expect(tile(answer, id), id).toBeDefined();
      });
    });

    describe('reset to my role\'s default (route-level row: reset my layout)', () => {
      const resetLayout = async (person: Person) => (await fx.signedInAs(person)).post('/api/dashboard/layout/reset', {});
      const resetOk = async (person: Person): Promise<LayoutAnswer & { saved: boolean }> => {
        const res = await resetLayout(person);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body as LayoutAnswer & { saved: boolean };
      };
      const storedLayout = async (person: Person) => (await db.userDashboardLayout.findUnique({ where: { user_id: person.id } }))?.layout;

      it('puts a custom role made from Technician back to the Technician default, and every session reads it', async () => {
        const { org } = await newOrg();
        const role = await fx.addCustomRole(org, 'reset-senior-tech', 'TECHNICIAN');
        const me = await fx.addUser(org, 'reset-senior', 'TECHNICIAN', { customRoleId: role.id });
        await savedOk(me, [{ id: JOBS_WEEK, visible: true, size: 'full' }]);
        const answer = await resetOk(me);
        expect(answer.layout).toEqual(defaultOf('TECHNICIAN'));
        expect(defaultOf('TECHNICIAN').length).toBeGreaterThan(0);
        expect(answer.saved).toBe(true);
        expect((await readLayout(me)).layout).toEqual(defaultOf('TECHNICIAN'));
      });

      it('follows a role made from another role back to the preset behind it', async () => {
        const { org } = await newOrg();
        const first = await fx.addCustomRole(org, 'reset-first', 'TECHNICIAN');
        const second = await fx.addCustomRole(org, 'reset-second', 'TECHNICIAN');
        await db.customRole.update({ where: { id: second.id }, data: { made_from_role_key: first.key } });
        const me = await fx.addUser(org, 'reset-chained', 'TECHNICIAN', { customRoleId: second.id });
        await savedOk(me, [{ id: JOBS_WEEK, visible: true }]);
        expect((await resetOk(me)).layout).toEqual(defaultOf('TECHNICIAN'));
      });

      it('gives a person on the built-in Admin role the Admin default', async () => {
        const { admin } = await newOrg();
        await savedOk(admin, [{ id: JOBS_WEEK, visible: true }]);
        expect((await resetOk(admin)).layout).toEqual(defaultOf('ADMIN'));
        expect(defaultOf('ADMIN').length).toBeGreaterThan(0);
      });

      it('gives a role made from blank an empty layout, and the empty layout is saved', async () => {
        const { org } = await newOrg();
        const me = await personWith(org, JOBS_AND_LEADS);
        await savedOk(me, [{ id: JOBS_WEEK, visible: true }]);
        const answer = await resetOk(me);
        expect(answer.layout).toEqual([]);
        expect(answer.saved).toBe(true);
        expect(await storedLayout(me)).toEqual([]);
        expect((await readLayout(me)).layout).toEqual([]);
      });

      it('sends only the tiles the person may have right now', async () => {
        const { org } = await newOrg();
        const key = 'reset-narrowed';
        const role = await fx.addCustomRole(org, key, 'DISPATCHER');
        const me = await fx.addUser(org, 'reset-narrowed', 'DISPATCHER', { customRoleId: role.id });
        await fx.setRoleSwitches(org, key, { ...allOff, see_prices: true, view_jobs: true, jobs_scope: 'all' });
        await db.permissionUserSwitch.deleteMany({ where: { user_id: me.id } });
        clearSwitchCacheForUser(me.id);
        const mayHave = new Set((await dashboardOf(me)).tiles.map((t) => t.id));
        const expected = defaultLayoutOf('DISPATCHER').filter((e) => mayHave.has(e.id));
        expect(expected.length).toBeGreaterThan(0);
        expect(expected.length).toBeLessThan(defaultLayoutOf('DISPATCHER').length);
        expect((await resetOk(me)).layout).toEqual(expected);
        expect((await readLayout(me)).layout).toEqual(expected);
      });

      it('replaces the row and keeps it: one row, and a person who had none now has one', async () => {
        const { org } = await newOrg();
        const role = await fx.addCustomRole(org, 'reset-keeps-row', 'TECHNICIAN');
        const me = await fx.addUser(org, 'reset-keeps-row', 'TECHNICIAN', { customRoleId: role.id });
        expect(await db.userDashboardLayout.count({ where: { user_id: me.id } })).toBe(0);
        await resetOk(me);
        expect(await db.userDashboardLayout.count({ where: { user_id: me.id } })).toBe(1);
        await savedOk(me, [{ id: JOBS_WEEK, visible: true }]);
        await resetOk(me);
        const rows = await db.userDashboardLayout.findMany({ where: { user_id: me.id } });
        expect(rows).toHaveLength(1);
        expect(rows[0]!.organization_id).toBe(org);
        expect(rows[0]!.layout).toEqual(defaultOf('TECHNICIAN'));
      });

      it('does not let the browser layout come back afterwards: carry-over writes nothing once a reset has been made', async () => {
        const { org } = await newOrg();
        const blank = await personWith(org, JOBS_AND_LEADS);
        const role = await fx.addCustomRole(org, 'reset-no-carry', 'TECHNICIAN');
        const tech = await fx.addUser(org, 'reset-no-carry', 'TECHNICIAN', { customRoleId: role.id });
        const browser = [{ id: JOBS_WEEK, visible: true, size: 'full' }];
        for (const person of [blank, tech]) {
          const reset = await resetOk(person);
          const carry = await (await fx.signedInAs(person)).post('/api/dashboard/layout/carry-over', { layout: browser });
          expect(carry.status, JSON.stringify(carry.body)).toBe(200);
          expect((carry.body as LayoutAnswer).layout).toEqual(reset.layout);
          expect((await readLayout(person)).layout).toEqual(reset.layout);
          expect(((await readLayout(person)) as LayoutAnswer & { saved: boolean }).saved).toBe(true);
        }
      });

      it('resets only the signed-in person: a user id in the body or the address is not read', async () => {
        const { org } = await newOrg();
        const mine = await personWith(org, JOBS_AND_LEADS);
        const colleague = await personWith(org, JOBS_AND_LEADS);
        await savedOk(mine, [{ id: JOBS_WEEK, visible: true }]);
        await savedOk(colleague, [{ id: OPEN_LEADS, visible: true }]);
        const res = await (await fx.signedInAs(mine)).post('/api/dashboard/layout/reset', { user_id: colleague.id });
        expect(res.status).toBe(200);
        expect((await (await fx.signedInAs(mine)).post(`/api/dashboard/layout/reset/${colleague.id}`, {})).status).toBe(404);
        expect(ids((await readLayout(colleague)).layout)).toEqual([OPEN_LEADS]);
      });

      it('refuses a request from nobody signed in', async () => {
        const request = (await import('supertest')).default;
        const app = (await import('../app.js')).default as never;
        expect((await request(app).post('/api/dashboard/layout/reset').send({})).status).toBe(401);
      });
    });

    describe('the one-time carry-over of a browser layout (route-level row: carry over my layout)', () => {
      type Carried = LayoutAnswer & { saved: boolean };
      const carryOver = async (person: Person, layout: unknown) => (await fx.signedInAs(person)).post('/api/dashboard/layout/carry-over', { layout });
      const carriedOk = async (person: Person, layout: Entry[]): Promise<Carried> => {
        const res = await carryOver(person, layout);
        expect(res.status, JSON.stringify(res.body)).toBe(200);
        return res.body as Carried;
      };
      const read = async (person: Person) => (await readLayout(person)) as Carried;
      const stored = async (person: Person) => (await db.userDashboardLayout.findUnique({ where: { user_id: person.id } }))?.layout;
      const browser: Entry[] = [
        { id: OPEN_LEADS, visible: true, size: 'full', range: '7d' }, { id: JOBS_TODAY, visible: false }, { id: JOBS_WEEK, visible: true, size: 'half' },
      ];

      it('says whether a layout is saved: not until the person has one, and a read never saves one', async () => {
        const { org } = await newOrg();
        const me = await personWith(org, JOBS_AND_LEADS);
        expect((await read(me)).saved).toBe(false);
        expect((await read(me)).saved).toBe(false);
        expect(await stored(me)).toBeUndefined();
        await savedOk(me, [{ id: JOBS_WEEK, visible: true }]);
        expect((await read(me)).saved).toBe(true);
      });

      it('saves the browser layout once when none is saved, with its order and choices, and a later session reads it', async () => {
        const { org } = await newOrg();
        const me = await personWith(org, JOBS_AND_LEADS);
        const answer = await carriedOk(me, browser);
        expect(answer.saved).toBe(true);
        expect(answer.layout).toEqual(browser);
        const later = await read(me);
        expect(later.layout).toEqual(browser);
        expect(later.saved).toBe(true);
        expect(await db.userDashboardLayout.count({ where: { user_id: me.id } })).toBe(1);
      });

      it('stores a tile the person may not have hidden, keeps it in place, and does not draw it', async () => {
        const { org } = await newOrg();
        const me = await personWith(org, { view_jobs: true, jobs_scope: 'all' });
        const answer = await carriedOk(me, browser);
        // The tile is sent back flagged, hidden and where the browser had it, for the page never to draw ...
        expect(answer.layout).toEqual([
          { id: OPEN_LEADS, visible: false, size: 'full', range: '7d', available: false }, { id: JOBS_TODAY, visible: false }, { id: JOBS_WEEK, visible: true, size: 'half' },
        ]);
        // ... and stored without the flag.
        expect(await stored(me)).toEqual([
          { id: OPEN_LEADS, visible: false, size: 'full', range: '7d' }, { id: JOBS_TODAY, visible: false }, { id: JOBS_WEEK, visible: true, size: 'half' },
        ]);
      });

      it('leaves a tile that was stored hidden hidden when the access returns', async () => {
        const { org } = await newOrg();
        const key = `carry-role-${++sequence}`;
        await fx.addCustomRole(org, key, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
        const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key } });
        const setSwitches = (values: Record<string, boolean | string>) =>
          fx.setRoleSwitches(org, key, { ...allOff, see_prices: true, ...values });
        await setSwitches({ view_jobs: true, jobs_scope: 'all' });
        const me = await fx.addUser(org, `carry-p${sequence}`, 'TECHNICIAN', { customRoleId: role.id, basedOnRoleKey: key });
        await db.permissionUserSwitch.deleteMany({ where: { user_id: me.id } });
        clearSwitchCacheForUser(me.id);
        await carriedOk(me, browser);
        await setSwitches(JOBS_AND_LEADS);
        clearSwitchCacheForUser(me.id);
        expect((await read(me)).layout).toEqual([
          { id: OPEN_LEADS, visible: false, size: 'full', range: '7d' }, { id: JOBS_TODAY, visible: false }, { id: JOBS_WEEK, visible: true, size: 'half' },
        ]);
      });

      it('never replaces a layout that is already saved, and answers with the saved one', async () => {
        const { org } = await newOrg();
        const me = await personWith(org, JOBS_AND_LEADS);
        const mine: Entry[] = [{ id: JOBS_WEEK, visible: true, range: 'month' }];
        await savedOk(me, mine);
        const answer = await carriedOk(me, browser);
        expect(answer.layout).toEqual(mine);
        expect(answer.saved).toBe(true);
        expect((await read(me)).layout).toEqual(mine);
      });

      it('does not carry over again after the person has saved an empty layout, or one this build cannot read', async () => {
        const { org } = await newOrg();
        const emptied = await personWith(org, JOBS_AND_LEADS);
        await savedOk(emptied, []);
        expect((await carriedOk(emptied, browser)).layout).toEqual([]);
        expect(await stored(emptied)).toEqual([]);
        const odd = await personWith(org, JOBS_AND_LEADS);
        await db.userDashboardLayout.create({ data: { user_id: odd.id, organization_id: org, layout: { not: 'a list' } } });
        expect((await read(odd)).saved).toBe(true);
        await carriedOk(odd, browser);
        expect(await stored(odd)).toEqual({ not: 'a list' });
      });

      it('writes once when two tabs carry over at the same moment, and both are told what was stored', async () => {
        const { org } = await newOrg();
        const me = await personWith(org, JOBS_AND_LEADS);
        const other: Entry[] = [{ id: JOBS_TODAY, visible: true }];
        const [a, b] = await Promise.all([carryOver(me, browser), carryOver(me, other)]);
        expect([a.status, b.status]).toEqual([200, 200]);
        expect(await db.userDashboardLayout.count({ where: { user_id: me.id } })).toBe(1);
        const kept = (await read(me)).layout;
        expect([browser, other]).toContainEqual(kept);
        expect((a.body as Carried).layout).toEqual(kept);
        expect((b.body as Carried).layout).toEqual(kept);
      });

      it('drops a tile the catalog does not know and a repeat, and stores nothing when nothing usable is left', async () => {
        const { org } = await newOrg();
        const me = await personWith(org, JOBS_AND_LEADS);
        const none = await carriedOk(me, [{ id: 'tile.retired.long.ago', visible: true }]);
        expect(none.saved).toBe(false);
        expect(none.layout).toEqual([]);
        expect(await stored(me)).toBeUndefined();
        const answer = await carriedOk(me, [
          { id: JOBS_WEEK, visible: true }, { id: 'tile.retired.long.ago', visible: true }, { id: JOBS_WEEK, visible: false }, { id: OPEN_LEADS, visible: true },
        ]);
        expect(answer.layout).toEqual([{ id: JOBS_WEEK, visible: true }, { id: OPEN_LEADS, visible: true }]);
        expect(await stored(me)).toEqual(answer.layout);
      });

      it('acts on the signed-in person only: a user id sent with it is not read and nobody else is touched', async () => {
        const { org } = await newOrg();
        const mine = await personWith(org, JOBS_AND_LEADS);
        const colleague = await personWith(org, JOBS_AND_LEADS);
        const before = await read(colleague);
        const res = await (await fx.signedInAs(mine)).post('/api/dashboard/layout/carry-over', { layout: browser, user_id: colleague.id });
        expect(res.status).toBe(200);
        expect(await read(colleague)).toEqual(before);
        expect(await stored(colleague)).toBeUndefined();
        expect(await stored(mine)).toEqual(browser);
        expect((await (await fx.signedInAs(mine)).post(`/api/dashboard/layout/carry-over/${colleague.id}`, { layout: browser })).status).toBe(404);
      });

      it('refuses a request from nobody signed in, and a layout that is not a list of tiles', async () => {
        const request = (await import('supertest')).default;
        const app = (await import('../app.js')).default as never;
        expect((await request(app).post('/api/dashboard/layout/carry-over').send({ layout: [] })).status).toBe(401);
        const { org } = await newOrg();
        const me = await personWith(org, JOBS_AND_LEADS);
        for (const bad of ['nothing', { id: JOBS_TODAY }, [{ id: JOBS_TODAY }], [{ visible: true }], [{ id: JOBS_TODAY, visible: true, size: 'huge' }], [{ id: 7, visible: true }]]) {
          expect((await carryOver(me, bad)).status, JSON.stringify(bad)).toBe(400);
        }
        expect(await stored(me)).toBeUndefined();
      });

      it('stays saved after a reset-style replacement: the saved flag follows the row, so a later reset cannot bring the carry-over back', async () => {
        const { org } = await newOrg();
        const me = await personWith(org, JOBS_AND_LEADS);
        await carriedOk(me, browser);
        const reset = await savedOk(me, []);
        expect((reset as Carried).saved).toBe(true);
        expect((await read(me)).saved).toBe(true);
        expect((await carriedOk(me, browser)).layout).toEqual(reset.layout);
      });
    });
  });

  describe('Estimates still to send (S09.18)', () => {
    const TILE = 'estimates_to_send';
    type Row = { id: string; estimate_number: string; title: string; total: number; link: string };
    type Figure = { count: number; estimates: Row[] };
    // A document is reached through the lead or job it hangs off, which takes View leads and View jobs (ticket 33, story 50).
    const VIEW = { view_estimates: true, view_leads: true, view_jobs: true, jobs_scope: 'all', leads_scope: 'all' };
    const ATTACHED = { ...VIEW, jobs_scope: 'attached', leads_scope: 'attached' };
    const dataOf = (answer: Answer) => answer.data[TILE] as Figure;
    const read = async (person: Person) => dashboardOf(person, `?tiles=${TILE}`);
    const figureOf = async (person: Person) => dataOf(await read(person));
    const numbersOf = (figure: Figure) => figure.estimates.map((e) => e.estimate_number);
    const linkOfTile = (answer: Answer) => (tile(answer, TILE) as (Tile & { link: string | null }) | undefined)?.link;
    const numberOf = async (id: string) => (await db.estimate.findUniqueOrThrow({ where: { id }, select: { estimate_number: true } })).estimate_number;

    /** A draft estimate, with the number it was given, the total it carries and the moment it was made. */
    async function draft(
      org: string,
      customer: string,
      createdBy: string,
      opts: { leadId?: string; jobId?: string; total?: number; madeDaysAgo?: number } = {},
    ) {
      const made = await fx.addEstimate(org, customer, createdBy, { leadId: opts.leadId, jobId: opts.jobId });
      await db.estimate.update({
        where: { id: made.id },
        data: {
          ...(opts.total !== undefined ? { total_amount: opts.total, subtotal: opts.total } : {}),
          ...(opts.madeDaysAgo !== undefined ? { created_at: new Date(Date.now() - opts.madeDaysAgo * 86_400_000) } : {}),
        },
      });
      return { ...made, number: await numberOf(made.id) };
    }

    it('is an Estimates tile that View estimates unlocks, and is neither sent nor computed without it, even when asked for by id', async () => {
      const { org } = await newOrg();
      expect(tile(await read(await personWith(org, VIEW)), TILE)).toMatchObject({ category: 'estimates' });
      const without = await personWith(org, { view_leads: true, view_jobs: true, view_invoices: true, see_company_figures: true, ...ALL_SCOPES });
      expect(tile(await dashboardOf(without), TILE)).toBeUndefined();
      const byId = await read(without);
      expect(byId.tiles).toEqual([]);
      expect(byId.data).toEqual({});
    });

    it('shows nothing on the home page to a person with View estimates off who made a draft, and the estimate does not open either', async () => {
      const { org, customer } = await newOrg();
      const me = await personWith(org, { ...VIEW, view_estimates: false });
      const mine = await draft(org, customer, me.id);
      const answer = await read(me);
      expect(answer.tiles).toEqual([]);
      expect(answer.data).toEqual({});
      expect((await (await fx.signedInAs(me)).get(`/api/estimates/${mine.id}`)).status).toBe(403);
    });

    it('says so plainly when there is no draft: a zero count and no rows', async () => {
      const { org } = await newOrg();
      expect(await figureOf(await personWith(org, VIEW))).toEqual({ count: 0, estimates: [] });
    });

    it('lists the person\'s own draft, and the draft leaves the tile once it is sent through the real send route', async () => {
      const { org, customer } = await newOrg();
      await db.customer.update({ where: { id: customer }, data: { email: `customer-${org.slice(0, 8)}@example.test` } });
      // Estimates scope Attached with nothing attached: the only way this person reaches the estimate is that they made it
      // for a customer alone. Sending it takes Edit estimates, which the person holds explicitly.
      const me = await personWith(org, { ...ATTACHED, edit_estimates: true });
      // The send goes out from the sender's own mailbox (PRD 10, S10.12).
      await fx.addUserMailbox(org, me);
      const mine = await draft(org, customer, me.id);
      const before = await figureOf(me);
      expect(before.count).toBe(1);
      expect(numbersOf(before)).toEqual([mine.number]);
      const sent = await (await fx.signedInAs(me)).post(`/api/estimates/${mine.id}/send`, { deposit_required: false, payment_methods: [] });
      expect(sent.status, JSON.stringify(sent.body)).toBe(200);
      expect((await db.estimate.findUniqueOrThrow({ where: { id: mine.id } })).status).toBe('SENT');
      expect(await figureOf(me)).toEqual({ count: 0, estimates: [] });
    });

    it('lists drafts and nothing else: sent, pending, won, declined, expired, archived and superseded estimates are left out', async () => {
      const { org, customer, admin } = await newOrg();
      const me = await personWith(org, VIEW);
      const wanted = await draft(org, customer, admin.id);
      for (const status of ['SENT', 'PENDING', 'WON', 'DECLINED', 'EXPIRED', 'ARCHIVED', 'SUPERSEDED'] as const) {
        const other = await draft(org, customer, admin.id);
        await db.estimate.update({ where: { id: other.id }, data: { status } });
      }
      const figure = await figureOf(me);
      expect(figure.count).toBe(1);
      expect(numbersOf(figure)).toEqual([wanted.number]);
    });

    describe('Estimates scope Attached', () => {
      it('shows a draft on a lead the person is on even when someone else wrote it, and not a draft on a lead they are not on', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, ATTACHED);
        const myLead = await fx.addLead(org, customer, { assignees: [me.id] });
        const otherLead = await fx.addLead(org, customer, { assignees: [admin.id] });
        const onMine = await draft(org, customer, admin.id, { leadId: myLead.id });
        await draft(org, customer, admin.id, { leadId: otherLead.id });
        await draft(org, customer, admin.id);
        const figure = await figureOf(me);
        expect(numbersOf(figure)).toEqual([onMine.number]);
        expect(figure.count).toBe(1);
      });

      it('shows a draft on a job the person is crew on even when someone else wrote it, and not a draft on a job they are not on', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, ATTACHED);
        const myJob = await fx.addJob(org, customer, { crew: [me.id] });
        const otherJob = await fx.addJob(org, customer, { crew: [admin.id] });
        const onMine = await draft(org, customer, admin.id, { jobId: myJob.id });
        await draft(org, customer, admin.id, { jobId: otherJob.id });
        expect(numbersOf(await figureOf(me))).toEqual([onMine.number]);
      });

      it('shows the draft the person made on a lead they are on, and stops showing it once they are taken off that lead', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, ATTACHED);
        const lead = await fx.addLead(org, customer, { assignees: [me.id, admin.id], createdBy: admin.id });
        const mine = await draft(org, customer, me.id, { leadId: lead.id });
        expect(numbersOf(await figureOf(me))).toEqual([mine.number]);
        await db.leadAssignee.deleteMany({ where: { lead_id: lead.id, user_id: me.id } });
        expect(await figureOf(me)).toEqual({ count: 0, estimates: [] });
      });

      it('keeps showing a draft the person made for a customer alone, which is theirs for good', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, ATTACHED);
        const mine = await draft(org, customer, me.id);
        await draft(org, customer, admin.id);
        expect(numbersOf(await figureOf(me))).toEqual([mine.number]);
      });
    });

    describe('wider scopes', () => {
      it('shows every draft in the company under Estimates scope All, and the team\'s under Team', async () => {
        const { org, customer, admin } = await newOrg();
        const team = await fx.addDepartment(org, 'crew');
        const mate = await fx.addUser(org, 'mate', 'TECHNICIAN', { departmentId: team });
        const me = await personWith(org, VIEW, { departmentId: team });
        const teamLead = await fx.addLead(org, customer, { assignees: [mate.id] });
        const onTeam = await draft(org, customer, admin.id, { leadId: teamLead.id });
        const elsewhere = await draft(org, customer, admin.id);
        expect((await figureOf(me)).count).toBe(2);
        const narrow = await personWith(org, { ...VIEW, jobs_scope: 'team', leads_scope: 'team' }, { departmentId: team });
        expect(numbersOf(await figureOf(narrow))).toEqual([onTeam.number]);
        expect(numbersOf(await figureOf(me)).sort()).toEqual([onTeam.number, elsewhere.number].sort());
      });

      it('never shows another company\'s draft, whatever the scope', async () => {
        const mine = await newOrg();
        const other = await newOrg();
        const me = await personWith(mine.org, VIEW);
        await draft(other.org, other.customer, other.admin.id);
        expect(await figureOf(me)).toEqual({ count: 0, estimates: [] });
      });
    });

    describe('the rows', () => {
      it('carries the estimate number, the customer\'s name and the estimate\'s total, opening the estimate, oldest draft first', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, VIEW);
        const newer = await draft(org, customer, admin.id, { total: 80, madeDaysAgo: 1 });
        const older = await draft(org, customer, admin.id, { total: 1234.56, madeDaysAgo: 9 });
        const figure = await figureOf(me);
        expect(figure.estimates).toEqual([
          { id: older.id, estimate_number: older.number, title: 'Pat Payer', total: 1234.56, link: `/estimates/${older.id}` },
          { id: newer.id, estimate_number: newer.number, title: 'Pat Payer', total: 80, link: `/estimates/${newer.id}` },
        ]);
      });

      it('names a company customer by its company name when it has no person name', async () => {
        const { org, admin } = await newOrg();
        const company = randomUUID();
        await db.customer.create({ data: { id: company, organization_id: org, customer_number: `C-${company.slice(0, 8)}`, kind: 'COMPANY', segment: 'COMMERCIAL', company_name: 'Acme Test Works' } });
        await draft(org, company, admin.id);
        expect((await figureOf(await personWith(org, VIEW))).estimates[0]!.title).toBe('Acme Test Works');
      });

      it('shows a total equal to the one the estimate\'s own page shows', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, VIEW);
        const made = await draft(org, customer, admin.id, { total: 417.25 });
        const row = (await figureOf(me)).estimates[0]!;
        const page = await (await fx.signedInAs(me)).get(`/api/estimates/${made.id}`);
        expect(page.status).toBe(200);
        expect(row.total).toBe(Number(page.body.estimate.total_amount));
      });

      it('shows the total to a person with neither See company figures nor See costs, and carries no cost, margin, sum or contact detail', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, { ...VIEW, see_company_figures: false, see_costs: false });
        await db.customer.update({ where: { id: customer }, data: { email: 'private@example.test', phone: '5550100' } });
        await draft(org, customer, admin.id, { total: 99 });
        await draft(org, customer, admin.id, { total: 1 });
        const figure = await figureOf(me);
        expect(figure.estimates.map((e) => e.total).sort()).toEqual([1, 99]);
        // Only these keys on the figure and on each row: no sum across rows, no cost, margin or customer contact.
        expect(Object.keys(figure).sort()).toEqual(['count', 'estimates']);
        for (const row of figure.estimates) expect(Object.keys(row).sort()).toEqual(['estimate_number', 'id', 'link', 'title', 'total']);
        expect(JSON.stringify(figure)).not.toMatch(/private@example|5550100|cost|margin/i);
      });

      it('names the customer the way the Estimates list does for the same person', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, { ...VIEW, view_customers: false });
        const made = await draft(org, customer, admin.id);
        const list = await (await fx.signedInAs(me)).get('/api/estimates');
        expect(list.status).toBe(200);
        const listed = (list.body.estimates as Array<{ id: string; customer: { first_name: string; last_name: string } }>).find((e) => e.id === made.id)!;
        expect((await figureOf(me)).estimates[0]!.title).toBe(`${listed.customer.first_name} ${listed.customer.last_name}`);
      });

      it('sends the five oldest drafts as rows and counts all of them', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, VIEW);
        const made = [];
        for (let age = 1; age <= 8; age += 1) made.push(await draft(org, customer, admin.id, { madeDaysAgo: age }));
        const figure = await figureOf(me);
        expect(figure.count).toBe(8);
        expect(numbersOf(figure)).toEqual(made.slice(3).reverse().map((m) => m.number));
      });
    });

    describe('where it leads', () => {
      it('carries the Estimates list filtered to Draft with View estimates alone', async () => {
        const { org } = await newOrg();
        expect(linkOfTile(await dashboardOf(await personWith(org, VIEW)))).toBe('/estimates?status=DRAFT');
      });

      it('gives each row its estimate to open', async () => {
        const { org, customer, admin } = await newOrg();
        const me = await personWith(org, { ...VIEW });
        const made = await draft(org, customer, admin.id);
        expect((await figureOf(me)).estimates[0]!.link).toBe(`/estimates/${made.id}`);
      });
    });

    it('is computed for a person whose saved layout shows it, and left out of the read when the layout hides it', async () => {
      const { org, customer, admin } = await newOrg();
      const me = await personWith(org, VIEW);
      await draft(org, customer, admin.id);
      const api = await fx.signedInAs(me);
      expect((await api.put('/api/dashboard/layout', { layout: [{ id: TILE, visible: true }] })).status).toBe(200);
      expect(dataOf((await api.get('/api/dashboard?shown=1')).body as Answer).count).toBe(1);
      expect((await api.put('/api/dashboard/layout', { layout: [{ id: TILE, visible: false }] })).status).toBe(200);
      expect(((await api.get('/api/dashboard?shown=1')).body as Answer).data[TILE]).toBeUndefined();
    });

    it('is in the Technician and the Sales default home pages, and both are fully eligible under their presets', async () => {
      const { org, customer, admin } = await newOrg();
      await draft(org, customer, admin.id);
      for (const role of ['TECHNICIAN', 'SALES'] as const) {
        const stock = await fx.addUser(org, `stock-${role.toLowerCase()}`, role);
        const answer = await dashboardOf(stock, '?shown=1');
        const eligible = new Set(answer.tiles.map((t) => t.id));
        for (const entry of defaultLayoutOf(role)) expect(eligible.has(entry.id), `${role}:${entry.id}`).toBe(true);
        expect(answer.data[TILE], role).toBeDefined();
      }
    });
  });
});
