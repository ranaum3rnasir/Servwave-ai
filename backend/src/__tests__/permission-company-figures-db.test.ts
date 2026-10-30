/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.16 - See company figures strips company-wide money on the server.

   Everything goes through the public interface: the routes, called as a person on a custom role (never a
   built-in role name) who holds exactly the switch values under test. Real migrated database
   (TEST_DATABASE_URL); the suite skips when it is unset. Every org it creates is removed again.

   One row per server check the catalog lists for See company figures. For each row the same request is made
   with the switch on and with it off (and once as the Admin box, which has no switches and always passes):
     - on and Admin: the company money is on the response;
     - off: it is absent (the key is gone, never zero), and the counts beside it are still there.
   The seeded figures are ones no count, date or id on the test records can equal, so finding one anywhere in
   a response means company money was carried.
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

const keyOf = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)!.key;
const SEE_COMPANY_FIGURES = keyOf('See company figures');
const ACCESS_REPORTS = keyOf('Access Reports');

/** Figures no count, date or id on these records can equal. */
const MONEY = {
  collected: 1234.56, // one payment on the invoice below
  jobBig: 7654.32, // the one completed job of the first technician
  jobSmallEach: 11.11, // each of the second technician's two completed jobs
  jobSmall: 22.22, // what the two come to on the scoreboard
  due: 987.65, // the open invoice
  estimate: 4242.42, // the sent estimate
  fee: 33.33, // the card payment's processing fee
  callRevenue: 4321.09, // the revenue tied to the one call
  agentRevenue: 8765.43, // the phone agent's attributed revenue
};

/**
 * True when the key the path ends at is present on its parent, whatever its value. A key may itself hold dots (the
 * dashboard's tile ids, like "kpi.revenue_mtd"), so each step takes the longest key that starts what is left.
 */
function has(body: unknown, path: string): boolean {
  if (body == null || typeof body !== 'object') return false;
  const holder = body as Record<string, unknown>;
  if (path in holder) return true;
  return Object.keys(holder).some((key) => path.startsWith(`${key}.`) && has(holder[key], path.slice(key.length + 1)));
}

const everyFigure = Object.values(MONEY).map(String);
/** The figures that appear in a response, found by looking for each as a whole number token. */
function figuresIn(body: unknown): string[] {
  const text = JSON.stringify(body);
  return everyFigure.filter((figure) => new RegExp(`(?<![\\d.])${figure.replace('.', '\\.')}(?![\\d])`).test(text));
}

