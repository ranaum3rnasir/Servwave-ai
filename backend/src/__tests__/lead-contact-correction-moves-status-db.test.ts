/* =============================================================================
   Spec #2618, Seam A (hand correction): correcting a lead's contact time by hand moves a New lead
   to Contacted, through the same single status writer, and leaves every other status alone.

   Driven through the real route (POST /api/leads/:id/contact) against a real migrated database
   (TEST_DATABASE_URL), because "only from New" is a WHERE clause a mocked client cannot check and
   the response body must already say Contacted. Skips when TEST_DATABASE_URL is unset, like every
   other *-db suite. Every org it creates is removed again.
   ========================================================================== */

import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import request from 'supertest';
import { randomUUID } from 'crypto';
import type { RequestListener, Server } from 'http';
import type { LeadStatus } from '@prisma/client';
import { listenOnLoopback } from './loopback-app';

// One factory for every client in this file (see job-cancel-payment-race-db.test.ts for why).
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

import { supabaseAdmin } from '../lib/supabase';

const suite = realClient ? describe : describe.skip;

suite('the hand contact correction moves a New lead to Contacted (real database)', () => {
  const db = realClient!;
  const orgs: string[] = [];
  // A 127.0.0.1 listener, so a request can only reach this app (see loopback-app.ts).
  let app: Server;
  beforeAll(async () => {
    app = await listenOnLoopback((await import('../app.js')).default as unknown as RequestListener);
  });

  async function fixture(status: LeadStatus, contactedAt: Date | null = null) {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    const user = randomUUID();
    const customer = randomUUID();
    const lead = randomUUID();
    await db.organization.create({
      data: {
        id: org, name: `lcc2618-${tag}`, email: `lcc2618-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
        // Leads are a paid module; the lead doors need a plan that includes them.
        plan: 'ENTERPRISE',
      },
    });
    await db.user.create({
      data: { id: user, organization_id: org, email: `admin-${tag}@example.test`, first_name: 'Ada', last_name: 'Admin', role: 'ADMIN' },
    });
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: 'C00001', kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Test', last_name: 'Customer' },
    });
    await db.lead.create({
      data: { id: lead, organization_id: org, lead_number: 'L00001', customer_id: customer, service_request: 'Door', status, contacted_at: contactedAt },
    });
    (supabaseAdmin.auth.getUser as ReturnType<typeof vi.fn>).mockResolvedValue({
      data: { user: { id: user, email: `admin-${tag}@example.test` } },
      error: null,
    });
    // One token per fixture: the auth layer caches the resolved user by token.
    const bearer = `Bearer lcc2618-${tag}`;
    const correct = (contacted_at: string) =>
      request(app).post(`/api/leads/${lead}/contact`).set('Authorization', bearer).send({ contacted_at });
    const observe = async () => {
      const row = await db.lead.findUniqueOrThrow({ where: { id: lead }, select: { status: true, contacted_at: true } });
      const history = await db.timelineEvent.findMany({
        where: { organization_id: org, entity_type: 'LEAD', entity_id: lead, event_type: 'STATUS_CHANGE' },
        select: { metadata: true, created_by: true },
      });
      return { ...row, history };
    };
    return { org, user, lead, correct, observe };
  }

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const organization_id of orgs) {
      await quietly(db.timelineEvent.deleteMany({ where: { organization_id } }));
      await quietly(db.auditLog.deleteMany({ where: { org_id: organization_id } }));
      await quietly(db.lead.deleteMany({ where: { organization_id } }));
      await quietly(db.customer.deleteMany({ where: { organization_id } }));
      await quietly(db.user.deleteMany({ where: { organization_id } }));
      await quietly(db.organization.deleteMany({ where: { id: organization_id } }));
    }
    await db.$disconnect();
  });

  const WHEN = '2031-05-06T14:00:00.000Z';

  it('a New lead: Contacted in the response and in the database, one History row by the corrector', async () => {
    const f = await fixture('NEW');

    const res = await f.correct(WHEN);

    expect(res.status).toBe(200);
    expect(res.body.lead.status).toBe('CONTACTED');
    const seen = await f.observe();
    expect(seen.status).toBe('CONTACTED');
    expect(seen.contacted_at).toEqual(new Date(WHEN));
    expect(seen.history).toEqual([
      { metadata: { from: 'NEW', to: 'CONTACTED', via: 'contact_set_by_hand' }, created_by: f.user },
    ]);
  });

  it('a New lead whose clock is being corrected (already set) moves too', async () => {
    const f = await fixture('NEW', new Date('2031-05-01T10:00:00.000Z'));
    const res = await f.correct(WHEN);
    expect(res.status).toBe(200);
    expect(res.body.lead.status).toBe('CONTACTED');
    expect((await f.observe()).history).toHaveLength(1);
  });

  it.each<LeadStatus>([
    'CONTACTED', 'WALKTHROUGH_SCHEDULED', 'WALKTHROUGH_COMPLETED', 'ESTIMATED', 'WON', 'LOST',
  ])('%s: the clock is corrected and the status is left alone, with no status History row', async (status) => {
    const f = await fixture(status);
    const res = await f.correct(WHEN);
    expect(res.status).toBe(200);
    expect(res.body.lead.status).toBe(status);
    expect(await f.observe()).toEqual({ status, contacted_at: new Date(WHEN), history: [] });
  });
});
