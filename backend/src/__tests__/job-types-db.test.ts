/* =============================================================================
   V7-03 - Job types as rows: the /api/job-types endpoints against a real migrated database (TEST_DATABASE_URL).
   Skips when it is unset. The cases live in list-rows-endpoint-suite.ts, shared with lead-sources-db.test.ts.
   ========================================================================== */
import { describe, vi } from 'vitest';
import { randomUUID } from 'crypto';
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
vi.mock('../lib/prisma', () => ({ prisma: realClient }));

import { describeListEndpoints } from './list-rows-endpoint-suite';

const suite = realClient ? describe : describe.skip;

suite('Job types (real database)', () => {
  describeListEndpoints(realClient as PrismaClient, {
    path: '/api/job-types',
    table: 'job_types',
    model: 'jobType',
    orgField: 'job_type_options',
    noun: 'Job type',
    hasReorder: true,
    async seedCarriers(db, org, adminId, customer, text) {
      const job = await db.job.create({
        data: { id: randomUUID(), organization_id: org, customer_id: customer, job_number: `J-${randomUUID().slice(0, 8)}`, status: 'SCHEDULED', job_type: text,
          service_location_id: (await db.serviceLocation.create({ data: { customer_id: customer, address_line1: '1 Test Way', city: 'Testville', state: 'MA', zip: '02108' } })).id },
      });
      await db.lead.create({ data: { organization_id: org, customer_id: customer, lead_number: `L-${job.id.slice(0, 8)}`, service_request: 'x', job_type: text } });
      await db.estimate.create({
        data: { organization_id: org, customer_id: customer, created_by: adminId, estimate_number: `E-${job.id.slice(0, 8)}`, subtotal: 1, tax_amount: 0, total_amount: 1, job_type: text },
      });
      await db.servicePlanTemplate.create({
        data: { organization_id: org, name: 'Plan', job_type: text, default_visit_cadence: 'ANNUAL', term_months: 12, default_price: 1 },
      });
    },
    async readCarriers(db, org) {
      const [jobs, leads, estimates, templates] = await Promise.all([
        db.job.findMany({ where: { organization_id: org }, select: { job_type: true } }),
        db.lead.findMany({ where: { organization_id: org }, select: { job_type: true } }),
        db.estimate.findMany({ where: { organization_id: org }, select: { job_type: true } }),
        db.servicePlanTemplate.findMany({ where: { organization_id: org }, select: { job_type: true } }),
      ]);
      return [...jobs, ...leads, ...estimates, ...templates].map((r) => r.job_type).filter((v): v is string => v !== null).sort();
    },
    async seedUsed(db, fx, org, customer, text) {
      // One job and two leads carry it (case differs on purpose): three records.
      const job = await fx.addJob(org, customer);
      await db.job.update({ where: { id: job.id }, data: { job_type: text } });
      for (const t of [text, text.toLowerCase()]) {
        await db.lead.create({ data: { organization_id: org, customer_id: customer, lead_number: `L-${randomUUID().slice(0, 8)}`, service_request: 'x', job_type: t } });
      }
      return 3;
    },
  });
});
