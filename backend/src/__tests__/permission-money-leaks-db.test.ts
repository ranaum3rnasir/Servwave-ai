/* =============================================================================
   Roles & Permissions, PRD 1, slice S01.16 follow-up (scenario pass 1, findings F1 and F7) - company money and
   cost words that still reached a person without the switch.

   Everything goes through the public interface: the routes, called as people on custom roles (never a built-in
   role name) who hold exactly the switch values under test. Real migrated database (TEST_DATABASE_URL); the
   suite skips when it is unset. Every org it creates is removed again.

     - GET /api/estimates/stats: the pending-deposit tile is company-wide money. Without See company figures it
       counts only the deposits on estimates the person can open (the same answer the estimates list gives for the
       tile); with it, or as the Admin box, it is the whole company's.
     - GET /api/reports/jobs: a margin or cost key (profit, item cost, labor cost, card and tech expenses) is
       left out without See financial data; the prices of each job stay.
     - GET /api/reports/activity: revenue touched, which sums company revenue, is left out without See company
       figures; the action counts stay.
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
import { setRoleSwitchValues } from '../lib/permissions/switches/store';
import { SWITCH_CATALOG } from '../lib/permissions/switches/catalog';

const suite = realClient ? describe : describe.skip;

const keyOf = (label: string) => SWITCH_CATALOG.find((s) => s.label === label)!.key;
const SEE_COMPANY_FIGURES = keyOf('See company figures');
const SEE_FINANCIAL_DATA = keyOf('See financial data');
const ACCESS_REPORTS = keyOf('Access Reports');
const VIEW_ESTIMATES = keyOf('View estimates');
const ESTIMATES_SCOPE = keyOf('Estimates scope');

/** Figures no count, date or id on these records can equal. */
const DEPOSIT = { mine: 321.45, stranger: 777.77 };

