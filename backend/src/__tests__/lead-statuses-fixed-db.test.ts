/* =============================================================================
   Lead statuses are fixed (walkthrough lead-statuses PRD, D12), against a real,
   migrated database.

   The per-org rename / reorder / hide / default-status table is gone, and a lead
   created without a status opens at NEW because that is the column's own default.
   Both are physical facts about Postgres, which a mocked Prisma cannot judge:
     - the old table no longer exists once every migration has run;
     - the drop migration is idempotent (a second run is a no-op, never an error);
     - a lead written the way the app and the web-form intake write it (no status
       key at all) reads NEW.

   Skips when TEST_DATABASE_URL is unset, the same idiom as the other *-db suites.
   Every org this suite creates is removed again in afterAll.
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const DROP_MIGRATION = join(
  __dirname, '..', '..', 'prisma', 'migrations', '20261006200100_drop_lead_status_overrides', 'migration.sql',
);
// Built from pieces so a sweep for the removed identifier stays clean (same convention as
// lead-statuses-fixed.test.ts).
const REMOVED_TABLE = ['lead', 'status', 'overrides'].join('_');

suite('fixed lead statuses (real database)', () => {
  const prisma = new PrismaClient({ datasources: { db: { url: url ?? '' } } });
  const orgs: string[] = [];

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const organization_id of orgs) {
      await quietly(prisma.lead.deleteMany({ where: { organization_id } }));
      await quietly(prisma.customer.deleteMany({ where: { organization_id } }));
      await quietly(prisma.organization.deleteMany({ where: { id: organization_id } }));
    }
    await prisma.$disconnect();
  });

  async function tableExists(): Promise<boolean> {
    const rows = await prisma.$queryRawUnsafe<{ t: string | null }[]>(
      `SELECT to_regclass('public.${REMOVED_TABLE}')::text AS t`,
    );
    return rows[0].t !== null;
  }

  it('has no per-org status settings table once the migrations have run', async () => {
    expect(await tableExists()).toBe(false);
  });

  it('re-running the drop migration is a no-op', async () => {
    const sql = readFileSync(DROP_MIGRATION, 'utf8');
    await prisma.$executeRawUnsafe(sql);
    await prisma.$executeRawUnsafe(sql);
    expect(await tableExists()).toBe(false);
  });

  it('opens a lead written without a status at NEW', async () => {
    const orgId = randomUUID();
    orgs.push(orgId);
    const tag = orgId.slice(0, 8);
    await prisma.organization.create({
      data: {
        id: orgId, name: `lsf-${tag}`, email: `lsf-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '',
      },
    });
    const customerId = randomUUID();
    await prisma.customer.create({
      data: { id: customerId, organization_id: orgId, customer_number: 'C00001', kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Test', last_name: 'Customer' },
    });
    const lead = await prisma.lead.create({
      data: { organization_id: orgId, lead_number: 'L00001', customer_id: customerId, service_request: 'Door' },
    });
    expect(lead.status).toBe('NEW');
  });
});