suite('See company figures strips company-wide money, on the server (real database)', () => {
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
      await quietly(db.$executeRawUnsafe(`DELETE FROM payments WHERE invoice_id IN (SELECT id FROM invoices WHERE organization_id = '${org}')`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM visit_assignees WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM visits WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM call_sessions WHERE organization_id = '${org}'`));
      await quietly(db.$executeRawUnsafe(`DELETE FROM phone_agents WHERE organization_id = '${org}'`));
    }
    await fx.cleanup();
  });

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  interface World {
    on: () => Promise<Api>;
    off: () => Promise<Api>;
    admin: () => Promise<Api>;
    bigTech: string;
    smallTech: string;
  }

  async function buildWorld(): Promise<World> {
    const { org, customer, admin } = await fx.newOrg();
    orgs.push(org);

    // Two people who differ in one switch only: See company figures. Both may open reports, and both read the Communication
    // section with call insights (the call and agent revenue checks sit under it).
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    // Both see the whole company's records (every scope All) and have every View switch the dashboard's tiles read, so
    // the only difference between them is the money.
    const wide = {
      view_jobs: true, view_leads: true, view_estimates: true, view_invoices: true, view_service_plans: true, view_tasks: true,
      leads_scope: 'all', jobs_scope: 'all', estimates_scope: 'all', invoices_scope: 'all',
    };
    const person = async (name: string, figures: boolean) => {
      const roleKey = `figures-${name}`;
      const role = await fx.addCustomRole(org, roleKey, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
      await setRoleSwitchValues({
        organizationId: org, roleKey, actorId: null, reason: 'manual',
        values: {
          ...allOff, ...wide, [ACCESS_REPORTS]: true, [SEE_COMPANY_FIGURES]: figures,
          view_communication: true, access_communication: true, see_call_insights: true, communication_scope: 'all',
        },
      });
      const p = await fx.addUser(org, name, 'TECHNICIAN', { customRoleId: role.id });
      return () => fx.signedInAs(p);
    };
    const on = await person('seesfigures', true);
    const off = await person('nofigures', false);

    // Two technicians who each complete jobs: the first one job worth a lot, the second two worth little, so the
    // ranking by revenue and the ranking by job count disagree.
    const bigTech = await fx.addUser(org, 'bigtech', 'TECHNICIAN');
    const smallTech = await fx.addUser(org, 'smalltech', 'TECHNICIAN');
    const finish = async (jobId: string, amount: number) =>
      db.job.update({ where: { id: jobId }, data: { status: 'COMPLETED', completed_at: new Date(), amount_invoiced: amount, dispatcher_id: admin.id } });

    const lead = await fx.addLead(org, customer, { assignees: [admin.id] });
    await db.lead.update({ where: { id: lead.id }, data: { source: 'google' } });
    const big = await fx.addJob(org, customer, { crew: [bigTech.id], pastVisit: true, fromLead: lead.id });
    await finish(big.id, MONEY.jobBig);
    await db.estimate.update({ where: { id: big.estimateId! }, data: { job_type: 'install' } });
    for (let i = 0; i < 2; i++) {
      const small = await fx.addJob(org, customer, { crew: [smallTech.id], pastVisit: true });
      await finish(small.id, MONEY.jobSmallEach);
    }

    // An overdue invoice with a balance (the unpaid-balance tile, the attention list, the unpaid-invoices report).
    const open = await fx.addInvoice(org, customer);
    await db.invoice.update({
      where: { id: open.id },
      data: { status: 'SENT', sent_at: new Date(Date.now() - 20 * 86_400_000), due_date: new Date(Date.now() - 5 * 86_400_000), total_amount: MONEY.due, amount_due: MONEY.due },
    });

    // A payment collected this month, with a timeline event that quotes it, and a card payment with a processing fee.
    const paid = await fx.addInvoice(org, customer);
    await db.invoice.update({ where: { id: paid.id }, data: { status: 'PAID', sent_at: new Date(), total_amount: MONEY.collected, amount_due: 0 } });
    await db.payment.create({ data: { invoice_id: paid.id, amount: MONEY.collected, method: 'CHECK', paid_at: new Date(), state: 'SUCCEEDED', collected_by: admin.id } });
    await db.payment.create({
      data: {
        invoice_id: paid.id, amount: 50, method: 'CARD', paid_at: new Date(), state: 'SUCCEEDED', collected_by: admin.id,
        stripe_fee_amount: MONEY.fee, platform_fee_amount: 1, net_amount: 50 - MONEY.fee - 1,
      },
    });
    await db.timelineEvent.create({
      data: {
        organization_id: org, entity_type: 'INVOICE', entity_id: paid.id, event_type: 'PAYMENT_RECEIVED', created_by: admin.id,
        description: `Payment of $${MONEY.collected.toFixed(2)} received via Check (plus $2.00 tip)`,
      },
    });

    // A sent estimate (the estimate-conversion report).
    const est = await fx.addEstimate(org, customer, admin.id);
    await db.estimate.update({
      where: { id: est.id },
      data: { status: 'SENT', sent_at: new Date(Date.now() - 3 * 86_400_000), total_amount: MONEY.estimate },
    });

    // A call with revenue tied to it, and a phone agent with attributed revenue (the Communication section's two places).
    await db.callSession.create({
      data: {
        organization_id: org, direction: 'inbound', from_number: '+15555550100', to_number: '+15555550199', status: 'completed',
        answered_by: {}, started_at: new Date(), qa_score: 88, revenue: MONEY.callRevenue,
      },
    });
    await db.phoneAgent.create({
      data: { organization_id: org, kind: 'human', name: 'Scorecard Agent', role: 'CSR', calls: 17, revenue: MONEY.agentRevenue },
    });

    return { on, off, admin: () => fx.signedInAs(admin as Person), bigTech: bigTech.id, smallTech: smallTech.id };
  }

  let world: World;
  beforeAll(async () => {
    world = await buildWorld();
  }, 120_000);

  /** One request per server check, and what must be on the response with the switch on and gone with it off. */
  interface Probe {
    check: string;
    path: string;
    /** Paths that carry company money: present on, absent off. */
    money: string[];
    /** Paths that must be there either way (counts, names, windows). */
    kept: string[];
    /** Anything more to assert about the pair of responses. */
    extra?: (on: any, off: any) => void;
  }

  const probes: Probe[] = [
    {
      // PRD 9: without the switch every money tile is the person's own money ("Yours"), so what goes is the company's
      // plan and mix: the Company figures tiles and the revenue goal.
      check: 'dashboard-company-figures',
      path: '/api/dashboard',
      money: [
        'data.kpi.revenue_mtd.target', 'data.kpi.revenue_mtd.pct_of_goal', 'data.revenue_chart.target',
        'data.kpi.recurring', 'data.revenue_by_job_type', 'data.smart_insights',
      ],
      kept: [
        'data.kpi.revenue_mtd.collected', 'data.kpi.ar', 'data.kpi.collected_today', 'data.kpi.avg_ticket', 'data.kpi.deposits', 'data.revenue_chart.months',
        'data.kpi.jobs_today', 'data.kpi.open_leads', 'data.kpi.close_rate', 'data.kpi.jobs_week',
        'data.needs_attention', 'data.schedule_today', 'data.jobs_by_status', 'data.coming_up', 'generated_at',
      ],
      extra: (on, off) => {
        expect(on.data['kpi.revenue_mtd'].collected).toBeCloseTo(MONEY.collected + 50, 2);
        expect(on.data['kpi.ar'].total).toBeCloseTo(MONEY.due, 2);
        expect(on.data.pipeline.some((s: { kind: string }) => s.kind === 'amount')).toBe(true);
        // The person without the switch has no records of their own, so their own money is nothing, never the company's.
        expect(off.data['kpi.revenue_mtd'].collected).toBe(0);
        expect(off.data['kpi.ar'].total).toBe(0);
        expect(off.tiles.find((t: { id: string }) => t.id === 'kpi.ar')).toMatchObject({ mode: 'own', label: 'Yours' });
        expect(on.tiles.find((t: { id: string }) => t.id === 'kpi.ar')).toMatchObject({ mode: 'company', label: null });
        expect(off.tiles.map((t: { id: string }) => t.id)).not.toContain('smart_insights');
        // The overdue invoice is one both can open (every scope All), and an invoice's amount is its own price, not a
        // company figure: it shows to anyone who can open the invoice.
        for (const body of [on, off]) {
          expect(body.data.needs_attention.find((i: { type: string }) => i.type === 'overdue_invoice').meta).toMatch(/\$988/);
        }
      },
    },
    {
      check: 'dashboard-scoreboard-revenue',
      path: '/api/dashboard',
      money: ['data.tech_scoreboard.0.revenue', 'data.dispatch_scoreboard.0.revenue', 'data.lead_sources.0.revenue'],
      kept: ['data.tech_scoreboard.0.jobs', 'data.tech_scoreboard.0.name', 'data.dispatch_scoreboard.0.jobs', 'data.dispatch_scoreboard.0.name', 'data.lead_sources.0.lead_pct', 'data.lead_sources.0.label'],
      extra: (on, off) => {
        const byName = (board: { name: string; jobs: number }[]) => board.map((e) => [e.name.startsWith('bigtech') ? 'big' : 'small', e.jobs]);
        // Ranked by revenue with the figures; by job count without them.
        expect(byName(on.data.tech_scoreboard)).toEqual([['big', 1], ['small', 2]]);
        expect(byName(off.data.tech_scoreboard)).toEqual([['small', 2], ['big', 1]]);
        expect(off.data.dispatch_scoreboard).toHaveLength(1);
        expect(off.data.dispatch_scoreboard[0].jobs).toBe(3);
      },
    },
    {
      check: 'dashboard-activity-amounts',
      path: '/api/dashboard',
      money: [],
      kept: ['data.recent_activity.0.description', 'data.recent_activity.0.created_at'],
      extra: (on, off) => {
        const paymentEvent = (body: { data: { recent_activity: { event_type: string; description: string }[] } }) =>
          body.data.recent_activity.find((e) => e.event_type === 'PAYMENT_RECEIVED');
        expect(paymentEvent(on)!.description).toBe('Payment of $1234.56 received via Check (plus $2.00 tip)');
        expect(paymentEvent(off)!.description).toBe('Payment received via Check');
        expect(off.data.recent_activity).toHaveLength(on.data.recent_activity.length);
        expect(JSON.stringify(off.data.recent_activity)).not.toMatch(/\$\d/);
      },
    },
    {
      check: 'report-revenue-totals',
      path: '/api/reports/revenue',
      money: ['totals', 'totals.collected'],
      kept: ['series'],
      extra: (on, off) => {
        expect(on.series.length).toBeGreaterThan(0);
        expect(off.series).toEqual([]);
      },
    },
    {
      check: 'report-payment-fees-totals',
      path: '/api/reports/payment-fees',
      money: ['gross', 'charged', 'stripeFees', 'platformFees', 'net', 'serviceFees', 'tips'],
      kept: ['from', 'to', 'reconciledCount', 'serviceFeeCount', 'tipCount'],
      extra: (on, off) => {
        expect(on.stripeFees).toBeCloseTo(MONEY.fee, 2);
        expect(off.reconciledCount).toBe(on.reconciledCount);
      },
    },
    {
      check: 'report-estimate-conversion-totals',
      path: '/api/reports/estimate-conversion?anchor=created',
      money: ['summary.totalValue', 'summary.sentEverValue', 'summary.won.value', 'context.avgTicketWon'],
      kept: ['summary.totalCount', 'summary.sentEverCount', 'summary.conversion', 'byRep', 'byMonth', 'aging', 'options'],
      extra: (on, off) => {
        expect(on.summary.totalValue).toBeGreaterThanOrEqual(MONEY.estimate);
        expect(on.summary.totalCount).toBe(off.summary.totalCount);
        expect(JSON.stringify(off)).not.toMatch(/Value|avgTicket/);
      },
    },
    {
      check: 'report-unpaid-invoices-totals',
      path: '/api/reports/ar-aging',
      money: ['dso', 'salesInWindow'],
      kept: ['accounts', 'salesWindowDays'],
      extra: (on, off) => {
        // The balances are the invoices themselves and stay; the sales window and the days-outstanding figure built from it go.
        expect(off.accounts).toEqual(on.accounts);
        expect(off.accounts[0].invoices[0].balance).toBeCloseTo(MONEY.due, 2);
        expect(on.salesInWindow).toBeGreaterThan(0);
      },
    },
    {
      check: 'call-revenue',
      path: '/api/communication/calls',
      money: ['calls.0.revenue'],
      kept: ['calls.0.id', 'calls.0.status', 'calls.0.qaScore', 'calls.0.answeredBy'],
      extra: (on, off) => {
        expect(on.calls[0].revenue).toBeCloseTo(MONEY.callRevenue, 2);
        expect(off.calls).toHaveLength(on.calls.length);
        expect(off.calls[0].qaScore).toBe(88);
      },
    },
    {
      check: 'agent-revenue',
      path: '/api/communication/agents',
      money: ['agents.0.revenue'],
      kept: ['agents.0.id', 'agents.0.name', 'agents.0.role', 'agents.0.calls', 'agents.0.sentimentPct'],
      extra: (on, off) => {
        expect(on.agents[0].revenue).toBeCloseTo(MONEY.agentRevenue, 2);
        expect(off.agents).toHaveLength(on.agents.length);
        expect(off.agents[0].calls).toBe(17);
      },
    },
  ];

  describe.each(probes)('$check', (probe) => {
    it('carries the company money with the switch on, and for the Admin box', async () => {
      const onBody = (await (await world.on()).get(probe.path)).body;
      const adminBody = (await (await world.admin()).get(probe.path)).body;
      for (const body of [onBody, adminBody]) {
        for (const path of [...probe.money, ...probe.kept]) expect(has(body, path), path).toBe(true);
      }
    });

    it('leaves it out with the switch off, keeping the counts and names beside it', async () => {
      const on = await (await world.on()).get(probe.path);
      const off = await (await world.off()).get(probe.path);
      expect(off.status).toBe(200);
      for (const path of probe.money) expect(has(off.body, path), path).toBe(false);
      for (const path of probe.kept) expect(has(off.body, path), path).toBe(true);
      probe.extra?.(on.body, off.body);
    });
  });

  it('has a row here for every server check the catalog lists for the switch, and none the catalog does not', () => {
    const entry = SWITCH_CATALOG.find((s) => s.key === SEE_COMPANY_FIGURES)!;
    expect(probes.map((p) => p.check).sort()).toEqual([...entry.serverChecks].sort());
  });

  it('carries none of the seeded company figures anywhere on the dashboard or the money reports without the switch', async () => {
    const off = await world.off();
    for (const path of ['/api/dashboard', '/api/reports/revenue', '/api/reports/payment-fees', '/api/reports/estimate-conversion?anchor=created']) {
      const res = await off.get(path);
      expect(res.status, path).toBe(200);
      expect(figuresIn(res.body), path).toEqual([]);
    }
  });

  it('shows every one of them with the switch on', async () => {
    const dash = (await (await world.on()).get('/api/dashboard')).body;
    expect(figuresIn(dash)).toEqual(expect.arrayContaining([String(MONEY.jobBig), String(MONEY.jobSmall), String(MONEY.due)]));
  });

  it('keeps the price of each record in a list report: only the report totals are company figures', async () => {
    const off = await world.off();
    const payments = await off.get('/api/reports/payments');
    expect(payments.status).toBe(200);
    expect(payments.body.payments.some((p: { amount: number }) => p.amount === MONEY.collected)).toBe(true);
  });

  it('answers a person with no switch on at all, the dashboard being every signed-in person\'s home page', async () => {
    const blank = await fx.addUser((await db.user.findFirstOrThrow({ where: { id: world.bigTech } })).organization_id, 'blankperson', 'TECHNICIAN');
    const res = await (await fx.signedInAs(blank)).get('/api/dashboard');
    expect(res.status).toBe(200);
    // The Technician preset holds View invoices off, so there is no invoices-and-payments tile at all.
    expect(has(res.body, 'data.kpi.revenue_mtd')).toBe(false);
  });
});
