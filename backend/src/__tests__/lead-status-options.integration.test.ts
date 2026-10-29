/**
 * Real-database run of the lead status menu rules (walkthrough lead-statuses PRD 7.1 to 7.3,
 * tests 12.2 items 12 to 14 and 16). The mocked route tests prove the wiring; this proves the two
 * counted facts against actual rows, which a mocked `count` cannot: which estimate statuses mean
 * "an estimate was sent", which visit statuses are open, and that a refused change writes nothing.
 *
 * Skipped by default (CI skips *.integration.test.ts). Run against a LOCAL throwaway Postgres with
 * every migration applied, never a shared database:
 *   DATABASE_URL=postgresql://<you>@localhost:5433/<db> RUN_INTEGRATION_TESTS=1 \
 *     npx vitest run src/__tests__/lead-status-options.integration.test.ts
 *
 * It drives the real Express app (supertest) with the real Prisma client. Only the identity
 * provider and the automation dispatcher are stubbed, so the real `authenticate` and permission
 * middleware run against a real user row.
 */
import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from 'vitest';
import dotenv from 'dotenv';

dotenv.config();

const enabled =
  process.env.RUN_INTEGRATION_TESTS === '1' &&
  typeof process.env.DATABASE_URL === 'string' &&
  !process.env.DATABASE_URL.includes('test:test@localhost') &&
  /localhost|127\.0\.0\.1/.test(process.env.DATABASE_URL);

// setup.ts replaces the prisma module with a mock for every suite. Put the real client back for
// this file only, so the routes under test read and write real rows.
vi.mock('../lib/prisma', async () => {
  const { PrismaClient } = await import('@prisma/client');
  return { prisma: new PrismaClient() };
});
vi.mock('../services/automations/dispatch', () => ({ dispatchAutomationEvent: vi.fn() }));

const ORG_ID = '00000000-0000-0000-0000-00000000a004';
const USER_ID = '00000000-0000-0000-0000-00000000a005';
const CUSTOMER_ID = '00000000-0000-0000-0000-00000000a006';

const ESTIMATE_SENT = "An estimate was already sent to this lead, so it can't go back to this step.";

