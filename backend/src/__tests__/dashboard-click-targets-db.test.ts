/* =============================================================================
   Roles & Permissions, PRD 9, slice S09.3 - GET /api/dashboard sends each tile's, row's and stage's click target,
   or none, by the person's switches.

   Everything goes through the public interface: the dashboard endpoint, called as people on custom roles (never a
   built-in role name) holding exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the
   suite skips when it is unset. Every org it creates is removed again and every assertion is about rows the test
   created in its own org.
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

import { switchFixture, type Person } from './permission-switches-fixture';
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

type Tile = { id: string; link: string | null };
type Answer = { tiles: Tile[]; data: Record<string, any> };

suite('GET /api/dashboard sends click targets only where the person may go (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(async () => {
    await fx.cleanup();
  });

  let sequence = 0;
  const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
  const ALL_SCOPES = { leads_scope: 'all', jobs_scope: 'all' };
  /** Every page the dashboard can lead to, open: View and Show of each list, and the two Access switches. */
  const PAGES_OPEN = {
    view_jobs: true, view_leads: true, view_estimates: true,
    view_invoices: true, access_reports: true, access_schedule: true, see_company_figures: true,
    ...ALL_SCOPES,
  };

  async function personWith(org: string, values: Record<string, boolean | string>): Promise<Person> {
    const key = `target-role-${++sequence}`;
    await fx.addCustomRole(org, key, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
    await setRoleSwitchValues({ organizationId: org, roleKey: key, values: { ...allOff, see_prices: true, ...values }, actorId: null, reason: 'manual' });
    const role = await db.customRole.findFirstOrThrow({ where: { organization_id: org, key } });
    return fx.addUser(org, `t${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
  }
  const dashboardOf = async (person: Person): Promise<Answer> => {
    const res = await (await fx.signedInAs(person)).get('/api/dashboard');
    expect(res.status, JSON.stringify(res.body)).toBe(200);
    return res.body as Answer;
  };
  const linkOf = (answer: Answer, id: string) => {
    const t = answer.tiles.find((x) => x.id === id);
    expect(t, `${id} is sent`).toBeDefined();
    return t!.link;
  };
  /** Pages open except the named switches. */
  const pagesExcept = (...off: string[]) => ({ ...PAGES_OPEN, ...Object.fromEntries(off.map((k) => [k, false])) });

  it('sends a person with every page open a target on each tile that has one', async () => {
    const { org } = await fx.newOrg();
    const answer = await dashboardOf(await personWith(org, PAGES_OPEN));
    expect(linkOf(answer, 'kpi.jobs_week')).toBe('/jobs');
    expect(linkOf(answer, 'kpi.open_leads')).toBe('/leads');
    expect(linkOf(answer, 'kpi.revenue_mtd')).toBe('/invoices');
    expect(linkOf(answer, 'kpi.collected_today')).toBe('/reports/payments');
    expect(linkOf(answer, 'kpi.jobs_today')).toBe('/schedule');
  });

  it('sends no target on Close Rate, Collected Today, Unpaid Balance and Avg Ticket without Access Reports', async () => {
    const { org } = await fx.newOrg();
    const answer = await dashboardOf(await personWith(org, pagesExcept('access_reports')));
    for (const id of ['kpi.close_rate', 'kpi.collected_today', 'kpi.ar', 'kpi.avg_ticket']) expect(linkOf(answer, id), id).toBeNull();
    // The tile is still sent, with its figures: only the way through is closed.
    expect(answer.data['kpi.ar']).toBeDefined();
  });

  it('sends a target on Monthly Revenue, its chart and the Invoiced and Paid stages with View invoices alone (no Show switch exists, P1)', async () => {
    const { org } = await fx.newOrg();
    const answer = await dashboardOf(await personWith(org, PAGES_OPEN));
    expect(linkOf(answer, 'kpi.revenue_mtd')).toBe('/invoices');
    expect(linkOf(answer, 'revenue_chart')).toBe('/invoices');
    const stages = Object.fromEntries((answer.data.pipeline as { key: string; link: string | null }[]).map((s) => [s.key, s.link]));
    expect(stages.invoiced).toBe('/invoices');
    expect(stages.paid).toBe('/invoices?status=paid');
    expect(stages.estimates).toBe('/estimates');
    expect(stages.leads).toBe('/leads');
  });

  it('sends targets to the lists on Jobs This Week, Open Leads and the pipeline\'s Estimates stage when View is on', async () => {
    const { org } = await fx.newOrg();
    const answer = await dashboardOf(await personWith(org, PAGES_OPEN));
    expect(linkOf(answer, 'kpi.jobs_week')).toBe('/jobs');
    expect(linkOf(answer, 'kpi.open_leads')).toBe('/leads');
    expect((answer.data.pipeline as { key: string; link: string }[]).find((s) => s.key === 'estimates')!.link).toBe('/estimates');
  });

  it('sends a Smart Insights card a target to its list page for a person who holds View on it', async () => {
    const { org, customer } = await fx.newOrg();
    const lead = await fx.addLead(org, customer, {});
    await db.lead.update({ where: { id: lead.id }, data: { source: 'referral' } });
    const open = await dashboardOf(await personWith(org, PAGES_OPEN));
    const card = (answer: Answer) => (answer.data.smart_insights as { id: string; link: string | null }[]).find((i) => i.id === 'top_source')!;
    expect(card(open).link).toBe('/leads');
  });

  it('opens a Coming Up row on its job, and sends its View all (the tile target) only with Access Schedule', async () => {
    const { org, customer } = await fx.newOrg();
    const job = await fx.addJob(org, customer, { crew: [] });
    await fx.addVisit(org, { jobId: job.id, crew: [], daysFromNow: 2, seq: 2 });
    const open = await dashboardOf(await personWith(org, PAGES_OPEN));
    const rows = open.data.coming_up as { id: string; link: string | null }[];
    expect(rows.find((r) => r.id === job.id)?.link).toBe(`/jobs/${job.id}`);
    expect(linkOf(open, 'coming_up')).toBe('/schedule');

    const noSchedule = await dashboardOf(await personWith(org, pagesExcept('access_schedule')));
    expect(linkOf(noSchedule, 'coming_up')).toBeNull();
    // The row is a job the person can open whether or not they can open the Schedule.
    expect((noSchedule.data.coming_up as { id: string; link: string | null }[]).find((r) => r.id === job.id)?.link).toBe(`/jobs/${job.id}`);
  });

  it('opens a Top Lead Sources row on the Leads list filtered to that source', async () => {
    const { org, customer } = await fx.newOrg();
    const lead = await fx.addLead(org, customer, {});
    await db.lead.update({ where: { id: lead.id }, data: { source: 'referral' } });
    const open = await dashboardOf(await personWith(org, PAGES_OPEN));
    expect((open.data.lead_sources as { source: string; link: string | null }[]).find((s) => s.source === 'referral')?.link).toBe('/leads?source=referral');
  });

  it('opens the leads-with-no-owner item on the Leads list filtered to No owner for a person who holds View leads', async () => {
    const { org, customer } = await fx.newOrg();
    await fx.addLead(org, customer, {});
    const item = (answer: Answer) => (answer.data.needs_attention as { type: string; link: string | null }[]).find((i) => i.type === 'missing_lead_owner')!;
    expect(item(await dashboardOf(await personWith(org, PAGES_OPEN))).link).toBe('/leads?assigned_to=NO_OWNER');
  });

  it('opens each Today\'s Schedule entry on the record it names: a job on its job, a walkthrough on its lead', async () => {
    const { org, customer } = await fx.newOrg();
    const job = await fx.addJob(org, customer, { crew: [] });
    await fx.addVisit(org, { jobId: job.id, crew: [], daysFromNow: 0, seq: 2 });
    const lead = await fx.addLead(org, customer, {});
    await fx.addVisit(org, { leadId: lead.id, purpose: 'WALKTHROUGH', crew: [], daysFromNow: 0 });
    // The links are the records, not the Schedule page.
    const answer = await dashboardOf(await personWith(org, PAGES_OPEN));
    const entries = (answer.data.schedule_today as { jobs: { id: string; entity: string; link: string }[] }[]).flatMap((lane) => lane.jobs);
    expect(entries.find((e) => e.id === job.id)?.link).toBe(`/jobs/${job.id}`);
    expect(entries.find((e) => e.id === lead.id && e.entity === 'walkthrough')?.link).toBe(`/leads/${lead.id}`);
  });
});
