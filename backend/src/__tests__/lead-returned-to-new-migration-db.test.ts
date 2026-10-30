/* =============================================================================
   SPEC-4 D7 (Ran, 24 Oct): the lead's "back in New" instant, the migration run for real.

   A lead whose last outbound contact is taken off it goes back to New, and Spider counts a fresh New
   stay from that moment, so the lead needs an instant for it:
     - after CI's `prisma migrate deploy`, `leads.returned_to_new_at` exists, nullable, with no
       default and no index of its own;
     - running the file again succeeds and changes nothing;
     - an existing lead reads null (no backfill), and the column takes an instant.

   Reads the migration's own SQL file and runs it against the database TEST_DATABASE_URL points at,
   on rows of its own company. Skips when TEST_DATABASE_URL is unset. Every org it creates is
   removed again.
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { PrismaClient } from '@prisma/client';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION_SQL = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'migrations', '20261025120000_lead_returned_to_new_at', 'migration.sql'),
  'utf8',
);
/** The file's statements, one at a time: a raw call sends a single statement. */
const STATEMENTS = MIGRATION_SQL.split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

suite('lead returned-to-new migration (real database)', () => {
  // Built only when the suite runs: the skipped suite must not need a database URL.
  const db = url ? new PrismaClient({ datasources: { db: { url } } }) : (undefined as unknown as PrismaClient);
  const orgs: string[] = [];

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['leads', 'customers']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  /** The column as the catalog describes it, and every index on leads that names it. */
  async function shape() {
    const columns = await db.$queryRaw<{ data_type: string; is_nullable: string; column_default: string | null }[]>`
      SELECT data_type, is_nullable, column_default FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'leads' AND column_name = 'returned_to_new_at'`;
    const indexes = await db.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes
      WHERE tablename = 'leads' AND indexdef LIKE '%returned_to_new_at%'`;
    return { columns, indexes };
  }

  const run = async () => {
    for (const statement of STATEMENTS) await db.$executeRawUnsafe(statement);
  };

  it('after migrate deploy, leads.returned_to_new_at exists: a nullable timestamp, no default, no index', async () => {
    expect(STATEMENTS).toHaveLength(1);
    expect(await shape()).toEqual({
      columns: [{ data_type: 'timestamp without time zone', is_nullable: 'YES', column_default: null }],
      indexes: [],
    });
  });

  it('running the file again succeeds and changes nothing', async () => {
    const before = await shape();
    await run();
    await run();
    expect(await shape()).toEqual(before);
  });

  it('an existing lead reads null (no backfill), and the column holds an instant', async () => {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `lead-rtn-${tag}`, email: `org-${tag}@example.test`,
        address_line1: '1 Test Way', city: 'Testville', state: 'MA', postal_code: '02108',
        estimate_terms: '', estimate_notes: '', estimate_payment_terms: '', is_demo: true,
      },
    });
    const customer = randomUUID();
    await db.customer.create({
      data: { id: customer, organization_id: org, customer_number: `C-${tag}`, kind: 'PERSON', segment: 'RESIDENTIAL', first_name: 'Pat', last_name: 'Payer' },
    });
    const lead = randomUUID();
    await db.lead.create({ data: { id: lead, organization_id: org, customer_id: customer, lead_number: `L-${tag}`, service_request: 'Fix the door', status: 'NEW' } });

    await run();
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead }, select: { returned_to_new_at: true } })).returned_to_new_at).toBeNull();

    const at = new Date('2026-10-24T15:16:17.189Z');
    await db.lead.update({ where: { id: lead }, data: { returned_to_new_at: at } });
    expect((await db.lead.findUniqueOrThrow({ where: { id: lead }, select: { returned_to_new_at: true } })).returned_to_new_at).toEqual(at);
  });
});
