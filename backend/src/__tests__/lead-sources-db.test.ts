/* =============================================================================
   V7-03 - Lead/Customer sources as rows: the /api/lead-sources endpoints against a real migrated database
   (TEST_DATABASE_URL). Skips when it is unset. The cases live in list-rows-endpoint-suite.ts, shared with
   job-types-db.test.ts; sources have no reorder route.
   ========================================================================== */
import { describe, vi } from 'vitest';
import { randomUUID } from 'crypto';
import type { PrismaClient } from '@prisma/client';

const { realClient } = vi.hoisted(() => {
  const clientAt = (url: string) => {
    const { PrismaClient } = require('@prisma/client') as typeof import('@prisma/client');
    return new PrismaClient({ datasources: { db: { url } } });
  };
  const dbUrl = process.env.TEST_DATABASE_URL;
  return { realClient: dbUrl ? clientAt(dbUrl) : undefined };
});
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { describeListEndpoints } from './list-rows-endpoint-suite';

const suite = realClient ? describe : describe.skip;

suite('Lead/Customer sources (real database)', () => {
  describeListEndpoints(realClient as PrismaClient, {
    path: '/api/lead-sources',
    table: 'lead_sources',
    model: 'leadSource',
    orgField: 'source_options',
    noun: 'Source',
    hasReorder: false,
    async seedCarriers(db, org, adminId, customer, text) {
      await db.customer.update({ where: { id: customer }, data: { ad_source: text, source: text } });
      await db.estimate.create({
        data: { organization_id: org, customer_id: customer, created_by: adminId, estimate_number: `E-${randomUUID().slice(0, 8)}`, subtotal: 1, tax_amount: 0, total_amount: 1, lead_source: text },
      });
      await db.webFormIntegration.create({
        data: { organization_id: org, provider: 'forminator', url_token: randomUUID(), default_lead_source: text },
      });
    },
    async readCarriers(db, org) {
      const [customers, estimates, hooks] = await Promise.all([
        db.customer.findMany({ where: { organization_id: org }, select: { ad_source: true, source: true } }),
        db.estimate.findMany({ where: { organization_id: org }, select: { lead_source: true } }),
        db.webFormIntegration.findMany({ where: { organization_id: org }, select: { default_lead_source: true } }),
      ]);
      return [
        ...customers.flatMap((c) => [c.ad_source, c.source]),
        ...estimates.map((e) => e.lead_source),
        ...hooks.map((h) => h.default_lead_source),
      ].filter((v): v is string => v !== null).sort();
    },
    async seedUsed(db, fx, org, customer, text) {
      // Two leads on a customer whose ad_source is the name (case differs on purpose).
      await db.customer.update({ where: { id: customer }, data: { ad_source: text } });
      for (let i = 0; i < 2; i++) {
        await db.lead.create({ data: { organization_id: org, customer_id: customer, lead_number: `L-${randomUUID().slice(0, 8)}`, service_request: 'x' } });
      }
      void fx;
      return 2;
    },
  });
});