describe.skipIf(!enabled)('lead status options: real database', () => {
  let prisma: any;
  let app: any;
  let request: any;
  let supabaseAdmin: any;
  let seq = 0;

  beforeAll(async () => {
    prisma = (await import('../lib/prisma.js')).prisma;
    app = (await import('../app.js')).default;
    request = (await import('supertest')).default;
    supabaseAdmin = (await import('../lib/supabase.js')).supabaseAdmin;

    await wipe();
    await prisma.organization.create({
      data: { id: ORG_ID, plan: 'SCALE', name: 'Lead Status Test Org', address_line1: '1 Test St', city: 'Testville', state: 'NY', postal_code: '10001',
        email: 'lws04-org@example.invalid', estimate_terms: '', estimate_notes: '', estimate_payment_terms: '' },
    });
    await prisma.user.create({
      data: { id: USER_ID, email: 'lws04-admin@example.invalid', first_name: 'Lead', last_name: 'Admin', role: 'ADMIN', organization_id: ORG_ID },
    });
    await prisma.customer.create({
      data: { id: CUSTOMER_ID, organization_id: ORG_ID, customer_number: 'C-LWS04', kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Status', last_name: 'Probe' },
    });
    // Loading the whole Express app is the slow part; the default 10s hook limit is too tight.
  }, 120_000);

  afterAll(async () => {
    if (!prisma) return;
    await wipe();
    await prisma.$disconnect();
  });

  beforeEach(() => {
    supabaseAdmin.auth.getUser.mockResolvedValue({ data: { user: { id: USER_ID, email: 'lws04-admin@example.invalid' } }, error: null });
  });

  async function wipe() {
    // Child rows first. Everything here is keyed to the throwaway org, nothing else is touched.
    await prisma.timelineEvent.deleteMany({ where: { organization_id: ORG_ID } });
    await prisma.visit.deleteMany({ where: { organization_id: ORG_ID } });
    await prisma.estimate.deleteMany({ where: { organization_id: ORG_ID } });
    await prisma.lead.deleteMany({ where: { organization_id: ORG_ID } });
    await prisma.customer.deleteMany({ where: { organization_id: ORG_ID } });
    await prisma.user.deleteMany({ where: { organization_id: ORG_ID } });
    await prisma.organization.deleteMany({ where: { id: ORG_ID } });
  }

  async function makeLead(status: string) {
    seq += 1;
    return prisma.lead.create({
      data: { organization_id: ORG_ID, customer_id: CUSTOMER_ID, lead_number: `L-LWS04-${seq}`, service_request: 'Probe', status },
    });
  }
  async function addVisit(leadId: string, status: string) {
    seq += 1;
    return prisma.visit.create({
      data: { organization_id: ORG_ID, lead_id: leadId, purpose: 'WALKTHROUGH', status, visit_seq: seq, scheduled_at: new Date('2026-12-01T15:00:00Z') },
    });
  }
  async function addEstimate(leadId: string, status: string, sentAt: Date | null = null) {
    seq += 1;
    return prisma.estimate.create({
      data: {
        organization_id: ORG_ID, lead_id: leadId, customer_id: CUSTOMER_ID, created_by: USER_ID,
        estimate_number: `E-LWS04-${seq}`, status, sent_at: sentAt, subtotal: 100, tax_amount: 0, total_amount: 100,
      },
    });
  }

  const get = (id: string) => request(app).get(`/api/leads/${id}`).set('Authorization', 'Bearer fake');
  const patch = (id: string, body: object) => request(app).patch(`/api/leads/${id}`).set('Authorization', 'Bearer fake').send(body);
  const options = async (id: string) => {
    const res = await get(id);
    expect(res.status).toBe(200);
    return Object.fromEntries(res.body.lead.status_options.map((o: any) => [o.status, o]));
  };
  const history = (id: string) => prisma.timelineEvent.findMany({ where: { entity_id: id, event_type: 'STATUS_CHANGE' } });

  it('GET returns all eight statuses in PRD section 5 order', async () => {
    const lead = await makeLead('NEW');
    const res = await get(lead.id);
    expect(res.body.lead.status_options.map((o: any) => o.status)).toEqual([
      'NEW', 'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED', 'WON', 'LOST', 'CANCELLED',
    ]);
  });

  describe('"estimate sent" (PRD 7.1)', () => {
    it.each(['SENT', 'PENDING', 'WON', 'DECLINED', 'EXPIRED'])('an estimate in status %s counts', async (status) => {
      const lead = await makeLead('CONTACTED');
      await addEstimate(lead.id, status);
      const o = await options(lead.id);
      expect(o.ESTIMATED.available).toBe(true);
      expect(o.NEW.reason).toBe(ESTIMATE_SENT);
    });

    it('a SUPERSEDED estimate counts only when it was sent first', async () => {
      const sent = await makeLead('CONTACTED');
      await addEstimate(sent.id, 'SUPERSEDED', new Date('2026-11-01T12:00:00Z'));
      expect((await options(sent.id)).ESTIMATED.available).toBe(true);

      const neverSent = await makeLead('CONTACTED');
      await addEstimate(neverSent.id, 'SUPERSEDED', null);
      const o = await options(neverSent.id);
      expect(o.ESTIMATED).toEqual({ status: 'ESTIMATED', available: false, reason: 'No estimate has been sent to this lead yet.' });
    });

    it.each(['DRAFT', 'ARCHIVED'])('an estimate in status %s never counts', async (status) => {
      const lead = await makeLead('CONTACTED');
      await addEstimate(lead.id, status);
      const o = await options(lead.id);
      expect(o.ESTIMATED.available).toBe(false);
      expect(o.NEW.available).toBe(true);
    });

    it('closing a lead archives its estimates, so a closed lead with only archived ones can go back', async () => {
      const lead = await makeLead('LOST');
      await addEstimate(lead.id, 'ARCHIVED');
      const o = await options(lead.id);
      expect(o.CONTACTED).toEqual({ status: 'CONTACTED', available: true, reason: null });
    });
  });

  describe('open and finished visits (PRD 7.1)', () => {
    it('counts a SCHEDULED visit as open and a COMPLETED one as finished, never a CANCELLED one', async () => {
      const lead = await makeLead('CONTACTED');
      await addVisit(lead.id, 'CANCELLED');
      let o = await options(lead.id);
      expect(o.NEW.available).toBe(true);
      expect(o.WALKTHROUGH_SCHEDULED.available).toBe(false);
      expect(o.WALKTHROUGH_COMPLETED.available).toBe(false);

      await addVisit(lead.id, 'SCHEDULED');
      o = await options(lead.id);
      expect(o.WALKTHROUGH_SCHEDULED.available).toBe(true);
      expect(o.WALKTHROUGH_COMPLETED.reason).toBe('A walkthrough visit is still booked on this lead.');
      expect(o.NEW.reason).toBe("This lead already has a walkthrough or an estimate, so it's past New.");

      // New, not Contacted: the current status never carries a lock reason, so Contacted has to be a different row.
      const finished = await makeLead('NEW');
      await addVisit(finished.id, 'COMPLETED');
      o = await options(finished.id);
      expect(o.WALKTHROUGH_COMPLETED.available).toBe(true);
      expect(o.WALKTHROUGH_SCHEDULED.reason).toBe("There's no walkthrough booked on this lead right now.");
      expect(o.CONTACTED.reason).toBe("This lead already has a walkthrough or an estimate, so it's past Contacted.");
    });

    it('counts only walkthrough visits: a WORK-purpose visit on the lead is neither open nor finished (PRD 4)', async () => {
      const lead = await makeLead('CONTACTED');
      seq += 1;
      await prisma.visit.create({
        data: { organization_id: ORG_ID, lead_id: lead.id, purpose: 'WORK', status: 'SCHEDULED', visit_seq: seq, scheduled_at: new Date('2026-12-01T15:00:00Z') },
      });
      seq += 1;
      await prisma.visit.create({
        data: { organization_id: ORG_ID, lead_id: lead.id, purpose: 'WORK', status: 'COMPLETED', visit_seq: seq, scheduled_at: new Date('2026-12-01T15:00:00Z') },
      });
      const o = await options(lead.id);
      expect(o.WALKTHROUGH_SCHEDULED.available).toBe(false);
      expect(o.WALKTHROUGH_COMPLETED.available).toBe(false);
    });

    it.each(['EN_ROUTE', 'ON_SITE', 'IN_PROGRESS'])('treats a %s visit as open', async (status) => {
      const lead = await makeLead('CONTACTED');
      await addVisit(lead.id, status);
      expect((await options(lead.id)).WALKTHROUGH_SCHEDULED.available).toBe(true);
    });
  });

  describe('PATCH /api/leads/:id { status }', () => {
    it('refuses a contradicting status with 409 and the exact text, and writes nothing', async () => {
      const lead = await makeLead('CONTACTED');
      const visit = await addVisit(lead.id, 'COMPLETED');
      const before = await prisma.visit.findUnique({ where: { id: visit.id } });

      const res = await patch(lead.id, { status: 'WALKTHROUGH_SCHEDULED' });

      expect(res.status).toBe(409);
      expect(res.body).toEqual({ error: "There's no walkthrough booked on this lead right now." });
      expect((await prisma.lead.findUnique({ where: { id: lead.id } })).status).toBe('CONTACTED');
      expect(await history(lead.id)).toHaveLength(0);
      expect(await prisma.visit.findUnique({ where: { id: visit.id } })).toEqual(before);
    });

    it('accepts a supported status: 200, the status moves, one History row with from and to', async () => {
      const lead = await makeLead('CONTACTED');
      await addVisit(lead.id, 'SCHEDULED');

      const res = await patch(lead.id, { status: 'WALKTHROUGH_SCHEDULED' });

      expect(res.status).toBe(200);
      expect((await prisma.lead.findUnique({ where: { id: lead.id } })).status).toBe('WALKTHROUGH_SCHEDULED');
      const rows = await history(lead.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({ from: 'CONTACTED', to: 'WALKTHROUGH_SCHEDULED' });
    });

    it('moves a Won lead with an approved estimate to Estimate Sent (200), and refuses Contacted with the estimate text', async () => {
      const lead = await makeLead('WON');
      await addEstimate(lead.id, 'WON');

      const ok = await patch(lead.id, { status: 'ESTIMATED' });
      expect(ok.status).toBe(200);
      expect((await prisma.lead.findUnique({ where: { id: lead.id } })).status).toBe('ESTIMATED');

      const won = await makeLead('WON');
      await addEstimate(won.id, 'WON');
      const refused = await patch(won.id, { status: 'CONTACTED' });
      expect(refused.status).toBe(409);
      expect(refused.body).toEqual({ error: ESTIMATE_SENT });
      expect((await prisma.lead.findUnique({ where: { id: won.id } })).status).toBe('WON');
      expect(await history(won.id)).toHaveLength(0);
    });

    it('lets a New lead with no estimate go to Won, and stamps won_at', async () => {
      const lead = await makeLead('NEW');

      const res = await patch(lead.id, { status: 'WON' });

      expect(res.status).toBe(200);
      const row = await prisma.lead.findUnique({ where: { id: lead.id } });
      expect(row.status).toBe('WON');
      expect(row.won_at).not.toBeNull();
    });
  });
});