suite('company money and cost words held back from a person without the switch (real database)', () => {
  const db = realClient as PrismaClient;
  const fx = switchFixture(db, async () => (await import('../app.js')).default as never);
  // Loading the whole app is slow on a loaded machine.
  beforeAll(async () => {
    await import('../app.js');
  }, 120_000);
  afterAll(() => fx.cleanup());

  type Api = Awaited<ReturnType<typeof fx.signedInAs>>;
  let sequence = 0;

  /** A person on a fresh custom role whose every toggle is off except the values given. */
  async function personWith(org: string, values: Record<string, boolean | string>): Promise<(() => Promise<Api>) & { id: string }> {
    const allOff = Object.fromEntries(SWITCH_CATALOG.filter((s) => s.kind === 'toggle').map((s) => [s.key, false]));
    const roleKey = `money-role-${++sequence}`;
    const role = await fx.addCustomRole(org, roleKey, 'TECHNICIAN', { madeFromBlank: true, copyGrants: false });
    await setRoleSwitchValues({ organizationId: org, roleKey, actorId: null, reason: 'manual', values: { ...allOff, ...values } });
    const person = await fx.addUser(org, `p${sequence}`, 'TECHNICIAN', { customRoleId: role.id });
    return Object.assign(() => fx.signedInAs(person), { id: person.id });
  }

  /** A deposit invoice still awaiting payment, on a new estimate that hangs off the given lead. */
  async function addPendingDeposit(org: string, customer: string, adminId: string, leadId: string, amount: number) {
    const estimate = await fx.addEstimate(org, customer, adminId, { leadId });
    const invoice = await fx.addInvoice(org, customer, { estimateId: estimate.id });
    await db.invoice.update({
      where: { id: invoice.id },
      data: { kind: 'DEPOSIT', status: 'SENT', sent_at: new Date(), total_amount: amount, amount_due: amount },
    });
  }

  describe('GET /api/estimates/stats', () => {
    let world: Awaited<ReturnType<typeof buildWorld>>;

    async function buildWorld() {
      const { org, customer, admin } = await fx.newOrg();
      const attached = { [VIEW_ESTIMATES]: true, [ESTIMATES_SCOPE]: 'attached' };
      const on = await personWith(org, { ...attached, [SEE_COMPANY_FIGURES]: true });
      const off = await personWith(org, { ...attached, [SEE_COMPANY_FIGURES]: false });
      const offSeesAll = await personWith(org, { [VIEW_ESTIMATES]: true, [ESTIMATES_SCOPE]: 'all', [SEE_COMPANY_FIGURES]: false });
      const nothing = await personWith(org, { [VIEW_ESTIMATES]: true, [ESTIMATES_SCOPE]: 'attached' });

      // The person without the figures is on the first lead; the second belongs to nobody they can reach.
      const mine = await fx.addLead(org, customer, { assignees: [off.id, on.id] });
      const strangers = await fx.addLead(org, customer, {});
      await addPendingDeposit(org, customer, admin.id, mine.id, DEPOSIT.mine);
      await addPendingDeposit(org, customer, admin.id, strangers.id, DEPOSIT.stranger);
      return { on, off, offSeesAll, nothing, admin: () => fx.signedInAs(admin) };
    }

    beforeAll(async () => {
      world = await buildWorld();
    }, 120_000);

    const deposits = async (who: () => Promise<Api>) => {
      const res = await (await who()).get('/api/estimates/stats');
      expect(res.status).toBe(200);
      return res.body.pending_deposits as { count: number; total: number | string };
    };

    it('carries the whole company\'s pending deposits with See company figures, and for the Admin box', async () => {
      for (const who of [world.on, world.admin]) {
        const d = await deposits(who);
        expect(d.count).toBe(2);
        expect(Number(d.total)).toBeCloseTo(DEPOSIT.mine + DEPOSIT.stranger, 2);
      }
    });

    it('counts only the deposits on estimates the person can open without it', async () => {
      const d = await deposits(world.off);
      expect(d.count).toBe(1);
      expect(Number(d.total)).toBeCloseTo(DEPOSIT.mine, 2);
    });

    it('keeps the deposits of every estimate a person can open, whatever their scope, without it', async () => {
      const d = await deposits(world.offSeesAll);
      expect(d.count).toBe(2);
      expect(Number(d.total)).toBeCloseTo(DEPOSIT.mine + DEPOSIT.stranger, 2);
    });

    it('shows nothing for a person who is attached to nothing', async () => {
      const d = await deposits(world.nothing);
      expect(d.count).toBe(0);
      expect(Number(d.total)).toBe(0);
    });

    it('carries no stranger\'s figure anywhere on the answer without it', async () => {
      const res = await (await world.off()).get('/api/estimates/stats');
      expect(JSON.stringify(res.body)).not.toContain(String(DEPOSIT.stranger));
    });
  });

  describe('GET /api/reports/jobs and /api/reports/activity', () => {
    let world: Awaited<ReturnType<typeof buildWorld>>;

    async function buildWorld() {
      const { org, customer, admin } = await fx.newOrg();
      const reports = { [ACCESS_REPORTS]: true };
      const both = await personWith(org, { ...reports, [SEE_FINANCIAL_DATA]: true, [SEE_COMPANY_FIGURES]: true });
      const costsOff = await personWith(org, { ...reports, [SEE_FINANCIAL_DATA]: false, [SEE_COMPANY_FIGURES]: true });
      const figuresOff = await personWith(org, { ...reports, [SEE_FINANCIAL_DATA]: true, [SEE_COMPANY_FIGURES]: false });

      const job = await fx.addJob(org, customer, { crew: [admin.id] });
      const invoice = await fx.addInvoice(org, customer, { jobId: job.id });
      await db.invoice.update({
        where: { id: invoice.id },
        data: { status: 'SENT', subtotal: 1000, tax_amount: 80, total_amount: 1080, amount_due: 1080 },
      });
      await db.timelineEvent.create({
        data: { organization_id: org, entity_type: 'JOB', entity_id: job.id, event_type: 'JOB_CREATED', created_by: admin.id, description: 'Job created' },
      });
      return { both, costsOff, figuresOff, admin: () => fx.signedInAs(admin) };
    }

    beforeAll(async () => {
      world = await buildWorld();
    }, 120_000);

    const COST_KEYS = ['profit', 'itemCost', 'laborCost', 'cardExpenses', 'techExpenses'];
    const PRICE_KEYS = ['billed', 'paid', 'subtotal', 'tax', 'tip', 'jobNumber', 'client', 'status'];

    const jobRows = async (who: () => Promise<Api>) => {
      const res = await (await who()).get('/api/reports/jobs');
      expect(res.status).toBe(200);
      expect(res.body.jobs.length).toBeGreaterThan(0);
      return res.body.jobs as Record<string, unknown>[];
    };

    it('carries the margin and cost keys of every job with See financial data, and for the Admin box', async () => {
      for (const who of [world.both, world.figuresOff, world.admin]) {
        for (const row of await jobRows(who)) for (const key of COST_KEYS) expect(key in row, key).toBe(true);
      }
    });

    it('leaves the margin and cost keys out of every job without See financial data, keeping the prices', async () => {
      for (const row of await jobRows(world.costsOff)) {
        for (const key of COST_KEYS) expect(key in row, key).toBe(false);
        for (const key of PRICE_KEYS) expect(key in row, key).toBe(true);
        expect(row.subtotal).toBe(1000);
      }
    });

    const activityUsers = async (who: () => Promise<Api>) => {
      const res = await (await who()).get('/api/reports/activity');
      expect(res.status).toBe(200);
      expect(res.body.users.length).toBeGreaterThan(0);
      return res.body.users as Record<string, unknown>[];
    };

    it('carries revenue touched with See company figures, and for the Admin box', async () => {
      for (const who of [world.both, world.costsOff, world.admin]) {
        for (const user of await activityUsers(who)) {
          expect('revenueTouched' in user).toBe(true);
          expect('prevRevenueTouched' in user).toBe(true);
        }
      }
    });

    it('leaves revenue touched out without See company figures, keeping the action counts', async () => {
      for (const user of await activityUsers(world.figuresOff)) {
        expect('revenueTouched' in user).toBe(false);
        expect('prevRevenueTouched' in user).toBe(false);
        expect(user.actions).toBeGreaterThan(0);
        expect(user.breakdown).toBeTruthy();
      }
    });
  });
});
