/* =============================================================================
   Spider: one alert per stage visit per switched-on period (SPEC-3, Ran, 20 Oct, D5), the
   migration run for real.

   The alert log's claim key gains counted_from, so a lead still stuck after Spider is switched
   back on can be claimed once more, while a second claim inside one period still fails:
     - after CI's `prisma migrate deploy`, the five-column unique key exists and the old
       four-column one is gone;
     - running the file again succeeds and changes neither;
     - the same visit with another counted_from inserts; the identical five parts fail (P2002).

   Reads the migration's own SQL file and runs it against the database TEST_DATABASE_URL points at,
   on rows of its own company. Skips when TEST_DATABASE_URL is unset. Every org it creates is
   removed again.
   ========================================================================== */

import { describe, it, expect, afterAll } from 'vitest';
import { randomUUID } from 'crypto';
import { readFileSync } from 'fs';
import { join } from 'path';
import { Prisma, PrismaClient } from '@prisma/client';

const url = process.env.TEST_DATABASE_URL;
const suite = url ? describe : describe.skip;

const MIGRATION_SQL = readFileSync(
  join(__dirname, '..', '..', 'prisma', 'migrations', '20261025100000_spider_alert_per_activation', 'migration.sql'),
  'utf8',
);
/** The file's statements, one at a time: a raw call sends a single statement. */
const STATEMENTS = MIGRATION_SQL.split('\n')
  .filter((line) => !line.trim().startsWith('--'))
  .join('\n')
  .split(';')
  .map((s) => s.trim())
  .filter(Boolean);

const NEW_KEY = 'spider_alerts_visit_activation_key';
const OLD_KEY = 'spider_alerts_organization_id_lead_id_status_entered_status_key';

suite('Spider alert-per-activation migration (real database)', () => {
  // Built only when the suite runs: the skipped suite must not need a database URL.
  const db = url ? new PrismaClient({ datasources: { db: { url } } }) : (undefined as unknown as PrismaClient);
  const orgs: string[] = [];

  afterAll(async () => {
    const quietly = (p: Promise<unknown>) => p.catch(() => undefined);
    for (const org of orgs) {
      for (const table of ['spider_alerts', 'leads', 'customers']) {
        await quietly(db.$executeRawUnsafe(`DELETE FROM ${table} WHERE organization_id = '${org}'`));
      }
      await quietly(db.organization.deleteMany({ where: { id: org } }));
    }
    await db.$disconnect();
  });

  /** The unique keys on spider_alerts, with each one's definition and catalog id. */
  async function spiderAlertKeys() {
    return db.$queryRaw<{ indexname: string; indexdef: string; oid: number }[]>`
      SELECT i.indexname, i.indexdef, c.oid::int AS oid
      FROM pg_indexes i JOIN pg_class c ON c.relname = i.indexname
      WHERE i.tablename = 'spider_alerts' AND i.indexname IN (${NEW_KEY}, ${OLD_KEY})
      ORDER BY i.indexname`;
  }

  const run = async () => {
    for (const statement of STATEMENTS) await db.$executeRawUnsafe(statement);
  };

  it('after migrate deploy, the claim key is the five columns and the old four-column key is gone', async () => {
    expect(STATEMENTS).toHaveLength(2);
    const keys = await spiderAlertKeys();
    expect(keys.map((k) => k.indexname)).toEqual([NEW_KEY]);
    expect(keys[0]!.indexdef).toBe(
      `CREATE UNIQUE INDEX ${NEW_KEY} ON public.spider_alerts USING btree (organization_id, lead_id, status, entered_status_at, counted_from)`,
    );
  });

  it('running the file again succeeds and changes neither index', async () => {
    const before = await spiderAlertKeys();
    await run();
    expect(await spiderAlertKeys()).toEqual(before);
  });

  it('the same stage visit inserts again with another counted_from, and the identical five parts fail', async () => {
    const org = randomUUID();
    orgs.push(org);
    const tag = org.slice(0, 8);
    await db.organization.create({
      data: {
        id: org, name: `spider-mig-${tag}`, email: `org-${tag}@example.test`,
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

    const entered = new Date('2026-10-01T09:00:00.000Z');
    const row = (countedFrom: Date) => ({
      organization_id: org, lead_id: lead, status: 'NEW' as const, entered_status_at: entered, counted_from: countedFrom,
      limit_value: 2, limit_unit: 'HOUR',
    });
    await db.spiderAlert.create({ data: row(entered) });
    // Switched off and on: counted from the new switch-on.
    await db.spiderAlert.create({ data: row(new Date('2026-10-01T12:10:00.000Z')) });
    expect(await db.spiderAlert.count({ where: { lead_id: lead } })).toBe(2);

    const again = await db.spiderAlert.create({ data: row(entered) }).catch((err: unknown) => err);
    expect(again).toBeInstanceOf(Prisma.PrismaClientKnownRequestError);
    expect((again as Prisma.PrismaClientKnownRequestError).code).toBe('P2002');
    expect(await db.spiderAlert.count({ where: { lead_id: lead } })).toBe(2);
  });
});
